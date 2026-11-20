/**
 * The durable lifecycle layer: typed readers for every `workgraph_*`
 * metadata key plus the single guarded `transition()` every phase change
 * goes through.
 *
 * The store's native statuses stay simple; lifecycle phase is workgraph
 * semantics stored in namespaced metadata (README "Durable lifecycle
 * metadata"). Readers normalize like the lease accessors do — values round-trip as
 * written (a stamped `"1"` or a created `1`), so `workgraph_attempt` and
 * `workgraph_lifecycle_version` are read through `Number(...)`; never trust
 * the raw shape.
 *
 * `transition()` mirrors the lease layer's read/guard/write discipline:
 * re-read the issue, compare the expected phase (compare-and-set against
 * concurrent writers — the metadata merge is last-writer-wins, so like the lease epoch this is
 * best-effort: a racing writer between read and write still lands
 * last-writer-wins and the loser is detected on the NEXT re-read), consult
 * the LEGAL edge table, and write phase + companion fields in ONE
 * `setMetadata` call — the store merges per-key, so a single call is the atomicity
 * unit and two calls would open a torn-state window.
 *
 * Human-override, lease-lost, and escalation edges are deliberately NOT in
 * LEGAL: they are coordinator/override-tool recovery paths with their own
 * audit ({@link escalate} guards escalation from any ACTIVE phase; the
 * override tool bypasses phases entirely, always audited).
 */
import { setMetadata, show, type MetadataValue } from "./store.ts";
import { GUARD_GATES, type GuardGate } from "./policy.ts";
import type { WorkIssue, WorkflowClassT, WorkgraphPhase } from "./types.ts";
import {
  DEFAULT_WORKFLOW_CLASS,
  WORKGRAPH_ACCEPTED_TREE_KEY,
  WORKGRAPH_ACTIVE_EXECUTION_ID_KEY,
  WORKGRAPH_ATTEMPT_KEY,
  WORKGRAPH_BAR_DIGEST_KEY,
  WORKGRAPH_BASE_COMMIT_KEY,
  WORKGRAPH_BASE_TREE_KEY,
  WORKGRAPH_CHECK_KEY,
  WORKGRAPH_CHECK_WAIVER_KEY,
  WORKGRAPH_DECISION_GATE_KEY,
  WORKGRAPH_EXECUTOR_ID_KEY,
  WORKGRAPH_FAILURE_FINGERPRINT_KEY,
  WORKGRAPH_FINALIZED_TREE_KEY,
  WORKGRAPH_GUARD_ALLOWED_BY_KEY,
  WORKGRAPH_GUARD_ALLOWED_KEY,
  WORKGRAPH_GUARD_ROUNDS_KEY,
  WORKGRAPH_OUTCOME_DEADLINE_KEY,
  WORKGRAPH_OUTCOME_EXECUTION_ID_KEY,
  WORKGRAPH_OUTCOME_KEY,
  WORKGRAPH_OUTCOME_STATUS_KEY,
  WORKGRAPH_LAST_VERDICT_KEY,
  WORKGRAPH_LIFECYCLE_VERSION_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_PLAN_APPROVED_KEY,
  WORKGRAPH_PLAN_FEEDBACK_KEY,
  WORKGRAPH_RESULT_COMMIT_KEY,
  WORKGRAPH_RESULT_TREE_KEY,
  WORKGRAPH_RISK_TIER_KEY,
  WORKGRAPH_WORKFLOW_CLASS_KEY,
  WORKGRAPH_WORKFLOW_RUN_ID_KEY,
  WORKGRAPH_WORKSPACE_PATH_KEY,
} from "./types.ts";

export type { WorkgraphPhase } from "./types.ts";

const PHASES: readonly WorkgraphPhase[] = [
  "draft",
  "ready",
  "planning",
  "plan_review",
  "implementing",
  "judging",
  "revising",
  "verifying",
  "accepted",
  "escalated",
];

/**
 * The legal phase edges (README "State transitions", edge-for-edge).
 * `accepted` and `escalated` are terminal here: accepted work leaves via
 * the store (a status change, not a phase change) and escalated work via
 * human override / re-approve.
 */
export const LEGAL: Record<WorkgraphPhase, readonly WorkgraphPhase[]> = {
  draft: ["ready"],
  // Both claim edges are legal by design: `planning` when some executor
  // offered the planner role, `implementing` when none did. Planning is a
  // TIER, not a mandatory stage — making it mandatory would strand every
  // graph whose executors implement but do not plan.
  ready: ["planning", "implementing"],
  planning: ["plan_review", "implementing", "escalated"],
  // The human gate: a recorded plan waits here, lease released, until
  // workgraph_approve_plan sends it back to ready (approved → implement;
  // rejected → re-plan with feedback).
  plan_review: ["ready"],
  // One-shot success skips judgment but still passes through the explicit
  // verification/acceptance tail before close.
  implementing: ["judging", "verifying", "revising", "escalated"],
  judging: ["revising", "verifying"],
  revising: ["revising", "judging"], // new execution accepted; implementation completed
  verifying: ["accepted", "revising", "escalated"],
  accepted: [], // → store close, not a phase change
  escalated: [], // human override / re-approve path
};

/**
 * Initialization edges for LEGACY issues (no phase at all): approval
 * (`workgraph_approve`) enters at `ready`; a compat-mode coordinator claim
 * enters at `implementing`. Both stamp `workgraph_lifecycle_version: 1`
 * per issue, without a bulk rewrite.
 */
const LEGACY_ENTRY: readonly WorkgraphPhase[] = ["ready", "implementing"];

/** Phases with a live workflow attached (escalation is guarded to these). */
const ACTIVE_PHASES: readonly WorkgraphPhase[] = [
  "planning",
  "implementing",
  "judging",
  "revising",
  "verifying",
];

/** Whether a phase has a live workflow attached (planning/implementing/
 *  judging/revising/verifying) — the sweep's reclaim resets exactly these
 *  back to `ready` so a reclaimed issue is redispatchable (phase 4). A
 *  planner run holds a lease like any other, so a crashed planner must
 *  reclaim on the same path; leaving `planning` out would strand the issue
 *  in a phase nothing sweeps. */
export function isActivePhase(
  phase: WorkgraphPhase | undefined,
): phase is "planning" | "implementing" | "judging" | "revising" | "verifying" {
  return phase !== undefined && ACTIVE_PHASES.includes(phase);
}

/**
 * Thrown when a transition is illegal or lost a compare-and-set race. The
 * losing writer must re-read before deciding anything else; terminal
 * handlers stay idempotent (the coordinator's latch pattern).
 */
export class LifecycleError extends Error {
  readonly issueId: string;
  readonly expected: WorkgraphPhase | undefined;
  readonly actual: WorkgraphPhase | undefined;
  readonly to: WorkgraphPhase;

  constructor(
    issueId: string,
    expected: WorkgraphPhase | undefined,
    actual: WorkgraphPhase | undefined,
    to: WorkgraphPhase,
    detail: string,
  ) {
    super(
      `Illegal lifecycle transition on ${issueId}: ${detail} ` +
        `(expected phase ${expected ?? "<none/legacy>"}, found ${actual ?? "<none/legacy>"}, target ${to})`,
    );
    this.name = "LifecycleError";
    this.issueId = issueId;
    this.expected = expected;
    this.actual = actual;
    this.to = to;
  }
}

// ---------------------------------------------------------------------------
// Metadata readers — normalize, never trust (the lease-accessor pattern).
// ---------------------------------------------------------------------------

/** The issue's lifecycle phase; undefined = legacy (no phase metadata). */
export function phaseOf(issue: WorkIssue): WorkgraphPhase | undefined {
  const raw = issue.metadata?.[WORKGRAPH_PHASE_KEY];
  return typeof raw === "string" && (PHASES as readonly string[]).includes(raw)
    ? (raw as WorkgraphPhase)
    : undefined;
}

/** The issue's lifecycle schema version; undefined = legacy. */
export function lifecycleVersionOf(issue: WorkIssue): number | undefined {
  const raw = issue.metadata?.[WORKGRAPH_LIFECYCLE_VERSION_KEY];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Whether the issue is under lifecycle-v1 management (non-legacy). */
export function isLifecycleV1(issue: WorkIssue): boolean {
  return lifecycleVersionOf(issue) === 1;
}

/** Current implementation/revision attempt number, if any. */
export function attemptOf(issue: WorkIssue): number | undefined {
  const raw = issue.metadata?.[WORKGRAPH_ATTEMPT_KEY];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The issue's judgment risk tier, if stamped. */
export function riskTierOf(issue: WorkIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_RISK_TIER_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The issue's execution topology; old/unclassified work defaults to reviewed. */
export function workflowClassOf(issue: WorkIssue): WorkflowClassT {
  const raw = issue.metadata?.[WORKGRAPH_WORKFLOW_CLASS_KEY];
  return raw === "oneshot" || raw === "reviewed" || raw === "planned"
    ? raw
    : DEFAULT_WORKFLOW_CLASS;
}

/** The stored failure fingerprint from the last blocking verdict, if any. */
export function failureFingerprintOf(issue: WorkIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_FAILURE_FINGERPRINT_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The compact last-verdict summary, if any. */
export function lastVerdictOf(issue: WorkIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_LAST_VERDICT_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The persisted workflow-run id, if any. */
export function workflowRunIdOf(issue: WorkIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_WORKFLOW_RUN_ID_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The persisted executor id the run was delegated to, if any (phase 4:
 *  recovery is the first reader — the write landed at claim in phase 2). */
export function executorIdOf(issue: WorkIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_EXECUTOR_ID_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The persisted executor-side execution id, if any. Empty string reads as
 *  undefined — the sweep CLEARS this key by writing "", so one branch covers
 *  both cleared and never-written. */
export function activeExecutionIdOf(issue: WorkIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_ACTIVE_EXECUTION_ID_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** Whether a human approved the recorded plan (`workgraph_approve_plan`). */
export function planApprovedOf(issue: WorkIssue): boolean {
  const raw = issue.metadata?.[WORKGRAPH_PLAN_APPROVED_KEY];
  return raw === true || raw === "true";
}

/** Feedback from a rejected plan, for the next planner run; empty = none. */
export function planFeedbackOf(issue: WorkIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_PLAN_FEEDBACK_KEY];
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

/** A tree-binding key's value; "" (cleared) and non-strings read as unset. */
function bindingValue(issue: WorkIssue, key: string): string | undefined {
  const raw = issue.metadata?.[key];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The directory the issue's work was last reported in, if any. */
export function workspacePathOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_WORKSPACE_PATH_KEY);
}

/** The commit the work in {@link workspacePathOf} started from, if recorded. */
export function baseCommitOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_BASE_COMMIT_KEY);
}

/** The tree the work in {@link workspacePathOf} started from, if recorded. */
export function baseTreeOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_BASE_TREE_KEY);
}

/** The anchored snapshot commit of the latest result, if recorded. */
export function resultCommitOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_RESULT_COMMIT_KEY);
}

/** The tree of the latest result, if recorded. */
export function resultTreeOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_RESULT_TREE_KEY);
}

/** The tree the close stamp accepted, if any. */
export function acceptedTreeOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_ACCEPTED_TREE_KEY);
}

/** The tree after finalization, set only when finalization changed it. */
export function finalizedTreeOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_FINALIZED_TREE_KEY);
}

/** The issue's own check command, trimmed; "" and whitespace read as unset. */
export function checkOf(issue: WorkIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_CHECK_KEY];
  // A command is stored as a string, but a hand-written `true` may have
  // landed as a boolean: it is still the shell builtin.
  const text = typeof raw === "boolean" ? String(raw) : raw;
  return typeof text === "string" && text.trim() !== "" ? text.trim() : undefined;
}

/** Why no check applies to the issue, trimmed; "" and whitespace read as unset. */
export function checkWaiverOf(issue: WorkIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_CHECK_WAIVER_KEY];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/** The digest of the bar frozen at the latest claim, if recorded. */
export function barDigestOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_BAR_DIGEST_KEY);
}

/**
 * A guard key's value as a list of guard gates, each once, in the order
 * written. "" (cleared), a non-string and any name that is not a guard gate
 * read as nothing: a hand-written `review` in the list allows no gate.
 */
function guardList(issue: WorkIssue, key: string): GuardGate[] {
  const raw = issue.metadata?.[key];
  if (typeof raw !== "string") return [];
  const gates: GuardGate[] = [];
  for (const part of raw.split(",")) {
    const gate = GUARD_GATES.find((candidate) => candidate === part.trim());
    if (gate !== undefined && !gates.includes(gate)) gates.push(gate);
  }
  return gates;
}

/** The guards whose one revision round this issue has already spent. */
export function guardRoundsOf(issue: WorkIssue): GuardGate[] {
  return guardList(issue, WORKGRAPH_GUARD_ROUNDS_KEY);
}

/** The guards a human allowed for this issue. */
export function guardAllowedOf(issue: WorkIssue): GuardGate[] {
  return guardList(issue, WORKGRAPH_GUARD_ALLOWED_KEY);
}

/** Who gave the latest guard allowance, if recorded. */
export function guardAllowedByOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_GUARD_ALLOWED_BY_KEY);
}

/** The guards the pending decision is about; empty for an executor's own question. */
export function decisionGatesOf(issue: WorkIssue): GuardGate[] {
  return guardList(issue, WORKGRAPH_DECISION_GATE_KEY);
}

/** The latest recorded outcome in its compact form (`needed_fixes:2`), if any. */
export function outcomeOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_OUTCOME_KEY);
}

/** Where the issue's outcome stands: an outcome step is expected to report, or an outcome exists. */
export function outcomeStatusOf(
  issue: WorkIssue,
): "pending" | "recorded" | undefined {
  const raw = bindingValue(issue, WORKGRAPH_OUTCOME_STATUS_KEY);
  return raw === "pending" || raw === "recorded" ? raw : undefined;
}

/** The execution of the outcome step launched for the latest close, if recorded. */
export function outcomeExecutionIdOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_OUTCOME_EXECUTION_ID_KEY);
}

/** The ISO time a pending outcome stops being waited for, if recorded. */
export function outcomeDeadlineOf(issue: WorkIssue): string | undefined {
  return bindingValue(issue, WORKGRAPH_OUTCOME_DEADLINE_KEY);
}

// ---------------------------------------------------------------------------
// Guarded transitions
// ---------------------------------------------------------------------------

export interface TransitionOptions {
  /** Companion metadata written in the SAME setMetadata call as the phase. */
  fields?: Record<string, MetadataValue>;
  /** the store actor attribution for the write. */
  actor?: string;
}

/**
 * Move `issueId` from phase `expect` to phase `to`. Re-reads the issue,
 * verifies the current phase equals `expect` (compare-and-set discipline —
 * a concurrent double-transition loses and throws {@link LifecycleError}),
 * verifies the edge is legal, then writes phase + `fields` in one
 * `setMetadata` call.
 *
 * `expect: undefined` is the legacy initialization entry: only approval
 * (→ `ready`) and a compat claim (→ `implementing`) are legal from an
 * unphased issue. Transitions out of `draft`/`ready`/legacy stamp
 * `workgraph_lifecycle_version: 1` when it is absent.
 *
 * The compatibility contract this stamping path carries (phase 6, pinned by
 * `test/migration.test.ts`):
 * - NON-DESTRUCTIVE — the single `setMetadata` call merges PER-KEY
 *   server-side, so every pre-existing metadata key (lease keys and foreign
 *   tooling keys) survives byte-for-byte; only `workgraph_*` keys are added.
 * - PER-ISSUE AT TOUCH TIME — there is deliberately no bulk rewrite; an
 *   interrupted process leaves untouched issues unchanged.
 * - IDEMPOTENT AS CAS-SAFE, not silently repeatable — re-running the
 *   initialization entry on an already-stamped issue throws
 *   {@link LifecycleError} (the phase changed underneath `expect:
 *   undefined`), never a second stamp.
 *
 * Returns the re-read issue as observed BEFORE the write.
 */
export async function transition(
  cwd: string,
  issueId: string,
  expect: WorkgraphPhase | undefined,
  to: WorkgraphPhase,
  opts: TransitionOptions = {},
): Promise<WorkIssue> {
  const cur = await show(cwd, issueId);
  const actual = phaseOf(cur);
  if (actual !== expect) {
    throw new LifecycleError(
      issueId,
      expect,
      actual,
      to,
      "phase changed underneath this transition (concurrent writer)",
    );
  }
  const legal =
    expect === undefined ? LEGACY_ENTRY.includes(to) : LEGAL[expect].includes(to);
  if (!legal) {
    throw new LifecycleError(
      issueId,
      expect,
      actual,
      to,
      `no legal edge ${expect ?? "<legacy>"} → ${to}`,
    );
  }

  const kv: Record<string, MetadataValue> = {
    ...opts.fields,
    [WORKGRAPH_PHASE_KEY]: to,
  };
  const stampsV1 =
    !isLifecycleV1(cur) &&
    (expect === undefined || expect === "draft" || expect === "ready");
  if (stampsV1) kv[WORKGRAPH_LIFECYCLE_VERSION_KEY] = "1";

  await setMetadata(cwd, issueId, kv, opts.actor);
  return cur;
}

/**
 * The escalation edge: any ACTIVE phase → `escalated`, with the same
 * compare-and-set discipline as {@link transition}. Kept separate because
 * escalation is a coordinator-owned recovery edge (fingerprint repeat,
 * bounds exhausted, no independent reviewer), not part of the LEGAL happy
 * path — like human override and lease loss, it carries its own audit.
 * The caller flips the store status to `blocked` (removing the issue from the
 * ready pool) and records the audit event; escalation is recoverable via
 * re-approve.
 */
export async function escalate(
  cwd: string,
  issueId: string,
  expect: WorkgraphPhase,
  opts: TransitionOptions = {},
): Promise<void> {
  if (!ACTIVE_PHASES.includes(expect)) {
    throw new LifecycleError(
      issueId,
      expect,
      expect,
      "escalated",
      `only active phases escalate (${ACTIVE_PHASES.join(", ")})`,
    );
  }
  const cur = await show(cwd, issueId);
  const actual = phaseOf(cur);
  if (actual !== expect) {
    throw new LifecycleError(
      issueId,
      expect,
      actual,
      "escalated",
      "phase changed underneath this escalation (concurrent writer)",
    );
  }
  await setMetadata(
    cwd,
    issueId,
    { ...opts.fields, [WORKGRAPH_PHASE_KEY]: "escalated" },
    opts.actor,
  );
}

/**
 * The re-approve recovery edge: `escalated` → `ready`, with the same
 * compare-and-set discipline as {@link transition}. Like {@link escalate},
 * this is deliberately NOT a LEGAL edge: it is the human recovery path the
 * failure-modes table documents ("escalation is recoverable via
 * re-approve"), owned by `workgraph_approve` with its own audit. The caller
 * reopens the store status — escalation parked the issue as `blocked`, and a
 * blocked issue never re-enters the ready pool.
 */
export async function reapprove(
  cwd: string,
  issueId: string,
  opts: TransitionOptions = {},
): Promise<void> {
  const cur = await show(cwd, issueId);
  const actual = phaseOf(cur);
  if (actual !== "escalated") {
    throw new LifecycleError(
      issueId,
      "escalated",
      actual,
      "ready",
      "re-approve recovers only escalated issues",
    );
  }
  await setMetadata(
    cwd,
    issueId,
    { ...opts.fields, [WORKGRAPH_PHASE_KEY]: "ready" },
    opts.actor,
  );
}
