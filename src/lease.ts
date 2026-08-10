/**
 * The lease layer: TTL + fencing over bd's primitives.
 *
 * bd's atomic `--claim` is the mutex; the lease metadata trio
 * (`lease_holder`, `lease_epoch`, `lease_expires_at`) is the bookkeeping
 * that makes claims safe for unattended workers. bd has NO CAS, so the
 * fencing token (`lease_epoch`) is mandatory: acquisition increments the
 * epoch, every subsequent holder write first re-reads and verifies its epoch
 * is still current, and a stale holder that wakes up after a reclaim finds a
 * higher epoch and aborts.
 *
 * Only this module exports write paths for lease-held issues — a holder
 * write that skips `verifyHolding` is how a stale write lands (review
 * checklist item).
 *
 * Config (TTL), time (`now()`), and IDENTITY (`LeaseActor`) are injected
 * parameters, never read from an ExtensionAPI or module global here — tests
 * compress timers to seconds and shift clocks deterministically; worker
 * child processes receive them via `WORKGRAPH_*` env vars. This module must
 * never import `identity.ts`: ambient identity inside a lease op is how
 * run-scoped fencing gets silently bypassed.
 */
import { recordLeaseEvent } from "./audit.ts";
import { claim, claimNext, release, setMetadata, show } from "./bd.ts";
import type { BeadsIssue, Lease, LeaseActor } from "./types.ts";
import {
  LEASE_EPOCH_KEY,
  LEASE_EXPIRES_AT_KEY,
  LEASE_HOLDER_KEY,
} from "./types.ts";

/**
 * Thrown when a holder write discovers its lease was reclaimed (the issue's
 * epoch moved past the held one, or the holder changed).
 */
export class FencingError extends Error {
  readonly issueId: string;
  readonly heldEpoch: number;
  readonly currentEpoch: number;
  readonly currentHolder: string;

  constructor(
    issueId: string,
    heldEpoch: number,
    currentEpoch: number,
    currentHolder: string,
  ) {
    super(
      `Lease on ${issueId} was reclaimed by ${currentHolder} ` +
        `(epoch ${currentEpoch}, you held ${heldEpoch}); do not continue this issue`,
    );
    this.name = "FencingError";
    this.issueId = issueId;
    this.heldEpoch = heldEpoch;
    this.currentEpoch = currentEpoch;
    this.currentHolder = currentHolder;
  }
}

// ---------------------------------------------------------------------------
// Metadata readers — bd stores numeric-looking values as JSON numbers but
// `metadata` is typed `Record<string, unknown>`; normalize, never trust.
// ---------------------------------------------------------------------------

/** The issue's fencing epoch; 0 when absent/garbled (never-leased issues). */
export function leaseEpochOf(issue: BeadsIssue): number {
  const raw = issue.metadata?.[LEASE_EPOCH_KEY];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** The issue's lease holder, if any. */
export function leaseHolderOf(issue: BeadsIssue): string | undefined {
  const raw = issue.metadata?.[LEASE_HOLDER_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** The issue's lease expiry (RFC3339), if any. */
export function leaseExpiresAtOf(issue: BeadsIssue): string | undefined {
  const raw = issue.metadata?.[LEASE_EXPIRES_AT_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** RFC3339 UTC at second precision (bd's `updated_at` granularity). */
export function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Held-lease registry. The heartbeat tool has no parameters — what it renews
// is whatever this process acquired and still holds. Keyed by (cwd, issueId)
// because tests (and multi-workspace sessions) hold leases in several
// workspaces at once.
// ---------------------------------------------------------------------------

/** A tracked lease plus the workspace it lives in and the acquiring actor. */
export interface HeldLease extends Lease {
  cwd: string;
  /** The actor used at acquire time; renew/release/close reuse it. */
  actor: LeaseActor;
}

const held = new Map<string, HeldLease>();

function heldKey(cwd: string, issueId: string): string {
  return `${cwd}\u0000${issueId}`;
}

/** Track a lease this process holds (acquire/reclaim call this). */
export function trackLease(cwd: string, lease: Lease, actor: LeaseActor): void {
  held.set(heldKey(cwd, lease.issueId), { ...lease, cwd, actor });
}

/** Stop tracking (release, fencing loss, or external cleanup). */
export function untrackLease(cwd: string, issueId: string): void {
  held.delete(heldKey(cwd, issueId));
}

/** Leases this process holds in `cwd`, in insertion order. */
export function heldLeases(cwd: string): HeldLease[] {
  return [...held.values()].filter((l) => l.cwd === cwd);
}

/** The held lease for one issue in `cwd`, if any. */
export function getHeldLease(cwd: string, issueId: string): HeldLease | undefined {
  return held.get(heldKey(cwd, issueId));
}

/** Test-only: forget every held lease. */
export function resetLeasesForTest(): void {
  held.clear();
}

// ---------------------------------------------------------------------------
// The epoch protocol
// ---------------------------------------------------------------------------

export interface AcquireOptions {
  /** Claim this specific issue; omit to atomically claim the next ready one. */
  issueId?: string;
  /** Lease time-to-live in milliseconds. */
  ttlMs: number;
  /** Clock injection for tests (default Date.now). */
  now?: () => number;
  /** The identity to acquire as: `holder` is stamped on the lease, `bdActor`
   *  attributes the bd writes. Required — this module has no ambient
   *  identity to fall back on. */
  actor: LeaseActor;
}

export type AcquireOutcome =
  /** Claimed and lease stamped; `renewal` when this worker already held it. */
  | { kind: "acquired"; lease: Lease; issue: BeadsIssue; renewal: boolean }
  /** Nothing ready to claim (claim-next path only). */
  | { kind: "empty" }
  /** The stamp was overwritten between claim and verification — extremely
   *  narrow, still handled; caller moves on to other work. */
  | { kind: "lost-race"; issueId: string };

/**
 * Acquire a lease: piggyback on bd's atomic claim, then stamp the lease
 * metadata. Acquisition order is claim-then-stamp — bd's claim is the mutex,
 * the stamp is bookkeeping — and the narrow window between them is closed by
 * post-write verification (same-key metadata races are last-writer-wins),
 * not by pretending the sequence is atomic.
 *
 * Re-acquiring an issue this worker already holds (bd's claim is idempotent
 * for the same actor) is treated as a RENEWAL: the epoch does not
 * double-increment.
 *
 * Throws BdError on a claim conflict (`already claimed by ...` verbatim).
 */
export async function acquireLease(
  cwd: string,
  opts: AcquireOptions,
): Promise<AcquireOutcome> {
  const nowFn = opts.now ?? Date.now;
  const me = opts.actor.holder;
  const actor = opts.actor.bdActor;

  let issue: BeadsIssue;
  if (opts.issueId) {
    await claim(cwd, opts.issueId, actor); // atomic; throws on conflict
    issue = await show(cwd, opts.issueId);
  } else {
    const next = await claimNext(cwd, actor); // atomic claim-next
    if (!next) return { kind: "empty" }; // empty pool: [], exit 0
    issue = next;
  }

  // Epoch is read fresh from the issue at every acquire (never cached), so a
  // retry after partial failure cannot double-increment; gaps are harmless —
  // monotonicity is the invariant, not density.
  const renewal = leaseHolderOf(issue) === me && leaseEpochOf(issue) > 0;
  const epoch = renewal ? leaseEpochOf(issue) : leaseEpochOf(issue) + 1;
  const expiresAt = rfc3339(nowFn() + opts.ttlMs);

  await setMetadata(
    cwd,
    issue.id,
    {
      [LEASE_HOLDER_KEY]: me,
      [LEASE_EPOCH_KEY]: String(epoch),
      [LEASE_EXPIRES_AT_KEY]: expiresAt,
    },
    actor,
  );

  // Post-write verification: someone may have reclaimed between our claim
  // and our stamp.
  const check = await show(cwd, issue.id);
  if (leaseHolderOf(check) !== me || leaseEpochOf(check) !== epoch) {
    await recordLeaseEvent(
      cwd,
      "lost-acquisition-race",
      issue.id,
      {
        attemptedEpoch: epoch,
        attemptedHolder: me,
        observedEpoch: leaseEpochOf(check),
        observedHolder: leaseHolderOf(check) ?? null,
      },
      actor,
    );
    return { kind: "lost-race", issueId: issue.id };
  }

  const lease: Lease = { issueId: issue.id, epoch, expiresAt };
  trackLease(cwd, lease, opts.actor);
  await recordLeaseEvent(
    cwd,
    renewal ? "renew" : "claim",
    issue.id,
    { epoch, holder: me, expires: expiresAt },
    actor,
  );
  return { kind: "acquired", lease, issue: check, renewal };
}

/**
 * The gate every holder write goes through: re-read the issue and confirm
 * this lease's epoch is still current and `holder` is still the holder.
 * The expected holder is passed by the caller — this function has zero
 * ambient identity. Holders never trust cached lease state across an await
 * gap longer than the heartbeat.
 */
export async function verifyHolding(
  cwd: string,
  lease: Lease,
  holder: string,
): Promise<boolean> {
  const cur = await show(cwd, lease.issueId);
  return leaseEpochOf(cur) === lease.epoch && leaseHolderOf(cur) === holder;
}

export interface RenewOptions {
  /** Lease time-to-live in milliseconds (new expiry = now + ttl). */
  ttlMs: number;
  /** Clock injection for tests (default Date.now). */
  now?: () => number;
  /** The identity renewing: `holder` is fenced against, `bdActor` attributes
   *  the bd writes. Required — no ambient identity here. */
  actor: LeaseActor;
}

/**
 * Heartbeat: verify the epoch, then push `lease_expires_at` forward. The
 * metadata write bumps `updated_at`, so a live worker's issue always looks
 * fresh to the expiry sweep. Throws {@link FencingError} (and untracks the
 * lease) when the lease was reclaimed.
 */
export async function renewLease(
  cwd: string,
  lease: Lease,
  opts: RenewOptions,
): Promise<Lease> {
  const nowFn = opts.now ?? Date.now;
  const me = opts.actor.holder;
  const actor = opts.actor.bdActor;

  const cur = await show(cwd, lease.issueId);
  if (leaseEpochOf(cur) !== lease.epoch || leaseHolderOf(cur) !== me) {
    untrackLease(cwd, lease.issueId);
    throw new FencingError(
      lease.issueId,
      lease.epoch,
      leaseEpochOf(cur),
      leaseHolderOf(cur) ?? cur.assignee ?? "unknown",
    );
  }

  const expiresAt = rfc3339(nowFn() + opts.ttlMs);
  await setMetadata(cwd, lease.issueId, { [LEASE_EXPIRES_AT_KEY]: expiresAt }, actor);
  const renewed: Lease = { ...lease, expiresAt };
  trackLease(cwd, renewed, opts.actor);
  await recordLeaseEvent(
    cwd,
    "renew",
    lease.issueId,
    { epoch: lease.epoch, holder: me, expires: expiresAt },
    actor,
  );
  return renewed;
}

/**
 * Voluntary release of a held lease: verify the epoch (a reclaimed lease
 * must not be "released" out from under the new holder — throws
 * {@link FencingError}), then clear the assignee, reopen, and unset the
 * holder/expiry metadata. `lease_epoch` survives on the issue: the fencing
 * token is monotonic per issue and never resets across release/re-acquire
 * cycles.
 */
export async function releaseLease(
  cwd: string,
  lease: Lease,
  releaseActor: LeaseActor,
): Promise<void> {
  const me = releaseActor.holder;
  const actor = releaseActor.bdActor;

  const cur = await show(cwd, lease.issueId);
  if (leaseEpochOf(cur) !== lease.epoch || leaseHolderOf(cur) !== me) {
    untrackLease(cwd, lease.issueId);
    throw new FencingError(
      lease.issueId,
      lease.epoch,
      leaseEpochOf(cur),
      leaseHolderOf(cur) ?? cur.assignee ?? "unknown",
    );
  }

  await release(cwd, lease.issueId, actor);
  untrackLease(cwd, lease.issueId);
  await recordLeaseEvent(
    cwd,
    "release",
    lease.issueId,
    { epoch: lease.epoch, holder: me },
    actor,
  );
}
