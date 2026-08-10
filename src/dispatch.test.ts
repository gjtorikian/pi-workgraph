/**
 * Dispatch decision logic against mock-pi: idle detection, claim gating,
 * wake-message shape, heartbeat lifecycle, fencing loss, and teardown
 * release — controller-driven ticks over a real scratch graph, no live
 * model, timers exercised via injected 50 ms-scale config.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bindExec, getExecLog, resetExecLog } from "./bd.ts";
import type { WorkgraphConfig } from "./config.ts";
import {
  buildWorkPrompt,
  DISPATCH_FENCING_ENTRY_TYPE,
  DISPATCH_FLAG,
  DISPATCH_MESSAGE_TYPE,
  registerDispatch,
  type DispatchController,
} from "./dispatch.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "./identity.ts";
import {
  heldLeases,
  leaseExpiresAtOf,
  resetLeasesForTest,
  untrackLease,
} from "./lease.ts";
import { STATUS_KEY } from "./status.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockEventContext,
  type MockPi,
} from "../test/helpers/mock-pi.ts";
import {
  makeScratchGraph,
  type ScratchGraph,
} from "../test/helpers/scratch.ts";

const WORKER = "dispatch-test-worker";

/**
 * Timers are injected config — production floors live in index.ts only.
 * Ticks and beats are driven explicitly through the controller, so the
 * default intervals are long enough to never fire mid-test.
 */
const TEST_CONFIG: WorkgraphConfig = {
  leaseTtlMs: 300_000,
  heartbeatMs: 600_000,
  pollMs: 600_000,
  sweepIntervalMs: 600_000, // the sweep never fires mid-test either
  discoveryTimeoutMs: 40, // unused by deprecated dispatch — config-shape only
  acceptTimeoutMs: 150,
  compatInSessionExecutor: false,
  workerIdOverride: undefined,
};

let nowMs = Date.now();
const graphs: ScratchGraph[] = [];
const controllers: DispatchController[] = [];

function makeGraph(seed: number): ScratchGraph {
  const graph = makeScratchGraph({ seed, prefix: "disp" });
  graphs.push(graph);
  return graph;
}

interface Harness {
  mock: MockPi;
  controller: DispatchController;
  ectx: MockEventContext;
}

function makeHarness(
  cwd: string,
  config: Partial<WorkgraphConfig> = {},
): Harness {
  const mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  const controller = registerDispatch(asExtensionAPI(mock), {
    getConfig: () => ({ ...TEST_CONFIG, ...config }),
    now: () => nowMs,
  });
  controllers.push(controller);
  return { mock, controller, ectx: makeEventContext(cwd) };
}

function claimExecs(): readonly string[][] {
  return getExecLog()
    .filter((entry) => entry.args.includes("--claim"))
    .map((entry) => [...entry.args]);
}

beforeAll(() => {
  setWorkerIdOverride(WORKER);
}, 60_000);

afterAll(() => {
  for (const graph of graphs) graph.cleanup();
  resetIdentityForTest();
});

afterEach(async () => {
  // Ctx-less teardown: stop timers without releasing (registry is reset below).
  for (const controller of controllers.splice(0)) {
    await controller.teardown();
  }
  resetLeasesForTest();
  resetExecLog();
  nowMs = Date.now();
});

describe("claim gating", () => {
  it("empty pool: zero claims, zero messages (array-length rule)", async () => {
    const graph = makeGraph(0);
    const { mock, controller, ectx } = makeHarness(graph.dir);
    await controller.tick(ectx.ctx);
    expect(mock.sendMessages).toHaveLength(0);
    expect(claimExecs()).toHaveLength(0);
    expect(controller.current()).toBeNull();
  }, 30_000);

  it("does not claim while the agent is streaming or has queued messages", async () => {
    const graph = makeGraph(1);
    const { mock, controller, ectx } = makeHarness(graph.dir);
    ectx.setIdle(false);
    await controller.tick(ectx.ctx);
    ectx.setIdle(true);
    ectx.setPendingMessages(true);
    await controller.tick(ectx.ctx);
    expect(mock.sendMessages).toHaveLength(0);
    expect(claimExecs()).toHaveLength(0);
  }, 30_000);

  it("uninitialized directory: tick is inert, never throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-noinit-"));
    try {
      const { mock, controller, ectx } = makeHarness(dir);
      await controller.tick(ectx.ctx);
      expect(mock.sendMessages).toHaveLength(0);
      expect(claimExecs()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("claims one ready issue and wakes the agent with the dispatch message", async () => {
    const graph = makeGraph(1);
    const { mock, controller, ectx } = makeHarness(graph.dir);
    await controller.tick(ectx.ctx);

    const current = controller.current();
    expect(current).not.toBeNull();
    const issueId = graph.seededIds[0]!;
    expect(current!.issue.id).toBe(issueId);
    expect(graph.showIssue(issueId).assignee).toBe(WORKER);

    // Claim went through bd's atomic ready --claim, never a bare assignee write.
    const claims = claimExecs();
    expect(claims).toHaveLength(1);
    expect(claims[0]![0]).toBe("ready");

    expect(mock.sendMessages).toHaveLength(1);
    const wake = mock.sendMessages[0]!;
    expect(wake.message.customType).toBe(DISPATCH_MESSAGE_TYPE);
    expect(wake.message.display).toBe(true);
    expect(wake.message.content).toBe(
      buildWorkPrompt(current!.issue, current!.lease),
    );
    expect(String(wake.message.content)).toContain(issueId);
    expect(String(wake.message.content)).toContain("workgraph_close");
    expect(wake.options).toEqual({ triggerTurn: true, deliverAs: "nextTurn" });

    // Status bar shows the claim + countdown.
    const lastStatus = ectx.statusCalls.at(-1)!;
    expect(lastStatus.key).toBe(STATUS_KEY);
    expect(lastStatus.text).toContain(issueId);
  }, 30_000);

  it("rapid agent_settled bursts never double-claim (reentrant guard)", async () => {
    const graph = makeGraph(1);
    const { mock, controller, ectx } = makeHarness(graph.dir);
    await Promise.all([
      controller.tick(ectx.ctx),
      controller.tick(ectx.ctx),
      controller.tick(ectx.ctx),
    ]);
    expect(claimExecs()).toHaveLength(1);
    expect(mock.sendMessages).toHaveLength(1);
    expect(heldLeases(graph.dir)).toHaveLength(1);
  }, 30_000);

  it("holds one issue at a time and re-prompts exactly once when the wake is ignored", async () => {
    const graph = makeGraph(2);
    const { mock, controller, ectx } = makeHarness(graph.dir);
    await controller.tick(ectx.ctx); // claims issue 1
    expect(mock.sendMessages).toHaveLength(1);

    // Agent settled again without finishing: no second claim, ONE re-prompt.
    await controller.tick(ectx.ctx);
    expect(claimExecs()).toHaveLength(1);
    expect(mock.sendMessages).toHaveLength(2);

    // Third settle: still held, already re-prompted — silence.
    await controller.tick(ectx.ctx);
    expect(mock.sendMessages).toHaveLength(2);
    expect(claimExecs()).toHaveLength(1);
  }, 30_000);

  it("tools clearing the held lease lets the next tick claim the next issue", async () => {
    const graph = makeGraph(2);
    const { mock, controller, ectx } = makeHarness(graph.dir);
    await controller.tick(ectx.ctx);
    const first = controller.current()!.issue.id;

    // workgraph_close / workgraph_release untrack the lease — the registry
    // is the tools→dispatch bridge; simulate the tool side of it.
    untrackLease(graph.dir, first);
    await controller.tick(ectx.ctx);

    const second = controller.current();
    expect(second).not.toBeNull();
    expect(second!.issue.id).not.toBe(first);
    expect(mock.sendMessages).toHaveLength(2);
    expect(controller.timersActive().heartbeat).toBe(true);
  }, 30_000);
});

describe("heartbeat", () => {
  it("renews the lease: expiry advances and rides the injected clock", async () => {
    const graph = makeGraph(1);
    const { controller, ectx } = makeHarness(graph.dir);
    await controller.tick(ectx.ctx);
    const issueId = controller.current()!.lease.issueId;
    const before = leaseExpiresAtOf(graph.showIssue(issueId))!;

    nowMs += 60_000;
    await controller.beat(ectx.ctx);

    const after = leaseExpiresAtOf(graph.showIssue(issueId))!;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    expect(controller.current()!.lease.expiresAt).toBe(after);
  }, 30_000);

  it("fencing loss clears state, audits, notifies via appendEntry, clears status", async () => {
    const graph = makeGraph(1);
    const { mock, controller, ectx } = makeHarness(graph.dir);
    await controller.tick(ectx.ctx);
    const issueId = controller.current()!.lease.issueId;

    // A rival reclaims: epoch moves past ours.
    graph.bd([
      "update",
      issueId,
      "--set-metadata",
      "lease_epoch=999",
      "--set-metadata",
      "lease_holder=rival-worker",
      "--actor",
      "rival-worker",
    ]);

    await controller.beat(ectx.ctx);

    expect(controller.current()).toBeNull();
    expect(controller.timersActive().heartbeat).toBe(false);
    expect(heldLeases(graph.dir)).toHaveLength(0);

    // Zero-context-cost notification.
    const entry = mock.entries.find(
      (e) => e.customType === DISPATCH_FENCING_ENTRY_TYPE,
    );
    expect(entry).toBeDefined();
    expect((entry!.data as { issueId: string }).issueId).toBe(issueId);

    // Audit record landed on the issue's comment trail.
    const comments = JSON.parse(graph.bd(["comments", issueId, "--json"])) as {
      text: string;
    }[];
    expect(
      comments.some((c) => c.text.startsWith("workgraph-lease fencing-loss")),
    ).toBe(true);

    // Status is CLEARED, not overwritten.
    expect(ectx.statusCalls.at(-1)).toEqual({
      key: STATUS_KEY,
      text: undefined,
    });
  }, 30_000);
});

describe("lifecycle", () => {
  it("session_start starts the poll timer; session_shutdown tears it down idempotently", async () => {
    const graph = makeGraph(0);
    // Long timers so nothing fires during the test window.
    const { mock, controller, ectx } = makeHarness(graph.dir, {
      pollMs: 600_000,
      heartbeatMs: 600_000,
    });

    await mock.emit("session_start", { type: "session_start" }, ectx.ctx);
    expect(controller.timersActive().poll).toBe(true);

    await mock.emit(
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      ectx.ctx,
    );
    expect(controller.timersActive()).toEqual({ poll: false, heartbeat: false });

    // Idempotent: a second teardown is a no-op.
    await controller.teardown(ectx.ctx);
    expect(controller.timersActive()).toEqual({ poll: false, heartbeat: false });
  }, 30_000);

  it("teardown voluntarily releases the held lease (audit: release, not expire)", async () => {
    const graph = makeGraph(1);
    const { controller, ectx } = makeHarness(graph.dir, {
      pollMs: 600_000,
      heartbeatMs: 600_000,
    });
    await controller.tick(ectx.ctx);
    const issueId = controller.current()!.lease.issueId;

    await controller.teardown(ectx.ctx);

    expect(controller.current()).toBeNull();
    expect(heldLeases(graph.dir)).toHaveLength(0);
    const released = graph.showIssue(issueId);
    expect(released.status).toBe("open");
    expect(released.assignee ?? "").toBe("");

    const comments = JSON.parse(graph.bd(["comments", issueId, "--json"])) as {
      text: string;
    }[];
    expect(
      comments.some((c) => c.text.startsWith("workgraph-lease release")),
    ).toBe(true);
    expect(
      comments.some((c) => c.text.startsWith("workgraph-lease expire")),
    ).toBe(false);
  }, 30_000);

  it("the workgraph-dispatch flag disables the loop entirely", async () => {
    const graph = makeGraph(1);
    const { mock, controller, ectx } = makeHarness(graph.dir);
    mock.setFlag(DISPATCH_FLAG, false);

    await mock.emit("session_start", { type: "session_start" }, ectx.ctx);
    expect(controller.timersActive().poll).toBe(false);

    await mock.emit("agent_settled", { type: "agent_settled" }, ectx.ctx);
    expect(mock.sendMessages).toHaveLength(0);
    expect(claimExecs()).toHaveLength(0);
  }, 30_000);
});
