/**
 * A plan critique is advice for the human approving the plan, never
 * authority: it cannot change the plan, the acceptance criteria, or the
 * approval, and no executor downstream ever reads a gap. These tests pin
 * that from the outside — by what the plan record, the issue, and every
 * later `run:request` contain after a critic has spoken.
 *
 * Gap notes use distinctive `ZZ-GAP-n` strings so their absence can be
 * asserted on whole payloads.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { WorkgraphConfig } from "../src/config.ts";
import { registerCoordinator, type CoordinatorController } from "../src/coordinator.ts";
import { latestPlanCritique } from "../src/critique.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import { phaseOf, planApprovedOf } from "../src/lifecycle.ts";
import { latestPlan, renderPlan } from "../src/plan.ts";
import { listComments } from "../src/store.ts";
import { setResolvedTiers } from "../src/tiers.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import { WORKGRAPH_PLAN_CRITIQUE_KEY, WORKGRAPH_PLAN_SUMMARY_KEY, type PlanCritiqueT, type PlanT } from "../src/types.ts";
import { preProofConfig } from "./helpers/config.ts";
import { installFakeExecutor, type RoleScript } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "plan-critique-authority-worker";
const ACCEPTANCE = "retries back off, capped at five attempts";

const CONFIG = preProofConfig({ workerIdOverride: WORKER, planCritique: "high-risk" });

const PLAN_PROV = { harness: "fake", model: "plan-model", provider: "prov-plan" };
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };
const CRITIC_PROV = { harness: "fake", model: "critic-model", provider: "prov-critic" };

const PLAN: PlanT = {
  summary: "add retry backoff to the client",
  steps: [
    { description: "add a RetryPolicy type", targets: ["src/retry.ts"] },
    { description: "handle retries in the request path", rationale: "one place to cap attempts" },
  ],
  risks: ["jitter strategy unspecified"],
};

const SECOND_PLAN: PlanT = {
  summary: "retry with jitter",
  steps: [{ description: "add jittered backoff" }, { description: "wire it in" }],
};

const GAPS: PlanCritiqueT = {
  summary: "ZZ-GAP-SUMMARY two things an implementer would guess at",
  gaps: [
    { step: 2, note: "ZZ-GAP-1 which errors retry, 429 only or 5xx too?" },
    { note: "ZZ-GAP-2 no rollback is described" },
  ],
};

const MAIN = "main";
const CRITIC = "critic";

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
  config: WorkgraphConfig;
}

function makeHarness(overrides: Partial<WorkgraphConfig> = {}): Harness {
  const mock = makeMockPi();
  const config = preProofConfig({ ...CONFIG, ...overrides });
  setWorkerIdOverride(WORKER);
  registerWorkgraphTools(asExtensionAPI(mock));
  const coordinator = registerCoordinator(asExtensionAPI(mock), { getConfig: () => config });
  return { mock, coordinator, config };
}

function settle(mock: MockPi, ctx: unknown): Promise<unknown[]> {
  return mock.emit("agent_settled", { type: "agent_settled" }, ctx as Parameters<MockPi["emit"]>[2]);
}

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
    ACCEPTANCE,
    "--actor",
    "approver",
  ]);
}

function runTool(mock: MockPi, name: string, params: unknown, cwd: string) {
  const def = mock.tools.get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def.execute(`call-${name}`, params, undefined, undefined, makeToolContext(cwd));
}

async function planComments(dir: string, id: string): Promise<string[]> {
  const comments = await listComments(dir, id);
  return comments.filter((c) => c.text.startsWith("workgraph-plan plan ")).map((c) => c.text);
}

/** Poll an in-memory condition while a chain is deliberately left blocked. */
async function until(cond: () => boolean, timeoutMs = 10_000, intervalMs = 15): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("until: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function installMain(mock: MockPi, planner: RoleScript | RoleScript[] = { provenance: PLAN_PROV, plan: PLAN }) {
  return installFakeExecutor(mock.events, {
    executorId: MAIN,
    roles: ["planner", "implementer", "reviewer"],
    roleScripts: {
      planner,
      implementer: { provenance: IMPL_PROV, artifacts: ["src/retry.ts"] },
      reviewer: { provenance: REV_PROV, verdict: { findings: [] } },
    },
  });
}

function installCritic(mock: MockPi, script: RoleScript) {
  return installFakeExecutor(mock.events, {
    executorId: CRITIC,
    roles: ["plan_critic"],
    roleScripts: { plan_critic: { provenance: CRITIC_PROV, ...script } },
  });
}

afterEach(() => {
  resetLeasesForTest();
  resetIdentityForTest();
  setResolvedTiers(undefined);
});

describe("a critique changes nothing it comments on", () => {
  it("leaves the plan record and the acceptance criteria exactly as they were before it arrived", async () => {
    const graph = makeScratchGraph({ prefix: "caplan", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    const critic = installCritic(mock, { behavior: "accept-stall", critique: GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await until(() => coordinator.current()?.executionId === `${CRITIC}-exec-1`);

      // The plan is recorded and the critic is still thinking.
      const before = await planComments(graph.dir, id);
      expect(before).toHaveLength(1);
      const criteriaBefore = graph.showIssue(id).acceptance_criteria;
      expect(criteriaBefore).toBe(ACCEPTANCE);

      critic.complete();
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("plan_review");
      expect(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("2 gaps");
      expect(await planComments(graph.dir, id)).toEqual(before);
      expect(shown.acceptance_criteria).toBe(criteriaBefore);
      expect(String(shown.metadata?.[WORKGRAPH_PLAN_SUMMARY_KEY])).not.toContain("ZZ-GAP");
      expect(await latestPlan(graph.dir, id)).toEqual(PLAN);
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      await mock.flushEvents();
      graph.cleanup();
    }
  }, 60_000);

  it("a critic that tries to approve, rewrite the criteria, or replace the steps is read for its gaps alone", async () => {
    const graph = makeScratchGraph({ prefix: "caextra", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    const critic = installCritic(mock, {
      critique: {
        ...GAPS,
        approve: true,
        approved: true,
        acceptanceCriteria: "ZZ-GAP-CRITERIA anything goes",
        steps: [{ description: "ZZ-GAP-STEP do something else entirely" }],
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("plan_review");
      expect(planApprovedOf(shown)).toBe(false);
      expect(shown.status).toBe("open");
      expect(shown.acceptance_criteria).toBe(ACCEPTANCE);
      expect(await latestPlan(graph.dir, id)).toEqual(PLAN);
      expect(await planComments(graph.dir, id)).toHaveLength(1);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      // Only the main executor's planner ran besides the critic: nothing
      // was dispatched on the strength of the critic's "approval".
      expect(main.requests.map((r) => r.role)).toEqual(["planner"]);

      // The extra fields are not even persisted with the critique.
      expect(await latestPlanCritique(graph.dir, id)).toEqual(GAPS);
      const trail = (await listComments(graph.dir, id)).map((c) => c.text).join("\n");
      expect(trail).not.toContain("ZZ-GAP-CRITERIA");
      expect(trail).not.toContain("ZZ-GAP-STEP");
      expect(JSON.stringify(shown.metadata)).not.toContain("ZZ-GAP");
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("no executor downstream reads a gap", () => {
  it("the implementer and the reviewer receive the plan as recorded, with no critique text", async () => {
    const graph = makeScratchGraph({ prefix: "caimpl", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    const critic = installCritic(mock, { critique: GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("2 gaps");

      await runTool(mock, "workgraph_approve_plan", { id, decision: "approve" }, graph.dir);
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(main.requests.map((r) => r.role)).toEqual(["planner", "implementer", "reviewer"]);
      expect(critic.requests).toHaveLength(1);
      const expected = renderPlan((await latestPlan(graph.dir, id))!);
      const [, implReq, reviewReq] = main.requests;
      expect(implReq!.plan).toBe(expected);
      expect(reviewReq!.plan).toBe(expected);
      for (const request of [implReq!, reviewReq!]) {
        const payload = JSON.stringify(request);
        expect(payload).not.toContain("ZZ-GAP");
        expect(payload).not.toContain("   ? ");
        expect(payload).not.toContain("Plan as a whole:");
        expect(request.issue.acceptanceCriteria).toBe(ACCEPTANCE);
      }
      expect(graph.showIssue(id).status).toBe("closed");
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a rejected plan goes back to the planner with the human's feedback and nothing from the critic", async () => {
    const graph = makeScratchGraph({ prefix: "carej", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock, [
      { provenance: PLAN_PROV, plan: PLAN },
      { provenance: PLAN_PROV, plan: SECOND_PLAN },
    ]);
    const critic = installCritic(mock, { critique: GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("2 gaps");

      const feedback = "say which errors retry";
      await runTool(mock, "workgraph_approve_plan", { id, decision: "reject", feedback }, graph.dir);
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(main.requests.map((r) => r.role)).toEqual(["planner", "planner"]);
      const replan = main.requests[1]!;
      expect(replan.feedback).toBe(feedback);
      expect(replan.plan).toBeUndefined();
      expect(JSON.stringify(replan)).not.toContain("ZZ-GAP");
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});
