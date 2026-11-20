/**
 * The advisory plan critique, happy path and display: with
 * `planCritique: "high-risk"` a high-risk planned issue gets one
 * `plan_critic` run between the planner's completion and the park, and the
 * human sees its gaps inline in `workgraph_status` and counted in the
 * per-turn context. Plus every case where NO critic may be asked.
 *
 * Timer discipline follows the repo convention: huge poll/heartbeat
 * intervals, tiny real discovery/accept timeouts, event-driven ticks via
 * `agent_settled`, and `flushEvents()` to drain completion handlers (the
 * planner's handler promise spans the whole critique).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { WorkgraphConfig } from "../src/config.ts";
import { registerContextInjection, resetContextCacheForTest } from "../src/context.ts";
import { registerCoordinator, type CoordinatorController } from "../src/coordinator.ts";
import { latestPlanCritique } from "../src/critique.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import { phaseOf, planApprovedOf } from "../src/lifecycle.ts";
import { renderPlan } from "../src/plan.ts";
import { listComments } from "../src/store.ts";
import { setResolvedTiers } from "../src/tiers.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import { WORKGRAPH_PLAN_CRITIQUE_KEY, type PlanCritiqueT, type PlanT } from "../src/types.ts";
import { preProofConfig } from "./helpers/config.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "plan-critique-worker";

const CONFIG = preProofConfig({ workerIdOverride: WORKER, planCritique: "high-risk" });

const PLAN_PROV = { harness: "fake", model: "plan-model", provider: "prov-plan" };
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };
const CRITIC_PROV = { harness: "fake", model: "critic-model", provider: "prov-critic" };

const PLAN: PlanT = {
  summary: "add retry backoff to the client",
  steps: [
    { description: "add a RetryPolicy type", targets: ["src/retry.ts"] },
    { description: "handle retries in the request path" },
  ],
  risks: ["jitter strategy unspecified"],
};

const TWO_GAPS: PlanCritiqueT = {
  gaps: [
    { step: 2, note: "which errors retry, 429 only or 5xx too?" },
    { step: 1, note: "is the policy per client or per request?" },
  ],
};

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
  config: WorkgraphConfig;
}

function makeHarness(overrides: Partial<WorkgraphConfig> = {}, planCritiqueWaitMs?: number): Harness {
  const mock = makeMockPi();
  const config = preProofConfig({ ...CONFIG, ...overrides });
  setWorkerIdOverride(WORKER);
  registerWorkgraphTools(asExtensionAPI(mock));
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
    ...(planCritiqueWaitMs !== undefined ? { planCritiqueWaitMs } : {}),
  });
  return { mock, coordinator, config };
}

function settle(mock: MockPi, ctx: unknown): Promise<unknown[]> {
  return mock.emit("agent_settled", { type: "agent_settled" }, ctx as Parameters<MockPi["emit"]>[2]);
}

function approvePlanned(
  graph: ScratchGraph,
  id: string,
  riskTier: "low" | "medium" | "high" = "high",
  acceptance = "retries back off",
): void {
  graph.op([
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=ready",
    "--set-metadata",
    `workgraph_risk_tier=${riskTier}`,
    "--set-metadata",
    "workgraph_workflow_class=planned",
    "--acceptance",
    acceptance,
    "--actor",
    "approver",
  ]);
}

function runTool(mock: MockPi, name: string, params: unknown, cwd: string) {
  const def = mock.tools.get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def.execute(`call-${name}`, params, undefined, undefined, makeToolContext(cwd));
}

async function statusText(mock: MockPi, id: string, cwd: string): Promise<string> {
  const result = await runTool(mock, "workgraph_status", { id }, cwd);
  return (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
}

async function auditKinds(dir: string, id: string): Promise<string[]> {
  const comments = await listComments(dir, id);
  return comments
    .filter((c) => c.text.startsWith("workgraph-lease "))
    .map((c) => c.text.split(" ")[1]!);
}

/** One executor that plans, critiques, implements, and reviews. */
function installAll(mock: MockPi, critique: unknown, criticProvenance: { harness: string; model?: string } = CRITIC_PROV) {
  return installFakeExecutor(mock.events, {
    roles: ["planner", "implementer", "reviewer", "plan_critic"],
    roleScripts: {
      planner: { provenance: PLAN_PROV, plan: PLAN },
      plan_critic: { provenance: criticProvenance, critique },
      implementer: { provenance: IMPL_PROV, artifacts: ["src/retry.ts"] },
      reviewer: { provenance: REV_PROV, verdict: { findings: [] } },
    },
  });
}

afterEach(() => {
  resetLeasesForTest();
  resetIdentityForTest();
  setResolvedTiers(undefined);
  resetContextCacheForTest();
});

describe("no critic is asked", () => {
  const cases: {
    name: string;
    config: Partial<WorkgraphConfig>;
    riskTier: "low" | "medium" | "high";
  }[] = [
    { name: "planCritique unset", config: { planCritique: undefined }, riskTier: "high" },
    { name: 'planCritique "off"', config: { planCritique: "off" }, riskTier: "high" },
    { name: '"high-risk" with a medium-risk issue', config: {}, riskTier: "medium" },
    { name: '"high-risk" with a low-risk issue', config: {}, riskTier: "low" },
  ];

  for (const c of cases) {
    it(`${c.name}: the plan parks after the planner alone, with an empty critique summary`, async () => {
      const graph = makeScratchGraph({ prefix: "critoff", seed: 1 });
      const id = graph.seededIds[0]!;
      approvePlanned(graph, id, c.riskTier);
      const { mock, coordinator } = makeHarness(c.config);
      const fake = installAll(mock, TWO_GAPS);
      const ectx = makeEventContext(graph.dir);
      try {
        await settle(mock, ectx.ctx);
        await mock.flushEvents();

        expect(fake.requests.map((r) => r.role)).toEqual(["planner"]);
        const shown = graph.showIssue(id);
        expect(phaseOf(shown)).toBe("plan_review");
        expect(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("");
        expect(heldLeases(graph.dir)).toHaveLength(0);
        expect(coordinator.current()).toBeNull();
        const kinds = await auditKinds(graph.dir, id);
        expect(kinds).not.toContain("plan-critique");
        expect(kinds).not.toContain("plan-critique-unavailable");
        // No critique line: the plan follows the review header directly.
        const status = await statusText(mock, id, graph.dir);
        expect(status).not.toContain("Critique");
        expect(status).toContain(renderPlan(PLAN));
      } finally {
        fake.uninstall();
        await coordinator.teardown(ectx.ctx);
        graph.cleanup();
      }
    }, 60_000);
  }

  it('"high-risk" under planApproval: auto goes straight to implementation, never through a critic', async () => {
    const graph = makeScratchGraph({ prefix: "critauto", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness({ planApproval: "auto" });
    const fake = installAll(mock, TWO_GAPS);
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(fake.requests.map((r) => r.role)).toEqual(["planner", "implementer", "reviewer"]);
      expect(graph.showIssue(id).status).toBe("closed");
      expect(await auditKinds(graph.dir, id)).not.toContain("plan-critique");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("a high-risk plan is critiqued before it parks", () => {
  it("asks one plan_critic, records its gaps against the plan, and parks with the summary", async () => {
    const graph = makeScratchGraph({ prefix: "crit", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installAll(mock, TWO_GAPS);
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(fake.requests.map((r) => r.role)).toEqual(["planner", "plan_critic"]);
      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("plan_review");
      expect(shown.status).toBe("open");
      expect(planApprovedOf(shown)).toBe(false);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(coordinator.current()).toBeNull();
      expect(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("2 gaps");
      const kinds = await auditKinds(graph.dir, id);
      expect(kinds).toContain("plan-critique");
      expect(kinds).toContain("plan-review");
      expect(kinds).not.toContain("plan-critique-unavailable");
      expect((await latestPlanCritique(graph.dir, id))?.gaps).toEqual(TWO_GAPS.gaps);

      // The critic read the plan the implementer would get, under the same
      // run and lease, and was told what shape to answer in.
      const [planReq, criticReq] = fake.requests;
      expect(criticReq!.plan).toBe(renderPlan(PLAN));
      expect(criticReq!.outputSchema).toBeDefined();
      expect(criticReq!.issue.acceptanceCriteria).toBe("retries back off");
      expect(criticReq!.issue.riskTier).toBe("high");
      expect(criticReq!.feedback).toBeUndefined();
      expect(criticReq!.workflowRunId).toBe(planReq!.workflowRunId);
      expect(criticReq!.leaseEpoch).toBe(planReq!.leaseEpoch);
      expect(criticReq!.workspace.requiresIsolation).toBe(false);

      // The park audit names the PLANNER's execution, not the critic's.
      const comments = await listComments(graph.dir, id);
      const park = comments.find((c) => c.text.startsWith("workgraph-lease plan-review "))!;
      expect(park.text).toContain(fake.completions[0]!.executionId);
      expect(park.text).not.toContain(fake.completions[1]!.executionId);

      // Another tick claims nothing: plan_review is not dispatchable.
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(fake.requests).toHaveLength(2);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("once the critiqued plan is approved, the next tick implements it and the run closes through review", async () => {
    const graph = makeScratchGraph({ prefix: "critgo", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installAll(mock, TWO_GAPS);
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(phaseOf(graph.showIssue(id))).toBe("plan_review");

      await runTool(mock, "workgraph_approve_plan", { id, decision: "approve" }, graph.dir);
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(fake.requests.map((r) => r.role)).toEqual(["planner", "plan_critic", "implementer", "reviewer"]);
      expect(graph.showIssue(id).status).toBe("closed");
      expect(phaseOf(graph.showIssue(id))).toBe("accepted");
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a single executor at maxConcurrency 1 can critique the plan it just produced", async () => {
    const graph = makeScratchGraph({ prefix: "critcap", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["planner", "implementer", "plan_critic"],
      maxConcurrency: 1,
      roleScripts: {
        planner: { provenance: PLAN_PROV, plan: PLAN },
        plan_critic: { provenance: CRITIC_PROV, critique: TWO_GAPS },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(fake.requests.map((r) => r.role)).toEqual(["planner", "plan_critic"]);
      expect(graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("2 gaps");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("the critique summary", () => {
  const eightGaps: PlanCritiqueT = {
    gaps: Array.from({ length: 8 }, (_, i) => ({ step: (i % 2) + 1, note: `GAP-NOTE-${i + 1}` })),
  };

  it("eight gaps are capped at five, in the critic's order, and the summary counts what is shown", async () => {
    const graph = makeScratchGraph({ prefix: "crit8", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installAll(mock, eightGaps);
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("5 gaps");
      expect((await latestPlanCritique(graph.dir, id))?.gaps.map((g) => g.note)).toEqual([
        "GAP-NOTE-1",
        "GAP-NOTE-2",
        "GAP-NOTE-3",
        "GAP-NOTE-4",
        "GAP-NOTE-5",
      ]);
      const status = await statusText(mock, id, graph.dir);
      expect(status).toContain('Critique (advisory): 5 gaps, marked "?" under the steps they concern.');
      for (let i = 1; i <= 5; i++) expect(status).toContain(`? GAP-NOTE-${i}`);
      for (let i = 6; i <= 8; i++) expect(status).not.toContain(`GAP-NOTE-${i}`);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("zero gaps reads as build-ready and leaves the plan body exactly as the implementer will get it", async () => {
    const graph = makeScratchGraph({ prefix: "crit0", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installAll(mock, { gaps: [] });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("0 gaps");
      expect(await auditKinds(graph.dir, id)).toContain("plan-critique");
      const status = await statusText(mock, id, graph.dir);
      const header =
        "Plan awaiting your review — workgraph_approve_plan with decision approve, or reject plus feedback:";
      expect(status).toContain(`${header}\nCritique (advisory): build-ready, 0 gaps.\n${renderPlan(PLAN)}`);
      expect(status).not.toContain("could not be read");
      expect(status).not.toContain("   ? ");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  const modelCases: { name: string; critic: { harness: string; model?: string }; expected: string }[] = [
    { name: "the planner's own model", critic: { harness: "fake", model: "plan-model" }, expected: "2 gaps, same model as planner" },
    { name: "a different model", critic: CRITIC_PROV, expected: "2 gaps" },
    { name: "no reported model", critic: { harness: "fake" }, expected: "2 gaps" },
  ];
  for (const c of modelCases) {
    it(`a critic on ${c.name} summarizes as "${c.expected}"`, async () => {
      const graph = makeScratchGraph({ prefix: "critmodel", seed: 1 });
      const id = graph.seededIds[0]!;
      approvePlanned(graph, id);
      const { mock, coordinator } = makeHarness();
      const fake = installAll(mock, TWO_GAPS, c.critic);
      const ectx = makeEventContext(graph.dir);
      try {
        await settle(mock, ectx.ctx);
        await mock.flushEvents();
        expect(graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe(c.expected);
        const status = await statusText(mock, id, graph.dir);
        expect(status).toContain(`Critique (advisory): ${c.expected}, marked "?" under the steps they concern.`);
      } finally {
        fake.uninstall();
        await coordinator.teardown(ectx.ctx);
        graph.cleanup();
      }
    }, 60_000);
  }

  it("a zero-gap critique on the planner's model keeps the same-model note", async () => {
    const graph = makeScratchGraph({ prefix: "crit0same", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installAll(mock, { gaps: [] }, { harness: "fake", model: "plan-model" });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("0 gaps, same model as planner");
      expect(await statusText(mock, id, graph.dir)).toContain(
        "Critique (advisory): build-ready, 0 gaps, same model as planner.",
      );
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("inline display", () => {
  it("workgraph_status prints each gap under its step, and step-less or out-of-range gaps under the plan as a whole", async () => {
    const graph = makeScratchGraph({ prefix: "critshow", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installAll(mock, {
      gaps: [
        { step: 2, note: "which errors retry, 429 only or 5xx too?" },
        { note: "no rollback is described" },
        { step: 99, note: "refers to a step that does not exist" },
      ],
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const status = await statusText(mock, id, graph.dir);
      const lines = status.split("\n");
      const header = lines.indexOf(
        "Plan awaiting your review — workgraph_approve_plan with decision approve, or reject plus feedback:",
      );
      expect(header).toBeGreaterThanOrEqual(0);
      expect(lines[header + 1]).toBe('Critique (advisory): 3 gaps, marked "?" under the steps they concern.');

      const step2 = lines.indexOf("2. handle retries in the request path");
      expect(lines[step2 + 1]).toBe("   ? which errors retry, 429 only or 5xx too?");
      const whole = lines.indexOf("Plan as a whole:");
      expect(whole).toBeGreaterThan(step2);
      expect(lines.slice(whole + 1, whole + 3)).toEqual([
        "? no rollback is described",
        "? (step 99) refers to a step that does not exist",
      ]);
      // Step 1 carries no gap.
      const step1 = lines.indexOf("1. add a RetryPolicy type");
      expect(lines[step1 + 1]).toBe("   targets: src/retry.ts");
      expect(lines[step1 + 2]).toBe("2. handle retries in the request path");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("says so when the summary counts gaps whose record cannot be read, and shows the plain plan", async () => {
    const graph = makeScratchGraph({ prefix: "critlost", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    // The planner alone parks the plan; the summary is then stamped by hand,
    // which is what a failed critique-comment write leaves behind.
    const { mock, coordinator } = makeHarness({ planCritique: "off" });
    const fake = installAll(mock, TWO_GAPS);
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      graph.op(["update", id, "--set-metadata", `${WORKGRAPH_PLAN_CRITIQUE_KEY}=2 gaps`, "--actor", "approver"]);

      const status = await statusText(mock, id, graph.dir);
      expect(status).toContain("Critique (advisory): 2 gaps, but its details could not be read.");
      expect(status).toContain(renderPlan(PLAN));
      expect(status).not.toContain("   ? ");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("the per-turn context line for the parked plan carries the critique summary", async () => {
    const graph = makeScratchGraph({ prefix: "critctx", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    registerContextInjection(asExtensionAPI(mock));
    const fake = installAll(mock, TWO_GAPS);
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      // Emitted only after the park: graph state is cached per cwd.
      const prompt = await mock.emitBeforeAgentStart(ectx.ctx, { systemPrompt: "BASE" });
      const line = prompt.split("\n").find((l) => l.startsWith(`- ${id} `));
      expect(line).toBeDefined();
      expect(line).toContain("2 steps");
      expect(line).toContain("critique: 2 gaps");
      expect(line!.endsWith(" · critique: 2 gaps")).toBe(true);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("the per-turn context line has no critique suffix when none was attempted", async () => {
    const graph = makeScratchGraph({ prefix: "critctx0", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id, "medium");
    const { mock, coordinator } = makeHarness();
    registerContextInjection(asExtensionAPI(mock));
    const fake = installAll(mock, TWO_GAPS);
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      const prompt = await mock.emitBeforeAgentStart(ectx.ctx, { systemPrompt: "BASE" });
      const line = prompt.split("\n").find((l) => l.startsWith(`- ${id} `));
      expect(line).toBeDefined();
      expect(line).not.toContain("critique");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});
