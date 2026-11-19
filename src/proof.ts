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
 * never stops judgment. The durable record a close depends on is the verdict
 * (`src/verdict.ts`), not this trail.
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
  /** the tree the result is bound to (unset until tree binding exists) */
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
