/**
 * The in-session compatibility executor: v0.1's sendMessage wake repackaged
 * as an EXPLICIT, configured protocol adapter. It answers discovery
 * (`executorId: "in-session"`, `isolation: "none"`, roles
 * `["implementer"]`), accepts run requests, wakes the model with the work
 * prompt over the exact mechanism dispatch.ts used (`pi.sendMessage` with
 * `triggerTurn: true, deliverAs: "nextTurn"`), and reports `run:completed`
 * when the session settles after the work turn.
 *
 * KNOWN WEAKNESS (by design — this is a *compatibility* adapter): the
 * completion signal is "the turn ended". `agent_settled` can fire for a
 * turn unrelated to the run (user chatter mid-run), producing a premature
 * completion report. The mitigations are structural, not perfect:
 *  - completion is associated with the run and reported EXACTLY ONCE (the
 *    run is cleared before emitting, so re-settles find nothing);
 *  - this adapter must be registered BEFORE the coordinator (index.ts
 *    order), so within one settled dispatch the adapter observes the run
 *    state from the PREVIOUS tick — a run requested during this settle
 *    completes on the NEXT one, never instantly;
 *  - the judgment gate (phase 3) is the real evaluator of the work; this
 *    signal only says "a turn finished".
 *
 * Cancellation: on `run:cancel` the adapter stops associating the session
 * turn with the run (no mid-turn interrupt of the model in v1) and acks
 * `run:cancelled`; the abandoned turn's settle reports nothing.
 *
 * Isolation: `"none"` — this executor can never satisfy an
 * isolation-requiring request (`selectExecutor` filters it out) unless an
 * operator pins it via explicit `executorId` config.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkgraphConfig } from "../config.ts";
import { DISPATCH_MESSAGE_TYPE } from "../dispatch.ts";
import {
  CH,
  Discover,
  newEnvelope,
  parseMessage,
  RunCancel,
  RunRequest,
  RunStatusRequest,
  type ExecutorOfferT,
  type RunRequestT,
  type RunStatusT,
} from "../protocol.ts";

export const IN_SESSION_EXECUTOR_ID = "in-session";
export const IN_SESSION_ADAPTER_VERSION = "1.0.0";

export interface InSessionDeps {
  /** Effective config; resolved lazily (flags are not readable at load). */
  getConfig: () => WorkgraphConfig;
  /** Clock injection for tests (default Date.now). */
  now?: () => number;
}

/** The run this adapter is currently executing in-session. */
export interface InSessionRun {
  workflowRunId: string;
  executionId: string;
  issueId: string;
  leaseEpoch: number;
}

/** Handle returned by {@link registerInSessionExecutor}. */
export interface InSessionController {
  /** The accepted run awaiting its settle, if any. */
  activeRun(): InSessionRun | null;
  /** Unsubscribe the event-bus handlers (tests). */
  teardown(): void;
}

/**
 * The wake prompt. Modeled on dispatch.ts's `buildWorkPrompt` (which stays
 * exported for external importers), but with phase-2 completion semantics:
 * completion is REPORTED when the turn settles — the model must not close
 * the issue itself (implementation transitions to judging, never to
 * closed).
 */
export function buildInSessionPrompt(request: RunRequestT): string {
  const lines = [
    `[workgraph dispatch] You are assigned work-graph issue ${request.issue.id}: "${request.issue.title}".`,
  ];
  if (request.issue.description) {
    lines.push("", request.issue.description);
  }
  lines.push(
    "",
    `You are executing workflow run ${request.workflowRunId} (lease epoch ${request.leaseEpoch}); the lease is heartbeated automatically while you work.`,
    "",
    "Work this issue now.",
    "- When this turn ends, your completion is reported to the workgraph coordinator, which records the result and moves the issue to judging — do not close or release the issue yourself.",
    "- If you cannot finish it, say so clearly in your final reply; the coordinator and its judgment gate handle the rest.",
    "- Never claim or release issues by writing assignee fields from bash; use the workgraph tools only.",
  );
  return lines.join("\n");
}

export function registerInSessionExecutor(
  pi: ExtensionAPI,
  deps: InSessionDeps,
): InSessionController {
  const nowFn = deps.now ?? Date.now;

  const state = {
    run: null as InSessionRun | null,
    /** One completion per accepted run — the cleared-run guard's backstop. */
    completed: new Set<string>(),
  };

  function enabled(): boolean {
    return deps.getConfig().compatInSessionExecutor;
  }

  const unsubs: (() => void)[] = [];

  // Discovery: advertise capabilities. Registered only in the protocol
  // sense — the subscription exists, but a disabled adapter never offers.
  unsubs.push(
    pi.events.on(CH.discover, (data) => {
      if (!enabled()) return;
      let msg;
      try {
        msg = parseMessage(CH.discover, Discover, data);
      } catch {
        return; // malformed discovery — no state change
      }
      const offer: ExecutorOfferT = {
        ...newEnvelope(nowFn),
        inReplyTo: msg.messageId,
        executorId: IN_SESSION_EXECUTOR_ID,
        adapterVersion: IN_SESSION_ADAPTER_VERSION,
        roles: ["implementer"],
        harness: "pi",
        isolation: "none",
        supportsCancellation: true,
        supportsReconciliation: false,
        profileSemantics: "initiating",
        maxConcurrency: 1,
      };
      pi.events.emit(CH.offer, offer);
    }),
  );

  // Run requests addressed to this executor.
  unsubs.push(
    pi.events.on(CH.runRequest, (data) => {
      if (!enabled()) return;
      let msg: RunRequestT;
      try {
        msg = parseMessage(CH.runRequest, RunRequest, data);
      } catch {
        return;
      }
      if (msg.executorId !== IN_SESSION_EXECUTOR_ID) return; // not for us

      if (state.run) {
        // One run at a time — the session has one model.
        pi.events.emit(CH.runRejected, {
          ...newEnvelope(nowFn),
          inReplyTo: msg.messageId,
          workflowRunId: msg.workflowRunId,
          issueId: msg.issue.id,
          leaseEpoch: msg.leaseEpoch,
          executorId: IN_SESSION_EXECUTOR_ID,
          reason: "busy",
        });
        return;
      }

      // Wake FIRST (pi.sendMessage returns void; failures throw
      // synchronously): a run we could not start must be rejected, never
      // accepted-and-silently-dropped.
      try {
        pi.sendMessage(
          {
            customType: DISPATCH_MESSAGE_TYPE,
            content: buildInSessionPrompt(msg),
            display: true,
          },
          { triggerTurn: true, deliverAs: "nextTurn" },
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        pi.events.emit(CH.runRejected, {
          ...newEnvelope(nowFn),
          inReplyTo: msg.messageId,
          workflowRunId: msg.workflowRunId,
          issueId: msg.issue.id,
          leaseEpoch: msg.leaseEpoch,
          executorId: IN_SESSION_EXECUTOR_ID,
          reason: `wake-failed: ${reason}`,
        });
        return;
      }

      const run: InSessionRun = {
        workflowRunId: msg.workflowRunId,
        executionId: crypto.randomUUID(),
        issueId: msg.issue.id,
        leaseEpoch: msg.leaseEpoch,
      };
      state.run = run;
      pi.events.emit(CH.runAccepted, {
        ...newEnvelope(nowFn),
        inReplyTo: msg.messageId,
        workflowRunId: run.workflowRunId,
        executionId: run.executionId,
        issueId: run.issueId,
        leaseEpoch: run.leaseEpoch,
        executorId: IN_SESSION_EXECUTOR_ID,
      });
    }),
  );

  // Cancellation: stop associating the turn with the run and ack.
  unsubs.push(
    pi.events.on(CH.runCancel, (data) => {
      let msg;
      try {
        msg = parseMessage(CH.runCancel, RunCancel, data);
      } catch {
        return;
      }
      const run = state.run;
      if (!run || run.workflowRunId !== msg.workflowRunId) return;
      state.run = null; // the turn's settle now reports nothing
      pi.events.emit(CH.runCancelled, {
        ...newEnvelope(nowFn),
        workflowRunId: run.workflowRunId,
        executionId: run.executionId,
        issueId: run.issueId,
      });
    }),
  );

  // Reconciliation (phase 4): in-session executions die with the session,
  // so any pre-restart execution is `missing` BY DEFINITION — after a
  // restart `state.run` is null, and the missing-when-unknown answer below
  // is trivially correct. (A live run this session started answers
  // `active`.) Only requests explicitly addressed to this executor are
  // answered — an unaddressed probe about someone else's run must not get
  // a spurious `missing`.
  unsubs.push(
    pi.events.on(CH.runStatusRequest, (data) => {
      if (!enabled()) return;
      let msg;
      try {
        msg = parseMessage(CH.runStatusRequest, RunStatusRequest, data);
      } catch {
        return;
      }
      if (msg.executorId !== IN_SESSION_EXECUTOR_ID) return; // not for us
      const run = state.run;
      const active = run !== null && run.workflowRunId === msg.workflowRunId;
      const status: RunStatusT = {
        ...newEnvelope(nowFn),
        inReplyTo: msg.messageId,
        workflowRunId: msg.workflowRunId,
        issueId: msg.issueId,
        status: active ? "active" : "missing",
        ...(active ? { executionId: run.executionId } : {}),
      };
      pi.events.emit(CH.runStatus, status);
    }),
  );

  // Completion: the settle after the work turn. Exactly one completion per
  // accepted run — the run is cleared BEFORE emitting, so a re-settle (or a
  // handler re-entry) finds nothing to report.
  pi.on("agent_settled", (_event, ctx) => {
    const run = state.run;
    if (!run) return;
    if (state.completed.has(run.executionId)) return;
    state.run = null;
    state.completed.add(run.executionId);
    pi.events.emit(CH.runCompleted, {
      ...newEnvelope(nowFn),
      workflowRunId: run.workflowRunId,
      executionId: run.executionId,
      issueId: run.issueId,
      leaseEpoch: run.leaseEpoch,
      outcome: "success",
      artifacts: [],
      evidence: [
        `in-session turn settled (session ${ctx.sessionManager.getSessionId()})`,
      ],
      provenance: { harness: "pi", profile: "initiating" },
    });
  });

  return {
    activeRun: () => state.run,
    teardown: () => {
      for (const off of unsubs) off();
      unsubs.length = 0;
      state.run = null;
    },
  };
}
