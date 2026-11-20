/**
 * The pi-subagents bridge's handling of the `plan_critic` role: the offer,
 * the launch params (upstream profile, model, workspace), the task text, and
 * the structured output riding back as `critique`. Both sides are faked as in
 * `test/pi-subagents-adapter.test.ts`, whose harness helpers are copied here
 * because that file exports nothing. The last case runs the real bridge
 * under the real coordinator, the pattern from `test/judgment.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSubagentTask,
  PI_SUBAGENTS_EXECUTOR_ID,
  registerPiSubagentsExecutor,
  type PiSubagentsController,
} from "../src/adapters/pi-subagents.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import { registerCoordinator } from "../src/coordinator.ts";
import { latestPlanCritique } from "../src/critique.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { resetLeasesForTest } from "../src/lease.ts";
import { phaseOf } from "../src/lifecycle.ts";
import { renderPlan } from "../src/plan.ts";
import {
  CH,
  ExecutorOffer,
  newEnvelope,
  parseMessage,
  type ExecutorOfferT,
  type RunCompletedT,
  type RunRequestT,
} from "../src/protocol.ts";
import { resolveTiers, setResolvedTiers } from "../src/tiers.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import {
  PlanCritique,
  WORKGRAPH_PLAN_CRITIQUE_KEY,
  type PlanCritiqueT,
  type PlanT,
} from "../src/types.ts";
import { preProofConfig } from "./helpers/config.ts";
import { installFakeSubagents } from "./helpers/fake-subagents.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "bridge-critic-worker";

const CONFIG = preProofConfig({ subagentsExecutor: { enabled: true } });

const PLAN: PlanT = {
  summary: "add retry backoff to the client",
  steps: [
    { description: "add a RetryPolicy type", targets: ["src/retry.ts"] },
    { description: "handle retries in the request path" },
  ],
};

/** What the coordinator sends as `plan`: the implementer's rendering. */
const PLAN_TEXT = renderPlan(PLAN);

const TWO_GAPS: PlanCritiqueT = {
  gaps: [
    { step: 2, note: "which errors retry, 429 only or 5xx too?" },
    { step: 1, note: "is the policy per client or per request?" },
  ],
};

type CriticCompletion = RunCompletedT & { critique?: unknown };

interface BridgeHarness {
  mock: MockPi;
  bridge: PiSubagentsController;
  config: WorkgraphConfig;
}

function makeBridgeHarness(
  overrides: Partial<WorkgraphConfig> = {},
): BridgeHarness {
  const mock = makeMockPi();
  const config = preProofConfig({ ...CONFIG, ...overrides });
  const bridge = registerPiSubagentsExecutor(asExtensionAPI(mock), {
    getConfig: () => config,
    probeVersion: () => "0.34.8",
    warn: () => {},
  });
  return { mock, bridge, config };
}

/** A critic request shaped like the coordinator's: a `planned`, high-risk
 *  issue, the rendered plan, the critique schema, and no isolation. */
function makeRunRequest(overrides: Partial<RunRequestT> = {}): RunRequestT {
  return {
    ...newEnvelope(),
    executorId: PI_SUBAGENTS_EXECUTOR_ID,
    issue: {
      id: "wg-7",
      title: "wire the flux capacitor",
      acceptanceCriteria: "the capacitor fluxes",
      workflowClass: "planned",
      riskTier: "high",
    },
    workflowRunId: "workgraph-run/sub-run-1",
    leaseEpoch: 3,
    role: "plan_critic",
    attempt: 1,
    workspace: { baseRevision: "", requiresIsolation: false },
    plan: PLAN_TEXT,
    outputSchema: PlanCritique,
    ...overrides,
  };
}

function busOn(mock: MockPi, channel: string): unknown[] {
  return mock.busEvents.filter((e) => e.channel === channel).map((e) => e.data);
}

/** A resolved `plan_critic` tier, built the way session start builds one. */
function setCriticTier(thinking?: "high"): void {
  const registry = {
    getAvailable: () => [
      { provider: "anthropic", id: "claude-opus-5", name: "opus" } as never,
    ],
  };
  const { resolved } = resolveTiers(registry, {
    plan_critic: {
      model: "anthropic/claude-opus-*",
      ...(thinking ? { thinking } : {}),
    },
  });
  setResolvedTiers(resolved);
}

afterEach(() => {
  resetLeasesForTest();
  resetIdentityForTest();
  setResolvedTiers(undefined);
});

// ---------------------------------------------------------------------------
// offer
// ---------------------------------------------------------------------------

describe("the bridge offers the plan_critic role", () => {
  it("lists plan_critic in a discovery offer the protocol accepts", () => {
    const { mock, bridge } = makeBridgeHarness();
    try {
      mock.events.emit(CH.discover, newEnvelope());
      const offers = busOn(mock, CH.offer) as ExecutorOfferT[];
      expect(offers).toHaveLength(1);
      expect(offers[0]!.roles).toEqual([
        "planner",
        "implementer",
        "reviewer",
        "revision",
        "plan_critic",
      ]);
      // A misspelled role passes the type checker (the role enum is a plain
      // string to TypeScript) and is caught only here: the coordinator drops
      // an offer that fails this parse, and with it every role.
      expect(() =>
        parseMessage(CH.offer, ExecutorOffer, offers[0]),
      ).not.toThrow();
    } finally {
      bridge.teardown();
    }
  });

  it("keeps finalizer last when finalization is configured", () => {
    const { mock, bridge } = makeBridgeHarness({
      finalization: { instructions: "Export to our system" },
    });
    try {
      mock.events.emit(CH.discover, newEnvelope());
      const offers = busOn(mock, CH.offer) as ExecutorOfferT[];
      expect(offers[0]!.roles.slice(-2)).toEqual(["plan_critic", "finalizer"]);
    } finally {
      bridge.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// launch: profile, context, workspace
// ---------------------------------------------------------------------------

describe("launching a plan critic", () => {
  it("launches the upstream reviewer profile, fresh, in the source checkout, with the output schema", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: { structuredOutput: TWO_GAPS },
    });
    try {
      mock.events.emit(CH.runRequest, makeRunRequest());

      expect(busOn(mock, CH.runRejected)).toHaveLength(0);
      expect(fake.requests).toHaveLength(1);
      const params = fake.requests[0]!.params;
      expect(params.agent).toBe("reviewer");
      expect(params.context).toBe("fresh");
      expect(params.worktree).toBe(false);
      expect(params).not.toHaveProperty("cwd");
      expect(params.outputSchema).toEqual(PlanCritique);
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("a planned-work route for plan_critic names a different upstream profile", () => {
    const { mock, bridge } = makeBridgeHarness({
      subagentsExecutor: {
        enabled: true,
        routes: { planned: { plan_critic: "oracle" } },
      },
    });
    const fake = installFakeSubagents(mock.events);
    try {
      mock.events.emit(CH.runRequest, makeRunRequest());
      expect(fake.requests.map((r) => r.params.agent)).toEqual(["oracle"]);
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("a route for the reviewer role does not move the critic", () => {
    const { mock, bridge } = makeBridgeHarness({
      subagentsExecutor: {
        enabled: true,
        routes: { planned: { reviewer: "strict-reviewer" } },
      },
    });
    const fake = installFakeSubagents(mock.events);
    try {
      mock.events.emit(CH.runRequest, makeRunRequest());
      expect(fake.requests.map((r) => r.params.agent)).toEqual(["reviewer"]);
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("with finalization configured, the critic is still launched in the source checkout, not a workflow workspace", () => {
    const { mock, bridge } = makeBridgeHarness({
      finalization: { instructions: "Export to our system" },
    });
    const fake = installFakeSubagents(mock.events, {
      script: { structuredOutput: TWO_GAPS },
    });
    try {
      // The coordinator sends the source checkout as the repository. No
      // workflow workspace exists at planning time, so resolving one for
      // this path would reject the request.
      mock.events.emit(
        CH.runRequest,
        makeRunRequest({
          workspace: {
            repoPath: "/nonexistent/source-checkout",
            baseRevision: "",
            requiresIsolation: false,
          },
        }),
      );

      expect(busOn(mock, CH.runRejected)).toHaveLength(0);
      expect(fake.requests).toHaveLength(1);
      const params = fake.requests[0]!.params;
      expect(params.worktree).toBe(false);
      expect(params).not.toHaveProperty("cwd");

      const completions = busOn(mock, CH.runCompleted) as CriticCompletion[];
      expect(completions).toHaveLength(1);
      expect(completions[0]!.critique).toEqual(TWO_GAPS);
      expect(completions[0]).not.toHaveProperty("workspace");
      expect(completions[0]!.artifacts).toEqual([]);
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// launch: model
// ---------------------------------------------------------------------------

describe("the critic's launch model", () => {
  function launchedParams(
    options?: NonNullable<WorkgraphConfig["subagentsExecutor"]>["options"],
  ): { params: Record<string, unknown>; rejected: unknown[] } {
    const { mock, bridge } = makeBridgeHarness({
      subagentsExecutor: { enabled: true, ...(options ? { options } : {}) },
    });
    const fake = installFakeSubagents(mock.events);
    try {
      mock.events.emit(CH.runRequest, makeRunRequest());
      return {
        params: fake.requests[0]?.params ?? {},
        rejected: busOn(mock, CH.runRejected),
      };
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  }

  it("passes no model when neither a tier nor an option names one", () => {
    const { params } = launchedParams();
    expect(params.agent).toBe("reviewer");
    expect(params).not.toHaveProperty("model");
  });

  it("a resolved plan_critic tier becomes the launch model, with its thinking level as the suffix", () => {
    setCriticTier("high");
    expect(launchedParams().params.model).toBe("anthropic/claude-opus-5:high");
  });

  it("a tier without a thinking level launches the bare model id", () => {
    setCriticTier();
    expect(launchedParams().params.model).toBe("anthropic/claude-opus-5");
  });

  it("options.plan_critic overrides the tier's model", () => {
    setCriticTier();
    const { params } = launchedParams({
      plan_critic: { model: "openai/gpt-5", thinking: "low" },
    });
    expect(params.model).toBe("openai/gpt-5:low");
  });

  it("an option that names only a model keeps the tier's thinking level", () => {
    // The options are spread over the tier field by field, as for every
    // role: overriding the model alone does not reset the thinking level.
    setCriticTier("high");
    const { params } = launchedParams({
      plan_critic: { model: "openai/gpt-5" },
    });
    expect(params.model).toBe("openai/gpt-5:high");
  });

  it("rejects a thinking option that has no model to apply to", () => {
    const { params, rejected } = launchedParams({
      plan_critic: { thinking: "high" },
    });
    expect(params).toEqual({});
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "a thinking override requires an explicit model",
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// task text
// ---------------------------------------------------------------------------

describe("buildSubagentTask for a plan critic", () => {
  const PROPOSED_LABEL =
    "Proposed implementation plan (not yet approved by a human):";

  it("labels the plan as proposed and asks the build-readiness question", () => {
    const task = buildSubagentTask(makeRunRequest());

    expect(task).toContain("Acceptance criteria: the capacitor fluxes");
    expect(task).toContain(`${PROPOSED_LABEL}\n${PLAN_TEXT}`);
    expect(task).toContain("not yet approved");
    expect(task).toContain("PLAN CRITIC");
    expect(task).toContain("at most 5 gaps");
    // The upstream reviewer profile expects an implementation to review;
    // the task has to say there is none, and that nothing may be edited.
    expect(task).toContain("No implementation exists");
    expect(task).toContain("Do not modify any files");
    // The critic branch refers to "the proposed plan above".
    expect(task.indexOf(PROPOSED_LABEL)).toBeLessThan(
      task.indexOf("PLAN CRITIC"),
    );
    // The shared trailer still applies.
    expect(task).toContain("calling the structured_output tool");
    expect(task).toContain("Do not close or release the issue yourself");
  });

  it("carries no other role's instructions", () => {
    const task = buildSubagentTask(makeRunRequest());
    expect(task).not.toContain("Accepted implementation plan:");
    expect(task).not.toContain("INDEPENDENT reviewer");
    expect(task).not.toContain("Do not modify product code");
    expect(task).not.toContain("Implement and validate the changes");
  });

  it("is the task the upstream agent is launched with", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events);
    try {
      const request = makeRunRequest();
      mock.events.emit(CH.runRequest, request);
      expect(fake.requests[0]!.params.task).toBe(buildSubagentTask(request));
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  // The whole task text of each other role for the same request, as it was
  // before the bridge learned `plan_critic`. The plan label is a line every
  // role shares, so the edit that relabels it for the critic must leave
  // these byte-identical. Update a literal here only when that role's prompt
  // is changed on purpose.
  const ROLE_SENTENCE: Record<string, string> = {
    // Two lines: the second asks for the file paths the `scope` guard holds
    // an approved plan to.
    planner: [
      "Produce a concrete implementation plan as structured output matching the provided schema. Do not modify product code.",
      "In each step's targets, list the repository-relative file paths the step expects to change (a directory covers everything under it). Once the plan is approved, a change to a file outside those paths is flagged as out of scope; test files, and a lockfile beside a changed manifest, are exempt.",
    ].join("\n"),
    implementer:
      "Implement and validate the changes. Leave the result in this workspace for independent review and subsequent workflow stages.",
    reviewer:
      "You are an INDEPENDENT reviewer: evaluate the implementation against the acceptance criteria and report your verdict as structured output matching the provided schema.",
  };

  it.each(["planner", "implementer", "reviewer"])(
    "leaves the %s task text unchanged",
    (role) => {
      const task = buildSubagentTask(makeRunRequest({ role }));
      expect(task).toBe(
        [
          `[workgraph ${role}] Issue wg-7: "wire the flux capacitor" (workflow run workgraph-run/sub-run-1, attempt 1).`,
          "",
          "Acceptance criteria: the capacitor fluxes",
          "",
          "Accepted implementation plan:",
          PLAN_TEXT,
          "",
          ROLE_SENTENCE[role],
          "",
          "Completion contract for this workflow: finish by calling the structured_output tool with { value: <your result> }, where value matches the supplied outputSchema. A Markdown answer or a plan.md file alone does not submit a result. This workflow contract takes precedence over the agent profile's default output format. If validation fails, correct the value and call structured_output again.",
          "",
          "Helper tooling: use Node.js for ad hoc JSON/JSONL, XML test-report summaries, manifests, transcripts, and file processing. Do not use Python, python3, pyenv, or mise for these helper scripts. Continue to use the repository's own build and test commands.",
          "Run reporting helpers separately from builds/tests and give each helper an explicit 60-second bash timeout. Give builds/tests an appropriate finite timeout. If a helper times out, change the approach rather than repeating it unchanged; replace a stalled Python helper with Node.js.",
          "",
          "Do not close or release the issue yourself — the workgraph coordinator records your result and its judgment gate decides what it means.",
        ].join("\n"),
      );
      expect(task).not.toContain("PLAN CRITIC");
      expect(task).not.toContain("Proposed implementation plan");
    },
  );
});

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

describe("the critic's completion", () => {
  it("returns structured output as the critique, and neither a verdict nor a plan", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: { model: "provider/critic:high", structuredOutput: TWO_GAPS },
    });
    try {
      const request = makeRunRequest();
      mock.events.emit(CH.runRequest, request);

      const completions = busOn(mock, CH.runCompleted) as CriticCompletion[];
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({
        workflowRunId: request.workflowRunId,
        issueId: "wg-7",
        leaseEpoch: 3,
        outcome: "success",
        critique: TWO_GAPS,
        provenance: { harness: "pi-subagents", model: "provider/critic" },
      });
      expect(completions[0]).not.toHaveProperty("verdict");
      expect(completions[0]).not.toHaveProperty("plan");
      expect(completions[0]).not.toHaveProperty("finalization");
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it.each([
    { name: "an empty gaps list", output: { gaps: [] } },
    { name: "a malformed critique", output: { gaps: "none", approve: true } },
  ])(
    "passes $name through unchanged for the coordinator to validate",
    ({ output }) => {
      const { mock, bridge } = makeBridgeHarness();
      const fake = installFakeSubagents(mock.events, {
        script: { structuredOutput: output },
      });
      try {
        mock.events.emit(CH.runRequest, makeRunRequest());
        const completions = busOn(mock, CH.runCompleted) as CriticCompletion[];
        expect(completions).toHaveLength(1);
        expect(completions[0]!.critique).toEqual(output);
      } finally {
        fake.uninstall();
        bridge.teardown();
      }
    },
  );

  it("a response without structured output completes without a critique, and none is synthesized", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      // Prose that reads like a critique, and a self-acceptance ledger:
      // neither may be promoted into the critique slot.
      script: {
        finalOutput: "Gaps: step 2 does not say which errors retry.",
        acceptance: { status: "accepted" },
      },
    });
    try {
      mock.events.emit(CH.runRequest, makeRunRequest());
      const completions = busOn(mock, CH.runCompleted) as CriticCompletion[];
      expect(completions).toHaveLength(1);
      expect(completions[0]!.outcome).toBe("success");
      expect(completions[0]).not.toHaveProperty("critique");
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("an upstream error response completes as a failure carrying the error text", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: { isError: true, errorText: "critic exploded" },
    });
    try {
      mock.events.emit(CH.runRequest, makeRunRequest());
      const completions = busOn(mock, CH.runCompleted) as CriticCompletion[];
      expect(completions).toHaveLength(1);
      expect(completions[0]!.outcome).toBe("failure");
      expect(completions[0]!.evidence.join("\n")).toContain("critic exploded");
      expect(completions[0]).not.toHaveProperty("critique");
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("an upstream error with no child result reports it as the execution error", () => {
    // The fake's scripted error still carries one child result, which is
    // why this case sends the raw response upstream sends when the launch
    // itself is refused: no child result at all.
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: { mode: "stall" },
    });
    try {
      mock.events.emit(CH.runRequest, makeRunRequest());
      fake.emitRawResponse({
        requestId: fake.requests[0]!.requestId,
        isError: true,
        errorText: "Unknown agent: oracle",
        result: { details: { results: [] } },
      });
      const completions = busOn(mock, CH.runCompleted) as CriticCompletion[];
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({
        outcome: "failure",
        executionError: "Unknown agent: oracle",
      });
      expect(completions[0]).not.toHaveProperty("critique");
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe("canceling a plan critic", () => {
  // Only an in-flight critic is covered. A critic still queued behind
  // another bridge run was never submitted upstream, so the bridge cancels
  // it locally and nothing reaches the fake (`fake.cancels` stays empty);
  // `test/pi-subagents-adapter.test.ts` covers that path for every role.
  it("forwards a cancel for the critic's execution upstream and acks with run:cancelled", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: { mode: "stall", structuredOutput: TWO_GAPS },
    });
    try {
      const request = makeRunRequest();
      mock.events.emit(CH.runRequest, request);
      const accepted = busOn(mock, CH.runAccepted)[0] as {
        executionId: string;
      };

      mock.events.emit(CH.runCancel, {
        ...newEnvelope(),
        workflowRunId: request.workflowRunId,
        issueId: "wg-7",
        executionId: accepted.executionId,
        reason: "no critique in time",
      });

      expect(fake.cancels).toEqual([fake.requests[0]!.requestId]);
      expect(busOn(mock, CH.runCancelled)).toEqual([
        expect.objectContaining({
          workflowRunId: request.workflowRunId,
          issueId: "wg-7",
          executionId: accepted.executionId,
        }),
      ]);
      // The aborted response is the ack, never a late critique.
      expect(busOn(mock, CH.runCompleted)).toHaveLength(0);
      expect(bridge.activeRunCount()).toBe(0);
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// end to end: the real bridge under the real coordinator
// ---------------------------------------------------------------------------

function settle(mock: MockPi, ctx: unknown): Promise<unknown[]> {
  return mock.emit(
    "agent_settled",
    { type: "agent_settled" },
    ctx as Parameters<MockPi["emit"]>[2],
  );
}

/** Approve a seeded issue as high-risk `planned` work. */
function approvePlanned(graph: ScratchGraph, id: string): void {
  graph.op([
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=ready",
    "--set-metadata",
    "workgraph_risk_tier=high",
    "--set-metadata",
    "workgraph_workflow_class=planned",
    "--acceptance",
    "retries back off",
    "--actor",
    "approver",
  ]);
}

async function statusText(
  mock: MockPi,
  id: string,
  cwd: string,
): Promise<string> {
  const def = mock.tools.get("workgraph_status");
  if (!def) throw new Error("tool not registered: workgraph_status");
  const result = await def.execute(
    "call-workgraph_status",
    { id },
    undefined,
    undefined,
    makeToolContext(cwd),
  );
  return (result.content as { type: string; text?: string }[])
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("plan critique through the bridge, under the coordinator", () => {
  it("plans and critiques a high-risk planned issue upstream, then parks it with both gaps shown under their steps", async () => {
    const graph = makeScratchGraph({ prefix: "bridgecrit", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const mock = makeMockPi();
    const config = preProofConfig({
      ...CONFIG,
      workerIdOverride: WORKER,
      planCritique: "high-risk",
    });
    setWorkerIdOverride(WORKER);
    registerWorkgraphTools(asExtensionAPI(mock));
    const coordinator = registerCoordinator(asExtensionAPI(mock), {
      getConfig: () => config,
    });
    const bridge = registerPiSubagentsExecutor(asExtensionAPI(mock), {
      getConfig: () => config,
      probeVersion: () => "0.34.8",
    });
    // One entry per upstream launch: the planner, then the critic. Their
    // models differ, so the summary carries no same-model note.
    const fake = installFakeSubagents(mock.events, {
      script: [
        { model: "provider/planner", structuredOutput: PLAN },
        { model: "provider/critic", structuredOutput: TWO_GAPS },
      ],
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(fake.requests.map((r) => r.params.agent)).toEqual([
        "planner",
        "reviewer",
      ]);
      const critic = fake.requests[1]!.params;
      expect(critic.worktree).toBe(false);
      expect(critic.outputSchema).toEqual(PlanCritique);
      expect(String(critic.task)).toContain("PLAN CRITIC");
      expect(String(critic.task)).toContain(
        `Proposed implementation plan (not yet approved by a human):\n${PLAN_TEXT}`,
      );

      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("plan_review");
      expect(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("2 gaps");
      expect((await latestPlanCritique(graph.dir, id))?.gaps).toEqual(
        TWO_GAPS.gaps,
      );
      expect(bridge.activeRunCount()).toBe(0);

      const lines = (await statusText(mock, id, graph.dir)).split("\n");
      expect(lines).toContain(
        'Critique (advisory): 2 gaps, marked "?" under the steps they concern.',
      );
      const step1 = lines.indexOf("1. add a RetryPolicy type");
      expect(step1).toBeGreaterThanOrEqual(0);
      expect(lines.slice(step1, step1 + 5)).toEqual([
        "1. add a RetryPolicy type",
        "   targets: src/retry.ts",
        "   ? is the policy per client or per request?",
        "2. handle retries in the request path",
        "   ? which errors retry, 429 only or 5xx too?",
      ]);
    } finally {
      await coordinator.teardown(ectx.ctx);
      fake.uninstall();
      bridge.teardown();
      graph.cleanup();
    }
  }, 60_000);
});
