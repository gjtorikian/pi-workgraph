/**
 * The plan critique never costs the human a plan: every way a critic can
 * fail — nobody offers the role, it rejects, never accepts, never finishes,
 * fails, asks a question, or answers garbage — ends with the recorded plan
 * parked in `plan_review`, lease released, and an audited reason. Exactly
 * one request per plan, no escalation, no retry.
 *
 * Also here: the re-entrancy cases (a critic that completes inside the
 * request emit, a completion that lands after the park, a re-delivered
 * planner completion), the lost-lease cases (the one failure that must NOT
 * park), and the re-plan cases where an earlier plan's gaps must not
 * survive.
 *
 * `flushEvents()` drains the planner's completion handler, whose promise
 * spans the whole critique — so tests that leave a critic deliberately
 * stalled poll an in-memory condition with `until` instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkgraphConfig } from "../src/config.ts";
import { registerCoordinator, type CoordinatorController } from "../src/coordinator.ts";
import { latestPlanCritique } from "../src/critique.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, leaseEpochOf, resetLeasesForTest } from "../src/lease.ts";
import { phaseOf } from "../src/lifecycle.ts";
import { latestPlan } from "../src/plan.ts";
import { CH, type RunCancelT } from "../src/protocol.ts";
import { listComments } from "../src/store.ts";
import { setResolvedTiers } from "../src/tiers.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import { WORKGRAPH_PLAN_CRITIQUE_KEY, type PlanCritiqueT, type PlanT } from "../src/types.ts";
import { preProofConfig } from "./helpers/config.ts";
import { installFakeExecutor, type FakeExecutorHandle, type RoleScript } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "plan-critique-failures-worker";

const CONFIG = preProofConfig({ workerIdOverride: WORKER, planCritique: "high-risk" });

const PLAN_PROV = { harness: "fake", model: "plan-model", provider: "prov-plan" };
const CRITIC_PROV = { harness: "fake", model: "critic-model", provider: "prov-critic" };

const PLAN: PlanT = {
  summary: "add retry backoff to the client",
  steps: [{ description: "add a RetryPolicy type" }, { description: "handle retries in the request path" }],
};

const SECOND_PLAN: PlanT = {
  summary: "retry with jitter",
  steps: [{ description: "add jittered backoff" }, { description: "wire it in" }, { description: "test it" }],
};

const TWO_GAPS: PlanCritiqueT = {
  gaps: [
    { step: 2, note: "ROUND-ONE-GAP-A which errors retry?" },
    { note: "ROUND-ONE-GAP-B no rollback described" },
  ],
};

/** Executor ids are baked into execution ids: `critic-exec-1` is the critic's first run. */
const MAIN = "main";
const CRITIC = "critic";
const CRITIC_EXECUTION = `${CRITIC}-exec-1`;

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

/** The `reason` recorded on the issue's `plan-critique-unavailable` audit(s). */
async function unavailableReasons(dir: string, id: string): Promise<string[]> {
  const marker = "workgraph-lease plan-critique-unavailable ";
  const comments = await listComments(dir, id);
  return comments
    .filter((c) => c.text.startsWith(marker))
    .map((c) => String((JSON.parse(c.text.slice(marker.length)) as { reason?: unknown }).reason));
}

async function planComments(dir: string, id: string): Promise<string[]> {
  const comments = await listComments(dir, id);
  return comments.filter((c) => c.text.startsWith("workgraph-plan plan ")).map((c) => c.text);
}

/** Every `run:cancel` published on the bus (each fake's `cancels` is bus-wide too). */
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

/** The executor that plans (and implements, and reviews) but never critiques. */
function installMain(mock: MockPi, planner: RoleScript | RoleScript[] = { provenance: PLAN_PROV, plan: PLAN }) {
  return installFakeExecutor(mock.events, {
    executorId: MAIN,
    roles: ["planner", "implementer", "reviewer"],
    roleScripts: { planner },
  });
}

/** A second executor offering ONLY plan_critic, scripted to misbehave. */
function installCritic(mock: MockPi, script: RoleScript) {
  return installFakeExecutor(mock.events, {
    executorId: CRITIC,
    roles: ["plan_critic"],
    supportsCancellation: true,
    roleScripts: { plan_critic: { provenance: CRITIC_PROV, ...script } },
  });
}

/**
 * The facts every failure mode shares: the plan parked for the human as if
 * no critique had been asked for, with the reason on the trail and nothing
 * escalated.
 */
async function expectParkedWithoutCritique(
  graph: ScratchGraph,
  id: string,
  coordinator: CoordinatorController,
  reason: RegExp,
): Promise<void> {
  const shown = graph.showIssue(id);
  expect(phaseOf(shown)).toBe("plan_review");
  expect(shown.status).toBe("open");
  expect(heldLeases(graph.dir)).toHaveLength(0);
  expect(coordinator.current()).toBeNull();

  const reasons = await unavailableReasons(graph.dir, id);
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toMatch(reason);
  // The summary the human sees is the audited reason, behind the prefix
  // the display matches on.
  expect(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe(`unavailable: ${reasons[0]}`);

  const kinds = await auditKinds(graph.dir, id);
  expect(kinds).toContain("plan-review");
  expect(kinds).not.toContain("plan-critique");
  expect(kinds).not.toContain("escalated");
  expect(kinds).not.toContain("plan-invalid");
  expect(kinds).not.toContain("decision-needed");
  expect(shown.metadata?.workgraph_decision_pending).toBeUndefined();
  // The plan itself is untouched and readable.
  expect((await latestPlan(graph.dir, id))?.summary).toBe(PLAN.summary);
  expect(await latestPlanCritique(graph.dir, id)).toBeUndefined();
}

afterEach(() => {
  resetLeasesForTest();
  resetIdentityForTest();
  setResolvedTiers(undefined);
});

describe("nobody to ask", () => {
  it("no executor offers plan_critic: the plan parks and no request is sent", async () => {
    const graph = makeScratchGraph({ prefix: "cfnone", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(main.requests.map((r) => r.role)).toEqual(["planner"]);
      await expectParkedWithoutCritique(graph, id, coordinator, /no plan_critic executor/);
      expect(await statusText(mock, id, graph.dir)).toContain("Critique unavailable: no plan_critic executor.");
    } finally {
      main.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("the pinned plan_critic executor did not offer: no fallback to another critic, no request", async () => {
    const graph = makeScratchGraph({ prefix: "cfpin", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness({ executorByRole: { plan_critic: "nobody" } });
    const main = installMain(mock);
    const critic = installCritic(mock, { critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(critic.requests).toHaveLength(0);
      await expectParkedWithoutCritique(graph, id, coordinator, /no plan_critic executor/);
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a pin on an executor that does not critique is no critic, not a request it would reject", async () => {
    const graph = makeScratchGraph({ prefix: "cfpinrole", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    // The global pin applies to every role, plan_critic included.
    const { mock, coordinator } = makeHarness({ executorId: MAIN });
    const main = installMain(mock);
    const critic = installCritic(mock, { critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(main.requests.map((r) => r.role)).toEqual(["planner"]);
      expect(critic.requests).toHaveLength(0);
      await expectParkedWithoutCritique(graph, id, coordinator, /no plan_critic executor/);
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("a critic that fails", () => {
  const modes: {
    name: string;
    script: RoleScript;
    reason: RegExp;
    waitMs?: number;
    /** The reason on the single `run:cancel` this mode must publish (none when absent). */
    cancel?: { reason: RegExp; executionId?: string };
  }[] = [
    {
      name: "rejects the request",
      script: { behavior: "reject", rejectReason: "at-capacity" },
      reason: /plan_critic rejected the request: at-capacity/,
    },
    {
      name: "never accepts",
      script: { behavior: "silent" },
      reason: /plan_critic did not accept in time/,
      cancel: { reason: /not accepted in time/ },
    },
    {
      name: "accepts and never completes",
      script: { behavior: "accept-stall" },
      waitMs: 60,
      reason: /^no critique within /,
      cancel: { reason: /timed out/, executionId: CRITIC_EXECUTION },
    },
    {
      name: "reports failure",
      script: { outcome: "failure", executionError: "boom" },
      reason: /plan_critic execution failed \(failure\): boom/,
    },
    {
      name: "asks a decision question",
      script: { outcome: "blocked", decisionQuestion: "which API?", workerPending: true },
      reason: /plan_critic asked a question instead of reporting/,
      cancel: { reason: /cannot ask for a decision/, executionId: CRITIC_EXECUTION },
    },
    {
      name: "reports blocked with no question",
      script: { outcome: "blocked" },
      reason: /plan_critic asked a question instead of reporting/,
      cancel: { reason: /cannot ask for a decision/, executionId: CRITIC_EXECUTION },
    },
    {
      name: "succeeds with no critique payload",
      script: {},
      reason: /^invalid critique: /,
    },
    {
      name: "returns a critique that fails the schema",
      script: { critique: { gaps: "nope" } },
      reason: /^invalid critique: /,
    },
    {
      name: "returns a null critique",
      script: { critique: null },
      reason: /^invalid critique: /,
    },
    {
      name: "returns one malformed gap among good ones",
      script: { critique: { gaps: [{ step: 1, note: "fine" }, { step: 0, note: "bad step" }] } },
      reason: /^invalid critique: /,
    },
  ];

  for (const mode of modes) {
    it(`${mode.name}: the plan parks without a critique, after exactly one request`, async () => {
      const graph = makeScratchGraph({ prefix: "cfmode", seed: 1 });
      const id = graph.seededIds[0]!;
      approvePlanned(graph, id);
      const { mock, coordinator } = makeHarness({}, mode.waitMs);
      const main = installMain(mock);
      const critic = installCritic(mock, mode.script);
      const ectx = makeEventContext(graph.dir);
      try {
        await settle(mock, ectx.ctx);
        await mock.flushEvents();

        expect(main.requests.map((r) => r.role)).toEqual(["planner"]);
        expect(critic.requests.map((r) => r.role)).toEqual(["plan_critic"]);
        await expectParkedWithoutCritique(graph, id, coordinator, mode.reason);

        const cancels = cancelsOn(mock);
        if (mode.cancel) {
          expect(cancels).toHaveLength(1);
          expect(cancels[0]!.workflowRunId).toBe(critic.requests[0]!.workflowRunId);
          expect(cancels[0]!.reason).toMatch(mode.cancel.reason);
          expect(cancels[0]!.executionId).toBe(mode.cancel.executionId);
          expect(critic.cancels).toHaveLength(1);
        } else {
          expect(cancels).toHaveLength(0);
        }
        // Nothing waits on a human but the plan itself.
        expect(graph.showIssue(id).status).toBe("open");
        // A later tick does not try again.
        await settle(mock, ectx.ctx);
        await mock.flushEvents();
        expect(critic.requests).toHaveLength(1);
      } finally {
        main.uninstall();
        critic.uninstall();
        await coordinator.teardown(ectx.ctx);
        graph.cleanup();
      }
    }, 60_000);
  }
});

describe("a bug in the critique path", () => {
  it("an unexpected throw while asking parks the plan as unavailable and frees the coordinator", async () => {
    const graph = makeScratchGraph({ prefix: "cfthrow", seed: 2 });
    const [id, nextId] = graph.seededIds as [string, string];
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    const critic = installCritic(mock, { critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    // Not a failure mode a critic can produce: the bus itself throws on the
    // critic's request, so the throw surfaces inside the critique step.
    const emit = mock.events.emit.bind(mock.events);
    mock.events.emit = (channel, data) => {
      if (channel === CH.runRequest && (data as { role?: unknown }).role === "plan_critic") {
        throw new Error("bus is on fire");
      }
      emit(channel, data);
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(main.requests.map((r) => r.role)).toEqual(["planner"]);
      expect(critic.requests).toHaveLength(0);
      await expectParkedWithoutCritique(graph, id, coordinator, /^internal error: bus is on fire$/);
      expect(cancelsOn(mock)).toHaveLength(0);
      expect(errors.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringContaining(`plan critique failed for ${id}: bus is on fire`),
      );
      expect(await statusText(mock, id, graph.dir)).toContain("Critique unavailable: internal error: bus is on fire.");

      // The queue is not stalled: the next approved issue is claimed.
      mock.events.emit = emit;
      approvePlanned(graph, nextId);
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(main.requests.map((r) => r.issue.id)).toEqual([id, nextId]);
      expect(critic.requests.map((r) => r.issue.id)).toEqual([nextId]);
      expect(phaseOf(graph.showIssue(nextId))).toBe("plan_review");
    } finally {
      errors.mockRestore();
      mock.events.emit = emit;
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("completions that arrive at awkward times", () => {
  it("a critic that completes inside the request emit is still read as a critique, never as a plan", async () => {
    const graph = makeScratchGraph({ prefix: "cfsync", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    // The default behavior: accept and complete synchronously, before the
    // coordinator has even learned the execution id it must await.
    const critic = installCritic(mock, { critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("plan_review");
      expect(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("2 gaps");
      const kinds = await auditKinds(graph.dir, id);
      expect(kinds).toContain("plan-critique");
      expect(kinds).not.toContain("plan-invalid");
      expect(kinds).not.toContain("stale-result-rejected");
      expect(kinds).not.toContain("escalated");
      expect(cancelsOn(mock)).toHaveLength(0);

      // The run was bound to the critic for the wait; the trail still
      // attributes the plan to the planner and the critique to the critic.
      const trail = (await listComments(graph.dir, id)).map((c) => c.text);
      const park = trail.find((t) => t.startsWith("workgraph-lease plan-review "))!;
      expect(JSON.parse(park.slice("workgraph-lease plan-review ".length))).toMatchObject({
        executorId: MAIN,
        executionId: `${MAIN}-exec-1`,
      });
      const critiqued = trail.find((t) => t.startsWith("workgraph-lease plan-critique "))!;
      expect(JSON.parse(critiqued.slice("workgraph-lease plan-critique ".length))).toMatchObject({
        executorId: CRITIC,
        executionId: CRITIC_EXECUTION,
        gaps: 2,
      });
      const record = trail.find((t) => t.startsWith("workgraph-plan-critique critique "))!;
      expect(JSON.parse(record.slice("workgraph-plan-critique critique ".length))).toMatchObject({
        planExecutionId: `${MAIN}-exec-1`,
        executionId: CRITIC_EXECUTION,
        executorId: CRITIC,
      });
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a critique that lands after the plan parked without it changes nothing", async () => {
    const graph = makeScratchGraph({ prefix: "cflate", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness({}, 60);
    const main = installMain(mock);
    const critic = installCritic(mock, { behavior: "accept-stall", critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      await expectParkedWithoutCritique(graph, id, coordinator, /^no critique within /);
      const kindsBefore = await auditKinds(graph.dir, id);
      const commentsBefore = (await listComments(graph.dir, id)).length;
      const summaryBefore = graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY];

      // The stalled critic finally answers, with a perfectly valid critique.
      critic.complete();
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("plan_review");
      expect(shown.status).toBe("open");
      expect(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe(summaryBefore);
      expect(await auditKinds(graph.dir, id)).toEqual(kindsBefore);
      expect(await listComments(graph.dir, id)).toHaveLength(commentsBefore);
      expect(await latestPlanCritique(graph.dir, id)).toBeUndefined();
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a planner completion delivered again during the critique is not recorded as a second plan", async () => {
    const graph = makeScratchGraph({ prefix: "cfdup", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    const critic = installCritic(mock, { behavior: "accept-stall", critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await until(() => coordinator.current()?.executionId === CRITIC_EXECUTION);
      expect(coordinator.current()?.pendingPlan).toBeDefined();
      expect(phaseOf(graph.showIssue(id))).toBe("planning");

      // Byte-identical re-delivery (same messageId), then a fresh message
      // for the same finished execution (new messageId).
      main.reemit(main.completions[0]!);
      main.complete();
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(await planComments(graph.dir, id)).toHaveLength(1);
      expect(phaseOf(graph.showIssue(id))).toBe("planning");
      expect(coordinator.current()?.executionId).toBe(CRITIC_EXECUTION);

      // The critic then finishes; its critique is still the one consumed.
      critic.complete();
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("plan_review");
      expect(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("2 gaps");
      expect(await planComments(graph.dir, id)).toHaveLength(1);
      const kinds = await auditKinds(graph.dir, id);
      expect(kinds).not.toContain("plan-invalid");
      expect(kinds).not.toContain("escalated");
      expect(kinds.filter((k) => k === "plan-review")).toHaveLength(1);
      expect(kinds.filter((k) => k === "run-completed")).toHaveLength(1);
      expect(coordinator.current()).toBeNull();
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      await mock.flushEvents();
      graph.cleanup();
    }
  }, 60_000);
});

describe("a lease lost during the critique", () => {
  function reclaim(graph: ScratchGraph, id: string): void {
    const heldEpoch = leaseEpochOf(graph.showIssue(id));
    graph.op([
      "update",
      id,
      "--set-metadata",
      "lease_holder=workgraph-run/reclaimer",
      "--set-metadata",
      `lease_epoch=${heldEpoch + 1}`,
      "--actor",
      "reclaimer",
    ]);
  }

  it("a critique returned under a reclaimed lease is rejected and the plan is NOT parked", async () => {
    const graph = makeScratchGraph({ prefix: "cflost", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock);
    const critic = installCritic(mock, { behavior: "accept-stall", critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await until(() => coordinator.current()?.executionId === CRITIC_EXECUTION);
      reclaim(graph, id);

      critic.complete();
      await mock.flushEvents();

      // The issue is the reclaimer's now: no park, no critique, run dropped.
      expect(phaseOf(graph.showIssue(id))).toBe("planning");
      expect(coordinator.current()).toBeNull();
      expect(heldLeases(graph.dir)).toHaveLength(0);
      const kinds = await auditKinds(graph.dir, id);
      expect(kinds).toContain("stale-result-rejected");
      expect(kinds).not.toContain("plan-review");
      expect(kinds).not.toContain("plan-critique");
      expect(kinds).not.toContain("plan-critique-unavailable");
      expect(graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBeUndefined();
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a wait that expires after the lease was reclaimed does not park over the new holder", async () => {
    const graph = makeScratchGraph({ prefix: "cflostwait", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness({}, 250);
    const main = installMain(mock);
    const critic = installCritic(mock, { behavior: "accept-stall" });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await until(() => coordinator.current()?.executionId === CRITIC_EXECUTION);
      reclaim(graph, id);

      // No heartbeat ran: the coordinator still believes it holds the lease
      // when the wait expires, and must find out from the store.
      await mock.flushEvents();

      expect(phaseOf(graph.showIssue(id))).toBe("planning");
      expect(coordinator.current()).toBeNull();
      expect(heldLeases(graph.dir)).toHaveLength(0);
      const kinds = await auditKinds(graph.dir, id);
      expect(kinds).not.toContain("plan-review");
      expect(kinds).not.toContain("plan-critique-unavailable");
      // The critic was still told to stop.
      expect(cancelsOn(mock).map((c) => c.executionId)).toEqual([CRITIC_EXECUTION]);
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a lease loss the heartbeat noticed ends the critique without a park, and frees the coordinator", async () => {
    const graph = makeScratchGraph({ prefix: "cflostbeat", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness({}, 250);
    const main = installMain(mock);
    const critic = installCritic(mock, { behavior: "accept-stall", critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await until(() => coordinator.current()?.executionId === CRITIC_EXECUTION);
      reclaim(graph, id);
      await coordinator.beat(ectx.ctx);

      // The heartbeat dropped the run and canceled the CRITIC's execution.
      expect(coordinator.current()).toBeNull();
      expect(cancelsOn(mock).map((c) => c.executionId)).toEqual([CRITIC_EXECUTION]);

      await mock.flushEvents(); // the wait expires
      expect(phaseOf(graph.showIssue(id))).toBe("planning");
      const kinds = await auditKinds(graph.dir, id);
      expect(kinds).toContain("fencing-loss");
      expect(kinds).not.toContain("plan-review");
      expect(kinds).not.toContain("plan-critique-unavailable");
      expect(heldLeases(graph.dir)).toHaveLength(0);

      // A straggler from the dropped critique is ignored.
      critic.complete();
      await mock.flushEvents();
      expect(phaseOf(graph.showIssue(id))).toBe("planning");
      expect(await auditKinds(graph.dir, id)).toEqual(kinds);
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

describe("re-planning after a critiqued plan", () => {
  async function rejectPlan(mock: MockPi, id: string, dir: string): Promise<void> {
    await runTool(mock, "workgraph_approve_plan", { id, decision: "reject", feedback: "add jitter and tests" }, dir);
  }

  it("shows none of the first plan's gaps when the second plan's critique is unavailable", async () => {
    const graph = makeScratchGraph({ prefix: "cfreplan", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock, [
      { provenance: PLAN_PROV, plan: PLAN },
      { provenance: PLAN_PROV, plan: SECOND_PLAN },
    ]);
    const critic: FakeExecutorHandle = installCritic(mock, { critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("2 gaps");
      expect((await latestPlanCritique(graph.dir, id))?.gaps).toHaveLength(2);
      expect(await statusText(mock, id, graph.dir)).toContain("ROUND-ONE-GAP-A");

      await rejectPlan(mock, id, graph.dir);
      critic.uninstall(); // round two has nobody to ask
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(main.requests.map((r) => r.role)).toEqual(["planner", "planner"]);
      expect(critic.requests).toHaveLength(1);
      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("plan_review");
      expect(String(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY])).toBe("unavailable: no plan_critic executor");
      expect(await latestPlanCritique(graph.dir, id)).toBeUndefined();
      const status = await statusText(mock, id, graph.dir);
      expect(status).toContain("1. add jittered backoff");
      expect(status).toContain("Critique unavailable: no plan_critic executor.");
      expect(status).not.toContain("ROUND-ONE-GAP");
      expect(status).not.toContain("   ? ");
      expect(status).not.toContain("Plan as a whole:");
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("clears the summary when the setting is turned off between rounds", async () => {
    const graph = makeScratchGraph({ prefix: "cfreoff", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator, config } = makeHarness();
    const main = installMain(mock, [
      { provenance: PLAN_PROV, plan: PLAN },
      { provenance: PLAN_PROV, plan: SECOND_PLAN },
    ]);
    const critic = installCritic(mock, { critique: TWO_GAPS });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("2 gaps");

      await rejectPlan(mock, id, graph.dir);
      config.planCritique = "off";
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(critic.requests).toHaveLength(1);
      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("plan_review");
      expect(shown.metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("");
      expect(await latestPlanCritique(graph.dir, id)).toBeUndefined();
      const status = await statusText(mock, id, graph.dir);
      expect(status).toContain("1. add jittered backoff");
      expect(status).not.toContain("Critique");
      expect(status).not.toContain("ROUND-ONE-GAP");
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a second critiqued plan shows its own gaps, not the first plan's", async () => {
    const graph = makeScratchGraph({ prefix: "cfre2", seed: 1 });
    const id = graph.seededIds[0]!;
    approvePlanned(graph, id);
    const { mock, coordinator } = makeHarness();
    const main = installMain(mock, [
      { provenance: PLAN_PROV, plan: PLAN },
      { provenance: PLAN_PROV, plan: SECOND_PLAN },
    ]);
    const critic = installFakeExecutor(mock.events, {
      executorId: CRITIC,
      roles: ["plan_critic"],
      roleScripts: {
        plan_critic: [
          { provenance: CRITIC_PROV, critique: TWO_GAPS },
          { provenance: CRITIC_PROV, critique: { gaps: [{ step: 3, note: "ROUND-TWO-GAP what does the test assert?" }] } },
        ],
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      await rejectPlan(mock, id, graph.dir);
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(critic.requests).toHaveLength(2);
      expect(graph.showIssue(id).metadata?.[WORKGRAPH_PLAN_CRITIQUE_KEY]).toBe("1 gap");
      const status = await statusText(mock, id, graph.dir);
      expect(status).toContain("   ? ROUND-TWO-GAP what does the test assert?");
      expect(status).not.toContain("ROUND-ONE-GAP");
    } finally {
      main.uninstall();
      critic.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});
