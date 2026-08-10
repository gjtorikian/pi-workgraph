/**
 * LEGACY-MECHANISM pin (phase 2 retarget): the coordinator drain lives in
 * test/coordinator.test.ts now — this suite keeps the DEPRECATED
 * registerDispatch loop honest, because the in-session compatibility
 * adapter reuses its exact wake mechanism (`pi.sendMessage` with
 * `triggerTurn: true, deliverAs: "nextTurn"` and the DISPATCH_MESSAGE_TYPE
 * customType). Deprecation-in-place means this must keep working
 * unmodified: a 5-issue pool drains through a stub work handler — the
 * "model" immediately completes each dispatched issue via workgraph_close,
 * exactly as the legacy wake prompt instructs.
 *
 * Assertions run against the bd exec log (`getExecLog`): every claim went
 * through the atomic `ready --claim` path, and no code path wrote a bare
 * `--assignee` (the collision-freedom invariant).
 *
 * Run via `npm run test:dispatch`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindExec, getExecLog, resetExecLog } from "../src/bd.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import {
  DISPATCH_MESSAGE_TYPE,
  registerDispatch,
  type DispatchController,
} from "../src/dispatch.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockEventContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "drain-worker";
const POOL_SIZE = 5;

const TEST_CONFIG: WorkgraphConfig = {
  leaseTtlMs: 300_000,
  heartbeatMs: 600_000, // beats never fire — the drain is tick-driven
  pollMs: 600_000, // ticks come from agent_settled, not the interval
  sweepIntervalMs: 600_000, // the sweep never fires mid-test either
  discoveryTimeoutMs: 40, // unused by deprecated dispatch — config-shape only
  acceptTimeoutMs: 150,
  compatInSessionExecutor: false,
  workerIdOverride: WORKER,
};

let mock: MockPi;
let controller: DispatchController;
let graph: ScratchGraph;
let ectx: MockEventContext;

beforeAll(() => {
  mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  registerWorkgraphTools(asExtensionAPI(mock));
  controller = registerDispatch(asExtensionAPI(mock), {
    getConfig: () => TEST_CONFIG,
  });
  // Both surfaces agree on identity: the flag feeds the tools' prepare();
  // the direct override covers dispatch ticks before any tool call.
  mock.setFlag("workgraph-worker-id", WORKER);
  setWorkerIdOverride(WORKER);
  graph = makeScratchGraph({ seed: POOL_SIZE, prefix: "drain" });
  ectx = makeEventContext(graph.dir);
  resetExecLog();
}, 60_000);

afterAll(async () => {
  await controller?.teardown();
  graph?.cleanup();
  resetLeasesForTest();
  resetIdentityForTest();
});

/** The stub model: close whatever dispatch just assigned. Since phase 3,
 *  workgraph_close permits only phase-`accepted` issues (the judgment
 *  gate) — the deprecated dispatch loop stamps no lifecycle metadata, so
 *  the stub records the acceptance the way src/tools.test.ts's close tests
 *  do before closing. (Latent phase-3 breakage: this suite predates the
 *  accepted-only guard and was never run against it — the branch has no CI
 *  history; discovered and fixed during phase-4 validation.) */
async function completeCurrentIssue(issueId: string): Promise<void> {
  const close = mock.tools.get("workgraph_close");
  if (!close) throw new Error("workgraph_close not registered");
  graph.bd([
    "update",
    issueId,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=accepted",
    "--actor",
    "stub-judgment",
  ]);
  await close.execute(
    `stub-close-${issueId}`,
    { id: issueId, reason: "done by stub handler" },
    undefined,
    undefined,
    makeToolContext(graph.dir),
  );
}

function settle(): Promise<unknown[]> {
  return mock.emit("agent_settled", { type: "agent_settled" }, ectx.ctx);
}

describe("criterion 4: drain 5 seeded issues", () => {
  it("claims, dispatches, and closes every issue with no manual input", async () => {
    const dispatchedIds: string[] = [];

    for (let round = 0; round < POOL_SIZE; round++) {
      await settle();

      const current = controller.current();
      expect(current, `round ${round} should claim an issue`).not.toBeNull();
      const issueId = current!.issue.id;
      expect(dispatchedIds).not.toContain(issueId);
      dispatchedIds.push(issueId);

      // One issue at a time, ever.
      expect(heldLeases(graph.dir)).toHaveLength(1);

      // The stub "model" follows the wake prompt: close it.
      await completeCurrentIssue(issueId);
    }

    // Pool drained: the next settle finds nothing and goes quiet.
    await settle();
    expect(controller.current()).toBeNull();
    expect(heldLeases(graph.dir)).toHaveLength(0);

    // Every seeded issue went through dispatch and is closed.
    expect(dispatchedIds.sort()).toEqual([...graph.seededIds].sort());
    for (const id of graph.seededIds) {
      expect(graph.showIssue(id).status).toBe("closed");
    }

    // One wake message per issue, correctly shaped.
    expect(mock.sendMessages).toHaveLength(POOL_SIZE);
    for (const wake of mock.sendMessages) {
      expect(wake.message.customType).toBe(DISPATCH_MESSAGE_TYPE);
      expect(wake.options).toEqual({ triggerTurn: true, deliverAs: "nextTurn" });
    }

    // Exec-log invariants: all claims via atomic `ready --claim`; zero bare
    // assignee writes anywhere in the drain.
    const log = getExecLog();
    const claims = log.filter((entry) => entry.args.includes("--claim"));
    expect(claims).toHaveLength(POOL_SIZE);
    for (const claim of claims) {
      expect(claim.args[0]).toBe("ready");
    }
    expect(log.some((entry) => entry.args.includes("--assignee"))).toBe(false);
  }, 120_000);
});
