/**
 * The tiered executor: role→model routing, the not-offered safety property,
 * provenance reporting, structured-output extraction, and cancellation.
 *
 * NOTHING HERE SPAWNS A MODEL. The adapter takes its spawn function as a
 * dependency and this suite injects a fake child process, so every
 * assertion is about the argv the adapter WOULD run and what it does with
 * the stream it gets back. That is the whole testable surface: the adapter
 * has no logic that requires a real `pi`.
 *
 * Run via `npm run test:tiered`.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTieredPrompt,
  extractStructured,
  offeredRoles,
  piInvocation,
  registerTieredExecutor,
  TIERED_EXECUTOR_ID,
  type TieredController,
} from "../src/adapters/tiered.ts";
import type { TieredExecutorConfig, WorkgraphConfig } from "../src/config.ts";
import {
  CH,
  Discover,
  newEnvelope,
  parseMessage,
  RunCompleted,
  RunRequest,
  type ExecutorOfferT,
  type RunCompletedT,
  type RunRequestT,
} from "../src/protocol.ts";
import { Plan, Verdict } from "../src/types.ts";
import { asExtensionAPI, makeMockPi, type MockPi } from "./helpers/mock-pi.ts";

const BASE_CONFIG: WorkgraphConfig = {
  leaseTtlMs: 300_000,
  heartbeatMs: 600_000,
  pollMs: 600_000,
  sweepIntervalMs: 600_000,
  discoveryTimeoutMs: 40,
  acceptTimeoutMs: 150,
  compatInSessionExecutor: false,
};

const TIERS: TieredExecutorConfig = {
  enabled: true,
  models: {
    planner: "anthropic/claude-fable-5",
    implementer: "anthropic/claude-opus-5",
    reviewer: "some/reviewer-model",
  },
};

/** A fake child process: stdout/stderr streams plus a recorded kill. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string | null = null;
  kill(signal?: string): boolean {
    this.killed = signal ?? "SIGTERM";
    return true;
  }
  /** Emit one NDJSON assistant turn. */
  say(text: string, model = "reported/model"): void {
    this.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", model, content: [{ type: "text", text }] },
      })}\n`,
    );
  }
  finish(code = 0): void {
    this.emit("close", code);
  }
}

interface Harness {
  mock: MockPi;
  controller: TieredController;
  spawns: { command: string; args: string[] }[];
  children: FakeChild[];
  offers: ExecutorOfferT[];
  completions: RunCompletedT[];
  rejections: { reason: string }[];
}

function makeHarness(overrides: Partial<TieredExecutorConfig> = {}): Harness {
  const mock = makeMockPi();
  const spawns: { command: string; args: string[] }[] = [];
  const children: FakeChild[] = [];
  const offers: ExecutorOfferT[] = [];
  const completions: RunCompletedT[] = [];
  const rejections: { reason: string }[] = [];

  const config: WorkgraphConfig = {
    ...BASE_CONFIG,
    tieredExecutor: { ...TIERS, ...overrides },
  };

  mock.events.on(CH.offer, (data) => offers.push(data as ExecutorOfferT));
  mock.events.on(CH.runCompleted, (data) => {
    completions.push(parseMessage(CH.runCompleted, RunCompleted, data));
  });
  mock.events.on(CH.runRejected, (data) => {
    rejections.push(data as { reason: string });
  });

  const controller = registerTieredExecutor(asExtensionAPI(mock), {
    getConfig: () => config,
    cwd: "/fake/cwd",
    spawnFn: ((command: string, args: string[]) => {
      spawns.push({ command, args });
      const child = new FakeChild();
      children.push(child);
      return child;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  });

  return { mock, controller, spawns, children, offers, completions, rejections };
}

function discover(mock: MockPi): void {
  mock.events.emit(CH.discover, { ...newEnvelope() });
}

function request(
  mock: MockPi,
  role: RunRequestT["role"],
  extra: Partial<RunRequestT> = {},
): RunRequestT {
  const msg: RunRequestT = {
    ...newEnvelope(),
    executorId: TIERED_EXECUTOR_ID,
    issue: { id: "iss-1", title: "add retry backoff" },
    workflowRunId: "wfr-1",
    leaseEpoch: 3,
    role,
    attempt: 1,
    workspace: { baseRevision: "", requiresIsolation: false },
    ...extra,
  };
  mock.events.emit(CH.runRequest, msg);
  return parseMessage(CH.runRequest, RunRequest, msg);
}

let active: TieredController | null = null;
afterEach(() => {
  active?.teardown();
  active = null;
});

// ---------------------------------------------------------------------------
// The safety property
// ---------------------------------------------------------------------------

describe("role→model mapping", () => {
  it("offers ONLY the roles that have a model, never the ambient default", () => {
    expect(offeredRoles(TIERS)).toEqual(["planner", "implementer", "reviewer"]);
    // `revision` is unmapped above, so it is absent — the coordinator will
    // look elsewhere rather than getting untiered work reported as success.
    expect(offeredRoles(TIERS)).not.toContain("revision");
    expect(
      offeredRoles({ enabled: true, models: { implementer: "m" } }),
    ).toEqual(["implementer"]);
  });

  it("advertises the mapped roles, isolation none, and a priority above in-session", () => {
    const h = makeHarness();
    active = h.controller;
    discover(h.mock);
    expect(h.offers).toHaveLength(1);
    const offer = h.offers[0]!;
    expect(offer.executorId).toBe(TIERED_EXECUTOR_ID);
    expect(offer.roles).toEqual(["planner", "implementer", "reviewer"]);
    // Honest isolation: the adapter creates no worktree, so it must not
    // claim one — the coordinator filters on this when a request needs it.
    expect(offer.isolation).toBe("none");
    expect(offer.supportsCancellation).toBe(true);
    expect(offer.priority).toBeGreaterThan(0);
  });

  it("rejects an unmapped role rather than running it on the default model", () => {
    const h = makeHarness();
    active = h.controller;
    request(h.mock, "revision");
    expect(h.spawns).toHaveLength(0);
    expect(h.rejections[0]?.reason).toMatch(/no model configured for role revision/);
  });

  it("spawns each role with ITS model", () => {
    const h = makeHarness();
    active = h.controller;
    request(h.mock, "planner");
    request(h.mock, "implementer");

    const modelOf = (args: string[]): string => args[args.indexOf("--model") + 1]!;
    expect(modelOf(h.spawns[0]!.args)).toBe("anthropic/claude-fable-5");
    expect(modelOf(h.spawns[1]!.args)).toBe("anthropic/claude-opus-5");

    // The invocation shape pi's own subagent example uses. Asserted as a
    // contiguous run rather than from index 0, because `piInvocation` may
    // prepend the current script when re-running it under this runtime —
    // which is exactly what happens under vitest, whose argv[1] is a real
    // file. The prompt is always last.
    const args = h.spawns[0]!.args;
    const flagStart = args.indexOf("--mode");
    expect(flagStart).toBeGreaterThanOrEqual(0);
    expect(args.slice(flagStart, flagStart + 6)).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      "anthropic/claude-fable-5",
    ]);
    expect(args[args.length - 1]).toContain("work-graph issue iss-1");
  });

  it("piInvocation re-runs the current script when it is a real file", () => {
    // Under vitest, argv[1] is a real path, so the first branch applies and
    // the script is prepended — the same behavior a checked-out pi gets.
    const { command, args } = piInvocation(["--mode", "json"]);
    expect(args.slice(-2)).toEqual(["--mode", "json"]);
    expect(command).toBe(process.execPath);
    expect(args).toHaveLength(3);
  });

  it("honours maxConcurrency, rejecting the run past the cap", () => {
    const h = makeHarness({ maxConcurrency: 1 });
    active = h.controller;
    request(h.mock, "implementer");
    request(h.mock, "implementer");
    expect(h.spawns).toHaveLength(1);
    expect(h.rejections[0]?.reason).toBe("at-capacity");
  });
});

// ---------------------------------------------------------------------------
// Provenance — what the independence check reads
// ---------------------------------------------------------------------------

describe("provenance", () => {
  it("reports the model the run SAID it used, not the one requested", () => {
    const h = makeHarness();
    active = h.controller;
    request(h.mock, "implementer");
    // The provider served something other than what we asked for.
    h.children[0]!.say("done", "anthropic/claude-opus-5-fallback");
    h.children[0]!.finish(0);

    expect(h.completions).toHaveLength(1);
    expect(h.completions[0]!.provenance.model).toBe(
      "anthropic/claude-opus-5-fallback",
    );
    // Surfacing the substitution is the point: a same-model review would
    // otherwise pass the judgment gate's independence check on a lie.
    expect(h.completions[0]!.provenance.model).not.toBe(
      "anthropic/claude-opus-5",
    );
  });

  it("populates the provider axis, so independence is not silently model-only", () => {
    const h = makeHarness();
    active = h.controller;
    request(h.mock, "reviewer");
    h.children[0]!.say("{}", "openai-codex/gpt-5.6-sol");
    h.children[0]!.finish(0);

    // `checkIndependence` FAILS CLOSED: an undefined axis counts as a
    // match, so leaving provider unset would quietly reduce the check to
    // the model axis alone.
    expect(h.completions[0]!.provenance.provider).toBe("openai-codex");
    expect(h.completions[0]!.provenance.model).toBe("openai-codex/gpt-5.6-sol");
  });

  it("leaves provider unset when the model id is not an unambiguous provider/id", () => {
    const h = makeHarness();
    active = h.controller;
    request(h.mock, "implementer");
    // Fireworks-style ids carry several slashes — splitting them would
    // invent a provider that does not mean what the axis means.
    h.children[0]!.say("done", "accounts/fireworks/models/kimi-k3");
    h.children[0]!.finish(0);
    expect(h.completions[0]!.provenance.provider).toBeUndefined();
    expect(h.completions[0]!.provenance.model).toBe(
      "accounts/fireworks/models/kimi-k3",
    );
  });

  it("falls back to the requested model only when the run reported none", () => {
    const h = makeHarness();
    active = h.controller;
    request(h.mock, "planner");
    h.children[0]!.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "{}" }] },
      })}\n`,
    );
    h.children[0]!.finish(0);
    expect(h.completions[0]!.provenance.model).toBe("anthropic/claude-fable-5");
  });

  it("a non-zero exit is a failure outcome, with stderr as evidence", () => {
    const h = makeHarness();
    active = h.controller;
    request(h.mock, "implementer");
    h.children[0]!.stderr.emit("data", "boom: model unavailable");
    h.children[0]!.finish(2);

    expect(h.completions[0]!.outcome).toBe("failure");
    expect(h.completions[0]!.evidence.join(" ")).toContain("boom: model unavailable");
  });
});

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

describe("structured output", () => {
  it("extracts bare and fenced JSON, and refuses anything else", () => {
    expect(extractStructured('{"steps":[]}')).toEqual({ steps: [] });
    expect(extractStructured('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractStructured('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractStructured("here you go: {}")).toBeUndefined();
    expect(extractStructured("plain prose")).toBeUndefined();
    expect(extractStructured("[1,2]")).toEqual([1, 2]);
    expect(extractStructured('"a string"')).toBeUndefined();
  });

  it("attaches a planner's JSON as `plan` and a reviewer's as `verdict`", () => {
    const h = makeHarness();
    active = h.controller;
    request(h.mock, "planner", { outputSchema: Plan });
    h.children[0]!.say('{"steps":[{"description":"do it"}]}');
    h.children[0]!.finish(0);
    expect(
      (h.completions[0] as RunCompletedT & { plan?: { steps: unknown[] } }).plan,
    ).toEqual({ steps: [{ description: "do it" }] });

    request(h.mock, "reviewer", { outputSchema: Verdict });
    h.children[1]!.say('{"findings":[]}');
    h.children[1]!.finish(0);
    expect(
      (h.completions[1] as RunCompletedT & { verdict?: unknown }).verdict,
    ).toEqual({ findings: [] });
  });

  it("omits the field entirely when the output is unparseable", () => {
    const h = makeHarness();
    active = h.controller;
    request(h.mock, "planner", { outputSchema: Plan });
    h.children[0]!.say("I thought about it but here is prose instead.");
    h.children[0]!.finish(0);

    // No invented payload: the core's own invalid-plan path (audited,
    // escalating) is the right place to decide what a missing plan means.
    expect(h.completions[0]).not.toHaveProperty("plan");
    expect(h.completions[0]!.outcome).toBe("success");
  });

  it("an implementer's JSON-looking text is NOT attached as structured output", () => {
    const h = makeHarness();
    active = h.controller;
    request(h.mock, "implementer");
    h.children[0]!.say('{"findings":[]}');
    h.children[0]!.finish(0);
    expect(h.completions[0]).not.toHaveProperty("verdict");
    expect(h.completions[0]).not.toHaveProperty("plan");
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe("prompts", () => {
  it("tells each role what it may not do, and carries the plan downstream", () => {
    const base = {
      ...newEnvelope(),
      executorId: TIERED_EXECUTOR_ID,
      issue: { id: "i", title: "t", acceptanceCriteria: "must hold" },
      workflowRunId: "w",
      leaseEpoch: 1,
      attempt: 1,
      workspace: { baseRevision: "", requiresIsolation: false },
    };

    const planner = buildTieredPrompt({ ...base, role: "planner" } as RunRequestT);
    expect(planner).toContain("Do not edit, create, or delete any file");
    expect(planner).toContain("must hold");

    const impl = buildTieredPrompt({
      ...base,
      role: "implementer",
      plan: "1. do the thing",
    } as RunRequestT);
    expect(impl).toContain("1. do the thing");
    expect(impl).toContain("do not close or release the issue yourself");

    const reviewer = buildTieredPrompt({ ...base, role: "reviewer" } as RunRequestT);
    expect(reviewer).toContain("Do not fix what you find");

    const revision = buildTieredPrompt({
      ...base,
      role: "revision",
      priorFindings: ['{"criterion":"x"}'],
    } as RunRequestT);
    expect(revision).toContain('{"criterion":"x"}');

    // A schema on the request is inlined with the bare-JSON instruction.
    expect(
      buildTieredPrompt({ ...base, role: "planner", outputSchema: Plan } as RunRequestT),
    ).toContain("bare JSON object");
  });
});

// ---------------------------------------------------------------------------
// Cancellation and teardown
// ---------------------------------------------------------------------------

describe("cancellation", () => {
  it("kills the child, acks, and reports NO completion", () => {
    const h = makeHarness();
    active = h.controller;
    const msg = request(h.mock, "implementer");
    const acks: unknown[] = [];
    h.mock.events.on(CH.runCancelled, (d) => acks.push(d));

    h.mock.events.emit(CH.runCancel, {
      ...newEnvelope(),
      workflowRunId: msg.workflowRunId,
      issueId: msg.issue.id,
    });

    expect(h.children[0]!.killed).toBe("SIGTERM");
    expect(acks).toHaveLength(1);
    // A cancelled run's close must not surface as a completion — the
    // coordinator has already moved on and would fence it out anyway.
    h.children[0]!.finish(0);
    expect(h.completions).toHaveLength(0);
  });

  it("acks an unknown run too (the no-op-ack contract)", () => {
    const h = makeHarness();
    active = h.controller;
    const acks: unknown[] = [];
    h.mock.events.on(CH.runCancelled, (d) => acks.push(d));
    h.mock.events.emit(CH.runCancel, {
      ...newEnvelope(),
      workflowRunId: "never-existed",
      issueId: "iss-9",
    });
    // Silence would make a coordinator wait out its whole ack window.
    expect(acks).toHaveLength(1);
  });

  it("teardown kills every in-flight child", () => {
    const h = makeHarness();
    request(h.mock, "planner");
    request(h.mock, "implementer");
    expect(h.controller.activeRuns()).toHaveLength(2);
    h.controller.teardown();
    expect(h.children.every((c) => c.killed === "SIGTERM")).toBe(true);
    expect(h.controller.activeRuns()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The disabled default
// ---------------------------------------------------------------------------

describe("disabled by default", () => {
  it("offers nothing and runs nothing without config", () => {
    const mock = makeMockPi();
    const offers: unknown[] = [];
    const spawns: unknown[] = [];
    mock.events.on(CH.offer, (d) => offers.push(d));
    const controller = registerTieredExecutor(asExtensionAPI(mock), {
      getConfig: () => BASE_CONFIG, // no tieredExecutor block
      spawnFn: (() => {
        spawns.push(1);
        return new FakeChild();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });
    active = controller;
    discover(mock);
    request(mock, "implementer");
    expect(offers).toHaveLength(0);
    expect(spawns).toHaveLength(0);
  });

  it("an enabled block with no models offers nothing", () => {
    const h = makeHarness({ models: {} });
    active = h.controller;
    discover(h.mock);
    expect(h.offers).toHaveLength(0);
  });
});
