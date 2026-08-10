/**
 * Structured verdicts: validation, comment persistence, and failure
 * fingerprints.
 *
 * TRANSPORT: protocol-v1 schemas are non-strict, so a reviewer completion
 * carries its verdict as an extra `verdict` field on `run:completed` — no
 * protocol change. This module validates that payload against the shared
 * {@link Verdict} schema before the judgment gate acts on it; an invalid
 * verdict causes zero state change (the coordinator discards the attempt,
 * audits it, and re-requests within a bounded retry).
 *
 * PERSISTENCE follows the audit-trail pattern (`src/audit.ts`): one
 * machine-readable comment per verdict under a stable prefix, written
 * fire-and-forget (a broken comment surface must not take judgment down),
 * read back via `listComments`. Metadata is NOT an event store (decision
 * log): only the compact summary lands in `workgraph_last_verdict`, riding
 * the same `setMetadata` call as the phase transition.
 *
 * SIZE CAPS (failure-modes table): findings are capped and evidence strings
 * truncated with a marker before serialization, so a reviewer returning
 * huge findings can never produce an unwritable/unreadable comment.
 */
import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { addComment } from "./bd.ts";
import type { FindingT, VerdictT } from "./types.ts";
import { Verdict } from "./types.ts";

/** Prefix on every verdict comment; tests and humans grep for it. */
export const VERDICT_PREFIX = "workgraph-verdict";

/** Cap on findings persisted per verdict (the rest fold into a count). */
export const MAX_FINDINGS = 50;

/** Cap on a single evidence/note string before truncation. */
export const MAX_EVIDENCE_CHARS = 400;

/** Marker appended to truncated strings. */
export const TRUNCATION_MARKER = "…[truncated]";

/** Cap on the compact `workgraph_last_verdict` summary value. */
export const MAX_SUMMARY_CHARS = 160;

/** Thrown when a reported verdict payload fails schema validation. */
export class VerdictError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Invalid verdict payload: ${detail}`);
    this.name = "VerdictError";
    this.detail = detail;
  }
}

/**
 * Validate a reported verdict payload. Returns the typed verdict or throws
 * {@link VerdictError}; a missing payload (`undefined`) is invalid — the
 * judgment gate never infers a verdict from silence.
 */
export function parseVerdict(raw: unknown): VerdictT {
  if (Value.Check(Verdict, raw)) return raw;
  const detail = [...Value.Errors(Verdict, raw)]
    .slice(0, 3)
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
  throw new VerdictError(detail || "schema mismatch");
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
  };
}

/**
 * Canonicalize findings for hashing and persistence: sorted by criterion
 * then severity (spec), with a stable key order per finding — so two
 * verdicts differing only in arrival order fingerprint identically.
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
 * sha256 over the canonical JSON of the BLOCKING findings plus the artifact
 * digest of the implementation result being judged. A repeated blocking
 * verdict without a changed artifact digest escalates instead of
 * relaunching revisions (decision log).
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
 */
export function verdictSummary(verdict: VerdictT): string {
  const blocking = blockingFindings(verdict);
  const advisory = verdict.findings.length - blocking.length;
  const head = blocking[0]?.criterion ?? verdict.findings[0]?.criterion;
  const label = blocking.length > 0 ? "reject" : "pass";
  const parts = [`${label} blocking=${blocking.length} advisory=${advisory}`];
  if (head) parts.push(head);
  return truncate(parts.join(": "), MAX_SUMMARY_CHARS);
}

/**
 * Persist one verdict as a machine-readable comment:
 * `workgraph-verdict verdict {json}` — findings capped/truncated, extra
 * context (`details`: workflowRunId, executionId, reviewer provenance,
 * attempt) folded in. Resolves (never rejects) even when the write fails,
 * mirroring `recordLeaseEvent`.
 */
export async function recordVerdict(
  cwd: string,
  issueId: string,
  verdict: VerdictT,
  details: Record<string, unknown>,
  actor?: string,
): Promise<void> {
  const capped = canonicalFindings(verdict.findings);
  const folded = capped.length - MAX_FINDINGS;
  const payload = {
    ...details,
    summary: verdictSummary(verdict),
    findings: capped.slice(0, MAX_FINDINGS),
    ...(folded > 0 ? { foldedFindings: folded } : {}),
  };
  const text = `${VERDICT_PREFIX} verdict ${JSON.stringify(payload)}`;
  try {
    await addComment(cwd, issueId, text, actor);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Loud, but non-blocking — judgment proceeds without the trail.
    console.error(
      `[pi-workgraph] VERDICT WRITE FAILED (${issueId}): ${msg}`,
    );
  }
}
