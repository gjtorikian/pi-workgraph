/**
 * DEPRECATED (phase 2, control-plane refactor): the coordinator
 * (`src/coordinator.ts`) owns scheduling now — it discovers executors over
 * the versioned protocol, claims under generated workflow-run identities,
 * and validates results against the fencing triple. This module is
 * deprecated IN PLACE, not refactored (incompatible ownership models —
 * decision log): index.ts no longer registers it, but its exports stay
 * importable — `buildWorkPrompt` and the sendMessage wake pattern live on
 * inside the in-session compatibility adapter
 * (`src/adapters/in-session.ts`), `MIN_POLL_MS` remains the wiring-layer
 * floor, and external importers are unaffected. Completion detection by
 * disappearance from the process-local held-lease registry is gone from
 * the production path. Do not add new callers.
 *
 * The dispatch loop: feed ready work to an idle agent.
 *
 * One state machine: idle → claiming → working (heartbeating) → idle. A
 * timer started in `session_start` (never in the extension factory —
 * factories run in invocations that never start sessions) plus an
 * `agent_settled` listener (Pi's TRUE idle signal — `agent_end` fires per
 * low-level run while retries/compaction may still be pending) both funnel
 * into one reentrancy-guarded `tick`.
 *
 * Readiness is judged by ARRAY LENGTH, never exit codes — an empty pool is
 * `[]` with exit 0.
 *
 * Completion detection: the wake prompt instructs the model to call
 * `workgraph_close` (or `workgraph_release`); both tools already untrack the
 * lease in the held-lease registry (`lease.ts`), so a tick that finds
 * `getHeldLease(...) === undefined` knows the model finished — no output
 * parsing, and no tools→dispatch callback coupling.
 *
 * Config and the clock are injected (`DispatchDeps`), never read from the
 * ExtensionAPI here — tests run 50 ms timers by passing config directly;
 * the 5 s poll floor (`MIN_POLL_MS`) is applied at the index.ts wiring
 * layer only.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordLeaseEvent } from "./audit.ts";
import { bdBinaryAvailable, ensureWorkspace, ready } from "./bd.ts";
import type { WorkgraphConfig } from "./config.ts";
import { defaultLeaseActor } from "./identity.ts";
import {
  acquireLease,
  FencingError,
  getHeldLease,
  releaseLease,
  renewLease,
} from "./lease.ts";
import { clearLeaseStatus, showLeaseStatus } from "./status.ts";
import type { BeadsIssue, Lease } from "./types.ts";

/** Kill-switch flag (dash-case, matching `workgraph-worker-id`): pass
 *  `--workgraph-dispatch=false` for tools + context without autonomy. */
export const DISPATCH_FLAG = "workgraph-dispatch";

/**
 * Poll-interval floor. Applied by the index.ts wiring (never inside this
 * module) so a runaway claim loop cannot spin faster than once per 5 s in
 * production while tests inject 50 ms timers directly.
 */
export const MIN_POLL_MS = 5_000;

/** `customType` on the wake message dispatch sends. */
export const DISPATCH_MESSAGE_TYPE = "workgraph-dispatch";

/** `customType` on the zero-context-cost fencing-loss notification entry. */
export const DISPATCH_FENCING_ENTRY_TYPE = "workgraph-dispatch-fencing";

export interface DispatchDeps {
  /** Effective config; resolved lazily (flags are not readable at load). */
  getConfig: () => WorkgraphConfig;
  /** Clock injection for tests (default Date.now). */
  now?: () => number;
}

/** The issue dispatch is currently driving, with its lease. */
export interface CurrentDispatch {
  lease: Lease;
  issue: BeadsIssue;
}

/** Handle returned by {@link registerDispatch}; tests drive ticks directly. */
export interface DispatchController {
  /** One dispatch decision pass. Reentrant calls no-op. */
  tick(ctx: ExtensionContext): Promise<void>;
  /** One heartbeat pass (what the heartbeat timer fires). */
  beat(ctx: ExtensionContext): Promise<void>;
  /** Idempotent shutdown: stop timers and release any held lease. */
  teardown(ctx?: ExtensionContext): Promise<void>;
  /** The in-flight issue + lease, if any (compaction reads the title here). */
  current(): CurrentDispatch | null;
  /** Timer liveness, for lifecycle tests. */
  timersActive(): { poll: boolean; heartbeat: boolean };
}

/** The wake message content. Exported for tests and prompt review. */
export function buildWorkPrompt(issue: BeadsIssue, lease: Lease): string {
  const lines = [
    `[workgraph dispatch] You are assigned work-graph issue ${issue.id}: "${issue.title}".`,
  ];
  if (issue.description) {
    lines.push("", issue.description);
  }
  lines.push(
    "",
    `Your lease (epoch ${lease.epoch}) expires at ${lease.expiresAt}; it is heartbeated automatically while you work.`,
    "",
    "Work this issue now.",
    "- When it is done, call workgraph_close with a short reason.",
    "- If you cannot finish it, call workgraph_release to hand it back to the pool.",
    "- Never claim or release issues by writing assignee fields from bash; use the workgraph tools only.",
  );
  return lines.join("\n");
}

export function registerDispatch(
  pi: ExtensionAPI,
  deps: DispatchDeps,
): DispatchController {
  const nowFn = deps.now ?? Date.now;

  interface DispatchState {
    current: CurrentDispatch | null;
    timer: ReturnType<typeof setInterval> | null;
    hb: ReturnType<typeof setInterval> | null;
    /** In-flight tick guard — set synchronously before any await, so a
     *  timer tick and an `agent_settled` tick firing together cannot
     *  double-claim. */
    ticking: boolean;
    /** Wake-ignored backstop: re-prompt at most once per claim. */
    reprompted: boolean;
    /** Last skip reason logged — log once per state change, not per tick. */
    lastSkipLog: string | null;
  }

  const state: DispatchState = {
    current: null,
    timer: null,
    hb: null,
    ticking: false,
    reprompted: false,
    lastSkipLog: null,
  };

  pi.registerFlag(DISPATCH_FLAG, {
    description:
      "Enable the workgraph dispatch loop (auto-claims ready issues and wakes the agent); set to false for tools + context injection without autonomy",
    type: "boolean",
    default: true,
  });

  function enabled(): boolean {
    return pi.getFlag(DISPATCH_FLAG) !== false;
  }

  function logSkipOnce(reason: string): void {
    if (state.lastSkipLog === reason) return;
    state.lastSkipLog = reason;
    console.error(`[pi-workgraph] dispatch skipping: ${reason}`);
  }

  function clearSkipLog(): void {
    state.lastSkipLog = null;
  }

  function stopHeartbeat(): void {
    if (state.hb) {
      clearInterval(state.hb);
      state.hb = null;
    }
  }

  function startHeartbeat(ctx: ExtensionContext, heartbeatMs: number): void {
    stopHeartbeat();
    state.hb = setInterval(() => void beat(ctx), heartbeatMs);
  }

  /** Forget the current claim: stop heartbeating, clear the status line. */
  function finishCurrent(ctx: ExtensionContext): void {
    stopHeartbeat();
    state.current = null;
    state.reprompted = false;
    clearLeaseStatus(ctx);
  }

  /**
   * Deliver the wake message. `pi.sendMessage` returns void (not a
   * Promise), so the catch-and-retry-next-tick backstop is a synchronous
   * try/catch: on failure the reprompt flag is reset so the next tick's
   * re-prompt path retries.
   */
  function sendWake(cur: CurrentDispatch): void {
    try {
      pi.sendMessage(
        {
          customType: DISPATCH_MESSAGE_TYPE,
          content: buildWorkPrompt(cur.issue, cur.lease),
          display: true,
        },
        { triggerTurn: true, deliverAs: "nextTurn" },
      );
    } catch (e) {
      state.reprompted = false;
      const msg = e instanceof Error ? e.message : String(e);
      logSkipOnce(`sendMessage failed (will retry next tick): ${msg}`);
    }
  }

  async function tick(ctx: ExtensionContext): Promise<void> {
    if (state.ticking) return; // reentrant tick — checked/set before any await
    state.ticking = true;
    try {
      await tickInner(ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logSkipOnce(msg);
    } finally {
      state.ticking = false;
    }
  }

  async function tickInner(ctx: ExtensionContext): Promise<void> {
    const config = deps.getConfig();

    // Work in flight: one issue at a time in v0.
    if (state.current) {
      const held = getHeldLease(ctx.cwd, state.current.lease.issueId);
      if (held) {
        // Still ours. If the agent settled without finishing (wake message
        // ignored), re-prompt ONCE; the heartbeat keeps the lease alive.
        if (ctx.isIdle() && !ctx.hasPendingMessages() && !state.reprompted) {
          state.reprompted = true;
          sendWake(state.current);
        }
        showLeaseStatus(ctx, held, nowFn);
        return;
      }
      // The tools untracked the lease (workgraph_close / workgraph_release):
      // the model finished. Clear and fall through to claim the next issue.
      finishCurrent(ctx);
    }

    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    if (!bdBinaryAvailable()) {
      logSkipOnce("bd CLI not found");
      return;
    }
    try {
      await ensureWorkspace(ctx.cwd);
    } catch {
      // No .beads/ here — dispatch stays inert. ensureWorkspace does not
      // cache failures, so a mid-session `bd init` is picked up.
      return;
    }

    // ARRAY LENGTH is the readiness signal, never exit codes: an empty pool
    // is `[]` with exit 0.
    const pool = await ready(ctx.cwd, 1);
    if (pool.length === 0) {
      clearSkipLog();
      return;
    }

    // bd's atomic `ready --claim` path. "empty" (pool drained since the
    // probe) and "lost-race" both mean: no claim this tick, try again later.
    const outcome = await acquireLease(ctx.cwd, {
      ttlMs: config.leaseTtlMs,
      now: nowFn,
      // Behavior-identical bridge: holder = this session's worker id. The
      // phase-2 coordinator replaces this with a generated workflow-run
      // actor whose lifetime is the run's, not the session's.
      actor: defaultLeaseActor(),
    });
    if (outcome.kind !== "acquired") return;

    state.current = { lease: outcome.lease, issue: outcome.issue };
    state.reprompted = false;
    startHeartbeat(ctx, config.heartbeatMs);
    showLeaseStatus(ctx, outcome.lease, nowFn);
    sendWake(state.current);
    clearSkipLog();
  }

  /** One heartbeat: renew the held lease, or clean up after a reclaim. */
  async function beat(ctx: ExtensionContext): Promise<void> {
    const cur = state.current;
    if (!cur) {
      stopHeartbeat();
      return;
    }
    const held = getHeldLease(ctx.cwd, cur.lease.issueId);
    if (!held) {
      // Closed/released via tools between ticks — nothing left to renew.
      finishCurrent(ctx);
      return;
    }
    const config = deps.getConfig();
    try {
      const renewed = await renewLease(ctx.cwd, cur.lease, {
        ttlMs: config.leaseTtlMs,
        now: nowFn,
        // Renew as the actor stored at acquire time — never ambient identity.
        actor: held.actor,
      });
      cur.lease = renewed;
      showLeaseStatus(ctx, renewed, nowFn);
    } catch (e) {
      if (e instanceof FencingError) {
        // Reclaimed out from under us (renewLease already untracked): clear
        // state, audit, and notify via appendEntry — a custom entry is never
        // sent to the LLM, so the notification costs zero context.
        const details = {
          holder: e.currentHolder,
          heldEpoch: e.heldEpoch,
          currentEpoch: e.currentEpoch,
          via: "dispatch-heartbeat",
        };
        finishCurrent(ctx);
        await recordLeaseEvent(ctx.cwd, "fencing-loss", e.issueId, details);
        try {
          pi.appendEntry(DISPATCH_FENCING_ENTRY_TYPE, {
            issueId: e.issueId,
            ...details,
            ts: nowFn(),
          });
        } catch {
          // Entry append is best-effort notification only.
        }
        return;
      }
      // Transient bd trouble: keep the lease, retry on the next beat.
      const msg = e instanceof Error ? e.message : String(e);
      logSkipOnce(`heartbeat failed (will retry): ${msg}`);
    }
  }

  /**
   * Idempotent teardown: stop both timers and voluntarily release any held
   * lease (audit kind `release`, not `expire`) so a graceful quit never
   * strands a claim for the TTL.
   */
  async function teardown(ctx?: ExtensionContext): Promise<void> {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    stopHeartbeat();
    const cur = state.current;
    state.current = null;
    state.reprompted = false;
    if (!cur || !ctx) return;
    clearLeaseStatus(ctx);
    const held = getHeldLease(ctx.cwd, cur.lease.issueId);
    if (held) {
      try {
        // Release as the actor stored at acquire time.
        await releaseLease(ctx.cwd, cur.lease, held.actor);
      } catch (e) {
        // FencingError (reclaimed at shutdown) or bd trouble: either way the
        // lease is no longer ours to strand — log and finish shutting down.
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[pi-workgraph] dispatch teardown could not release ${cur.lease.issueId}: ${msg}`,
        );
      }
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (!enabled()) return;
    if (state.timer) clearInterval(state.timer); // idempotent restart
    const config = deps.getConfig();
    state.timer = setInterval(() => void tick(ctx), config.pollMs);
  });

  // The idle edge — poll immediately instead of waiting out the interval.
  pi.on("agent_settled", (_event, ctx) => {
    if (!enabled()) return;
    return tick(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => teardown(ctx));

  return {
    tick,
    beat,
    teardown,
    current: () => state.current,
    timersActive: () => ({
      poll: state.timer !== null,
      heartbeat: state.hb !== null,
    }),
  };
}
