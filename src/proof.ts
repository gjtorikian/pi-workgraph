/**
 * Proof records: what a gate result means, when it blocks, and where it is
 * recorded.
 *
 * A GATE is one named check on work before it closes (`GATES` in
 * `src/policy.ts`). Evaluating one yields a {@link GateResult}; the gate's
 * mode for the issue's risk tier then decides what that result does
 * ({@link decideGate}):
 *
 *   enforce — a blocking result blocks the close (`blocked`)
 *   observe — the same result is only recorded (`wouldBlock`)
 *   off     — the gate is not evaluated and nothing is recorded
 *
 * `violation` is a blocking result for every gate. `unknown` (the gate could
 * not determine an answer) is a blocking result only for the
 * {@link PROOF_GATES}: those are the records a close rests on, so a missing
 * answer is a missing proof. The three diff guards (`weakened-tests`,
 * `unproven-tests`, `scope`) are heuristics over a diff; when one cannot
 * decide — a red base branch, a missing setup command — it records `unknown`
 * and lets work through whose own check and review passed (decision log).
 * `observe` mirrors `enforce` exactly: `wouldBlock` is true precisely when
 * `enforce` would have set `blocked`.
 *
 * PERSISTENCE follows the audit-trail pattern (`src/audit.ts`): one
 * machine-readable comment per evaluation, `workgraph-proof gate {json}`,
 * written fire-and-forget — a failed gate-record write is logged loudly and
 * never stops judgment.
 *
 * THE STAMP is the other record under this prefix, and it is not
 * fire-and-forget. `workgraph-proof stamp {json}` is written once per
 * accepted run, after the gates passed and BEFORE finalization: it names
 * the tree that was accepted, the base it is measured against, the verdict
 * it rests on and the latest result of every gate that was evaluated. Like
 * the verdict (`src/verdict.ts`), it is a record a close depends on, so
 * {@link recordStamp} rejects with {@link StampWriteError} when the write
 * fails and the caller escalates instead of closing. Comments are
 * append-only, so a tree changed by finalization is recorded as a second
 * comment, `workgraph-proof stamp-amended {json}`, which
 * {@link latestStamp} folds into the stamp it returns.
 */
import {
  addComment,
  listComments,
  listCommentsByPrefix,
} from "./store.ts";
import { GATES, type GateModeT, type GateName } from "./policy.ts";
import { TRUNCATION_MARKER } from "./verdict.ts";

/** Prefix on every proof comment; tests and humans grep for it. */
export const PROOF_PREFIX = "workgraph-proof";

/** Marker opening every gate record: the prefix, the record kind, a space. */
const GATE_MARKER = `${PROOF_PREFIX} gate `;

/** Marker opening the close stamp. The space keeps it from matching an amendment. */
const STAMP_MARKER = `${PROOF_PREFIX} stamp `;

/** Marker opening a stamp amendment (finalization changed the tree). */
const STAMP_AMENDED_MARKER = `${PROOF_PREFIX} stamp-amended `;

/** Cap on a record's `reason`, truncation marker included. */
export const MAX_REASON_CHARS = 400;

export type GateResult = "pass" | "violation" | "not-applicable" | "unknown";

const GATE_RESULTS: readonly GateResult[] = [
  "pass",
  "violation",
  "not-applicable",
  "unknown",
];

/** Gates whose `unknown` blocks under enforce. The three diff guards are not in it. */
export const PROOF_GATES: readonly GateName[] = [
  "review",
  "tree-binding",
  "check",
  "criteria-evidence",
];

/** One evaluation of one gate, as recorded on the issue's comment trail. */
export interface GateRecord {
  gate: GateName;
  mode: GateModeT;
  result: GateResult;
  /** enforce and the result blocks */
  blocked: boolean;
  /** observe and enforce would have blocked */
  wouldBlock: boolean;
  /** capped at {@link MAX_REASON_CHARS} */
  reason?: string;
  /** the result tree the evaluation is bound to; unset when none was recorded */
  tree?: string;
  workflowRunId: string;
  attempt: number;
}

/**
 * What a gate result does under a mode. Pure: the whole table is
 * `GATES` x modes x results, and `off` is false on both sides everywhere.
 */
export function decideGate(
  gate: GateName,
  mode: GateModeT,
  result: GateResult,
): { blocked: boolean; wouldBlock: boolean } {
  const blocks =
    result === "violation" ||
    (result === "unknown" && PROOF_GATES.includes(gate));
  return {
    blocked: mode === "enforce" && blocks,
    wouldBlock: mode === "observe" && blocks,
  };
}

function capReason(reason: string): string {
  if (reason.length <= MAX_REASON_CHARS) return reason;
  return (
    reason.slice(0, MAX_REASON_CHARS - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
}

/**
 * Record one gate evaluation as `workgraph-proof gate {json}`. Resolves
 * (never rejects) even when the write fails, mirroring `recordLeaseEvent`.
 * A record whose mode is `off` is never written: an off gate was not
 * evaluated, so there is no result to record.
 */
export async function recordGate(
  cwd: string,
  issueId: string,
  record: GateRecord,
  actor?: string,
): Promise<void> {
  if (record.mode === "off") return;
  const payload: GateRecord = {
    gate: record.gate,
    mode: record.mode,
    result: record.result,
    blocked: record.blocked,
    wouldBlock: record.wouldBlock,
    ...(record.reason !== undefined
      ? { reason: capReason(record.reason) }
      : {}),
    ...(record.tree !== undefined ? { tree: record.tree } : {}),
    workflowRunId: record.workflowRunId,
    attempt: record.attempt,
  };
  const text = `${GATE_MARKER}${JSON.stringify(payload)}`;
  try {
    await addComment(cwd, issueId, text, actor);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Loud, but non-blocking — judgment proceeds without the gate record.
    console.error(
      `[pi-workgraph] PROOF WRITE FAILED (${record.gate} gate on ${issueId}): ${msg}`,
    );
  }
}

/** A gate record read back from a comment, or undefined when it is not one. */
function parseGateRecord(json: string): GateRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const payload = raw as Record<string, unknown>;
  const gate = GATES.find((candidate) => candidate === payload.gate);
  const result = GATE_RESULTS.find((candidate) => candidate === payload.result);
  const mode = payload.mode;
  if (
    gate === undefined ||
    result === undefined ||
    (mode !== "observe" && mode !== "enforce") ||
    typeof payload.blocked !== "boolean" ||
    typeof payload.wouldBlock !== "boolean" ||
    typeof payload.workflowRunId !== "string" ||
    typeof payload.attempt !== "number"
  ) {
    return undefined;
  }
  return {
    gate,
    mode,
    result,
    blocked: payload.blocked,
    wouldBlock: payload.wouldBlock,
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    ...(typeof payload.tree === "string" ? { tree: payload.tree } : {}),
    workflowRunId: payload.workflowRunId,
    attempt: payload.attempt,
  };
}

/**
 * Every gate record on one issue, or (no `issueId`) across the whole graph,
 * oldest first. A comment under the prefix that does not parse as a gate
 * record is skipped, never thrown: one corrupt comment must not hide the
 * rest of the trail.
 */
export async function listGateRecords(
  cwd: string,
  issueId?: string,
): Promise<Array<GateRecord & { issueId: string }>> {
  const comments =
    issueId !== undefined
      ? await listComments(cwd, issueId)
      : await listCommentsByPrefix(cwd, GATE_MARKER);
  const records: Array<GateRecord & { issueId: string }> = [];
  for (const comment of comments) {
    if (!comment.text.startsWith(GATE_MARKER)) continue;
    const record = parseGateRecord(comment.text.slice(GATE_MARKER.length));
    if (record) records.push({ ...record, issueId: comment.issue_id });
  }
  return records;
}

/** What one gate did across a set of records. */
export interface GateSummary {
  /** Evaluations recorded for the gate. */
  records: number;
  /** Issues the gate blocked at least once, in first-blocked order. */
  blocked: string[];
  /** Issues the gate would have blocked at least once, in the same order. */
  wouldBlock: string[];
}

/**
 * Group records by gate for the gate report. An issue counts once per
 * column however many times it was evaluated, and it counts if the gate
 * EVER blocked (or would have blocked) it: an issue blocked in round one and
 * passed after a revision was still blocked by the gate, which is the
 * question the report answers.
 */
export function summarizeGates(
  records: ReadonlyArray<GateRecord & { issueId: string }>,
): Record<GateName, GateSummary> {
  const summary = {} as Record<GateName, GateSummary>;
  for (const gate of GATES) {
    summary[gate] = { records: 0, blocked: [], wouldBlock: [] };
  }
  for (const record of records) {
    const entry = summary[record.gate];
    entry.records += 1;
    if (record.blocked && !entry.blocked.includes(record.issueId)) {
      entry.blocked.push(record.issueId);
    }
    if (record.wouldBlock && !entry.wouldBlock.includes(record.issueId)) {
      entry.wouldBlock.push(record.issueId);
    }
  }
  return summary;
}

/** The most recent record of each gate, in `GATES` order. */
export function latestGateRecords<T extends GateRecord>(
  records: readonly T[],
): T[] {
  const latest = new Map<GateName, T>();
  for (const record of records) latest.set(record.gate, record);
  return GATES.flatMap((gate) => {
    const record = latest.get(gate);
    return record ? [record] : [];
  });
}

// ---------------------------------------------------------------------------
// The close stamp
// ---------------------------------------------------------------------------

/**
 * What an accepted run was accepted ON. The three tree fields are present
 * together or not at all: a run whose workspace could not be snapshotted
 * (`tree-binding: unknown` under `observe`) is stamped without them, which
 * says exactly that — the close rests on no tree.
 */
export interface Stamp {
  /** The accepted result tree. */
  tree?: string;
  /** The tree the work started from. */
  baseTree?: string;
  /** The anchored snapshot commit holding `tree`. */
  commit?: string;
  workflowRunId: string;
  attempt: number;
  /** The verdict the close rests on; absent when no review ran. */
  verdict?: { executionId: string; summary: string };
  /** Latest result per gate evaluated for this run. */
  gates: Record<string, GateResult>;
  /** Set only when finalization changed the tree (folded in by {@link latestStamp}). */
  finalizedTree?: string;
}

/** Thrown when a close stamp could not be written to the comment trail. */
export class StampWriteError extends Error {
  readonly issueId: string;
  /** The underlying write failure. */
  readonly detail: string;

  constructor(issueId: string, detail: string) {
    super(`Close stamp for ${issueId} could not be written: ${detail}`);
    this.name = "StampWriteError";
    this.issueId = issueId;
    this.detail = detail;
  }
}

/**
 * Persist the close stamp as `workgraph-proof stamp {json}`. REJECTS with
 * {@link StampWriteError} when the write fails, unlike {@link recordGate}:
 * the caller must not close an issue whose stamp was not recorded.
 */
export async function recordStamp(
  cwd: string,
  issueId: string,
  stamp: Stamp,
  actor?: string,
): Promise<void> {
  const payload: Stamp = {
    ...(stamp.tree !== undefined ? { tree: stamp.tree } : {}),
    ...(stamp.baseTree !== undefined ? { baseTree: stamp.baseTree } : {}),
    ...(stamp.commit !== undefined ? { commit: stamp.commit } : {}),
    workflowRunId: stamp.workflowRunId,
    attempt: stamp.attempt,
    ...(stamp.verdict !== undefined
      ? {
          verdict: {
            executionId: stamp.verdict.executionId,
            summary: stamp.verdict.summary,
          },
        }
      : {}),
    gates: { ...stamp.gates },
  };
  const text = `${STAMP_MARKER}${JSON.stringify(payload)}`;
  try {
    await addComment(cwd, issueId, text, actor);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Loud AND blocking — the close must not proceed without the record.
    console.error(`[pi-workgraph] STAMP WRITE FAILED (${issueId}): ${msg}`);
    throw new StampWriteError(issueId, msg);
  }
}

/**
 * Record that finalization changed the stamped tree, as
 * `workgraph-proof stamp-amended {json}`. Resolves even when the write
 * fails: finalization's external effects have already happened, so nothing
 * is gained by blocking the close on this record (decision log).
 */
export async function recordStampAmendment(
  cwd: string,
  issueId: string,
  amendment: { finalizedTree: string; workflowRunId: string },
  actor?: string,
): Promise<void> {
  const text = `${STAMP_AMENDED_MARKER}${JSON.stringify({
    finalizedTree: amendment.finalizedTree,
    workflowRunId: amendment.workflowRunId,
  })}`;
  try {
    await addComment(cwd, issueId, text, actor);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[pi-workgraph] PROOF WRITE FAILED (stamp amendment on ${issueId}): ${msg}`,
    );
  }
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    return raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseStamp(json: string): Stamp | undefined {
  const payload = jsonObject(json);
  if (
    !payload ||
    typeof payload.workflowRunId !== "string" ||
    typeof payload.attempt !== "number"
  ) {
    return undefined;
  }
  const gates: Record<string, GateResult> = {};
  const rawGates = payload.gates;
  if (
    rawGates !== null &&
    typeof rawGates === "object" &&
    !Array.isArray(rawGates)
  ) {
    for (const [gate, value] of Object.entries(rawGates)) {
      const result = GATE_RESULTS.find((candidate) => candidate === value);
      if (result !== undefined) gates[gate] = result;
    }
  }
  const verdict = payload.verdict as
    | { executionId?: unknown; summary?: unknown }
    | null
    | undefined;
  return {
    ...(typeof payload.tree === "string" ? { tree: payload.tree } : {}),
    ...(typeof payload.baseTree === "string"
      ? { baseTree: payload.baseTree }
      : {}),
    ...(typeof payload.commit === "string" ? { commit: payload.commit } : {}),
    workflowRunId: payload.workflowRunId,
    attempt: payload.attempt,
    ...(verdict !== null &&
    typeof verdict === "object" &&
    typeof verdict.executionId === "string" &&
    typeof verdict.summary === "string"
      ? {
          verdict: {
            executionId: verdict.executionId,
            summary: verdict.summary,
          },
        }
      : {}),
    gates,
  };
}

/**
 * The newest close stamp on an issue, with the newest amendment written
 * after it for the same run folded in as `finalizedTree`. Undefined when the
 * issue has none. A comment under either marker that does not parse is
 * skipped, never thrown.
 */
export async function latestStamp(
  cwd: string,
  issueId: string,
): Promise<Stamp | undefined> {
  const comments = await listComments(cwd, issueId);
  let finalizedBy: { finalizedTree: string; workflowRunId: string } | undefined;
  for (let i = comments.length - 1; i >= 0; i--) {
    const text = comments[i]!.text;
    if (text.startsWith(STAMP_AMENDED_MARKER)) {
      const payload = jsonObject(text.slice(STAMP_AMENDED_MARKER.length));
      if (
        finalizedBy === undefined &&
        payload &&
        typeof payload.finalizedTree === "string" &&
        typeof payload.workflowRunId === "string"
      ) {
        finalizedBy = {
          finalizedTree: payload.finalizedTree,
          workflowRunId: payload.workflowRunId,
        };
      }
      continue;
    }
    if (!text.startsWith(STAMP_MARKER)) continue;
    const stamp = parseStamp(text.slice(STAMP_MARKER.length));
    if (!stamp) continue;
    return finalizedBy !== undefined &&
      finalizedBy.workflowRunId === stamp.workflowRunId
      ? { ...stamp, finalizedTree: finalizedBy.finalizedTree }
      : stamp;
  }
  return undefined;
}
