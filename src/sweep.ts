/**
 * Expiry sweep: two-stage detection, then the non-atomic takeover made safe
 * by fencing.
 *
 * Detection is dual-condition by design (the clock-skew guard):
 *   1. server-side — `bd list --status in_progress --updated-before
 *      <now - TTL>`; a heartbeating worker bumps `updated_at` (local to bd's
 *      clock) on every renewal, so live workers never appear here; and
 *   2. client-side — `lease_expires_at < now()` confirms against the lease
 *      the holder actually wrote.
 * A skewed clock must beat BOTH conditions before work is stolen mid-flight.
 *
 * Reclaim cannot be atomic (bd has no CAS), so it is fenced: the epoch bump
 * lands BEFORE the assignee overwrite, and post-write verification elects
 * exactly one winner when reclaimers race (same shape as acquisition).
 */
import type { EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordLeaseEvent } from "./audit.ts";
import {
  bdBinaryAvailable,
  ensureWorkspace,
  listInProgressUpdatedBefore,
  overwriteAssigneeForReclaim,
  setMetadata,
  show,
} from "./bd.ts";
import type { WorkgraphConfig } from "./config.ts";
import { defaultLeaseActor, workerId } from "./identity.ts";
import {
  FencingError,
  leaseEpochOf,
  leaseExpiresAtOf,
  leaseHolderOf,
  releaseLease,
  rfc3339,
  trackLease,
  untrackLease,
} from "./lease.ts";
import {
  activeExecutionIdOf,
  isActivePhase,
  isLifecycleV1,
  phaseOf,
  workflowRunIdOf,
} from "./lifecycle.ts";
import { CH, newEnvelope, type RunCancelT } from "./protocol.ts";
import type { BeadsIssue, Lease } from "./types.ts";
import {
  LEASE_EPOCH_KEY,
  LEASE_EXPIRES_AT_KEY,
  LEASE_HOLDER_KEY,
  WORKGRAPH_ACTIVE_EXECUTION_ID_KEY,
  WORKGRAPH_PHASE_KEY,
} from "./types.ts";

export interface SweepOptions {
  /** Lease time-to-live in milliseconds (also the `updated_at` staleness cutoff). */
  ttlMs: number;
  /** Clock injection for tests (default Date.now). */
  now?: () => number;
  /** bd `--actor`; defaults to workerId(). */
  actor?: string;
}

/**
 * Stale in_progress claims with NO lease metadata (claimed by a human's
 * manual `bd update --claim`, or by pre-lease Phase 1 code) are flagged
 * `expire-detected` but never auto-reclaimed — stealing a human's claim is
 * worse than a stalled issue. Flag once per issue per process, not once per
 * sweep tick (a 500 ms poll would otherwise bury the issue in comments).
 */
const flaggedLegacyClaims = new Set<string>();

/** Test-only: forget which legacy claims were already flagged. */
export function resetSweepForTest(): void {
  flaggedLegacyClaims.clear();
}

/**
 * Find issues whose leases have expired: server-side staleness filter, then
 * client-side `lease_expires_at` confirmation. Legacy no-lease claims are
 * audited (`expire-detected`) and excluded — see {@link resetSweepForTest}'s
 * doc for why they are never reclaimed.
 */
export async function findExpired(
  cwd: string,
  opts: SweepOptions,
): Promise<BeadsIssue[]> {
  const nowFn = opts.now ?? Date.now;
  const nowMs = nowFn();
  const actor = opts.actor ?? workerId();
  // bd compares timestamps at SECOND precision; round the cutoff UP so
  // flooring it doesn't hide a just-expired lease for an extra second (the
  // reclaim-latency bound is TTL + poll + tolerance, and a rounding second
  // eats most of the tolerance). Being ≤1 s aggressive here is safe: the
  // client-side `lease_expires_at < now` confirmation below is the real
  // guard, and a live heartbeat keeps `updated_at` far fresher than TTL.
  const cutoff = rfc3339(Math.ceil((nowMs - opts.ttlMs) / 1_000) * 1_000);

  const stale = await listInProgressUpdatedBefore(cwd, cutoff);
  const expired: BeadsIssue[] = [];
  for (const issue of stale) {
    const expiresAt = leaseExpiresAtOf(issue);
    if (expiresAt === undefined) {
      if (!flaggedLegacyClaims.has(issue.id)) {
        flaggedLegacyClaims.add(issue.id);
        await recordLeaseEvent(
          cwd,
          "expire-detected",
          issue.id,
          {
            assignee: issue.assignee ?? null,
            updatedAt: issue.updated_at ?? null,
            note: "stale in_progress claim with no lease metadata; NOT auto-reclaimed",
          },
          actor,
        );
      }
      continue;
    }
    if (Date.parse(expiresAt) < nowMs) expired.push(issue);
  }
  return expired;
}

/**
 * Fenced takeover of an expired lease. The epoch bump lands BEFORE the
 * assignee overwrite: a stale holder verifying mid-reclaim already sees the
 * new epoch and aborts, even though its assignee value is momentarily
 * intact. Two concurrent reclaimers race on last-writer-wins metadata;
 * post-write verification elects exactly one — the loser returns null.
 */
export async function reclaim(
  cwd: string,
  issue: BeadsIssue,
  opts: SweepOptions,
): Promise<Lease | null> {
  const nowFn = opts.now ?? Date.now;
  const me = workerId();
  const actor = opts.actor ?? me;

  const oldEpoch = leaseEpochOf(issue);
  const oldHolder = leaseHolderOf(issue) ?? issue.assignee ?? "unknown";
  const oldExpiresAt = leaseExpiresAtOf(issue) ?? null;
  const epoch = oldEpoch + 1;
  const expiresAt = rfc3339(nowFn() + opts.ttlMs);

  // The takeover: epoch fence and assignee overwrite in ONE bd update, so
  // there is no window where the assignee moved but the epoch did not (and
  // reclaim latency stays inside the contract's TTL + poll + tolerance
  // bound — every extra serialized write here counts against it).
  await overwriteAssigneeForReclaim(
    cwd,
    issue.id,
    me,
    {
      [LEASE_HOLDER_KEY]: me,
      [LEASE_EPOCH_KEY]: String(epoch),
      [LEASE_EXPIRES_AT_KEY]: expiresAt,
    },
    actor,
  );

  const check = await show(cwd, issue.id);
  if (leaseEpochOf(check) !== epoch || leaseHolderOf(check) !== me) {
    return null; // lost the reclaim race — exactly one winner
  }

  const lease: Lease = { issueId: issue.id, epoch, expiresAt };
  trackLease(cwd, lease, { holder: me, bdActor: actor });
  // Deliberately NOT awaited: the reclaim is complete once the fenced
  // takeover verifies; the audit record must never add to (or block) the
  // reclaim latency. The exec queue still serializes it before any later bd
  // call from this process, and recordLeaseEvent never rejects.
  void recordLeaseEvent(
    cwd,
    "reclaim",
    issue.id,
    {
      from: oldHolder,
      oldEpoch,
      epoch,
      expiredAt: oldExpiresAt,
      expires: expiresAt,
      note: "lease expired; partial work may exist on the previous holder's branch",
    },
    actor,
  );
  return lease;
}

/**
 * The coordinator-aware reclaim composition (phase 4): fenced takeover of an
 * expired lease, best-effort `run:cancel` for the RECORDED execution (the
 * old executor may still be running — or may be gone; the emit has no
 * failure signal, so the attempt is audited and TTL + fencing remain the
 * real guarantee), a phase reset so the issue is REDISPATCHABLE (the
 * coordinator claims only phase-`ready` lifecycle-v1 issues — without the
 * reset a reclaimed `implementing` issue would sit in the pool forever),
 * and the leave-ready release.
 *
 * `reclaim()` itself is deliberately untouched (its direct-call takeover
 * behavior is asserted by four suites); this composes around it. The
 * metadata reset clears ONLY `workgraph_phase` (→ ready) and
 * `workgraph_active_execution_id` (→ "" — bd's setMetadata cannot unset;
 * readers normalize empty to undefined). `workgraph_failure_fingerprint`
 * and `workgraph_attempt` survive by design: fingerprint history must
 * persist across reclaims (decision log).
 *
 * Returns true when this caller won the reclaim (and the issue was left
 * ready), false on a lost race. FencingError during the release means a
 * concurrent claimant took the issue between reclaim and release — theirs
 * now, registry cleaned. Other errors propagate to the caller's skip-log.
 */
export async function reclaimAndLeaveReady(
  cwd: string,
  issue: BeadsIssue,
  opts: SweepOptions,
  events?: EventBus,
): Promise<boolean> {
  const nowFn = opts.now ?? Date.now;
  // Captured BEFORE the takeover: the reclaim rewrites lease metadata.
  const workflowRunId = workflowRunIdOf(issue);
  const executionId = activeExecutionIdOf(issue);
  const phase = phaseOf(issue);
  const v1 = isLifecycleV1(issue);

  const lease = await reclaim(cwd, issue, opts);
  if (!lease) return false; // lost the reclaim race — exactly one winner

  const actor = opts.actor ?? workerId();

  // Best-effort cancellation of the recorded execution under the OLD run:
  // the executor treats a cancel for an unknown/finished run as a no-op ack.
  if (events && workflowRunId) {
    const cancel: RunCancelT = {
      ...newEnvelope(nowFn),
      workflowRunId,
      issueId: issue.id,
      ...(executionId !== undefined ? { executionId } : {}),
      reason: "lease expired and reclaimed",
    };
    events.emit(CH.runCancel, cancel);
    // Fire-and-forget (the reclaim audit precedent): the attempt is
    // recorded, never awaited on the reclaim path.
    void recordLeaseEvent(
      cwd,
      "cancel-published",
      issue.id,
      {
        workflowRunId,
        ...(executionId !== undefined ? { executionId } : {}),
        via: "sweep-reclaim",
      },
      actor,
    );
  }

  // Redispatchability reset — one write, phase + execution-id together.
  const kv: Record<string, string> = {};
  if (v1 && isActivePhase(phase)) kv[WORKGRAPH_PHASE_KEY] = "ready";
  if (executionId !== undefined) kv[WORKGRAPH_ACTIVE_EXECUTION_ID_KEY] = "";
  if (Object.keys(kv).length > 0) {
    await setMetadata(cwd, issue.id, kv, actor);
  }

  // Leave-ready: release the lease we just reclaimed (fenced, audited) so
  // the issue reopens for the next dispatcher and never lingers in this
  // session's held-lease registry.
  try {
    await releaseLease(cwd, lease, { holder: workerId(), bdActor: actor });
  } catch (e) {
    untrackLease(cwd, issue.id);
    if (!(e instanceof FencingError)) throw e;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Production sweep wiring: a serialized timer that runs findExpired() +
// reclaim() every tick, mirroring registerDispatch's discipline. Every Pi
// session runs one; cross-process safety comes from the fencing epochs (two
// sweepers racing one expired lease elect exactly one winner).
// ---------------------------------------------------------------------------

export interface SweepDeps {
  /** Effective config; resolved lazily (flags are not readable at load). */
  getConfig: () => WorkgraphConfig;
  /** Clock injection for tests (default Date.now). */
  now?: () => number;
}

/** Handle returned by {@link registerSweep}; tests drive ticks directly. */
export interface SweepController {
  /** One sweep pass. Reentrant calls no-op (suppressed, not queued). */
  tick(ctx: ExtensionContext): Promise<void>;
  /** Idempotent shutdown: stop the timer. */
  teardown(): void;
  /** Timer liveness, for lifecycle tests. */
  timerActive(): boolean;
}

/**
 * Register the expiry sweep: a timer started on `session_start` (interval
 * `config.sweepIntervalMs` — the floor is applied at the index.ts wiring
 * layer, never here, so tests inject tiny intervals), stopped on
 * `session_shutdown`. Each tick finds expired leases and reclaims them, then
 * immediately releases the reclaimed lease so the issue lands back in the
 * `ready` pool for whatever dispatcher runs next — the sweep never
 * redispatches, and the sweeper's own held-lease registry stays empty (a
 * sweep-reclaimed issue is NOT this session's work).
 */
export function registerSweep(pi: ExtensionAPI, deps: SweepDeps): SweepController {
  const nowFn = deps.now ?? Date.now;

  const state = {
    timer: null as ReturnType<typeof setInterval> | null,
    /** In-flight tick guard — set synchronously before any await, so a tick
     *  that fires while the previous one is still running is suppressed. */
    ticking: false,
    /** Last skip reason logged — log once per state change, not per tick. */
    lastSkipLog: null as string | null,
  };

  function logSkipOnce(reason: string): void {
    if (state.lastSkipLog === reason) return;
    state.lastSkipLog = reason;
    console.error(`[pi-workgraph] sweep skipping: ${reason}`);
  }

  function clearSkipLog(): void {
    state.lastSkipLog = null;
  }

  async function tick(ctx: ExtensionContext): Promise<void> {
    if (state.ticking) return; // reentrant tick — checked/set before any await
    state.ticking = true;
    try {
      await tickInner(ctx);
    } catch (e) {
      // Transient bd trouble: log once, retry next tick.
      const msg = e instanceof Error ? e.message : String(e);
      logSkipOnce(msg);
    } finally {
      state.ticking = false;
    }
  }

  async function tickInner(ctx: ExtensionContext): Promise<void> {
    if (!bdBinaryAvailable()) {
      logSkipOnce("bd CLI not found");
      return;
    }
    try {
      await ensureWorkspace(ctx.cwd);
    } catch {
      // No .beads/ here — the sweep stays inert. ensureWorkspace does not
      // cache failures, so a mid-session `bd init` is picked up.
      return;
    }

    const config = deps.getConfig();
    const opts: SweepOptions = {
      ttlMs: config.leaseTtlMs,
      now: nowFn,
      actor: defaultLeaseActor().bdActor,
    };
    // A nothing-expired tick is read-only: findExpired is one bd list plus
    // client-side filtering — zero writes.
    const expired = await findExpired(ctx.cwd, opts);
    for (const issue of expired) {
      try {
        // Reclaim + best-effort run:cancel for the recorded execution +
        // redispatchability reset + leave-ready release (phase 4 — the
        // coordinator-aware composition; see reclaimAndLeaveReady).
        await reclaimAndLeaveReady(ctx.cwd, issue, opts, pi.events);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logSkipOnce(`could not reclaim ${issue.id}: ${msg}`);
      }
    }
    clearSkipLog();
  }

  function teardown(): void {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (state.timer) clearInterval(state.timer); // idempotent restart
    const config = deps.getConfig();
    state.timer = setInterval(() => void tick(ctx), config.sweepIntervalMs);
  });

  pi.on("session_shutdown", () => teardown());

  return {
    tick,
    teardown,
    timerActive: () => state.timer !== null,
  };
}
