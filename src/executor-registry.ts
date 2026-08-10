/**
 * Executor registry: discovery broadcast, deterministic offer selection,
 * and correlated request/response with bounded timeouts.
 *
 * Pi's event bus is process-local, has no replay, and `emit()` does not
 * await handlers — so every correlated exchange here follows the same two
 * rules: SUBSCRIBE BEFORE EMIT (a synchronous responder must never be
 * missed), and correlate by ids (`inReplyTo` → the request's `messageId`),
 * never by emit-order or timing assumptions. Both exchanges are bounded:
 * discovery collects offers until a deadline; a run request resolves
 * `accepted`/`rejected`/`timeout`, never hangs.
 *
 * Selection is a PURE function (`selectExecutor`) — deterministic given the
 * same offers, independent of arrival order.
 */
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
  CH,
  ExecutorOffer,
  newEnvelope,
  parseMessage,
  ProtocolError,
  RunAccepted,
  RunRejected,
  type ExecutorOfferT,
  type ExecutorRoleT,
  type RunAcceptedT,
  type RunRejectedT,
  type RunRequestT,
} from "./protocol.ts";

/** Called (never awaited) when an incoming payload fails validation. */
export type OnInvalidMessage = (channel: string, error: ProtocolError) => void;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveryOptions {
  /** How long to collect offers before returning (bounded — never open-ended). */
  timeoutMs: number;
  /** Clock injection for envelope timestamps (default Date.now). */
  now?: () => number;
  onInvalid?: OnInvalidMessage;
}

/**
 * Broadcast `executor:discover` and collect `executor:offer` replies until
 * the deadline. Offers answering a DIFFERENT discovery round (`inReplyTo`
 * mismatch) and offers arriving after the deadline are ignored — the
 * subscription is torn down before resolving.
 */
export function discoverExecutors(
  events: EventBus,
  opts: DiscoveryOptions,
): Promise<ExecutorOfferT[]> {
  const discover = newEnvelope(opts.now);
  const offers: ExecutorOfferT[] = [];

  return new Promise((resolve) => {
    // Subscribe FIRST: an adapter may answer synchronously inside emit().
    const unsubscribe = events.on(CH.offer, (data) => {
      try {
        const offer = parseMessage(CH.offer, ExecutorOffer, data);
        if (offer.inReplyTo !== discover.messageId) return; // another round
        offers.push(offer);
      } catch (e) {
        if (e instanceof ProtocolError) opts.onInvalid?.(CH.offer, e);
      }
    });
    events.emit(CH.discover, discover);
    setTimeout(() => {
      unsubscribe();
      resolve(offers);
    }, opts.timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ExecutorRequirements {
  role: ExecutorRoleT;
  /**
   * True when the run must execute in an isolated workspace. Offers
   * advertising `isolation: "none"` (the in-session compatibility adapter)
   * cannot satisfy an isolation-requiring request — the only way to force
   * one is naming it via explicit `executorId` config, which wins outright.
   */
  requiresIsolation: boolean;
  /**
   * Required offer `profileSemantics` (phase 5). When specified, only
   * offers DECLARING exactly this semantics match — an offer with no
   * declared semantics fails a specified requirement (fail closed). No
   * requirement (undefined, every caller today) passes every offer.
   */
  profileSemantics?: "initiating" | "named" | "executor-defined";
}

export interface SelectionConfig {
  /** Explicitly configured executor: wins over every filter and ordering. */
  executorId?: string;
}

/** Thrown when a configured executor is absent — never fall through silently. */
export class ExecutorSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorSelectionError";
  }
}

/**
 * Deterministic selection over collected offers:
 *  1. explicit `config.executorId` wins (ERROR if configured but absent —
 *     an operator who pinned an executor must never get a silent fallback).
 *     A pin overrides EVERY filter below, including `available: false` and
 *     capacity — the operator's explicit choice is never second-guessed;
 *  2. filter by required role, by `isolation !== "none"` when the request
 *     requires isolation, and (phase 5) by the optional offer fields:
 *     `available === false` is excluded, an offer at its advertised
 *     `maxConcurrency` (per the caller-supplied in-flight counts) is
 *     skipped, and a request-specified `profileSemantics` must match the
 *     offer's declared semantics exactly;
 *  3. order by `priority ?? 0` descending, then `executorId` ascending.
 * Returns undefined when no offer is eligible.
 *
 * `inFlight` maps executorId → live execution count. It must derive from
 * the caller's SUPERVISED-RUN state (reconciled on restart), never an
 * independent counter — a lost completion would otherwise starve the
 * executor at maxConcurrency forever (spec-phase-5 failure-modes row).
 */
export function selectExecutor(
  offers: readonly ExecutorOfferT[],
  requirements: ExecutorRequirements,
  config: SelectionConfig,
  inFlight?: ReadonlyMap<string, number>,
): ExecutorOfferT | undefined {
  if (config.executorId) {
    const pinned = offers.find((o) => o.executorId === config.executorId);
    if (!pinned) {
      throw new ExecutorSelectionError(
        `configured executor "${config.executorId}" did not offer — refusing to select another (no claim)`,
      );
    }
    return pinned;
  }

  const eligible = offers.filter(
    (o) =>
      o.roles.includes(requirements.role) &&
      (!requirements.requiresIsolation || o.isolation !== "none") &&
      o.available !== false &&
      (o.maxConcurrency === undefined ||
        (inFlight?.get(o.executorId) ?? 0) < o.maxConcurrency) &&
      (requirements.profileSemantics === undefined ||
        o.profileSemantics === requirements.profileSemantics),
  );
  eligible.sort(
    (a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) ||
      (a.executorId < b.executorId ? -1 : a.executorId > b.executorId ? 1 : 0),
  );
  return eligible[0];
}

// ---------------------------------------------------------------------------
// Correlated run request
// ---------------------------------------------------------------------------

export type RunRequestOutcome =
  | { kind: "accepted"; message: RunAcceptedT }
  | { kind: "rejected"; message: RunRejectedT }
  | { kind: "timeout" };

export interface RequestRunOptions {
  /** Accept/reject deadline; expiry resolves `timeout` (caller releases). */
  timeoutMs: number;
  onInvalid?: OnInvalidMessage;
}

/**
 * Emit `run:request` and await the correlated `run:accepted`/`run:rejected`
 * (matched on `inReplyTo` === the request's `messageId`), bounded by
 * `timeoutMs`. Subscriptions are registered before the emit and torn down
 * on resolution — a late accept after timeout is dropped on the floor (the
 * caller has already released the lease; the executor's eventual
 * `run:completed` will fail the fencing triple).
 */
export function requestRun(
  events: EventBus,
  request: RunRequestT,
  opts: RequestRunOptions,
): Promise<RunRequestOutcome> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubs: (() => void)[] = [];

    function finish(outcome: RunRequestOutcome): void {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      for (const off of unsubs) off();
      resolve(outcome);
    }

    // Subscribe BEFORE emitting — adapters may answer synchronously.
    unsubs.push(
      events.on(CH.runAccepted, (data) => {
        try {
          const msg = parseMessage(CH.runAccepted, RunAccepted, data);
          if (msg.inReplyTo !== request.messageId) return;
          finish({ kind: "accepted", message: msg });
        } catch (e) {
          if (e instanceof ProtocolError) opts.onInvalid?.(CH.runAccepted, e);
        }
      }),
    );
    unsubs.push(
      events.on(CH.runRejected, (data) => {
        try {
          const msg = parseMessage(CH.runRejected, RunRejected, data);
          if (msg.inReplyTo !== request.messageId) return;
          finish({ kind: "rejected", message: msg });
        } catch (e) {
          if (e instanceof ProtocolError) opts.onInvalid?.(CH.runRejected, e);
        }
      }),
    );

    timer = setTimeout(() => finish({ kind: "timeout" }), opts.timeoutMs);
    events.emit(CH.runRequest, request);
  });
}
