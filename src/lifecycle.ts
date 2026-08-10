/**
 * The durable lifecycle layer: typed readers for every `workgraph_*`
 * metadata key plus the single guarded `transition()` every phase change
 * goes through.
 *
 * Beads' native statuses stay simple; lifecycle phase is workgraph
 * semantics stored in namespaced metadata (README "Durable lifecycle
 * metadata"). Readers normalize like the lease accessors do — bd stores
 * numeric-looking values as JSON numbers, so `workgraph_attempt` and
 * `workgraph_lifecycle_version` read back typed; never trust the inference.
 *
 * `transition()` mirrors the lease layer's read/guard/write discipline:
 * re-read the issue, compare the expected phase (compare-and-set against
 * concurrent writers — bd has no CAS, so like the lease epoch this is
 * best-effort: a racing writer between read and write still lands
 * last-writer-wins and the loser is detected on the NEXT re-read), consult
 * the LEGAL edge table, and write phase + companion fields in ONE
 * `setMetadata` call — bd merges per-key, so a single call is the atomicity
 * unit and two calls would open a torn-state window.
 *
 * Human-override, lease-lost, and escalation edges are deliberately NOT in
 * LEGAL: they are coordinator/override-tool recovery paths with their own
 * audit ({@link escalate} guards escalation from any ACTIVE phase; the
 * override tool bypasses phases entirely, always audited).
 */
import { setMetadata, show } from "./bd.ts";
import type { BeadsIssue, WorkgraphPhase } from "./types.ts";
import {
  WORKGRAPH_ACTIVE_EXECUTION_ID_KEY,
  WORKGRAPH_ATTEMPT_KEY,
  WORKGRAPH_EXECUTOR_ID_KEY,
  WORKGRAPH_FAILURE_FINGERPRINT_KEY,
  WORKGRAPH_LAST_VERDICT_KEY,
  WORKGRAPH_LIFECYCLE_VERSION_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_RISK_TIER_KEY,
  WORKGRAPH_WORKFLOW_RUN_ID_KEY,
} from "./types.ts";

export type { WorkgraphPhase } from "./types.ts";

const PHASES: readonly WorkgraphPhase[] = [
  "draft",
  "ready",
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
 * `bd close` (a status change, not a phase change) and escalated work via
 * human override / re-approve.
 */
export const LEGAL: Record<WorkgraphPhase, readonly WorkgraphPhase[]> = {
  draft: ["ready"],
  ready: ["implementing"],
  implementing: ["judging", "revising", "escalated"],
  judging: ["revising", "verifying"],
  revising: ["revising", "judging"], // new execution accepted; implementation completed
  verifying: ["accepted", "revising", "escalated"],
  accepted: [], // → bd close, not a phase change
  escalated: [], // human override / re-approve path
};

/**
 * Migration entry edges for LEGACY issues (no phase at all): approval
 * (`workgraph_approve`) enters at `ready`; a compat-mode coordinator claim
 * enters at `implementing`. Both stamp `workgraph_lifecycle_version: 1` —
 * lazy, per-issue, never a bulk rewrite.
 */
const LEGACY_ENTRY: readonly WorkgraphPhase[] = ["ready", "implementing"];

/** Phases with a live workflow attached (escalation is guarded to these). */
const ACTIVE_PHASES: readonly WorkgraphPhase[] = [
  "implementing",
  "judging",
  "revising",
  "verifying",
];

/** Whether a phase has a live workflow attached (implementing/judging/
 *  revising/verifying) — the sweep's reclaim resets exactly these back to
 *  `ready` so a reclaimed issue is redispatchable (phase 4). */
export function isActivePhase(
  phase: WorkgraphPhase | undefined,
): phase is "implementing" | "judging" | "revising" | "verifying" {
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
export function phaseOf(issue: BeadsIssue): WorkgraphPhase | undefined {
  const raw = issue.metadata?.[WORKGRAPH_PHASE_KEY];
  return typeof raw === "string" && (PHASES as readonly string[]).includes(raw)
    ? (raw as WorkgraphPhase)
    : undefined;
}

/** The issue's lifecycle schema version; undefined = legacy. */
export function lifecycleVersionOf(issue: BeadsIssue): number | undefined {
  const raw = issue.metadata?.[WORKGRAPH_LIFECYCLE_VERSION_KEY];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Whether the issue is under lifecycle-v1 management (non-legacy). */
export function isLifecycleV1(issue: BeadsIssue): boolean {
  return lifecycleVersionOf(issue) === 1;
}

/** Current implementation/revision attempt number, if any. */
export function attemptOf(issue: BeadsIssue): number | undefined {
  const raw = issue.metadata?.[WORKGRAPH_ATTEMPT_KEY];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The issue's judgment risk tier, if stamped. */
export function riskTierOf(issue: BeadsIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_RISK_TIER_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The stored failure fingerprint from the last blocking verdict, if any. */
export function failureFingerprintOf(issue: BeadsIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_FAILURE_FINGERPRINT_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The compact last-verdict summary, if any. */
export function lastVerdictOf(issue: BeadsIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_LAST_VERDICT_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The persisted workflow-run id, if any. */
export function workflowRunIdOf(issue: BeadsIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_WORKFLOW_RUN_ID_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The persisted executor id the run was delegated to, if any (phase 4:
 *  recovery is the first reader — the write landed at claim in phase 2). */
export function executorIdOf(issue: BeadsIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_EXECUTOR_ID_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The persisted executor-side execution id, if any. Empty string reads as
 *  undefined — the sweep CLEARS this key by writing "" (bd's setMetadata
 *  cannot unset), so one branch covers both cleared and never-written. */
export function activeExecutionIdOf(issue: BeadsIssue): string | undefined {
  const raw = issue.metadata?.[WORKGRAPH_ACTIVE_EXECUTION_ID_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Guarded transitions
// ---------------------------------------------------------------------------

export interface TransitionOptions {
  /** Companion metadata written in the SAME setMetadata call as the phase. */
  fields?: Record<string, string>;
  /** bd `--actor` attribution for the write. */
  actor?: string;
}

/**
 * Move `issueId` from phase `expect` to phase `to`. Re-reads the issue,
 * verifies the current phase equals `expect` (compare-and-set discipline —
 * a concurrent double-transition loses and throws {@link LifecycleError}),
 * verifies the edge is legal, then writes phase + `fields` in one
 * `setMetadata` call.
 *
 * `expect: undefined` is the legacy/migration entry: only approval
 * (→ `ready`) and a compat claim (→ `implementing`) are legal from an
 * unphased issue. Transitions out of `draft`/`ready`/legacy stamp
 * `workgraph_lifecycle_version: 1` when it is absent (lazy migration).
 *
 * The migration contract this stamping path carries (phase 6, pinned by
 * `test/migration.test.ts`):
 * - NON-DESTRUCTIVE — the single `setMetadata` call merges PER-KEY
 *   server-side, so every pre-existing metadata key (v0.1 lease keys,
 *   foreign tooling keys) survives byte-for-byte; only `workgraph_*` keys
 *   are added.
 * - PER-ISSUE AT TOUCH TIME — there is deliberately no bulk-migration
 *   path anywhere; an interrupted process leaves no half-migrated graph.
 * - IDEMPOTENT AS CAS-SAFE, not silently repeatable — re-running the
 *   migration entry on an already-stamped issue throws
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
): Promise<BeadsIssue> {
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

  const kv: Record<string, string> = {
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
 * The caller flips the bd status to `blocked` (removing the issue from the
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
 * reopens the bd status — escalation parked the issue as `blocked`, and a
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
