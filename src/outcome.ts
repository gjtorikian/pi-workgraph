/**
 * Outcome records: what happened to accepted work AFTER it closed, and the
 * scorecard that counts how often accepted work needed nothing more.
 *
 * AN OUTCOME is one of `clean` (the work needed nothing), `needed_fixes`
 * (with a round count), `abandoned`, or `unknown` (nobody could say). It is
 * written as one machine-readable comment, `workgraph-outcome outcome
 * {json}`, plus a compact copy in metadata (`workgraph_outcome`, for example
 * `needed_fixes:2`). Recording again is allowed: the latest record wins and
 * the earlier ones stay on the trail.
 *
 * Invariants owned here:
 *  - AN OUTCOME IS AN ANNOTATION. It changes no lifecycle state and is
 *    written on an issue that is already closed, where no lease exists. So
 *    it is the one write in this extension that is NOT lease-fenced.
 *  - ONLY GATE-CLOSED WORK IS GRADED ({@link gradableClose}): the issue is
 *    closed, the close was not an override, and it carries the close stamp
 *    of its latest run. Work closed with no stamp (both gates that feed the
 *    stamp are `off`) has nothing to hold an outcome against.
 *  - AN OUTCOME BELONGS TO ONE CLOSE. A record names the run whose stamp it
 *    grades, and {@link latestOutcome} returns only a record for the latest
 *    stamp's run: an issue that is released and closed again starts with no
 *    outcome instead of inheriting the first close's.
 *  - A REPORT IS NEVER OVERWRITTEN BY SILENCE. `pending` only says an
 *    outcome step is expected to report. {@link markOutcomePending} is not
 *    written over a record that already exists, and the core writes
 *    `unknown` only where the trail holds no record for that close.
 *  - `none` IS NOT `clean`. The scorecard counts a gate-closed issue with no
 *    record as `none`, and never as work that needed nothing.
 *
 * Callers report `clean`, `needed_fixes` or `abandoned`; `unknown` is the
 * core's own word for a step that could not run or never reported.
 */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { recordLeaseEvent } from "./audit.ts";
import {
  outcomeDeadlineOf,
  outcomeStatusOf,
  workflowRunIdOf,
} from "./lifecycle.ts";
import { latestStamp, type Stamp, type StampCheck } from "./proof.ts";
import {
  addComment,
  listClosedByMetadata,
  listComments,
  setMetadata,
} from "./store.ts";
import type { WorkIssue } from "./types.ts";
import { TRUNCATION_MARKER } from "./verdict.ts";
import {
  WORKGRAPH_OUTCOME_DEADLINE_KEY,
  WORKGRAPH_OUTCOME_EXECUTION_ID_KEY,
  WORKGRAPH_OUTCOME_KEY,
  WORKGRAPH_OUTCOME_STATUS_KEY,
  WORKGRAPH_PHASE_KEY,
} from "./types.ts";

/** Prefix on every outcome comment; tests and humans grep for it. */
export const OUTCOME_PREFIX = "workgraph-outcome";

/** Marker opening an outcome record: the prefix, the record kind, a space. */
export const OUTCOME_MARKER = `${OUTCOME_PREFIX} outcome `;

/** Cap on a record's summary before truncation (the house cap for evidence). */
export const MAX_OUTCOME_SUMMARY_CHARS = 400;

/** How long a launched outcome step may stay silent before `unknown` (2 h). */
export const DEFAULT_OUTCOME_TIMEOUT_MS = 7_200_000;

/** The scorecard's default window. */
export const DEFAULT_SCORECARD_WINDOW_DAYS = 7;

/** Under this many counted issues the scorecard prints counts, never a percentage. */
export const SCORECARD_PERCENT_MINIMUM = 10;

/** Cap on the scorecard's `worst` list. */
export const MAX_WORST = 10;

/**
 * How a close through the override tool marks its reason
 * (`workgraph_override` writes it; {@link gradableClose} reads it). A close
 * whose reason starts with this was a human's, not the gate's.
 */
export const OVERRIDE_CLOSE_PREFIX = "override: ";

/** What happened to accepted work after it closed. `data` is free-form detail. */
export const Outcome = Type.Object({
  outcome: Type.Union([
    Type.Literal("clean"),
    Type.Literal("needed_fixes"),
    Type.Literal("abandoned"),
    Type.Literal("unknown"),
  ]),
  fixRounds: Type.Optional(Type.Integer({ minimum: 0 })),
  summary: Type.String({ minLength: 1 }),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type OutcomeT = Static<typeof Outcome>;

/** An outcome as read back: when it was recorded, by whom, and for which close. */
export type RecordedOutcome = OutcomeT & {
  /** When the record was written (the comment's creation time). */
  at: string;
  actor?: string;
  executionId?: string;
  /** The run whose close stamp the record grades. */
  workflowRunId?: string;
};

/**
 * The compact metadata value for an outcome: the outcome word, plus the
 * round count for `needed_fixes` when one was given (`needed_fixes:2`).
 */
export function compactOutcome(outcome: OutcomeT): string {
  return outcome.outcome === "needed_fixes" && outcome.fixRounds !== undefined
    ? `${outcome.outcome}:${outcome.fixRounds}`
    : outcome.outcome;
}

function capSummary(summary: string): string {
  return summary.length > MAX_OUTCOME_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_OUTCOME_SUMMARY_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
    : summary;
}

/**
 * Persist one outcome: the comment `workgraph-outcome outcome {json}`, an
 * `outcome-recorded` audit event, then the compact metadata with
 * `workgraph_outcome_status: "recorded"`. `details` names who reported
 * (`actor`), the outcome step's execution when there was one, and the run
 * whose close the record grades (`workflowRunId`, the close stamp's).
 * REJECTS when the comment or the metadata cannot be written: the caller
 * decides what a lost record means. Not lease-fenced (see the module
 * comment).
 */
export async function recordOutcome(
  cwd: string,
  issueId: string,
  outcome: OutcomeT,
  details: { actor?: string; executionId?: string; workflowRunId?: string },
  actor?: string,
): Promise<void> {
  const payload = {
    outcome: outcome.outcome,
    ...(outcome.fixRounds !== undefined ? { fixRounds: outcome.fixRounds } : {}),
    summary: capSummary(outcome.summary),
    ...(outcome.data !== undefined ? { data: outcome.data } : {}),
    ...(details.actor !== undefined ? { actor: details.actor } : {}),
    ...(details.executionId !== undefined
      ? { executionId: details.executionId }
      : {}),
    ...(details.workflowRunId !== undefined
      ? { workflowRunId: details.workflowRunId }
      : {}),
  };
  await addComment(cwd, issueId, `${OUTCOME_MARKER}${JSON.stringify(payload)}`, actor);
  await recordLeaseEvent(
    cwd,
    "outcome-recorded",
    issueId,
    {
      outcome: payload.outcome,
      ...(payload.fixRounds !== undefined ? { fixRounds: payload.fixRounds } : {}),
      summary: payload.summary,
      ...(details.actor !== undefined ? { actor: details.actor } : {}),
      ...(details.executionId !== undefined
        ? { executionId: details.executionId }
        : {}),
      ...(details.workflowRunId !== undefined
        ? { workflowRunId: details.workflowRunId }
        : {}),
    },
    actor,
  );
  await setMetadata(
    cwd,
    issueId,
    {
      [WORKGRAPH_OUTCOME_KEY]: compactOutcome(outcome),
      [WORKGRAPH_OUTCOME_STATUS_KEY]: "recorded",
    },
    actor,
  );
}

/**
 * The newest valid outcome record among `comments` that grades the close of
 * `runId`. A record that names another run belongs to an earlier close and
 * is skipped; one that names no run counts for any. A comment under the
 * marker that does not parse, or does not match {@link Outcome}, is skipped,
 * never thrown: a malformed newest record falls back to the valid one
 * before it.
 */
function outcomeAmong(
  comments: readonly { text: string; created_at?: string }[],
  runId: string | undefined,
): RecordedOutcome | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]!;
    if (!comment.text.startsWith(OUTCOME_MARKER)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(comment.text.slice(OUTCOME_MARKER.length));
    } catch {
      continue; // Not a readable record: keep looking.
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const outcome = {
      outcome: record.outcome,
      ...(record.fixRounds !== undefined ? { fixRounds: record.fixRounds } : {}),
      summary: record.summary,
      ...(record.data !== undefined ? { data: record.data } : {}),
    };
    if (!Value.Check(Outcome, outcome)) continue;
    const recordedFor =
      typeof record.workflowRunId === "string" && record.workflowRunId !== ""
        ? record.workflowRunId
        : undefined;
    if (recordedFor !== undefined && runId !== undefined && recordedFor !== runId) {
      continue; // An earlier close's outcome.
    }
    return {
      ...outcome,
      at: comment.created_at ?? "",
      ...(typeof record.actor === "string" ? { actor: record.actor } : {}),
      ...(typeof record.executionId === "string"
        ? { executionId: record.executionId }
        : {}),
      ...(recordedFor !== undefined ? { workflowRunId: recordedFor } : {}),
    };
  }
  return undefined;
}

/**
 * The latest outcome recorded for the issue's latest close, or undefined
 * when there is none. "Latest close" is the run the newest close stamp
 * names; an issue with no stamp has no close to tie a record to, and the
 * newest valid record is returned as it is.
 */
export async function latestOutcome(
  cwd: string,
  issueId: string,
): Promise<RecordedOutcome | undefined> {
  const stamp = await latestStamp(cwd, issueId);
  return outcomeAmong(await listComments(cwd, issueId), stamp?.workflowRunId);
}

// ---------------------------------------------------------------------------
// Which closes are graded
// ---------------------------------------------------------------------------

/** A close an outcome can be recorded against, or why it cannot. */
export type Gradable =
  | { ok: true; stamp: Stamp }
  | { ok: false; refusal: string };

/**
 * Whether `issue` was closed by the gate, with a stamp to grade. Checked in
 * this order, and the refusal names the condition that failed: the issue is
 * `closed`; the close was not an override; it carries the close stamp of
 * its latest run.
 */
export async function gradableClose(
  cwd: string,
  issue: WorkIssue,
): Promise<Gradable> {
  if (issue.status !== "closed") {
    return {
      ok: false,
      refusal: `${issue.id} is not closed (status ${issue.status}): an outcome is recorded after accepted work closes.`,
    };
  }
  if (issue.close_reason?.startsWith(OVERRIDE_CLOSE_PREFIX)) {
    return {
      ok: false,
      refusal: `${issue.id} was closed by an override, not by the gate: an override-closed issue is not graded.`,
    };
  }
  const stamp = await latestStamp(cwd, issue.id);
  const runId = workflowRunIdOf(issue);
  if (
    stamp === undefined ||
    (runId !== undefined && stamp.workflowRunId !== runId)
  ) {
    return {
      ok: false,
      refusal: `${issue.id} carries no close stamp for its latest run: only work the gate closed with a stamp (tree-binding or check evaluated) is graded.`,
    };
  }
  return { ok: true, stamp };
}

// ---------------------------------------------------------------------------
// Pending tracking: an outcome step was launched and is expected to report
// ---------------------------------------------------------------------------

/**
 * What the core hands an outcome step beside the caller's instructions: a
 * tolerated extra field on its run request (`outcomeReport`), never part of
 * the instructions themselves. The executor renders it as a block of its
 * own after them.
 */
export interface OutcomeReport {
  issueId: string;
  /** The close stamp of the run the step follows. */
  stamp: Stamp;
  /** The finalization result recorded for that run, when finalization ran. */
  finalization?: unknown;
  /** How the step reports: {@link outcomeReportInstruction}. */
  instruction: string;
}

/** The one sentence that tells an outcome step how to report. */
export function outcomeReportInstruction(issueId: string): string {
  return `When finished, call workgraph_record_outcome for issue ${issueId} with outcome clean, needed_fixes or abandoned, the number of fix rounds, and a one-line summary.`;
}

/**
 * Mark the issue's outcome as awaited: `pending`, with the step's execution
 * id and the deadline after which silence is recorded as `unknown`.
 */
export async function markOutcomePending(
  cwd: string,
  issueId: string,
  pending: { executionId: string; deadline: string },
  actor?: string,
): Promise<void> {
  await setMetadata(
    cwd,
    issueId,
    {
      [WORKGRAPH_OUTCOME_STATUS_KEY]: "pending",
      [WORKGRAPH_OUTCOME_EXECUTION_ID_KEY]: pending.executionId,
      [WORKGRAPH_OUTCOME_DEADLINE_KEY]: pending.deadline,
    },
    actor,
  );
}

/** Every closed issue whose outcome is still awaited, oldest first. */
export async function listPendingOutcomes(cwd: string): Promise<WorkIssue[]> {
  const issues = await listClosedByMetadata(
    cwd,
    WORKGRAPH_OUTCOME_STATUS_KEY,
    "pending",
  );
  return issues.filter((issue) => outcomeStatusOf(issue) === "pending");
}

/**
 * Whether a pending outcome's deadline is behind `nowMs`. A missing or
 * unreadable deadline reads as passed: nothing would ever settle it
 * otherwise.
 */
export function outcomeDeadlinePassed(issue: WorkIssue, nowMs: number): boolean {
  const raw = outcomeDeadlineOf(issue);
  if (raw === undefined) return true;
  const deadline = Date.parse(raw);
  return Number.isNaN(deadline) || deadline <= nowMs;
}

// ---------------------------------------------------------------------------
// The scorecard
// ---------------------------------------------------------------------------

/** One gate-closed issue, as the scorecard counts it. */
export interface ScorecardRow {
  issueId: string;
  title: string;
  /** When the issue closed (ISO). A row without a readable time is not counted. */
  closedAt?: string;
  /** The close stamp's `check` field; absent when the gate was `off`. */
  check?: StampCheck;
  /** The outcome recorded for this close; absent when there is none. */
  outcome?: OutcomeT["outcome"];
  fixRounds?: number;
}

export interface Scorecard {
  windowDays: number;
  total: number;
  clean: number;
  neededFixes: number;
  abandoned: number;
  unknown: number;
  /** Gate-closed issues with no outcome record. Never counted as clean. */
  none: number;
  /**
   * The same count split by what the close rested on from the `check` gate.
   * `failed` is a failing check the gate only observed; a stamp with no
   * `check` field (gate `off`) counts under `none`.
   */
  byCheck: Record<StampCheck, { total: number; clean: number }>;
  /** The issues that fared worst: abandoned, then most fix rounds, then unknown. */
  worst: Array<{
    issueId: string;
    title: string;
    outcome: string;
    fixRounds?: number;
  }>;
}

const DAY_MS = 86_400_000;

/** The rounds a `needed_fixes` row counts for: a missing count is one round. */
function roundsOf(row: ScorecardRow): number {
  return row.fixRounds ?? 1;
}

/**
 * Count the rows closed within `windowDays` of `now` (a close exactly that
 * old still counts). Pure: the rows are what {@link scorecardRows} read.
 */
export function scorecard(
  rows: ScorecardRow[],
  opts: { now: Date; windowDays: number },
): Scorecard {
  const nowMs = opts.now.getTime();
  const cutoff = nowMs - opts.windowDays * DAY_MS;
  const counted = rows.filter((row) => {
    if (row.closedAt === undefined) return false;
    const closed = Date.parse(row.closedAt);
    return !Number.isNaN(closed) && closed >= cutoff;
  });
  const card: Scorecard = {
    windowDays: opts.windowDays,
    total: counted.length,
    clean: 0,
    neededFixes: 0,
    abandoned: 0,
    unknown: 0,
    none: 0,
    byCheck: {
      passed: { total: 0, clean: 0 },
      waived: { total: 0, clean: 0 },
      none: { total: 0, clean: 0 },
      failed: { total: 0, clean: 0 },
    },
    worst: [],
  };
  for (const row of counted) {
    const split = card.byCheck[row.check ?? "none"];
    split.total += 1;
    switch (row.outcome) {
      case "clean":
        card.clean += 1;
        split.clean += 1;
        break;
      case "needed_fixes":
        card.neededFixes += 1;
        break;
      case "abandoned":
        card.abandoned += 1;
        break;
      case "unknown":
        card.unknown += 1;
        break;
      default:
        card.none += 1;
    }
  }
  const rank = (row: ScorecardRow): number =>
    row.outcome === "abandoned" ? 0 : row.outcome === "needed_fixes" ? 1 : 2;
  card.worst = counted
    .filter(
      (row) =>
        row.outcome === "abandoned" ||
        row.outcome === "needed_fixes" ||
        row.outcome === "unknown",
    )
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.outcome === "needed_fixes" ? roundsOf(b) - roundsOf(a) : 0) ||
        (a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0),
    )
    .slice(0, MAX_WORST)
    .map((row) => ({
      issueId: row.issueId,
      title: row.title,
      outcome: row.outcome as string,
      ...(row.outcome === "needed_fixes" && row.fixRounds !== undefined
        ? { fixRounds: row.fixRounds }
        : {}),
    }));
  return card;
}

/**
 * The scorecard as text. Under {@link SCORECARD_PERCENT_MINIMUM} counted
 * issues it prints counts (`3 of 4 needed nothing`) and never a percentage:
 * a rate over four issues reads as more than it is. When most counted
 * issues have no outcome record, that line comes first, because the rest
 * then says little.
 */
export function renderScorecard(card: Scorecard): string {
  const days = `${card.windowDays} day${card.windowDays === 1 ? "" : "s"}`;
  if (card.total === 0) {
    return `No gate-closed issues in the last ${days}.`;
  }
  const lines = [`Gate-closed issues in the last ${days}: ${card.total}`];
  const noneLine = `${card.none} of ${card.total} have no outcome recorded (never counted as clean)`;
  const mostlyNone = card.none > card.total / 2;
  if (mostlyNone) lines.push(noneLine);
  lines.push(
    card.total < SCORECARD_PERCENT_MINIMUM
      ? `${card.clean} of ${card.total} needed nothing`
      : `${Math.round((card.clean / card.total) * 100)}% needed nothing (${card.clean} of ${card.total})`,
  );
  lines.push(
    `Needed fixes: ${card.neededFixes}, abandoned: ${card.abandoned}, unknown: ${card.unknown}`,
  );
  if (!mostlyNone && card.none > 0) lines.push(noneLine);
  const splits = (Object.keys(card.byCheck) as StampCheck[])
    .filter((check) => card.byCheck[check].total > 0)
    .map(
      (check) =>
        `${check === "none" ? "no check" : `check ${check}`}: ${card.byCheck[check].clean} of ${card.byCheck[check].total} needed nothing`,
    );
  if (splits.length > 0) lines.push(`By check: ${splits.join("; ")}`);
  for (const worst of card.worst) {
    const rounds =
      worst.fixRounds !== undefined
        ? ` (${worst.fixRounds} round${worst.fixRounds === 1 ? "" : "s"})`
        : "";
    lines.push(`Worst: ${worst.issueId} ${worst.title}: ${worst.outcome}${rounds}`);
  }
  return lines.join("\n");
}

/**
 * The rows the scorecard counts: every gate-closed issue (closed in phase
 * `accepted`, not by an override, with the close stamp of its latest run),
 * each with its stamp's `check` and the outcome recorded for that close.
 * One row per issue whatever its history.
 */
export async function scorecardRows(cwd: string): Promise<ScorecardRow[]> {
  const issues = await listClosedByMetadata(cwd, WORKGRAPH_PHASE_KEY, "accepted");
  const rows: ScorecardRow[] = [];
  for (const issue of issues) {
    const gradable = await gradableClose(cwd, issue);
    if (!gradable.ok) continue;
    const outcome = outcomeAmong(
      await listComments(cwd, issue.id),
      gradable.stamp.workflowRunId,
    );
    rows.push({
      issueId: issue.id,
      title: issue.title,
      ...(issue.closed_at !== undefined ? { closedAt: issue.closed_at } : {}),
      ...(gradable.stamp.check !== undefined ? { check: gradable.stamp.check } : {}),
      ...(outcome !== undefined ? { outcome: outcome.outcome } : {}),
      ...(outcome?.fixRounds !== undefined ? { fixRounds: outcome.fixRounds } : {}),
    });
  }
  return rows;
}
