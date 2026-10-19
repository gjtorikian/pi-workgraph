/**
 * The in-session executor: the local sendMessage wake exposed as an
 * explicit, configured protocol adapter. It answers discovery
 * (`executorId: "in-session"`, `isolation: "none"`, roles
 * `["planner", "implementer"]`), accepts run requests, wakes the model with
 * the work prompt (`pi.sendMessage` with `triggerTurn: true, deliverAs:
 * "followUp"`), and reports `run:completed` when the session settles after
 * the work turn.
 *
 * PLANNER ROLE. A planning turn produces no code: the prompt asks the model
 * to submit its plan through the `workgraph_submit_plan` tool this adapter
 * registers, and the settle reports that plan on the completion. A planning
 * turn that ends without a submitted plan completes as `failure` (the
 * coordinator escalates — "failure is escalation, not degradation").
 *
 * MODEL TIERS. When a tier is resolved for the requested role
 * (src/tiers.ts), the adapter switches the session model (and thinking
 * level) for the duration of the run and restores the previous settings
 * when the run completes or is cancelled — the "plan with the strong model,
 * build with the fast one" flip, inside one session. Provenance on the
 * completion reports the model the turn actually ran on.
 *
 * The wake MUST NOT use dispatch.ts's original `deliverAs: "nextTurn"`:
 * pi ignores `triggerTurn` for "nextTurn" delivery (the message queues for
 * the next USER prompt), so in a promptless session — `pi --mode rpc`
 * driven by an external launcher — the work prompt would sit queued
 * forever while the coordinator renews the lease indefinitely.
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
 * turn with the run (no mid-turn interrupt of the model in v1), restores
 * the model, and acks `run:cancelled`; the abandoned turn's settle reports
 * nothing.
 *
 * Isolation: `"none"` — this executor can never satisfy an
 * isolation-requiring request (`selectExecutor` filters it out) unless an
 * operator pins it via explicit `executorId` config.
 */
import type { Model } from "@earendil-works/pi-ai";
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
  type ExecutorRoleT,
  type RunCompletedT,
  type RunRequestT,
  type RunStatusT,
} from "../protocol.ts";
import { tierFor, type ResolvedTier } from "../tiers.ts";
import { Plan, type PlanT } from "../types.ts";

export const IN_SESSION_EXECUTOR_ID = "in-session";
export const IN_SESSION_ADAPTER_VERSION = "1.1.0";
export const IN_SESSION_ROLES: ExecutorRoleT[] = ["planner", "implementer"];
/** The tool a planning turn submits its plan through. */
export const SUBMIT_PLAN_TOOL = "workgraph_submit_plan";

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
  role: ExecutorRoleT;
  /** The plan submitted during a planning turn (planner role). */
  plan?: PlanT;
  /** Session settings to put back when the run ends (tiered runs only). */
  restore?: { model?: Model<any>; thinking?: string };
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
 * closed). A planner wake asks for a submitted plan and no code.
 */
export function buildInSessionPrompt(request: RunRequestT): string {
  if (request.role === "planner") return buildPlannerPrompt(request);
  const lines = [
    `[workgraph dispatch] You are assigned work-graph issue ${request.issue.id}: "${request.issue.title}".`,
  ];
  if (request.issue.description) {
    lines.push("", request.issue.description);
  }
  if (request.issue.acceptanceCriteria) {
    lines.push("", `Acceptance criteria: ${request.issue.acceptanceCriteria}`);
  }
  if (request.plan)
    lines.push("", "Accepted implementation plan:", request.plan);
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

function buildPlannerPrompt(request: RunRequestT): string {
  const lines = [
    `[workgraph planning] Plan work-graph issue ${request.issue.id}: "${request.issue.title}".`,
  ];
  if (request.issue.description) lines.push("", request.issue.description);
  if (request.issue.acceptanceCriteria) {
    lines.push("", `Acceptance criteria: ${request.issue.acceptanceCriteria}`);
  }
  if (request.feedback) {
    lines.push(
      "",
      "A previous plan for this issue was REJECTED with this feedback — address it:",
      request.feedback,
    );
  }
  lines.push(
    "",
    `This is the planning step of workflow run ${request.workflowRunId} (lease epoch ${request.leaseEpoch}).`,
    "",
    "Produce a concrete implementation plan. Read the repository as needed, but do NOT modify product code in this turn.",
    "- Break the work into ordered, bounded steps; name the files or symbols each step touches and why it exists.",
    "- List open questions or risks you could not resolve.",
    `- Submit the plan by calling the ${SUBMIT_PLAN_TOOL} tool with { steps: [{ description, targets?, rationale? }], summary?, risks? }, then end your turn.`,
    "- The plan then waits for a human: they approve it (implementation starts with the plan attached) or reject it with feedback (you plan again).",
    "- A planning turn that ends without a submitted plan is reported as a failure and escalated.",
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
    /** The session model as last seen on an event context (for restore + provenance). */
    lastModel: undefined as Model<any> | undefined,
  };

  function enabled(): boolean {
    return deps.getConfig().compatInSessionExecutor;
  }

  /**
   * Switch the session onto the role's tier. Best effort: a registry that
   * refuses the model (`setModel` → false) or a harness without the API
   * leaves the session as it was — the run still proceeds on the current
   * model, and provenance reports whatever actually ran.
   */
  async function applyTier(tier: ResolvedTier): Promise<InSessionRun["restore"]> {
    const restore: NonNullable<InSessionRun["restore"]> = { model: state.lastModel };
    try {
      if (typeof pi.setModel === "function") {
        const ok = await pi.setModel(tier.model);
        if (!ok) delete restore.model;
      } else {
        delete restore.model;
      }
      if (tier.thinking && typeof pi.setThinkingLevel === "function") {
        restore.thinking =
          typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined;
        pi.setThinkingLevel(tier.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
      }
    } catch {
      // Leave the session alone; the run proceeds untiered.
    }
    return restore;
  }

  async function restoreTier(run: InSessionRun): Promise<void> {
    const restore = run.restore;
    if (!restore) return;
    delete run.restore;
    try {
      if (restore.model && typeof pi.setModel === "function") await pi.setModel(restore.model);
      if (restore.thinking !== undefined && typeof pi.setThinkingLevel === "function") {
        pi.setThinkingLevel(restore.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
      }
    } catch {
      // Best effort: the user can always /model back.
    }
  }

  const unsubs: (() => void)[] = [];

  // The plan intake for planning turns. Registered unconditionally (tools
  // are cheap); it refuses unless a planning run is active.
  pi.registerTool({
    name: SUBMIT_PLAN_TOOL,
    label: "Submit plan",
    description:
      "Submit the implementation plan for the work-graph issue currently being planned in this session. Only valid during a planning turn; the plan is handed to a human for approval when the turn ends.",
    promptSnippet: "Submit the plan for the issue being planned",
    promptGuidelines: [
      `During a workgraph planning turn, finish by calling ${SUBMIT_PLAN_TOOL} with ordered steps; do not write code.`,
    ],
    parameters: Plan,
    executionMode: "sequential",
    async execute(_id, params) {
      const run = state.run;
      if (!run || run.role !== "planner") {
        throw new Error(
          `${SUBMIT_PLAN_TOOL} is only valid during a workgraph planning turn (no planning run is active).`,
        );
      }
      if (params.steps.length === 0) throw new Error("A plan needs at least one step.");
      run.plan = params;
      return {
        content: [
          {
            type: "text",
            text: `Plan recorded (${params.steps.length} step${params.steps.length === 1 ? "" : "s"}) for ${run.issueId}. End your turn to submit it for human review.`,
          },
        ],
        details: { issueId: run.issueId, steps: params.steps.length },
      };
    },
  });

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
        roles: [...IN_SESSION_ROLES],
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
    pi.events.on(CH.runRequest, async (data) => {
      if (!enabled()) return;
      let msg: RunRequestT;
      try {
        msg = parseMessage(CH.runRequest, RunRequest, data);
      } catch {
        return;
      }
      if (msg.executorId !== IN_SESSION_EXECUTOR_ID) return; // not for us

      const reject = (reason: string): void => {
        pi.events.emit(CH.runRejected, {
          ...newEnvelope(nowFn),
          inReplyTo: msg.messageId,
          workflowRunId: msg.workflowRunId,
          issueId: msg.issue.id,
          leaseEpoch: msg.leaseEpoch,
          executorId: IN_SESSION_EXECUTOR_ID,
          reason,
        });
      };

      if (state.run) {
        // One run at a time — the session has one model.
        reject("busy");
        return;
      }
      if (!IN_SESSION_ROLES.includes(msg.role)) {
        reject(`role ${msg.role} is not offered in-session`);
        return;
      }

      // Tier first, then wake: the work turn must start on the tier's
      // model, and a failed switch simply proceeds untiered.
      const tier = tierFor(msg.role);
      const restore = tier ? await applyTier(tier) : undefined;
      if (state.run) {
        // Another request won while we were switching models.
        reject("busy");
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
          // "followUp", never "nextTurn": pi ignores triggerTurn for
          // nextTurn, and a promptless RPC session has no next user prompt
          // to flush the queue — the run would never start a turn.
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (restore) await restoreTier({ restore } as InSessionRun);
        reject(`wake-failed: ${reason}`);
        return;
      }

      const run: InSessionRun = {
        workflowRunId: msg.workflowRunId,
        executionId: crypto.randomUUID(),
        issueId: msg.issue.id,
        leaseEpoch: msg.leaseEpoch,
        role: msg.role,
        ...(restore ? { restore } : {}),
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

  // Cancellation: stop associating the turn with the run, restore, and ack.
  unsubs.push(
    pi.events.on(CH.runCancel, async (data) => {
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
      await restoreTier(run);
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

  // Track the session model from any context we see: it is what a tiered
  // run restores to, and the fallback provenance when a settle has none.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.model) state.lastModel = ctx.model;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.model && !state.run) state.lastModel = ctx.model;
  });

  // Completion: the settle after the work turn. Exactly one completion per
  // accepted run — the run is cleared BEFORE emitting, so a re-settle (or a
  // handler re-entry) finds nothing to report.
  pi.on("agent_settled", async (_event, ctx) => {
    const run = state.run;
    if (!run) {
      if (ctx.model) state.lastModel = ctx.model;
      return;
    }
    if (state.completed.has(run.executionId)) return;
    state.run = null;
    state.completed.add(run.executionId);
    const ran = ctx.model;
    const provenance: RunCompletedT["provenance"] = {
      harness: "pi",
      profile: "initiating",
      ...(ran ? { model: ran.id, provider: ran.provider } : {}),
    };
    const base = {
      ...newEnvelope(nowFn),
      workflowRunId: run.workflowRunId,
      executionId: run.executionId,
      issueId: run.issueId,
      leaseEpoch: run.leaseEpoch,
      artifacts: [] as string[],
      provenance,
    };
    const sessionNote = `in-session turn settled (session ${ctx.sessionManager.getSessionId()})`;
    if (run.role === "planner") {
      pi.events.emit(
        CH.runCompleted,
        run.plan
          ? {
              ...base,
              outcome: "success",
              evidence: [sessionNote, `plan submitted via ${SUBMIT_PLAN_TOOL}`],
              plan: run.plan,
            }
          : {
              ...base,
              outcome: "failure",
              evidence: [sessionNote, `planning turn ended without ${SUBMIT_PLAN_TOOL}`],
            },
      );
    } else {
      pi.events.emit(CH.runCompleted, {
        ...base,
        outcome: "success",
        evidence: [sessionNote],
      });
    }
    await restoreTier(run);
    if (ctx.model) state.lastModel = run.restore?.model ?? state.lastModel;
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
