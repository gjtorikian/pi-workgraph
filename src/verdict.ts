/**
 * Structured verdicts: validation, blocker processing, comment persistence,
 * and failure fingerprints.
 *
 * TRANSPORT: protocol-v1 schemas are non-strict, so a reviewer completion
 * carries its verdict as an extra `verdict` field on `run:completed` — no
 * protocol change. This module validates that payload against the shared
 * {@link Verdict} schema before the judgment gate acts on it; an invalid
 * verdict causes zero state change (the coordinator discards the attempt,
 * audits it, and re-requests within a bounded retry). The answer to a
 * blocker recheck travels the same way, as `recheck`.
 *
 * BLOCKERS. A reviewer's blocking finding sends work back for a revision
 * and another review, so it is checked twice before it counts, and both
 * checks can only take a blocker away:
 *
 *  1. {@link checkCitations}: the finding must point at a file and line that
 *     exist in the reviewed tree. One that does not is downgraded to
 *     advisory, with the reason appended to its note. Skipped when the work
 *     is bound to no tree.
 *  2. {@link applyRecheck}: the reviewer executor gets one more run over the
 *     blockers that are left ({@link recheckBlockers} numbers them) and
 *     keeps or downgrades each. No answer, or no usable answer, keeps.
 *
 * A finding the core wrote itself (`author: "code"`: a failed check) is
 * touched by neither. Its evidence is a receipt, not an opinion.
 *
 * PERSISTENCE borrows the audit trail's shape (`src/audit.ts`): one
 * machine-readable comment per verdict under a stable prefix, read back via
 * `listComments`. It does NOT borrow the audit trail's fire-and-forget
 * write. The verdict is the record a close rests on, so `recordVerdict`
 * rejects with {@link VerdictWriteError} when the write fails and the
 * judgment gate escalates instead of closing: an issue never closes on a
 * verdict nobody can read back. No gate mode relaxes this. The verdict
 * comment is the reviewer's FIRST reply, as reported, with its criterion
 * answers. What the two blocker checks made of it is a second comment,
 * `workgraph-verdict recheck {json}` ({@link recordRecheck}), written
 * whenever either check ran into something. Metadata is NOT an event store
 * (decision log): only the compact summary lands in
 * `workgraph_last_verdict`, riding the same `setMetadata` call as the phase
 * transition.
 *
 * SIZE CAPS (failure-modes table): findings and criterion answers are capped
 * and evidence strings truncated with a marker before serialization, so a
 * reviewer returning huge findings can never produce an unwritable or
 * unreadable comment.
 */
import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { evaluateCriteria, MAX_CRITERIA, type Criterion } from "./criteria.ts";
import { addComment, listComments } from "./store.ts";
import type {
  BlockerRecheckT,
  CriterionAnswerT,
  FindingT,
  VerdictT,
} from "./types.ts";
import { BlockerRecheck, Verdict } from "./types.ts";

/** Prefix on every verdict comment; tests and humans grep for it. */
export const VERDICT_PREFIX = "workgraph-verdict";

/** Marker opening a verdict record: the prefix, the record kind, a space. */
export const VERDICT_MARKER = `${VERDICT_PREFIX} verdict `;

/** Marker opening a recheck record. The space keeps the two apart. */
export const RECHECK_MARKER = `${VERDICT_PREFIX} recheck `;

/** Cap on findings persisted per verdict (the rest fold into a count). */
export const MAX_FINDINGS = 50;

/** Cap on a single evidence/note string before truncation. */
export const MAX_EVIDENCE_CHARS = 400;

/** Marker appended to truncated strings. */
export const TRUNCATION_MARKER = "…[truncated]";

/** Cap on the compact `workgraph_last_verdict` summary value. */
export const MAX_SUMMARY_CHARS = 160;

/** Appended to the note of a blocker whose citation did not resolve. */
export const CITATION_DOWNGRADE_NOTE =
  "[Downgraded: citation does not resolve in the reviewed tree]";

/** Cap on the reason quoted in a recheck downgrade note. */
const MAX_RECHECK_REASON_CHARS = 200;

/** How far into a finding's evidence a `path:line` is looked for. */
const MAX_CITATION_SCAN_CHARS = 2000;

/** Thrown when a reported verdict payload fails schema validation. */
export class VerdictError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Invalid verdict payload: ${detail}`);
    this.name = "VerdictError";
    this.detail = detail;
  }
}

/** Thrown when a verdict could not be written to the comment trail. */
export class VerdictWriteError extends Error {
  readonly issueId: string;
  /** The underlying write failure. */
  readonly detail: string;

  constructor(issueId: string, detail: string) {
    super(`Verdict record for ${issueId} could not be written: ${detail}`);
    this.name = "VerdictWriteError";
    this.issueId = issueId;
    this.detail = detail;
  }
}

/** Thrown when a reported recheck payload fails schema validation. */
export class RecheckError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Invalid recheck payload: ${detail}`);
    this.name = "RecheckError";
    this.detail = detail;
  }
}

/**
 * Validate a reported verdict payload. Returns the typed verdict or throws
 * {@link VerdictError}; a missing payload (`undefined`) is invalid — the
 * judgment gate never infers a verdict from silence.
 */
export function parseVerdict(raw: unknown): VerdictT {
  const reported = withoutAuthors(raw);
  if (Value.Check(Verdict, reported)) return reported;
  const detail = [...Value.Errors(Verdict, reported)]
    .slice(0, 3)
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
  throw new VerdictError(detail || "schema mismatch");
}

/**
 * Validate a reported recheck payload. Returns the typed answers or throws
 * {@link RecheckError}; a missing payload is invalid, and an invalid recheck
 * leaves every blocker standing.
 */
export function parseRecheck(raw: unknown): BlockerRecheckT {
  if (Value.Check(BlockerRecheck, raw)) return raw;
  const detail = [...Value.Errors(BlockerRecheck, raw)]
    .slice(0, 3)
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
  throw new RecheckError(detail || "schema mismatch");
}

/**
 * A reported verdict with `author` removed from every finding. `author:
 * "code"` marks a finding the core wrote itself, and the blocker checks
 * leave such a finding alone; a reviewer must not be able to claim it, so
 * the field never survives a reported verdict, whatever it held.
 * Anything that is not verdict-shaped is returned as it came, for the
 * schema check to reject.
 */
function withoutAuthors(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const findings = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return raw;
  return {
    ...(raw as Record<string, unknown>),
    findings: findings.map((finding: unknown) => {
      if (
        finding === null ||
        typeof finding !== "object" ||
        Array.isArray(finding) ||
        !("author" in finding)
      ) {
        return finding;
      }
      const { author: _author, ...rest } = finding as Record<string, unknown>;
      return rest;
    }),
  };
}

/** The blocking findings of a verdict. */
export function blockingFindings(verdict: VerdictT): FindingT[] {
  return verdict.findings.filter((f) => f.severity === "blocking");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + TRUNCATION_MARKER;
}

function capFinding(finding: FindingT): FindingT {
  return {
    criterion: truncate(finding.criterion, MAX_EVIDENCE_CHARS),
    severity: finding.severity,
    ...(finding.note !== undefined
      ? { note: truncate(finding.note, MAX_EVIDENCE_CHARS) }
      : {}),
    ...(finding.evidence !== undefined
      ? { evidence: truncate(finding.evidence, MAX_EVIDENCE_CHARS) }
      : {}),
    ...(finding.citation !== undefined
      ? {
          citation: {
            path: truncate(finding.citation.path, MAX_EVIDENCE_CHARS),
            line: finding.citation.line,
          },
        }
      : {}),
    ...(finding.author !== undefined ? { author: finding.author } : {}),
  };
}

function capAnswer(answer: CriterionAnswerT): CriterionAnswerT {
  return {
    id: truncate(answer.id, MAX_EVIDENCE_CHARS),
    status: answer.status,
    ...(answer.evidence !== undefined
      ? { evidence: truncate(answer.evidence, MAX_EVIDENCE_CHARS) }
      : {}),
  };
}

/**
 * Canonicalize findings for hashing and persistence: sorted by criterion
 * then severity (spec), with a stable key order per finding — so two
 * verdicts differing only in arrival order fingerprint identically. A
 * finding keeps its `citation` and its `author`.
 */
export function canonicalFindings(findings: readonly FindingT[]): FindingT[] {
  return [...findings]
    .map(capFinding)
    .sort(
      (a, b) =>
        a.criterion.localeCompare(b.criterion) ||
        a.severity.localeCompare(b.severity),
    );
}

// ---------------------------------------------------------------------------
// Blocker processing
// ---------------------------------------------------------------------------

/** A reviewer's blocking finding: what the two checks below work on. */
function isReviewerBlocker(finding: FindingT): boolean {
  return finding.severity === "blocking" && finding.author !== "code";
}

/**
 * `finding` as advisory, with `why` appended to its note. Room is left for
 * `why`: a long note is cut, never the reason for the downgrade.
 */
function downgraded(finding: FindingT, why: string): FindingT {
  const note = finding.note?.trim() ?? "";
  const room = MAX_EVIDENCE_CHARS - why.length - 1;
  const kept =
    note.length <= room
      ? note
      : note.slice(0, Math.max(0, room - TRUNCATION_MARKER.length)) +
        TRUNCATION_MARKER;
  return {
    ...finding,
    severity: "advisory",
    note: kept === "" ? why : `${kept} ${why}`,
  };
}

/**
 * A `path:line` inside free text. The path may not hold whitespace, a colon
 * or a bracket or quote that would wrap it; the line is digits.
 */
const PATH_LINE = /([^\s:()[\]{}<>"'`,;]+):(\d+)/g;

/**
 * The file and line a finding cites: its `citation` when it has one,
 * otherwise the first `path:line` in its `evidence`. Skipped as not being
 * one: a token right after a colon (the port of `http://host:8080`, the
 * column of `file.ts:12:5`), an all-digit path (`12:30`), and line 0.
 */
export function citationOf(
  finding: FindingT,
): { path: string; line: number } | undefined {
  if (finding.citation !== undefined) return finding.citation;
  // Bounded: evidence is reviewer-supplied and of any length.
  const evidence = finding.evidence?.slice(0, MAX_CITATION_SCAN_CHARS);
  if (evidence === undefined) return undefined;
  for (const match of evidence.matchAll(PATH_LINE)) {
    const path = match[1]!;
    const line = Number(match[2]);
    if (match.index > 0 && evidence[match.index - 1] === ":") continue;
    if (/^\d+$/.test(path)) continue;
    if (!Number.isSafeInteger(line) || line < 1) continue;
    return { path, line };
  }
  return undefined;
}

/** Lines in a file: a trailing newline ends the last line, it starts none. */
function lineCount(content: string): number {
  if (content === "") return 0;
  const parts = content.split("\n").length;
  return content.endsWith("\n") ? parts - 1 : parts;
}

/**
 * The verdict with unresolvable reviewer blockers downgraded to advisory.
 *
 * `read` returns the content of a cited path in the reviewed tree, or
 * undefined when the tree has no such file. A blocker resolves when it
 * cites a file `read` returns and a line no greater than that file's line
 * count. One that does not is kept as advisory, with
 * {@link CITATION_DOWNGRADE_NOTE} appended to its note. Findings the core
 * wrote (`author: "code"`) are never touched. With no `tree` the work is
 * bound to nothing a citation could be checked against: the check is
 * skipped and every blocker stands.
 */
export function checkCitations(
  verdict: VerdictT,
  tree: string | undefined,
  read: (path: string) => string | undefined,
): VerdictT {
  if (tree === undefined) return verdict;
  // One read per cited path, however many findings cite it: `read` is a
  // synchronous git call in the coordinator.
  const lines = new Map<string, number | undefined>();
  const linesIn = (path: string): number | undefined => {
    if (!lines.has(path)) {
      const content = read(path);
      lines.set(path, content !== undefined ? lineCount(content) : undefined);
    }
    return lines.get(path);
  };
  let changed = false;
  const findings = verdict.findings.map((finding) => {
    if (!isReviewerBlocker(finding)) return finding;
    const citation = citationOf(finding);
    if (citation !== undefined) {
      const count = linesIn(citation.path);
      if (count !== undefined && citation.line <= count) return finding;
    }
    changed = true;
    return downgraded(finding, CITATION_DOWNGRADE_NOTE);
  });
  return changed ? { ...verdict, findings } : verdict;
}

/** One blocker as a recheck request lists it. */
export interface NumberedBlocker {
  /** 1-based, in the verdict's own order. */
  n: number;
  criterion: string;
  note?: string;
  citation?: { path: string; line: number };
}

/**
 * The reviewer blockers of a verdict, numbered for a recheck: the same
 * enumeration {@link applyRecheck} reads the answers against. Capped at
 * {@link MAX_FINDINGS}; a blocker past the cap is never asked about and so
 * stands.
 */
export function recheckBlockers(verdict: VerdictT): NumberedBlocker[] {
  return verdict.findings
    .filter(isReviewerBlocker)
    .slice(0, MAX_FINDINGS)
    .map((finding, index) => {
      const capped = capFinding(finding);
      // From the finding as reported, so it is the citation the citation
      // check resolved, wherever in the evidence it was.
      const citation = citationOf(finding);
      return {
        n: index + 1,
        criterion: capped.criterion,
        ...(capped.note !== undefined ? { note: capped.note } : {}),
        ...(citation !== undefined
          ? {
              citation: {
                path: truncate(citation.path, MAX_EVIDENCE_CHARS),
                line: citation.line,
              },
            }
          : {}),
      };
    });
}

/**
 * The verdict with the recheck's answers applied. It can only take a
 * blocker away: `downgrade` turns blocker `n` into advisory with the
 * reviewer's reason appended to its note; `keep`, no answer, or an `n` that
 * names no blocker leaves everything as it was. Two answers for one `n`:
 * `keep` wins.
 */
export function applyRecheck(
  verdict: VerdictT,
  answers: BlockerRecheckT["answers"],
): VerdictT {
  const reasons = new Map<number, string | undefined>();
  for (const answer of answers) {
    if (answer.decision === "keep") reasons.set(answer.n, undefined);
    else if (!reasons.has(answer.n)) reasons.set(answer.n, answer.reason);
  }
  let n = 0;
  let changed = false;
  const findings = verdict.findings.map((finding) => {
    if (!isReviewerBlocker(finding)) return finding;
    n += 1;
    const reason = n <= MAX_FINDINGS ? reasons.get(n) : undefined;
    if (reason === undefined) return finding;
    changed = true;
    const why = truncate(reason.trim(), MAX_RECHECK_REASON_CHARS);
    return downgraded(finding, `[Not a blocker on a second look: ${why}]`);
  });
  return changed ? { ...verdict, findings } : verdict;
}

/**
 * Digest over an implementation result's artifact list (order-insensitive).
 * NOTE: an empty artifact list digests to a constant — two failed attempts
 * with no artifacts and identical blocking findings escalate on the second
 * attempt BY DESIGN (escalation is recoverable via re-approve).
 */
export function artifactDigest(artifacts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const artifact of [...artifacts].sort()) {
    hash.update(artifact);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/**
 * The failure fingerprint stored in `workgraph_failure_fingerprint`:
 * sha256 over the canonical JSON of the BLOCKING findings plus a digest of
 * the implementation result being judged. `digest` is the RESULT TREE when
 * the work was snapshotted, so the fingerprint follows file content: the
 * same findings on changed content are a new failure, not a repeat. When no
 * tree exists (tree binding off, or no git repository) it falls back to
 * {@link artifactDigest}, which only sees the artifact path list. A repeated
 * blocking verdict on an unchanged digest escalates instead of relaunching
 * revisions (decision log). A finding's `citation` is left out on purpose:
 * the same complaint on the same tree is a repeat even when the reviewer
 * cites another line.
 */
export function failureFingerprint(
  blocking: readonly FindingT[],
  digest: string,
): string {
  const canonical = canonicalFindings(blocking).map((f) => ({
    criterion: f.criterion,
    severity: f.severity,
    ...(f.note !== undefined ? { note: f.note } : {}),
    ...(f.evidence !== undefined ? { evidence: f.evidence } : {}),
    // Only when set, so a reviewer finding hashes as it always did.
    ...(f.author !== undefined ? { author: f.author } : {}),
  }));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .update("\u0000")
    .update(digest)
    .digest("hex");
}

/**
 * The compact summary written to `workgraph_last_verdict` metadata:
 * severity counts plus the first blocking (else first) criterion, capped.
 * With numbered `criteria` (the `criteria-evidence` gate was evaluated for
 * an issue that has some) the counts gain `criteria=<met>/<total>`; without
 * them the summary reads as it always did. The label follows the blocking
 * findings alone, so `pass ... criteria=1/2` is a verdict with no blocker
 * and an unanswered criterion: the count is where that shows.
 */
export function verdictSummary(
  verdict: VerdictT,
  criteria: readonly Criterion[] = [],
): string {
  const blocking = blockingFindings(verdict);
  const advisory = verdict.findings.length - blocking.length;
  const head = blocking[0]?.criterion ?? verdict.findings[0]?.criterion;
  const label = blocking.length > 0 ? "reject" : "pass";
  const answered =
    criteria.length > 0
      ? ` criteria=${evaluateCriteria(criteria, verdict).met.length}/${criteria.length}`
      : "";
  const parts = [
    `${label} blocking=${blocking.length} advisory=${advisory}${answered}`,
  ];
  if (head) parts.push(head);
  return truncate(parts.join(": "), MAX_SUMMARY_CHARS);
}

/** The capped findings of a record, and how many were folded away. */
function cappedFindings(verdict: VerdictT): {
  findings: FindingT[];
  foldedFindings?: number;
} {
  const capped = canonicalFindings(verdict.findings);
  const folded = capped.length - MAX_FINDINGS;
  return {
    findings: capped.slice(0, MAX_FINDINGS),
    ...(folded > 0 ? { foldedFindings: folded } : {}),
  };
}

async function writeRecord(
  cwd: string,
  issueId: string,
  text: string,
  actor: string | undefined,
): Promise<void> {
  try {
    await addComment(cwd, issueId, text, actor);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Loud AND blocking — judgment must not proceed without the record.
    console.error(`[pi-workgraph] VERDICT WRITE FAILED (${issueId}): ${msg}`);
    throw new VerdictWriteError(issueId, msg);
  }
}

/**
 * Persist one verdict as a machine-readable comment:
 * `workgraph-verdict verdict {json}` — findings capped/truncated, the
 * reviewer's criterion answers (capped at {@link MAX_CRITERIA}, evidence
 * truncated) when it gave any, and extra context (`details`: workflowRunId,
 * executionId, reviewer provenance, attempt, and `tree` — the result tree
 * the verdict judged, when one was recorded) folded in. `criteria` are the
 * issue's numbered criteria, for the summary's count. REJECTS with
 * {@link VerdictWriteError} when the write fails, unlike `recordLeaseEvent`:
 * the caller must not close an issue whose verdict was not recorded (see the
 * module comment).
 */
export async function recordVerdict(
  cwd: string,
  issueId: string,
  verdict: VerdictT,
  details: Record<string, unknown>,
  actor?: string,
  criteria: readonly Criterion[] = [],
): Promise<void> {
  const answers = verdict.criteria;
  const payload = {
    ...details,
    summary: verdictSummary(verdict, criteria),
    ...cappedFindings(verdict),
    ...(answers !== undefined
      ? {
          criteria: answers.slice(0, MAX_CRITERIA).map(capAnswer),
          ...(answers.length > MAX_CRITERIA
            ? { foldedCriteria: answers.length - MAX_CRITERIA }
            : {}),
        }
      : {}),
  };
  await writeRecord(
    cwd,
    issueId,
    `${VERDICT_MARKER}${JSON.stringify(payload)}`,
    actor,
  );
}

/**
 * Persist what the blocker checks made of a verdict, as a second comment:
 * `workgraph-verdict recheck {json}`. `verdict` is the verdict AFTER the
 * citation check and the recheck; `details` says how it got there (the
 * recheck's outcome and answers, the count of citation downgrades). The
 * first comment keeps the reviewer's reply as reported, so the trail shows
 * both. REJECTS with {@link VerdictWriteError} like {@link recordVerdict};
 * the caller decides whether a close could rest on this record.
 */
export async function recordRecheck(
  cwd: string,
  issueId: string,
  verdict: VerdictT,
  details: Record<string, unknown>,
  actor?: string,
  criteria: readonly Criterion[] = [],
): Promise<void> {
  const payload = {
    ...details,
    summary: verdictSummary(verdict, criteria),
    ...cappedFindings(verdict),
  };
  await writeRecord(
    cwd,
    issueId,
    `${RECHECK_MARKER}${JSON.stringify(payload)}`,
    actor,
  );
}

/**
 * The newest verdict record on an issue, as the JSON object it was written
 * as, or undefined when the issue has none. A comment under the marker that
 * does not parse is skipped, never thrown.
 */
export async function latestVerdictRecord(
  cwd: string,
  issueId: string,
): Promise<Record<string, unknown> | undefined> {
  const comments = await listComments(cwd, issueId);
  for (let i = comments.length - 1; i >= 0; i--) {
    const text = comments[i]!.text;
    if (!text.startsWith(VERDICT_MARKER)) continue;
    try {
      const raw: unknown = JSON.parse(text.slice(VERDICT_MARKER.length));
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
      }
    } catch {
      // Not a readable record: keep looking.
    }
  }
  return undefined;
}

/**
 * The context a recorded review ran in, as its executor reported it
 * (`reviewerProvenance.context`: `fresh` for a run launched with no memory
 * of the implementation), or undefined when the record names none.
 */
export function reviewContextOf(
  record: Record<string, unknown> | undefined,
): string | undefined {
  const provenance = record?.reviewerProvenance;
  if (provenance === null || typeof provenance !== "object") return undefined;
  const context = (provenance as { context?: unknown }).context;
  return typeof context === "string" && context !== "" ? context : undefined;
}
