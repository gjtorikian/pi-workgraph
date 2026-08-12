/**
 * Restart and cancellation recovery (spec-phase-4): startup reconciliation
 * (re-adopt / terminal-through-the-normal-handler / abandon / reclaim),
 * graceful shutdown (release vs cancel→ack→release vs abandon-unacked),
 * fencing-loss cancellation, and the compaction run-reference fold.
 *
 * Restart simulation: a "dead prior coordinator" is durable metadata a
 * fresh process finds — lifecycle + lease keys stamped via scratch bd (or
 * driven by a REAL first coordinator instance), then `resetLeasesForTest()`
 * (the in-memory held-lease registry loss a crash implies) and a brand-new
 * mock-pi + coordinator against the same workspace.
 *
 * Timer discipline follows the repo convention (no fake timers anywhere):
 * huge poll/heartbeat intervals, tiny REAL discovery/accept/status
 * timeouts, injected `now()` to fabricate lease expiry.
 *
 * Run via `npm run test:recovery`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bindExec, listComments } from "../src/bd.ts";
import { buildCompactionInstructions, registerCompactionTakeover } from "../src/compaction.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { registerInSessionExecutor } from "../src/adapters/in-session.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import {
  heldLeases,
  leaseEpochOf,
  leaseHolderOf,
  resetLeasesForTest,
  rfc3339,
} from "../src/lease.ts";
import { activeExecutionIdOf, phaseOf } from "../src/lifecycle.ts";
import { CH, newEnvelope, type RunCompletedT } from "../src/protocol.ts";
import { reclaimAndLeaveReady } from "../src/sweep.ts";
import {
  WORKGRAPH_ATTEMPT_KEY,
  WORKGRAPH_FAILURE_FINGERPRINT_KEY,
} from "../src/types.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "recovery-test-worker";
const TTL = 300_000;

/** Huge scheduling timers (event-driven only), tiny REAL protocol timeouts. */
const CONFIG: WorkgraphConfig = {
  leaseTtlMs: TTL,
  heartbeatMs: 600_000,
  pollMs: 600_000,
  sweepIntervalMs: 600_000,
  discoveryTimeoutMs: 40,
  acceptTimeoutMs: 150,
  compatInSessionExecutor: false,
  compatLegacyIssues: true,
  workerIdOverride: WORKER,
};

const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
  config: WorkgraphConfig;
}

function makeHarness(
  overrides: Partial<WorkgraphConfig> = {},
  now?: () => number,
): Harness {
  const mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  const config: WorkgraphConfig = { ...CONFIG, ...overrides };
  setWorkerIdOverride(WORKER);
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
    ...(now ? { now } : {}),
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

function busOn(mock: MockPi, channel: string): unknown[] {
  return mock.busEvents.filter((e) => e.channel === channel).map((e) => e.data);
}

async function auditCount(dir: string, id: string, kind: string): Promise<number> {
  const comments = await listComments(dir, id);
  return comments.filter((c) => c.text.startsWith(`workgraph-lease ${kind} `))
    .length;
}

/**
 * Poll a condition. Needed where the judgment chain is deliberately left
 * blocked mid-flight (a stalled revision execution): `flushEvents()` would
 * await that chain's promise and deadlock. Keep the condition CHEAP and
 * in-memory — a blocking bd read per poll starves the event loop the
 * chain's own bd calls resolve on.
 *
 * `intervalMs` exists for the rare poll that MUST read durable state: a bd
 * read is synchronous and slow, so those callers back the interval off far
 * enough that the chain's own async bd calls still get the loop between
 * checks. Do not lower it for a durable condition.
 */
async function until(
  cond: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 15,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("until: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

interface DeadRunOptions {
  runId: string;
  phase?: string;
  executorId?: string;
  executionId?: string;
  epoch?: number;
  /** Lease expiry relative to `nowMs` (negative = already expired). */
  expiresInMs?: number;
  nowMs?: number;
  fingerprint?: string;
  attempt?: number;
}

/**
 * Stamp the durable remains of a dead prior coordinator's run: bd claim
 * (in_progress + assignee) plus the lease trio and lifecycle metadata a
 * phase-2/3 coordinator persists before/at accept. What it deliberately
 * does NOT create is any in-process state — exactly what a crash loses.
 */
function stampDeadRun(graph: ScratchGraph, id: string, opts: DeadRunOptions): void {
  graph.bd(["update", id, "--claim", "--actor", "dead-coordinator"]);
  const expires = rfc3339((opts.nowMs ?? Date.now()) + (opts.expiresInMs ?? TTL));
  const args = [
    "update",
    id,
    "--set-metadata",
    `lease_holder=${opts.runId}`,
    "--set-metadata",
    `lease_epoch=${opts.epoch ?? 1}`,
    "--set-metadata",
    `lease_expires_at=${expires}`,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    `workgraph_phase=${opts.phase ?? "implementing"}`,
    "--set-metadata",
    `workgraph_workflow_run_id=${opts.runId}`,
  ];
  if (opts.executorId) {
    args.push("--set-metadata", `workgraph_executor_id=${opts.executorId}`);
  }
  if (opts.executionId) {
    args.push("--set-metadata", `workgraph_active_execution_id=${opts.executionId}`);
  }
  if (opts.fingerprint) {
    args.push("--set-metadata", `workgraph_failure_fingerprint=${opts.fingerprint}`);
  }
  if (opts.attempt !== undefined) {
    args.push("--set-metadata", `workgraph_attempt=${String(opts.attempt)}`);
  }
  args.push("--actor", "dead-coordinator");
  graph.bd(args);
}

/** A well-formed completion echoing a stamped run's fencing triple. */
function completionFor(opts: {
  runId: string;
  executionId: string;
  issueId: string;
  epoch: number;
  artifacts?: string[];
}): RunCompletedT {
  return {
    ...newEnvelope(),
    workflowRunId: opts.runId,
    executionId: opts.executionId,
    issueId: opts.issueId,
    leaseEpoch: opts.epoch,
    outcome: "success",
    artifacts: opts.artifacts ?? [],
    evidence: ["completed by the pre-restart executor"],
    provenance: IMPL_PROV,
  };
}

afterEach(() => {
  resetLeasesForTest();
  resetIdentityForTest();
});

// ---------------------------------------------------------------------------
// reconcile: re-adopt / terminal / abandon / reclaim
// ---------------------------------------------------------------------------

describe("startup reconciliation", () => {
  it("re-adopts a live implementing run on `active` and drains it to judging with no duplicate run request", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvadopt", seed: 1 });
    const id = graph.seededIds[0]!;
    const RUN = "workgraph-run/rcv-adopt-1";
    stampDeadRun(graph, id, {
      runId: RUN,
      executorId: "fake-executor",
      executionId: "pre-restart-exec-1",
    });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, { status: "active" });
    const ectx = makeEventContext(graph.dir);
    try {
      const report = await coordinator.reconcile(ectx.ctx);
      expect(report.readopted).toEqual([id]);
      expect(report.abandoned).toEqual([]);
      expect(report.reclaimed).toEqual([]);
      // Heartbeat resumed: the lease is tracked again under the RUN actor.
      expect(heldLeases(graph.dir)).toHaveLength(1);
      expect(coordinator.current()?.workflowRunId).toBe(RUN);
      // The status request went to the recorded executor about the
      // recorded execution — and NO new run:request was emitted.
      expect(fake.statusRequests).toHaveLength(1);
      expect(fake.statusRequests[0]!.executionId).toBe("pre-restart-exec-1");
      expect(fake.requests).toHaveLength(0);
      expect(await auditCount(graph.dir, id, "re-adopted")).toBe(1);

      // The executor finishes: the completion flows through the NORMAL
      // fenced handler and the issue drains to judging.
      mock.events.emit(
        CH.runCompleted,
        completionFor({ runId: RUN, executionId: "pre-restart-exec-1", issueId: id, epoch: 1 }),
      );
      await mock.flushEvents();
      expect(metadataOf(graph, id).workgraph_phase).toBe("judging");
      expect(await auditCount(graph.dir, id, "run-completed")).toBe(1);
      expect(fake.requests).toHaveLength(0); // still no re-dispatch
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("applies a terminal-during-downtime result through the normal fenced handler", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvterm", seed: 1 });
    const id = graph.seededIds[0]!;
    const RUN = "workgraph-run/rcv-term-1";
    stampDeadRun(graph, id, {
      runId: RUN,
      executorId: "fake-executor",
      executionId: "term-exec-1",
    });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      status: (req) => ({
        ...newEnvelope(),
        inReplyTo: req.messageId,
        workflowRunId: req.workflowRunId,
        issueId: req.issueId,
        status: "terminal",
        ...(req.executionId !== undefined ? { executionId: req.executionId } : {}),
        completion: completionFor({
          runId: req.workflowRunId,
          executionId: req.executionId ?? "term-exec-1",
          issueId: req.issueId,
          epoch: 1,
          artifacts: ["src/downtime.ts"],
        }),
      }),
    });
    const ectx = makeEventContext(graph.dir);
    try {
      const report = await coordinator.reconcile(ectx.ctx);
      expect(report.completed).toEqual([id]);
      expect(report.abandoned).toEqual([]);
      // One code path: the same run-completed audit + judging transition
      // a live completion produces (then parked — nothing offers reviewer).
      expect(metadataOf(graph, id).workgraph_phase).toBe("judging");
      expect(await auditCount(graph.dir, id, "run-completed")).toBe(1);
      expect(heldLeases(graph.dir)).toHaveLength(1);
      expect(coordinator.current()?.phase).toBe("judging");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a duplicate terminal delivery after re-adoption causes a single transition", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvdup", seed: 1 });
    const id = graph.seededIds[0]!;
    const RUN = "workgraph-run/rcv-dup-1";
    stampDeadRun(graph, id, {
      runId: RUN,
      executorId: "fake-executor",
      executionId: "dup-exec-1",
    });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, { status: "active" });
    const ectx = makeEventContext(graph.dir);
    try {
      await coordinator.reconcile(ectx.ctx);
      const completion = completionFor({
        runId: RUN,
        executionId: "dup-exec-1",
        issueId: id,
        epoch: 1,
      });
      mock.events.emit(CH.runCompleted, completion);
      await mock.flushEvents();
      // Byte-identical re-delivery (same messageId) AND a fresh-id copy:
      // the seen-set catches the first, the judgment inbox (no consumer
      // for that execution) swallows the second — zero further writes.
      mock.events.emit(CH.runCompleted, completion);
      mock.events.emit(CH.runCompleted, { ...completion, ...newEnvelope() });
      await mock.flushEvents();
      expect(metadataOf(graph, id).workgraph_phase).toBe("judging");
      expect(await auditCount(graph.dir, id, "run-completed")).toBe(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("abandons on `missing`, the expired lease is reclaimed with a cancel for the OLD execution, and redispatch runs under the new epoch while the old late completion is rejected", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvgone", seed: 1 });
    const id = graph.seededIds[0]!;
    const RUN_OLD = "workgraph-run/rcv-gone-old";
    let clock = Date.now();
    stampDeadRun(graph, id, {
      runId: RUN_OLD,
      executorId: "fake-executor",
      executionId: "gone-exec-9",
      epoch: 5,
      expiresInMs: 60_000,
      nowMs: clock,
      fingerprint: "fp-survives",
    });
    const { mock, coordinator } = makeHarness({}, () => clock);
    const fake = installFakeExecutor(mock.events, {
      status: "missing",
      behavior: "accept-stall",
      supportsCancellation: true,
    });
    const ectx = makeEventContext(graph.dir);
    try {
      // 1. Executor answers `missing` → abandoned: no adoption, no renewal.
      const first = await coordinator.reconcile(ectx.ctx);
      expect(first.abandoned).toEqual([id]);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(await auditCount(graph.dir, id, "recovery-abandoned")).toBe(1);

      // 2. TTL passes; the reclaim path takes over: epoch bump, best-effort
      // run:cancel for the RECORDED execution, phase reset, leave-ready.
      clock += 120_000;
      const second = await coordinator.reconcile(ectx.ctx);
      expect(second.reclaimed).toEqual([id]);
      const cancels = busOn(mock, CH.runCancel) as { executionId?: string; workflowRunId?: string }[];
      expect(cancels).toHaveLength(1);
      expect(cancels[0]).toMatchObject({
        workflowRunId: RUN_OLD,
        executionId: "gone-exec-9",
      });
      let shown = graph.showIssue(id);
      expect(shown.status).toBe("open");
      expect(leaseEpochOf(shown)).toBe(6);
      expect(phaseOf(shown)).toBe("ready");
      expect(activeExecutionIdOf(shown)).toBeUndefined();
      // Fingerprint history survives reclaim (decision log).
      expect(metadataOf(graph, id)[WORKGRAPH_FAILURE_FINGERPRINT_KEY]).toBe(
        "fp-survives",
      );

      // 3. Redispatch under the new epoch: a normal tick claims it again.
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      const run = coordinator.current();
      expect(run?.phase).toBe("accepted");
      expect(run?.workflowRunId).not.toBe(RUN_OLD);
      shown = graph.showIssue(id);
      expect(leaseEpochOf(shown)).toBe(7);

      // 4. The old executor's LATE completion (old run, old epoch) lands
      // harmlessly: unknown run → zero writes, the new run is untouched.
      mock.events.emit(
        CH.runCompleted,
        completionFor({ runId: RUN_OLD, executionId: "gone-exec-9", issueId: id, epoch: 5 }),
      );
      await mock.flushEvents();
      expect(phaseOf(graph.showIssue(id))).toBe("implementing");
      expect(coordinator.current()?.workflowRunId).toBe(run?.workflowRunId);
      expect(await auditCount(graph.dir, id, "run-completed")).toBe(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("abandons immediately when no execution was recorded (crash between claim and accept) — no status request", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvnoexe", seed: 1 });
    const id = graph.seededIds[0]!;
    stampDeadRun(graph, id, {
      runId: "workgraph-run/rcv-noexec-1",
      executorId: "fake-executor",
      // NO executionId: intent persisted at claim, crash before accept.
    });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, { status: "active" });
    const ectx = makeEventContext(graph.dir);
    try {
      const report = await coordinator.reconcile(ectx.ctx);
      expect(report.abandoned).toEqual([id]);
      expect(fake.statusRequests).toHaveLength(0);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      const comments = await listComments(graph.dir, id);
      const abandoned = comments.filter((c) =>
        c.text.startsWith("workgraph-lease recovery-abandoned "),
      );
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]!.text).toContain("claim and accept");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("a status timeout is NOT evidence of life: abandoned, heartbeat never resumes", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvsilent", seed: 1 });
    const id = graph.seededIds[0]!;
    stampDeadRun(graph, id, {
      runId: "workgraph-run/rcv-silent-1",
      executorId: "fake-executor",
      executionId: "silent-exec-1",
    });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {}); // status defaults silent
    const ectx = makeEventContext(graph.dir);
    try {
      const report = await coordinator.reconcile(ectx.ctx);
      expect(report.abandoned).toEqual([id]);
      expect(report.readopted).toEqual([]);
      expect(fake.statusRequests).toHaveLength(1); // asked, never answered
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(coordinator.current()).toBeNull();
      const comments = await listComments(graph.dir, id);
      const abandoned = comments.filter((c) =>
        c.text.startsWith("workgraph-lease recovery-abandoned "),
      );
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]!.text).toContain("timed out");
      // The lease itself is untouched — the TTL sweep owns it now.
      expect(leaseHolderOf(graph.showIssue(id))).toBe("workgraph-run/rcv-silent-1");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("drops a hijacked run silently: holder/epoch moved while this coordinator was down", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvhijack", seed: 1 });
    const id = graph.seededIds[0]!;
    const RUN = "workgraph-run/rcv-hijack-victim";
    stampDeadRun(graph, id, {
      runId: RUN,
      executorId: "fake-executor",
      executionId: "hijack-exec-1",
    });
    // Another coordinator reclaimed while we were down: epoch bumped,
    // holder replaced — but the OLD workflow-run id metadata still names us.
    graph.bd([
      "update",
      id,
      "--set-metadata",
      "lease_holder=workgraph-run/the-other-coordinator",
      "--set-metadata",
      "lease_epoch=2",
      "--actor",
      "other-coordinator",
    ]);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, { status: "active" });
    const ectx = makeEventContext(graph.dir);
    try {
      const report = await coordinator.reconcile(ectx.ctx);
      expect(report.readopted).toEqual([]);
      expect(report.abandoned).toEqual([id]); // dropped, never adopted
      expect(fake.statusRequests).toHaveLength(0); // never even probed
      expect(heldLeases(graph.dir)).toHaveLength(0);
      // Silent drop: no audit spam on someone else's live run.
      expect(await auditCount(graph.dir, id, "recovery-abandoned")).toBe(0);
      expect(leaseHolderOf(graph.showIssue(id))).toBe(
        "workgraph-run/the-other-coordinator",
      );
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("restart mid-judging: the author is reconstructed from the durable trail and the reviewer flow resumes to acceptance", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvjudge", seed: 1 });
    const id = graph.seededIds[0]!;

    // ---- life before the crash: a REAL coordinator drives the issue to
    // parked-in-judging (implementer-only executor, nothing offers review).
    const first = makeHarness();
    const fakeA = installFakeExecutor(first.mock.events, {
      roleScripts: {
        implementer: { provenance: IMPL_PROV, artifacts: ["src/thing.ts"] },
      },
    });
    const ectx1 = makeEventContext(graph.dir);
    await settle(first.mock, ectx1.ctx);
    await first.mock.flushEvents();
    expect(metadataOf(graph, id).workgraph_phase).toBe("judging");
    const runId = String(metadataOf(graph, id).workgraph_workflow_run_id);
    fakeA.uninstall();

    // ---- the crash: in-memory state (held-lease registry, coordinator
    // state) is gone; Beads keeps the lease + lifecycle + audit trail.
    resetLeasesForTest();

    // ---- the restart: a FRESH coordinator with a reviewer-capable
    // executor reconciles the same workspace.
    const second = makeHarness();
    const fakeB = installFakeExecutor(second.mock.events, {
      executorId: "reviewer-exec",
      roles: ["reviewer"],
      roleScripts: {
        reviewer: { provenance: REV_PROV, verdict: { findings: [] } },
      },
    });
    const ectx2 = makeEventContext(graph.dir);
    try {
      const report = await second.coordinator.reconcile(ectx2.ctx);
      expect(report.readopted).toEqual([id]);

      // The reviewer flow resumed: the review request carried the
      // RECONSTRUCTED author's artifacts, the clean independent verdict
      // passed the gate, and the issue closed.
      const review = fakeB.requests.find((r) => r.role === "reviewer")!;
      expect(review).toBeDefined();
      expect(
        (review as typeof review & { artifacts?: string[] }).artifacts,
      ).toEqual(["src/thing.ts"]);
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("closed");
      expect(metadataOf(graph, id).workgraph_phase).toBe("accepted");
      expect(await auditCount(graph.dir, id, "judgment-closed")).toBe(1);
      // The re-adoption is audited as resumed (the lease survived the
      // restart under the same run identity and epoch).
      const comments = await listComments(graph.dir, id);
      const readopts = comments.filter((c) =>
        c.text.startsWith("workgraph-lease re-adopted "),
      );
      expect(readopts).toHaveLength(1);
      expect(readopts[0]!.text).toContain(`"workflowRunId":"${runId}"`);
      expect(readopts[0]!.text).toContain('"resumed":true');
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fakeB.uninstall();
      await second.coordinator.teardown(ectx2.ctx);
      await first.coordinator.teardown(ectx1.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a judging run with NO reconstructable author parks with the heartbeat instead of judging blind", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvpark", seed: 1 });
    const id = graph.seededIds[0]!;
    const RUN = "workgraph-run/rcv-park-1";
    // Stamped straight into judging with no run-completed audit trail.
    stampDeadRun(graph, id, {
      runId: RUN,
      phase: "judging",
      executorId: "fake-executor",
      executionId: "park-exec-1",
    });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["reviewer"],
      roleScripts: { reviewer: { provenance: REV_PROV, verdict: { findings: [] } } },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      const report = await coordinator.reconcile(ectx.ctx);
      expect(report.readopted).toEqual([id]);
      // Parked: adopted and heartbeat-held, but NO review was requested —
      // there is no author record to judge against.
      expect(fake.requests).toHaveLength(0);
      expect(metadataOf(graph, id).workgraph_phase).toBe("judging");
      expect(heldLeases(graph.dir)).toHaveLength(1);
      const comments = await listComments(graph.dir, id);
      const readopts = comments.filter((c) =>
        c.text.startsWith("workgraph-lease re-adopted "),
      );
      expect(readopts).toHaveLength(1);
      expect(readopts[0]!.text).toContain('"resumed":false');
      // The heartbeat actually renews the re-adopted lease (same epoch).
      await coordinator.beat(ectx.ctx);
      expect(leaseEpochOf(graph.showIssue(id))).toBe(1);
      expect(heldLeases(graph.dir)).toHaveLength(1);
      // Teardown releases the parked run (no in-flight execution).
      await coordinator.teardown(ectx.ctx);
      expect(graph.showIssue(id).status).toBe("open");
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("reconciliation is safe to re-run: a second pass adopts nothing twice", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvrerun", seed: 1 });
    const id = graph.seededIds[0]!;
    stampDeadRun(graph, id, {
      runId: "workgraph-run/rcv-rerun-1",
      executorId: "fake-executor",
      executionId: "rerun-exec-1",
    });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, { status: "active" });
    const ectx = makeEventContext(graph.dir);
    try {
      const first = await coordinator.reconcile(ectx.ctx);
      expect(first.readopted).toEqual([id]);
      const second = await coordinator.reconcile(ectx.ctx);
      expect(second).toEqual({
        readopted: [],
        completed: [],
        abandoned: [],
        reclaimed: [],
      });
      expect(heldLeases(graph.dir)).toHaveLength(1);
      expect(await auditCount(graph.dir, id, "re-adopted")).toBe(1);
      expect(fake.statusRequests).toHaveLength(1); // probed exactly once
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("a run-held lease with NO expiry is abandoned EXPLICITLY (reported + audited), never probed or silently skipped", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvnoexp", seed: 1 });
    const id = graph.seededIds[0]!;
    const RUN = "workgraph-run/rcv-noexp-1";
    stampDeadRun(graph, id, {
      runId: RUN,
      executorId: "fake-executor",
      executionId: "noexp-exec-1",
    });
    // The anomaly: a run holder whose expiry was lost or never written
    // ("" reads undefined). The sweep NEVER auto-reclaims a no-expiry
    // claim, so a silent recovery skip would strand it in_progress forever.
    graph.bd([
      "update",
      id,
      "--set-metadata",
      "lease_expires_at=",
      "--actor",
      "dead-coordinator",
    ]);
    const { mock, coordinator } = makeHarness();
    // Even a LIVE executor answering `active` must not matter: the run is
    // abandoned before any status probe (there is no expiry to fence by).
    const fake = installFakeExecutor(mock.events, { status: "active" });
    const ectx = makeEventContext(graph.dir);
    try {
      const report = await coordinator.reconcile(ectx.ctx);
      expect(report.abandoned).toEqual([id]);
      expect(report.readopted).toEqual([]);
      expect(fake.statusRequests).toHaveLength(0);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      const comments = await listComments(graph.dir, id);
      const abandoned = comments.filter((c) =>
        c.text.startsWith("workgraph-lease recovery-abandoned "),
      );
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]!.text).toContain("no lease_expires_at");
      // The claim itself is untouched — operator territory, but VISIBLE.
      expect(leaseHolderOf(graph.showIssue(id))).toBe(RUN);
      expect(graph.showIssue(id).status).toBe("in_progress");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("a run-completed audit with a garbled outcome is NOT trusted: the judging run parks instead of resuming", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvbadout", seed: 1 });
    const id = graph.seededIds[0]!;
    const RUN = "workgraph-run/rcv-badout-1";
    stampDeadRun(graph, id, {
      runId: RUN,
      phase: "judging",
      executorId: "fake-executor",
      executionId: "badout-exec-1",
    });
    // A durable trail EXISTS but its outcome is corrupted — reconstruction
    // must never infer success (or ANY outcome) from a garbled record.
    graph.bd([
      "comment",
      id,
      `workgraph-lease run-completed ${JSON.stringify({
        workflowRunId: RUN,
        executionId: "badout-exec-1",
        outcome: "sucess!!",
        artifacts: ["src/thing.ts"],
        evidence: [],
        provenance: IMPL_PROV,
      })}`,
      "--actor",
      "dead-coordinator",
    ]);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["reviewer"],
      roleScripts: {
        reviewer: { provenance: REV_PROV, verdict: { findings: [] } },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      const report = await coordinator.reconcile(ectx.ctx);
      expect(report.readopted).toEqual([id]);
      // Parked (heartbeat only): NO review was requested off the corrupted
      // trail, and the re-adoption is audited resumed:false.
      expect(fake.requests).toHaveLength(0);
      expect(metadataOf(graph, id).workgraph_phase).toBe("judging");
      expect(heldLeases(graph.dir)).toHaveLength(1);
      const comments = await listComments(graph.dir, id);
      const readopts = comments.filter((c) =>
        c.text.startsWith("workgraph-lease re-adopted "),
      );
      expect(readopts).toHaveLength(1);
      expect(readopts[0]!.text).toContain('"resumed":false');
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// the sweep's coordinator-aware reclaim (direct composition)
// ---------------------------------------------------------------------------

describe("sweep reclaim publishes cancel and clears execution state", () => {
  it("reclaimAndLeaveReady cancels the recorded execution, resets the phase, and preserves fingerprint history", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvsweep", seed: 1 });
    const id = graph.seededIds[0]!;
    const mock = makeMockPi();
    bindExec((command, args, options) => mock.exec(command, args, options));
    setWorkerIdOverride(WORKER);
    const nowMs = Date.now();
    stampDeadRun(graph, id, {
      runId: "workgraph-run/rcv-sweep-1",
      executorId: "fake-executor",
      executionId: "sweep-exec-3",
      epoch: 2,
      expiresInMs: -10_000, // already expired
      nowMs,
      fingerprint: "fp-keeps",
      attempt: 2,
    });
    try {
      const won = await reclaimAndLeaveReady(
        graph.dir,
        graph.showIssue(id),
        { ttlMs: TTL, now: () => nowMs },
        mock.events,
      );
      expect(won).toBe(true);

      const cancels = busOn(mock, CH.runCancel) as Record<string, unknown>[];
      expect(cancels).toHaveLength(1);
      expect(cancels[0]).toMatchObject({
        workflowRunId: "workgraph-run/rcv-sweep-1",
        issueId: id,
        executionId: "sweep-exec-3",
      });

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("open");
      expect(leaseHolderOf(shown)).toBeUndefined();
      expect(leaseEpochOf(shown)).toBe(3); // bumped by the reclaim, kept by release
      expect(phaseOf(shown)).toBe("ready"); // redispatchable again
      expect(activeExecutionIdOf(shown)).toBeUndefined(); // cleared ("" reads undefined)
      // Fingerprint + attempt history survive the reclaim (decision log).
      const metadata = metadataOf(graph, id);
      expect(metadata[WORKGRAPH_FAILURE_FINGERPRINT_KEY]).toBe("fp-keeps");
      expect(Number(metadata[WORKGRAPH_ATTEMPT_KEY])).toBe(2);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(await auditCount(graph.dir, id, "reclaim")).toBe(1);
      expect(await auditCount(graph.dir, id, "cancel-published")).toBe(1);
      expect(await auditCount(graph.dir, id, "release")).toBe(1);
    } finally {
      graph.cleanup();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// graceful shutdown
// ---------------------------------------------------------------------------

describe("graceful shutdown", () => {
  it("shutdown with an acked cancel releases the lease before exit", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvshack", seed: 1 });
    const id = graph.seededIds[0]!;
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      behavior: "accept-stall",
      supportsCancellation: true,
      cancel: "ack",
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(coordinator.current()?.phase).toBe("accepted");

      await coordinator.teardown(ectx.ctx);
      // Cancel → ack → release: the executor stopped, so releasing is safe.
      expect(fake.cancels).toHaveLength(1);
      expect(fake.cancels[0]!.reason).toBe("coordinator shutdown");
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("open");
      expect(leaseHolderOf(shown)).toBeUndefined();
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(await auditCount(graph.dir, id, "release")).toBe(1);
      expect(await auditCount(graph.dir, id, "abandoned-unacked-cancel")).toBe(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("shutdown without an ack ABANDONS: lease intact for TTL reclaim, audited abandoned-unacked-cancel", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvshno", seed: 1 });
    const id = graph.seededIds[0]!;
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      behavior: "accept-stall",
      supportsCancellation: true,
      cancel: "ignore", // the executor died before acking
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      const run = coordinator.current();
      expect(run?.phase).toBe("accepted");

      await coordinator.teardown(ectx.ctx); // waits out the 150 ms ack window
      // No release: the executor may still be mutating — the lease stays
      // INTACT (holder/epoch/expiry) so the TTL sweep reclaims it fenced.
      expect(fake.cancels).toHaveLength(1);
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(leaseHolderOf(shown)).toBe(run!.workflowRunId);
      // …but this process stopped renewing (registry empty = no heartbeat).
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(await auditCount(graph.dir, id, "abandoned-unacked-cancel")).toBe(1);
      expect(await auditCount(graph.dir, id, "release")).toBe(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("shutdown releases parked-judging runs immediately — no cancel wait", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvshpark", seed: 1 });
    const id = graph.seededIds[0]!;
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      supportsCancellation: true, // even a cancellable executor: nothing in flight
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(metadataOf(graph, id).workgraph_phase).toBe("judging");

      await coordinator.teardown(ectx.ctx);
      // A run parked in judgment has no in-flight execution to cancel.
      expect(busOn(mock, CH.runCancel)).toHaveLength(0);
      expect(graph.showIssue(id).status).toBe("open");
      expect(await auditCount(graph.dir, id, "release")).toBe(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("shutdown releases an in-session execution immediately (it cannot outlive the session)", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvshins", seed: 1 });
    const id = graph.seededIds[0]!;
    const mock = makeMockPi();
    bindExec((command, args, options) => mock.exec(command, args, options));
    setWorkerIdOverride(WORKER);
    const config: WorkgraphConfig = { ...CONFIG, compatInSessionExecutor: true };
    // Registration order mirrors index.ts: adapter first.
    registerInSessionExecutor(asExtensionAPI(mock), { getConfig: () => config });
    const coordinator = registerCoordinator(asExtensionAPI(mock), {
      getConfig: () => config,
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      const run = coordinator.current();
      expect(run?.phase).toBe("accepted");
      expect(run?.isolation).toBe("none");

      await coordinator.teardown(ectx.ctx);
      // isolation "none" → no cancel-first: released straight away.
      expect(busOn(mock, CH.runCancel)).toHaveLength(0);
      expect(graph.showIssue(id).status).toBe("open");
      expect(await auditCount(graph.dir, id, "release")).toBe(1);
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("fencing loss mid-run publishes run:cancel for the stale execution", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvfence", seed: 1 });
    const id = graph.seededIds[0]!;
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, { behavior: "accept-stall" });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      const run = coordinator.current();
      expect(run?.phase).toBe("accepted");
      const executionId = run!.executionId!;
      const heldEpoch = leaseEpochOf(graph.showIssue(id));

      // A reclaimer takes the lease while the executor still runs.
      graph.bd([
        "update",
        id,
        "--set-metadata",
        "lease_holder=workgraph-run/reclaimer",
        "--set-metadata",
        `lease_epoch=${heldEpoch + 1}`,
        "--actor",
        "reclaimer",
      ]);

      await coordinator.beat(ectx.ctx);
      // The heartbeat discovered the loss: supervision dropped, the stale
      // execution cancelled, the loss audited.
      expect(coordinator.current()).toBeNull();
      const cancels = busOn(mock, CH.runCancel) as Record<string, unknown>[];
      expect(cancels).toHaveLength(1);
      expect(cancels[0]).toMatchObject({
        workflowRunId: run!.workflowRunId,
        executionId,
      });
      expect(String(cancels[0]!.reason)).toMatch(/lease lost/);
      expect(await auditCount(graph.dir, id, "fencing-loss")).toBe(1);

      // The stale executor's eventual completion changes nothing.
      fake.complete();
      await mock.flushEvents();
      expect(phaseOf(graph.showIssue(id))).toBe("implementing");
      expect(await auditCount(graph.dir, id, "run-completed")).toBe(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("shutdown mid-revision cancels the LIVE revision execution; unacked → abandoned, lease intact", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvshrev", seed: 1 });
    const id = graph.seededIds[0]!;
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "revision"],
      supportsCancellation: true,
      cancel: "ignore", // the revisor never acks — the abandon fork
      roleScripts: {
        implementer: { provenance: IMPL_PROV, artifacts: ["src/broken.ts"] },
        reviewer: {
          provenance: REV_PROV,
          verdict: {
            findings: [
              {
                criterion: "criterion-x",
                severity: "blocking",
                note: "does not hold",
              },
            ],
          },
        },
        // The revision is accepted, then stalls: an ISOLATED revision
        // execution is in flight when teardown arrives.
        revision: { behavior: "accept-stall", provenance: IMPL_PROV },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      // The judgment chain is live and blocked awaiting the stalled
      // revision — flushEvents() would deadlock on it. Poll the CHEAP
      // in-memory supervision state (a blocking bd poll would starve the
      // event loop the chain runs on) until the revision execution is
      // bound at its run:accepted.
      await until(() => {
        const run = coordinator.current();
        return run?.phase === "revising" && run.revisionInFlight === true;
      }, 45_000);
      const supervised = coordinator.current()!;
      const revisionExec = supervised.executionId!;
      const implementationExec = fake.completions[0]!.executionId;
      expect(revisionExec).not.toBe(implementationExec);
      const runId = supervised.workflowRunId;

      // `revisionInFlight` is set BEFORE the revising→revising self edge
      // that binds the execution id DURABLY — deliberately, so a teardown
      // racing that write still cancels the live execution. The assertions
      // below read that metadata, so gating only on the in-memory flag
      // races the write and intermittently observes the previous
      // (implementation) execution id. Wait for the durable binding, at a
      // relaxed interval because each poll is a blocking bd read.
      await until(
        () => activeExecutionIdOf(graph.showIssue(id)) === revisionExec,
        10_000,
        250,
      );

      await coordinator.teardown(ectx.ctx); // waits out the 150 ms ack window
      // The cancel targeted the REVISION execution (never the completed
      // implementation one), and with no ack the run was ABANDONED, not
      // released: the revisor may still be mutating — the lease stays
      // INTACT (holder/epoch/expiry) so the TTL sweep reclaims it fenced.
      expect(fake.cancels).toHaveLength(1);
      expect(fake.cancels[0]).toMatchObject({
        workflowRunId: runId,
        executionId: revisionExec,
        reason: "coordinator shutdown",
      });
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(leaseHolderOf(shown)).toBe(runId);
      expect(phaseOf(shown)).toBe("revising");
      expect(activeExecutionIdOf(shown)).toBe(revisionExec);
      // …but this process stopped renewing (registry empty = no heartbeat).
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(await auditCount(graph.dir, id, "abandoned-unacked-cancel")).toBe(1);
      expect(await auditCount(graph.dir, id, "release")).toBe(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 90_000);

  it("a reordered run:cancelled for an OLD execution inside the ack window is NOT the ack", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvstale", seed: 1 });
    const id = graph.seededIds[0]!;
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      behavior: "accept-stall",
      supportsCancellation: true,
      cancel: "ignore", // the LIVE executor never acks
    });
    const ectx = makeEventContext(graph.dir);
    const unsubs: (() => void)[] = [];
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      const run = coordinator.current();
      expect(run?.phase).toBe("accepted");
      const liveExecution = run!.executionId!;

      // A reordered ack from an EARLIER execution of the same workflow run
      // lands inside the shutdown ack window: same workflowRunId, DIFFERENT
      // executionId. cancelAndAwaitAck's correlation guard must skip it —
      // only an ack for the live execution (or timeout) may resolve.
      unsubs.push(
        mock.events.on(CH.runCancel, () => {
          mock.events.emit(CH.runCancelled, {
            ...newEnvelope(),
            workflowRunId: run!.workflowRunId,
            issueId: id,
            executionId: "stale-prior-exec-0",
          });
        }),
      );

      await coordinator.teardown(ectx.ctx); // waits out the FULL ack window
      // The stale ack did NOT count: unacked-cancel abandon, lease intact.
      expect(fake.cancels).toHaveLength(1);
      expect(fake.cancels[0]!.executionId).toBe(liveExecution);
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(leaseHolderOf(shown)).toBe(run!.workflowRunId);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(await auditCount(graph.dir, id, "abandoned-unacked-cancel")).toBe(1);
      expect(await auditCount(graph.dir, id, "release")).toBe(0);
    } finally {
      for (const off of unsubs) off();
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// compaction: run references survive a forced compaction
// ---------------------------------------------------------------------------

describe("compaction run references", () => {
  it("folds the run id, phase, attempt, and evidence into the takeover instructions", () => {
    const text = buildCompactionInstructions("User focus first.", {
      issueId: "wg-9",
      title: "Recover the thing",
      workflowRunId: "workgraph-run/compact-1",
      phase: "judging",
      attempt: 2,
      evidence: ["tests pass", "lint clean"],
    });
    expect(text.startsWith("User focus first.")).toBe(true);
    expect(text).toContain('wg-9 ("Recover the thing")');
    expect(text).toContain("workgraph-run/compact-1");
    expect(text).toContain("phase judging");
    expect(text).toContain("attempt 2");
    expect(text).toContain("tests pass; lint clean");
    // The issue-only shape (workgraph_claim fallback) stays run-free.
    const bare = buildCompactionInstructions(undefined, { issueId: "wg-7" });
    expect(bare).not.toContain("workflow run");
  });

  it("a forced compaction keeps the coordinator run id and phase in the summary instructions", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcvcomp", seed: 1 });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roleScripts: { implementer: { provenance: IMPL_PROV } },
    });
    const instructions: (string | undefined)[] = [];
    registerCompactionTakeover(asExtensionAPI(mock), {
      compactFn: (async (...args: unknown[]) => {
        instructions.push(args[4] as string | undefined);
        return { summary: "s", firstKeptEntryId: "entry-0", tokensBefore: 1 };
      }) as never,
      // The index.ts wiring: the coordinator's current run, refs included.
      getCurrent: () => {
        const run = coordinator.current();
        return run
          ? {
              issueId: run.issue.id,
              title: run.issue.title,
              workflowRunId: run.workflowRunId,
              phase: run.phase,
              attempt: run.attempt,
              ...(run.evidence !== undefined ? { evidence: run.evidence } : {}),
            }
          : null;
      },
    });
    const ectx = makeEventContext(graph.dir, { model: {} });
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      const run = coordinator.current();
      expect(run?.phase).toBe("judging"); // parked, lease heartbeat-held

      const { takenOver } = await mock.simulateForcedCompaction(ectx.ctx);
      expect(takenOver).toBe(true);
      expect(instructions[0]).toContain(run!.workflowRunId);
      expect(instructions[0]).toContain("phase judging");
      expect(instructions[0]).toContain(run!.issue.id);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);
});
