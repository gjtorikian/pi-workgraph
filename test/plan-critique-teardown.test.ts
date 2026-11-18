/**
 * Closing Pi while a plan critique is in flight must not throw away a
 * finished plan: teardown cancels the critic and parks the recorded plan
 * for review, as it would have parked without a critique. The park survives
 * the session — a fresh coordinator implements the plan once approved.
 *
 * Each test leaves the critic deliberately unfinished, so the planner's
 * completion handler is still awaiting when teardown runs: tests poll an
 * in-memory condition with `until` rather than `flushEvents()`, and drain
 * the bus only AFTER teardown has closed the inbox.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { WorkgraphConfig } from "../src/config.ts";
import { registerCoordinator, type CoordinatorController } from "../src/coordinator.ts";
import { latestPlanCritique } from "../src/critique.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import { phaseOf } from "../src/lifecycle.ts";
import { latestPlan, renderPlan } from "../src/plan.ts";
import { CH, type RunCancelT } from "../src/protocol.ts";
import { listComments } from "../src/store.ts";
import { setResolvedTiers } from "../src/tiers.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import { WORKGRAPH_PLAN_CRITIQUE_KEY, type PlanCritiqueT, type PlanT } from "../src/types.ts";
import { installFakeExecutor, type RoleScript } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "plan-critique-teardown-worker";
const SESSION_ENDED = "session ended during the critique";

const CONFIG: WorkgraphConfig = {
  leaseTtlMs: 300_000,
  heartbeatMs: 600_000,
  pollMs: 600_000,
  sweepIntervalMs: 600_000,
  discoveryTimeoutMs: 40,
  acceptTimeoutMs: 150,
  compatInSessionExecutor: false,
  workerIdOverride: WORKER,
  planCritique: "high-risk",
};

const PLAN_PROV = { harness: "fake", model: "plan-model", provider: "prov-plan" };
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };
const CRITIC_PROV = { harness: "fake", model: "critic-model", provider: "prov-critic" };

const PLAN: PlanT = {
  summary: "add retry backoff to the client",
  steps: [{ description: "add a RetryPolicy type" }, { description: "handle retries in the request path" }],
};

const TWO_GAPS: PlanCritiqueT = {
  gaps: [{ step: 2, note: "which errors retry?" }, { note: "no rollback described" }],
};

const MAIN = "main";
const CRITIC = "critic";
const PLANNER_EXECUTION = `${MAIN}-exec-1`;
const CRITIC_EXECUTION = `${CRITIC}-exec-1`;

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
    "workgraph_risk_tier=high",
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

async function audits(dir: string, id: string, kind: string): Promise<Record<string, unknown>[]> {
  const marker = `workgraph-lease ${kind} `;
  const comments = await listComments(dir, id);
  return comments
    .filter((c) => c.text.startsWith(marker))
    .map((c) => JSON.parse(c.text.slice(marker.length)) as Record<string, unknown>);
}

async function auditKinds(dir: string, id: string): Promise<string[]> {
  const comments = await listComments(dir, id);
  return comments
    .filter((c) => c.text.startsWith("workgraph-lease "))
    .map((c) => c.text.split(" ")[1]!);
}

/** Every `run:cancel` published on the bus. */
function cancelsOn(mock: MockPi): RunCancelT[] {
  return mock.busEvents.filter((e) => e.channel === CH.runCancel).map((e) => e.data as RunCancelT);
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

function installMain(mock: MockPi) {
  return installFakeExecutor(mock.events, {
    executorId: MAIN,
    roles: ["planner", "implementer", "reviewer"],
    roleScripts: {
      planner: { provenance: PLAN_PROV, plan: PLAN },
      implementer: { provenance: IMPL_PROV, artifacts: ["src/retry.ts"] },
      reviewer: { provenance: REV_PROV, verdict: { findings: [] } },
    },
  });
}

function installCritic(mock: MockPi, script: RoleScript) {
  return installFakeExecutor(mock.events, {
    executorId: CRITIC,
    roles: ["plan_critic"],
    supportsCancellation: true,
    roleScripts: { plan_critic: { provenance: CRITIC_PROV, ...script } },
  });
}

/** The plan parked by teardown: reviewable, lease released, reason audited. */
async function expectParkedByTeardown(graph: ScratchGraph, id: string): Promise<void> {
  const shown = graph.showIssue(id);
  expect(phaseOf(shown)).toBe("plan_review");
  expect(shown.status).toBe("open");
  expect(shown.assignee ?? "").toBe("");
  expect(heldLeases(graph.dir)).toHaveLength(0);
  expect(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe(`unavailable: ${SESSION_ENDED}`);

  const unavailable = await audits(graph.dir, id, "plan-critique-unavailable");
  expect(unavailable).toHaveLength(1);
  expect(unavailable[0]!.reason).toBe(SESSION_ENDED);
  // The park is attributed to the plan's source, not to the critic the run
  // was bound to when the session ended.
  const parks = await audits(graph.dir, id, "plan-review");
  expect(parks).toHaveLength(1);
  expect(parks[0]).toMatchObject({ executorId: MAIN, executionId: PLANNER_EXECUTION, steps: 2 });

  const kinds = await auditKinds(graph.dir, id);
  expect(kinds).toContain("release");
  expect(kinds).not.toContain("plan-critique");
  expect(kinds).not.toContain("abandoned-unacked-cancel");
  expect(kinds).not.toContain("escalated");
  expect((await latestPlan(graph.dir, id))?.summary).toBe(PLAN.summary);
  expect(await latestPlanCritique(graph.dir, id)).toBeUndefined();
}

afterEach(() => {
  resetLeasesForTest();
  resetIdentityForTest();
  setResolvedTiers(undefined);
});

describe("teardown during a plan critique", () => {
  it("cancels a critic that had accepted and parks the recorded plan", async () => {
    const graph = makeScratchGraph({ prefix: "ctdstall", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    const critic = installCritic(mock, { behavior: "accept-stall", critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await until(() => coordinator.current()?.executionId === CRITIC_EXECUTION);
      expect(phaseOf(graph.showIssue(id))).toBe("planning");
      expect(heldLeases(graph.dir)).toHaveLength(1);

      await coordinator.teardown(ectx.ctx);
      await mock.flushEvents();

      const cancels = cancelsOn(mock);
      expect(cancels).toHaveLength(1);
      expect(cancels[0]).toMatchObject({
        workflowRunId: critic.requests[0]!.workflowRunId,
        executionId: CRITIC_EXECUTION,
      });
      expect(cancels[0]!.reason).toMatch(/plan critique/);
      expect(coordinator.current()).toBeNull();
      await expectParkedByTeardown(graph, id);

      // The canceled critic answering anyway changes nothing.
      const kinds = await auditKinds(graph.dir, id);
      critic.complete();
      await mock.flushEvents();
      expect(phaseOf(graph.showIssue(id))).toBe("plan_review");
      expect(await auditKinds(graph.dir, id)).toEqual(kinds);
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      await mock.flushEvents();
      graph.cleanup();
    }
  }, 60_000);

  it("parks the plan when the critic had been asked but had not accepted yet", async () => {
    const graph = makeScratchGraph({ prefix: "ctdaccept", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    const critic = installCritic(mock, { behavior: "silent" });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await until(() => critic.requests.length === 1);

      await coordinator.teardown(ectx.ctx);
      // Teardown parked at once, without waiting out the accept window.
      await expectParkedByTeardown(graph, id);
      expect(cancelsOn(mock)).toHaveLength(0);

      // The accept window then closes: the never-accepted request is
      // canceled so it cannot start later, and nothing else moves.
      const kinds = await auditKinds(graph.dir, id);
      await mock.flushEvents();
      const cancels = cancelsOn(mock);
      expect(cancels).toHaveLength(1);
      expect(cancels[0]!.workflowRunId).toBe(critic.requests[0]!.workflowRunId);
      expect(cancels[0]!.executionId).toBeUndefined();
      expect(await auditKinds(graph.dir, id)).toEqual(kinds);
      expect(phaseOf(graph.showIssue(id))).toBe("plan_review");
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      await mock.flushEvents();
      graph.cleanup();
    }
  }, 60_000);

  it("parks the plan when no critic had been asked yet, without canceling the planner's finished run", async () => {
    const graph = makeScratchGraph({ prefix: "ctddisc", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    // A long discovery window: teardown lands while the critique is still
    // looking for an executor, before any request exists.
    const { mock, coordinator } = makeHarness({ discoveryTimeoutMs: 300 });
    const main = installMain(mock);
    const critic = installCritic(mock, { critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await until(() => coordinator.current()?.pendingPlan?.planner !== undefined);
      expect(critic.requests).toHaveLength(0);

      await coordinator.teardown(ectx.ctx);
      await mock.flushEvents();

      expect(critic.requests).toHaveLength(0);
      expect(cancelsOn(mock)).toHaveLength(0);
      await expectParkedByTeardown(graph, id);
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      await mock.flushEvents();
      graph.cleanup();
    }
  }, 60_000);

  it("a critique that arrives in the same turn as the shutdown is dropped, and the plan parks exactly once", async () => {
    const graph = makeScratchGraph({ prefix: "ctdrace", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    const critic = installCritic(mock, { behavior: "accept-stall", critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await until(() => coordinator.current()?.executionId === CRITIC_EXECUTION);

      // No turn of the event loop between the two: the critique is queued
      // in the inbox when teardown closes it.
      critic.complete();
      await coordinator.teardown(ectx.ctx);
      await mock.flushEvents();

      await expectParkedByTeardown(graph, id);
      expect(await audits(graph.dir, id, "stale-result-rejected")).toHaveLength(0);
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      await mock.flushEvents();
      graph.cleanup();
    }
  }, 60_000);

  it("the park survives the session: a fresh coordinator implements the plan once it is approved", async () => {
    const graph = makeScratchGraph({ prefix: "ctdnext", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const first = makeHarness();
    const main = installMain(first.mock);
    const critic = installCritic(first.mock, { behavior: "accept-stall", critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    let second: Harness | undefined;
    let next: ReturnType<typeof installMain> | undefined;
    try {
      await settle(first.mock, ectx.ctx);
      await until(() => first.coordinator.current()?.executionId === CRITIC_EXECUTION);
      await first.coordinator.teardown(ectx.ctx);
      await first.mock.flushEvents();
      main.uninstall();
      critic.uninstall();
      await expectParkedByTeardown(graph, id);

      // Next session: a new process-local bus, a new coordinator, the same
      // workspace. Nothing in memory carries over.
      resetLeasesForTest();
      second = makeHarness();
      next = installMain(second.mock);
      const ectx2 = makeEventContext(graph.dir);

      // Unapproved, the parked plan is not dispatchable.
      await settle(second.mock, ectx2.ctx);
      await second.mock.flushEvents();
      expect(next.requests).toHaveLength(0);

      await runTool(second.mock, "workgraph_approve_plan", { id, decision: "approve" }, graph.dir);
      await settle(second.mock, ectx2.ctx);
      await second.mock.flushEvents();

      expect(next.requests.map((r) => r.role)).toEqual(["implementer", "reviewer"]);
      expect(next.requests[0]!.plan).toBe(renderPlan(PLAN));
      expect(graph.showIssue(id).status).toBe("closed");
      expect(phaseOf(graph.showIssue(id))).toBe("accepted");
      await second.coordinator.teardown(ectx2.ctx);
    } finally {
      main.uninstall();
      critic.uninstall();
      next?.uninstall();
      await first.coordinator.teardown(ectx.ctx);
      await second?.coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("teardown outside a critique is unchanged", () => {
  it("ordinary planning (no plan recorded yet) still resets to ready for a re-plan", async () => {
    const graph = makeScratchGraph({ prefix: "ctdplan", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    // A planner still working when the session ends; it acknowledges cancels.
    const main = installFakeExecutor(mock.events, {
      executorId: MAIN,
      roles: ["planner", "implementer"],
      supportsCancellation: true,
      roleScripts: { planner: { behavior: "accept-stall", provenance: PLAN_PROV, plan: PLAN } },
    });
    const critic = installCritic(mock, { critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(coordinator.current()?.phase).toBe("accepted");
      expect(coordinator.current()?.pendingPlan).toBeUndefined();
      expect(phaseOf(graph.showIssue(id))).toBe("planning");

      await coordinator.teardown(ectx.ctx);

      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("ready");
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBeUndefined();
      const kinds = await auditKinds(graph.dir, id);
      expect(kinds).not.toContain("plan-review");
      expect(kinds).not.toContain("plan-critique-unavailable");
      expect(critic.requests).toHaveLength(0);
      expect(cancelsOn(mock).map((c) => c.executionId)).toEqual([PLANNER_EXECUTION]);
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("a human halt during a plan critique", () => {
  it("drops the run without parking: the halt, not the critique, decides where the issue goes", async () => {
    const graph = makeScratchGraph({ prefix: "ctdhalt", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    const critic = installCritic(mock, { behavior: "accept-stall", critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await until(() => coordinator.current()?.executionId === CRITIC_EXECUTION);
      const current = coordinator.current()!;
      const epoch = current.lease.epoch + 1;
      graph.op([
        "update",
        id,
        "--status",
        "open",
        "--assignee",
        "",
        "--set-metadata",
        `lease_epoch=${epoch}`,
        "--unset-metadata",
        "lease_holder",
        "--unset-metadata",
        "lease_expires_at",
        "--set-metadata",
        "workgraph_halted=true",
        "--set-metadata",
        "workgraph_phase=draft",
      ]);
      const notice = { issueId: id, leaseEpoch: epoch, workflowRunIds: [] as string[] };
      mock.events.emit("workgraph:ui:issue-halted", notice);
      expect(notice.workflowRunIds).toContain(current.workflowRunId);
      expect(coordinator.current()).toBeNull();
      await mock.flushEvents(); // the critique wait ends with the inbox

      critic.complete();
      await mock.flushEvents();

      expect(phaseOf(graph.showIssue(id))).toBe("draft");
      expect(heldLeases(graph.dir)).toHaveLength(0);
      const kinds = await auditKinds(graph.dir, id);
      expect(kinds).not.toContain("plan-review");
      expect(kinds).not.toContain("plan-critique");
      expect(kinds).not.toContain("plan-critique-unavailable");
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      await mock.flushEvents();
      graph.cleanup();
    }
  }, 60_000);
});
