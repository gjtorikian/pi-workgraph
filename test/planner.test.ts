/**
 * The planner tier: plan validation/rendering, the two claim edges out of
 * `ready`, and the coordinator's planner → implementer → judgment chain
 * driven through the per-role scriptable fake executor.
 *
 * The invariant this suite exists to pin is BACKWARD COMPATIBILITY: a
 * deployment whose executors do not offer the planner role must behave
 * exactly as it did before the role existed — same phase, same request,
 * same audit. Every other test here is about what happens once one does.
 *
 * Timer discipline follows the repo convention (no fake timers anywhere):
 * huge poll/heartbeat intervals so timers never fire mid-test, tiny REAL
 * discovery/accept timeouts, event-driven ticks via `agent_settled`, and
 * mock-pi's `flushEvents()` draining the completion handler's promise.
 *
 * Run via `npm run test:planner`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bindExec, listComments } from "../src/bd.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import {
  isActivePhase,
  LEGAL,
  LifecycleError,
  phaseOf,
  transition,
} from "../src/lifecycle.ts";
import {
  MAX_RENDER_CHARS,
  MAX_STEPS,
  MAX_SUMMARY_CHARS,
  parsePlan,
  PlanError,
  planSummary,
  renderPlan,
  TRUNCATION_MARKER,
} from "../src/plan.ts";
import {
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_PLAN_SUMMARY_KEY,
  WORKGRAPH_PLANNER_PROVENANCE_KEY,
  type PlanT,
} from "../src/types.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "planner-test-worker";

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

/** Distinct provenance per tier — independent under every policy. */
const PLAN_PROV = { harness: "fake", model: "plan-model", provider: "prov-plan" };
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };

const CLEAN_VERDICT = { findings: [] };

const PLAN: PlanT = {
  summary: "add retry backoff to the client",
  steps: [
    { description: "add an exponential backoff helper", targets: ["src/retry.ts"] },
    { description: "call it from the request path", rationale: "one call site" },
  ],
  risks: ["the jitter strategy is unspecified"],
};

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
  config: WorkgraphConfig;
}

function makeHarness(overrides: Partial<WorkgraphConfig> = {}): Harness {
  const mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  const config: WorkgraphConfig = { ...CONFIG, ...overrides };
  setWorkerIdOverride(WORKER);
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
  });
  return { mock, coordinator, config };
}

function settle(mock: MockPi, ctx: unknown): Promise<unknown[]> {
  return mock.emit(
    "agent_settled",
    { type: "agent_settled" },
    ctx as Parameters<MockPi["emit"]>[2],
  );
}

function metadataOf(graph: ScratchGraph, id: string): Record<string, unknown> {
  return (graph.showIssue(id).metadata ?? {}) as Record<string, unknown>;
}

/** Approve an issue the way workgraph_approve does. */
function approve(
  graph: ScratchGraph,
  id: string,
  opts: { riskTier?: string; acceptance?: string } = {},
): void {
  const args = [
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=ready",
    "--set-metadata",
    `workgraph_risk_tier=${opts.riskTier ?? "medium"}`,
  ];
  if (opts.acceptance) args.push("--acceptance", opts.acceptance);
  args.push("--actor", "approver");
  graph.bd(args);
}

async function auditCount(
  dir: string,
  id: string,
  kind: string,
): Promise<number> {
  const comments = await listComments(dir, id);
  return comments.filter((c) => c.text.startsWith(`workgraph-lease ${kind} `))
    .length;
}

async function planCount(dir: string, id: string): Promise<number> {
  const comments = await listComments(dir, id);
  return comments.filter((c) => c.text.startsWith("workgraph-plan plan ")).length;
}

afterEach(() => {
  resetLeasesForTest();
  resetIdentityForTest();
});

// ---------------------------------------------------------------------------
// plan.ts — validation, summary, rendering
// ---------------------------------------------------------------------------

describe("plan validation and rendering", () => {
  it("parsePlan rejects malformed payloads, including a plan with no steps", () => {
    expect(() => parsePlan(undefined)).toThrow(PlanError);
    expect(() => parsePlan({})).toThrow(PlanError);
    expect(() => parsePlan({ steps: "nope" })).toThrow(PlanError);
    expect(() => parsePlan({ steps: [{ rationale: "no description" }] })).toThrow(
      PlanError,
    );
    // A schema-valid but EMPTY plan is still invalid: an executor that
    // answered the planner role owes a plan, and an empty one is
    // indistinguishable from a planner that did nothing.
    expect(() => parsePlan({ steps: [] })).toThrow(PlanError);

    const parsed = parsePlan({ steps: [{ description: "do the thing" }] });
    expect(parsed.steps).toHaveLength(1);
  });

  it("planSummary is capped and leads with the step count", () => {
    expect(planSummary(PLAN)).toBe("2 steps: add retry backoff to the client");
    expect(planSummary({ steps: [{ description: "only one" }] })).toBe(
      "1 step: only one",
    );
    const huge: PlanT = {
      summary: "x".repeat(500),
      steps: [{ description: "d" }],
    };
    const summary = planSummary(huge);
    expect(summary.length).toBeLessThanOrEqual(
      MAX_SUMMARY_CHARS + TRUNCATION_MARKER.length,
    );
    expect(summary.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("renderPlan numbers steps in order, labels risks advisory, and caps length", () => {
    const rendered = renderPlan(PLAN);
    expect(rendered).toContain("1. add an exponential backoff helper");
    expect(rendered).toContain("targets: src/retry.ts");
    expect(rendered).toContain("2. call it from the request path");
    expect(rendered).toContain("why: one call site");
    // Order is meaning: step 1 must precede step 2 in the rendering.
    expect(rendered.indexOf("1. add an")).toBeLessThan(
      rendered.indexOf("2. call it"),
    );
    // Risks render last and are marked advisory so an implementer does not
    // read them as work items.
    expect(rendered).toContain("advisory — not work items");
    expect(rendered.indexOf("advisory — not work items")).toBeGreaterThan(
      rendered.indexOf("2. call it"),
    );

    // A planner's refined criteria are rendered as advisory context, never
    // as a replacement for the approved bar.
    expect(renderPlan({ ...PLAN, acceptanceCriteria: "must retry twice" })).toContain(
      "the approved criteria on the issue remain authoritative",
    );

    // Over-long plans truncate rather than blow the executor's context.
    const massive: PlanT = {
      steps: Array.from({ length: MAX_STEPS + 10 }, (_, i) => ({
        description: `step ${i} ` + "y".repeat(300),
      })),
    };
    const big = renderPlan(massive);
    expect(big.length).toBeLessThanOrEqual(
      MAX_RENDER_CHARS + TRUNCATION_MARKER.length,
    );
  });
});

// ---------------------------------------------------------------------------
// lifecycle — the two claim edges and the active-phase contract
// ---------------------------------------------------------------------------

describe("planning phase edges", () => {
  it("ready has BOTH claim edges; planning reaches implementing and escalated", () => {
    expect(LEGAL.ready).toContain("planning");
    // The pre-planner edge survives: a graph with no planner still claims
    // straight into implementing.
    expect(LEGAL.ready).toContain("implementing");
    expect(LEGAL.planning).toContain("implementing");
    expect(LEGAL.planning).toContain("escalated");
    // Planning is never a shortcut past the gate.
    expect(LEGAL.planning).not.toContain("judging");
    expect(LEGAL.planning).not.toContain("accepted");
  });

  it("planning is an ACTIVE phase, so a crashed planner reclaims like any run", () => {
    expect(isActivePhase("planning")).toBe(true);
  });

  it("walks ready → planning → implementing, and rejects planning → judging", async () => {
    const mock = makeMockPi();
    bindExec((command, args, options) => mock.exec(command, args, options));
    const graph = makeScratchGraph({ prefix: "planwalk" });
    try {
      const id = graph.createIssue("planner walk");
      await transition(graph.dir, id, undefined, "ready");
      await transition(graph.dir, id, "ready", "planning");
      expect(phaseOf(graph.showIssue(id))).toBe("planning");
      await expect(
        transition(graph.dir, id, "planning", "judging"),
      ).rejects.toThrow(LifecycleError);
      await transition(graph.dir, id, "planning", "implementing");
      expect(phaseOf(graph.showIssue(id))).toBe("implementing");
    } finally {
      graph.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// coordinator — the planner → implementer → judgment chain
// ---------------------------------------------------------------------------

describe("coordinator planner tier", () => {
  it("plans, then implements with the plan attached, then judges and closes", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "plok", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id, { acceptance: "retries back off" });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["planner", "implementer", "reviewer"],
      roleScripts: {
        planner: { provenance: PLAN_PROV, plan: PLAN },
        implementer: { provenance: IMPL_PROV, artifacts: ["src/retry.ts"] },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      // All three tiers ran, in order, under ONE workflow run.
      const roles = fake.requests.map((r) => r.role);
      expect(roles).toEqual(["planner", "implementer", "reviewer"]);
      const runIds = new Set(fake.requests.map((r) => r.workflowRunId));
      expect(runIds.size).toBe(1);

      // The implementer received the rendered plan; the planner did not.
      const planReq = fake.requests.find((r) => r.role === "planner")!;
      const implReq = fake.requests.find((r) => r.role === "implementer")!;
      expect(planReq.plan).toBeUndefined();
      expect(implReq.plan).toContain("add an exponential backoff helper");
      expect(implReq.plan).toContain("2. call it from the request path");
      // The approved criteria still reach both tiers unchanged.
      expect(planReq.issue.acceptanceCriteria).toBe("retries back off");
      expect(implReq.issue.acceptanceCriteria).toBe("retries back off");

      // The plan is durable: one plan comment plus the compact summary and
      // planner provenance in metadata.
      expect(await planCount(graph.dir, id)).toBe(1);
      const metadata = metadataOf(graph, id);
      expect(String(metadata[WORKGRAPH_PLAN_SUMMARY_KEY])).toBe(
        "2 steps: add retry backoff to the client",
      );
      expect(String(metadata[WORKGRAPH_PLANNER_PROVENANCE_KEY])).toContain(
        "plan-model",
      );

      // And the run still ends where it did before the tier existed.
      expect(graph.showIssue(id).status).toBe("closed");
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("accepted");
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(coordinator.current()).toBeNull();
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("one executor at maxConcurrency 1 still implements what it just planned", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "plcap", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness();
    // The most natural single-adapter setup: one executor, every role, one
    // slot. The planner's slot must be released when its run completes —
    // otherwise it is judged at capacity for its own implementation.
    const fake = installFakeExecutor(mock.events, {
      roles: ["planner", "implementer", "reviewer"],
      maxConcurrency: 1,
      roleScripts: {
        planner: { provenance: PLAN_PROV, plan: PLAN },
        implementer: { provenance: IMPL_PROV, artifacts: ["src/retry.ts"] },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(fake.requests.map((r) => r.role)).toEqual([
        "planner",
        "implementer",
        "reviewer",
      ]);
      // Not handed back: the issue ran the whole chain to a close.
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("accepted");
      expect(graph.showIssue(id).status).toBe("closed");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("BACKWARD COMPAT: no planner offered → claims straight into implementing", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "plnone", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id, { acceptance: "unchanged" });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(fake.requests.map((r) => r.role)).toEqual([
        "implementer",
        "reviewer",
      ]);
      // No plan anywhere: not on the request, not in metadata, not a comment.
      expect(fake.requests[0]!.plan).toBeUndefined();
      expect(metadataOf(graph, id)[WORKGRAPH_PLAN_SUMMARY_KEY]).toBeUndefined();
      expect(await planCount(graph.dir, id)).toBe(0);
      expect(graph.showIssue(id).status).toBe("closed");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("never plans what cannot be built: a planner-only offer set makes no claim", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "plonly", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["planner"],
      roleScripts: { planner: { provenance: PLAN_PROV, plan: PLAN } },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      // No claim at all — planning without an implementer would loop.
      expect(fake.requests).toHaveLength(0);
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(coordinator.current()).toBeNull();
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("an invalid plan escalates — it never degrades to an unplanned implementation", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "plbad", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["planner", "implementer", "reviewer"],
      roleScripts: {
        planner: { provenance: PLAN_PROV, plan: { steps: [] } },
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      // The implementer was NEVER dispatched — that is the whole point.
      expect(fake.requests.map((r) => r.role)).toEqual(["planner"]);
      expect(graph.showIssue(id).status).toBe("blocked");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      expect(await auditCount(graph.dir, id, "plan-invalid")).toBe(1);
      expect(await auditCount(graph.dir, id, "escalated")).toBe(1);
      expect(await planCount(graph.dir, id)).toBe(0);
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a planner reporting failure escalates without dispatching the implementer", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "plfail", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["planner", "implementer"],
      roleScripts: {
        planner: { provenance: PLAN_PROV, outcome: "blocked", plan: PLAN },
        implementer: { provenance: IMPL_PROV },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(fake.requests.map((r) => r.role)).toEqual(["planner"]);
      expect(graph.showIssue(id).status).toBe("blocked");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      expect(await auditCount(graph.dir, id, "escalated")).toBe(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("legacy issues never plan: compat claims still enter at implementing", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "plleg", seed: 1 });
    const id = graph.seededIds[0]!;
    // No approve(): a legacy issue, dispatched only under the compat opt-in.
    const { mock, coordinator } = makeHarness({ compatLegacyIssues: true });
    const fake = installFakeExecutor(mock.events, {
      roles: ["planner", "implementer"],
      roleScripts: {
        planner: { provenance: PLAN_PROV, plan: PLAN },
        implementer: { provenance: IMPL_PROV },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      // The legacy migration entry is `implementing` and nothing else, so
      // the planner tier must not be offered the issue.
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      expect(await planCount(graph.dir, id)).toBe(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});
