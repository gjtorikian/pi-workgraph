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
 *    claim. Because the store's `ready --claim` is metadata-blind, claims go
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
 *  - TREE BINDING (`src/snapshot.ts`): unless the `tree-binding` gate is
 *    `off`, every run is bound to two git trees — the BASE the work started
 *    from and the RESULT the implementer handed back — taken by the core
 *    itself. The verdict, the review gate record and the close stamp name
 *    the result tree; the workspace is compared against it after the review
 *    and again before the stamp, and a workspace that moved goes back
 *    through review. The stamp is written before finalization.
 *  - ONE ISSUE UNDER JUDGMENT PER SHARED CHECKOUT: while a run whose work
 *    sits in a non-isolated checkout is in judging or verifying, no new
 *    issue is claimed for a non-isolated executor in that checkout. The
 *    comparison above is against the live checkout, so a second issue's
 *    edits there would read as a change to the first.
 */
import { existsSync, realpathSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { recordLeaseEvent } from "./audit.ts";
import {
  StoreError,
  close,
  ensureWorkspace,
  ready,
  setMetadata,
  show,
  update,
  type MetadataValue,
} from "./store.ts";
import { DEFAULT_CONFIG, type WorkgraphConfig } from "./config.ts";
import {
  critiqueSummary,
  MAX_GAPS,
  parsePlanCritique,
  PlanCritiqueError,
  recordPlanCritique,
  unavailableSummary,
} from "./critique.ts";
import { DISPATCH_FLAG } from "./dispatch.ts";
import {
  discoverExecutors,
  ExecutorSelectionError,
  requestRun,
  selectExecutor,
} from "./executor-registry.ts";
import { FinalizationResult, parseFinalizationResult } from "./finalization.ts";
import {
  decisionAnswer,
  ISSUE_HALT_EVENT,
  issueHaltNotice,
  sourceWorkspace,
} from "./issue-control.ts";
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
  baseCommitOf,
  baseTreeOf,
  escalate,
  executorIdOf,
  failureFingerprintOf,
  isLifecycleV1,
  planApprovedOf,
  planFeedbackOf,
  LifecycleError,
  phaseOf,
  riskTierOf,
  transition,
  workflowClassOf,
  workflowRunIdOf,
  workspacePathOf,
} from "./lifecycle.ts";
import {
  latestPlan,
  parsePlan,
  PlanError,
  planSummary,
  recordPlan,
  renderPlan,
} from "./plan.ts";
import {
  checkIndependence,
  resolvePolicy,
  type GateModeT,
  type GateName,
  type RiskTier,
} from "./policy.ts";
import {
  decideGate,
  recordGate,
  recordStamp,
  recordStampAmendment,
  StampWriteError,
  type GateResult,
} from "./proof.ts";
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
  reconstructBinding,
  requestStatus,
  type RecoveredBinding,
  type ReconcileReport,
} from "./recovery.ts";
import {
  anchorTree,
  isGitWorkspace,
  proofRef,
  runKey,
  snapshotWorkspace,
  treeOf,
  treeOfCommit,
} from "./snapshot.ts";
import { clearLeaseStatus, showLeaseStatus } from "./status.ts";
import { reclaimAndLeaveReady } from "./sweep.ts";
import type {
  WorkIssue,
  IdentityProvider,
  Lease,
  LeaseActor,
  PlanCritiqueT,
  PlanT,
  WorkflowClassT,
  VerdictT,
} from "./types.ts";
import {
  Plan,
  PlanCritique,
  Verdict,
  WORKGRAPH_ACCEPTED_TREE_KEY,
  WORKGRAPH_ACTIVE_EXECUTION_ID_KEY,
  WORKGRAPH_ATTEMPT_KEY,
  WORKGRAPH_AUTHOR_PROVENANCE_KEY,
  WORKGRAPH_BASE_COMMIT_KEY,
  WORKGRAPH_BASE_TREE_KEY,
  WORKGRAPH_EXECUTOR_ID_KEY,
  WORKGRAPH_FAILURE_FINGERPRINT_KEY,
  WORKGRAPH_FINALIZED_TREE_KEY,
  WORKGRAPH_LAST_VERDICT_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_PLAN_APPROVED_KEY,
  WORKGRAPH_PLAN_CRITIQUE_KEY,
  WORKGRAPH_PLAN_FEEDBACK_KEY,
  WORKGRAPH_PLAN_SUMMARY_KEY,
  WORKGRAPH_PLANNER_PROVENANCE_KEY,
  WORKGRAPH_RESULT_COMMIT_KEY,
  WORKGRAPH_RESULT_TREE_KEY,
  WORKGRAPH_WORKFLOW_RUN_ID_KEY,
  WORKGRAPH_WORKFLOW_CLASS_KEY,
  WORKGRAPH_WORKSPACE_PATH_KEY,
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
  VerdictWriteError,
} from "./verdict.ts";

/**
 * Kill switch: the coordinator inherits dispatch's flag name — the operator
 * contract ("workgraph-dispatch=false means no autonomous claiming") is
 * unchanged even though the machinery underneath was replaced.
 */
export const COORDINATOR_FLAG = DISPATCH_FLAG;

export interface CoordinatorDeps {
  /**
   * Effective config; resolved lazily (flags are not readable at load). May
   * THROW: an invalid policy raises `PolicyConfigError`, which stops
   * dispatch and judgment but not the work already under a lease (see
   * `currentConfig` / `heldConfig` in {@link registerCoordinator}).
   */
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
  /**
   * TEST SEAM. How long a plan critique may run before the plan parks
   * without one. Default {@link PLAN_CRITIQUE_WAIT_MS}. Not a user setting:
   * a knob with one exercised value is a constant.
   */
  planCritiqueWaitMs?: number;
  /**
   * TEST SEAM. Called on every pass through the judgment gate's tail, after
   * the verdict was recorded (or the review gate was found `off`) and
   * immediately before the last comparison of the workspace against the
   * result tree. It is the one window no executor runs in, so a test that
   * needs a file edited "after the verdict" has no other way in. Not a user
   * setting.
   */
  beforeAcceptance?: (run: {
    issueId: string;
    workspacePath?: string;
  }) => void | Promise<void>;
}

/**
 * Bounded retries for a review whose completion carried no parseable
 * verdict (the attempt is discarded and audited; counts against THIS bound,
 * never against `maxRevisions`). A knob with one exercised value is a
 * constant (decision log).
 */
export const MAX_REVIEW_RETRIES = 2;

/**
 * Default bound on a plan critique: one attempt, then the plan parks without
 * one. A constant for the same reason {@link MAX_REVIEW_RETRIES} is.
 */
export const PLAN_CRITIQUE_WAIT_MS = 600_000;

/**
 * Resolve topology defensively. Approval already promotes non-low one-shot
 * requests, but hand-written metadata must not be able to bypass a blocking
 * risk policy.
 */
function effectiveWorkflowClass(issue: WorkIssue): WorkflowClassT {
  const workflowClass = workflowClassOf(issue);
  return workflowClass === "oneshot" && riskTierOf(issue) !== "low"
    ? "reviewed"
    : workflowClass;
}

/** Protocol-safe form of the same conservative risk fallback policy uses. */
function effectiveRiskTier(issue: WorkIssue): RiskTier {
  const riskTier = riskTierOf(issue);
  return riskTier === "low" || riskTier === "medium" || riskTier === "high"
    ? riskTier
    : "medium";
}

/** One workflow run the coordinator supervises. */
export interface CoordinatorRun {
  cwd: string;
  issue: WorkIssue;
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
  /** Includes reviews accepted into an executor queue but not yet launched. */
  reviewInFlight?: boolean;
  finalizationInFlight?: boolean;
  /** Evidence refs from the latest fenced completion (compaction). */
  evidence?: string[];
  /**
   * Where the implementer's work lives: the path its completion reported,
   * else the coordinator's own checkout. Set at the implementation's
   * completion (whatever the `tree-binding` mode — it is routing, not
   * proof); every later request of the run sends its role there, and the
   * claim-wait rule reads it.
   */
  workspacePath?: string;
  /** The commit the work started from, its tree, and the workspace both
   *  belong to: the base is keyed by workspace path. */
  baseCommit?: string;
  baseTree?: string;
  basePath?: string;
  /** The anchored snapshot of the result under judgment, and its tree. */
  resultCommit?: string;
  resultTree?: string;
  /** Why the run has no base or no result tree (the gate's `unknown` reason). */
  bindingReason?: string;
  /** Latest result of each gate evaluated for this run; the close stamp
   *  copies it. Kept in memory because gate records are fire-and-forget. */
  gateResults?: Record<string, GateResult>;
  /** The tree the close stamp accepted (compared again after finalization). */
  stampedTree?: string;
  /**
   * A recorded plan that has not parked yet: set by acceptPlan when a
   * critique will run, cleared by parkForPlanReview. While set, the
   * planner's completion has ALREADY been consumed for this run.
   */
  pendingPlan?: {
    plan: PlanT;
    completion: RunCompletedT;
    /** The planner's binding, saved while the run is rebound to the critic,
     *  so both critiqueThenPark and teardown() can restore it before parking. */
    planner?: {
      executorId: string;
      executionId?: string;
      isolation: IsolationLevelT;
      supportsCancellation: boolean;
    };
  };
}

/** What `acceptPlan` tells `onCompleted` to do once the latch is released. */
type PlanNext = "stop" | "implement" | "critique";

/** How one bounded attempt to obtain a plan critique ended. */
type CritiqueOutcome =
  | {
      kind: "critique";
      critique: PlanCritiqueT;
      completion: RunCompletedT;
      executorId: string;
    }
  | { kind: "unavailable"; reason: string }
  /** The inbox closed: teardown (or a human halt) owns the run now. */
  | { kind: "abandon" }
  /** The lease is gone: the run is dropped without parking. */
  | { kind: "lost" };

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
  function legacyLiveLease(issue: WorkIssue): boolean {
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

  /**
   * CONFIG UNDER AN INVALID POLICY. `deps.getConfig()` throws when the policy
   * does not validate, and it resolves afresh on every call, so an edit to a
   * settings file can break it in the middle of a session. Two readers:
   *
   *  - `currentConfig()` THROWS. For the paths that start work or judge it —
   *    the tick, startup reconciliation, the judgment loop — whose wrappers
   *    log the message once and do nothing. This is how an invalid policy
   *    stops dispatch and stops judgment.
   *  - `heldConfig()` never throws. For the paths that protect or finish
   *    work ALREADY under a lease — the heartbeat, teardown, completion
   *    handling, an in-flight revision — which read timers and routing.
   *    Of the policy they read one thing, the `tree-binding` mode, and only
   *    to learn whether to take a snapshot (and, for one-shot work, which
   *    has no judgment loop, to decide that gate). It logs the message and keeps the last config that
   *    resolved, because stopping these over a typo would let a live lease
   *    lapse or strand an issue between two transitions.
   *
   * `DEFAULT_CONFIG` stands in when nothing has resolved yet. Only the poll
   * timer's start can see it: no run is held before a tick or a
   * reconciliation resolved the config, and both go through `currentConfig`.
   */
  let lastConfig: WorkgraphConfig | undefined;

  function currentConfig(): WorkgraphConfig {
    const config = deps.getConfig();
    lastConfig = config;
    return config;
  }

  function heldConfig(): WorkgraphConfig {
    try {
      return currentConfig();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logSkipOnce(msg);
      return lastConfig ?? DEFAULT_CONFIG;
    }
  }

  function onInvalid(channel: string, error: ProtocolError): void {
    // Invalid payload → log once with channel + reason; no state change.
    logSkipOnce(`invalid message on ${channel}: ${error.detail}`);
  }

  // -------------------------------------------------------------------------
  // Tree binding. All git access goes through src/snapshot.ts; everything
  // here turns a git failure into a reason on the run, never into a throw —
  // a snapshot that fails must not abort a claim or a completion.
  // -------------------------------------------------------------------------

  /** Whether two paths name one directory (`/var/...` vs `/private/var/...`). */
  function samePath(a: string, b: string): boolean {
    if (a === b) return true;
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return false;
    }
  }

  /**
   * The `tree-binding` mode for an issue under a given config. The gate is
   * DECIDED in the judgment loop, under `currentConfig()`; the completion
   * handler and the claim path only ask this to learn whether snapshots are
   * wanted at all, and they ask it of the config they already hold.
   */
  function bindingModeOf(issue: WorkIssue, config: WorkgraphConfig): GateModeT {
    return resolvePolicy(riskTierOf(issue), config.policy).gates[
      "tree-binding"
    ];
  }

  /** Why git could not snapshot `path`, in words an escalation can carry. */
  function gitFailure(path: string, e: unknown): string {
    if (!existsSync(path)) return `workspace path does not exist: ${path}`;
    if (!isGitWorkspace(path)) return "workspace is not a git repository";
    const stderr = (e as { stderr?: unknown } | null)?.stderr;
    const detail =
      typeof stderr === "string" && stderr.trim() !== ""
        ? stderr.trim()
        : e instanceof Error
          ? e.message
          : String(e);
    return `git failed in the workspace: ${detail.split("\n")[0]}`;
  }

  /** The result tree, but only when the run also has a base: a result with
   *  nothing to measure it against binds nothing. */
  function boundTreeOf(run: CoordinatorRun): string | undefined {
    return run.baseTree !== undefined ? run.resultTree : undefined;
  }

  function noteGate(
    run: CoordinatorRun,
    gate: GateName,
    result: GateResult,
  ): void {
    run.gateResults = { ...run.gateResults, [gate]: result };
  }

  /**
   * The `workspace` block of every run request, in one place so the six
   * request sites cannot drift. `path` appears once the implementer
   * reported where its work is; `baseTree` and `tree` appear together, once
   * both exist.
   */
  function requestWorkspace(run: CoordinatorRun): RunRequestT["workspace"] {
    const tree = boundTreeOf(run);
    return {
      repoPath: run.cwd,
      ...sourceWorkspace(run.issue.metadata),
      baseRevision: run.baseCommit ?? "",
      requiresIsolation: false,
      ...(run.workspacePath !== undefined ? { path: run.workspacePath } : {}),
      ...(tree !== undefined && run.baseTree !== undefined
        ? { baseTree: run.baseTree, tree }
        : {}),
    };
  }

  /**
   * The base for a NON-ISOLATED executor: snapshot the coordinator's own
   * checkout just before the implementer request goes out, so whatever the
   * user already had uncommitted there is part of the base and is never
   * attributed to the issue. Kept across re-claims: a base already stored
   * for this checkout is reused, so a file deleted in a first attempt still
   * shows as deleted against it. (An isolated executor's base is the
   * revision its completion reports — see `bindResult`.) Never throws.
   */
  async function recordSharedBase(
    run: CoordinatorRun,
    isolation: IsolationLevelT,
    config: WorkgraphConfig,
  ): Promise<void> {
    if (isolation !== "none") return;
    if (bindingModeOf(run.issue, config) === "off") return;
    const storedPath = workspacePathOf(run.issue);
    const storedCommit = baseCommitOf(run.issue);
    const storedTree = baseTreeOf(run.issue);
    if (
      storedPath !== undefined &&
      storedCommit !== undefined &&
      storedTree !== undefined &&
      samePath(storedPath, run.cwd)
    ) {
      run.baseCommit = storedCommit;
      run.baseTree = storedTree;
      run.basePath = run.cwd;
      return;
    }
    try {
      const base = snapshotWorkspace(
        run.cwd,
        proofRef(run.issue.id, `${runKey(run.workflowRunId)}/base`),
        `workgraph base: ${run.issue.id} (${run.workflowRunId})`,
      );
      run.baseCommit = base.commit;
      run.baseTree = base.tree;
      run.basePath = run.cwd;
    } catch {
      // No base: the gate reports `unknown` once the work completes, with
      // the reason `bindResult` works out then.
      return;
    }
    try {
      await setMetadata(
        run.cwd,
        run.issue.id,
        {
          [WORKGRAPH_WORKSPACE_PATH_KEY]: run.cwd,
          [WORKGRAPH_BASE_COMMIT_KEY]: run.baseCommit,
          [WORKGRAPH_BASE_TREE_KEY]: run.baseTree,
        },
        run.actor.bdActor,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logSkipOnce(`could not record the base of ${run.issue.id}: ${msg}`);
    }
  }

  /**
   * Bind a completed implementation or revision: settle where the work is,
   * settle its base, snapshot the result. Returns the metadata to write in
   * the SAME transition that moves the issue on, so the path, the base and
   * the result survive a restart together. Under `off` it only notes the
   * workspace path (routing) and writes nothing.
   *
   * The base, in order: the one this run already holds for this path (the
   * shared-checkout snapshot); the one stored on the issue for this path
   * (a follow-up into a retained worktree); the revision the completion
   * reports, for an executor that is not known to be non-isolated. No base
   * and no result are both `unknown`, with the reason kept on the run.
   */
  function bindResult(
    run: CoordinatorRun,
    completion: RunCompletedT,
    attempt: number,
    isolation: IsolationLevelT | undefined,
    mode: GateModeT,
  ): Record<string, MetadataValue> {
    const path = completion.workspace?.path ?? run.workspacePath ?? run.cwd;
    run.workspacePath = path;
    if (mode === "off") return {};

    let reason: string | undefined;
    if (run.basePath === undefined || !samePath(run.basePath, path)) {
      delete run.baseCommit;
      delete run.baseTree;
      delete run.basePath;
      const storedPath = workspacePathOf(run.issue);
      const storedCommit = baseCommitOf(run.issue);
      const storedTree = baseTreeOf(run.issue);
      const reported = completion.workspace?.baseRevision;
      if (
        storedPath !== undefined &&
        storedCommit !== undefined &&
        storedTree !== undefined &&
        samePath(storedPath, path)
      ) {
        run.baseCommit = storedCommit;
        run.baseTree = storedTree;
        run.basePath = path;
      } else if (isolation !== "none" && reported) {
        try {
          run.baseTree = treeOfCommit(path, reported);
          run.baseCommit = reported;
          run.basePath = path;
        } catch (e) {
          reason = `base revision ${reported} could not be resolved: ${gitFailure(path, e)}`;
        }
      } else {
        reason =
          isolation === "none"
            ? "no base snapshot of the workspace was recorded before the work started"
            : "the executor reported no base revision for its workspace";
      }
    }

    delete run.resultCommit;
    delete run.resultTree;
    try {
      const result = snapshotWorkspace(
        path,
        proofRef(
          run.issue.id,
          `${runKey(run.workflowRunId)}/result-${attempt}`,
        ),
        `workgraph result: ${run.issue.id} attempt ${attempt} (${run.workflowRunId})`,
      );
      run.resultCommit = result.commit;
      run.resultTree = result.tree;
    } catch (e) {
      // The result is the tree every record names: its failure is the
      // reason reported, whatever happened to the base.
      reason = gitFailure(path, e);
    }
    if (reason !== undefined) run.bindingReason = reason;
    else delete run.bindingReason;
    // Path and base are written together, "" for a missing value: a base
    // left behind from another workspace would read as this one's.
    return {
      [WORKGRAPH_WORKSPACE_PATH_KEY]: path,
      [WORKGRAPH_BASE_COMMIT_KEY]: run.baseCommit ?? "",
      [WORKGRAPH_BASE_TREE_KEY]: run.baseTree ?? "",
      [WORKGRAPH_RESULT_COMMIT_KEY]: run.resultCommit ?? "",
      [WORKGRAPH_RESULT_TREE_KEY]: run.resultTree ?? "",
    };
  }

  /**
   * Compare the live workspace with the result tree the run is bound to.
   * `same`: nothing moved. `changed`: it moved, and the run is now bound to
   * the new tree (anchored, written to metadata, audited) — the caller
   * sends it back through review. `failed`: git could not answer; the run
   * loses its result tree and carries the reason, so the gate reports
   * `unknown` on the next pass. A run with no bound tree is always `same`.
   */
  async function recheckWorkspace(
    run: CoordinatorRun,
    attempt: number,
    when: string,
  ): Promise<"same" | "changed" | "failed"> {
    const recorded = boundTreeOf(run);
    const path = run.workspacePath;
    if (recorded === undefined || path === undefined) return "same";
    let live: string;
    let commit: string;
    try {
      live = treeOf(path);
      if (live === recorded) return "same";
      // Anchor the tree that was just compared, not a fresh snapshot: no
      // window for the workspace to move again in between.
      commit = anchorTree(
        path,
        live,
        proofRef(
          run.issue.id,
          `${runKey(run.workflowRunId)}/result-${attempt}-${live.slice(0, 12)}`,
        ),
        `workgraph result: ${run.issue.id} attempt ${attempt}, workspace changed ${when} (${run.workflowRunId})`,
      ).commit;
    } catch (e) {
      run.bindingReason = gitFailure(path, e);
      delete run.resultCommit;
      delete run.resultTree;
      return "failed";
    }
    run.resultCommit = commit;
    run.resultTree = live;
    await setMetadata(
      run.cwd,
      run.lease.issueId,
      {
        [WORKGRAPH_RESULT_COMMIT_KEY]: commit,
        [WORKGRAPH_RESULT_TREE_KEY]: live,
      },
      run.actor.bdActor,
    );
    await recordLeaseEvent(
      run.cwd,
      "workspace-changed",
      run.lease.issueId,
      {
        workflowRunId: run.workflowRunId,
        workspacePath: path,
        previousTree: recorded,
        tree: live,
        when,
      },
      run.actor.bdActor,
    );
    return "changed";
  }

  /**
   * Evaluate and record the `tree-binding` gate for the run's current
   * result: `pass` when a base tree and a result tree both exist, `unknown`
   * otherwise. Returns the escalation reason when the gate blocks
   * (`enforce` and `unknown`), else undefined.
   */
  async function evaluateBinding(
    run: CoordinatorRun,
    mode: GateModeT,
    attempt: number,
  ): Promise<string | undefined> {
    const tree = boundTreeOf(run);
    const result: GateResult = tree !== undefined ? "pass" : "unknown";
    const reason = run.bindingReason ?? "no result tree was recorded";
    const decision = decideGate("tree-binding", mode, result);
    noteGate(run, "tree-binding", result);
    await recordGate(
      run.cwd,
      run.lease.issueId,
      {
        gate: "tree-binding",
        mode,
        result,
        ...decision,
        ...(tree !== undefined ? { tree } : { reason }),
        workflowRunId: run.workflowRunId,
        attempt,
      },
      run.actor.bdActor,
    );
    return decision.blocked
      ? `tree-binding: ${reason}; set gates.tree-binding to observe to close without it`
      : undefined;
  }

  /**
   * Write the close stamp and `workgraph_accepted_tree`. The stamp is
   * durable like the verdict: if it cannot be written the run escalates
   * from `verifying` and this returns false — the caller stops, nothing
   * closes. A run with no bound tree (`observe` and `unknown`) is stamped
   * without the tree fields.
   */
  async function stampAcceptance(
    run: CoordinatorRun,
    attempt: number,
    verdict?: { executionId: string; summary: string },
  ): Promise<boolean> {
    const tree = boundTreeOf(run);
    try {
      await recordStamp(
        run.cwd,
        run.lease.issueId,
        {
          ...(tree !== undefined
            ? {
                tree,
                baseTree: run.baseTree,
                ...(run.resultCommit !== undefined
                  ? { commit: run.resultCommit }
                  : {}),
              }
            : {}),
          workflowRunId: run.workflowRunId,
          attempt,
          ...(verdict !== undefined ? { verdict } : {}),
          gates: { ...run.gateResults },
        },
        run.actor.bdActor,
      );
    } catch (e) {
      if (!(e instanceof StampWriteError)) throw e;
      await escalateRun(
        run,
        "verifying",
        `close stamp could not be written: ${e.detail}`,
      );
      return false;
    }
    run.stampedTree = tree;
    await setMetadata(
      run.cwd,
      run.lease.issueId,
      { [WORKGRAPH_ACCEPTED_TREE_KEY]: tree ?? "" },
      run.actor.bdActor,
    );
    return true;
  }

  /**
   * After a finalization that succeeded: if it changed the stamped tree,
   * record the new tree (anchored, in `workgraph_finalized_tree`, and as a
   * stamp amendment). Never blocks: finalization's external effects have
   * already happened (decision log).
   */
  async function amendAfterFinalization(run: CoordinatorRun): Promise<void> {
    const stamped = run.stampedTree;
    const path = run.workspacePath;
    if (stamped === undefined || path === undefined) return;
    let live: string;
    try {
      live = treeOf(path);
      if (live === stamped) return;
      anchorTree(
        path,
        live,
        proofRef(run.issue.id, `${runKey(run.workflowRunId)}/finalized`),
        `workgraph finalized: ${run.issue.id} (${run.workflowRunId})`,
      );
    } catch (e) {
      logSkipOnce(
        `could not compare ${run.lease.issueId} after finalization: ${gitFailure(path, e)}`,
      );
      return;
    }
    await setMetadata(
      run.cwd,
      run.lease.issueId,
      { [WORKGRAPH_FINALIZED_TREE_KEY]: live },
      run.actor.bdActor,
    );
    await recordStampAmendment(
      run.cwd,
      run.lease.issueId,
      { finalizedTree: live, workflowRunId: run.workflowRunId },
      run.actor.bdActor,
    );
  }

  /** Put what recovery rebuilt about a run's workspace and trees onto it. */
  function applyBinding(run: CoordinatorRun, binding: RecoveredBinding): void {
    if (binding.workspacePath !== undefined) {
      run.workspacePath = binding.workspacePath;
    }
    if (
      binding.workspacePath !== undefined &&
      binding.baseCommit !== undefined &&
      binding.baseTree !== undefined
    ) {
      run.baseCommit = binding.baseCommit;
      run.baseTree = binding.baseTree;
      run.basePath = binding.workspacePath;
    }
    if (binding.resultTree !== undefined) run.resultTree = binding.resultTree;
    if (binding.resultCommit !== undefined) {
      run.resultCommit = binding.resultCommit;
    }
  }

  function heldRuns(): CoordinatorRun[] {
    return state.active ? [...state.judged, state.active] : [...state.judged];
  }

  /** Status-bar detail: the durable phase plus the selected executor. The
   *  handshake states (`requested`/`accepted`) carry no durable phase of
   *  their own, so they render the phase their ROLE is running under —
   *  otherwise a planning run would report "implementing" while the issue
   *  sits in `planning`. */
  function statusDetail(run: CoordinatorRun): {
    phase: string;
    executorId: string;
  } {
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

  const haltGenerations = new Map<string, number>();
  pi.events.on(ISSUE_HALT_EVENT, (value) => {
    const notice = issueHaltNotice(value);
    if (!notice) return;
    haltGenerations.set(
      notice.issueId,
      (haltGenerations.get(notice.issueId) ?? 0) + 1,
    );
    for (const run of heldRuns()) {
      if (
        run.issue.id !== notice.issueId ||
        run.lease.epoch > notice.leaseEpoch
      )
        continue;
      notice.workflowRunIds.push(run.workflowRunId);
      if (state.active === run) state.active = null;
      untrackLease(run.cwd, run.issue.id);
      dropJudgedRun(run);
    }
    if (heldRuns().length === 0) stopHeartbeat();
  });

  /**
   * Abandon a judged run whose durable state moved underneath it (override,
   * re-approve, concurrent writer — every LifecycleError site): attempt a
   * fenced voluntary release FIRST — without it the store lease would sit
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
    timeoutMs?: number,
  ): Promise<RunCompletedT | null> {
    const deadline =
      timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    for (;;) {
      const idx = box.messages.findIndex((m) => m.executionId === executionId);
      if (idx >= 0) return box.messages.splice(idx, 1)[0]!;
      if (box.closed || Date.now() >= deadline) return null;
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = () => {
          if (timer) clearTimeout(timer);
          box.waiters = box.waiters.filter((w) => w !== wake);
          resolve();
        };
        box.waiters.push(wake);
        if (Number.isFinite(deadline))
          timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
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
   * strictly POST-COMMIT — fired only AFTER the corresponding store writes
   * (transition/escalate/close) resolved, so observers can never see a
   * phantom transition; every LifecycleError path emits nothing. Fire-and-
   * forget like the audit trail: a broken observer must never take the
   * lifecycle down. COVERAGE GAP BY DESIGN: sweep reclaims and recovery
   * re-adoption/abandon live outside this module and emit no activity —
   * observers needing those read the audit trail (README notes the gap).
   */
  function emitActivity(a: {
    kind: "claim" | "transition" | "verdict" | "escalation" | "close" | "plan-review";
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
   * execution, review, or finalization, including executor-owned queues.
   */
  /**
   * The executor pin for a role: the per-role table (`executorByRole`, from
   * settings or flag) wins over the global `executorId`. Either pin is
   * fail-closed in selectExecutor: a pinned executor that did not offer
   * means no claim, never a silent fallback to someone else.
   */
  function pinFor(role: string): { executorId?: string } {
    const config = heldConfig();
    const pinned = config.executorByRole?.[role] ?? config.executorId;
    return pinned !== undefined ? { executorId: pinned } : {};
  }

  function inFlightCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const bump = (executorId: string): void => {
      counts.set(executorId, (counts.get(executorId) ?? 0) + 1);
    };
    if (state.active) bump(state.active.executorId);
    for (const run of state.judged) {
      if (
        run.revisionInFlight ||
        run.reviewInFlight ||
        run.finalizationInFlight
      )
        bump(run.executorId);
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
      ...(run.executionId !== undefined
        ? { executionId: run.executionId }
        : {}),
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
    reason = "coordinator shutdown",
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
      publishCancel(run, reason);
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
    bindingFields: Record<string, MetadataValue>,
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
        ...bindingFields,
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
    // TREE BINDING for one-shot work. There is no judging phase and no
    // judgment loop here, so the gate is decided where the work lands: in
    // `verifying`, on the policy of the config this handler holds. Then the
    // stamp, BEFORE finalization, exactly as on the reviewed path.
    const bindingMode = bindingModeOf(run.issue, heldConfig());
    if (bindingMode !== "off") {
      const blocked = await evaluateBinding(run, bindingMode, run.attempt);
      let stopped: boolean;
      if (blocked !== undefined) {
        await escalateRun(run, "verifying", blocked);
        stopped = true;
      } else {
        // Escalates by itself when the stamp cannot be written.
        stopped = !(await stampAcceptance(run, run.attempt));
      }
      if (stopped) {
        if (state.active === run) state.active = null;
        if (heldRuns().length === 0) stopHeartbeat();
        return;
      }
    }
    if (heldConfig().finalization) {
      state.active = null;
      state.judged.push(run);
      state.inboxes.set(run.workflowRunId, {
        messages: [],
        waiters: [],
        closed: false,
      });
      if (!(await finalize(run, msg))) return;
      if (bindingMode !== "off") await amendAfterFinalization(run);
    }
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
    dropJudgedRun(run);
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

    if (run.pendingPlan) {
      // The planner's completion was already consumed and its plan recorded.
      // Anything else arriving for this run now (a critic completion after
      // its inbox closed, a re-delivery) is not a plan and must never reach
      // acceptPlan, which would record plan-invalid and escalate.
      logSkipOnce(
        `ignoring run:completed for ${msg.workflowRunId}: its plan is already recorded`,
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
    let startCritique = false;
    try {
      // Fencing triple, part 1: the payload must match the run we supervise.
      const payloadMatches =
        msg.issueId === run.lease.issueId &&
        msg.leaseEpoch === run.lease.epoch &&
        msg.workflowRunId === run.workflowRunId;

      // Fencing triple, part 2: re-validate against the store — the epoch and
      // holder must still be current AND the persisted workflow-run id must
      // still be ours. Never trust cached lease state across the await gap.
      let storeMatches = false;
      if (payloadMatches) {
        if (await verifyHolding(run.cwd, run.lease, run.actor.holder)) {
          const cur = await show(run.cwd, run.lease.issueId);
          storeMatches =
            cur.metadata?.[WORKGRAPH_WORKFLOW_RUN_ID_KEY] === run.workflowRunId;
        }
      }

      if (!payloadMatches || !storeMatches) {
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
              ? "lease no longer current in the store (reclaimed or rewritten)"
              : "payload fencing triple does not match the supervised run",
          },
          run.actor.bdActor,
        );
        if (payloadMatches && !storeMatches) {
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

      // TREE BINDING, for a finished implementation only (a plan has no
      // result, and a question or an execution error is not one either):
      // note where the work is and snapshot it BEFORE the audit below, so
      // the `run-completed` event — what a restart rebuilds the run from —
      // carries the workspace path and the result tree. The metadata it
      // returns rides the transition that moves the issue on.
      let bindingFields: Record<string, MetadataValue> = {};
      if (
        run.role === "implementer" &&
        !msg.decisionQuestion &&
        !msg.executionError
      ) {
        bindingFields = bindResult(
          run,
          msg,
          run.attempt,
          run.isolation,
          bindingModeOf(run.issue, heldConfig()),
        );
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
          ...(msg.executionError ? { executionError: msg.executionError } : {}),
          provenance: msg.provenance,
          ...(run.role === "implementer" && run.workspacePath !== undefined
            ? { workspacePath: run.workspacePath }
            : {}),
          ...(run.role === "implementer" && run.resultTree !== undefined
            ? { tree: run.resultTree }
            : {}),
        },
        run.actor.bdActor,
      );

      // A finished PLAN is not a finished implementation: it advances
      // planning → implementing and is re-dispatched, never reaching the
      // judgment gate. The durable part runs inside the `completing` latch
      // (so a duplicate completion cannot double-transition); the DISPATCH
      // deliberately does not — see the tail of this function.
      if (msg.decisionQuestion) {
        await requestDecision(
          run,
          run.role === "planner" ? "planning" : "implementing",
          msg,
        );
        if (state.active === run) state.active = null;
        if (heldRuns().length === 0) stopHeartbeat();
      } else if (msg.executionError) {
        await escalateRun(
          run,
          run.role === "planner" ? "planning" : "implementing",
          `${run.role} execution failed: ${msg.executionError}`,
        );
        if (state.active === run) state.active = null;
        if (heldRuns().length === 0) stopHeartbeat();
      } else if (run.role === "planner") {
        const next = await acceptPlan(run, msg);
        startImplementation = next === "implement";
        startCritique = next === "critique";
        // A rejected, invalid, or parked plan releases its durable claim,
        // but it never enters judgment tracking. Clear the active slot as
        // well, otherwise every later tick returns early and the queue
        // stalls. NOT for "critique": that run stays active — its lease is
        // still held and heartbeated — until critiqueThenPark parks it.
        if (next === "stop" && state.active === run) {
          state.active = null;
          if (heldRuns().length === 0) stopHeartbeat();
        }
      } else if (effectiveWorkflowClass(run.issue) === "oneshot") {
        await finishOneshot(run, msg, bindingFields);
      } else {
        try {
          await transition(
            run.cwd,
            run.lease.issueId,
            "implementing",
            "judging",
            {
              fields: {
                ...bindingFields,
                [WORKGRAPH_AUTHOR_PROVENANCE_KEY]: JSON.stringify(
                  msg.provenance,
                ),
              },
              actor: run.actor.bdActor,
            },
          );
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
    // ALL continuations run OUTSIDE the `completing` latch, and for the same
    // reason: each emits a request whose executor may answer synchronously on
    // the process-local bus, so the resulting `run:completed` re-enters this
    // handler DURING the call. Dispatching the implementation inside the
    // latch would make that completion hit `if (state.completing) return` and
    // be dropped — the run would then sit in `implementing` until its lease
    // expired, with the plan already committed. (A critic's completion
    // dropped the same way would cost every critique its full wait.) Awaited
    // so the handler's promise spans the whole chain (test buses drain it;
    // the real bus ignores the return value).
    if (startImplementation) await dispatchImplementation(run);
    if (startCritique) await critiqueThenPark(run);
    if (startJudgment) await judge(run, msg);
  }

  /**
   * A fenced planner completion: validate the reported plan, persist it, and
   * either park it for a human or advance planning → implementing. Returns
   * what the caller should do next — "implement" (dispatch the
   * implementation run), "critique" (ask a plan_critic, then park), or
   * "stop". The dispatch itself must happen OUTSIDE the `completing` latch
   * this runs under (see `onCompleted`'s tail), so every path here reports
   * its decision rather than acting on it.
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
  ): Promise<PlanNext> {
    if (msg.outcome !== "success") {
      await escalateRun(run, "planning", completionFailure("planner", msg));
      return "stop";
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
      await escalateRun(
        run,
        "planning",
        `planner returned an invalid plan: ${detail}`,
      );
      return "stop";
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

    // THE HUMAN GATE (default): park the plan for review and release the
    // lease. Only `planApproval: "auto"` lets a plan flow straight on.
    if ((heldConfig().planApproval ?? "required") !== "auto") {
      if (wantsPlanCritique(run)) {
        // Decide here, act in onCompleted's tail: the critic's request must
        // not be sent from inside the completion latch.
        run.pendingPlan = { plan, completion: msg };
        return "critique";
      }
      await parkForPlanReview(run, msg, plan);
      return "stop";
    }

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
        return "stop";
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
    return "implement";
  }

  /**
   * Whether a recorded plan gets an advisory critique before it parks:
   * `planCritique: "high-risk"` and a high-risk issue. The tier is read
   * through the conservative fallback, so an unreadable tier means no
   * critique. No workflow-class check: only `planned` issues reach a
   * planner run. Never consulted on the `planApproval: "auto"` path, where
   * nobody would read the result before the plan is built.
   */
  function wantsPlanCritique(run: CoordinatorRun): boolean {
    return (
      heldConfig().planCritique === "high-risk" &&
      effectiveRiskTier(run.issue) === "high"
    );
  }

  /**
   * Park a recorded plan for a human: planning → plan_review, then RELEASE
   * the lease — nobody is working the issue while it waits, so a lease would
   * only expire into a pointless reclaim. The approval tool sends the issue
   * back to `ready`; the claim path then implements the recorded plan
   * (approved) or plans again with the feedback (rejected). Always returns
   * false: the implementation never starts from here.
   *
   * `critiqueValue` is the `workgraph_plan_critique` value. It is written
   * on EVERY park, defaulting to "", so a plan parked without a critique
   * clears whatever an earlier plan's critique left there.
   *
   * `msg` is the PLANNER's completion and `run` must carry the planner's
   * binding: the audit below names the plan's source, not the critic.
   */
  async function parkForPlanReview(
    run: CoordinatorRun,
    msg: RunCompletedT,
    plan: PlanT,
    critiqueValue = "",
  ): Promise<boolean> {
    try {
      await transition(run.cwd, run.lease.issueId, "planning", "plan_review", {
        fields: {
          [WORKGRAPH_PLAN_SUMMARY_KEY]: planSummary(plan),
          [WORKGRAPH_PLANNER_PROVENANCE_KEY]: JSON.stringify(msg.provenance),
          [WORKGRAPH_PLAN_APPROVED_KEY]: false,
          [WORKGRAPH_PLAN_FEEDBACK_KEY]: "",
          [WORKGRAPH_PLAN_CRITIQUE_KEY]: critiqueValue,
        },
        actor: run.actor.bdActor,
      });
    } catch (e) {
      if (e instanceof LifecycleError) {
        delete run.pendingPlan;
        logSkipOnce(e.message);
        untrackLease(run.cwd, run.lease.issueId);
        if (state.active === run) state.active = null;
        if (heldRuns().length === 0) stopHeartbeat();
        return false;
      }
      throw e;
    }
    // The plan is parked: nothing is pending any more, and a completion
    // arriving for this run from here on is simply late.
    delete run.pendingPlan;
    emitActivity({
      kind: "plan-review",
      issueId: run.lease.issueId,
      phase: "plan_review",
      workflowRunId: run.workflowRunId,
      actor: run.actor.bdActor,
      summary: `plan recorded (${plan.steps.length} steps) from ${run.executorId} — awaiting workgraph_approve_plan`,
    });
    await recordLeaseEvent(
      run.cwd,
      "plan-review",
      run.lease.issueId,
      {
        workflowRunId: run.workflowRunId,
        executionId: msg.executionId,
        executorId: run.executorId,
        steps: plan.steps.length,
      },
      run.actor.bdActor,
    );
    // Only OUR slot: a park that finishes after this run was detached (a
    // critique wait that outlived its lease, or teardown) must not clear a
    // run a later tick claimed.
    if (state.active === run) state.active = null;
    if (heldRuns().length === 0) stopHeartbeat();
    try {
      await releaseLease(run.cwd, run.lease, run.actor);
    } catch (e) {
      if (!(e instanceof FencingError)) {
        const detail = e instanceof Error ? e.message : String(e);
        logSkipOnce(`could not release ${run.lease.issueId}: ${detail}`);
      }
    }
    return false;
  }

  /**
   * Dispatch the implementation run for a run already transitioned into
   * `implementing`. Split out of the claim path because the planner tier
   * reaches this point from a completion handler rather than a tick, with a
   * lease it already holds.
   */
  async function dispatchImplementation(run: CoordinatorRun): Promise<void> {
    const config = heldConfig();
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
        pinFor("implementer"),
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
    // The planner tier reaches its implementer here, not through the claim
    // path, so the shared-checkout base is taken here too.
    await recordSharedBase(run, implementer.isolation, config);
    if (state.active !== run) return; // halted while the base was recorded

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
      ...decisionAnswer(run.issue.metadata),
      workspace: requestWorkspace(run),
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
  // The plan critique. ADVISORY: one bounded attempt to get a plan_critic's
  // gaps in front of the human, between the planner's completion and the
  // park. Nothing here may reject, escalate, or re-plan because of what a
  // critic said or failed to say — every way it can fail ends where the plan
  // was going anyway: plan_review, lease released, human in charge.
  // -------------------------------------------------------------------------

  /**
   * Whether this run still holds its lease in the STORE and is still the
   * run the issue records — the store half of the fencing triple, for the
   * critique exits that have no completion message to fence.
   */
  async function holdsPlanningLease(run: CoordinatorRun): Promise<boolean> {
    if (!(await verifyHolding(run.cwd, run.lease, run.actor.holder)))
      return false;
    const cur = await show(run.cwd, run.lease.issueId);
    return cur.metadata?.[WORKGRAPH_WORKFLOW_RUN_ID_KEY] === run.workflowRunId;
  }

  /** Put the planner's binding back on a run that was rebound to a critic. */
  function restorePlannerBinding(run: CoordinatorRun): void {
    const planner = run.pendingPlan?.planner;
    if (!planner) return;
    run.executorId = planner.executorId;
    run.isolation = planner.isolation;
    run.supportsCancellation = planner.supportsCancellation;
    if (planner.executionId !== undefined)
      run.executionId = planner.executionId;
    else delete run.executionId;
  }

  /**
   * Ask one plan_critic for a critique of the pending plan and wait a
   * bounded time for it. EXACTLY ONE REQUEST: there is no loop here — a
   * rejected, timed-out, failed, or invalid critique is not retried and no
   * second executor is tried.
   *
   * Two things are re-checked after EVERY await, in this order:
   *
   *  - `box.closed` — teardown (or a human halt) took the run. That path
   *    returns "abandon" having mutated nothing and written nothing:
   *    teardown reads this run's binding after its own first await, and a
   *    store call here could land after the workspace is gone.
   *  - `state.active !== run` — the lease was lost underneath the wait (the
   *    heartbeat drops an active run on a fencing loss without closing its
   *    inbox, since before the critique no active run had one). Parking
   *    then would write `plan_review` over whatever claimed the issue next.
   *
   * A critic left running is canceled with `publishCancel`, never
   * `cancelAndAwaitAck`: the critic is read-only and the park does not
   * depend on it having stopped — deliberately unlike `finalize`, whose
   * executor may be mutating the checkout. The cancel only frees the slot.
   */
  async function obtainCritique(
    run: CoordinatorRun,
    pending: NonNullable<CoordinatorRun["pendingPlan"]>,
    box: JudgmentInbox,
  ): Promise<CritiqueOutcome> {
    const config = heldConfig();
    const offers = await discoverExecutors(pi.events, {
      timeoutMs: config.discoveryTimeoutMs,
      now: nowFn,
      onInvalid,
    });
    if (box.closed) return { kind: "abandon" };
    if (state.active !== run) return { kind: "lost" };

    // The planner's execution has finished but `state.active` still counts
    // it: release that slot before selecting, exactly as
    // dispatchImplementation does, or one executor offering both roles at
    // `maxConcurrency: 1` could never critique its own plan. Computed while
    // `run.executorId` is still the planner's.
    const counts = new Map(inFlightCounts());
    const held = counts.get(run.executorId);
    if (held !== undefined) {
      if (held <= 1) counts.delete(run.executorId);
      else counts.set(run.executorId, held - 1);
    }
    let critic;
    try {
      critic = selectExecutor(
        offers,
        { role: "plan_critic", requiresIsolation: false },
        pinFor("plan_critic"),
        counts,
      );
    } catch (e) {
      if (!(e instanceof ExecutorSelectionError)) throw e;
      critic = undefined;
    }
    // A pin overrides registry filters (and `pinFor` falls back to the
    // global executor pin), so re-check the role: a pinned executor that
    // does not critique is "no critic", not a request it will reject.
    if (!critic || !critic.roles.includes("plan_critic"))
      return { kind: "unavailable", reason: "no plan_critic executor" };

    // Rebind the run to the critic for the wait — this is what makes
    // `publishCancel`, the heartbeat's lease-loss cancel, and teardown
    // address the critic rather than the finished planner. In memory only:
    // recovery abandons any run found in `planning`, so there is nothing to
    // reconcile, and a metadata write would have to be undone before parking.
    run.executorId = critic.executorId;
    run.isolation = critic.isolation;
    run.supportsCancellation = critic.supportsCancellation;
    delete run.executionId;

    const request: RunRequestT = {
      ...newEnvelope(nowFn),
      executorId: critic.executorId,
      workflowRunId: run.workflowRunId,
      leaseEpoch: run.lease.epoch,
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
      role: "plan_critic",
      attempt: run.attempt,
      workspace: requestWorkspace(run),
      outputSchema: PlanCritique,
      // What the implementer would receive — the critic judges exactly that.
      plan: renderPlan(pending.plan),
    };
    const result = await requestRun(pi.events, request, {
      timeoutMs: config.acceptTimeoutMs,
      onInvalid,
    });
    const acceptedId =
      result.kind === "accepted" ? result.message.executionId : undefined;
    if (box.closed || state.active !== run) {
      // Whoever took the run did not know this execution id yet (teardown
      // sees no accepted critic; the heartbeat's cancel carried none), so
      // address the critic here. Built from a COPY: on the closed path the
      // run itself is teardown's now and must not be touched.
      if (result.kind !== "rejected")
        publishCancel(
          { ...run, executionId: acceptedId },
          "plan critique abandoned during acceptance",
        );
      return box.closed ? { kind: "abandon" } : { kind: "lost" };
    }
    if (result.kind === "rejected") {
      return {
        kind: "unavailable",
        reason: `plan_critic rejected the request: ${result.message.reason}`,
      };
    }
    if (result.kind === "timeout") {
      publishCancel(run, "plan critique was not accepted in time");
      return {
        kind: "unavailable",
        reason: "plan_critic did not accept in time",
      };
    }
    run.executionId = result.message.executionId;

    const waitMs = deps.planCritiqueWaitMs ?? PLAN_CRITIQUE_WAIT_MS;
    const completion = await awaitCompletion(
      box,
      result.message.executionId,
      waitMs,
    );
    // A critique that arrived as teardown began is lost: the plan parks as
    // unavailable there. Accepted — it beats racing teardown to the park.
    if (box.closed) return { kind: "abandon" };
    if (state.active !== run) return { kind: "lost" };
    if (!completion) {
      publishCancel(run, "plan critique timed out");
      return {
        kind: "unavailable",
        reason: `no critique within ${waitMs / 1000} s`,
      };
    }

    // Fencing at consumption, as every sub-run completion gets: payload
    // triple, store lease, stored workflow-run id. A failure means the
    // lease is gone and the whole run is stale.
    const fenced = await fencedForJudgment(run, completion);
    if (box.closed) return { kind: "abandon" };
    if (!fenced || state.active !== run) return { kind: "lost" };

    // A critic may not ask the human anything: a question (or `blocked`)
    // is an unavailable critique, and its pending worker is canceled so it
    // cannot hold the bridge's upstream slot. Never requestDecision.
    if (completion.decisionQuestion || completion.outcome === "blocked") {
      publishCancel(run, "plan critique cannot ask for a decision");
      return {
        kind: "unavailable",
        reason: "plan_critic asked a question instead of reporting",
      };
    }
    // Never escalateRun: a failed critic costs the human a critique, not
    // the plan.
    if (completion.outcome !== "success" || completion.executionError) {
      return {
        kind: "unavailable",
        reason: completionFailure("plan_critic", completion),
      };
    }
    try {
      const critique = parsePlanCritique(
        (completion as RunCompletedT & { critique?: unknown }).critique,
      );
      return {
        kind: "critique",
        critique,
        completion,
        executorId: critic.executorId,
      };
    } catch (e) {
      if (!(e instanceof PlanCritiqueError)) throw e;
      return {
        kind: "unavailable",
        reason: `invalid critique: ${e.detail}`,
      };
    }
  }

  /**
   * Record what the critique attempt produced and park the plan with it.
   * Runs under the PLANNER's binding (restored first), so the park audit
   * names the plan's source. Returns without parking only when the run is
   * no longer this coordinator's to park.
   */
  async function recordCritiqueAndPark(
    run: CoordinatorRun,
    pending: NonNullable<CoordinatorRun["pendingPlan"]>,
    box: JudgmentInbox,
    outcome: CritiqueOutcome,
  ): Promise<void> {
    if (outcome.kind === "abandon" || box.closed) return;
    if (outcome.kind === "lost" || state.active !== run) return;
    restorePlannerBinding(run);

    let summary: string;
    if (outcome.kind === "critique") {
      const { critique, completion } = outcome;
      await recordPlanCritique(
        run.cwd,
        run.lease.issueId,
        critique,
        {
          planExecutionId: pending.completion.executionId,
          workflowRunId: run.workflowRunId,
          executionId: completion.executionId,
          executorId: outcome.executorId,
          provenance: completion.provenance,
        },
        run.actor.bdActor,
      );
      const shown = Math.min(critique.gaps.length, MAX_GAPS);
      await recordLeaseEvent(
        run.cwd,
        "plan-critique",
        run.lease.issueId,
        {
          workflowRunId: run.workflowRunId,
          executionId: completion.executionId,
          executorId: outcome.executorId,
          gaps: shown,
          ...(critique.gaps.length > shown
            ? { foldedGaps: critique.gaps.length - shown }
            : {}),
        },
        run.actor.bdActor,
      );
      // A NOTE, not a gate: said only when both sides reported a model and
      // they match. Missing on either side means no note — the opposite of
      // checkIndependence's fail-closed rule, on purpose.
      const plannerModel = pending.completion.provenance?.model;
      const criticModel = completion.provenance?.model;
      summary = critiqueSummary(critique, {
        sameModel:
          typeof plannerModel === "string" &&
          plannerModel !== "" &&
          plannerModel === criticModel,
      });
    } else {
      // No completion fenced this exit (no executor, rejection, timeout,
      // internal error), or it was fenced a wait ago: confirm the lease in
      // the store before writing a park over the issue.
      if (!(await holdsPlanningLease(run))) {
        if (box.closed) return;
        // Lease lost: dropped by critiqueThenPark's cleanup, not parked.
        delete run.pendingPlan;
        return;
      }
      if (box.closed || state.active !== run) return;
      await recordLeaseEvent(
        run.cwd,
        "plan-critique-unavailable",
        run.lease.issueId,
        { workflowRunId: run.workflowRunId, reason: outcome.reason },
        run.actor.bdActor,
      );
      summary = unavailableSummary(outcome.reason);
    }
    // Teardown may have started during the writes above; it parks the run.
    if (box.closed || state.active !== run) return;
    await parkForPlanReview(run, pending.completion, pending.plan, summary);
  }

  /**
   * The continuation `onCompleted` runs for a plan `acceptPlan` marked
   * pending: one bounded attempt to get a critique, then park. It runs
   * inside the `planning` phase under the planner run's lease, workflow-run
   * id, and fencing triple, with the run still `state.active` — so the
   * heartbeat keeps renewing the lease and the tick claims nothing else.
   *
   * THE INBOX OPENS BEFORE ANYTHING IS SENT: `run:completed` carries no
   * role, so the critic's completion is told apart from the planner's by
   * routing every completion for this workflow run into the inbox and
   * awaiting by execution id — a critic may complete inside the request
   * emit. It closes LAST, so stragglers are swallowed for as long as
   * possible; `run.pendingPlan` guards the gap after that.
   *
   * Exits that do not park: teardown/halt took the run (inbox closed —
   * nothing here touches it), or the lease is gone (dropped, as the planner
   * path drops a stale completion). Everything else parks, including an
   * unexpected throw: a bug in the critique path must not strand a recorded
   * plan in `planning`, and must never leave `state.active` set — no issue
   * would be claimed again this session.
   */
  async function critiqueThenPark(run: CoordinatorRun): Promise<void> {
    const pending = run.pendingPlan;
    // Detached while the plan was being recorded (teardown, halt): whoever
    // detached the run owns its lease, and teardown parks a pending plan.
    if (!pending || state.active !== run) return;
    pending.planner = {
      executorId: run.executorId,
      // From the completion, not `run.executionId`: that is only bound by
      // the tick's post-accept continuation, which may not have run yet.
      executionId: pending.completion.executionId,
      isolation: run.isolation,
      supportsCancellation: run.supportsCancellation,
    };
    const box: JudgmentInbox = { messages: [], waiters: [], closed: false };
    state.inboxes.set(run.workflowRunId, box);
    try {
      let outcome: CritiqueOutcome;
      try {
        outcome = await obtainCritique(run, pending, box);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.error(
          `[pi-workgraph] plan critique failed for ${run.lease.issueId}: ${detail}`,
        );
        // An execution may be in flight behind the throw; free its slot.
        if (
          !box.closed &&
          run.executionId !== undefined &&
          run.executionId !== pending.completion.executionId
        )
          publishCancel(run, "plan critique failed");
        outcome = { kind: "unavailable", reason: `internal error: ${detail}` };
      }
      await recordCritiqueAndPark(run, pending, box, outcome);
    } catch (e) {
      // Recording or parking threw. Park once more with nothing but the
      // summary — unless the park already ran (pendingPlan cleared) or the
      // run is no longer ours.
      const detail = e instanceof Error ? e.message : String(e);
      console.error(
        `[pi-workgraph] could not park ${run.lease.issueId} after its plan critique: ${detail}`,
      );
      if (!box.closed && state.active === run && run.pendingPlan === pending) {
        try {
          restorePlannerBinding(run);
          await parkForPlanReview(
            run,
            pending.completion,
            pending.plan,
            unavailableSummary(`internal error: ${detail}`),
          );
        } catch (again) {
          const msg = again instanceof Error ? again.message : String(again);
          logSkipOnce(`could not park ${run.lease.issueId}: ${msg}`);
        }
      }
    } finally {
      // A closed inbox means teardown or a halt owns the run: leave the run
      // and the coordinator state exactly as they are.
      if (!box.closed) {
        if (state.active === run) {
          // Neither parked nor taken over — the lease was lost, or the park
          // itself failed. Drop the run: untracked and un-heartbeated, its
          // lease expires and the sweep returns the issue to `ready`.
          untrackLease(run.cwd, run.lease.issueId);
          state.active = null;
        }
        delete run.pendingPlan;
        if (heldRuns().length === 0) stopHeartbeat();
        closeInbox(run.workflowRunId);
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
   * AND the store (never trust cached lease state across an await gap). A
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
    let storeMatches = false;
    if (payloadMatches) {
      if (await verifyHolding(run.cwd, run.lease, run.actor.holder)) {
        const cur = await show(run.cwd, run.lease.issueId);
        storeMatches =
          cur.metadata?.[WORKGRAPH_WORKFLOW_RUN_ID_KEY] === run.workflowRunId;
      }
    }
    if (payloadMatches && storeMatches) return true;
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
          ? "lease no longer current in the store (reclaimed or rewritten)"
          : "payload fencing triple does not match the supervised run",
      },
      run.actor.bdActor,
    );
    return false;
  }

  /** Park an explicit question without sending unfinished work for review. */
  async function requestDecision(
    run: CoordinatorRun,
    phase: "planning" | "implementing" | "judging" | "revising" | "verifying",
    completion: RunCompletedT,
  ): Promise<void> {
    const stopped =
      !completion.workerPending ||
      (run.supportsCancellation &&
        (await cancelAndAwaitAck(
          run,
          heldConfig().acceptTimeoutMs,
          "waiting for a human decision",
        )));
    // Cancellation can overlap a human halt or a reclaimed lease.
    if (!(await fencedForJudgment(run, completion))) {
      untrackLease(run.cwd, run.lease.issueId);
      dropJudgedRun(run);
      return;
    }
    const saved = await escalateRun(
      run,
      phase,
      `Needs your decision: ${completion.decisionQuestion}`,
      {
        workgraph_decision_pending: true,
        workgraph_decision_id: completion.executionId,
        workgraph_decision_question: completion.decisionQuestion!,
        workgraph_decision_requested_at: new Date(nowFn()).toISOString(),
        workgraph_workspace_run_id: run.workflowRunId,
        workgraph_halt_unconfirmed: !stopped,
      },
    );
    if (!saved) return;
    await recordLeaseEvent(
      run.cwd,
      "decision-needed",
      run.lease.issueId,
      {
        workflowRunId: run.workflowRunId,
        decisionId: completion.executionId,
        question: completion.decisionQuestion,
        workerStopped: stopped,
      },
      run.actor.bdActor,
    );
  }

  /** Escalate with a guarded phase write, audit, lease release, and blocked status. */
  async function escalateRun(
    run: CoordinatorRun,
    expect: "planning" | "implementing" | "judging" | "revising" | "verifying",
    reason: string,
    fields: Record<string, MetadataValue> = {},
  ): Promise<boolean> {
    try {
      await escalate(run.cwd, run.lease.issueId, expect, {
        fields,
        actor: run.actor.bdActor,
      });
    } catch (e) {
      if (e instanceof LifecycleError) {
        logSkipOnce(e.message);
        await abandonJudgedRun(run);
        return false;
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
    // block: the ready query excludes blocked issues, and the open window is
    // invisible to approved-only claiming (the phase is already escalated).
    try {
      await releaseLease(run.cwd, run.lease, run.actor);
    } catch (e) {
      if (!(e instanceof FencingError)) throw e;
      dropJudgedRun(run); // reclaimed mid-escalation: no longer ours to block
      return false;
    }
    await update(
      run.cwd,
      run.lease.issueId,
      { status: "blocked" },
      run.actor.bdActor,
    );
    dropJudgedRun(run);
    return true;
  }

  /**
   * A reviewed workflow that cannot converge gets one structural escalation:
   * promote it to planned and return it ready. A planned workflow that still
   * cannot converge takes the ordinary blocked escalation path.
   */
  async function promoteReviewedToPlanned(
    run: CoordinatorRun,
    reason: string,
    fields: Record<string, MetadataValue> = {},
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
    bindingMode: GateModeT,
  ): Promise<RunCompletedT | "parked" | "aborted"> {
    const config = heldConfig();
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
        pinFor("revision"),
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
      ...decisionAnswer(run.issue.metadata),
      workspace: requestWorkspace(run),
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
    // A revision is a new result: snapshot it before the audit, as the
    // implementation's completion handler does, and write its keys in the
    // revising → judging transition below.
    const bindingFields =
      completion.decisionQuestion || completion.executionError
        ? {}
        : bindResult(run, completion, attempt, revisor.isolation, bindingMode);
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
        ...(completion.executionError
          ? { executionError: completion.executionError }
          : {}),
        artifacts: completion.artifacts,
        evidence: completion.evidence,
        provenance: completion.provenance,
        ...(run.workspacePath !== undefined
          ? { workspacePath: run.workspacePath }
          : {}),
        ...(run.resultTree !== undefined ? { tree: run.resultTree } : {}),
      },
      run.actor.bdActor,
    );
    if (completion.decisionQuestion) {
      await requestDecision(run, "revising", completion);
      return "aborted";
    }
    if (completion.executionError) {
      await escalateRun(
        run,
        "revising",
        `revision execution failed: ${completion.executionError}`,
      );
      return "aborted";
    }
    // revising → judging: any outcome is judged — the reviewer sees
    // failures too; the gate, not the implementer, decides what they mean.
    try {
      await transition(run.cwd, run.lease.issueId, "revising", "judging", {
        fields: {
          ...bindingFields,
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

  function completionFailure(role: string, completion: RunCompletedT): string {
    const detail = completion.executionError || completion.evidence.join("; ");
    return `${role} execution failed (${completion.outcome})${detail ? `: ${detail.slice(0, 1500)}` : ""}`;
  }

  /** Optional caller-defined work. A missing or failed result never closes the issue. */
  async function finalize(
    run: CoordinatorRun,
    author: RunCompletedT,
  ): Promise<boolean> {
    const config = heldConfig();
    const task = config.finalization;
    if (!task) return true;
    const box = state.inboxes.get(run.workflowRunId);
    if (!box || box.closed) return false;
    const offers = await discoverExecutors(pi.events, {
      timeoutMs: config.discoveryTimeoutMs,
      now: nowFn,
      onInvalid,
    });
    if (box.closed) return false;
    let executor;
    try {
      executor = selectExecutor(
        offers,
        { role: "finalizer", requiresIsolation: false },
        pinFor("finalizer"),
        inFlightCounts(),
      );
    } catch (error) {
      if (!(error instanceof ExecutorSelectionError)) throw error;
    }
    if (!executor) {
      await escalateRun(
        run,
        "verifying",
        "configured finalization has no capable executor",
        { workgraph_finalization_status: "blocked" },
      );
      return false;
    }
    if (!(await fencedForJudgment(run, author)) || box.closed) {
      untrackLease(run.cwd, run.lease.issueId);
      dropJudgedRun(run);
      return false;
    }
    await setMetadata(
      run.cwd,
      run.issue.id,
      {
        workgraph_finalization_status: "running",
        workgraph_finalization_result: "",
        [WORKGRAPH_EXECUTOR_ID_KEY]: executor.executorId,
        [WORKGRAPH_ACTIVE_EXECUTION_ID_KEY]: "",
      },
      run.actor.bdActor,
    );
    if (box.closed) return false;
    run.executorId = executor.executorId;
    run.executionId = undefined;
    run.isolation = executor.isolation;
    run.supportsCancellation = executor.supportsCancellation;
    run.finalizationInFlight = true;
    const request: RunRequestT & { artifacts: string[] } = {
      ...newEnvelope(nowFn),
      executorId: executor.executorId,
      workflowRunId: run.workflowRunId,
      leaseEpoch: run.lease.epoch,
      issue: {
        id: run.issue.id,
        title: run.issue.title,
        workflowClass: effectiveWorkflowClass(run.issue),
        riskTier: effectiveRiskTier(run.issue),
        description: run.issue.description,
        acceptanceCriteria: run.issue.acceptance_criteria,
      },
      role: "finalizer",
      attempt: run.attempt,
      workspace: requestWorkspace(run),
      instructions: task.instructions,
      outputSchema: FinalizationResult,
      artifacts: author.artifacts,
      ...(run.plan ? { plan: run.plan } : {}),
    };
    const result = await requestRun(pi.events, request, {
      timeoutMs: config.acceptTimeoutMs,
      onInvalid,
    });
    if (result.kind === "accepted")
      run.executionId = result.message.executionId;
    if (box.closed) {
      publishCancel(run, "coordinator stopped during finalization acceptance");
      return false;
    }
    if (result.kind !== "accepted") {
      const stopped =
        result.kind === "rejected" ||
        (run.supportsCancellation &&
          (await cancelAndAwaitAck(run, config.acceptTimeoutMs)));
      if (!stopped) {
        untrackLease(run.cwd, run.lease.issueId);
        dropJudgedRun(run);
        return false;
      }
      run.finalizationInFlight = false;
      await escalateRun(
        run,
        "verifying",
        result.kind === "rejected"
          ? `finalization request rejected: ${result.message.reason}`
          : "finalization acceptance timed out",
        { workgraph_finalization_status: "blocked" },
      );
      return false;
    }
    await setMetadata(
      run.cwd,
      run.issue.id,
      { [WORKGRAPH_ACTIVE_EXECUTION_ID_KEY]: result.message.executionId },
      run.actor.bdActor,
    );
    emitActivity({
      kind: "transition",
      issueId: run.issue.id,
      phase: "verifying",
      workflowRunId: run.workflowRunId,
      summary: "running configured finalization",
    });
    const completion = await awaitCompletion(
      box,
      result.message.executionId,
      task.timeoutMs ?? 3_600_000,
    );
    if (!completion) {
      if (box.closed) return false;
      const stopped =
        run.supportsCancellation &&
        (await cancelAndAwaitAck(run, config.acceptTimeoutMs));
      if (!stopped) {
        untrackLease(run.cwd, run.lease.issueId);
        dropJudgedRun(run);
        return false; // Leave the lease to expire while an executor may still be mutating.
      }
      run.finalizationInFlight = false;
      await escalateRun(run, "verifying", "finalization timed out", {
        workgraph_finalization_status: "blocked",
      });
      return false;
    }
    run.finalizationInFlight = false;
    if (!(await fencedForJudgment(run, completion)) || box.closed) {
      untrackLease(run.cwd, run.lease.issueId);
      dropJudgedRun(run);
      return false;
    }
    if (completion.decisionQuestion) {
      await requestDecision(run, "verifying", completion);
      return false;
    }
    if (completion.outcome !== "success" || completion.executionError) {
      await escalateRun(
        run,
        "verifying",
        completionFailure("finalizer", completion),
        {
          workgraph_finalization_status: "failure",
        },
      );
      return false;
    }
    let receipt;
    try {
      receipt = parseFinalizationResult(
        (completion as RunCompletedT & { finalization?: unknown }).finalization,
      );
    } catch (error) {
      await escalateRun(
        run,
        "verifying",
        `${String(error)}${completion.evidence.length ? `; executor evidence: ${completion.evidence.join("; ").slice(0, 1500)}` : ""}`,
        {
          workgraph_finalization_status: "failure",
        },
      );
      return false;
    }
    await recordLeaseEvent(
      run.cwd,
      "finalization-completed",
      run.issue.id,
      {
        workflowRunId: run.workflowRunId,
        executionId: completion.executionId,
        outcome: completion.outcome,
        result: receipt,
        provenance: completion.provenance,
      },
      run.actor.bdActor,
    );
    const succeeded =
      completion.outcome === "success" && receipt.outcome === "success";
    const fields = {
      workgraph_finalization_status: succeeded ? "success" : "blocked",
      workgraph_finalization_result: JSON.stringify(receipt),
    };
    if (!succeeded) {
      await escalateRun(run, "verifying", receipt.summary, fields);
      return false;
    }
    await setMetadata(run.cwd, run.issue.id, fields, run.actor.bdActor);
    return true;
  }

  /**
   * The judgment gate's pass tail: judging → verifying → (finalization) →
   * accepted → closed, releasing the run. Reached two ways, which is why it
   * is its own function: the review gate passed (a clean verdict, advisory
   * findings only, or blocking findings under `observe`), or the review gate
   * is `off` and no review ran.
   *
   * `summary` lands in `workgraph_last_verdict` and the close audit: the
   * verdict summary, or `review off`. `executionId` is the execution the
   * close is attributed to: the review's, or the implementation's when
   * there was no review.
   *
   * `proof` carries what the close stamp needs: the `tree-binding` mode
   * (`off` writes no stamp — nothing was evaluated), the attempt, and
   * whether a verdict exists. The stamp is written once the issue is in
   * `verifying` and BEFORE finalization; a tree finalization changes is
   * recorded afterwards as an amendment and does not block.
   */
  async function acceptAndClose(
    run: CoordinatorRun,
    author: RunCompletedT,
    summary: string,
    executionId: string,
    proof: { bindingMode: GateModeT; attempt: number; reviewed: boolean },
  ): Promise<void> {
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
      if (proof.bindingMode !== "off") {
        const stamped = await stampAcceptance(
          run,
          proof.attempt,
          proof.reviewed ? { executionId, summary } : undefined,
        );
        if (!stamped) return; // escalated from verifying; nothing closes
      }
      const finalizes = heldConfig().finalization !== undefined;
      if (!(await finalize(run, author))) return;
      if (finalizes && proof.bindingMode !== "off") {
        await amendAfterFinalization(run);
      }
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
    // POST-COMMIT: the store close resolved above.
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
        executionId,
        verdictSummary: summary,
        actor: identitySnapshot(run.actor),
      },
      run.actor.bdActor,
    );
    dropJudgedRun(run);
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

    if (implementation.executionError) {
      await escalateRun(
        run,
        "judging",
        completionFailure("implementer", implementation),
      );
      return;
    }

    // The implementation result currently under judgment; a completed
    // revision replaces it (fresh artifacts + provenance).
    let author = implementation;
    // Shared by every reason a review round is thrown away: no parseable
    // verdict, a workspace that changed during the review, a workspace that
    // changed after the verdict. One bound, so the loop cannot spin.
    let reviewRetries = 0;
    // Executors whose reviews were rejected (non-independent) or who did
    // not accept — never re-selected for THIS run.
    const excluded = new Set<string>();
    // The result the `tree-binding` gate was last recorded for: one gate
    // record per result, not one per review round.
    let bindingRecordedFor: string | undefined;

    for (;;) {
      if (box.closed) return; // teardown
      // Throws on an invalid policy: judge() logs the message and the run
      // stays parked in judging under its lease. Work is never judged on a
      // policy that did not validate.
      const config = currentConfig();
      const issue = await show(run.cwd, run.lease.issueId);
      const policy = resolvePolicy(riskTierOf(issue), config.policy);
      const mode = policy.gates.review;
      const bindingMode = policy.gates["tree-binding"];
      const attempt = attemptOf(issue) ?? 1;

      // ---- the tree-binding gate. Decided here, under the validated
      // policy, not where the snapshot was taken. `off`: not evaluated, and
      // every record below simply names no tree. ----
      if (bindingMode !== "off") {
        if (run.resultTree === undefined && run.bindingReason === undefined) {
          // No snapshot was ever attempted for this result: a run adopted
          // from before tree binding, or a gate switched on after the
          // implementation completed. Take it now.
          const fields = bindResult(run, author, attempt, undefined, bindingMode);
          await setMetadata(
            run.cwd,
            run.lease.issueId,
            fields,
            run.actor.bdActor,
          );
        }
        const key = boundTreeOf(run) ?? `unknown: ${run.bindingReason ?? ""}`;
        if (bindingRecordedFor !== key) {
          bindingRecordedFor = key;
          const blocked = await evaluateBinding(run, bindingMode, attempt);
          if (blocked !== undefined) {
            await escalateRun(run, "judging", blocked);
            return;
          }
        }
      }
      // The tree every record of this round names; undefined = unbound.
      const tree = bindingMode !== "off" ? boundTreeOf(run) : undefined;

      /**
       * The last look before the close: has the workspace moved since the
       * result was snapshotted (or last compared)? `accept`: no. `again`:
       * yes — the run is bound to the new tree and goes round the loop, so
       * the new tree is reviewed. `stop`: escalated.
       */
      const beforeAcceptance = async (): Promise<"accept" | "again" | "stop"> => {
        await deps.beforeAcceptance?.({
          issueId: run.lease.issueId,
          ...(run.workspacePath !== undefined
            ? { workspacePath: run.workspacePath }
            : {}),
        });
        if (tree === undefined) return "accept";
        const moved = await recheckWorkspace(run, attempt, "after the verdict");
        if (moved === "same") return "accept";
        reviewRetries += 1;
        if (reviewRetries > MAX_REVIEW_RETRIES) {
          await escalateRun(
            run,
            "judging",
            `review retries exhausted (${MAX_REVIEW_RETRIES}): workspace changed after the verdict`,
          );
          return "stop";
        }
        return "again";
      };

      // ---- review gate off: not evaluated, so no reviewer is selected, no
      // verdict exists, and no gate result is recorded. The work is accepted
      // on the implementation alone — which also means an off tier never
      // parks for want of a reviewer-capable executor. ----
      if (mode === "off") {
        if (author.outcome !== "success") {
          // Everywhere else "any outcome is judged": the reviewer decides
          // what a reported failure means. With the gate off nobody does,
          // so only a reported success is accepted (the one-shot rule).
          await escalateRun(
            run,
            "judging",
            `${completionFailure("implementer", author)}; the review gate is off, so nothing judges a reported ${author.outcome}`,
          );
          return;
        }
        const next = await beforeAcceptance();
        if (next === "stop") return;
        if (next === "again") continue;
        await acceptAndClose(run, author, "review off", author.executionId, {
          bindingMode,
          attempt,
          reviewed: false,
        });
        return;
      }

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
          pinFor("reviewer"),
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
      if (box.closed) return;
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
        ...decisionAnswer(run.issue.metadata),
        workspace: requestWorkspace(run),
        // The required structured-verdict output schema (a TypeBox schema
        // IS a JSON schema object).
        outputSchema: Verdict,
        // v1-tolerated extra field: the artifacts under review (non-strict
        // schemas carry fields this version's envelope does not name).
        artifacts: [...author.artifacts],
        ...(run.plan !== undefined ? { plan: run.plan } : {}),
      };
      run.executorId = reviewer.executorId;
      run.executionId = undefined;
      run.isolation = reviewer.isolation;
      run.supportsCancellation = reviewer.supportsCancellation;
      run.reviewInFlight = true;
      const result = await requestRun(pi.events, reviewRequest, {
        timeoutMs: config.acceptTimeoutMs,
        onInvalid,
      });
      if (result.kind === "accepted")
        run.executionId = result.message.executionId;
      if (box.closed) {
        publishCancel(run, "coordinator stopped during review acceptance");
        return;
      }
      if (result.kind !== "accepted") {
        if (result.kind === "timeout") {
          const stopped =
            run.supportsCancellation &&
            (await cancelAndAwaitAck(run, config.acceptTimeoutMs));
          if (!stopped) {
            untrackLease(run.cwd, run.lease.issueId);
            dropJudgedRun(run);
            return;
          }
        }
        run.reviewInFlight = false;
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
      run.reviewInFlight = false;
      if (!(await fencedForJudgment(run, completion))) {
        // Our lease is gone — the whole run is stale; drop it.
        untrackLease(run.cwd, run.lease.issueId);
        dropJudgedRun(run);
        return;
      }

      if (completion.decisionQuestion) {
        await requestDecision(run, "judging", completion);
        return;
      }
      if (completion.outcome !== "success" || completion.executionError) {
        await escalateRun(
          run,
          "judging",
          completionFailure("reviewer", completion),
        );
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
            evidence: completion.evidence,
            retry: reviewRetries,
          },
          run.actor.bdActor,
        );
        if (reviewRetries > MAX_REVIEW_RETRIES) {
          await escalateRun(
            run,
            "judging",
            `review retries exhausted (${MAX_REVIEW_RETRIES}) without a parseable verdict: ${detail}${completion.evidence.length ? `; executor evidence: ${completion.evidence.join("; ").slice(0, 1500)}` : ""}`,
          );
          return;
        }
        continue; // bounded review retry — never counts against maxRevisions
      }

      // ---- the workspace must still be the tree that was reviewed ----
      // A verdict on a tree that is no longer in the workspace judges
      // nothing: discard it and review again. The reviewer is NOT excluded
      // (unlike a non-independent one) — with a single reviewer that would
      // escalate for want of a reviewer instead of reviewing the new tree.
      if (tree !== undefined) {
        const moved = await recheckWorkspace(run, attempt, "during review");
        if (moved !== "same") {
          reviewRetries += 1;
          const reason =
            moved === "changed"
              ? "workspace changed during review"
              : `workspace could not be read during review: ${run.bindingReason ?? "git failed"}`;
          await recordLeaseEvent(
            run.cwd,
            "review-rejected",
            run.lease.issueId,
            {
              workflowRunId: run.workflowRunId,
              executionId: completion.executionId,
              executorId: reviewer.executorId,
              reason,
              reviewedTree: tree,
              ...(run.resultTree !== undefined ? { tree: run.resultTree } : {}),
              retry: reviewRetries,
            },
            run.actor.bdActor,
          );
          if (reviewRetries > MAX_REVIEW_RETRIES) {
            await escalateRun(
              run,
              "judging",
              `review retries exhausted (${MAX_REVIEW_RETRIES}): ${reason}`,
            );
            return;
          }
          continue; // review the tree that is there now
        }
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
      // The verdict is the record the close rests on. If it cannot be
      // written the run escalates, under observe exactly as under enforce:
      // durability is a rule with no mode.
      try {
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
            ...(tree !== undefined ? { tree } : {}),
          },
          run.actor.bdActor,
        );
      } catch (e) {
        if (!(e instanceof VerdictWriteError)) throw e;
        await escalateRun(
          run,
          "judging",
          `verdict record could not be written: ${e.detail}`,
        );
        return;
      }
      const summary = verdictSummary(verdict);

      // ---- apply the review gate ----
      // Blocking findings are a violation; the gate's mode decides whether
      // that blocks (enforce) or is only recorded (observe). One gate record
      // per iteration, so a revision loop leaves a violation, then a pass.
      const blocking = blockingFindings(verdict);
      const gateResult: GateResult =
        blocking.length > 0 ? "violation" : "pass";
      const decision = decideGate("review", mode, gateResult);
      noteGate(run, "review", gateResult);
      await recordGate(
        run.cwd,
        run.lease.issueId,
        {
          gate: "review",
          mode,
          result: gateResult,
          ...decision,
          ...(gateResult === "violation" ? { reason: summary } : {}),
          ...(tree !== undefined ? { tree } : {}),
          workflowRunId: run.workflowRunId,
          attempt,
        },
        run.actor.bdActor,
      );
      if (decision.blocked) {
        // The tree when there is one: the fingerprint then follows file
        // content. The artifact list is the fallback when nothing is bound.
        const digest = tree ?? artifactDigest(author.artifacts);
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
          bindingMode,
        );
        if (revision === "aborted" || revision === "parked") return;
        author = revision;
        run.phase = "judging";
        continue; // re-review the revised implementation
      }

      // ---- gate passed (clean, advisory findings, or observe mode) ----
      const next = await beforeAcceptance();
      if (next === "stop") return;
      if (next === "again") continue; // the new tree goes back through review
      await acceptAndClose(run, author, summary, completion.executionId, {
        bindingMode,
        attempt,
        reviewed: true,
      });
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
    // Throws on an invalid policy, before anything is read or claimed: the
    // tick wrapper logs the message once and dispatch stays stopped.
    const config = currentConfig();

    // A run in flight (requested/accepted): capacity is 1 — supervise only.
    // Judged runs don't consume capacity; their leases are heartbeated until
    // shutdown.
    if (state.active) {
      const held = getHeldLease(ctx.cwd, state.active.lease.issueId);
      if (held) showLeaseStatus(ctx, held, nowFn, statusDetail(state.active));
      return;
    }

    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    try {
      await ensureWorkspace(ctx.cwd);
    } catch {
      // No workspace here — the coordinator stays inert.
      return;
    }

    // ARRAY LENGTH is the readiness signal, never exit codes. Fetch
    // UNBOUNDED (`-n 0`, the workgraph_ready pattern) and filter
    // client-side: lifecycle phase is metadata, which the store's ready query
    // cannot see — a capped probe would let a page of legacy issues ahead
    // in the store's ordering starve newly approved work indefinitely (the
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
      if (
        issue.metadata?.workgraph_halted === true ||
        issue.metadata?.workgraph_halted === "true" ||
        issue.metadata?.workgraph_decision_pending === true ||
        issue.metadata?.workgraph_decision_pending === "true"
      )
        return false;
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
    const haltGeneration = haltGenerations.get(candidate.id) ?? 0;
    const workflowClass = effectiveWorkflowClass(candidate);
    // An APPROVED plan skips the planner: the claim goes straight to an
    // implementer with the recorded plan attached. An approval flag whose
    // plan trail is unreadable re-plans rather than implementing blind.
    const approvedPlan =
      isLifecycleV1(candidate) && workflowClass === "planned" && planApprovedOf(candidate)
        ? await latestPlan(ctx.cwd, candidate.id)
        : undefined;
    const planFeedback = planFeedbackOf(candidate);
    let role: "planner" | "implementer" =
      isLifecycleV1(candidate) && workflowClass === "planned" && approvedPlan === undefined
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
          pinFor("implementer").executorId !== undefined;
        selected = canImplement
          ? selectExecutor(
              offers,
              // Neither planning nor implementation runs REQUIRE
              // isolation, which is what lets the in-session adapter
              // (isolation "none") stay eligible. What a non-isolated
              // executor may not do is start a second issue in a checkout
              // that holds one under judgment — the claim-wait rule below.
              { role: "planner", requiresIsolation: false },
              pinFor("planner"),
              inFlightCounts(),
            )
          : undefined;
        // A pin overrides registry filters, so re-check the required role.
        if (selected && !selected.roles.includes("planner"))
          selected = undefined;
        if (!selected) {
          logSkipOnce("planned work requires an eligible planner — no claim");
          return;
        }
      }
      if (role === "implementer") {
        selected = selectExecutor(
          offers,
          { role: "implementer", requiresIsolation: false },
          pinFor("implementer"),
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
    // CLAIM-WAIT. A non-isolated executor works in this checkout. If a run
    // whose work sits in this same checkout is under judgment, a new issue
    // here would change the very tree that run's verdict and stamp are
    // compared against — so the claim waits for it to resolve. Review of
    // in-session work is therefore one issue at a time (decision log). The
    // rule is per process, and isolated executors are never held by it.
    if (selected.isolation === "none") {
      const underReview = state.judged.find(
        (judged) =>
          judged.workspacePath !== undefined &&
          samePath(judged.workspacePath, ctx.cwd),
      );
      if (underReview) {
        logSkipOnce(`workspace under review: ${underReview.lease.issueId}`);
        return;
      }
    }

    // The phase the claim enters, and the phase every downstream write in
    // this tick expects. Kept in one binding so the claim transition, the
    // activity event, and the request role can never disagree.
    const claimPhase = role === "planner" ? "planning" : "implementing";

    // A FRESH workflow-run holder per claim attempt: reusing one across
    // attempts would read as a same-holder renewal (no epoch bump) and
    // silently skip re-fencing.
    const workflowRunId = ids.newWorkflowRun().id;
    const actor: LeaseActor = {
      holder: workflowRunId,
      bdActor: ids.initiator().id,
    };

    // Claim BY ID (the store's atomic claim-by-id): `ready --claim`
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
      if (e instanceof StoreError) {
        // the store's claim conflict surfaces its stderr verbatim ("already
        // claimed by ..."): a lost race, retried next tick. Any OTHER
        // StoreError (broken binary, workspace corruption) must not be
        // silently swallowed on every tick — log it once.
        if (!/already claimed/i.test(e.message)) {
          logSkipOnce(`claim failed for ${candidate.id}: ${e.message}`);
        }
        return;
      }
      throw e;
    }
    if (outcome.kind !== "acquired") return;
    // A halt may arrive while the store is still acquiring a lease, before there
    // is a tracked run for the synchronous control listener to detach.
    if (
      outcome.issue.metadata?.workgraph_halted === true ||
      outcome.issue.metadata?.workgraph_halted === "true" ||
      outcome.issue.metadata?.workgraph_decision_pending === true ||
      outcome.issue.metadata?.workgraph_decision_pending === "true" ||
      (haltGenerations.get(candidate.id) ?? 0) !== haltGeneration
    ) {
      try {
        await releaseLease(ctx.cwd, outcome.lease, actor);
      } catch (error) {
        if (!(error instanceof FencingError)) throw error;
      }
      return;
    }

    const run: CoordinatorRun = {
      cwd: ctx.cwd,
      issue: outcome.issue,
      lease: outcome.lease,
      actor,
      workflowRunId,
      executorId: selected.executorId,
      phase: "requested",
      role,
      ...(approvedPlan !== undefined ? { plan: renderPlan(approvedPlan) } : {}),
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
    // A human halt may have detached this run while the write was pending.
    if (state.active !== run) return;
    // POST-COMMIT: the ready→planning/implementing claim transition resolved.
    emitActivity({
      kind: "claim",
      issueId: run.issue.id,
      phase: claimPhase,
      workflowRunId,
      actor: actor.bdActor,
      summary: `claimed for ${selected.executorId} (${role})`,
    });

    // The shared-checkout base, taken just before the implementer request.
    // (A planner run takes it later, in dispatchImplementation.) A failed
    // snapshot never aborts the claim: the gate reports it at judgment.
    if (role === "implementer") {
      await recordSharedBase(run, selected.isolation, config);
      if (state.active !== run) return; // halted while the base was recorded
    }

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
      ...decisionAnswer(run.issue.metadata),
      workspace: requestWorkspace(run),
      ...(role === "planner" ? { outputSchema: Plan } : {}),
      ...(role === "planner" && planFeedback !== undefined ? { feedback: planFeedback } : {}),
      ...(run.plan !== undefined ? { plan: run.plan } : {}),
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
    // Never throws: a lease must keep renewing under an invalid policy.
    const config = heldConfig();
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
   *    active implementation, review, revision, or finalizer execution,
   *    including accepted work waiting in an executor queue:
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
    // Never throws: every held lease below must still be released.
    const config = heldConfig();
    const active = state.active;
    const runs = heldRuns();
    state.active = null;
    state.judged = [];
    if (ctx) clearLeaseStatus(ctx);
    for (const run of runs) {
      const held = getHeldLease(run.cwd, run.lease.issueId);
      if (!held) continue;
      // A recorded plan whose critique was still in flight: closing Pi must
      // not throw a finished plan away. Cancel the critic (best effort, not
      // awaited — it is read-only, so the park does not depend on it having
      // stopped) and park the plan as it would have parked without one. The
      // inbox closed above, so critiqueThenPark's wait has abandoned the run
      // to this branch. Any failure falls through to the ordinary
      // reset-and-release below: a re-plan, never a stranded lease.
      const pending = run.pendingPlan;
      if (pending) {
        try {
          const issue = await show(run.cwd, run.lease.issueId);
          const stillOurs =
            leaseEpochOf(issue) === run.lease.epoch &&
            leaseHolderOf(issue) === run.actor.holder;
          if (stillOurs && phaseOf(issue) === "planning") {
            // Only a CRITIC execution is canceled: until the run is rebound
            // it still carries the planner's finished execution id.
            if (
              run.executionId !== undefined &&
              run.executionId !== pending.completion.executionId
            )
              publishCancel(run, "coordinator stopped during plan critique");
            // After the cancel (which had to address the critic): the park
            // audit names the plan's source.
            restorePlannerBinding(run);
            const reason = "session ended during the critique";
            await recordLeaseEvent(
              run.cwd,
              "plan-critique-unavailable",
              run.lease.issueId,
              { workflowRunId: run.workflowRunId, reason },
              run.actor.bdActor,
            );
            // Performs the transition and the lease release itself.
            await parkForPlanReview(
              run,
              pending.completion,
              pending.plan,
              unavailableSummary(reason),
            );
            continue;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(
            `[pi-workgraph] coordinator teardown could not park the pending plan for ${run.lease.issueId}: ${msg}`,
          );
        }
      }
      // Cancel-first is scoped to runs with an IN-FLIGHT execution on an
      // ISOLATED executor: the active implementation run (accepted,
      // uncompleted) and a supervised run whose downstream execution is live
      // (bound at its run:accepted — the executor may still be mutating,
      // so a blind release would invite a concurrent publisher). Parked
      // judgment runs have no live sub-execution to cancel; in-session
      // executions die with this session by definition.
      const inFlight =
        (run.executionId !== undefined ||
          run.finalizationInFlight === true ||
          run.reviewInFlight === true) &&
        run.isolation !== "none" &&
        ((run === active && run.phase === "accepted") ||
          (run.phase === "revising" && run.revisionInFlight === true) ||
          run.finalizationInFlight === true ||
          run.reviewInFlight === true);
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
      // Redispatchability reset BEFORE the release (sweep.ts discipline):
      // releasing while `workgraph_phase` is still an in-flight work phase
      // strands the issue — claiming takes phase "ready" only, and with
      // the lease gone the TTL sweep can never reclaim it either. Judging
      // and verifying keep their phase: reconciliation resumes those from
      // the durable trail, and a reset would discard the review state.
      // Fenced by the same epoch+holder releaseLease is about to verify;
      // best-effort — a failed reset must never block the release.
      try {
        const issue = await show(run.cwd, run.lease.issueId);
        const phase = phaseOf(issue);
        const stillOurs =
          leaseEpochOf(issue) === run.lease.epoch &&
          leaseHolderOf(issue) === run.actor.holder;
        if (
          stillOurs &&
          (phase === "planning" ||
            phase === "implementing" ||
            phase === "revising")
        ) {
          await setMetadata(
            run.cwd,
            run.lease.issueId,
            {
              [WORKGRAPH_PHASE_KEY]: "ready",
              [WORKGRAPH_ACTIVE_EXECUTION_ID_KEY]: "",
            },
            run.actor.bdActor,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[pi-workgraph] coordinator teardown could not reset ${run.lease.issueId} for redispatch: ${msg}`,
        );
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
      try {
        await ensureWorkspace(ctx.cwd);
      } catch {
        return report; // no workspace here — nothing persisted to recover
      }
      const config = currentConfig();
      const nowMs = nowFn();
      const issues = await listRunHeldInProgress(
        ctx.cwd,
        nowMs,
        config.leaseTtlMs,
      );
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
        let cur: WorkIssue;
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
        const offer =
          executorId !== undefined ? offersById.get(executorId) : undefined;
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
                reason:
                  "no recorded execution (crash between claim and accept)",
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
          // Workspace path, base and result tree, rebuilt from the trail:
          // the claim-wait rule needs the path, the gate needs the trees.
          applyBinding(run, await reconstructBinding(ctx.cwd, cur));
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
          if (author) {
            // The workspace may have been edited while nobody was watching.
            // If it no longer matches the recorded result tree, bind the run
            // to what is there now; the resumed loop then reviews THAT. (A
            // run with no recorded tree is snapshotted by the loop itself.)
            if (bindingModeOf(cur, config) !== "off") {
              await recheckWorkspace(
                run,
                run.attempt,
                "while the coordinator was down",
              );
            }
            resumed.push(judge(run, author));
          }
        } else if (phase === "revising" || phase === "verifying") {
          // Mid-gate states whose in-flight context (a revision execution,
          // a verification pass) cannot be rebuilt from memory: park with
          // the heartbeat so the lease survives; the gate resolves via
          // human override / re-approve or a later phase's reconnection.
          const run = makeRun(phase);
          // Parked, but still occupying its workspace: the claim-wait rule
          // reads the path from here.
          applyBinding(run, await reconstructBinding(ctx.cwd, cur));
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
          if (
            phase === "verifying" &&
            cur.metadata?.workgraph_finalization_status === "running"
          )
            run.finalizationInFlight = true;
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
    // Never throws: under an invalid policy the timer still starts, so each
    // tick reports the bad key and dispatch resumes once it is fixed.
    const config = heldConfig();
    state.timer = setInterval(() => void tick(ctx), config.pollMs);
    // Reconciliation BEFORE the first coordination pass: the `reconciling`
    // latch is set synchronously inside reconcile(), so a settle-tick (or
    // the poll timer) arriving mid-recovery no-ops until adoption is done.
    // Cost for the common (empty) case: one store list. The report is for
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
    current: () =>
      state.active ?? state.judged[state.judged.length - 1] ?? null,
    timersActive: () => ({
      poll: state.timer !== null,
      heartbeat: state.hb !== null,
    }),
  };
}
