/**
 * The workflow-run coordinator: the phase-2 replacement for the dispatch
 * loop. Dispatch stops being "wake the model in this session" and becomes
 * "discover an executor, claim under a generated workflow-run identity,
 * request a run over the versioned protocol, and validate every response
 * against issue ID + workflow-run ID + lease epoch" (the fencing triple).
 *
 * The SCHEDULING SHELL is dispatch.ts's, unchanged: a timer started in
 * `session_start` plus an `agent_settled` listener funnel into one
 * reentrancy-guarded `tick`; readiness is judged by ARRAY LENGTH; the poll
 * floor is applied at the index.ts wiring layer only. The body follows the
 * plan's seven event-bus rules — the bus is process-local, has no replay,
 * and `emit()` does not await handlers:
 *   1. subscribe for correlated responses BEFORE emitting a request;
 *   2. bound discovery and acceptance with timeouts;
 *   3. persist intent (workflow-run ID + executor ID metadata) before
 *      emission;
 *   4. treat progress as lossy (`run:progress` is reserved — no handler);
 *   5. make terminal handlers idempotent (messageId seen-set + phase check);
 *   6. reconcile persisted runs on startup (fully built in phase 4);
 *   7. never infer success from silence.
 *
 * Invariants owned here:
 *  - NO EXECUTOR → NO CLAIM: discovery precedes any claim attempt; zero
 *    offers leave the ready pool untouched (the phase-0 pin).
 *  - APPROVED WORK ONLY: the coordinator claims lifecycle-v1 issues in
 *    phase "ready" (approved via workgraph_approve); legacy issues need the
 *    explicit `compatLegacyIssues` opt-in and receive lifecycle metadata at
 *    claim. Because bd's `ready --claim` is metadata-blind, claims go
 *    through the equally-atomic claim-by-id path after client-side
 *    filtering; a claim conflict is a lost race, not an error.
 *  - Every claim mints a FRESH workflow-run holder (via the injected
 *    IdentityProvider) — re-acquiring under a reused holder would be
 *    treated as a renewal (no epoch bump) and silently bypass fencing.
 *  - Reviewed/planned implementation completion transitions
 *    `workgraph_phase` to "judging"; a successful low-risk one-shot instead
 *    follows the verification/acceptance tail directly. The judgment gate
 *    remains the reviewed/planned path to accepted+closed: independent
 *    review → policy application → bounded revisions → workflow promotion
 *    or escalation → verification → policy-approved close. The state
 *    machine enforces policy; prompts only explain it.
 *  - Judgment-time completions (reviewer/revision runs) correlate by the
 *    executionId bound at their run:accepted — `run:completed` has no
 *    inReplyTo, and the active-run matching would misroute them since one
 *    workflow run holds through implementation AND judgment.
 *  - The coordinator never wakes the model itself: `pi.sendMessage` belongs
 *    to the in-session compatibility adapter alone.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordLeaseEvent } from "./audit.ts";
import {
  BdError,
  bdBinaryAvailable,
  close,
  ensureWorkspace,
  ready,
  setMetadata,
  show,
  update,
} from "./bd.ts";
import type { WorkgraphConfig } from "./config.ts";
import { DISPATCH_FLAG } from "./dispatch.ts";
import {
  discoverExecutors,
  ExecutorSelectionError,
  requestRun,
  selectExecutor,
} from "./executor-registry.ts";
import { identitySnapshot, localIdentityProvider } from "./identity.ts";
import {
  acquireLease,
  FencingError,
  getHeldLease,
  leaseEpochOf,
  leaseExpiresAtOf,
  leaseHolderOf,
  releaseLease,
  renewLease,
  trackLease,
  untrackLease,
  verifyHolding,
  type AcquireOutcome,
} from "./lease.ts";
import {
  activeExecutionIdOf,
  attemptOf,
  escalate,
  executorIdOf,
  failureFingerprintOf,
  isLifecycleV1,
  LifecycleError,
  phaseOf,
  riskTierOf,
  transition,
  workflowClassOf,
  workflowRunIdOf,
} from "./lifecycle.ts";
import {
  parsePlan,
  PlanError,
  planSummary,
  recordPlan,
  renderPlan,
} from "./plan.ts";
import { checkIndependence, resolvePolicy, type RiskTier } from "./policy.ts";
import {
  CH,
  newEnvelope,
  parseMessage,
  ProtocolError,
  RunCancelled,
  RunCompleted,
  SeenMessages,
  type ActivityT,
  type IsolationLevelT,
  type RunCancelT,
  type RunCompletedT,
  type RunRequestT,
} from "./protocol.ts";
import {
  emptyReport,
  listRunHeldInProgress,
  partitionByExpiry,
  reconstructAuthorCompletion,
  requestStatus,
  type ReconcileReport,
} from "./recovery.ts";
import { clearLeaseStatus, showLeaseStatus } from "./status.ts";
import { reclaimAndLeaveReady } from "./sweep.ts";
import type {
  BeadsIssue,
  IdentityProvider,
  Lease,
  LeaseActor,
  PlanT,
  WorkflowClassT,
  VerdictT,
} from "./types.ts";
import {
  Plan,
  Verdict,
  WORKGRAPH_ACTIVE_EXECUTION_ID_KEY,
  WORKGRAPH_ATTEMPT_KEY,
  WORKGRAPH_AUTHOR_PROVENANCE_KEY,
  WORKGRAPH_EXECUTOR_ID_KEY,
  WORKGRAPH_FAILURE_FINGERPRINT_KEY,
  WORKGRAPH_LAST_VERDICT_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_PLAN_SUMMARY_KEY,
  WORKGRAPH_PLANNER_PROVENANCE_KEY,
  WORKGRAPH_WORKFLOW_RUN_ID_KEY,
  WORKGRAPH_WORKFLOW_CLASS_KEY,
} from "./types.ts";
import {
  artifactDigest,
  blockingFindings,
  canonicalFindings,
  failureFingerprint,
  parseVerdict,
  recordVerdict,
  VerdictError,
  verdictSummary,
} from "./verdict.ts";

/**
 * Kill switch: the coordinator inherits dispatch's flag name — the operator
 * contract ("workgraph-dispatch=false means no autonomous claiming") is
 * unchanged even though the machinery underneath was replaced.
 */
export const COORDINATOR_FLAG = DISPATCH_FLAG;

export interface CoordinatorDeps {
  /** Effective config; resolved lazily (flags are not readable at load). */
  getConfig: () => WorkgraphConfig;
  /** Clock injection for tests (default Date.now). */
  now?: () => number;
  /** Identity seam (default {@link localIdentityProvider}). */
  identity?: IdentityProvider;
  /**
   * Warning sink (default console.error). The once-per-session compat
   * warnings (legacy auto-dispatch active, unreadable lease metadata)
   * assert through this seam — the pi-subagents adapter's injectable-warn
   * pattern.
   */
  warn?: (message: string) => void;
}

/**
 * Bounded retries for a review whose completion carried no parseable
 * verdict (the attempt is discarded and audited; counts against THIS bound,
 * never against `maxRevisions`). A knob with one exercised value is a
 * constant (decision log).
 */
export const MAX_REVIEW_RETRIES = 2;

/**
 * Resolve topology defensively. Approval already promotes non-low one-shot
 * requests, but hand-written metadata must not be able to bypass a blocking
 * risk policy.
 */
function effectiveWorkflowClass(issue: BeadsIssue): WorkflowClassT {
  const workflowClass = workflowClassOf(issue);
  return workflowClass === "oneshot" && riskTierOf(issue) !== "low"
    ? "reviewed"
    : workflowClass;
}

/** Protocol-safe form of the same conservative risk fallback policy uses. */
function effectiveRiskTier(issue: BeadsIssue): RiskTier {
  const riskTier = riskTierOf(issue);
  return riskTier === "low" || riskTier === "medium" || riskTier === "high"
    ? riskTier
    : "medium";
}

/** One workflow run the coordinator supervises. */
export interface CoordinatorRun {
  cwd: string;
  issue: BeadsIssue;
  lease: Lease;
  /** Run-scoped identity: holder = the workflow-run id, bdActor = initiator. */
  actor: LeaseActor;
  workflowRunId: string;
  executorId: string;
  executionId?: string;
  phase: "requested" | "accepted" | "judging" | "revising" | "verifying";
  /**
   * What the CURRENTLY in-flight primary run is for. `planner` and
   * `implementer` are the only values a supervised run takes: reviewer and
   * revision sub-runs are routed through the judgment inbox, not through
   * `state.active`. This is what lets one `run:completed` handler tell a
   * finished plan (→ dispatch the implementer) from a finished
   * implementation (→ hand to the judgment gate); `phase` alone cannot,
   * because both arrive as "requested"/"accepted".
   */
  role: "planner" | "implementer";
  /** The accepted plan, rendered for prompts — set once a planner run
   *  completes, then attached to the implementation run and to every
   *  revision of it. Undefined whenever no planner ran. */
  plan?: string;
  /** Current implementation/revision attempt (compaction folds it in). */
  attempt: number;
  /** The selected executor's advertised isolation — graceful shutdown
   *  releases isolation-"none" (in-session) runs immediately; isolated
   *  background runs get cancel-first semantics. Rebound to the REVISOR's
   *  offer while a revision execution is in flight. */
  isolation: IsolationLevelT;
  /** Whether the executor's offer advertised run:cancel support. Rebound
   *  to the revisor's offer while a revision execution is in flight. */
  supportsCancellation: boolean;
  /** True while an isolated revision execution is in flight — set at its
   *  `run:accepted` (alongside rebinding `executionId` and the revisor's
   *  offer flags), cleared when its completion arrives. Graceful shutdown
   *  must cancel-first these exactly like an active implementation run:
   *  the revisor may still be mutating, so releasing without an ack would
   *  invite a concurrent publisher (spec-phase-4 key decision). */
  revisionInFlight?: boolean;
  /** Evidence refs from the latest fenced completion (compaction). */
  evidence?: string[];
}

/** Handle returned by {@link registerCoordinator}; tests drive ticks directly. */
export interface CoordinatorController {
  /** One coordination pass. Reentrant calls no-op. */
  tick(ctx: ExtensionContext): Promise<void>;
  /** One heartbeat pass over every held run (what the heartbeat timer fires). */
  beat(ctx: ExtensionContext): Promise<void>;
  /**
   * Startup reconciliation (phase 4): converge persisted runs — re-adopt,
   * apply terminal results through the normal handler, abandon, or reclaim.
   * Runs on `session_start` before the first tick; ticks no-op while it is
   * in flight (the `reconciling` latch). Safe to re-run: fenced + idempotent.
   */
  reconcile(ctx: ExtensionContext): Promise<ReconcileReport>;
  /**
   * Graceful shutdown (plan §6): stop timers; runs with NO in-flight
   * execution (parked in judgment, never-accepted) and in-session runs
   * release immediately; an isolated background execution — an accepted
   * implementation run OR a live revision execution — gets `run:cancel`
   * first: an acked cancel releases, an unacked one ABANDONS (heartbeat
   * stopped, lease left intact for TTL reclaim — releasing under a possibly
   * still-mutating executor would invite a concurrent publisher; fencing
   * rejects the stale publish either way). Idempotent.
   */
  teardown(ctx?: ExtensionContext): Promise<void>;
  /** The in-flight run (compaction reads the issue title here): the active
   *  run when one exists, else the most recent run parked in judging. */
  current(): CoordinatorRun | null;
  /** Timer liveness, for lifecycle tests. */
  timersActive(): { poll: boolean; heartbeat: boolean };
}

export function registerCoordinator(
  pi: ExtensionAPI,
  deps: CoordinatorDeps,
): CoordinatorController {
  const nowFn = deps.now ?? Date.now;
  const ids = deps.identity ?? localIdentityProvider();

  /**
   * Once-per-session warning latch (the pi-subagents `warnOnce` pattern:
   * Set keyed by message, injectable sink). Deliberately NOT `logSkipOnce`
   * below — that is last-reason dedupe, reset whenever the pool empties, so
   * a compat warning routed through it would repeat every few ticks.
   */
  const warnSink = deps.warn ?? ((message: string) => console.error(message));
  const warned = new Set<string>();
  function warnOnce(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    warnSink(message);
  }

  /**
   * Whether a LEGACY issue carries a live lease that must be respected:
   * never claimed, regardless of `compatLegacyIssues` (the lease trio is
   * the frozen interop surface, and `acquireLease` would otherwise stamp
   * over the foreign holder with epoch + 1). Tolerant parse per the
   * lease-accessor discipline: a holder
   * whose expiry is missing or unparseable cannot be proven expired —
   * treat the issue as leased and warn once per issue.
   */
  function legacyLiveLease(issue: BeadsIssue): boolean {
    const holder = leaseHolderOf(issue);
    if (holder === undefined) return false;
    const expiresAt = leaseExpiresAtOf(issue);
    if (expiresAt === undefined) {
      warnOnce(
        `[pi-workgraph] legacy issue ${issue.id} has lease_holder ("${holder}") but no lease_expires_at — treating it as leased, never claiming it`,
      );
      return true;
    }
    const expiryMs = Date.parse(expiresAt);
    if (Number.isNaN(expiryMs)) {
      warnOnce(
        `[pi-workgraph] legacy issue ${issue.id} has an unparseable lease_expires_at — treating it as leased, never claiming it`,
      );
      return true;
    }
    return expiryMs > nowFn();
  }

  /**
   * Per-run mailbox for judgment-time completions. `run:completed` has no
   * `inReplyTo`, so reviewer/revision completions are routed here by
   * workflowRunId (SYNCHRONOUSLY, in the completion handler — an executor
   * may complete inside the request emit, before the judgment loop even
   * learns the executionId it must await) and consumed by executionId.
   */
  interface JudgmentInbox {
    messages: RunCompletedT[];
    waiters: (() => void)[];
    closed: boolean;
  }

  interface CoordinatorState {
    /** The run being requested or executed — capacity is 1, like v0 dispatch. */
    active: CoordinatorRun | null;
    /** Completion-in-progress latch for the active run — set SYNCHRONOUSLY
     *  at handler entry so a concurrent duplicate performs zero writes. */
    completing: boolean;
    /** Runs under judgment (judging/revising/verifying) or parked there:
     *  leases held and heartbeated until the gate resolves or shutdown. */
    judged: CoordinatorRun[];
    /** Judgment mailboxes, keyed by workflowRunId. */
    inboxes: Map<string, JudgmentInbox>;
    timer: ReturnType<typeof setInterval> | null;
    hb: ReturnType<typeof setInterval> | null;
    /** In-flight tick guard — set synchronously before any await. */
    ticking: boolean;
    /** Startup-reconciliation latch — set synchronously at reconcile()
     *  entry; ticks no-op while recovery converges persisted runs, so an
     *  early settle-tick can never race the adoption pass. */
    reconciling: boolean;
    lastSkipLog: string | null;
    seen: SeenMessages;
  }

  const state: CoordinatorState = {
    active: null,
    completing: false,
    judged: [],
    inboxes: new Map(),
    timer: null,
    hb: null,
    ticking: false,
    reconciling: false,
    lastSkipLog: null,
    seen: new SeenMessages(),
  };

  pi.registerFlag(COORDINATOR_FLAG, {
    description:
      "Enable the workgraph coordinator (discovers executors, claims ready issues under workflow-run leases, delegates over the executor protocol); set to false for tools + context injection without autonomy",
    type: "boolean",
    default: true,
  });

  function enabled(): boolean {
    return pi.getFlag(COORDINATOR_FLAG) !== false;
  }

  function logSkipOnce(reason: string): void {
    if (state.lastSkipLog === reason) return;
    state.lastSkipLog = reason;
    console.error(`[pi-workgraph] coordinator skipping: ${reason}`);
  }

  function clearSkipLog(): void {
    state.lastSkipLog = null;
  }

  function onInvalid(channel: string, error: ProtocolError): void {
    // Invalid payload → log once with channel + reason; no state change.
    logSkipOnce(`invalid message on ${channel}: ${error.detail}`);
  }

  function heldRuns(): CoordinatorRun[] {
    return state.active ? [...state.judged, state.active] : [...state.judged];
  }

  /** Status-bar detail: the durable phase plus the selected executor. The
   *  handshake states (`requested`/`accepted`) carry no durable phase of
   *  their own, so they render the phase their ROLE is running under —
   *  otherwise a planning run would report "implementing" while the issue
   *  sits in `planning`. */
  function statusDetail(run: CoordinatorRun): { phase: string; executorId: string } {
    const phase =
      run.phase === "requested" || run.phase === "accepted"
        ? run.role === "planner"
          ? "planning"
          : "implementing"
        : run.phase;
    return { phase, executorId: run.executorId };
  }

  function wakeInbox(box: JudgmentInbox): void {
    const waiters = box.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  function closeInbox(workflowRunId: string): void {
    const box = state.inboxes.get(workflowRunId);
    if (!box) return;
    box.closed = true;
    wakeInbox(box);
    state.inboxes.delete(workflowRunId);
  }

  /** Remove a run from judgment tracking (terminal, escalated, or stale). */
  function dropJudgedRun(run: CoordinatorRun): void {
    state.judged = state.judged.filter((r) => r !== run);
    closeInbox(run.workflowRunId);
    if (heldRuns().length === 0) stopHeartbeat();
  }

  /**
   * Abandon a judged run whose durable state moved underneath it (override,
   * re-approve, concurrent writer — every LifecycleError site): attempt a
   * fenced voluntary release FIRST — without it the Beads lease would sit
   * un-heartbeated until the expiry sweep (dropJudgedRun removes the run
   * from heldRuns, so neither the heartbeat nor teardown would ever touch
   * it) and the in-memory registry would keep rendering a stale claim in
   * context injection. A FencingError means the lease was already reclaimed
   * (releaseLease untracked it); any other failure still untracks locally
   * so no stale registry entry survives.
   */
  async function abandonJudgedRun(run: CoordinatorRun): Promise<void> {
    try {
      await releaseLease(run.cwd, run.lease, run.actor);
    } catch (e) {
      if (!(e instanceof FencingError)) {
        const msg = e instanceof Error ? e.message : String(e);
        logSkipOnce(`could not release ${run.lease.issueId}: ${msg}`);
        untrackLease(run.cwd, run.lease.issueId);
      }
    }
    dropJudgedRun(run);
  }

  /**
   * Await the completion of one judgment sub-run (by its executionId).
   * Resolves null when the inbox closes (teardown) — never hangs a stale
   * loop past shutdown. Messages for OTHER executions stay queued.
   */
  async function awaitCompletion(
    box: JudgmentInbox,
    executionId: string,
  ): Promise<RunCompletedT | null> {
    for (;;) {
      const idx = box.messages.findIndex((m) => m.executionId === executionId);
      if (idx >= 0) return box.messages.splice(idx, 1)[0]!;
      if (box.closed) return null;
      await new Promise<void>((resolve) => {
        box.waiters.push(resolve);
      });
    }
  }

  function stopHeartbeat(): void {
    if (state.hb) {
      clearInterval(state.hb);
      state.hb = null;
    }
  }

  function startHeartbeat(ctx: ExtensionContext, heartbeatMs: number): void {
    if (state.hb) return; // one interval renews every held run
    state.hb = setInterval(() => void beat(ctx), heartbeatMs);
  }

  /**
   * Publish a canonical lifecycle change on `workgraph:v1:activity`
   * (phase 5). OBSERVERS-ONLY: nothing in-core subscribes, and emission is
   * strictly POST-COMMIT — fired only AFTER the corresponding bd write
   * (transition/escalate/close) resolved, so observers can never see a
   * phantom transition; every LifecycleError path emits nothing. Fire-and-
   * forget like the audit trail: a broken observer must never take the
   * lifecycle down. COVERAGE GAP BY DESIGN: sweep reclaims and recovery
   * re-adoption/abandon live outside this module and emit no activity —
   * observers needing those read the audit trail (README notes the gap).
   */
  function emitActivity(a: {
    kind: "claim" | "transition" | "verdict" | "escalation" | "close";
    issueId: string;
    phase: string;
    workflowRunId?: string;
    actor?: string;
    summary?: string;
  }): void {
    try {
      const message: ActivityT = {
        ...newEnvelope(nowFn),
        issueId: a.issueId,
        phase: a.phase,
        kind: a.kind,
        ...(a.workflowRunId !== undefined
          ? { workflowRunId: a.workflowRunId }
          : {}),
        ...(a.actor !== undefined ? { actor: a.actor } : {}),
        ...(a.summary !== undefined ? { summary: a.summary } : {}),
      };
      pi.events.emit(CH.activity, message);
    } catch {
      // Observers-only: activity must never disturb the run.
    }
  }

  /**
   * In-flight executions per executor, derived from the SUPERVISED-RUN map
   * (never an independent counter — restart reconciliation rebuilds this
   * state, so a lost completion self-heals; spec-phase-5 failure-modes
   * row). Counted: the active implementation run and any live revision
   * execution. Short-lived reviewer sub-runs are awaited inline rather
   * than tracked as state and are not counted — `maxConcurrency` is a
   * scheduling hint, not a hard reservation.
   */
  function inFlightCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const bump = (executorId: string): void => {
      counts.set(executorId, (counts.get(executorId) ?? 0) + 1);
    };
    if (state.active) bump(state.active.executorId);
    for (const run of state.judged) {
      if (run.revisionInFlight === true) bump(run.executorId);
    }
    return counts;
  }

  /**
   * Best-effort `run:cancel` for a supervised run's recorded execution —
   * published on fencing loss (a stale executor may still be mutating; the
   * cancel is a courtesy, fencing is the guarantee) and by graceful
   * shutdown. Fire-and-forget: the emit has no failure signal.
   */
  function publishCancel(run: CoordinatorRun, reason: string): void {
    const cancel: RunCancelT = {
      ...newEnvelope(nowFn),
      workflowRunId: run.workflowRunId,
      issueId: run.lease.issueId,
      ...(run.executionId !== undefined ? { executionId: run.executionId } : {}),
      reason,
    };
    pi.events.emit(CH.runCancel, cancel);
  }

  /**
   * Shutdown's cancel→ack exchange: subscribe for `run:cancelled` BEFORE
   * emitting `run:cancel` (rule 1 — an adapter may ack synchronously),
   * correlate by workflowRunId (and executionId when both sides carry one),
   * bounded by `timeoutMs`. Resolves false on timeout — silence is never an
   * acknowledgment.
   */
  function cancelAndAwaitAck(
    run: CoordinatorRun,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const unsubscribe = pi.events.on(CH.runCancelled, (data) => {
        try {
          const msg = parseMessage(CH.runCancelled, RunCancelled, data);
          if (msg.workflowRunId !== run.workflowRunId) return;
          if (
            msg.executionId !== undefined &&
            run.executionId !== undefined &&
            msg.executionId !== run.executionId
          ) {
            return; // an ack for some OTHER execution of this run
          }
          finish(true);
        } catch (e) {
          if (e instanceof ProtocolError) onInvalid(CH.runCancelled, e);
        }
      });

      function finish(acked: boolean): void {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(acked);
      }

      timer = setTimeout(() => finish(false), timeoutMs);
      publishCancel(run, "coordinator shutdown");
    });
  }

  // -------------------------------------------------------------------------
  // Completion handling — a PERSISTENT subscription registered before any
  // request this coordinator will ever emit (subscribe-first, rule 1), so a
  // completion can never race past its subscription.
  // -------------------------------------------------------------------------

  /**
   * Finish a one-shot implementation. Success follows the explicit
   * verification/acceptance tail and closes; failure promotes the issue to
   * the reviewed workflow and returns it to the ready pool for a stronger
   * implementation + independent judgment pass.
   */
  async function finishOneshot(
    run: CoordinatorRun,
    msg: RunCompletedT,
  ): Promise<void> {
    run.executionId = msg.executionId;
    run.evidence = [...msg.evidence];
    if (msg.outcome !== "success") {
      await setMetadata(
        run.cwd,
        run.lease.issueId,
        {
          [WORKGRAPH_PHASE_KEY]: "ready",
          [WORKGRAPH_WORKFLOW_CLASS_KEY]: "reviewed",
          [WORKGRAPH_ACTIVE_EXECUTION_ID_KEY]: "",
        },
        run.actor.bdActor,
      );
      await recordLeaseEvent(
        run.cwd,
        "workflow-promoted",
        run.lease.issueId,
        {
          workflowRunId: run.workflowRunId,
          from: "oneshot",
          to: "reviewed",
          outcome: msg.outcome,
          executionId: msg.executionId,
        },
        run.actor.bdActor,
      );
      emitActivity({
        kind: "transition",
        issueId: run.lease.issueId,
        phase: "ready",
        workflowRunId: run.workflowRunId,
        actor: run.actor.bdActor,
        summary: `one-shot ${msg.outcome}; promoted to reviewed`,
      });
      state.active = null;
      if (heldRuns().length === 0) stopHeartbeat();
      try {
        await releaseLease(run.cwd, run.lease, run.actor);
      } catch (e) {
        if (!(e instanceof FencingError)) throw e;
      }
      return;
    }

    await transition(run.cwd, run.lease.issueId, "implementing", "verifying", {
      fields: {
        [WORKGRAPH_AUTHOR_PROVENANCE_KEY]: JSON.stringify(msg.provenance),
      },
      actor: run.actor.bdActor,
    });
    run.phase = "verifying";
    emitActivity({
      kind: "transition",
      issueId: run.lease.issueId,
      phase: "verifying",
      workflowRunId: run.workflowRunId,
      actor: run.actor.bdActor,
      summary: `one-shot implementation completed by ${run.executorId}`,
    });
    // No verifier commands are configured in protocol v1, so this is the
    // same explicit pass-through verification tail used after judgment.
    await transition(run.cwd, run.lease.issueId, "verifying", "accepted", {
      actor: run.actor.bdActor,
    });
    emitActivity({
      kind: "transition",
      issueId: run.lease.issueId,
      phase: "accepted",
      workflowRunId: run.workflowRunId,
      actor: run.actor.bdActor,
      summary: "one-shot verification passed",
    });
    await close(
      run.cwd,
      run.lease.issueId,
      "accepted by the one-shot workflow",
      run.actor.bdActor,
    );
    untrackLease(run.cwd, run.lease.issueId);
    state.active = null;
    if (heldRuns().length === 0) stopHeartbeat();
    emitActivity({
      kind: "close",
      issueId: run.lease.issueId,
      phase: "accepted",
      workflowRunId: run.workflowRunId,
      actor: run.actor.bdActor,
      summary: "closed after one-shot verification",
    });
    await recordLeaseEvent(
      run.cwd,
      "oneshot-closed",
      run.lease.issueId,
      {
        workflowRunId: run.workflowRunId,
        executionId: msg.executionId,
        provenance: msg.provenance,
        actor: identitySnapshot(run.actor),
      },
      run.actor.bdActor,
    );
  }

  async function onCompleted(raw: unknown): Promise<void> {
    let msg: RunCompletedT;
    try {
      msg = parseMessage(CH.runCompleted, RunCompleted, raw);
    } catch (e) {
      if (e instanceof ProtocolError) onInvalid(CH.runCompleted, e);
      return;
    }

    // Idempotency, half 1: a duplicate messageId performs zero writes —
    // recorded synchronously, so a re-delivery racing this handler is safe.
    if (state.seen.seen(msg.messageId)) return;

    // Judgment-time completions (reviewer/revision runs) are routed by
    // workflowRunId into the run's inbox — SYNCHRONOUSLY, before any await:
    // the judgment loop correlates by executionId once its run:accepted
    // resolves, and validates the fencing triple at consumption time.
    const box = state.inboxes.get(msg.workflowRunId);
    if (box) {
      box.messages.push(msg);
      wakeInbox(box);
      return;
    }

    const run = state.active;
    if (!run || run.workflowRunId !== msg.workflowRunId) {
      // Late/unknown completion (run already judged, released, or never
      // ours). No run state → no durable transition; log once.
      logSkipOnce(
        `ignoring run:completed for unknown or finished run ${msg.workflowRunId}`,
      );
      return;
    }

    // Idempotency, half 2: the current-phase check. `completing` is the
    // synchronous latch covering the await gap below.
    if (run.phase !== "requested" && run.phase !== "accepted") return;
    if (state.completing) return;
    state.completing = true;
    let startJudgment = false;
    let startImplementation = false;
    try {
      // Fencing triple, part 1: the payload must match the run we supervise.
      const payloadMatches =
        msg.issueId === run.lease.issueId &&
        msg.leaseEpoch === run.lease.epoch &&
        msg.workflowRunId === run.workflowRunId;

      // Fencing triple, part 2: re-validate against Beads — the epoch and
      // holder must still be current AND the persisted workflow-run id must
      // still be ours. Never trust cached lease state across the await gap.
      let beadsMatches = false;
      if (payloadMatches) {
        if (await verifyHolding(run.cwd, run.lease, run.actor.holder)) {
          const cur = await show(run.cwd, run.lease.issueId);
          beadsMatches =
            cur.metadata?.[WORKGRAPH_WORKFLOW_RUN_ID_KEY] === run.workflowRunId;
        }
      }

      if (!payloadMatches || !beadsMatches) {
        // Mismatch → ignore + audit; never partial-apply.
        await recordLeaseEvent(
          run.cwd,
          "stale-result-rejected",
          msg.issueId,
          {
            workflowRunId: msg.workflowRunId,
            executionId: msg.executionId,
            payloadEpoch: msg.leaseEpoch,
            heldEpoch: run.lease.epoch,
            reason: payloadMatches
              ? "lease no longer current in Beads (reclaimed or rewritten)"
              : "payload fencing triple does not match the supervised run",
          },
          run.actor.bdActor,
        );
        if (payloadMatches && !beadsMatches) {
          // Our whole run is stale (reclaimed out from under us): drop it —
          // and cancel our own now-stale execution (phase 4): the executor
          // is evidently still live (it just reported), but its lease is
          // lost; the rejection above is the guarantee, the cancel stops
          // it from working on.
          publishCancel(run, "lease lost (stale completion rejected)");
          untrackLease(run.cwd, run.lease.issueId);
          state.active = null;
          if (heldRuns().length === 0) stopHeartbeat();
        }
        return;
      }

      // Fenced: record the evidence, transition to judging (guarded CAS,
      // stamping the author's reported provenance in the SAME write), KEEP
      // the lease, and hand the run to the judgment gate.
      await recordLeaseEvent(
        run.cwd,
        "run-completed",
        run.lease.issueId,
        {
          workflowRunId: run.workflowRunId,
          executionId: msg.executionId,
          executorId: run.executorId,
          role: run.role,
          outcome: msg.outcome,
          artifacts: msg.artifacts,
          evidence: msg.evidence,
          provenance: msg.provenance,
        },
        run.actor.bdActor,
      );

      // A finished PLAN is not a finished implementation: it advances
      // planning → implementing and is re-dispatched, never reaching the
      // judgment gate. The durable part runs inside the `completing` latch
      // (so a duplicate completion cannot double-transition); the DISPATCH
      // deliberately does not — see the tail of this function.
      if (run.role === "planner") {
        startImplementation = await acceptPlan(run, msg);
      } else if (effectiveWorkflowClass(run.issue) === "oneshot") {
        await finishOneshot(run, msg);
      } else {
        try {
          await transition(run.cwd, run.lease.issueId, "implementing", "judging", {
            fields: {
              [WORKGRAPH_AUTHOR_PROVENANCE_KEY]: JSON.stringify(msg.provenance),
            },
            actor: run.actor.bdActor,
          });
        } catch (e) {
          if (e instanceof LifecycleError) {
            // A concurrent writer moved the phase under our lease (override,
            // re-approve): this run no longer describes reality — drop it.
            logSkipOnce(e.message);
            untrackLease(run.cwd, run.lease.issueId);
            state.active = null;
            if (heldRuns().length === 0) stopHeartbeat();
            return;
          }
          throw e;
        }
        // POST-COMMIT: the judging transition just resolved.
        emitActivity({
          kind: "transition",
          issueId: run.lease.issueId,
          phase: "judging",
          workflowRunId: run.workflowRunId,
          actor: run.actor.bdActor,
          summary: `implementation completed (${msg.outcome}) by ${run.executorId}`,
        });
        run.executionId = msg.executionId;
        run.evidence = [...msg.evidence];
        run.phase = "judging";
        state.judged.push(run);
        state.inboxes.set(run.workflowRunId, {
          messages: [],
          waiters: [],
          closed: false,
        });
        state.active = null;
        startJudgment = true;
      }
    } finally {
      state.completing = false;
    }
    // BOTH continuations run OUTSIDE the `completing` latch, and for the same
    // reason: each emits a request whose executor may answer synchronously on
    // the process-local bus, so the resulting `run:completed` re-enters this
    // handler DURING the call. Dispatching the implementation inside the
    // latch would make that completion hit `if (state.completing) return` and
    // be dropped — the run would then sit in `implementing` until its lease
    // expired, with the plan already committed. Awaited so the handler's
    // promise spans the whole chain (test buses drain it; the real bus
    // ignores the return value).
    if (startImplementation) await dispatchImplementation(run);
    if (startJudgment) await judge(run, msg);
  }

  /**
   * A fenced planner completion: validate the reported plan, persist it, and
   * advance planning → implementing. Returns whether the caller should go on
   * to dispatch the implementation run — the dispatch itself must happen
   * OUTSIDE the `completing` latch this runs under (see `onCompleted`'s
   * tail), so every path here reports its decision rather than acting on it.
   *
   * FAILURE IS ESCALATION, NOT DEGRADATION. A planner that reports
   * `failure`/`blocked`, or returns a payload that is not a valid plan, does
   * NOT fall through to an unplanned implementation: the operator asked for
   * a planning tier, and silently implementing without one would look
   * identical to success while being exactly the thing they wanted to
   * prevent. Escalation parks the issue as `blocked`, audited, and is
   * recoverable via re-approve — the same contract the judgment gate uses
   * when it cannot obtain independent review.
   *
   * No retry loop here, deliberately: the reviewer's bounded retry exists
   * because a verdict is a JUDGMENT the gate cannot proceed without, while a
   * failed plan has a cheap human recovery (re-approve, having fixed the
   * planner). One knob with one exercised value is a constant.
   */
  async function acceptPlan(
    run: CoordinatorRun,
    msg: RunCompletedT,
  ): Promise<boolean> {
    if (msg.outcome !== "success") {
      await escalateRun(
        run,
        "planning",
        `planning run reported ${msg.outcome}`,
      );
      return false;
    }

    let plan: PlanT;
    try {
      plan = parsePlan((msg as RunCompletedT & { plan?: unknown }).plan);
    } catch (e) {
      const detail = e instanceof PlanError ? e.detail : String(e);
      await recordLeaseEvent(
        run.cwd,
        "plan-invalid",
        run.lease.issueId,
        {
          workflowRunId: run.workflowRunId,
          executionId: msg.executionId,
          executorId: run.executorId,
          detail,
        },
        run.actor.bdActor,
      );
      await escalateRun(run, "planning", `planner returned an invalid plan: ${detail}`);
      return false;
    }

    // Persist the plan trail BEFORE the transition: a crash between the two
    // leaves a recorded plan on an issue still in `planning`, which the
    // sweep reclaims to `ready` — recoverable. The reverse order would
    // advance the phase with no trail behind it.
    await recordPlan(
      run.cwd,
      run.lease.issueId,
      plan,
      {
        workflowRunId: run.workflowRunId,
        executionId: msg.executionId,
        executorId: run.executorId,
        provenance: msg.provenance,
      },
      run.actor.bdActor,
    );

    try {
      await transition(run.cwd, run.lease.issueId, "planning", "implementing", {
        fields: {
          [WORKGRAPH_PLAN_SUMMARY_KEY]: planSummary(plan),
          [WORKGRAPH_PLANNER_PROVENANCE_KEY]: JSON.stringify(msg.provenance),
        },
        actor: run.actor.bdActor,
      });
    } catch (e) {
      if (e instanceof LifecycleError) {
        // A concurrent writer moved the phase under our lease (override,
        // re-approve): this run no longer describes reality — drop it.
        logSkipOnce(e.message);
        untrackLease(run.cwd, run.lease.issueId);
        state.active = null;
        if (heldRuns().length === 0) stopHeartbeat();
        return false;
      }
      throw e;
    }
    emitActivity({
      kind: "transition",
      issueId: run.lease.issueId,
      phase: "implementing",
      workflowRunId: run.workflowRunId,
      actor: run.actor.bdActor,
      summary: `plan accepted (${plan.steps.length} steps) from ${run.executorId}`,
    });

    // The SAME run continues: same lease, same workflow-run id, same
    // fencing triple. Only the role and the executor rebind — which is what
    // keeps the whole planner → implementer → judgment chain one supervised
    // run, exactly as judgment sub-runs stay inside the run that authored
    // the work.
    run.role = "implementer";
    run.plan = renderPlan(plan);
    run.phase = "requested";
    delete run.executionId;
    return true;
  }

  /**
   * Dispatch the implementation run for a run already transitioned into
   * `implementing`. Split out of the claim path because the planner tier
   * reaches this point from a completion handler rather than a tick, with a
   * lease it already holds.
   */
  async function dispatchImplementation(run: CoordinatorRun): Promise<void> {
    const config = deps.getConfig();
    const offers = await discoverExecutors(pi.events, {
      timeoutMs: config.discoveryTimeoutMs,
      now: nowFn,
      onInvalid,
    });
    // The planner's execution has TERMINATED — this runs on its completion —
    // but `state.active` still carries its executorId, so the generic
    // in-flight count would charge it a slot it no longer occupies. Release
    // that slot before selecting: otherwise ONE executor offering both roles
    // at `maxConcurrency: 1` is judged at capacity for the very
    // implementation it just planned, and the issue is handed back on every
    // attempt — a permanent stall for the most natural single-adapter setup.
    const counts = new Map(inFlightCounts());
    const held = counts.get(run.executorId);
    if (held !== undefined) {
      if (held <= 1) counts.delete(run.executorId);
      else counts.set(run.executorId, held - 1);
    }

    let implementer;
    try {
      implementer = selectExecutor(
        offers,
        { role: "implementer", requiresIsolation: false },
        { executorId: config.executorId },
        counts,
      );
    } catch (e) {
      if (!(e instanceof ExecutorSelectionError)) throw e;
      implementer = undefined;
    }
    if (!implementer) {
      // The implementer that existed at claim time is gone (a genuine race,
      // not a steady state — the tick refuses to plan without one). Hand the
      // issue back rather than parking: the plan is durable in the comment
      // trail, so nothing is lost but the redundant re-plan.
      await handBackAfterPlanning(
        run,
        "no implementer-capable executor remained after planning",
      );
      return;
    }

    run.executorId = implementer.executorId;
    run.isolation = implementer.isolation;
    run.supportsCancellation = implementer.supportsCancellation;
    await setMetadata(
      run.cwd,
      run.lease.issueId,
      { [WORKGRAPH_EXECUTOR_ID_KEY]: implementer.executorId },
      run.actor.bdActor,
    );

    const request: RunRequestT = {
      ...newEnvelope(nowFn),
      executorId: implementer.executorId,
      issue: {
        id: run.issue.id,
        title: run.issue.title,
        workflowClass: effectiveWorkflowClass(run.issue),
        riskTier: effectiveRiskTier(run.issue),
        ...(run.issue.description !== undefined
          ? { description: run.issue.description }
          : {}),
        ...(run.issue.acceptance_criteria !== undefined
          ? { acceptanceCriteria: run.issue.acceptance_criteria }
          : {}),
      },
      workflowRunId: run.workflowRunId,
      leaseEpoch: run.lease.epoch,
      role: "implementer",
      attempt: run.attempt,
      workspace: { baseRevision: "", requiresIsolation: false },
      ...(run.plan !== undefined ? { plan: run.plan } : {}),
    };
    const result = await requestRun(pi.events, request, {
      timeoutMs: config.acceptTimeoutMs,
      onInvalid,
    });
    if (result.kind === "accepted") {
      if (state.active === run && run.phase === "requested") {
        run.phase = "accepted";
        run.executionId = result.message.executionId;
        await setMetadata(
          run.cwd,
          run.lease.issueId,
          { [WORKGRAPH_ACTIVE_EXECUTION_ID_KEY]: result.message.executionId },
          run.actor.bdActor,
        );
      }
      clearSkipLog();
      return;
    }
    if (state.active !== run || run.phase !== "requested") return;
    await recordLeaseEvent(
      run.cwd,
      result.kind === "rejected" ? "executor-rejected" : "accept-timeout",
      run.lease.issueId,
      {
        workflowRunId: run.workflowRunId,
        executorId: implementer.executorId,
        role: "implementer",
        via: "post-planning",
        ...(result.kind === "rejected"
          ? { reason: result.message.reason }
          : { timeoutMs: config.acceptTimeoutMs }),
      },
      run.actor.bdActor,
    );
    await handBackAfterPlanning(
      run,
      result.kind === "rejected"
        ? "implementer rejected the post-planning run"
        : "implementer did not accept the post-planning run",
    );
  }

  /**
   * Hand a planned-but-undispatched issue back to the ready pool: phase
   * reset and lease released. Like the claim path's reject/timeout release,
   * the `implementing` → `ready` write is a deliberate RAW write rather than
   * a LEGAL edge — the never-started recovery path, coordinator-owned and
   * audited.
   */
  async function handBackAfterPlanning(
    run: CoordinatorRun,
    reason: string,
  ): Promise<void> {
    logSkipOnce(`${run.lease.issueId}: ${reason} — returned to the ready pool`);
    state.active = null;
    if (heldRuns().length === 0) stopHeartbeat();
    await setMetadata(
      run.cwd,
      run.lease.issueId,
      { [WORKGRAPH_PHASE_KEY]: "ready" },
      run.actor.bdActor,
    );
    try {
      await releaseLease(run.cwd, run.lease, run.actor);
    } catch (e) {
      if (!(e instanceof FencingError)) {
        const detail = e instanceof Error ? e.message : String(e);
        logSkipOnce(`could not release ${run.lease.issueId}: ${detail}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The judgment gate (phase 3). Every gate is a CODE check — tool and
  // context text only explain it. The loop: independent review → verdict
  // validation → independence check → apply (revise / verify / escalate) →
  // bounded revisions with fingerprint escalation → policy-approved close.
  // -------------------------------------------------------------------------

  /**
   * Re-validate a judgment sub-run completion against the fencing triple
   * AND Beads (never trust cached lease state across an await gap). A
   * mismatch is audited and means the whole run is stale.
   */
  async function fencedForJudgment(
    run: CoordinatorRun,
    msg: RunCompletedT,
  ): Promise<boolean> {
    const payloadMatches =
      msg.issueId === run.lease.issueId &&
      msg.leaseEpoch === run.lease.epoch &&
      msg.workflowRunId === run.workflowRunId;
    let beadsMatches = false;
    if (payloadMatches) {
      if (await verifyHolding(run.cwd, run.lease, run.actor.holder)) {
        const cur = await show(run.cwd, run.lease.issueId);
        beadsMatches =
          cur.metadata?.[WORKGRAPH_WORKFLOW_RUN_ID_KEY] === run.workflowRunId;
      }
    }
    if (payloadMatches && beadsMatches) return true;
    await recordLeaseEvent(
      run.cwd,
      "stale-result-rejected",
      msg.issueId,
      {
        workflowRunId: msg.workflowRunId,
        executionId: msg.executionId,
        payloadEpoch: msg.leaseEpoch,
        heldEpoch: run.lease.epoch,
        via: "judgment",
        reason: payloadMatches
          ? "lease no longer current in Beads (reclaimed or rewritten)"
          : "payload fencing triple does not match the supervised run",
      },
      run.actor.bdActor,
    );
    return false;
  }

  /**
   * Escalate a run out of the gate: phase → `escalated` (CAS-guarded, any
   * active phase — a coordinator-owned recovery edge like override and
   * lease loss), audited with the reason and an immutable actor snapshot,
   * lease released, and bd status → `blocked` so the issue leaves the ready
   * pool. Recoverable via re-approve.
   */
  async function escalateRun(
    run: CoordinatorRun,
    expect: "planning" | "implementing" | "judging" | "revising" | "verifying",
    reason: string,
    fields: Record<string, string> = {},
  ): Promise<void> {
    try {
      await escalate(run.cwd, run.lease.issueId, expect, {
        fields,
        actor: run.actor.bdActor,
      });
    } catch (e) {
      if (e instanceof LifecycleError) {
        logSkipOnce(e.message);
        await abandonJudgedRun(run);
        return;
      }
      throw e;
    }
    await recordLeaseEvent(
      run.cwd,
      "escalated",
      run.lease.issueId,
      {
        workflowRunId: run.workflowRunId,
        reason,
        actor: identitySnapshot(run.actor),
      },
      run.actor.bdActor,
    );
    // POST-COMMIT: the escalate() write resolved above.
    emitActivity({
      kind: "escalation",
      issueId: run.lease.issueId,
      phase: "escalated",
      workflowRunId: run.workflowRunId,
      actor: run.actor.bdActor,
      summary: reason,
    });
    // Release first (fenced — clears holder/expiry, briefly reopens), then
    // block: `bd ready` excludes blocked issues, and the open window is
    // invisible to approved-only claiming (the phase is already escalated).
    try {
      await releaseLease(run.cwd, run.lease, run.actor);
    } catch (e) {
      if (!(e instanceof FencingError)) throw e;
      dropJudgedRun(run); // reclaimed mid-escalation: no longer ours to block
      return;
    }
    await update(run.cwd, run.lease.issueId, { status: "blocked" }, run.actor.bdActor);
    dropJudgedRun(run);
  }

  /**
   * A reviewed workflow that cannot converge gets one structural escalation:
   * promote it to planned and return it ready. A planned workflow that still
   * cannot converge takes the ordinary blocked escalation path.
   */
  async function promoteReviewedToPlanned(
    run: CoordinatorRun,
    reason: string,
    fields: Record<string, string> = {},
  ): Promise<void> {
    const cur = await show(run.cwd, run.lease.issueId);
    const actual = phaseOf(cur);
    if (actual !== "judging") {
      throw new LifecycleError(
        run.lease.issueId,
        "judging",
        actual,
        "ready",
        "phase changed underneath workflow promotion",
      );
    }
    await setMetadata(
      run.cwd,
      run.lease.issueId,
      {
        ...fields,
        [WORKGRAPH_PHASE_KEY]: "ready",
        [WORKGRAPH_WORKFLOW_CLASS_KEY]: "planned",
        [WORKGRAPH_ATTEMPT_KEY]: "1",
        [WORKGRAPH_ACTIVE_EXECUTION_ID_KEY]: "",
        [WORKGRAPH_FAILURE_FINGERPRINT_KEY]: "",
      },
      run.actor.bdActor,
    );
    await recordLeaseEvent(
      run.cwd,
      "workflow-promoted",
      run.lease.issueId,
      {
        workflowRunId: run.workflowRunId,
        from: "reviewed",
        to: "planned",
        reason,
      },
      run.actor.bdActor,
    );
    emitActivity({
      kind: "transition",
      issueId: run.lease.issueId,
      phase: "ready",
      workflowRunId: run.workflowRunId,
      actor: run.actor.bdActor,
      summary: `${reason}; promoted reviewed → planned`,
    });
    try {
      await releaseLease(run.cwd, run.lease, run.actor);
    } catch (e) {
      if (!(e instanceof FencingError)) throw e;
    }
    dropJudgedRun(run);
  }

  /**
   * Request one revision run (role `revision`, priorFindings = the verdict
   * serialized one canonical-JSON finding per entry — the protocol field is
   * frozen as Array<string>) and await its fenced completion. Returns the
   * completion, `"parked"` (no capable executor / not accepted — the issue
   * stays in `revising` with the lease heartbeating), or `"aborted"`.
   */
  async function runRevision(
    run: CoordinatorRun,
    box: JudgmentInbox,
    verdict: VerdictT,
    attempt: number,
    acceptanceCriteria: string | undefined,
  ): Promise<RunCompletedT | "parked" | "aborted"> {
    const config = deps.getConfig();
    if (box.closed) return "aborted";

    const offers = await discoverExecutors(pi.events, {
      timeoutMs: config.discoveryTimeoutMs,
      now: nowFn,
      onInvalid,
    });
    let revisor;
    try {
      revisor = selectExecutor(
        offers,
        { role: "revision", requiresIsolation: false },
        { executorId: config.executorId },
        inFlightCounts(),
      );
    } catch (e) {
      if (!(e instanceof ExecutorSelectionError)) throw e;
      revisor = undefined;
    }
    if (!revisor) {
      logSkipOnce(
        `no revision-capable executor — ${run.lease.issueId} parked in revising`,
      );
      return "parked";
    }

    const request: RunRequestT = {
      ...newEnvelope(nowFn),
      executorId: revisor.executorId,
      issue: {
        id: run.issue.id,
        title: run.issue.title,
        workflowClass: effectiveWorkflowClass(run.issue),
        riskTier: effectiveRiskTier(run.issue),
        ...(run.issue.description !== undefined
          ? { description: run.issue.description }
          : {}),
        ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
      },
      workflowRunId: run.workflowRunId,
      leaseEpoch: run.lease.epoch,
      role: "revision",
      attempt,
      workspace: { baseRevision: "", requiresIsolation: false },
      priorFindings: canonicalFindings(verdict.findings).map((f) =>
        JSON.stringify(f),
      ),
      // A revision is still work against the plan: the revisor gets it for
      // the same reason the implementer did. Absent when no planner ran.
      ...(run.plan !== undefined ? { plan: run.plan } : {}),
    };
    await recordLeaseEvent(
      run.cwd,
      "revision-requested",
      run.lease.issueId,
      {
        workflowRunId: run.workflowRunId,
        executorId: revisor.executorId,
        attempt,
      },
      run.actor.bdActor,
    );
    const result = await requestRun(pi.events, request, {
      timeoutMs: config.acceptTimeoutMs,
      onInvalid,
    });
    if (result.kind !== "accepted") {
      logSkipOnce(
        `revision request not accepted (${result.kind}) — ${run.lease.issueId} parked in revising`,
      );
      return "parked";
    }

    // Bind the revision execution to the RUN in memory, not just the
    // metadata write below: graceful shutdown's cancel-first fork must
    // target the LIVE revision execution under the REVISOR's offer flags
    // (the implementing executor's isolation/cancellation flags do not
    // describe the revisor). Set BEFORE the transition await so a teardown
    // racing that write still sees the in-flight execution.
    run.executionId = result.message.executionId;
    run.isolation = revisor.isolation;
    run.supportsCancellation = revisor.supportsCancellation;
    run.revisionInFlight = true;

    // revising → revising: the new-execution-accepted self edge, binding
    // the active execution id in the same write.
    try {
      await transition(run.cwd, run.lease.issueId, "revising", "revising", {
        fields: {
          [WORKGRAPH_ACTIVE_EXECUTION_ID_KEY]: result.message.executionId,
        },
        actor: run.actor.bdActor,
      });
    } catch (e) {
      if (e instanceof LifecycleError) {
        logSkipOnce(e.message);
        await abandonJudgedRun(run);
        return "aborted";
      }
      throw e;
    }
    // POST-COMMIT: the revising→revising self edge resolved.
    emitActivity({
      kind: "transition",
      issueId: run.lease.issueId,
      phase: "revising",
      workflowRunId: run.workflowRunId,
      actor: run.actor.bdActor,
      summary: `revision execution accepted by ${revisor.executorId} (attempt ${attempt})`,
    });

    const completion = await awaitCompletion(box, result.message.executionId);
    // A teardown-closed inbox resolves null with the revision execution
    // STILL live at the revisor — `revisionInFlight` stays set so the
    // shutdown fork cancels/abandons it instead of releasing blind.
    if (!completion) return "aborted";
    run.revisionInFlight = false;
    if (!(await fencedForJudgment(run, completion))) {
      untrackLease(run.cwd, run.lease.issueId);
      dropJudgedRun(run);
      return "aborted";
    }
    await recordLeaseEvent(
      run.cwd,
      "run-completed",
      run.lease.issueId,
      {
        workflowRunId: run.workflowRunId,
        executionId: completion.executionId,
        executorId: revisor.executorId,
        role: "revision",
        outcome: completion.outcome,
        artifacts: completion.artifacts,
        evidence: completion.evidence,
        provenance: completion.provenance,
      },
      run.actor.bdActor,
    );
    // revising → judging: any outcome is judged — the reviewer sees
    // failures too; the gate, not the implementer, decides what they mean.
    try {
      await transition(run.cwd, run.lease.issueId, "revising", "judging", {
        fields: {
          [WORKGRAPH_AUTHOR_PROVENANCE_KEY]: JSON.stringify(
            completion.provenance,
          ),
        },
        actor: run.actor.bdActor,
      });
    } catch (e) {
      if (e instanceof LifecycleError) {
        logSkipOnce(e.message);
        await abandonJudgedRun(run);
        return "aborted";
      }
      throw e;
    }
    // POST-COMMIT: the revising→judging transition resolved.
    emitActivity({
      kind: "transition",
      issueId: run.lease.issueId,
      phase: "judging",
      workflowRunId: run.workflowRunId,
      actor: run.actor.bdActor,
      summary: `revision completed (${completion.outcome}) by ${revisor.executorId}`,
    });
    return completion;
  }

  /** Error-isolated wrapper: a judgment failure never unwinds the bus. */
  async function judge(
    run: CoordinatorRun,
    implementation: RunCompletedT,
  ): Promise<void> {
    try {
      await judgeInner(run, implementation);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logSkipOnce(`judgment failed for ${run.lease.issueId}: ${msg}`);
    }
  }

  async function judgeInner(
    run: CoordinatorRun,
    implementation: RunCompletedT,
  ): Promise<void> {
    const box = state.inboxes.get(run.workflowRunId);
    if (!box) return;

    // The implementation result currently under judgment; a completed
    // revision replaces it (fresh artifacts + provenance).
    let author = implementation;
    let reviewRetries = 0;
    // Executors whose reviews were rejected (non-independent) or who did
    // not accept — never re-selected for THIS run.
    const excluded = new Set<string>();

    for (;;) {
      if (box.closed) return; // teardown
      const config = deps.getConfig();
      const issue = await show(run.cwd, run.lease.issueId);
      const policy = resolvePolicy(riskTierOf(issue), config.policy);

      // ---- select an independent review executor ----
      const offers = await discoverExecutors(pi.events, {
        timeoutMs: config.discoveryTimeoutMs,
        now: nowFn,
        onInvalid,
      });
      let reviewer;
      try {
        reviewer = selectExecutor(
          offers.filter((o) => !excluded.has(o.executorId)),
          { role: "reviewer", requiresIsolation: false },
          { executorId: config.executorId },
          inFlightCounts(),
        );
      } catch (e) {
        if (!(e instanceof ExecutorSelectionError)) throw e;
        reviewer = undefined;
      }
      if (!reviewer) {
        if (excluded.size > 0) {
          // Reviews were rejected and nobody else offers: escalate rather
          // than accept non-independent judgment (decision log).
          await escalateRun(
            run,
            "judging",
            "no independent reviewer-capable executor remained",
          );
          return;
        }
        // The DEFAULT production path until phase 5: nothing offers the
        // reviewer role. Park in judging — the lease keeps heartbeating
        // (sweep-safe), teardown still releases it.
        logSkipOnce(
          `no reviewer-capable executor — ${run.lease.issueId} parked in judging`,
        );
        return;
      }

      // ---- request the review ----
      const attempt = attemptOf(issue) ?? 1;
      const reviewRequest: RunRequestT & { artifacts: string[] } = {
        ...newEnvelope(nowFn),
        executorId: reviewer.executorId,
        issue: {
          id: run.issue.id,
          title: run.issue.title,
          workflowClass: effectiveWorkflowClass(run.issue),
          riskTier: effectiveRiskTier(issue),
          ...(run.issue.description !== undefined
            ? { description: run.issue.description }
            : {}),
          ...(issue.acceptance_criteria !== undefined
            ? { acceptanceCriteria: issue.acceptance_criteria }
            : {}),
        },
        workflowRunId: run.workflowRunId,
        leaseEpoch: run.lease.epoch,
        role: "reviewer",
        attempt,
        workspace: { baseRevision: "", requiresIsolation: false },
        // The required structured-verdict output schema (a TypeBox schema
        // IS a JSON schema object).
        outputSchema: Verdict,
        // v1-tolerated extra field: the artifacts under review (non-strict
        // schemas carry fields this version's envelope does not name).
        artifacts: [...author.artifacts],
      };
      const result = await requestRun(pi.events, reviewRequest, {
        timeoutMs: config.acceptTimeoutMs,
        onInvalid,
      });
      if (result.kind !== "accepted") {
        excluded.add(reviewer.executorId);
        await recordLeaseEvent(
          run.cwd,
          result.kind === "rejected" ? "executor-rejected" : "accept-timeout",
          run.lease.issueId,
          {
            workflowRunId: run.workflowRunId,
            executorId: reviewer.executorId,
            role: "reviewer",
            ...(result.kind === "rejected"
              ? { reason: result.message.reason }
              : { timeoutMs: config.acceptTimeoutMs }),
          },
          run.actor.bdActor,
        );
        continue; // another executor may offer; else park/escalate above
      }

      const completion = await awaitCompletion(box, result.message.executionId);
      if (!completion) return; // teardown
      if (!(await fencedForJudgment(run, completion))) {
        // Our lease is gone — the whole run is stale; drop it.
        untrackLease(run.cwd, run.lease.issueId);
        dropJudgedRun(run);
        return;
      }

      // ---- validate the reported verdict ----
      let verdict: VerdictT;
      try {
        verdict = parseVerdict(
          (completion as RunCompletedT & { verdict?: unknown }).verdict,
        );
      } catch (e) {
        const detail = e instanceof VerdictError ? e.detail : String(e);
        reviewRetries += 1;
        await recordLeaseEvent(
          run.cwd,
          "verdict-invalid",
          run.lease.issueId,
          {
            workflowRunId: run.workflowRunId,
            executionId: completion.executionId,
            executorId: reviewer.executorId,
            detail,
            retry: reviewRetries,
          },
          run.actor.bdActor,
        );
        if (reviewRetries > MAX_REVIEW_RETRIES) {
          await escalateRun(
            run,
            "judging",
            `review retries exhausted (${MAX_REVIEW_RETRIES}) without a parseable verdict`,
          );
          return;
        }
        continue; // bounded review retry — never counts against maxRevisions
      }

      // ---- author independence (fail closed) ----
      const independence = checkIndependence(
        {
          author: author.provenance,
          reviewer: completion.provenance,
          authorExecutionId: author.executionId,
          reviewerExecutionId: completion.executionId,
        },
        policy,
      );
      if (!independence.independent) {
        excluded.add(reviewer.executorId);
        await recordLeaseEvent(
          run.cwd,
          "review-rejected",
          run.lease.issueId,
          {
            workflowRunId: run.workflowRunId,
            executionId: completion.executionId,
            executorId: reviewer.executorId,
            reason: independence.reason,
          },
          run.actor.bdActor,
        );
        continue; // request again from a different executor, else escalate
      }

      // ---- persist the verdict (ALWAYS — advisory findings included) ----
      await recordVerdict(
        run.cwd,
        run.lease.issueId,
        verdict,
        {
          workflowRunId: run.workflowRunId,
          executionId: completion.executionId,
          executorId: reviewer.executorId,
          attempt,
          reviewerProvenance: completion.provenance,
        },
        run.actor.bdActor,
      );
      const summary = verdictSummary(verdict);

      // ---- apply the gate ----
      const blocking = blockingFindings(verdict);
      if (blocking.length > 0 && policy.gateMode === "blocking") {
        const digest = artifactDigest(author.artifacts);
        const fingerprint = failureFingerprint(blocking, digest);
        if (failureFingerprintOf(issue) === fingerprint) {
          if (effectiveWorkflowClass(issue) === "reviewed") {
            await promoteReviewedToPlanned(
              run,
              "repeated blocking-finding fingerprint on an unchanged artifact digest",
              { [WORKGRAPH_LAST_VERDICT_KEY]: summary },
            );
            return;
          }
          await escalateRun(
            run,
            "judging",
            "repeated blocking-finding fingerprint on an unchanged artifact digest",
            { [WORKGRAPH_LAST_VERDICT_KEY]: summary },
          );
          return;
        }
        if (attempt - 1 >= policy.maxRevisions) {
          if (effectiveWorkflowClass(issue) === "reviewed") {
            await promoteReviewedToPlanned(
              run,
              `maxRevisions (${policy.maxRevisions}) exhausted`,
              { [WORKGRAPH_LAST_VERDICT_KEY]: summary },
            );
            return;
          }
          await escalateRun(
            run,
            "judging",
            `maxRevisions (${policy.maxRevisions}) exhausted`,
            {
              [WORKGRAPH_LAST_VERDICT_KEY]: summary,
              [WORKGRAPH_FAILURE_FINGERPRINT_KEY]: fingerprint,
            },
          );
          return;
        }
        try {
          await transition(run.cwd, run.lease.issueId, "judging", "revising", {
            fields: {
              [WORKGRAPH_ATTEMPT_KEY]: String(attempt + 1),
              [WORKGRAPH_FAILURE_FINGERPRINT_KEY]: fingerprint,
              [WORKGRAPH_LAST_VERDICT_KEY]: summary,
            },
            actor: run.actor.bdActor,
          });
        } catch (e) {
          if (e instanceof LifecycleError) {
            logSkipOnce(e.message);
            await abandonJudgedRun(run);
            return;
          }
          throw e;
        }
        // POST-COMMIT: the verdict-driven judging→revising resolved.
        emitActivity({
          kind: "verdict",
          issueId: run.lease.issueId,
          phase: "revising",
          workflowRunId: run.workflowRunId,
          actor: run.actor.bdActor,
          summary,
        });
        run.phase = "revising";
        run.attempt = attempt + 1;
        const revision = await runRevision(
          run,
          box,
          verdict,
          attempt + 1,
          issue.acceptance_criteria,
        );
        if (revision === "aborted" || revision === "parked") return;
        author = revision;
        run.phase = "judging";
        continue; // re-review the revised implementation
      }

      // ---- gate passed (clean, advisory findings, or advisory mode) ----
      try {
        await transition(run.cwd, run.lease.issueId, "judging", "verifying", {
          fields: { [WORKGRAPH_LAST_VERDICT_KEY]: summary },
          actor: run.actor.bdActor,
        });
        run.phase = "verifying";
        // POST-COMMIT: emitted between the two writes — if the SECOND
        // transition fails, the verifying activity still described a
        // committed write (activity count == committed transitions).
        emitActivity({
          kind: "verdict",
          issueId: run.lease.issueId,
          phase: "verifying",
          workflowRunId: run.workflowRunId,
          actor: run.actor.bdActor,
          summary,
        });
        // Verification runs the policy's required verifier commands; the
        // trimmed knob set names none (a knob with one exercised value is
        // a constant — decision log), so verification is a pass-through.
        await transition(run.cwd, run.lease.issueId, "verifying", "accepted", {
          actor: run.actor.bdActor,
        });
        emitActivity({
          kind: "transition",
          issueId: run.lease.issueId,
          phase: "accepted",
          workflowRunId: run.workflowRunId,
          actor: run.actor.bdActor,
          summary: "verification passed",
        });
      } catch (e) {
        if (e instanceof LifecycleError) {
          logSkipOnce(e.message);
          await abandonJudgedRun(run);
          return;
        }
        throw e;
      }
      // The policy-approved close: the ONLY happy-path exit to closed.
      await close(
        run.cwd,
        run.lease.issueId,
        "accepted by the judgment gate",
        run.actor.bdActor,
      );
      untrackLease(run.cwd, run.lease.issueId);
      // POST-COMMIT: the bd close resolved above.
      emitActivity({
        kind: "close",
        issueId: run.lease.issueId,
        phase: "accepted",
        workflowRunId: run.workflowRunId,
        actor: run.actor.bdActor,
        summary: `closed: ${summary}`,
      });
      await recordLeaseEvent(
        run.cwd,
        "judgment-closed",
        run.lease.issueId,
        {
          workflowRunId: run.workflowRunId,
          executionId: completion.executionId,
          verdictSummary: summary,
          actor: identitySnapshot(run.actor),
        },
        run.actor.bdActor,
      );
      dropJudgedRun(run);
      return;
    }
  }

  // Registered once, up front — returning the promise lets test buses await
  // handler settlement; the real bus ignores the return value.
  pi.events.on(CH.runCompleted, (data) => onCompleted(data));

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  async function tick(ctx: ExtensionContext): Promise<void> {
    if (state.ticking) return; // reentrant tick — checked/set before any await
    if (state.reconciling) return; // recovery first — ticks resume after
    state.ticking = true;
    try {
      await tickInner(ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logSkipOnce(msg);
    } finally {
      state.ticking = false;
    }
  }

  async function tickInner(ctx: ExtensionContext): Promise<void> {
    const config = deps.getConfig();

    // A run in flight (requested/accepted): capacity is 1 — supervise only.
    // Judged runs don't consume capacity; their leases are heartbeated until
    // shutdown.
    if (state.active) {
      const held = getHeldLease(ctx.cwd, state.active.lease.issueId);
      if (held) showLeaseStatus(ctx, held, nowFn, statusDetail(state.active));
      return;
    }

    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    if (!bdBinaryAvailable()) {
      logSkipOnce("bd CLI not found");
      return;
    }
    try {
      await ensureWorkspace(ctx.cwd);
    } catch {
      // No .beads/ here — the coordinator stays inert.
      return;
    }

    // ARRAY LENGTH is the readiness signal, never exit codes. Fetch
    // UNBOUNDED (`-n 0`, the workgraph_ready pattern) and filter
    // client-side: lifecycle phase is metadata, which bd's ready query
    // cannot see — a capped probe would let a page of legacy issues ahead
    // in bd's ordering starve newly approved work indefinitely (the
    // all-legacy rollout scenario).
    const pool = await ready(ctx.cwd, 0);
    if (pool.length === 0) {
      clearSkipLog();
      return;
    }

    // APPROVED WORK ONLY: lifecycle-v1 issues must be in phase "ready"
    // (workgraph_approve); legacy issues (no lifecycle version) dispatch
    // only under the explicit compat opt-in (README "Legacy compatibility")
    // — and even under compat, a legacy issue carrying a live lease is
    // respected, never claimed.
    const compat = config.compatLegacyIssues ?? false;
    const eligible = pool.filter((issue) => {
      if (isLifecycleV1(issue)) return phaseOf(issue) === "ready";
      return compat && !legacyLiveLease(issue);
    });
    // Compat dispatch is about to include legacy work: say so ONCE per
    // session, naming the setting and its effect (phase 6 —
    // "warning names the setting each session" is the failure-modes
    // mitigation for users left on compat forever).
    if (compat && eligible.some((issue) => !isLifecycleV1(issue))) {
      warnOnce(
        "[pi-workgraph] workgraph-compat-legacy-issues is enabled: legacy issues " +
          "(no workgraph_lifecycle_version) are auto-dispatched, and each claim " +
          "initializes lifecycle metadata and enters phase " +
          '"implementing". Prefer approving work ' +
          "explicitly with workgraph_approve.",
      );
    }
    if (eligible.length === 0) {
      logSkipOnce(
        "ready pool has no dispatchable issues — approve drafts with workgraph_approve; legacy auto-dispatch requires workgraph-compat-legacy-issues",
      );
      return;
    }

    // NO EXECUTOR → NO CLAIM: discovery precedes any claim attempt. Zero
    // offers leave the ready pool untouched (the phase-0 pin flips here).
    const offers = await discoverExecutors(pi.events, {
      timeoutMs: config.discoveryTimeoutMs,
      now: nowFn,
      onInvalid,
    });
    if (offers.length === 0) {
      logSkipOnce("no executor offered — leaving the ready pool untouched");
      return;
    }

    // ROLE SELECTION. Workflow depth is now per issue: only `planned` work
    // enters planning, and it never silently degrades when a planner is
    // unavailable. Reviewed and one-shot work go straight to implementation
    // even while planner-capable executors are online.
    //
    // Both selections run against the SAME discovery round: re-discovering
    // per role would let the offer set change between the two calls and
    // could claim into `planning` on the strength of a planner that is gone
    // by the time we dispatch.
    //
    // LEGACY issues never plan: their compatibility entry is
    // `implementing` (lifecycle.ts LEGACY_ENTRY), so offering them the
    // planner tier would claim a lease and then throw on the transition.
    // Compat mode stays byte-for-byte what it was.
    const candidate = eligible[0]!;
    const workflowClass = effectiveWorkflowClass(candidate);
    let role: "planner" | "implementer" =
      isLifecycleV1(candidate) && workflowClass === "planned"
        ? "planner"
        : "implementer";
    let selected;
    try {
      if (role === "planner") {
        // NEVER PLAN WHAT CANNOT BE BUILT. Planning is only worth a lease if
        // an implementer exists to consume the plan: without this check a
        // planner-only offer set would plan, find nobody to implement, hand
        // the issue back to the pool, and re-plan on the next tick — a
        // token-burning loop with no forward progress.
        const canImplement =
          offers.some((o) => o.roles.includes("implementer")) ||
          config.executorId !== undefined;
        selected = canImplement
          ? selectExecutor(
              offers,
              // No isolation policy exists yet (phase 5+): neither planning
              // nor implementation runs require isolation, which is what
              // lets the in-session compat adapter (isolation "none") stay
              // eligible.
              { role: "planner", requiresIsolation: false },
              { executorId: config.executorId },
              inFlightCounts(),
            )
          : undefined;
        // A pin overrides registry filters, so re-check the required role.
        if (selected && !selected.roles.includes("planner")) selected = undefined;
        if (!selected) {
          logSkipOnce("planned work requires an eligible planner — no claim");
          return;
        }
      }
      if (role === "implementer") {
        selected = selectExecutor(
          offers,
          { role: "implementer", requiresIsolation: false },
          { executorId: config.executorId },
          inFlightCounts(),
        );
        if (selected && !selected.roles.includes("implementer")) {
          selected = undefined;
        }
      }
    } catch (e) {
      if (e instanceof ExecutorSelectionError) {
        // Configured-but-absent: error, NO CLAIM — never fall through.
        logSkipOnce(e.message);
        return;
      }
      throw e;
    }
    if (!selected) {
      logSkipOnce(`no eligible executor for role ${role} — no claim`);
      return;
    }
    // The phase the claim enters, and the phase every downstream write in
    // this tick expects. Kept in one binding so the claim transition, the
    // activity event, and the request role can never disagree.
    const claimPhase = role === "planner" ? "planning" : "implementing";

    // A FRESH workflow-run holder per claim attempt: reusing one across
    // attempts would read as a same-holder renewal (no epoch bump) and
    // silently skip re-fencing.
    const workflowRunId = ids.newWorkflowRun().id;
    const actor: LeaseActor = { holder: workflowRunId, bdActor: ids.initiator().id };

    // Claim BY ID (bd's equally-atomic `update --claim`): `ready --claim`
    // is metadata-blind and cannot honor the approved-only filter. A
    // conflicting claim exits 1 — a lost race, not an error. (`candidate`
    // was bound above — role selection needs it to keep legacy issues out
    // of the planner tier.)
    let outcome: AcquireOutcome;
    try {
      outcome = await acquireLease(ctx.cwd, {
        issueId: candidate.id,
        ttlMs: config.leaseTtlMs,
        now: nowFn,
        actor,
      });
    } catch (e) {
      if (e instanceof BdError) {
        // bd's claim conflict surfaces its stderr verbatim ("already
        // claimed by ..."): a lost race, retried next tick. Any OTHER
        // BdError (broken binary, workspace corruption) must not be
        // silently swallowed on every tick — log it once.
        if (!/already claimed/i.test(e.message)) {
          logSkipOnce(`claim failed for ${candidate.id}: ${e.message}`);
        }
        return;
      }
      throw e;
    }
    if (outcome.kind !== "acquired") return;

    const run: CoordinatorRun = {
      cwd: ctx.cwd,
      issue: outcome.issue,
      lease: outcome.lease,
      actor,
      workflowRunId,
      executorId: selected.executorId,
      phase: "requested",
      role,
      attempt: 1,
      isolation: selected.isolation,
      supportsCancellation: selected.supportsCancellation,
    };
    state.active = run;
    startHeartbeat(ctx, config.heartbeatMs);
    showLeaseStatus(ctx, outcome.lease, nowFn, statusDetail(run));

    // Persist intent BEFORE the request is emitted: a crash in the window
    // between claim and accept is reconcilable from metadata (phase 4) and
    // never orphans silently. The write goes through the guarded lifecycle
    // transition (ready → planning when a planner was selected, else ready →
    // implementing; a compat claim of a legacy issue is its initialization
    // entry, always → implementing, and stamps lifecycle v1) — phase, run id,
    // executor id, and attempt land in ONE setMetadata call.
    try {
      await transition(
        ctx.cwd,
        run.issue.id,
        isLifecycleV1(outcome.issue) ? "ready" : undefined,
        claimPhase,
        {
          fields: {
            [WORKGRAPH_WORKFLOW_RUN_ID_KEY]: workflowRunId,
            [WORKGRAPH_EXECUTOR_ID_KEY]: selected.executorId,
            [WORKGRAPH_ATTEMPT_KEY]: "1",
          },
          actor: actor.bdActor,
        },
      );
    } catch (e) {
      if (!(e instanceof LifecycleError)) throw e;
      // A concurrent writer moved the phase between the probe and our
      // claim: hand the claim back and let the next tick re-evaluate.
      logSkipOnce(e.message);
      state.active = null;
      if (heldRuns().length === 0) stopHeartbeat();
      clearLeaseStatus(ctx);
      try {
        await releaseLease(ctx.cwd, run.lease, actor);
      } catch (releaseError) {
        if (!(releaseError instanceof FencingError)) throw releaseError;
      }
      return;
    }
    // POST-COMMIT: the ready→planning/implementing claim transition resolved.
    emitActivity({
      kind: "claim",
      issueId: run.issue.id,
      phase: claimPhase,
      workflowRunId,
      actor: actor.bdActor,
      summary: `claimed for ${selected.executorId} (${role})`,
    });

    const request: RunRequestT = {
      ...newEnvelope(nowFn),
      executorId: selected.executorId,
      issue: {
        id: run.issue.id,
        title: run.issue.title,
        workflowClass: effectiveWorkflowClass(run.issue),
        riskTier: effectiveRiskTier(outcome.issue),
        ...(run.issue.description !== undefined
          ? { description: run.issue.description }
          : {}),
        ...(outcome.issue.acceptance_criteria !== undefined
          ? { acceptanceCriteria: outcome.issue.acceptance_criteria }
          : {}),
      },
      workflowRunId,
      leaseEpoch: run.lease.epoch,
      role,
      attempt: 1,
      workspace: { baseRevision: "", requiresIsolation: false },
      ...(role === "planner" ? { outputSchema: Plan } : {}),
    };

    // Bounded accept window; the correlated subscription is registered
    // inside requestRun BEFORE the emit.
    const result = await requestRun(pi.events, request, {
      timeoutMs: config.acceptTimeoutMs,
      onInvalid,
    });

    // A fast executor may have completed (and moved the run into judgment)
    // while we awaited — never downgrade a terminal state.
    if (result.kind === "accepted") {
      if (state.active === run && run.phase === "requested") {
        run.phase = "accepted";
        run.executionId = result.message.executionId;
        // Bind the executor-side run id durably (README lifecycle table).
        await setMetadata(
          ctx.cwd,
          run.issue.id,
          { [WORKGRAPH_ACTIVE_EXECUTION_ID_KEY]: result.message.executionId },
          actor.bdActor,
        );
      }
      clearSkipLog();
      return;
    }
    if (state.active !== run || run.phase !== "requested") return;

    // Reject/timeout → release promptly (audited with the reason); the
    // issue returns to the ready pool for whatever executor shows up next.
    state.active = null;
    if (heldRuns().length === 0) stopHeartbeat();
    clearLeaseStatus(ctx);
    await recordLeaseEvent(
      ctx.cwd,
      result.kind === "rejected" ? "executor-rejected" : "accept-timeout",
      run.issue.id,
      {
        workflowRunId,
        executorId: selected.executorId,
        ...(result.kind === "rejected"
          ? { reason: result.message.reason }
          : { timeoutMs: config.acceptTimeoutMs }),
      },
      actor.bdActor,
    );
    // Back to the pool. A deliberate RAW write, not a LEGAL edge:
    // implementing → ready is the never-started recovery path, owned by the
    // coordinator with its own audit (like lease loss and human override).
    await setMetadata(
      ctx.cwd,
      run.issue.id,
      { [WORKGRAPH_PHASE_KEY]: "ready" },
      actor.bdActor,
    );
    try {
      await releaseLease(ctx.cwd, run.lease, actor);
    } catch (e) {
      // FencingError: reclaimed in the window — it is no longer ours to
      // release (releaseLease already untracked). Anything else: log once.
      if (!(e instanceof FencingError)) {
        const msg = e instanceof Error ? e.message : String(e);
        logSkipOnce(`could not release ${run.issue.id}: ${msg}`);
      }
    }
  }

  /** One heartbeat: renew EVERY held run's lease as its run-scoped actor. */
  async function beat(ctx: ExtensionContext): Promise<void> {
    const runs = heldRuns();
    if (runs.length === 0) {
      stopHeartbeat();
      return;
    }
    const config = deps.getConfig();
    for (const run of runs) {
      const held = getHeldLease(run.cwd, run.lease.issueId);
      if (!held) continue; // released/lost between beats
      try {
        const renewed = await renewLease(run.cwd, run.lease, {
          ttlMs: config.leaseTtlMs,
          now: nowFn,
          // Renew as the run actor stored at acquire time — never ambient.
          actor: run.actor,
        });
        run.lease = renewed;
        if (state.active === run) {
          showLeaseStatus(ctx, renewed, nowFn, statusDetail(run));
        }
      } catch (e) {
        if (e instanceof FencingError) {
          // Reclaimed out from under this run (renewLease already
          // untracked): drop it, cancel the now-stale execution (phase 4 —
          // the executor may still be running under the lost lease), audit.
          publishCancel(run, "lease lost (fencing)");
          if (state.active === run) {
            state.active = null;
            clearLeaseStatus(ctx);
          } else {
            state.judged = state.judged.filter((r) => r !== run);
            closeInbox(run.workflowRunId); // abort any in-flight judgment
          }
          await recordLeaseEvent(
            run.cwd,
            "fencing-loss",
            e.issueId,
            {
              holder: e.currentHolder,
              heldEpoch: e.heldEpoch,
              currentEpoch: e.currentEpoch,
              via: "coordinator-heartbeat",
              workflowRunId: run.workflowRunId,
            },
            run.actor.bdActor,
          );
          continue;
        }
        const msg = e instanceof Error ? e.message : String(e);
        logSkipOnce(`heartbeat failed (will retry): ${msg}`);
      }
    }
    if (heldRuns().length === 0) stopHeartbeat();
  }

  /**
   * Idempotent GRACEFUL shutdown (plan §6): stop both timers, abort every
   * in-flight judgment loop (inboxes close, so awaiting loops resolve null
   * and exit), then per run:
   *
   *  - no in-flight execution (parked in judgment, never-accepted) or an
   *    in-session run (isolation "none" — its execution cannot outlive the
   *    session): voluntary release, exactly as before;
   *  - an isolated background execution that supports cancellation — the
   *    active implementation run, or a supervised run whose REVISION
   *    execution is in flight (`revisionInFlight`):
   *    `run:cancel` → bounded `run:cancelled` wait → acked releases,
   *    unacked ABANDONS (heartbeat already stopped, lease left INTACT for
   *    the TTL sweep — an immediate release would invite a concurrent
   *    publisher while the stale executor still mutates; fencing rejects
   *    the stale publish either way, this trades reclaim latency for
   *    isolation), audited `abandoned-unacked-cancel`;
   *  - an isolated execution WITHOUT cancellation support: nothing to send —
   *    abandon straight to the TTL sweep, same audit.
   *
   * Each release is fenced as the RUN actor stored at acquire time, never
   * ambient identity.
   */
  async function teardown(ctx?: ExtensionContext): Promise<void> {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    stopHeartbeat();
    for (const workflowRunId of [...state.inboxes.keys()]) {
      closeInbox(workflowRunId);
    }
    const config = deps.getConfig();
    const active = state.active;
    const runs = heldRuns();
    state.active = null;
    state.judged = [];
    if (ctx) clearLeaseStatus(ctx);
    for (const run of runs) {
      const held = getHeldLease(run.cwd, run.lease.issueId);
      if (!held) continue;
      // Cancel-first is scoped to runs with an IN-FLIGHT execution on an
      // ISOLATED executor: the active implementation run (accepted,
      // uncompleted) and a supervised run whose REVISION execution is live
      // (bound at its run:accepted — the executor may still be mutating,
      // so a blind release would invite a concurrent publisher). Parked
      // judgment runs have no live sub-execution to cancel; in-session
      // executions die with this session by definition.
      const inFlight =
        run.executionId !== undefined &&
        run.isolation !== "none" &&
        ((run === active && run.phase === "accepted") ||
          (run.phase === "revising" && run.revisionInFlight === true));
      if (inFlight) {
        const acked = run.supportsCancellation
          ? await cancelAndAwaitAck(run, config.acceptTimeoutMs)
          : false;
        if (!acked) {
          // Abandon ≠ release: stop tracking (no further renewals) but
          // leave holder/epoch/expiry INTACT so the TTL sweep reclaims
          // under a new epoch. Never release under a possibly-live mutator.
          untrackLease(run.cwd, run.lease.issueId);
          await recordLeaseEvent(
            run.cwd,
            "abandoned-unacked-cancel",
            run.lease.issueId,
            {
              workflowRunId: run.workflowRunId,
              executionId: run.executionId,
              executorId: run.executorId,
              reason: run.supportsCancellation
                ? `no run:cancelled inside ${config.acceptTimeoutMs} ms`
                : "executor does not support cancellation",
            },
            run.actor.bdActor,
          );
          continue;
        }
      }
      try {
        await releaseLease(run.cwd, run.lease, run.actor);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[pi-workgraph] coordinator teardown could not release ${run.lease.issueId}: ${msg}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Startup reconciliation (phase 4) — plan §10. The pure/protocol pieces
  // (enumeration, partition, the correlated status exchange, author
  // reconstruction) live in recovery.ts; the ADOPTION composes them with
  // this coordinator's state. Every step is fenced + idempotent, so a
  // reconciliation that crashes midway is safe to re-run.
  // -------------------------------------------------------------------------

  async function reconcile(ctx: ExtensionContext): Promise<ReconcileReport> {
    const report = emptyReport();
    if (state.reconciling) return report; // one reconciliation at a time
    state.reconciling = true; // synchronous — gates ticks before any await
    const resumed: Promise<void>[] = [];
    try {
      if (!bdBinaryAvailable()) return report;
      try {
        await ensureWorkspace(ctx.cwd);
      } catch {
        return report; // no .beads/ here — nothing persisted to recover
      }
      const config = deps.getConfig();
      const nowMs = nowFn();
      const issues = await listRunHeldInProgress(ctx.cwd, nowMs, config.leaseTtlMs);
      const { expired, live } = partitionByExpiry(issues, nowMs);

      // Already-expired leases: reclaim under a NEW epoch before any
      // redispatch, publishing best-effort run:cancel for the old
      // execution — the sweep's composition, invoked eagerly so the pool
      // reopens now instead of a sweep interval later. Fingerprint history
      // survives by construction (the reset touches phase + execution id
      // only).
      for (const issue of expired) {
        try {
          const won = await reclaimAndLeaveReady(
            ctx.cwd,
            issue,
            { ttlMs: config.leaseTtlMs, now: nowFn, actor: ids.initiator().id },
            pi.events,
          );
          if (won) report.reclaimed.push(issue.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logSkipOnce(`recovery could not reclaim ${issue.id}: ${msg}`);
        }
      }

      // One discovery round enriches re-adopted runs with the recorded
      // executor's CURRENT offer (isolation + cancellation support feed the
      // graceful-shutdown fork); absent executors default conservatively
      // (isolated, no cancellation → abandon-to-TTL at shutdown).
      const offers =
        live.length > 0
          ? await discoverExecutors(pi.events, {
              timeoutMs: config.discoveryTimeoutMs,
              now: nowFn,
              onInvalid,
            })
          : [];
      const offersById = new Map(offers.map((o) => [o.executorId, o]));

      for (const issue of live) {
        if (getHeldLease(ctx.cwd, issue.id)) continue; // already supervised
        const workflowRunId = workflowRunIdOf(issue);
        if (workflowRunId === undefined) continue; // isRunHeld guarantees it
        const expiresAt = leaseExpiresAtOf(issue);
        if (expiresAt === undefined) {
          // Anomalous for a run holder (acquire/renew/reclaim always stamp
          // an expiry) — and the sweep NEVER auto-reclaims a no-expiry
          // claim (findExpired flags it and moves on), so a silent skip
          // here would strand the issue in_progress indefinitely. Abandon
          // EXPLICITLY — reported + audited — so an operator sees the
          // stuck claim instead of a silent skip.
          report.abandoned.push(issue.id);
          await recordLeaseEvent(
            ctx.cwd,
            "recovery-abandoned",
            issue.id,
            {
              workflowRunId,
              reason:
                "run-held lease has no lease_expires_at; the sweep never auto-reclaims a no-expiry claim — operator attention required",
            },
            ids.initiator().id,
          );
          continue;
        }
        const lease: Lease = {
          issueId: issue.id,
          epoch: leaseEpochOf(issue),
          expiresAt,
        };
        const actor: LeaseActor = {
          // The RUN identity is the holder — portable across restarts by
          // design; the initiator attribution is this session's.
          holder: workflowRunId,
          bdActor: ids.initiator().id,
        };

        // Fencing before adoption: the holder+epoch must still be current
        // AND the persisted run id unmoved (the onCompleted double-check) —
        // a hijacked run (another coordinator reclaimed while we were
        // down) is dropped silently, never double-supervised.
        let cur: BeadsIssue;
        try {
          if (!(await verifyHolding(ctx.cwd, lease, workflowRunId))) {
            report.abandoned.push(issue.id);
            continue;
          }
          cur = await show(ctx.cwd, issue.id);
          if (workflowRunIdOf(cur) !== workflowRunId) {
            report.abandoned.push(issue.id);
            continue;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logSkipOnce(`recovery could not verify ${issue.id}: ${msg}`);
          continue;
        }

        const phase = phaseOf(cur);
        const executorId = executorIdOf(cur);
        const executionId = activeExecutionIdOf(cur);
        const offer = executorId !== undefined ? offersById.get(executorId) : undefined;
        const makeRun = (
          runPhase: CoordinatorRun["phase"],
          runRole: CoordinatorRun["role"] = "implementer",
        ): CoordinatorRun => ({
          cwd: ctx.cwd,
          issue: cur,
          lease,
          actor,
          workflowRunId,
          executorId: executorId ?? "unknown",
          ...(executionId !== undefined ? { executionId } : {}),
          phase: runPhase,
          role: runRole,
          attempt: attemptOf(cur) ?? 1,
          isolation: offer?.isolation ?? "worktree",
          supportsCancellation: offer?.supportsCancellation ?? false,
        });

        if (phase === "planning") {
          // A planner run interrupted by downtime. Unlike `implementing`
          // there is no partial work to protect — nothing has been written
          // to the tree — so recovery does NOT try to re-adopt a live
          // planner or reconstruct its completion: it abandons, and the TTL
          // sweep resets `planning` → `ready` (isActivePhase) for a clean
          // re-plan. Re-planning is cheap and idempotent; re-adopting would
          // add a status/reconstruct path whose only saving is one planner
          // run.
          report.abandoned.push(issue.id);
          await recordLeaseEvent(
            ctx.cwd,
            "recovery-abandoned",
            issue.id,
            {
              workflowRunId,
              ...(executorId !== undefined ? { executorId } : {}),
              ...(executionId !== undefined ? { executionId } : {}),
              phase: "planning",
              reason: "planning run interrupted; re-plans after the sweep",
            },
            actor.bdActor,
          );
          continue;
        }

        if (phase === "implementing") {
          if (executorId === undefined || executionId === undefined) {
            // Crash between claim and accept: intent persisted, no status
            // target — abandon immediately, the sweep reclaims at TTL.
            report.abandoned.push(issue.id);
            await recordLeaseEvent(
              ctx.cwd,
              "recovery-abandoned",
              issue.id,
              {
                workflowRunId,
                reason: "no recorded execution (crash between claim and accept)",
              },
              actor.bdActor,
            );
            continue;
          }
          const status = await requestStatus(
            pi.events,
            { executorId, executionId, workflowRunId, issueId: issue.id },
            { timeoutMs: config.acceptTimeoutMs, now: nowFn, onInvalid },
          );
          if (status?.status === "active" && state.active === null) {
            // Re-adopt: heartbeat resumes ONLY on a positive `active` —
            // a timeout is not evidence of life.
            const run = makeRun("accepted");
            trackLease(ctx.cwd, lease, actor);
            state.active = run;
            startHeartbeat(ctx, config.heartbeatMs);
            report.readopted.push(issue.id);
            await recordLeaseEvent(
              ctx.cwd,
              "re-adopted",
              issue.id,
              { workflowRunId, executorId, executionId, phase: "implementing" },
              actor.bdActor,
            );
          } else if (status?.status === "terminal" && status.completion) {
            // Terminal-during-downtime: adopt, then feed the embedded
            // completion through the NORMAL fenced handler — one code
            // path, no recovery special-casing. The handler owns all
            // further state (judging transition, judgment gate, drops).
            const run = makeRun("accepted");
            trackLease(ctx.cwd, lease, actor);
            state.active = run;
            startHeartbeat(ctx, config.heartbeatMs);
            report.completed.push(issue.id);
            await onCompleted(status.completion);
          } else {
            // missing | unreachable | terminal-without-result | timeout |
            // active-but-capacity-taken: abandon — never renew on silence;
            // the TTL sweep reclaims and redispatches under a new epoch.
            report.abandoned.push(issue.id);
            await recordLeaseEvent(
              ctx.cwd,
              "recovery-abandoned",
              issue.id,
              {
                workflowRunId,
                executorId,
                executionId,
                reason:
                  status === undefined
                    ? "status request timed out"
                    : status.status === "terminal"
                      ? "terminal status carried no result"
                      : status.status,
              },
              actor.bdActor,
            );
          }
        } else if (phase === "judging") {
          // One run holds through judgment (decision log), so judging runs
          // must reconnect too. The author completion is rebuilt from the
          // durable trail (run-completed audit + provenance metadata); with
          // it the reviewer flow RESUMES — without it the run parks
          // (heartbeat only) rather than judging blind.
          const author = await reconstructAuthorCompletion(
            ctx.cwd,
            cur,
            lease,
            nowFn,
          );
          const run = makeRun("judging");
          trackLease(ctx.cwd, lease, actor);
          state.judged.push(run);
          state.inboxes.set(workflowRunId, {
            messages: [],
            waiters: [],
            closed: false,
          });
          startHeartbeat(ctx, config.heartbeatMs);
          report.readopted.push(issue.id);
          await recordLeaseEvent(
            ctx.cwd,
            "re-adopted",
            issue.id,
            {
              workflowRunId,
              executorId,
              phase: "judging",
              resumed: author !== undefined,
            },
            actor.bdActor,
          );
          if (author) resumed.push(judge(run, author));
        } else if (phase === "revising" || phase === "verifying") {
          // Mid-gate states whose in-flight context (a revision execution,
          // a verification pass) cannot be rebuilt from memory: park with
          // the heartbeat so the lease survives; the gate resolves via
          // human override / re-approve or a later phase's reconnection.
          const run = makeRun(phase);
          // A revising run's recorded execution IS a revision execution
          // bound at its accept (the revising→revising self edge) and never
          // completed (completion would have transitioned to judging) — it
          // may still be mutating, so graceful shutdown must cancel/abandon
          // it, never release blind. Verifying runs carry no live
          // execution: their recorded id already completed to reach
          // judging. Offer flags default conservatively above (isolated,
          // no cancellation → abandon-to-TTL) when the executor is absent.
          if (phase === "revising" && run.executionId !== undefined) {
            run.revisionInFlight = true;
          }
          trackLease(ctx.cwd, lease, actor);
          state.judged.push(run);
          state.inboxes.set(workflowRunId, {
            messages: [],
            waiters: [],
            closed: false,
          });
          startHeartbeat(ctx, config.heartbeatMs);
          report.readopted.push(issue.id);
          await recordLeaseEvent(
            ctx.cwd,
            "re-adopted",
            issue.id,
            { workflowRunId, executorId, phase, resumed: false },
            actor.bdActor,
          );
        } else {
          // No lifecycle phase (or a terminal one) under a run-held lease:
          // inconsistent remnant — leave it for the sweep.
          report.abandoned.push(issue.id);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logSkipOnce(`reconciliation failed (safe to re-run): ${msg}`);
    } finally {
      state.reconciling = false;
    }
    // Resumed judgment chains run OUTSIDE the latch (they can take whole
    // discovery/review rounds); awaiting them here lets callers span the
    // full convergence. judge() is error-isolated — nothing unwinds.
    await Promise.all(resumed);
    return report;
  }

  pi.on("session_start", (_event, ctx) => {
    if (!enabled()) return;
    if (state.timer) clearInterval(state.timer); // idempotent restart
    const config = deps.getConfig();
    state.timer = setInterval(() => void tick(ctx), config.pollMs);
    // Reconciliation BEFORE the first coordination pass: the `reconciling`
    // latch is set synchronously inside reconcile(), so a settle-tick (or
    // the poll timer) arriving mid-recovery no-ops until adoption is done.
    // Cost for the common (empty) case: one bd list. The report is for
    // reconcile()'s direct callers; the event contract wants void.
    return reconcile(ctx).then(() => undefined);
  });

  // The idle edge — poll immediately instead of waiting out the interval.
  pi.on("agent_settled", (_event, ctx) => {
    if (!enabled()) return;
    return tick(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => teardown(ctx));

  return {
    tick,
    beat,
    reconcile,
    teardown,
    current: () => state.active ?? state.judged[state.judged.length - 1] ?? null,
    timersActive: () => ({
      poll: state.timer !== null,
      heartbeat: state.hb !== null,
    }),
  };
}
