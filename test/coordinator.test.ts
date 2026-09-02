/**
 * Coordinator + executor-registry behavior (spec-phase-2): deterministic
 * selection, bounded discovery, the no-executor-no-claim invariant, the
 * drain-to-judging flow through the fake executor, reject/timeout release,
 * fenced/duplicate/stale completion handling, and the in-session
 * compatibility adapter (standalone and integrated).
 *
 * Timer discipline follows the repo convention (no fake timers anywhere):
 * huge poll/heartbeat intervals so timers never fire mid-test, and tiny
 * REAL `discoveryTimeoutMs`/`acceptTimeoutMs` so the bounded waits resolve
 * in milliseconds. Ticks are event-driven via `agent_settled`; async
 * handler settlement is drained with mock-pi's `flushEvents()`.
 *
 * Run via `npm run test:coordinator`.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  registerInSessionExecutor,
  IN_SESSION_EXECUTOR_ID,
  type InSessionController,
} from "../src/adapters/in-session.ts";
import { bindExec, getExecLog, listComments, resetExecLog } from "../src/bd.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { DISPATCH_MESSAGE_TYPE } from "../src/dispatch.ts";
import {
  discoverExecutors,
  ExecutorSelectionError,
  selectExecutor,
} from "../src/executor-registry.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import {
  heldLeases,
  leaseEpochOf,
  leaseHolderOf,
  resetLeasesForTest,
} from "../src/lease.ts";
import {
  Activity,
  CH,
  newEnvelope,
  parseMessage,
  type ExecutorOfferT,
  type RunCompletedT,
  type RunRequestT,
} from "../src/protocol.ts";
import {
  LEASE_HOLDER_KEY,
  WORKFLOW_RUN_PREFIX,
  WORKGRAPH_ACTIVE_EXECUTION_ID_KEY,
  WORKGRAPH_EXECUTOR_ID_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_WORKFLOW_RUN_ID_KEY,
} from "../src/types.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "coord-test-worker";

/** Huge scheduling timers (event-driven ticks only), tiny REAL protocol
 *  timeouts (bounded waits resolve fast). */
const CONFIG: WorkgraphConfig = {
  leaseTtlMs: 300_000,
  heartbeatMs: 600_000,
  pollMs: 600_000,
  sweepIntervalMs: 600_000,
  discoveryTimeoutMs: 40,
  acceptTimeoutMs: 150,
  compatInSessionExecutor: false, // integration tests override per-harness
  // This suite exercises protocol coordination over legacy scratch issues;
  // the phase-3 approved-only rule (and its default legacy skip) has its
  // own coverage in test/judgment.test.ts.
  compatLegacyIssues: true,
  workerIdOverride: WORKER,
};

function makeOffer(overrides: Partial<ExecutorOfferT> = {}): ExecutorOfferT {
  return {
    ...newEnvelope(),
    inReplyTo: "disc-0",
    executorId: "exec-x",
    adapterVersion: "test",
    roles: ["implementer"],
    harness: "fake",
    isolation: "worktree",
    supportsCancellation: false,
    supportsReconciliation: false,
    ...overrides,
  };
}

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
  config: WorkgraphConfig;
}

function makeHarness(overrides: Partial<WorkgraphConfig> = {}): Harness {
  const mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  const config: WorkgraphConfig = { ...CONFIG, ...overrides };
  setWorkerIdOverride(WORKER);
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
  });
  return { mock, coordinator, config };
}

function settle(mock: MockPi, ctx: unknown): Promise<unknown[]> {
  return mock.emit(
    "agent_settled",
    { type: "agent_settled" },
    ctx as Parameters<MockPi["emit"]>[2],
  );
}

function metadataOf(graph: ScratchGraph, id: string): Record<string, unknown> {
  return (graph.showIssue(id).metadata ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  resetLeasesForTest();
  resetIdentityForTest();
});

// ---------------------------------------------------------------------------
// registry: pure selection
// ---------------------------------------------------------------------------

describe("registry: deterministic executor selection", () => {
  it("orders by priority desc then executorId asc, independent of arrival order", () => {
    const a = makeOffer({ executorId: "exec-a", priority: 1 });
    const b = makeOffer({ executorId: "exec-b", priority: 1 });
    const c = makeOffer({ executorId: "exec-c", priority: 5 });
    const requirements = { role: "implementer" as const, requiresIsolation: false };
    expect(selectExecutor([a, b, c], requirements, {})?.executorId).toBe("exec-c");
    expect(selectExecutor([c, b, a], requirements, {})?.executorId).toBe("exec-c");
    // Priority ties break on executorId ascending — again order-independent.
    expect(selectExecutor([b, a], requirements, {})?.executorId).toBe("exec-a");
    expect(selectExecutor([a, b], requirements, {})?.executorId).toBe("exec-a");
    // Missing priority reads as 0.
    const zero = makeOffer({ executorId: "exec-0" });
    const neg = makeOffer({ executorId: "exec-n", priority: -1 });
    expect(selectExecutor([neg, zero], requirements, {})?.executorId).toBe("exec-0");
  });

  it("filters by required role; no eligible offer selects nothing", () => {
    const reviewer = makeOffer({ executorId: "rev", roles: ["reviewer"] });
    const implementer = makeOffer({ executorId: "imp", roles: ["implementer"] });
    expect(
      selectExecutor(
        [reviewer, implementer],
        { role: "implementer", requiresIsolation: false },
        {},
      )?.executorId,
    ).toBe("imp");
    expect(
      selectExecutor([reviewer], { role: "implementer", requiresIsolation: false }, {}),
    ).toBeUndefined();
  });

  it("an isolation-requiring request excludes isolation-none offers", () => {
    const inSession = makeOffer({
      executorId: "in-session",
      isolation: "none",
      priority: 100,
    });
    const worktree = makeOffer({ executorId: "worktree-exec", isolation: "worktree" });
    // Isolation requirement beats even a much higher priority.
    expect(
      selectExecutor(
        [inSession, worktree],
        { role: "implementer", requiresIsolation: true },
        {},
      )?.executorId,
    ).toBe("worktree-exec");
    // Only isolation-none offers → nothing eligible.
    expect(
      selectExecutor([inSession], { role: "implementer", requiresIsolation: true }, {}),
    ).toBeUndefined();
    // Without the requirement the compat adapter is a normal candidate.
    expect(
      selectExecutor([inSession], { role: "implementer", requiresIsolation: false }, {})
        ?.executorId,
    ).toBe("in-session");
  });

  it("explicitly configured executorId wins over ordering and filters", () => {
    const pinned = makeOffer({
      executorId: "in-session",
      isolation: "none",
      priority: -5,
    });
    const better = makeOffer({ executorId: "exec-better", priority: 10 });
    expect(
      selectExecutor(
        [better, pinned],
        { role: "implementer", requiresIsolation: true },
        { executorId: "in-session" },
      )?.executorId,
    ).toBe("in-session");
  });

  it("a configured executor that did not offer throws — never a silent fallback", () => {
    const other = makeOffer({ executorId: "exec-other" });
    expect(() =>
      selectExecutor(
        [other],
        { role: "implementer", requiresIsolation: false },
        { executorId: "exec-pinned" },
      ),
    ).toThrow(ExecutorSelectionError);
    expect(() =>
      selectExecutor(
        [],
        { role: "implementer", requiresIsolation: false },
        { executorId: "exec-pinned" },
      ),
    ).toThrow(/exec-pinned/);
  });

  it("available === false is filtered out; an explicit pin still overrides it", () => {
    const away = makeOffer({
      executorId: "exec-away",
      available: false,
      priority: 100,
    });
    const here = makeOffer({ executorId: "exec-here" });
    const requirements = { role: "implementer" as const, requiresIsolation: false };
    // Priority never resurrects an unavailable offer.
    expect(selectExecutor([away, here], requirements, {})?.executorId).toBe(
      "exec-here",
    );
    expect(selectExecutor([away], requirements, {})).toBeUndefined();
    // The operator's explicit pin is never second-guessed by the filters.
    expect(
      selectExecutor([away, here], requirements, { executorId: "exec-away" })
        ?.executorId,
    ).toBe("exec-away");
  });

  it("maxConcurrency is respected against the caller-supplied in-flight counts", () => {
    const capped = makeOffer({
      executorId: "exec-capped",
      maxConcurrency: 2,
      priority: 5,
    });
    const open = makeOffer({ executorId: "exec-open" });
    const requirements = { role: "implementer" as const, requiresIsolation: false };
    // Below capacity the higher-priority capped executor wins…
    expect(
      selectExecutor([capped, open], requirements, {}, new Map([["exec-capped", 1]]))
        ?.executorId,
    ).toBe("exec-capped");
    // …at capacity it is skipped, deterministically.
    expect(
      selectExecutor([capped, open], requirements, {}, new Map([["exec-capped", 2]]))
        ?.executorId,
    ).toBe("exec-open");
    // No counts supplied reads as zero in flight (today's callers).
    expect(selectExecutor([capped, open], requirements, {})?.executorId).toBe(
      "exec-capped",
    );
    // An offer with NO advertised cap is never capacity-filtered.
    expect(
      selectExecutor([open], requirements, {}, new Map([["exec-open", 99]]))
        ?.executorId,
    ).toBe("exec-open");
  });

  it("a request-specified profileSemantics must match the offer's declared semantics exactly", () => {
    const named = makeOffer({
      executorId: "exec-named",
      profileSemantics: "named",
    });
    const initiating = makeOffer({
      executorId: "exec-init",
      profileSemantics: "initiating",
    });
    const undeclared = makeOffer({ executorId: "exec-undeclared" });
    const base = { role: "implementer" as const, requiresIsolation: false };
    // No requirement (every caller today): all pass, executorId tiebreak.
    expect(
      selectExecutor([named, initiating, undeclared], base, {})?.executorId,
    ).toBe("exec-init");
    // A requirement matches exactly; an undeclared offer fails closed.
    expect(
      selectExecutor(
        [named, initiating, undeclared],
        { ...base, profileSemantics: "named" },
        {},
      )?.executorId,
    ).toBe("exec-named");
    expect(
      selectExecutor([undeclared], { ...base, profileSemantics: "named" }, {}),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// registry: discovery
// ---------------------------------------------------------------------------

describe("registry: discovery round-trips", () => {
  it("collects only well-formed offers answering THIS round, until the deadline", async () => {
    const mock = makeMockPi();
    const fake = installFakeExecutor(mock.events, { executorId: "exec-live" });
    // A rogue responder answering some other discovery round…
    mock.events.on(CH.discover, () => {
      mock.events.emit(CH.offer, makeOffer({ inReplyTo: "someone-elses-round" }));
    });
    // …and one emitting garbage (must be skipped, not crash discovery).
    mock.events.on(CH.discover, () => {
      mock.events.emit(CH.offer, { totally: "malformed" });
    });
    try {
      const offers = await discoverExecutors(mock.events, { timeoutMs: 40 });
      expect(offers).toHaveLength(1);
      expect(offers[0]!.executorId).toBe("exec-live");
    } finally {
      fake.uninstall();
    }
  });

  it("an offer arriving after the discovery deadline is ignored", async () => {
    const mock = makeMockPi();
    const fake = installFakeExecutor(mock.events, {
      executorId: "exec-late",
      offerDelayMs: 80,
    });
    try {
      const offers = await discoverExecutors(mock.events, { timeoutMs: 30 });
      expect(offers).toHaveLength(0);
      // Let the late offer actually fire — it lands on a dead subscription.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        mock.busEvents.filter((e) => e.channel === CH.offer),
      ).toHaveLength(1);
    } finally {
      fake.uninstall();
    }
  });
});

// ---------------------------------------------------------------------------
// coordinator: the pin-flip invariant
// ---------------------------------------------------------------------------

describe("coordinator: no executor, no claim", () => {
  it("zero offers leave the ready pool untouched — no --claim ever runs", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "coord0", seed: 1 });
    const { mock, coordinator } = makeHarness();
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(coordinator.current()).toBeNull();
      expect(heldLeases(graph.dir)).toHaveLength(0);
      const shown = graph.showIssue(graph.seededIds[0]!);
      expect(shown.status).toBe("open");
      expect(shown.assignee ?? "").toBe("");
      // The discriminating assertion: the tick probed the pool but NEVER
      // reached bd's claim path.
      const log = getExecLog();
      expect(log.some((e) => e.args.includes("--claim"))).toBe(false);
      expect(log.some((e) => e.args[0] === "ready")).toBe(true);
    } finally {
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("a configured executor that does not offer means no claim either", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "coordp", seed: 1 });
    const { mock, coordinator } = makeHarness({ executorId: "pinned-executor" });
    // A perfectly good executor offers — but it is not the pinned one.
    const fake = installFakeExecutor(mock.events, { executorId: "exec-other" });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(coordinator.current()).toBeNull();
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(graph.showIssue(graph.seededIds[0]!).status).toBe("open");
      expect(getExecLog().some((e) => e.args.includes("--claim"))).toBe(false);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// coordinator: drain
// ---------------------------------------------------------------------------

describe("coordinator: drain through the fake executor", () => {
  it("drains 5 seeded issues to workgraph_phase=judging with zero coordinator sendMessage", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "coorddr", seed: 5 });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, { behavior: "accept-complete" });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      for (let round = 0; round < 5; round++) {
        await settle(mock, ectx.ctx);
        await mock.flushEvents();
      }

      // Every seeded issue reached fenced implementation-completion:
      // claimed → executed → judging. NOT closure — that is phase 3.
      const runIds = new Set<string>();
      for (const id of graph.seededIds) {
        const shown = graph.showIssue(id);
        expect(shown.status, `${id} stays claimed while judging`).toBe(
          "in_progress",
        );
        const metadata = metadataOf(graph, id);
        expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("judging");
        expect(metadata[WORKGRAPH_EXECUTOR_ID_KEY]).toBe("fake-executor");
        const runId = metadata[WORKGRAPH_WORKFLOW_RUN_ID_KEY];
        expect(String(runId)).toMatch(new RegExp(`^${WORKFLOW_RUN_PREFIX}`));
        runIds.add(String(runId));
        // The lease holder IS the workflow run — run-scoped, not session-scoped.
        expect(leaseHolderOf(shown)).toBe(runId);
      }
      expect(runIds.size).toBe(5); // a fresh run identity per claim

      // The coordinator holds every judged lease until shutdown (phase-3
      // boundary), and it NEVER woke the model — no sendMessage anywhere.
      expect(heldLeases(graph.dir)).toHaveLength(5);
      expect(coordinator.current()?.phase).toBe("judging");
      expect(mock.sendMessages).toHaveLength(0);
      expect(fake.requests).toHaveLength(5);

      // Exec-log invariants, ported from the legacy dispatch drain: every
      // claim went through bd's atomic claim-by-id (`update <id> --claim` —
      // phase 3's approved-only filter needs metadata `ready --claim`
      // cannot see); zero bare assignee writes.
      const log = getExecLog();
      const claims = log.filter((entry) => entry.args.includes("--claim"));
      expect(claims).toHaveLength(5);
      for (const claim of claims) {
        expect(claim.args[0]).toBe("update");
      }
      expect(log.some((entry) => entry.args.includes("--assignee"))).toBe(false);

      // Shutdown releases the parked leases (in-session semantics).
      await coordinator.teardown(ectx.ctx);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      for (const id of graph.seededIds) {
        expect(graph.showIssue(id).status).toBe("open");
      }
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// coordinator: reject / timeout → release
// ---------------------------------------------------------------------------

describe("coordinator: reject and timeout release", () => {
  it("an executor rejection releases the claim promptly, reason audited", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "coordrj", seed: 1 });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      behavior: "reject",
      rejectReason: "at-capacity",
    });
    const ectx = makeEventContext(graph.dir);
    const id = graph.seededIds[0]!;
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(coordinator.current()).toBeNull();
      expect(heldLeases(graph.dir)).toHaveLength(0);
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("open");
      expect(shown.assignee ?? "").toBe("");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("ready");

      const comments = await listComments(graph.dir, id);
      const rejections = comments.filter((c) =>
        c.text.startsWith("workgraph-lease executor-rejected "),
      );
      expect(rejections).toHaveLength(1);
      expect(rejections[0]!.text).toContain('"reason":"at-capacity"');
      // …and the lease release itself is audited too.
      expect(
        comments.filter((c) => c.text.startsWith("workgraph-lease release ")),
      ).toHaveLength(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("no accept inside the deadline releases the claim, audited as accept-timeout", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "coordto", seed: 1 });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, { behavior: "silent" });
    const ectx = makeEventContext(graph.dir);
    const id = graph.seededIds[0]!;
    try {
      await settle(mock, ectx.ctx); // tick awaits the real 150 ms deadline
      await mock.flushEvents();

      expect(coordinator.current()).toBeNull();
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(graph.showIssue(id).status).toBe("open");
      expect(fake.requests).toHaveLength(1); // the request WAS delivered

      const comments = await listComments(graph.dir, id);
      expect(
        comments.filter((c) =>
          c.text.startsWith("workgraph-lease accept-timeout "),
        ),
      ).toHaveLength(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// coordinator: fenced completion
// ---------------------------------------------------------------------------

describe("coordinator: fenced and idempotent completion", () => {
  it("duplicate run:completed deliveries cause one transition and ONE audit record", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "coorddp", seed: 1 });
    const { mock, coordinator } = makeHarness();
    // Byte-identical duplicate emitted immediately after the original.
    const fake = installFakeExecutor(mock.events, {
      behavior: "accept-complete",
      duplicateCompletion: true,
    });
    const ectx = makeEventContext(graph.dir);
    const id = graph.seededIds[0]!;
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("judging");

      // A LATE duplicate (same messageId, long after judging) and a fresh
      // re-completion (new messageId, finished run): both perform zero writes.
      fake.reemit(fake.completions[0]!);
      fake.complete();
      await mock.flushEvents();

      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("judging");
      const comments = await listComments(graph.dir, id);
      expect(
        comments.filter((c) => c.text.startsWith("workgraph-lease run-completed ")),
      ).toHaveLength(1);
      // The issue is still held by the same run — no epoch churn either.
      expect(heldLeases(graph.dir)).toHaveLength(1);
      expect(leaseEpochOf(graph.showIssue(id))).toBe(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("a completion with a stale epoch after a forced reclaim is ignored and audited stale", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "coordst", seed: 1 });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, { behavior: "accept-stall" });
    const ectx = makeEventContext(graph.dir);
    const id = graph.seededIds[0]!;
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(coordinator.current()?.phase).toBe("accepted");
      const heldEpoch = leaseEpochOf(graph.showIssue(id));

      // Forced takeover while the executor "works": epoch bump + holder
      // overwrite, exactly what a sweep reclaim does to an expired lease.
      graph.bd([
        "update",
        id,
        "--assignee",
        "thief-worker",
        "--set-metadata",
        "lease_holder=thief-worker",
        "--set-metadata",
        `lease_epoch=${heldEpoch + 1}`,
        "--actor",
        "thief-worker",
      ]);

      // The stalled executor finally reports success — echoing the triple
      // it was handed, which is now stale.
      fake.complete();
      await mock.flushEvents();

      // Ignored: no judging transition, and the coordinator dropped the run.
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("implementing");
      expect(leaseHolderOf(graph.showIssue(id))).toBe("thief-worker");
      expect(coordinator.current()).toBeNull();
      expect(heldLeases(graph.dir)).toHaveLength(0);

      const comments = await listComments(graph.dir, id);
      expect(
        comments.filter((c) =>
          c.text.startsWith("workgraph-lease stale-result-rejected "),
        ),
      ).toHaveLength(1);
      expect(
        comments.filter((c) => c.text.startsWith("workgraph-lease run-completed ")),
      ).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// coordinator: activity events (phase 5 — observers-only, post-commit)
// ---------------------------------------------------------------------------

describe("coordinator: activity events", () => {
  it("a full implement→judge→accept→close drain emits the canonical activity sequence", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "coordact", seed: 1 });
    const id = graph.seededIds[0]!;
    // Approve (workgraph_approve's writes): the activity trail covers the
    // approved-only path end to end.
    graph.bd([
      "update",
      id,
      "--set-metadata",
      "workgraph_lifecycle_version=1",
      "--set-metadata",
      "workgraph_phase=ready",
      "--actor",
      "approver",
    ]);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: {
          provenance: { harness: "fake", model: "impl-m", provider: "impl-p" },
          artifacts: ["src/thing.ts"],
        },
        reviewer: {
          provenance: { harness: "fake", model: "rev-m", provider: "rev-p" },
          verdict: { findings: [] },
        },
      },
    });
    // An OBSERVER subscription — nothing in-core subscribes to activity.
    const recorded: unknown[] = [];
    mock.events.on(CH.activity, (data) => {
      recorded.push(data);
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(graph.showIssue(id).status).toBe("closed");
      // Every event validates against the Activity schema, and the recorded
      // sequence matches the COMMITTED transition sequence exactly — one
      // activity per durable write, emitted strictly post-commit.
      const acts = recorded.map((d) => parseMessage(CH.activity, Activity, d));
      expect(acts.map((a) => `${a.kind}:${a.phase}`)).toEqual([
        "claim:implementing",
        "transition:judging",
        "verdict:verifying",
        "transition:accepted",
        "close:accepted",
      ]);
      const runId = String(metadataOf(graph, id)[WORKGRAPH_WORKFLOW_RUN_ID_KEY]);
      for (const act of acts) {
        expect(act.issueId).toBe(id);
        expect(act.workflowRunId).toBe(runId);
        expect(act.actor).toBe(WORKER);
      }
      // The verdict activity carries the compact summary.
      expect(acts[2]!.summary).toMatch(/^pass/);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("activity is post-commit only: a fenced-out stale completion emits nothing beyond the claim", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "coordas", seed: 1 });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, { behavior: "accept-stall" });
    const recorded: unknown[] = [];
    mock.events.on(CH.activity, (data) => {
      recorded.push(data);
    });
    const ectx = makeEventContext(graph.dir);
    const id = graph.seededIds[0]!;
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      const heldEpoch = leaseEpochOf(graph.showIssue(id));

      // Forced takeover while the executor "works" (the sweep-reclaim shape).
      graph.bd([
        "update",
        id,
        "--assignee",
        "thief-worker",
        "--set-metadata",
        "lease_holder=thief-worker",
        "--set-metadata",
        `lease_epoch=${heldEpoch + 1}`,
        "--actor",
        "thief-worker",
      ]);
      fake.complete(); // the stale completion — fenced out, ZERO writes
      await mock.flushEvents();

      // Exactly the claim's activity — the rejected completion committed
      // nothing, so observers saw no phantom judging transition.
      const kinds = recorded
        .map((d) => parseMessage(CH.activity, Activity, d))
        .map((a) => `${a.kind}:${a.phase}`);
      expect(kinds).toEqual(["claim:implementing"]);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// in-session adapter — standalone protocol behavior (no coordinator, no bd)
// ---------------------------------------------------------------------------

describe("in-session adapter (standalone)", () => {
  function makeAdapterHarness(compat = true): {
    mock: MockPi;
    adapter: InSessionController;
    config: WorkgraphConfig;
  } {
    const mock = makeMockPi();
    const config: WorkgraphConfig = { ...CONFIG, compatInSessionExecutor: compat };
    const adapter = registerInSessionExecutor(asExtensionAPI(mock), {
      getConfig: () => config,
    });
    return { mock, adapter, config };
  }

  function makeRunRequest(overrides: Partial<RunRequestT> = {}): RunRequestT {
    return {
      ...newEnvelope(),
      executorId: IN_SESSION_EXECUTOR_ID,
      issue: { id: "wg-42", title: "wire the flux capacitor" },
      workflowRunId: "workgraph-run/test-run-1",
      leaseEpoch: 7,
      role: "implementer",
      attempt: 1,
      workspace: { baseRevision: "", requiresIsolation: false },
      ...overrides,
    };
  }

  function busOn(mock: MockPi, channel: string): unknown[] {
    return mock.busEvents.filter((e) => e.channel === channel).map((e) => e.data);
  }

  it("answers discovery and accepts an addressed request by waking the model", async () => {
    const { mock } = makeAdapterHarness();
    const discover = newEnvelope();
    mock.events.emit(CH.discover, discover);
    const offers = busOn(mock, CH.offer) as ExecutorOfferT[];
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      inReplyTo: discover.messageId,
      executorId: IN_SESSION_EXECUTOR_ID,
      isolation: "none",
      roles: ["implementer"],
      supportsCancellation: true,
    });

    const request = makeRunRequest();
    mock.events.emit(CH.runRequest, request);
    const accepted = busOn(mock, CH.runAccepted);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      inReplyTo: request.messageId,
      workflowRunId: request.workflowRunId,
      issueId: "wg-42",
      leaseEpoch: 7,
      executorId: IN_SESSION_EXECUTOR_ID,
    });

    // The wake reuses dispatch.ts's message shape…
    expect(mock.sendMessages).toHaveLength(1);
    const wake = mock.sendMessages[0]!;
    expect(wake.message.customType).toBe(DISPATCH_MESSAGE_TYPE);
    expect(wake.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    // …with phase-2 semantics: completion is reported, never self-closed.
    const prompt = String(wake.message.content);
    expect(prompt).toContain("wg-42");
    expect(prompt).toContain(request.workflowRunId);
    expect(prompt).toContain("moves the issue to judging");
    expect(prompt).not.toContain("call workgraph_close");
  });

  it("wakes with a delivery mode that self-triggers when idle — never nextTurn", () => {
    // Regression: pi ignores `triggerTurn` for deliverAs "nextTurn" (the
    // message queues for the next USER prompt). A promptless `pi --mode
    // rpc` session — the pi-workgraph-ui launch path — has no next user
    // prompt, so a nextTurn wake left the issue in "implementing" with the
    // lease renewing for days while zero turns ran. The wake must use a
    // delivery mode whose triggerTurn actually fires on an idle agent
    // ("steer" or "followUp" per pi's sendMessage contract).
    const { mock } = makeAdapterHarness();
    mock.events.emit(CH.runRequest, makeRunRequest());

    expect(mock.sendMessages).toHaveLength(1);
    const options = mock.sendMessages[0]!.options;
    expect(options?.triggerTurn).toBe(true);
    expect(options?.deliverAs).not.toBe("nextTurn");
    expect(["steer", "followUp"]).toContain(options?.deliverAs);
  });

  it("reports EXACTLY one completion: first settle completes, re-settles are silent", async () => {
    const { mock, adapter } = makeAdapterHarness();
    const request = makeRunRequest();
    mock.events.emit(CH.runRequest, request);
    expect(adapter.activeRun()?.workflowRunId).toBe(request.workflowRunId);

    const ectx = makeEventContext("/tmp/unused");
    await settle(mock, ectx.ctx);
    let completions = busOn(mock, CH.runCompleted) as RunCompletedT[];
    expect(completions).toHaveLength(1);
    // The fencing triple is echoed verbatim for the coordinator to validate.
    expect(completions[0]).toMatchObject({
      workflowRunId: request.workflowRunId,
      issueId: "wg-42",
      leaseEpoch: 7,
      outcome: "success",
      provenance: { harness: "pi", profile: "initiating" },
    });
    expect(adapter.activeRun()).toBeNull();

    // Re-settles (user chatter after the run) report nothing more.
    await settle(mock, ectx.ctx);
    await settle(mock, ectx.ctx);
    completions = busOn(mock, CH.runCompleted) as RunCompletedT[];
    expect(completions).toHaveLength(1);
  });

  it("cancel before the settle acks run:cancelled and suppresses the completion", async () => {
    const { mock, adapter } = makeAdapterHarness();
    const request = makeRunRequest();
    mock.events.emit(CH.runRequest, request);
    expect(adapter.activeRun()).not.toBeNull();

    mock.events.emit(CH.runCancel, {
      ...newEnvelope(),
      workflowRunId: request.workflowRunId,
      issueId: "wg-42",
      reason: "lease lost",
    });
    const cancelled = busOn(mock, CH.runCancelled);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      workflowRunId: request.workflowRunId,
      issueId: "wg-42",
    });
    expect(adapter.activeRun()).toBeNull();

    // The abandoned turn's settle reports nothing.
    const ectx = makeEventContext("/tmp/unused");
    await settle(mock, ectx.ctx);
    expect(busOn(mock, CH.runCompleted)).toHaveLength(0);
  });

  it("rejects a second concurrent request as busy; a disabled adapter never offers", () => {
    const { mock, config } = makeAdapterHarness();
    mock.events.emit(CH.runRequest, makeRunRequest());
    mock.events.emit(
      CH.runRequest,
      makeRunRequest({ workflowRunId: "workgraph-run/test-run-2" }),
    );
    const rejected = busOn(mock, CH.runRejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      workflowRunId: "workgraph-run/test-run-2",
      reason: "busy",
    });
    expect(mock.sendMessages).toHaveLength(1); // one wake, not two

    // Flip the config off: discovery goes unanswered (it is explicit
    // configuration, not a hidden default path).
    config.compatInSessionExecutor = false;
    const before = busOn(mock, CH.offer).length;
    mock.events.emit(CH.discover, newEnvelope());
    expect(busOn(mock, CH.offer)).toHaveLength(before);
  });

  it("a request addressed to a different executor is ignored", () => {
    const { mock, adapter } = makeAdapterHarness();
    mock.events.emit(
      CH.runRequest,
      makeRunRequest({ executorId: "someone-else" }),
    );
    expect(adapter.activeRun()).toBeNull();
    expect(busOn(mock, CH.runAccepted)).toHaveLength(0);
    expect(mock.sendMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// in-session integration: the compat drain
// ---------------------------------------------------------------------------

describe("in-session integration", () => {
  it("the coordinator drains through the adapter: wakes come from the adapter alone", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "coordis", seed: 2 });
    const mock = makeMockPi();
    bindExec((command, args, options) => mock.exec(command, args, options));
    setWorkerIdOverride(WORKER);
    const config: WorkgraphConfig = { ...CONFIG, compatInSessionExecutor: true };
    // Registration order matters and mirrors index.ts: the ADAPTER first,
    // so within one settled dispatch it observes the run state from the
    // previous tick and never completes a run the same instant it accepted.
    registerInSessionExecutor(asExtensionAPI(mock), { getConfig: () => config });
    const coordinator = registerCoordinator(asExtensionAPI(mock), {
      getConfig: () => config,
    });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      // Each issue takes two settles: claim+wake, then settle→completion.
      for (let round = 0; round < 4; round++) {
        await settle(mock, ectx.ctx);
        await mock.flushEvents();
      }

      for (const id of graph.seededIds) {
        const metadata = metadataOf(graph, id);
        expect(metadata[WORKGRAPH_PHASE_KEY], `${id} reaches judging`).toBe(
          "judging",
        );
        expect(metadata[WORKGRAPH_EXECUTOR_ID_KEY]).toBe(IN_SESSION_EXECUTOR_ID);
        expect(graph.showIssue(id).status).toBe("in_progress");
      }

      // One wake per issue — and EVERY sendMessage is the adapter's wake;
      // the coordinator itself never calls sendMessage.
      expect(mock.sendMessages).toHaveLength(2);
      for (const sent of mock.sendMessages) {
        expect(sent.message.customType).toBe(DISPATCH_MESSAGE_TYPE);
        expect(sent.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
      }

      // Claims still go through bd's atomic claim path, exclusively —
      // claim-by-id since phase 3 (`update <id> --claim`).
      const claims = getExecLog().filter((e) => e.args.includes("--claim"));
      expect(claims).toHaveLength(2);
      for (const claim of claims) {
        expect(claim.args[0]).toBe("update");
      }
    } finally {
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 120_000);

  it("teardown resets a released implementing run to ready (redispatchable, not stranded)", async () => {
    // Regression: graceful shutdown (UI Stop → SIGTERM → session_shutdown)
    // released the in-session run's lease but left `workgraph_phase` at
    // "implementing". Claiming takes phase "ready" only, and with no lease
    // left to expire the TTL sweep never fires either — the issue was
    // stranded until a human reset the metadata by hand.
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "coordtd", seed: 1 });
    const mock = makeMockPi();
    bindExec((command, args, options) => mock.exec(command, args, options));
    setWorkerIdOverride(WORKER);
    const config: WorkgraphConfig = { ...CONFIG, compatInSessionExecutor: true };
    registerInSessionExecutor(asExtensionAPI(mock), { getConfig: () => config });
    const coordinator = registerCoordinator(asExtensionAPI(mock), {
      getConfig: () => config,
    });
    const ectx = makeEventContext(graph.dir);
    try {
      // ONE settle: claim + wake, work turn never completes — this is the
      // mid-implementation shutdown.
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const id = graph.seededIds[0]!;
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("implementing");

      await coordinator.teardown(ectx.ctx);

      const md = metadataOf(graph, id);
      expect(md[WORKGRAPH_PHASE_KEY], "phase reset for redispatch").toBe(
        "ready",
      );
      expect(md[WORKGRAPH_ACTIVE_EXECUTION_ID_KEY] ?? "").toBe("");
      expect(md[LEASE_HOLDER_KEY], "lease released").toBeUndefined();
      expect(graph.showIssue(id).status).toBe("open");
    } finally {
      await coordinator.teardown(ectx.ctx); // idempotent
      graph.cleanup();
    }
  }, 120_000);
});
