/**
 * Contract tests for the OPTIONAL pi-subagents bridge (spec-phase-5):
 * registration gating (config + version gate, zero subscriptions when
 * unconfigured), role mapping, reported provenance, the self-acceptance
 * exclusion (invariant 6), cancel semantics, and two-executor selection
 * determinism. Both sides are faked — the workgraph protocol drives the
 * bridge directly, `test/helpers/fake-subagents.ts` speaks the harvested
 * upstream event names — so every mapping is exercised WITHOUT pi-subagents
 * installed (the package must never appear in a dependency block).
 *
 * Run via `npm run test:adapter`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  registerInSessionExecutor,
  IN_SESSION_EXECUTOR_ID,
} from "../src/adapters/in-session.ts";
import {
  buildSubagentTask,
  defaultProbeVersion,
  PI_SUBAGENTS_EXECUTOR_ID,
  PI_SUBAGENTS_MAX_CONCURRENCY,
  registerPiSubagentsExecutor,
  splitProvider,
  UPSTREAM_EVENTS,
  type PiSubagentsController,
} from "../src/adapters/pi-subagents.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import { discoverExecutors, selectExecutor } from "../src/executor-registry.ts";
import {
  Activity,
  CH,
  newEnvelope,
  parseMessage,
  subagentsVersionInRange,
  type ExecutorOfferT,
  type RunCompletedT,
  type RunRequestT,
} from "../src/protocol.ts";
import { installFakeSubagents } from "./helpers/fake-subagents.ts";
import {
  asExtensionAPI,
  makeMockPi,
  type MockPi,
} from "./helpers/mock-pi.ts";

const CONFIG: WorkgraphConfig = {
  leaseTtlMs: 300_000,
  heartbeatMs: 600_000,
  pollMs: 600_000,
  sweepIntervalMs: 600_000,
  discoveryTimeoutMs: 40,
  acceptTimeoutMs: 150,
  compatInSessionExecutor: false,
  subagentsExecutor: { enabled: true },
};

interface BridgeHarness {
  mock: MockPi;
  bridge: PiSubagentsController;
  warnings: string[];
  config: WorkgraphConfig;
}

function makeBridgeHarness(
  overrides: Partial<WorkgraphConfig> = {},
  probe: () => string | undefined = () => "0.34.8",
): BridgeHarness {
  const mock = makeMockPi();
  const warnings: string[] = [];
  const config: WorkgraphConfig = { ...CONFIG, ...overrides };
  const bridge = registerPiSubagentsExecutor(asExtensionAPI(mock), {
    getConfig: () => config,
    probeVersion: probe,
    warn: (message) => warnings.push(message),
  });
  return { mock, bridge, warnings, config };
}

function makeRunRequest(overrides: Partial<RunRequestT> = {}): RunRequestT {
  return {
    ...newEnvelope(),
    executorId: PI_SUBAGENTS_EXECUTOR_ID,
    issue: {
      id: "wg-7",
      title: "wire the flux capacitor",
      acceptanceCriteria: "the capacitor fluxes",
      workflowClass: "reviewed",
      riskTier: "medium",
    },
    workflowRunId: "workgraph-run/sub-run-1",
    leaseEpoch: 3,
    role: "implementer",
    attempt: 1,
    workspace: { baseRevision: "", requiresIsolation: true },
    ...overrides,
  };
}

function busOn(mock: MockPi, channel: string): unknown[] {
  return mock.busEvents.filter((e) => e.channel === channel).map((e) => e.data);
}

// ---------------------------------------------------------------------------
// registration gating: config gate + version gate
// ---------------------------------------------------------------------------

describe("bridge registration gating", () => {
  it("configured + version-ok: discovery yields the pi-subagents offer", () => {
    const { mock, bridge } = makeBridgeHarness();
    expect(bridge.active()).toBe(true);
    const discover = newEnvelope();
    mock.events.emit(CH.discover, discover);
    const offers = busOn(mock, CH.offer) as ExecutorOfferT[];
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      inReplyTo: discover.messageId,
      executorId: PI_SUBAGENTS_EXECUTOR_ID,
      roles: ["planner", "implementer", "reviewer", "revision"],
      harness: "pi-subagents",
      isolation: "worktree",
      supportsCancellation: true,
      profileSemantics: "named",
      maxConcurrency: PI_SUBAGENTS_MAX_CONCURRENCY,
      available: true,
    });
    bridge.teardown();
  });

  it("unconfigured: no offer AND zero bus subscriptions (the inner gate)", () => {
    const mock = makeMockPi();
    const warnings: string[] = [];
    const config: WorkgraphConfig = { ...CONFIG };
    delete (config as Partial<WorkgraphConfig>).subagentsExecutor;
    const bridge = registerPiSubagentsExecutor(asExtensionAPI(mock), {
      getConfig: () => config,
      probeVersion: () => "0.34.8",
      warn: (message) => warnings.push(message),
    });
    expect(bridge.active()).toBe(false);
    // ZERO subscription side effects — stricter than the in-session
    // gate-per-event pattern: nothing was registered at all.
    expect(mock.busHandlerCount()).toBe(0);
    mock.events.emit(CH.discover, newEnvelope());
    expect(busOn(mock, CH.offer)).toHaveLength(0);
    expect(warnings).toHaveLength(0); // unconfigured is the default, not an error
  });

  it("enabled-but-disabled config object registers nothing either", () => {
    const { mock, bridge } = makeBridgeHarness({
      subagentsExecutor: { enabled: false },
    });
    expect(bridge.active()).toBe(false);
    expect(mock.busHandlerCount()).toBe(0);
  });

  it("explicit versionRange mismatch: one warning, no offer, zero subscriptions", () => {
    const { mock, bridge, warnings } = makeBridgeHarness(
      { subagentsExecutor: { enabled: true, versionRange: "0.34" } },
      () => "0.99.0",
    );
    expect(bridge.active()).toBe(false);
    expect(mock.busHandlerCount()).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/0\.99\.0/);
    expect(warnings[0]).toMatch(/0\.34\.x/);
    mock.events.emit(CH.discover, newEnvelope());
    expect(busOn(mock, CH.offer)).toHaveLength(0);
  });

  it("no configured versionRange bridges any installed version", () => {
    const { bridge, warnings } = makeBridgeHarness({}, () => "9.9.9");
    expect(bridge.active()).toBe(true);
    expect(warnings).toHaveLength(0);
    bridge.teardown();
  });

  it("no probe result (package not installed) is treated as a mismatch", () => {
    const { mock, bridge, warnings } = makeBridgeHarness({}, () => undefined);
    expect(bridge.active()).toBe(false);
    expect(mock.busHandlerCount()).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no installed pi-subagents/);
  });

  it("a configured versionRange overrides the harvest default", () => {
    const { bridge, warnings } = makeBridgeHarness(
      { subagentsExecutor: { enabled: true, versionRange: "0.99" } },
      () => "0.99.3",
    );
    expect(bridge.active()).toBe(true);
    expect(warnings).toHaveLength(0);
    bridge.teardown();
    // The range matcher is a strict major.minor prefix.
    expect(subagentsVersionInRange("0.34.8")).toBe(true);
    expect(subagentsVersionInRange("0.340.0")).toBe(false);
    expect(subagentsVersionInRange("1.34.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planner round-trip: named route + structured plan transport
// ---------------------------------------------------------------------------

describe("planner round-trip", () => {
  it("uses the planned-work profile override and returns structured output as the plan", () => {
    const { mock, bridge } = makeBridgeHarness({
      subagentsExecutor: {
        enabled: true,
        routes: { planned: { planner: "architecture-planner" } },
      },
    });
    const plan = {
      summary: "wire it safely",
      steps: [{ description: "inspect the flux circuit" }],
    };
    const fake = installFakeSubagents(mock.events, {
      script: { model: "planner-model", structuredOutput: plan },
    });
    try {
      const schema = { type: "object", properties: { steps: {} } };
      const request = makeRunRequest({
        role: "planner",
        workflowRunId: "workgraph-run/sub-run-plan",
        issue: {
          id: "wg-7",
          title: "wire the flux capacitor",
          acceptanceCriteria: "the capacitor fluxes",
          workflowClass: "planned",
          riskTier: "high",
        },
        outputSchema: schema,
      });
      mock.events.emit(CH.runRequest, request);

      expect(fake.requests).toHaveLength(1);
      const params = fake.requests[0]!.params;
      expect(params.agent).toBe("architecture-planner");
      expect(params.worktree).toBe(false);
      expect(params.context).toBe("fresh");
      expect(params.outputSchema).toEqual(schema);
      expect(String(params.task)).toContain("Do not modify product code");

      const completions = busOn(mock, CH.runCompleted) as Array<
        RunCompletedT & { plan?: unknown }
      >;
      expect(completions).toHaveLength(1);
      expect(completions[0]!.plan).toEqual(plan);
      expect(completions[0]!.provenance.model).toBe("planner-model");
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// implementer round-trip: role mapping + reported provenance
// ---------------------------------------------------------------------------

describe("implementer round-trip", () => {
  it("routes one-shot implementation to its configured economy profile", () => {
    const { mock, bridge } = makeBridgeHarness({
      subagentsExecutor: {
        enabled: true,
        routes: { oneshot: { implementer: "economy-worker" } },
      },
    });
    const fake = installFakeSubagents(mock.events);
    try {
      mock.events.emit(
        CH.runRequest,
        makeRunRequest({
          issue: {
            id: "wg-7",
            title: "rename a local helper",
            workflowClass: "oneshot",
            riskTier: "low",
          },
        }),
      );
      expect(fake.requests[0]!.params.agent).toBe("economy-worker");
      expect(fake.requests[0]!.params.worktree).toBe(true);
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("request → upstream worker launch → accepted → completed with REPORTED provenance", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: {
        model: "anthropic/claude-test-1",
        finalOutput: "implemented the thing",
        artifactPaths: { dir: "/tmp/artifacts/run-1" },
      },
    });
    try {
      const request = makeRunRequest();
      mock.events.emit(CH.runRequest, request);

      // Role mapping: implementer → a fresh worktree-isolated worker.
      expect(fake.requests).toHaveLength(1);
      const params = fake.requests[0]!.params;
      expect(params.agent).toBe("worker");
      expect(params.worktree).toBe(true);
      expect(params.context).toBe("fresh");
      expect(String(params.task)).toContain("wire the flux capacitor");
      expect(String(params.task)).toContain("the capacitor fluxes");
      expect(String(params.task)).toContain("Do not close or release");

      const accepted = busOn(mock, CH.runAccepted);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({
        inReplyTo: request.messageId,
        workflowRunId: request.workflowRunId,
        issueId: "wg-7",
        leaseEpoch: 3,
        executorId: PI_SUBAGENTS_EXECUTOR_ID,
      });

      const completions = busOn(mock, CH.runCompleted) as RunCompletedT[];
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({
        workflowRunId: request.workflowRunId,
        issueId: "wg-7",
        leaseEpoch: 3,
        outcome: "success",
        // REPORTED provenance: verbatim results[0].model, provider split
        // from the unambiguous provider/id shape — never the request's.
        provenance: {
          harness: "pi-subagents",
          model: "anthropic/claude-test-1",
          provider: "anthropic",
        },
        artifacts: ["/tmp/artifacts/run-1"],
      });
      expect(completions[0]!.executionId).toBe(
        (accepted[0] as { executionId: string }).executionId,
      );
      expect(bridge.activeRunCount()).toBe(0);
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("an ambiguous model string reports model verbatim with provider unset", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: { model: "claude-test-1" },
    });
    try {
      mock.events.emit(CH.runRequest, makeRunRequest());
      const completions = busOn(mock, CH.runCompleted) as RunCompletedT[];
      expect(completions).toHaveLength(1);
      expect(completions[0]!.provenance.model).toBe("claude-test-1");
      expect(completions[0]!.provenance.provider).toBeUndefined();
      // The splitter itself: unambiguous only.
      expect(splitProvider("anthropic/claude-4")).toBe("anthropic");
      expect(splitProvider("meta/llama/70b")).toBeUndefined();
      expect(splitProvider("/weird")).toBeUndefined();
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("an upstream error response for a started run completes with outcome failure", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: { isError: true, errorText: "worker exploded", model: "m-1" },
    });
    try {
      mock.events.emit(CH.runRequest, makeRunRequest());
      const completions = busOn(mock, CH.runCompleted) as RunCompletedT[];
      expect(completions).toHaveLength(1);
      expect(completions[0]!.outcome).toBe("failure");
      expect(completions[0]!.evidence.join("\n")).toContain("worker exploded");
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("a no-context upstream error BEFORE start is a rejection, never a completion", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: { mode: "no-context" },
    });
    try {
      const request = makeRunRequest();
      mock.events.emit(CH.runRequest, request);
      expect(busOn(mock, CH.runAccepted)).toHaveLength(0);
      expect(busOn(mock, CH.runCompleted)).toHaveLength(0);
      const rejected = busOn(mock, CH.runRejected);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        inReplyTo: request.messageId,
        executorId: PI_SUBAGENTS_EXECUTOR_ID,
      });
      expect(String((rejected[0] as { reason: string }).reason)).toContain(
        "No active extension context",
      );
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// reviewer round-trip: separate launch + verdict transport + invariant 6
// ---------------------------------------------------------------------------

describe("reviewer round-trip and self-acceptance exclusion", () => {
  const VERDICT = { findings: [] };

  it("a reviewer run is a SEPARATE fresh launch carrying the output schema; structured output rides as the verdict", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: { model: "rev-model", structuredOutput: VERDICT },
    });
    try {
      const schema = { type: "object", properties: { findings: {} } };
      const request = makeRunRequest({
        role: "reviewer",
        workflowRunId: "workgraph-run/sub-run-rev",
        outputSchema: schema,
      });
      (request as RunRequestT & { artifacts: string[] }).artifacts = [
        "src/thing.ts",
      ];
      mock.events.emit(CH.runRequest, request);

      expect(fake.requests).toHaveLength(1);
      const params = fake.requests[0]!.params;
      expect(params.agent).toBe("reviewer");
      expect(params.worktree).toBe(false);
      expect(params.context).toBe("fresh");
      expect(params.outputSchema).toEqual(schema);
      expect(String(params.task)).toContain("INDEPENDENT reviewer");
      expect(String(params.task)).toContain("src/thing.ts");

      const completions = busOn(mock, CH.runCompleted) as Array<
        RunCompletedT & { verdict?: unknown }
      >;
      expect(completions).toHaveLength(1);
      expect(completions[0]!.verdict).toEqual(VERDICT);
      expect(completions[0]!.provenance.model).toBe("rev-model");
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("a self-acceptance ledger on the IMPLEMENTER response emits nothing for the reviewer run and never becomes a verdict", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: [{ mode: "stall" }, { mode: "stall" }],
    });
    try {
      const implRequest = makeRunRequest({
        workflowRunId: "workgraph-run/impl-1",
      });
      const revRequest = makeRunRequest({
        role: "reviewer",
        workflowRunId: "workgraph-run/rev-1",
      });
      mock.events.emit(CH.runRequest, implRequest);
      mock.events.emit(CH.runRequest, revRequest);
      expect(busOn(mock, CH.runAccepted)).toHaveLength(2);
      const implRequestId = fake.requests[0]!.requestId;

      // The implementer's own run finalizes with a parent-controlled
      // self-acceptance ledger (upstream: "acceptance … is not independent
      // review") — DURING the reviewer request.
      fake.respond({
        requestId: implRequestId,
        acceptance: { status: "accepted", explicit: true },
        model: "impl-model",
      });

      const completions = busOn(mock, CH.runCompleted) as Array<
        RunCompletedT & { verdict?: unknown }
      >;
      // Exactly ONE completion — the implementer's; the reviewer run got
      // nothing (invariant 6: self-acceptance is never judgment).
      expect(completions).toHaveLength(1);
      expect(completions[0]!.workflowRunId).toBe("workgraph-run/impl-1");
      expect(completions[0]!.verdict).toBeUndefined();
      expect(completions[0]!.evidence.join("\n")).toContain(
        "self-acceptance ledger",
      );
      expect(completions[0]!.evidence.join("\n")).toContain(
        "not independent judgment",
      );
      expect(bridge.activeRunCount()).toBe(1); // the reviewer still runs
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("a reviewer response WITHOUT structured output completes without a verdict — the bridge never synthesizes one", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      // An acceptance ledger arrives but NO structuredOutput: the ledger
      // must not be promoted into the verdict slot.
      script: { acceptance: { status: "accepted" }, model: "rev-model" },
    });
    try {
      mock.events.emit(
        CH.runRequest,
        makeRunRequest({ role: "reviewer" }),
      );
      const completions = busOn(mock, CH.runCompleted) as Array<
        RunCompletedT & { verdict?: unknown }
      >;
      expect(completions).toHaveLength(1);
      expect(completions[0]!.verdict).toBeUndefined();
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// cancel semantics
// ---------------------------------------------------------------------------

describe("cancel semantics", () => {
  it("cancel of a live run forwards upstream; the aborted response maps to run:cancelled, not a failed completion", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: { mode: "stall" },
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
        reason: "coordinator shutdown",
      });
      // Forwarded by requestId to upstream, which aborts and RESPONDS —
      // upstream has no distinct cancelled event.
      expect(fake.cancels).toEqual([fake.requests[0]!.requestId]);

      const cancelled = busOn(mock, CH.runCancelled);
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]).toMatchObject({
        workflowRunId: request.workflowRunId,
        issueId: "wg-7",
        executionId: accepted.executionId,
      });
      expect(busOn(mock, CH.runCompleted)).toHaveLength(0);
      expect(bridge.activeRunCount()).toBe(0);
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("cancel for an UNKNOWN run is a no-op ack from the bridge itself — upstream never acks unknown ids", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events);
    try {
      mock.events.emit(CH.runCancel, {
        ...newEnvelope(),
        workflowRunId: "workgraph-run/never-seen",
        issueId: "wg-404",
        executionId: "exec-404",
      });
      // NOT forwarded upstream (upstream would park it forever, unacked).
      expect(fake.cancels).toHaveLength(0);
      const cancelled = busOn(mock, CH.runCancelled);
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]).toMatchObject({
        workflowRunId: "workgraph-run/never-seen",
        issueId: "wg-404",
        executionId: "exec-404",
      });
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// progress, addressing, capacity
// ---------------------------------------------------------------------------

describe("progress forwarding and addressing", () => {
  it("upstream updates forward as run:progress with the fencing fields", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: {
        mode: "respond",
        updates: [{ currentTool: "bash", toolCount: 3 }],
        model: "m-1",
      },
    });
    try {
      const request = makeRunRequest();
      mock.events.emit(CH.runRequest, request);
      const progress = busOn(mock, CH.runProgress);
      expect(progress).toHaveLength(1);
      expect(progress[0]).toMatchObject({
        workflowRunId: request.workflowRunId,
        issueId: "wg-7",
        leaseEpoch: 3,
        note: "tool: bash (3 calls)",
      });
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("a request addressed to a different executor is ignored; verifier requests are rejected as unsupported", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events);
    try {
      mock.events.emit(
        CH.runRequest,
        makeRunRequest({ executorId: "someone-else" }),
      );
      expect(fake.requests).toHaveLength(0);
      expect(busOn(mock, CH.runAccepted)).toHaveLength(0);

      mock.events.emit(CH.runRequest, makeRunRequest({ role: "verifier" }));
      const rejected = busOn(mock, CH.runRejected);
      expect(rejected).toHaveLength(1);
      expect(String((rejected[0] as { reason: string }).reason)).toMatch(
        /unsupported role/,
      );
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("requests beyond maxConcurrency are rejected at-capacity", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      script: { mode: "stall" },
    });
    try {
      for (let i = 0; i < PI_SUBAGENTS_MAX_CONCURRENCY; i++) {
        mock.events.emit(
          CH.runRequest,
          makeRunRequest({ workflowRunId: `workgraph-run/cap-${i}` }),
        );
      }
      expect(bridge.activeRunCount()).toBe(PI_SUBAGENTS_MAX_CONCURRENCY);
      mock.events.emit(
        CH.runRequest,
        makeRunRequest({ workflowRunId: "workgraph-run/cap-overflow" }),
      );
      const rejected = busOn(mock, CH.runRejected);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        workflowRunId: "workgraph-run/cap-overflow",
        reason: "at-capacity",
      });
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// two executors on one bus: selection determinism
// ---------------------------------------------------------------------------

describe("two executors: selection determinism", () => {
  function makeTwoExecutorHarness(): { mock: MockPi; cleanup: () => void } {
    const mock = makeMockPi();
    const config: WorkgraphConfig = {
      ...CONFIG,
      compatInSessionExecutor: true,
      subagentsExecutor: { enabled: true },
    };
    const inSession = registerInSessionExecutor(asExtensionAPI(mock), {
      getConfig: () => config,
    });
    const bridge = registerPiSubagentsExecutor(asExtensionAPI(mock), {
      getConfig: () => config,
      probeVersion: () => "0.34.8",
      warn: () => {},
    });
    return {
      mock,
      cleanup: () => {
        inSession.teardown();
        bridge.teardown();
      },
    };
  }

  it("both offer; the opted-in bridge wins implementer selection by priority, deterministically", async () => {
    const { mock, cleanup } = makeTwoExecutorHarness();
    try {
      const offers = await discoverExecutors(mock.events, { timeoutMs: 30 });
      expect(offers.map((o) => o.executorId).sort()).toEqual([
        IN_SESSION_EXECUTOR_ID,
        PI_SUBAGENTS_EXECUTOR_ID,
      ]);
      const requirements = {
        role: "implementer" as const,
        requiresIsolation: false,
      };
      // Priority (10 vs unset=0) decides — independent of arrival order.
      expect(
        selectExecutor(offers, requirements, {})?.executorId,
      ).toBe(PI_SUBAGENTS_EXECUTOR_ID);
      expect(
        selectExecutor([...offers].reverse(), requirements, {})?.executorId,
      ).toBe(PI_SUBAGENTS_EXECUTOR_ID);
      // An isolation-requiring request can NEVER select in-session.
      expect(
        selectExecutor(
          offers,
          { role: "implementer", requiresIsolation: true },
          {},
        )?.executorId,
      ).toBe(PI_SUBAGENTS_EXECUTOR_ID);
      // Only the bridge offers reviewer.
      expect(
        selectExecutor(offers, { role: "reviewer", requiresIsolation: false }, {})
          ?.executorId,
      ).toBe(PI_SUBAGENTS_EXECUTOR_ID);
      // An explicit pin still forces in-session.
      expect(
        selectExecutor(offers, requirements, {
          executorId: IN_SESSION_EXECUTOR_ID,
        })?.executorId,
      ).toBe(IN_SESSION_EXECUTOR_ID);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// opt-in live smoke test — the fake/real divergence net. NEVER runs in CI:
// requires BOTH WORKGRAPH_SUBAGENTS_SMOKE=1 AND an installed pi-subagents
// package (version probe — a package.json read, never an import).
// ---------------------------------------------------------------------------

const SMOKE_REQUESTED = process.env.WORKGRAPH_SUBAGENTS_SMOKE === "1";
const SMOKE_VERSION = SMOKE_REQUESTED ? defaultProbeVersion() : undefined;
const SMOKE = SMOKE_REQUESTED && SMOKE_VERSION !== undefined;
if (SMOKE_REQUESTED && !SMOKE) {
  console.error(
    "[pi-subagents smoke] WORKGRAPH_SUBAGENTS_SMOKE=1 but no installed pi-subagents package was found — smoke suite skipped",
  );
}

describe.skipIf(!SMOKE)(
  "live smoke (opt-in: WORKGRAPH_SUBAGENTS_SMOKE=1 + installed pi-subagents)",
  () => {
    it("the harvested event names still exist verbatim in the installed upstream package", () => {
      // Divergence net: re-verify the UPSTREAM_EVENTS constants against the
      // installed package's source — a filesystem scan, never an import.
      const req = createRequire(import.meta.url);
      const pkgJson = req.resolve("pi-subagents/package.json");
      const root = dirname(pkgJson);
      const corpus: string[] = [];
      const walk = (dir: string, depth: number): void => {
        if (depth > 4) return;
        for (const entry of readdirSync(dir)) {
          if (entry === "node_modules" || entry.startsWith(".")) continue;
          const path = join(dir, entry);
          const stat = statSync(path);
          if (stat.isDirectory()) walk(path, depth + 1);
          else if (/\.(ts|js|mjs|cjs)$/.test(entry)) {
            corpus.push(readFileSync(path, "utf8"));
          }
        }
      };
      walk(root, 0);
      const haystack = corpus.join("\n");
      for (const name of Object.values(UPSTREAM_EVENTS)) {
        expect(haystack, `harvested event ${name} @ ${SMOKE_VERSION}`).toContain(
          name,
        );
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Activity schema sanity (the emitted shape validates; core stays silent)
// ---------------------------------------------------------------------------

describe("activity payload validates against the Activity schema", () => {
  it("an enriched activity message parses; a v2 envelope is rejected", () => {
    const message = {
      ...newEnvelope(),
      issueId: "wg-7",
      phase: "implementing",
      kind: "claim",
      workflowRunId: "workgraph-run/x",
      actor: "worker-1",
      summary: "claimed for pi-subagents",
    };
    const parsed = parseMessage(CH.activity, Activity, message);
    expect(parsed.kind).toBe("claim");
    expect(parsed.workflowRunId).toBe("workgraph-run/x");
    expect(() =>
      parseMessage(CH.activity, Activity, { ...message, protocolVersion: 2 }),
    ).toThrow(/activity/);
  });
});
