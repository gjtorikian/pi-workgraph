/**
 * Lease + lifecycle audit trail. bd's own audit surface records NOTHING for
 * `--claim` or `--set-metadata` writes (verified), and bd 1.1.2 has no
 * `bd audit` subcommand, so every lease transition emits its own record as
 * an issue comment (`bd comment`; read back via `bd comments <id> --json` —
 * the mechanism that round-trips cleanly through JSON reads).
 *
 * Phase 3 extends the {@link LeaseEvent} union with structured
 * lifecycle/execution/judgment kinds (approve, override, review-rejected,
 * verdict-invalid, revision-requested, escalated, judgment-closed) so the
 * whole trail stays greppable under ONE prefix; verdict payloads have their
 * own prefix (`src/verdict.ts`'s `workgraph-verdict`) because they are
 * data, not events. Callers embed an immutable actor snapshot
 * (`identitySnapshot` in identity.ts) in `details` for events whose
 * attribution must survive later mutation of the acting identity.
 *
 * Audit failures log loudly but NEVER block lease operations: the lease
 * protocol stays correct without the trail, and a broken audit surface must
 * not take claiming down with it.
 */
import { addComment } from "./bd.ts";
import type { LeaseEvent } from "./types.ts";

/** Prefix on every audit comment; tests and humans grep for it. */
export const AUDIT_PREFIX = "workgraph-lease";

/**
 * Renew events are recorded at 1-per-N per issue (the 1st, N+1th, ...) —
 * a heartbeat every 60 s would otherwise bury the trail in renew spam.
 */
export const RENEW_SAMPLE_RATE = 10;

const renewCounts = new Map<string, number>();

/**
 * Record one lease event on the issue's audit trail. Resolves (never
 * rejects) even when the write fails — see module doc.
 */
export async function recordLeaseEvent(
  cwd: string,
  kind: LeaseEvent,
  issueId: string,
  details: Record<string, unknown>,
  actor?: string,
): Promise<void> {
  let payload = details;
  if (kind === "renew") {
    const count = (renewCounts.get(issueId) ?? 0) + 1;
    renewCounts.set(issueId, count);
    if ((count - 1) % RENEW_SAMPLE_RATE !== 0) return;
    payload = { ...details, renewCount: count };
  }
  const text = `${AUDIT_PREFIX} ${kind} ${JSON.stringify(payload)}`;
  try {
    await addComment(cwd, issueId, text, actor);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Loud, but non-blocking — the lease op that triggered this must proceed.
    console.error(
      `[pi-workgraph] AUDIT WRITE FAILED (${kind} on ${issueId}): ${msg}`,
    );
  }
}

/** Test-only: reset renew sampling counters. */
export function resetAuditForTest(): void {
  renewCounts.clear();
}
