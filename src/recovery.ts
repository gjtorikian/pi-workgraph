/**
 * Startup reconciliation (phase 4): the read side of phase 2's
 * persist-intent-before-emit. A coordinator that dies mid-run leaves its
 * truth in the store — `workgraph_workflow_run_id` + `workgraph_executor_id`
 * written at claim, `workgraph_active_execution_id` at accept, the lease
 * trio on every renewal, and the `run-completed` audit comment at each
 * fenced completion. On restart the coordinator enumerates that state,
 * asks each recorded executor what became of its execution, and converges:
 *
 *   expired lease  → reclaim under a new epoch BEFORE any redispatch,
 *                    publishing best-effort `run:cancel` for the old
 *                    execution (the sweep's reclaimAndLeaveReady);
 *   live + active  → re-adopt: track the lease, resume the heartbeat;
 *   live + terminal→ the embedded completion flows through the NORMAL
 *                    fenced completion handler — one code path, tested once;
 *   missing / unreachable / silent → abandon: never renew, let the TTL
 *                    sweep reclaim. A timeout is NOT evidence of life —
 *                    never infer life (or success) from silence.
 *
 * This module owns the pure/protocol pieces — enumeration, partition, the
 * correlated status exchange, and audit-trail reconstruction of a judging
 * run's author completion, of its tree binding (workspace path, base
 * and result tree) and of the bar it was claimed under. The ADOPTION itself (coordinator state, inboxes,
 * heartbeats, the judgment loop) lives in coordinator.ts's `reconcile()`,
 * which composes these. Everything here is fenced + idempotent: a
 * reconciliation that crashes midway is safe to re-run — unprocessed issues
 * simply wait for the next start or the sweep.
 *
 * OUTCOME STEPS are the one thing recovered here that holds no lease. A step
 * launched after a close (`src/outcome.ts`) is recorded on the CLOSED issue
 * as `workgraph_outcome_status: "pending"` with its execution id and a
 * deadline. {@link pendingOutcomes} reads those back and splits them on the
 * deadline: one still inside it is re-tracked and left alone, since its
 * child may be running and can still report through the outcome tool; one
 * past it is the coordinator's to record as `unknown`.
 */
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { AUDIT_PREFIX } from "./audit.ts";
import { parseBar, type Bar } from "./check.ts";
import { listComments, listInProgressUpdatedBefore } from "./store.ts";
import { listPendingOutcomes, outcomeDeadlinePassed } from "./outcome.ts";
import { leaseExpiresAtOf, leaseHolderOf, rfc3339 } from "./lease.ts";
import {
  baseCommitOf,
  baseTreeOf,
  outcomeDeadlineOf,
  outcomeExecutionIdOf,
  resultCommitOf,
  resultTreeOf,
  workflowRunIdOf,
  workspacePathOf,
} from "./lifecycle.ts";
import {
  CH,
  newEnvelope,
  parseMessage,
  ProtocolError,
  RunStatus,
  type RunCompletedT,
  type RunOutcomeT,
  type RunStatusRequestT,
  type RunStatusT,
} from "./protocol.ts";
import type { WorkIssue, Lease } from "./types.ts";
import {
  WORKFLOW_RUN_PREFIX,
  WORKGRAPH_AUTHOR_PROVENANCE_KEY,
} from "./types.ts";

/** Called (never awaited) when an incoming payload fails validation. */
type OnInvalidMessage = (channel: string, error: ProtocolError) => void;

/** What one reconciliation pass did, by issue id (logging + tests). */
export interface ReconcileReport {
  /** Runs re-adopted (heartbeat resumed / judgment resumed or parked). */
  readopted: string[];
  /** Terminal-during-downtime results applied through the normal handler. */
  completed: string[];
  /** Runs left un-renewed for the TTL sweep (missing/unreachable/silent/
   *  no recorded execution/hijacked). */
  abandoned: string[];
  /** Already-expired leases reclaimed (epoch bumped, cancel published,
   *  left ready for redispatch). */
  reclaimed: string[];
}

export function emptyReport(): ReconcileReport {
  return { readopted: [], completed: [], abandoned: [], reclaimed: [] };
}

/**
 * Whether this issue belongs to the coordinator namespace: its lease holder
 * carries the `workgraph-run/` prefix AND a workflow-run id is persisted.
 * Run holders are portable across restarts by design — the run identity,
 * not the session, owns the lease — so any coordinator on this workspace
 * may adopt them (single-workspace-single-coordinator is the v1 operating
 * assumption; concurrent coordinators are fenced-safe, merely duplicating
 * idempotent status requests).
 */
export function isRunHeld(issue: WorkIssue): boolean {
  const holder = leaseHolderOf(issue);
  return (
    holder !== undefined &&
    holder.startsWith(WORKFLOW_RUN_PREFIX) &&
    workflowRunIdOf(issue) !== undefined
  );
}

/** An outcome step a closed issue is still waiting on, as its metadata recorded it. */
export interface PendingOutcome {
  issueId: string;
  /** The closed run the step follows (absent only on hand-written metadata). */
  workflowRunId?: string;
  executionId?: string;
  deadline?: string;
}

/**
 * Every closed issue whose outcome is still `pending`, split on its
 * deadline against `nowMs`: `due` (the deadline passed, or cannot be read)
 * and `waiting`. Reads metadata only; what to do with either list is the
 * coordinator's.
 */
export async function pendingOutcomes(
  cwd: string,
  nowMs: number,
): Promise<{ due: PendingOutcome[]; waiting: PendingOutcome[] }> {
  const due: PendingOutcome[] = [];
  const waiting: PendingOutcome[] = [];
  for (const issue of await listPendingOutcomes(cwd)) {
    const workflowRunId = workflowRunIdOf(issue);
    const executionId = outcomeExecutionIdOf(issue);
    const deadline = outcomeDeadlineOf(issue);
    const pending: PendingOutcome = {
      issueId: issue.id,
      ...(workflowRunId !== undefined ? { workflowRunId } : {}),
      ...(executionId !== undefined ? { executionId } : {}),
      ...(deadline !== undefined ? { deadline } : {}),
    };
    (outcomeDeadlinePassed(issue, nowMs) ? due : waiting).push(pending);
  }
  return { due, waiting };
}

/**
 * Enumerate every in_progress issue held by a workflow run. The cutoff is
 * pushed one TTL into the FUTURE so the store's `--updated-before` filter passes
 * everything currently in progress (the sweep uses the same query with a
 * past cutoff as its staleness signal; recovery wants the full set and
 * partitions client-side on the lease expiry the holder actually wrote).
 */
export async function listRunHeldInProgress(
  cwd: string,
  nowMs: number,
  ttlMs: number,
): Promise<WorkIssue[]> {
  const cutoff = rfc3339(nowMs + ttlMs);
  const issues = await listInProgressUpdatedBefore(cwd, cutoff);
  return issues.filter(isRunHeld);
}

/**
 * Partition run-held issues on lease expiry vs now. An issue with NO
 * expiry (anomalous for a run holder — acquire always stamps one) is
 * partitioned as live; the reconcile pass then abandons it EXPLICITLY
 * (reported in `abandoned` + audited `recovery-abandoned`) rather than
 * probing it — the sweep never auto-reclaims a no-expiry claim, so a
 * silent skip would strand the issue in_progress indefinitely.
 */
export function partitionByExpiry(
  issues: readonly WorkIssue[],
  nowMs: number,
): { expired: WorkIssue[]; live: WorkIssue[] } {
  const expired: WorkIssue[] = [];
  const live: WorkIssue[] = [];
  for (const issue of issues) {
    const expiresAt = leaseExpiresAtOf(issue);
    if (expiresAt !== undefined && Date.parse(expiresAt) < nowMs) {
      expired.push(issue);
    } else {
      live.push(issue);
    }
  }
  return { expired, live };
}

// ---------------------------------------------------------------------------
// The correlated status exchange
// ---------------------------------------------------------------------------

/** The recorded run a status request asks about. */
export interface StatusTarget {
  executorId: string;
  executionId?: string;
  workflowRunId: string;
  issueId: string;
}

export interface RequestStatusOptions {
  /** Answer deadline; expiry resolves undefined (caller abandons). */
  timeoutMs: number;
  /** Clock injection for envelope timestamps (default Date.now). */
  now?: () => number;
  onInvalid?: OnInvalidMessage;
}

/**
 * Emit `run:status-request` addressed to the recorded executor and await
 * the correlated `run:status`, bounded by `timeoutMs`. Subscribe-first like
 * every phase-2 exchange (`emit()` never awaits handlers — a synchronous
 * responder must not be missed). Correlation: `inReplyTo` === the request's
 * messageId when the adapter sets it, else by `workflowRunId` (unique per
 * run; recovery processes runs serially, so the fallback is unambiguous).
 * Resolves undefined on timeout — silence is never treated as an answer.
 */
export function requestStatus(
  events: EventBus,
  target: StatusTarget,
  opts: RequestStatusOptions,
): Promise<RunStatusT | undefined> {
  const request: RunStatusRequestT = {
    ...newEnvelope(opts.now),
    workflowRunId: target.workflowRunId,
    issueId: target.issueId,
    executorId: target.executorId,
    ...(target.executionId !== undefined
      ? { executionId: target.executionId }
      : {}),
  };

  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = events.on(CH.runStatus, (data) => {
      try {
        const msg = parseMessage(CH.runStatus, RunStatus, data);
        const correlated =
          msg.inReplyTo !== undefined
            ? msg.inReplyTo === request.messageId
            : msg.workflowRunId === target.workflowRunId;
        if (!correlated) return;
        finish(msg);
      } catch (e) {
        if (e instanceof ProtocolError) opts.onInvalid?.(CH.runStatus, e);
      }
    });

    function finish(outcome: RunStatusT | undefined): void {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve(outcome);
    }

    timer = setTimeout(() => finish(undefined), opts.timeoutMs);
    events.emit(CH.runStatusRequest, request);
  });
}

// ---------------------------------------------------------------------------
// Author reconstruction for judging-phase re-adoption
// ---------------------------------------------------------------------------

const RUN_COMPLETED_PREFIX = `${AUDIT_PREFIX} run-completed `;
const OUTCOMES: readonly string[] = ["success", "failure", "blocked"];

/**
 * Rebuild the author `run:completed` a judging-phase run's judgment loop
 * needs (artifacts for the review request, provenance for the independence
 * check) from the DURABLE remnants: the newest `run-completed` audit
 * comment for this workflow run (written fenced, before the judging
 * transition — implementation and revision completions only, never
 * reviews; the newest one is the artifact set currently under judgment)
 * plus the `workgraph_author_provenance` metadata stamped in the same
 * transition write. Returns undefined when no trail exists OR the newest
 * matching record is corrupted (its `outcome` is not a valid RunOutcome) —
 * the caller parks the run (heartbeat only) instead of judging blind.
 */
export async function reconstructAuthorCompletion(
  cwd: string,
  issue: WorkIssue,
  lease: Lease,
  now: () => number = Date.now,
): Promise<RunCompletedT | undefined> {
  const workflowRunId = workflowRunIdOf(issue);
  if (workflowRunId === undefined) return undefined;

  let comments;
  try {
    comments = await listComments(cwd, issue.id);
  } catch {
    return undefined; // no trail readable — park, never judge blind
  }

  for (let i = comments.length - 1; i >= 0; i--) {
    const text = comments[i]!.text;
    if (!text.startsWith(RUN_COMPLETED_PREFIX)) continue;
    let details: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text.slice(RUN_COMPLETED_PREFIX.length));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      details = parsed as Record<string, unknown>;
    } catch {
      continue; // a garbled comment is skipped, never trusted
    }
    if (details.workflowRunId !== workflowRunId) continue;

    // Outcome must be a valid RunOutcome. The coordinator always writes one
    // (the run-completed audit carries the completion's outcome verbatim),
    // so a missing or garbled outcome means a corrupted trail — and this
    // module never infers success (or ANY outcome) from a corrupted record.
    // Fail closed: no reconstruction, the caller parks the run instead of
    // judging blind. (Falling through to an OLDER record would resurrect a
    // stale artifact set — also wrong.)
    const outcome = details.outcome;
    if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) {
      return undefined;
    }

    // Provenance: prefer the metadata stamped at the judging transition
    // (the value the independence check ran against), fall back to the
    // audit payload, fail closed on nothing.
    const provenance =
      parseProvenance(issue.metadata?.[WORKGRAPH_AUTHOR_PROVENANCE_KEY]) ??
      parseProvenance(details.provenance) ?? { harness: "unknown" };

    return {
      ...newEnvelope(now),
      workflowRunId,
      executionId:
        typeof details.executionId === "string" ? details.executionId : "",
      issueId: issue.id,
      leaseEpoch: lease.epoch,
      outcome: outcome as RunOutcomeT,
      artifacts: stringArray(details.artifacts),
      evidence: stringArray(details.evidence),
      ...(typeof details.executionError === "string"
        ? { executionError: details.executionError }
        : {}),
      provenance,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tree-binding reconstruction for judging/revising/verifying re-adoption
// ---------------------------------------------------------------------------

const WORKSPACE_CHANGED_PREFIX = `${AUDIT_PREFIX} workspace-changed `;

/** What a restarted coordinator can recover about a run's workspace and trees. */
export interface RecoveredBinding {
  /** Where the work lives. */
  workspacePath?: string;
  /** The result tree recorded for THIS run, if any. */
  resultTree?: string;
  /** The anchored snapshot commit holding `resultTree`, when still on record. */
  resultCommit?: string;
  baseCommit?: string;
  baseTree?: string;
}

/**
 * Rebuild a run's workspace path, base and result tree after a restart.
 *
 * The RESULT TREE comes from the audit trail, not from
 * `workgraph_result_tree`: metadata survives a re-claim, so after a crash
 * that key can still hold the previous run's tree. The newest
 * `run-completed` (implementer or revision) or `workspace-changed` event
 * carrying THIS run's id is the tree currently under judgment. An event
 * with no tree — a run from before tree binding, or one whose snapshot
 * failed — yields none, and the caller snapshots at re-adoption.
 *
 * The BASE comes from metadata, and only when it belongs to the same
 * workspace: the base is keyed by workspace path.
 */
export async function reconstructBinding(
  cwd: string,
  issue: WorkIssue,
): Promise<RecoveredBinding> {
  const workflowRunId = workflowRunIdOf(issue);
  let eventPath: string | undefined;
  let eventTree: string | undefined;
  if (workflowRunId !== undefined) {
    let comments: Awaited<ReturnType<typeof listComments>> = [];
    try {
      comments = await listComments(cwd, issue.id);
    } catch {
      comments = []; // no trail readable — fall back to metadata for the path
    }
    for (let i = comments.length - 1; i >= 0; i--) {
      const text = comments[i]!.text;
      const prefix = text.startsWith(RUN_COMPLETED_PREFIX)
        ? RUN_COMPLETED_PREFIX
        : text.startsWith(WORKSPACE_CHANGED_PREFIX)
          ? WORKSPACE_CHANGED_PREFIX
          : undefined;
      if (prefix === undefined) continue;
      let details: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(text.slice(prefix.length));
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          continue;
        }
        details = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (details.workflowRunId !== workflowRunId) continue;
      if (details.role === "planner") continue; // a plan has no result tree
      if (typeof details.workspacePath === "string" && details.workspacePath) {
        eventPath = details.workspacePath;
      }
      if (typeof details.tree === "string" && details.tree) {
        eventTree = details.tree;
      }
      break; // the newest matching event decides, tree or no tree
    }
  }
  const workspacePath = eventPath ?? workspacePathOf(issue);
  const sameWorkspace =
    workspacePath !== undefined && workspacePathOf(issue) === workspacePath;
  const baseCommit = sameWorkspace ? baseCommitOf(issue) : undefined;
  const baseTree = sameWorkspace ? baseTreeOf(issue) : undefined;
  const resultCommit =
    eventTree !== undefined && resultTreeOf(issue) === eventTree
      ? resultCommitOf(issue)
      : undefined;
  return {
    ...(workspacePath !== undefined ? { workspacePath } : {}),
    ...(eventTree !== undefined ? { resultTree: eventTree } : {}),
    ...(resultCommit !== undefined ? { resultCommit } : {}),
    ...(baseCommit !== undefined ? { baseCommit } : {}),
    ...(baseTree !== undefined ? { baseTree } : {}),
  };
}

// ---------------------------------------------------------------------------
// The frozen bar
// ---------------------------------------------------------------------------

const BAR_FROZEN_PREFIX = `${AUDIT_PREFIX} bar-frozen `;

/**
 * The bar a run was claimed under, from the newest `bar-frozen` event that
 * carries THIS run's id. Undefined when there is none: a run claimed before
 * the bar existed, or one whose event write was lost. The caller then
 * freezes a bar at re-adoption and says so on the trail.
 *
 * Read from the event and never rebuilt from the issue and the settings:
 * both may have been edited since the claim, which is exactly what a frozen
 * bar is there to ignore.
 */
export async function reconstructBar(
  cwd: string,
  issue: WorkIssue,
): Promise<Bar | undefined> {
  const workflowRunId = workflowRunIdOf(issue);
  if (workflowRunId === undefined) return undefined;
  let comments: Awaited<ReturnType<typeof listComments>>;
  try {
    comments = await listComments(cwd, issue.id);
  } catch {
    return undefined;
  }
  for (let i = comments.length - 1; i >= 0; i--) {
    const text = comments[i]!.text;
    if (!text.startsWith(BAR_FROZEN_PREFIX)) continue;
    let details: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text.slice(BAR_FROZEN_PREFIX.length));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      details = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (details.workflowRunId !== workflowRunId) continue;
    // The newest event for this run decides, readable or not: falling
    // through to an older one could resurrect a bar that was replaced.
    return parseBar(details.bar);
  }
  return undefined;
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : [];
}

function parseProvenance(raw: unknown): RunCompletedT["provenance"] | undefined {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { harness?: unknown }).harness === "string"
  ) {
    const v = value as {
      harness: string;
      profile?: unknown;
      model?: unknown;
      provider?: unknown;
    };
    return {
      harness: v.harness,
      ...(typeof v.profile === "string" ? { profile: v.profile } : {}),
      ...(typeof v.model === "string" ? { model: v.model } : {}),
      ...(typeof v.provider === "string" ? { provider: v.provider } : {}),
    };
  }
  return undefined;
}
