/**
 * The human plan gate: a recorded plan parks in `plan_review` with its
 * lease released; `workgraph_approve_plan` sends it back to `ready`, where
 * the next tick either implements the recorded plan (approved) or plans
 * again with the feedback (rejected). Plus the in-session planner (plan
 * submitted through `workgraph_submit_plan`) and tiered model switching.
 *
 * Timer discipline follows the repo convention: huge poll/heartbeat
 * intervals, tiny real discovery/accept timeouts, event-driven ticks via
 * `agent_settled`, and `flushEvents()` to drain completion handlers.
 */
import { afterEach, describe, expect, it } from "vitest";
import { registerInSessionExecutor, SUBMIT_PLAN_TOOL } from "../src/adapters/in-session.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import { registerCoordinator, type CoordinatorController } from "../src/coordinator.ts";
import { renderWorkgraphSection } from "../src/context.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import { LEGAL, phaseOf, planApprovedOf, planFeedbackOf } from "../src/lifecycle.ts";
import { latestPlan } from "../src/plan.ts";
import { listComments } from "../src/store.ts";
import { loadStoredTiers, resolveTiers, setResolvedTiers, tierFor } from "../src/tiers.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import { WORKGRAPH_PLAN_SUMMARY_KEY, type PlanT } from "../src/types.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "plan-gate-worker";

const CONFIG: WorkgraphConfig = {
  leaseTtlMs: 300_000,
  heartbeatMs: 600_000,
  pollMs: 600_000,
  sweepIntervalMs: 600_000,
  discoveryTimeoutMs: 40,
  acceptTimeoutMs: 150,
  compatInSessionExecutor: false,
  workerIdOverride: WORKER,
};

const PLAN_PROV = { harness: "fake", model: "plan-model", provider: "prov-plan" };
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };

const PLAN: PlanT = {
  summary: "add retry backoff to the client",
  steps: [
    { description: "add an exponential backoff helper", targets: ["src/retry.ts"] },
    { description: "call it from the request path" },
  ],
  risks: ["jitter strategy unspecified"],
};

const SECOND_PLAN: PlanT = {
  summary: "retry with jitter",
  steps: [{ description: "add jittered backoff" }, { description: "wire it in" }, { description: "test it" }],
};

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
  config: WorkgraphConfig;
}

function makeHarness(overrides: Partial<WorkgraphConfig> = {}): Harness {
  const mock = makeMockPi();
  const config: WorkgraphConfig = { ...CONFIG, ...overrides };
  setWorkerIdOverride(WORKER);
  registerWorkgraphTools(asExtensionAPI(mock));
  const coordinator = registerCoordinator(asExtensionAPI(mock), { getConfig: () => config });
  return { mock, coordinator, config };
}

function settle(mock: MockPi, ctx: unknown): Promise<unknown[]> {
  return mock.emit("agent_settled", { type: "agent_settled" }, ctx as Parameters<MockPi["emit"]>[2]);
}

function approvePlanned(graph: ScratchGraph, id: string, acceptance = "retries back off"): void {
  graph.op([
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=ready",
    "--set-metadata",
    "workgraph_risk_tier=medium",
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

async function auditKinds(dir: string, id: string): Promise<string[]> {
  const comments = await listComments(dir, id);
  return comments
    .filter((c) => c.text.startsWith("workgraph-lease "))
    .map((c) => c.text.split(" ")[1]!);
}

afterEach(() => {
  resetLeasesForTest();
  resetIdentityForTest();
  setResolvedTiers(undefined);
});

describe("lifecycle edges", () => {
  it("planning reaches plan_review, and plan_review only returns to ready", () => {
    expect(LEGAL.planning).toContain("plan_review");
    expect(LEGAL.plan_review).toEqual(["ready"]);
  });
});

describe("the plan gate (default: required)", () => {
  it("parks the recorded plan in plan_review with the lease released, then implements it once approved", async () => {
    const graph = makeScratchGraph({ prefix: "gate", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["planner", "implementer", "reviewer"],
      roleScripts: {
        planner: { provenance: PLAN_PROV, plan: PLAN },
        implementer: { provenance: IMPL_PROV, artifacts: ["src/retry.ts"] },
        reviewer: { provenance: REV_PROV, verdict: { findings: [] } },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      // Only the planner ran; the issue now waits on a human.
      expect(fake.requests.map((r) => r.role)).toEqual(["planner"]);
      let shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("plan_review");
      expect(shown.status).toBe("open");
      expect(shown.assignee ?? "").toBe("");
      expect(planApprovedOf(shown)).toBe(false);
      expect(String(shown.metadata?.[WORKGRAPH_PLAN_SUMMARY_KEY])).toContain("2 steps");
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(coordinator.current()).toBeNull();
      expect(await auditKinds(graph.dir, id)).toContain("plan-review");
      expect(
        mock.busEvents.some(
          (e) => e.channel === "workgraph:v1:activity" && (e.data as { kind?: string }).kind === "plan-review",
        ),
      ).toBe(true);
      // The plan is readable back from the trail, planner summary intact.
      const recorded = await latestPlan(graph.dir, id);
      expect(recorded?.steps.map((s) => s.description)).toEqual(PLAN.steps.map((s) => s.description));
      expect(recorded?.summary).toBe(PLAN.summary);

      // Another tick claims nothing: plan_review is not dispatchable.
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(fake.requests).toHaveLength(1);

      // Approve → ready with the flag; the next tick implements WITH the plan,
      // skipping the planner, and the chain finishes as before.
      await runTool(mock, "workgraph_approve_plan", { id, decision: "approve" }, graph.dir);
      shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("ready");
      expect(planApprovedOf(shown)).toBe(true);
      expect(await auditKinds(graph.dir, id)).toContain("plan-approved");

      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(fake.requests.map((r) => r.role)).toEqual(["planner", "implementer", "reviewer"]);
      const implReq = fake.requests[1]!;
      expect(implReq.plan).toContain("1. add an exponential backoff helper");
      expect(implReq.plan).toContain("2. call it from the request path");
      // A fresh workflow run: the planning run ended at the gate.
      expect(implReq.workflowRunId).not.toBe(fake.requests[0]!.workflowRunId);
      expect(graph.showIssue(id).status).toBe("closed");
      expect(phaseOf(graph.showIssue(id))).toBe("accepted");
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("rejecting a plan re-plans with the feedback attached, and the new plan parks again", async () => {
    const graph = makeScratchGraph({ prefix: "gaterej", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["planner", "implementer"],
      roleScripts: {
        planner: [
          { provenance: PLAN_PROV, plan: PLAN },
          { provenance: PLAN_PROV, plan: SECOND_PLAN },
        ],
        implementer: { provenance: IMPL_PROV },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(phaseOf(graph.showIssue(id))).toBe("plan_review");

      await expect(
        runTool(mock, "workgraph_approve_plan", { id, decision: "reject" }, graph.dir),
      ).rejects.toThrow(/feedback/);
      await runTool(
        mock,
        "workgraph_approve_plan",
        { id, decision: "reject", feedback: "add jitter and tests" },
        graph.dir,
      );
      let shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("ready");
      expect(planApprovedOf(shown)).toBe(false);
      expect(planFeedbackOf(shown)).toBe("add jitter and tests");
      expect(await auditKinds(graph.dir, id)).toContain("plan-rejected");

      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(fake.requests.map((r) => r.role)).toEqual(["planner", "planner"]);
      expect(fake.requests[1]!.feedback).toBe("add jitter and tests");
      expect(fake.requests[1]!.plan).toBeUndefined();

      shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("plan_review");
      expect(planFeedbackOf(shown)).toBeUndefined(); // consumed by the re-plan
      expect(String(shown.metadata?.[WORKGRAPH_PLAN_SUMMARY_KEY])).toContain("3 steps");
      expect((await latestPlan(graph.dir, id))?.summary).toBe("retry with jitter");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("workgraph_approve_plan refuses issues that are not in plan_review", async () => {
    const graph = makeScratchGraph({ prefix: "gatephase", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock } = makeHarness();
    try {
      await expect(
        runTool(mock, "workgraph_approve_plan", { id, decision: "approve" }, graph.dir),
      ).rejects.toThrow(/not plan_review/);
    } finally {
      graph.cleanup();
    }
  });

  it("planApproval: auto flows straight from planning into implementation", async () => {
    const graph = makeScratchGraph({ prefix: "gateauto", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness({ planApproval: "auto" });
    const fake = installFakeExecutor(mock.events, {
      roles: ["planner", "implementer", "reviewer"],
      roleScripts: {
        planner: { provenance: PLAN_PROV, plan: PLAN },
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: { findings: [] } },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(fake.requests.map((r) => r.role)).toEqual(["planner", "implementer", "reviewer"]);
      expect(graph.showIssue(id).status).toBe("closed");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("in-session planner", () => {
  it("wakes the session with a planning prompt, takes the plan from workgraph_submit_plan, and parks it for review", async () => {
    const graph = makeScratchGraph({ prefix: "insplan", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const mock = makeMockPi();
    const config: WorkgraphConfig = { ...CONFIG, compatInSessionExecutor: true };
    setWorkerIdOverride(WORKER);
    registerWorkgraphTools(asExtensionAPI(mock));
    const adapter = registerInSessionExecutor(asExtensionAPI(mock), { getConfig: () => config });
    const coordinator = registerCoordinator(asExtensionAPI(mock), { getConfig: () => config });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(adapter.activeRun()?.role).toBe("planner");
      expect(phaseOf(graph.showIssue(id))).toBe("planning");
      const wake = mock.sendMessages.at(-1)!;
      expect(String(wake.message.content)).toContain("[workgraph planning]");
      expect(String(wake.message.content)).toContain(SUBMIT_PLAN_TOOL);
      expect(String(wake.message.content)).toContain("retries back off");

      // The model submits its plan through the tool, then the turn ends.
      const result = await runTool(mock, SUBMIT_PLAN_TOOL, PLAN, graph.dir);
      expect(JSON.stringify(result.content)).toContain("Plan recorded (2 steps)");
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(adapter.activeRun()).toBeNull();
      expect(phaseOf(graph.showIssue(id))).toBe("plan_review");
      expect((await latestPlan(graph.dir, id))?.summary).toBe(PLAN.summary);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      // Submitting outside a planning turn is refused.
      await expect(runTool(mock, SUBMIT_PLAN_TOOL, PLAN, graph.dir)).rejects.toThrow(/no planning run/);
    } finally {
      adapter.teardown();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a planning turn that ends without a submitted plan escalates", async () => {
    const graph = makeScratchGraph({ prefix: "insnoplan", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const mock = makeMockPi();
    const config: WorkgraphConfig = { ...CONFIG, compatInSessionExecutor: true };
    setWorkerIdOverride(WORKER);
    registerWorkgraphTools(asExtensionAPI(mock));
    const adapter = registerInSessionExecutor(asExtensionAPI(mock), { getConfig: () => config });
    const coordinator = registerCoordinator(asExtensionAPI(mock), { getConfig: () => config });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(adapter.activeRun()?.role).toBe("planner");
      await settle(mock, ectx.ctx); // the turn ends; nothing was submitted
      await mock.flushEvents();
      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("escalated");
      expect(shown.status).toBe("blocked");
    } finally {
      adapter.teardown();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("model tiers in-session", () => {
  it("switches the session model for a tiered role, reports it as provenance, and restores afterwards", async () => {
    const graph = makeScratchGraph({ prefix: "tier", seed: 1 });
    const id = graph.seededIds[0]!;
    graph.op([
      "update",
      id,
      "--set-metadata",
      "workgraph_lifecycle_version=1",
      "--set-metadata",
      "workgraph_phase=ready",
      "--set-metadata",
      "workgraph_risk_tier=low",
      "--set-metadata",
      "workgraph_workflow_class=oneshot",
      "--actor",
      "approver",
    ]);
    const previous = { id: "big-model", provider: "prov", name: "Big" };
    const fast = { id: "fast-model", provider: "prov", name: "Fast" };
    setResolvedTiers({
      implementer: {
        role: "implementer",
        pattern: "prov/fast-*",
        model: fast as never,
        id: "prov/fast-model",
        thinking: "low",
      },
    });
    const mock = makeMockPi();
    const config: WorkgraphConfig = { ...CONFIG, compatInSessionExecutor: true };
    setWorkerIdOverride(WORKER);
    const adapter = registerInSessionExecutor(asExtensionAPI(mock), { getConfig: () => config });
    const coordinator = registerCoordinator(asExtensionAPI(mock), { getConfig: () => config });
    const ectx = makeEventContext(graph.dir, { model: previous });
    try {
      await mock.emit("session_start", { type: "session_start" }, ectx.ctx);
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(adapter.activeRun()?.role).toBe("implementer");
      expect(mock.modelCalls).toEqual([fast]);
      expect(mock.thinkingCalls).toEqual(["low"]);

      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(adapter.activeRun()).toBeNull();
      // Restored to the model the session had before the run, and thinking.
      expect(mock.modelCalls).toEqual([fast, previous]);
      expect(mock.thinkingCalls).toEqual(["low", "medium"]);
      const completion = mock.busEvents.find((e) => e.channel === "workgraph:v1:run:completed");
      expect((completion?.data as { provenance?: { model?: string } }).provenance?.model).toBe(
        "big-model",
      );
    } finally {
      adapter.teardown();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("context injection", () => {
  it("lists plans awaiting review under their own heading", () => {
    const section = renderWorkgraphSection(
      {
        initialized: true,
        readyCount: 0,
        readyTop: [],
        planReview: [
          {
            id: "gate-abc",
            title: "retry backoff",
            status: "open",
            priority: 2,
            issue_type: "task",
            metadata: { [WORKGRAPH_PLAN_SUMMARY_KEY]: "2 steps: add retry backoff" },
          },
        ],
        fetchedAt: 0,
      },
      [],
      0,
    );
    expect(section).toContain("Plans awaiting your review");
    expect(section).toContain("- gate-abc retry backoff — 2 steps: add retry backoff");
    expect(section).toContain("workgraph_approve_plan");
  });
});

describe("workgraph_init and workgraph_create", () => {
  it("init creates a workspace in a bare directory; create makes drafts or approved issues", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { closeWorkspace } = await import("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-init-"));
    const { mock } = makeHarness();
    try {
      await expect(runTool(mock, "workgraph_ready", {}, dir)).rejects.toThrow(/workgraph_init/);
      const init = await runTool(mock, "workgraph_init", { prefix: "fresh" }, dir);
      expect((init.details as { created: boolean }).created).toBe(true);
      expect((await runTool(mock, "workgraph_init", {}, dir)).details).toMatchObject({ created: false });

      const draft = await runTool(mock, "workgraph_create", { title: "a draft" }, dir);
      const draftIssue = (draft.details as { issue: { id: string; metadata?: Record<string, unknown> } }).issue;
      expect(draftIssue.id.startsWith("fresh-")).toBe(true);
      expect(draftIssue.metadata?.workgraph_phase).toBeUndefined();

      const approved = await runTool(
        mock,
        "workgraph_create",
        {
          title: "planned work",
          approve: true,
          workflowClass: "planned",
          riskTier: "high",
          acceptanceCriteria: "tests green",
          dependsOn: [draftIssue.id],
        },
        dir,
      );
      const issue = (approved.details as { issue: { id: string; metadata?: Record<string, unknown>; acceptance_criteria?: string; dependencies?: { id: string }[] } }).issue;
      expect(issue.metadata).toMatchObject({
        workgraph_lifecycle_version: 1,
        workgraph_phase: "ready",
        workgraph_workflow_class: "planned",
        workgraph_risk_tier: "high",
      });
      expect(issue.acceptance_criteria).toBe("tests green");
      expect(issue.dependencies?.map((d) => d.id)).toEqual([draftIssue.id]);
      expect(await auditKinds(dir, issue.id)).toContain("approve");
      // Blocked by the draft, so not ready yet.
      const ready = await runTool(mock, "workgraph_ready", {}, dir);
      expect((ready.details as { issues: unknown[] }).issues).toHaveLength(0);
    } finally {
      closeWorkspace(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workgraph_tiers", () => {
  it("stores the table per workspace, resolves it against the registry, and reloads it next session", async () => {
    const graph = makeScratchGraph({ prefix: "tiers" });
    const { mock } = makeHarness();
    const registry = {
      getAvailable: () => [
        { provider: "anthropic", id: "claude-opus-4-7", name: "o47" },
        { provider: "anthropic", id: "claude-opus-5", name: "o5" },
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "s45" },
      ],
    };
    const ctx = { ...makeToolContext(graph.dir), modelRegistry: registry } as never;
    const call = (params: unknown) =>
      mock.tools.get("workgraph_tiers")!.execute("call-tiers", params, undefined, undefined, ctx);
    try {
      const none = await call({});
      expect(JSON.stringify(none.content)).toContain("No model tiers");

      const set = await call({
        table: {
          planner: { model: "anthropic/claude-opus-*", thinking: "high" },
          implementer: { model: "anthropic/claude-sonnet-*", thinking: "medium" },
          reviewer: "anthropic/claude-opus-*",
        },
      });
      expect(JSON.stringify(set.content)).toContain("planner: anthropic/claude-opus-5 (thinking high)");
      expect(JSON.stringify(set.content)).toContain("implementer: anthropic/claude-sonnet-4-5 (thinking medium)");
      expect(tierFor("planner")?.id).toBe("anthropic/claude-opus-5");
      expect((await loadStoredTiers(graph.dir))?.planner?.model).toBe("anthropic/claude-opus-*");

      // A later session reloads it from the workspace, flag-free.
      setResolvedTiers(undefined);
      const { resolved } = resolveTiers(registry as never, (await loadStoredTiers(graph.dir))!);
      expect(resolved.reviewer?.id).toBe("anthropic/claude-opus-5");

      const table = await call({ table: { implementer: { model: "anthropic/claude-opus-4*", thinking: "low" }, bogus: "x" } });
      expect(JSON.stringify(table.content)).toContain("implementer: anthropic/claude-opus-4-7 (thinking low)");
      expect(tierFor("planner")).toBeUndefined();

      const off = await call({ clear: true });
      expect(JSON.stringify(off.content)).toContain("No model tiers");
      expect(await loadStoredTiers(graph.dir)).toBeUndefined();
      expect(tierFor("implementer")).toBeUndefined();
    } finally {
      graph.cleanup();
    }
  });
});

describe("per-role executor pins", () => {
  it("plans on the pinned chat executor and implements/reviews on the pinned worker executor", async () => {
    const graph = makeScratchGraph({ prefix: "pins", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness({
      planApproval: "auto",
      executorByRole: { planner: "chat", implementer: "workers", reviewer: "workers" },
    });
    // Without pins the higher-priority "workers" would plan too.
    const chat = installFakeExecutor(mock.events, {
      executorId: "chat",
      roles: ["planner", "implementer"],
      priority: 0,
      roleScripts: {
        planner: { provenance: PLAN_PROV, plan: PLAN },
        implementer: { provenance: IMPL_PROV },
      },
    });
    const workers = installFakeExecutor(mock.events, {
      executorId: "workers",
      roles: ["planner", "implementer", "reviewer"],
      priority: 10,
      roleScripts: {
        planner: { provenance: PLAN_PROV, plan: SECOND_PLAN },
        implementer: { provenance: IMPL_PROV, artifacts: ["src/retry.ts"] },
        reviewer: { provenance: REV_PROV, verdict: { findings: [] } },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(chat.requests.map((r) => r.role)).toEqual(["planner"]);
      expect(workers.requests.map((r) => r.role)).toEqual(["implementer", "reviewer"]);
      expect(workers.requests[0]!.plan).toContain("add an exponential backoff helper");
      expect(graph.showIssue(id).status).toBe("closed");
    } finally {
      chat.uninstall();
      workers.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a pinned executor that does not offer the role means no claim", async () => {
    const graph = makeScratchGraph({ prefix: "pinmiss", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness({ executorByRole: { planner: "absent" } });
    const fake = installFakeExecutor(mock.events, {
      roles: ["planner", "implementer"],
      roleScripts: { planner: { provenance: PLAN_PROV, plan: PLAN } },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(fake.requests).toHaveLength(0);
      expect(phaseOf(graph.showIssue(id))).toBe("ready");
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});
