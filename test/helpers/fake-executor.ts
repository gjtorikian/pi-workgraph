/**
 * A configurable protocol-speaking executor for tests: answers discovery
 * with an offer, then handles `run:request` per its configured behavior —
 * accept+complete, reject, stay silent (accept-timeout paths), or
 * accept-then-stall (manual completion via the handle, for fenced/stale
 * result tests). All emissions are well-formed protocol-v1 envelopes, so
 * the coordinator's `parseMessage` gates pass and only SEMANTIC checks
 * (correlation ids, fencing triple) decide the outcome.
 */
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
  CH,
  Discover,
  newEnvelope,
  parseMessage,
  RunCancel,
  RunRequest,
  RunStatusRequest,
  type ExecutorOfferT,
  type ExecutorRoleT,
  type IsolationLevelT,
  type RunCancelT,
  type RunCompletedT,
  type RunOutcomeT,
  type RunRequestT,
  type RunStatusRequestT,
  type RunStatusT,
} from "../../src/protocol.ts";

export type FakeBehavior =
  /** Accept the request and immediately emit a matching completion. */
  | "accept-complete"
  /** Reject with `rejectReason`. */
  | "reject"
  /** Never answer the request (drives the accept-timeout path). */
  | "silent"
  /** Accept, then never complete — tests call `handle.complete()` manually. */
  | "accept-stall";

/**
 * One scripted response for a role. Arrays are consumed in request order
 * (sequences: e.g. reviewer = [blocking verdict, clean verdict]); once
 * exhausted, the LAST entry repeats.
 */
export interface RoleScript {
  behavior?: FakeBehavior;
  outcome?: RunOutcomeT;
  /** Attached verbatim as the completion's extra `verdict` field (phase-3
   *  verdict transport: non-strict schemas tolerate it). */
  verdict?: unknown;
  provenance?: RunCompletedT["provenance"];
  artifacts?: string[];
  rejectReason?: string;
}

/**
 * Scripted `run:status` behavior (phase-4 recovery playground). The string
 * shorthands answer with that status; `"silent"` (the default) never
 * answers — the status-timeout path; a function builds the full reply
 * (return undefined for silence) — the terminal-with-completion case needs
 * the fencing triple only the test knows.
 */
export type FakeStatusScript =
  | "active"
  | "missing"
  | "unreachable"
  | "silent"
  | ((request: RunStatusRequestT) => RunStatusT | undefined);

export interface FakeExecutorOptions {
  executorId?: string;
  roles?: ExecutorRoleT[];
  isolation?: IsolationLevelT;
  priority?: number;
  behavior?: FakeBehavior;
  outcome?: RunOutcomeT;
  rejectReason?: string;
  /** Default provenance on completions (default `{harness: "fake"}`). */
  provenance?: RunCompletedT["provenance"];
  /** Per-role response scripts (phase-3 judgment playground). */
  roleScripts?: Partial<Record<ExecutorRoleT, RoleScript | RoleScript[]>>;
  /** Delay the discovery offer (late-offer / deadline tests). */
  offerDelayMs?: number;
  /** Don't answer discovery at all. */
  mute?: boolean;
  /** accept-complete only: re-emit the SAME completion message (duplicate
   *  messageId — the byte-identical re-delivery case). */
  duplicateCompletion?: boolean;
  /** Offer flags (phase 4; both default false, matching protocol history). */
  supportsCancellation?: boolean;
  supportsReconciliation?: boolean;
  /** `run:cancel` handling: `"ack"` (default) emits a correlated
   *  `run:cancelled` — including for unknown/finished runs (the no-op-ack
   *  contract); `"ignore"` drives the unacked-cancel abandon path. */
  cancel?: "ack" | "ignore";
  /** `run:status-request` handling (default `"silent"`). */
  status?: FakeStatusScript;
}

export interface CompleteOverrides {
  /** Override the echoed lease epoch (stale-result tests). */
  leaseEpoch?: number;
  outcome?: RunOutcomeT;
  verdict?: unknown;
  provenance?: RunCompletedT["provenance"];
  artifacts?: string[];
}

export interface FakeExecutorHandle {
  /** Every run request addressed to this executor, in order. */
  requests: RunRequestT[];
  /** Every completion message this executor emitted, in order. */
  completions: RunCompletedT[];
  /** Every run:cancel observed on the bus, in order (phase 4). */
  cancels: RunCancelT[];
  /** Every run:status-request addressed to this executor, in order. */
  statusRequests: RunStatusRequestT[];
  /** Complete the most recently accepted run (accept-stall flows). Returns
   *  the emitted message so tests can re-emit it verbatim. */
  complete(overrides?: CompleteOverrides): RunCompletedT;
  /** Re-emit a previously emitted completion verbatim (duplicate delivery). */
  reemit(message: RunCompletedT): void;
  /** Unsubscribe from the bus. */
  uninstall(): void;
}

export function installFakeExecutor(
  events: EventBus,
  opts: FakeExecutorOptions = {},
): FakeExecutorHandle {
  const executorId = opts.executorId ?? "fake-executor";
  const requests: RunRequestT[] = [];
  const completions: RunCompletedT[] = [];
  const cancels: RunCancelT[] = [];
  const statusRequests: RunStatusRequestT[] = [];
  let lastAccepted: {
    request: RunRequestT;
    executionId: string;
    script: RoleScript;
  } | null = null;
  let executionCounter = 0;
  const scriptCursor = new Map<ExecutorRoleT, number>();
  const unsubs: (() => void)[] = [];

  /** Next scripted response for a role (exhausted arrays repeat the last). */
  function scriptFor(role: ExecutorRoleT): RoleScript {
    const entry = opts.roleScripts?.[role];
    if (entry === undefined) return {};
    if (!Array.isArray(entry)) return entry;
    if (entry.length === 0) return {};
    const cursor = scriptCursor.get(role) ?? 0;
    scriptCursor.set(role, cursor + 1);
    return entry[Math.min(cursor, entry.length - 1)]!;
  }

  function buildCompletion(
    request: RunRequestT,
    executionId: string,
    overrides: CompleteOverrides = {},
    script: RoleScript = {},
  ): RunCompletedT {
    const verdict = overrides.verdict ?? script.verdict;
    return {
      ...newEnvelope(),
      workflowRunId: request.workflowRunId,
      executionId,
      issueId: request.issue.id,
      leaseEpoch: overrides.leaseEpoch ?? request.leaseEpoch,
      outcome: overrides.outcome ?? script.outcome ?? opts.outcome ?? "success",
      artifacts: overrides.artifacts ?? script.artifacts ?? [],
      evidence: [`fake executor ${executorId} completed ${request.issue.id}`],
      provenance:
        overrides.provenance ??
        script.provenance ??
        opts.provenance ?? { harness: "fake" },
      // Extra v1-tolerated field — the phase-3 verdict transport.
      ...(verdict !== undefined ? { verdict } : {}),
    } as RunCompletedT;
  }

  function emitCompletion(message: RunCompletedT): void {
    completions.push(message);
    events.emit(CH.runCompleted, message);
  }

  unsubs.push(
    events.on(CH.discover, (data) => {
      if (opts.mute) return;
      let msg;
      try {
        msg = parseMessage(CH.discover, Discover, data);
      } catch {
        return;
      }
      const offer: ExecutorOfferT = {
        ...newEnvelope(),
        inReplyTo: msg.messageId,
        executorId,
        adapterVersion: "test",
        roles: opts.roles ?? ["implementer"],
        harness: "fake",
        isolation: opts.isolation ?? "worktree",
        supportsCancellation: opts.supportsCancellation ?? false,
        supportsReconciliation: opts.supportsReconciliation ?? false,
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      };
      if (opts.offerDelayMs !== undefined) {
        setTimeout(() => events.emit(CH.offer, offer), opts.offerDelayMs);
      } else {
        events.emit(CH.offer, offer);
      }
    }),
  );

  unsubs.push(
    events.on(CH.runRequest, (data) => {
      let msg: RunRequestT;
      try {
        msg = parseMessage(CH.runRequest, RunRequest, data);
      } catch {
        return;
      }
      if (msg.executorId !== executorId) return; // addressed elsewhere
      requests.push(msg);

      const script = scriptFor(msg.role);
      const behavior = script.behavior ?? opts.behavior ?? "accept-complete";
      if (behavior === "silent") return;
      if (behavior === "reject") {
        events.emit(CH.runRejected, {
          ...newEnvelope(),
          inReplyTo: msg.messageId,
          workflowRunId: msg.workflowRunId,
          issueId: msg.issue.id,
          leaseEpoch: msg.leaseEpoch,
          executorId,
          reason: script.rejectReason ?? opts.rejectReason ?? "at-capacity",
        });
        return;
      }

      executionCounter += 1;
      // The executorId is baked into the execution id: two fake instances
      // (e.g. a pre- and post-restart pair) must never collide on the
      // independence check's executionId floor.
      const executionId = `${executorId}-exec-${executionCounter}`;
      lastAccepted = { request: msg, executionId, script };
      events.emit(CH.runAccepted, {
        ...newEnvelope(),
        inReplyTo: msg.messageId,
        workflowRunId: msg.workflowRunId,
        executionId,
        issueId: msg.issue.id,
        leaseEpoch: msg.leaseEpoch,
        executorId,
      });

      if (behavior === "accept-complete") {
        const completion = buildCompletion(msg, executionId, {}, script);
        emitCompletion(completion);
        if (opts.duplicateCompletion) {
          // Byte-identical re-delivery: same messageId, zero writes expected.
          events.emit(CH.runCompleted, completion);
        }
      }
    }),
  );

  // Cancellation (phase 4): record every cancel; ack unless scripted to
  // ignore. Acks fire even for unknown/finished runs — the contract says a
  // cancel for a run the executor does not know is a no-op ack.
  unsubs.push(
    events.on(CH.runCancel, (data) => {
      let msg: RunCancelT;
      try {
        msg = parseMessage(CH.runCancel, RunCancel, data);
      } catch {
        return;
      }
      cancels.push(msg);
      if ((opts.cancel ?? "ack") === "ignore") return;
      events.emit(CH.runCancelled, {
        ...newEnvelope(),
        workflowRunId: msg.workflowRunId,
        issueId: msg.issueId,
        ...(msg.executionId !== undefined
          ? { executionId: msg.executionId }
          : {}),
      });
    }),
  );

  // Reconciliation (phase 4): answer status requests ADDRESSED to this
  // executor per the script; the default is silence (the timeout path).
  unsubs.push(
    events.on(CH.runStatusRequest, (data) => {
      let msg: RunStatusRequestT;
      try {
        msg = parseMessage(CH.runStatusRequest, RunStatusRequest, data);
      } catch {
        return;
      }
      if (msg.executorId !== executorId) return; // addressed elsewhere
      statusRequests.push(msg);
      const script = opts.status ?? "silent";
      if (script === "silent") return;
      let reply: RunStatusT | undefined;
      if (typeof script === "function") {
        reply = script(msg);
      } else {
        reply = {
          ...newEnvelope(),
          inReplyTo: msg.messageId,
          workflowRunId: msg.workflowRunId,
          issueId: msg.issueId,
          status: script,
          ...(msg.executionId !== undefined
            ? { executionId: msg.executionId }
            : {}),
        };
      }
      if (reply) events.emit(CH.runStatus, reply);
    }),
  );

  return {
    requests,
    completions,
    cancels,
    statusRequests,
    complete(overrides = {}) {
      if (!lastAccepted) {
        throw new Error("fake executor: no accepted run to complete");
      }
      const message = buildCompletion(
        lastAccepted.request,
        lastAccepted.executionId,
        overrides,
        lastAccepted.script,
      );
      emitCompletion(message);
      return message;
    },
    reemit(message) {
      events.emit(CH.runCompleted, message);
    },
    uninstall() {
      for (const off of unsubs) off();
      unsubs.length = 0;
    },
  };
}
