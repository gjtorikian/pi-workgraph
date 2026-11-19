/**
 * Gate modes and proof records (proof-of-success phase 1): the seven-gate
 * policy map and its shipped defaults, policy validation, the block /
 * would-block decision, the `workgraph-proof` trail, the `review` gate under
 * enforce, observe and off, the gate report, and what an invalid policy
 * stops.
 *
 * This suite does NOT pin `PRE_PROOF_POLICY`. Its configs come from
 * `shippedConfig`, so a case with no `policy` runs on the defaults a user
 * gets, and a case that sets modes says so in the case. (The one place the
 * pin appears is the block that tests the pin itself.) `review` is the gate
 * whose behavior this suite covers; `tree-binding` has its own suite
 * (test/proof-binding.test.ts), and the other five are asserted as
 * configuration and as the decision table, not as behavior.
 *
 * Because the defaults enforce `tree-binding` at medium and high, every case
 * that drives the coordinator runs in a real git repository
 * (`makeScratchRepo`) with a fake that reports its workspace, and reads the
 * review gate's records through `reviewRecords`.
 *
 * Timer discipline is the repo's: no fake timers, huge scheduling intervals,
 * tiny REAL protocol timeouts, ticks driven through `agent_settled`, and
 * `flushEvents()` to drain the completion handler.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig, resolveConfigWithoutPolicy } from "../src/config.ts";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import piWorkgraph from "../src/index.ts";
import {
  heldLeases,
  leaseExpiresAtOf,
  resetLeasesForTest,
} from "../src/lease.ts";
import {
  DEFAULT_POLICY,
  GATES,
  PolicyConfigError,
  resolvePolicy,
  validatePolicyOverrides,
  type GateModeT,
  type GateName,
  type PolicyOverrides,
} from "../src/policy.ts";
import {
  decideGate,
  listGateRecords,
  MAX_REASON_CHARS,
  PROOF_GATES,
  recordGate,
  type GateRecord,
  type GateResult,
} from "../src/proof.ts";
import { noteSessionCwd } from "../src/settings.ts";
import { listComments, listCommentsByPrefix } from "../src/store.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import {
  WORKGRAPH_ATTEMPT_KEY,
  WORKGRAPH_LAST_VERDICT_KEY,
  WORKGRAPH_PHASE_KEY,
  type VerdictT,
} from "../src/types.ts";
import { TRUNCATION_MARKER } from "../src/verdict.ts";
import {
  PRE_PROOF_POLICY,
  preProofConfig,
  shippedConfig,
} from "./helpers/config.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import {
  failCommentWrites,
  makeScratchGraph,
  makeScratchRepo,
  type ScratchGraph,
  type ScratchRepo,
} from "./helpers/scratch.ts";

const WORKER = "gate-modes-worker";

/** Distinct author/reviewer provenance — independent under every policy. */
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };

const CLEAN_VERDICT: VerdictT = { findings: [] };

/** The file every blocking fixture cites. The implementer writes it. */
const CITED_FILE = "thing.ts";

/** An implementer `onRequest` that leaves {@link CITED_FILE} in the result tree. */
function writesCitedFile(repo: ScratchRepo): () => void {
  return () => writeFileSync(join(repo.dir, CITED_FILE), "export const thing = 1;\n");
}

/**
 * One blocking finding the core lets stand: it cites a line that exists in
 * the reviewed tree. A blocker that cited nothing would be downgraded to
 * advisory before the review gate ever saw it.
 */
function blockingVerdict(criterion: string): VerdictT {
  return {
    findings: [
      {
        criterion,
        severity: "blocking",
        note: "does not hold",
        citation: { path: CITED_FILE, line: 1 },
      },
    ],
  };
}

/** The reviewer's answer to the recheck every blocking verdict gets: it keeps its one blocker. */
const KEEP_BLOCKER = {
  answers: [{ n: 1, decision: "keep", reason: "line 1 still does it" }],
};

const MODES: readonly GateModeT[] = ["off", "observe", "enforce"];
const RESULTS: readonly GateResult[] = [
  "pass",
  "violation",
  "not-applicable",
  "unknown",
];
const OTHER_SIX = GATES.filter((gate) => gate !== "check");

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
}

/** A coordinator on the shipped defaults, or on exactly the `policy` given. */
function makeHarness(policy?: PolicyOverrides): Harness {
  const mock = makeMockPi();
  const config = shippedConfig({
    workerIdOverride: WORKER,
    ...(policy ? { policy } : {}),
  });
  setWorkerIdOverride(WORKER);
  // The tools resolve their own config from flags; keep the identity equal.
  mock.setFlag("workgraph-worker-id", WORKER);
  registerWorkgraphTools(asExtensionAPI(mock));
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
  });
  return { mock, coordinator };
}

function settle(mock: MockPi, ctx: unknown): Promise<unknown[]> {
  return mock.emit(
    "agent_settled",
    { type: "agent_settled" },
    ctx as Parameters<MockPi["emit"]>[2],
  );
}

/** One coordination pass per issue: claim, run, judge, and drain. */
async function drive(mock: MockPi, ctx: unknown, rounds = 1): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await settle(mock, ctx);
    await mock.flushEvents();
  }
}

function metadataOf(graph: ScratchGraph, id: string): Record<string, unknown> {
  return (graph.showIssue(id).metadata ?? {}) as Record<string, unknown>;
}

/** Approve an issue the way workgraph_approve does, from outside this process. */
function approve(graph: ScratchGraph, id: string, riskTier = "medium"): void {
  graph.op([
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=ready",
    // The check the core runs before any review: the shell builtin, which
    // passes. Medium- and high-risk work with none does not reach review.
    "--set-metadata",
    "workgraph_check=true",
    "--set-metadata",
    `workgraph_risk_tier=${riskTier}`,
    "--set-metadata",
    "workgraph_workflow_class=reviewed",
    "--actor",
    "approver",
  ]);
}

async function commentCount(dir: string, id: string, marker: string): Promise<number> {
  const comments = await listComments(dir, id);
  return comments.filter((c) => c.text.startsWith(marker)).length;
}

const verdictCount = (dir: string, id: string) =>
  commentCount(dir, id, "workgraph-verdict verdict ");

/**
 * What an isolated fake reports: its work is in the repository, cut from
 * HEAD. With it the `tree-binding` gate (enforced by default at medium and
 * high) passes, so a case about the review gate is about the review gate.
 */
function isolatedIn(repo: ScratchRepo) {
  return { path: repo.dir, baseRevision: repo.head };
}

/**
 * The `review` gate's records. The coordinator cases below run on a
 * git-backed scratch, where the `tree-binding` gate records ahead of every
 * review; its own behavior is covered in test/proof-binding.test.ts.
 */
async function reviewRecords(dir: string, issueId?: string) {
  return (await listGateRecords(dir, issueId)).filter((r) => r.gate === "review");
}

async function toolText(
  mock: MockPi,
  name: string,
  params: unknown,
  cwd: string,
): Promise<string> {
  const def = mock.tools.get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  const result = (await def.execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    makeToolContext(cwd),
  )) as { content: { type: string; text?: string }[] };
  return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

/** Silence console.error and return the lines it was given. */
function captureErrors(): () => string[] {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.join(" "));
}

const dirs: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-workgraph-${label}-`));
  dirs.push(dir);
  return dir;
}

/** Run `body` with the given env vars set (or, for `undefined`, unset), restoring them afterwards. */
function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const previous = new Map(Object.keys(vars).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLeasesForTest();
  resetIdentityForTest();
  noteSessionCwd(undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

describe("defaults", () => {
  it("names seven gates, review first", () => {
    expect([...GATES]).toEqual([
      "review",
      "tree-binding",
      "check",
      "criteria-evidence",
      "weakened-tests",
      "unproven-tests",
      "scope",
    ]);
  });

  it("with no overrides, check enforces at every tier and the other six enforce at high and medium and observe at low", () => {
    for (const tier of ["low", "medium", "high"] as const) {
      expect(resolvePolicy(tier).gates.check, `${tier} check`).toBe("enforce");
    }
    for (const gate of OTHER_SIX) {
      expect(resolvePolicy("high").gates[gate], `high ${gate}`).toBe("enforce");
      expect(resolvePolicy("medium").gates[gate], `medium ${gate}`).toBe("enforce");
      expect(resolvePolicy("low").gates[gate], `low ${gate}`).toBe("observe");
    }
  });

  it("the review gate's defaults are the old gateMode: low observes, medium and high enforce", () => {
    expect(resolvePolicy("low").gates.review).toBe("observe");
    expect(resolvePolicy("medium").gates.review).toBe("enforce");
    expect(resolvePolicy("high").gates.review).toBe("enforce");
  });

  it("an unknown or missing tier resolves to medium", () => {
    expect(resolvePolicy(undefined)).toEqual(DEFAULT_POLICY.medium);
    expect(resolvePolicy("urgent")).toEqual(DEFAULT_POLICY.medium);
    // And an override for another tier does not reach it.
    expect(
      resolvePolicy(undefined, { low: { gates: { check: "off" } } }).gates.check,
    ).toBe("enforce");
  });

  it("an override naming one gate changes that gate and leaves the other six, and the other knobs, alone", () => {
    const merged = resolvePolicy("high", { high: { gates: { scope: "off" } } });
    expect(merged.gates.scope).toBe("off");
    for (const gate of GATES.filter((g) => g !== "scope")) {
      expect(merged.gates[gate], gate).toBe(DEFAULT_POLICY.high.gates[gate]);
    }
    expect(merged.requireAuthorIndependence).toEqual({ model: true });
    expect(merged.maxRevisions).toBe(3);
    // The other tiers are untouched, and so are the shared defaults.
    expect(
      resolvePolicy("medium", { high: { gates: { scope: "off" } } }),
    ).toEqual(DEFAULT_POLICY.medium);
    expect(DEFAULT_POLICY.high.gates.scope).toBe("enforce");
  });

  it("an override naming a knob but no gate keeps every gate", () => {
    const merged = resolvePolicy("medium", { medium: { maxRevisions: 1 } });
    expect(merged.maxRevisions).toBe(1);
    expect(merged.gates).toEqual(DEFAULT_POLICY.medium.gates);
  });
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

describe("validation", () => {
  it("accepts every shape a partial policy can take", () => {
    expect(validatePolicyOverrides({})).toEqual({});
    expect(validatePolicyOverrides({ medium: {} })).toEqual({ medium: {} });
    expect(validatePolicyOverrides({ high: { maxRevisions: 1 } })).toEqual({
      high: { maxRevisions: 1 },
    });
    expect(
      validatePolicyOverrides({
        medium: { requireAuthorIndependence: { model: true, provider: true } },
      }),
    ).toEqual({
      medium: { requireAuthorIndependence: { model: true, provider: true } },
    });
    const full = {
      low: { gates: { review: "off", check: "observe" }, escalate: "block" },
      high: { gates: { scope: "enforce" }, maxRevisions: 0 },
    };
    expect(validatePolicyOverrides(full)).toEqual(full);
  });

  it.each([
    // [what, input, the name the message must carry]
    ["a misspelled gate", { medium: { gates: { chekc: "observe" } } }, "policy.medium.gates.chekc"],
    ["an unknown mode", { medium: { gates: { check: "warn" } } }, "policy.medium.gates.check"],
    ["an unknown tier", { urgent: {} }, "policy.urgent"],
    ["an unknown knob", { low: { minReviewers: 2 } }, "policy.low.minReviewers"],
    ["gates that is not an object", { high: { gates: "enforce" } }, "policy.high.gates"],
    ["a tier that is not an object", { high: "enforce" }, "policy.high"],
    ["a non-numeric maxRevisions", { low: { maxRevisions: "three" } }, "policy.low.maxRevisions"],
    ["a negative maxRevisions", { low: { maxRevisions: -1 } }, "policy.low.maxRevisions"],
    ["an unknown escalation", { low: { escalate: "ignore" } }, "policy.low.escalate"],
    [
      "an unknown independence axis",
      { medium: { requireAuthorIndependence: { vendor: true } } },
      "policy.medium.requireAuthorIndependence.vendor",
    ],
    [
      "a non-boolean independence axis",
      { medium: { requireAuthorIndependence: { model: "yes" } } },
      "policy.medium.requireAuthorIndependence.model",
    ],
  ])("rejects %s, naming the bad key", (_what, input, name) => {
    let thrown: unknown;
    try {
      validatePolicyOverrides(input);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PolicyConfigError);
    expect((thrown as Error).name).toBe("PolicyConfigError");
    expect((thrown as Error).message).toContain(name);
  });

  it("names what it expected: the gates, the modes, the tiers", () => {
    expect(() => validatePolicyOverrides({ medium: { gates: { chekc: "observe" } } })).toThrow(
      /chekc is not a gate \(expected review, tree-binding, check, criteria-evidence, weakened-tests, unproven-tests or scope\)/,
    );
    expect(() => validatePolicyOverrides({ medium: { gates: { check: "warn" } } })).toThrow(
      /policy\.medium\.gates\.check must be "off", "observe" or "enforce", got "warn"/,
    );
    expect(() => validatePolicyOverrides({ urgent: {} })).toThrow(
      /policy\.urgent is not a risk tier \(expected low, medium or high\)/,
    );
  });

  it.each([
    ["a string", "not json"],
    ["null", null],
    ["an array", [{ medium: {} }]],
    ["a number", 3],
  ])("rejects a policy that is %s", (_what, input) => {
    expect(() => validatePolicyOverrides(input)).toThrow(PolicyConfigError);
    expect(() => validatePolicyOverrides(input)).toThrow(/^policy must be an object keyed by risk tier/);
  });

  it("the removed gateMode key names its replacement", () => {
    for (const tier of ["low", "medium", "high"] as const) {
      expect(() => validatePolicyOverrides({ [tier]: { gateMode: "advisory" } })).toThrow(
        `policy.${tier}.gateMode was replaced by policy.${tier}.gates.review ("advisory" is "observe", "blocking" is "enforce")`,
      );
    }
    expect(() => validatePolicyOverrides({ medium: { gateMode: "advisory" } })).toThrow(PolicyConfigError);
  });

  it("stops at the first invalid key and returns nothing", () => {
    expect(() =>
      validatePolicyOverrides({ low: { gates: { scope: "off" } }, medium: { gates: { scope: "loud" } } }),
    ).toThrow(/policy\.medium\.gates\.scope/);
  });
});

describe("policy sources", () => {
  /** resolveConfig().policy with the flag, env and both settings files under the test's control. */
  function policyFrom(
    opts: { flag?: string; env?: string; agentDir?: string; project?: string } = {},
    resolve: typeof resolveConfig = resolveConfig,
  ): PolicyOverrides | undefined {
    const mock = makeMockPi();
    if (opts.flag !== undefined) mock.setFlag("workgraph-policy", opts.flag);
    noteSessionCwd(opts.project);
    return withEnv(
      { WORKGRAPH_POLICY: opts.env, PI_CODING_AGENT_DIR: opts.agentDir ?? tempDir("agent") },
      () => resolve(asExtensionAPI(mock)).policy,
    );
  }

  function writeSettings(dir: string, sub: string | undefined, policy: unknown): void {
    const target = sub ? join(dir, sub) : dir;
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "settings.json"), JSON.stringify({ workgraph: { policy } }));
  }

  it("is undefined when nothing sets it, so the shipped defaults apply", () => {
    expect(policyFrom()).toBeUndefined();
    expect(policyFrom({ project: tempDir("project") })).toBeUndefined();
  });

  it("reads the flag, then the environment, then the workgraph.policy setting", () => {
    const agentDir = tempDir("agent");
    const project = tempDir("project");
    writeSettings(agentDir, undefined, { low: { gates: { scope: "off" } } });
    expect(policyFrom({ agentDir })).toEqual({ low: { gates: { scope: "off" } } });

    // The project file replaces the global one whole.
    writeSettings(project, ".pi", { high: { maxRevisions: 1 } });
    expect(policyFrom({ agentDir, project })).toEqual({ high: { maxRevisions: 1 } });

    const env = JSON.stringify({ medium: { gates: { review: "observe" } } });
    expect(policyFrom({ agentDir, project, env })).toEqual({ medium: { gates: { review: "observe" } } });

    const flag = JSON.stringify({ medium: { gates: { review: "off" } } });
    expect(policyFrom({ agentDir, project, env, flag })).toEqual({ medium: { gates: { review: "off" } } });
  });

  it("an invalid flag or environment value throws, naming the key and the source", () => {
    const bad = JSON.stringify({ medium: { gates: { chekc: "observe" } } });
    for (const opts of [{ flag: bad }, { env: bad }]) {
      expect(() => policyFrom(opts)).toThrow(PolicyConfigError);
      expect(() => policyFrom(opts)).toThrow(
        /policy\.medium\.gates\.chekc is not a gate .* \(set by workgraph-policy\/WORKGRAPH_POLICY\)/,
      );
    }
  });

  it("unparseable JSON throws instead of falling back to the defaults", () => {
    expect(() => policyFrom({ flag: "not json" })).toThrow(PolicyConfigError);
    expect(() => policyFrom({ flag: "not json" })).toThrow(
      "policy is not valid JSON (set by workgraph-policy/WORKGRAPH_POLICY)",
    );
    expect(() => policyFrom({ flag: '"not json"' })).toThrow(/policy must be an object keyed by risk tier/);
  });

  it("an invalid policy in a settings file throws too, naming the setting", () => {
    const agentDir = tempDir("agent");
    writeSettings(agentDir, undefined, { low: { gateMode: "advisory" } });
    expect(() => policyFrom({ agentDir })).toThrow(PolicyConfigError);
    expect(() => policyFrom({ agentDir })).toThrow(
      'policy.low.gateMode was replaced by policy.low.gates.review ("advisory" is "observe", "blocking" is "enforce") (set by the "workgraph.policy" setting)',
    );
    // A valid flag wins over the invalid setting: the setting is never read.
    expect(policyFrom({ agentDir, flag: "{}" })).toEqual({});
  });

  it("the policy-free reader neither validates nor returns a policy", () => {
    const mock = makeMockPi();
    mock.setFlag("workgraph-policy", JSON.stringify({ medium: { gateMode: "advisory" } }));
    mock.setFlag("workgraph-lease-ttl-ms", "1234");
    const config = withEnv({ WORKGRAPH_POLICY: undefined }, () =>
      resolveConfigWithoutPolicy(asExtensionAPI(mock)),
    );
    expect(config.leaseTtlMs).toBe(1234);
    expect("policy" in config).toBe(false);
    expect(() =>
      withEnv({ WORKGRAPH_POLICY: undefined }, () => resolveConfig(asExtensionAPI(mock))),
    ).toThrow(PolicyConfigError);
  });
});

// ---------------------------------------------------------------------------
// decideGate
// ---------------------------------------------------------------------------

describe("decideGate", () => {
  it("the four proof gates are the ones whose unknown blocks", () => {
    expect([...PROOF_GATES]).toEqual(["review", "tree-binding", "check", "criteria-evidence"]);
  });

  it("covers the whole table: 7 gates x 3 modes x 4 results", () => {
    const diffGuards: GateName[] = ["weakened-tests", "unproven-tests", "scope"];
    let cases = 0;
    for (const gate of GATES) {
      for (const mode of MODES) {
        for (const result of RESULTS) {
          cases += 1;
          // What the result would do if the gate enforced.
          const blocks =
            result === "violation" ||
            (result === "unknown" && !diffGuards.includes(gate));
          expect(decideGate(gate, mode, result), `${gate} ${mode} ${result}`).toEqual({
            blocked: mode === "enforce" && blocks,
            wouldBlock: mode === "observe" && blocks,
          });
        }
      }
    }
    expect(cases).toBe(84);
  });

  it("a violation blocks under enforce for every gate", () => {
    for (const gate of GATES) {
      expect(decideGate(gate, "enforce", "violation")).toEqual({ blocked: true, wouldBlock: false });
    }
  });

  it("unknown blocks under enforce for a proof gate and never for a diff guard", () => {
    expect(decideGate("check", "enforce", "unknown").blocked).toBe(true);
    expect(decideGate("scope", "enforce", "unknown").blocked).toBe(false);
    expect(decideGate("weakened-tests", "enforce", "unknown").blocked).toBe(false);
    expect(decideGate("unproven-tests", "enforce", "unknown").blocked).toBe(false);
  });

  it("observe mirrors enforce: it would block exactly what enforce blocks", () => {
    expect(decideGate("review", "observe", "violation")).toEqual({ blocked: false, wouldBlock: true });
    expect(decideGate("check", "observe", "unknown").wouldBlock).toBe(true);
    expect(decideGate("scope", "observe", "unknown").wouldBlock).toBe(false);
    for (const gate of GATES) {
      for (const result of RESULTS) {
        expect(decideGate(gate, "observe", result).wouldBlock, `${gate} ${result}`).toBe(
          decideGate(gate, "enforce", result).blocked,
        );
      }
    }
  });

  it("off never blocks or would block; pass and not-applicable never do under any mode", () => {
    const neither = { blocked: false, wouldBlock: false };
    for (const gate of GATES) {
      for (const result of RESULTS) expect(decideGate(gate, "off", result)).toEqual(neither);
      for (const mode of MODES) {
        expect(decideGate(gate, mode, "pass")).toEqual(neither);
        expect(decideGate(gate, mode, "not-applicable")).toEqual(neither);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// the proof record trail
// ---------------------------------------------------------------------------

describe("proof record trail", () => {
  function record(overrides: Partial<GateRecord> = {}): GateRecord {
    return {
      gate: "review",
      mode: "enforce",
      result: "violation",
      blocked: true,
      wouldBlock: false,
      workflowRunId: "workgraph-run/test",
      attempt: 1,
      ...overrides,
    };
  }

  it("writes one workgraph-proof comment per record and reads it back, per issue and across the graph", async () => {
    const graph = makeScratchGraph({ prefix: "prf", seed: 2 });
    const [first, second] = graph.seededIds as [string, string];
    try {
      await recordGate(graph.dir, first, record({ reason: "reject blocking=1" }), "tester");
      await recordGate(
        graph.dir,
        second,
        record({ gate: "scope", mode: "observe", result: "unknown", blocked: false, tree: "abc123" }),
      );
      await recordGate(graph.dir, first, record({ result: "pass", blocked: false, attempt: 2 }));

      const comments = await listComments(graph.dir, first);
      expect(comments.map((c) => c.text.slice(0, 21))).toEqual([
        "workgraph-proof gate ",
        "workgraph-proof gate ",
      ]);
      expect(comments[0]!.author).toBe("tester");

      expect(await listGateRecords(graph.dir, first)).toEqual([
        { ...record({ reason: "reject blocking=1" }), issueId: first },
        { ...record({ result: "pass", blocked: false, attempt: 2 }), issueId: first },
      ]);
      // No id: every issue's records in one query, oldest first.
      const all = await listGateRecords(graph.dir);
      expect(all.map((r) => [r.issueId, r.gate, r.result])).toEqual([
        [first, "review", "violation"],
        [second, "scope", "unknown"],
        [first, "review", "pass"],
      ]);
      expect(all[1]!.tree).toBe("abc123");
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("caps the reason at 400 characters, marker included", async () => {
    const graph = makeScratchGraph({ prefix: "prfcap", seed: 1 });
    const id = graph.seededIds[0]!;
    try {
      await recordGate(graph.dir, id, record({ reason: "x".repeat(1000) }));
      await recordGate(graph.dir, id, record({ reason: "y".repeat(MAX_REASON_CHARS) }));
      const [capped, exact] = await listGateRecords(graph.dir, id);
      expect(MAX_REASON_CHARS).toBe(400);
      expect(capped!.reason).toHaveLength(400);
      expect(capped!.reason!.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(exact!.reason).toBe("y".repeat(400));
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("records nothing for a gate that is off", async () => {
    const graph = makeScratchGraph({ prefix: "prfoff", seed: 1 });
    const id = graph.seededIds[0]!;
    try {
      await recordGate(graph.dir, id, record({ mode: "off", blocked: false }));
      expect(await listComments(graph.dir, id)).toEqual([]);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("skips a comment under the prefix that is not a gate record, on both read paths", async () => {
    const graph = makeScratchGraph({ prefix: "prfbad", seed: 1 });
    const id = graph.seededIds[0]!;
    try {
      graph.op(["comment", id, "workgraph-proof gate {not json"]);
      graph.op(["comment", id, 'workgraph-proof gate {"gate":"review"}']);
      graph.op(["comment", id, 'workgraph-proof gate {"gate":"nonsense","mode":"enforce","result":"pass","blocked":false,"wouldBlock":false,"workflowRunId":"r","attempt":1}']);
      // Same words, wrong case: SQLite's LIKE would match it, the trail must not.
      graph.op(["comment", id, `WORKGRAPH-PROOF GATE ${JSON.stringify(record())}`]);
      await recordGate(graph.dir, id, record());

      const expected = [{ ...record(), issueId: id }];
      expect(await listGateRecords(graph.dir, id)).toEqual(expected);
      expect(await listGateRecords(graph.dir)).toEqual(expected);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("listCommentsByPrefix matches the prefix exactly: no wildcards, no case folding", async () => {
    const graph = makeScratchGraph({ prefix: "prfpre", seed: 2 });
    const [first, second] = graph.seededIds as [string, string];
    try {
      graph.op(["comment", first, "a_b one"]);
      graph.op(["comment", second, "axb two"]);
      graph.op(["comment", first, "A_B three"]);
      graph.op(["comment", second, "a%b four"]);
      graph.op(["comment", second, "a_b five"]);

      const underscore = await listCommentsByPrefix(graph.dir, "a_b");
      expect(underscore.map((c) => [c.issue_id, c.text])).toEqual([
        [first, "a_b one"],
        [second, "a_b five"],
      ]);
      expect((await listCommentsByPrefix(graph.dir, "a%")).map((c) => c.text)).toEqual(["a%b four"]);
      expect(await listCommentsByPrefix(graph.dir, "nothing")).toEqual([]);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("a failed gate-record write is logged loudly and resolves", async () => {
    const graph = makeScratchGraph({ prefix: "prffail", seed: 1 });
    const id = graph.seededIds[0]!;
    const logged = captureErrors();
    try {
      failCommentWrites(graph.dir, "workgraph-proof");
      await expect(recordGate(graph.dir, id, record())).resolves.toBeUndefined();
      expect(logged().filter((line) => line.includes("PROOF WRITE FAILED"))).toEqual([
        expect.stringContaining(`review gate on ${id}`),
      ]);
      expect(await listGateRecords(graph.dir, id)).toEqual([]);
    } finally {
      graph.cleanup();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// the review gate in the judgment loop
// ---------------------------------------------------------------------------

describe("the review gate", () => {
  /**
   * An implementer and a reviewer that returns one blocking finding, and
   * keeps it when asked to look again. One reviewer script serves both
   * requests: the review reads `verdict`, the recheck reads `recheck`.
   */
  function blockingReview(mock: MockPi, graph: ScratchRepo) {
    return installFakeExecutor(mock.events, {
      workspace: isolatedIn(graph),
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          artifacts: [CITED_FILE],
          onRequest: writesCitedFile(graph),
        },
        reviewer: {
          provenance: REV_PROV,
          verdict: blockingVerdict("criterion-x"),
          recheck: KEEP_BLOCKER,
        },
      },
    });
  }

  it("enforce: blocking findings send the issue to revising and record one blocked result", async () => {
    const graph = makeScratchRepo({ prefix: "gmenf", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness({ medium: { gates: { review: "enforce" } } });
    const fake = blockingReview(mock, graph);
    const ectx = makeEventContext(graph.dir);
    captureErrors(); // "no revision-capable executor" is expected noise
    try {
      await drive(mock, ectx.ctx);

      // Nothing offers the revision role, so the run parks where the gate
      // sent it: in revising, under its lease.
      expect(graph.showIssue(id).status).toBe("in_progress");
      const metadata = metadataOf(graph, id);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("revising");
      expect(Number(metadata[WORKGRAPH_ATTEMPT_KEY])).toBe(2);
      expect(String(metadata[WORKGRAPH_LAST_VERDICT_KEY])).toMatch(/^reject blocking=1/);
      expect(await verdictCount(graph.dir, id)).toBe(1);

      const records = await reviewRecords(graph.dir, id);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        gate: "review",
        mode: "enforce",
        result: "violation",
        blocked: true,
        wouldBlock: false,
        attempt: 1,
        issueId: id,
      });
      expect(records[0]!.reason).toMatch(/^reject blocking=1 advisory=0: criterion-x/);
      expect(records[0]!.workflowRunId).toBe(fake.requests[0]!.workflowRunId);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("observe: the same findings close the issue and record one would-block", async () => {
    const graph = makeScratchRepo({ prefix: "gmobs", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness({ medium: { gates: { review: "observe" } } });
    const fake = blockingReview(mock, graph);
    const ectx = makeEventContext(graph.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(graph.showIssue(id).status).toBe("closed");
      const metadata = metadataOf(graph, id);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("accepted");
      // The verdict is still what the reviewer said: observe changes what
      // the gate does with it, not what was found.
      expect(String(metadata[WORKGRAPH_LAST_VERDICT_KEY])).toMatch(/^reject blocking=1/);
      expect(await verdictCount(graph.dir, id)).toBe(1);
      // One review, then the one recheck its blocker gets: the blocker is
      // checked the same way whether or not the gate will act on it.
      const reviews = fake.requests.filter((r) => r.role === "reviewer");
      expect(reviews.map((r) => "recheck" in r)).toEqual([false, true]);

      const records = await reviewRecords(graph.dir, id);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        gate: "review",
        mode: "observe",
        result: "violation",
        blocked: false,
        wouldBlock: true,
        attempt: 1,
      });
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("off: the issue closes with no reviewer request, no verdict and no gate record", async () => {
    const graph = makeScratchRepo({ prefix: "gmoff", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness({ medium: { gates: { review: "off" } } });
    const fake = blockingReview(mock, graph);
    const ectx = makeEventContext(graph.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(graph.showIssue(id).status).toBe("closed");
      const metadata = metadataOf(graph, id);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("accepted");
      expect(metadata[WORKGRAPH_LAST_VERDICT_KEY]).toBe("review off");
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      expect(await verdictCount(graph.dir, id)).toBe(0);
      expect(await reviewRecords(graph.dir, id)).toEqual([]);
      // The close is still audited, attributed to the implementation.
      const comments = await listComments(graph.dir, id);
      const closed = comments.filter((c) => c.text.startsWith("workgraph-lease judgment-closed "));
      expect(closed).toHaveLength(1);
      expect(JSON.parse(closed[0]!.text.slice("workgraph-lease judgment-closed ".length))).toMatchObject({
        executionId: fake.completions[0]!.executionId,
        verdictSummary: "review off",
      });
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(coordinator.current()).toBeNull();
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("off: an issue does not park in judging when nothing offers the reviewer role", async () => {
    const graph = makeScratchRepo({ prefix: "gmoffnr", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness({ medium: { gates: { review: "off" } } });
    const fake = installFakeExecutor(mock.events, {
      workspace: isolatedIn(graph),
      roles: ["implementer"],
      roleScripts: { implementer: { provenance: IMPL_PROV } },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(graph.showIssue(id).status).toBe("closed");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("accepted");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("off accepts only a reported success: a reported failure escalates instead of closing", async () => {
    const graph = makeScratchRepo({ prefix: "gmofffail", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness({ medium: { gates: { review: "off" } } });
    const fake = installFakeExecutor(mock.events, {
      workspace: isolatedIn(graph),
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, outcome: "failure", evidence: ["tests fail"] },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(graph.showIssue(id).status).toBe("blocked");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      const comments = await listComments(graph.dir, id);
      const escalated = comments.filter((c) => c.text.startsWith("workgraph-lease escalated "));
      expect(escalated).toHaveLength(1);
      expect(escalated[0]!.text).toContain("the review gate is off");
      expect(await reviewRecords(graph.dir, id)).toEqual([]);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a mode that differs by tier: high enforces while low is off, in one policy", async () => {
    const graph = makeScratchRepo({ prefix: "gmtier", seed: 2 });
    const [high, low] = graph.seededIds as [string, string];
    approve(graph, high, "high");
    approve(graph, low, "low");
    const { mock, coordinator } = makeHarness({
      high: { gates: { review: "enforce" } },
      low: { gates: { review: "off" } },
    });
    const fake = blockingReview(mock, graph);
    const ectx = makeEventContext(graph.dir);
    captureErrors();
    try {
      await drive(mock, ectx.ctx, 2);

      expect(metadataOf(graph, high)[WORKGRAPH_PHASE_KEY]).toBe("revising");
      expect(graph.showIssue(high).status).toBe("in_progress");
      expect(graph.showIssue(low).status).toBe("closed");
      expect(metadataOf(graph, low)[WORKGRAPH_PHASE_KEY]).toBe("accepted");

      // The review and its recheck, both for the high issue.
      const reviewed = fake.requests.filter((r) => r.role === "reviewer").map((r) => r.issue.id);
      expect(reviewed).toEqual([high, high]);
      expect((await reviewRecords(graph.dir, high)).map((r) => [r.mode, r.blocked])).toEqual([
        ["enforce", true],
      ]);
      expect(await reviewRecords(graph.dir, low)).toEqual([]);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("with no gate configuration at all, a medium issue is blocked and a low issue would be", async () => {
    const graph = makeScratchRepo({ prefix: "gmdef", seed: 2 });
    const [medium, low] = graph.seededIds as [string, string];
    approve(graph, medium, "medium");
    approve(graph, low, "low");
    const { mock, coordinator } = makeHarness(); // shipped defaults
    const fake = blockingReview(mock, graph);
    const ectx = makeEventContext(graph.dir);
    captureErrors();
    try {
      await drive(mock, ectx.ctx, 2);

      expect(metadataOf(graph, medium)[WORKGRAPH_PHASE_KEY]).toBe("revising");
      expect(graph.showIssue(low).status).toBe("closed");
      expect((await reviewRecords(graph.dir)).map((r) => [r.issueId, r.mode, r.blocked, r.wouldBlock])).toEqual(
        expect.arrayContaining([
          [medium, "enforce", true, false],
          [low, "observe", false, true],
        ]),
      );
      expect(await reviewRecords(graph.dir)).toHaveLength(2);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a revision loop leaves one record per review: a violation, then a pass", async () => {
    const graph = makeScratchRepo({ prefix: "gmloop", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      workspace: isolatedIn(graph),
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, onRequest: writesCitedFile(graph) },
        revision: { provenance: IMPL_PROV, artifacts: ["src/fixed.ts"] },
        // In request order: the review, the recheck of its blocker, then
        // the review of the revised work.
        reviewer: [
          { provenance: REV_PROV, verdict: blockingVerdict("criterion-x") },
          { provenance: REV_PROV, recheck: KEEP_BLOCKER },
          { provenance: REV_PROV, verdict: CLEAN_VERDICT },
        ],
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(graph.showIssue(id).status).toBe("closed");
      const records = await reviewRecords(graph.dir, id);
      expect(records.map((r) => [r.result, r.blocked, r.attempt])).toEqual([
        ["violation", true, 1],
        ["pass", false, 2],
      ]);
      expect(records[1]!.reason).toBeUndefined();

      // Status shows the gate's LATEST result; the report still counts the
      // issue as one the gate blocked.
      const status = await toolText(mock, "workgraph_status", { id }, graph.dir);
      expect(status.split("\n")).toContain("Gate review: pass (enforce, attempt 2)");
      expect(status).not.toContain("Gate review: violation");
      const report = await toolText(mock, "workgraph_gates", {}, graph.dir);
      expect(report.split("\n")[0]).toBe(`review: 1 blocked (${id}), 0 would block`);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a failed gate-record write does not stop judgment", async () => {
    const graph = makeScratchRepo({ prefix: "gmwf", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    // Gate records only. The close stamp shares the `workgraph-proof` prefix
    // and is NOT fire-and-forget: failing it would block the close, which
    // is its own case in test/proof-binding.test.ts.
    failCommentWrites(graph.dir, "workgraph-proof gate ");
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      workspace: isolatedIn(graph),
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    const logged = captureErrors();
    try {
      await drive(mock, ectx.ctx);

      expect(graph.showIssue(id).status).toBe("closed");
      expect(await verdictCount(graph.dir, id)).toBe(1);
      expect(await reviewRecords(graph.dir, id)).toEqual([]);
      expect(logged().some((line) => line.includes("PROOF WRITE FAILED"))).toBe(true);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the gate report and the status lines
// ---------------------------------------------------------------------------

describe("gate report", () => {
  it("lists, per gate, the issue it blocked under enforce and the issue it would have blocked under observe", async () => {
    const graph = makeScratchRepo({ prefix: "gmrep", seed: 3 });
    const [high, low, untouched] = graph.seededIds as [string, string, string];
    approve(graph, high, "high"); // review enforces by default
    approve(graph, low, "low"); // review observes by default
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      workspace: isolatedIn(graph),
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, onRequest: writesCitedFile(graph) },
        reviewer: {
          provenance: REV_PROV,
          verdict: blockingVerdict("criterion-x"),
          recheck: KEEP_BLOCKER,
        },
      },
    });
    const ectx = makeEventContext(graph.dir);
    captureErrors();
    try {
      await drive(mock, ectx.ctx, 2);

      const report = await toolText(mock, "workgraph_gates", {}, graph.dir);
      expect(report.split("\n")).toEqual([
        `review: 1 blocked (${high}), 1 would block (${low})`,
        // Evaluated for both issues, and passed for both.
        "tree-binding: 0 blocked, 0 would block",
        // The fixture's check (`true`) ran once per issue and passed.
        "check: 0 blocked, 0 would block",
        // Evaluated for both, and it applies to neither: no criteria.
        "criteria-evidence: 0 blocked, 0 would block",
        "weakened-tests: no records",
        "unproven-tests: no records",
        "scope: no records",
      ]);

      // Narrowed to one issue.
      const narrowed = await toolText(mock, "workgraph_gates", { id: low }, graph.dir);
      expect(narrowed.split("\n")[0]).toBe(`review: 0 blocked, 1 would block (${low})`);
      const none = await toolText(mock, "workgraph_gates", { id: untouched }, graph.dir);
      expect(none.split("\n")[0]).toBe("review: no records");
      await expect(toolText(mock, "workgraph_gates", { id: "gmrep-999" }, graph.dir)).rejects.toThrow();
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("workgraph_status prints the gate modes for the issue's tier and each gate's latest result", async () => {
    const graph = makeScratchRepo({ prefix: "gmsts", seed: 3 });
    const [high, low, legacy] = graph.seededIds as [string, string, string];
    approve(graph, high, "high");
    approve(graph, low, "low");
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      workspace: isolatedIn(graph),
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, onRequest: writesCitedFile(graph) },
        reviewer: {
          provenance: REV_PROV,
          verdict: blockingVerdict("criterion-x"),
          recheck: KEEP_BLOCKER,
        },
      },
    });
    const ectx = makeEventContext(graph.dir);
    captureErrors();
    try {
      await drive(mock, ectx.ctx, 2);

      const enforced = (await toolText(mock, "workgraph_status", { id: high }, graph.dir)).split("\n");
      expect(enforced).toContain(
        "Gates: review=enforce tree-binding=enforce check=enforce criteria-evidence=enforce weakened-tests=enforce unproven-tests=enforce scope=enforce",
      );
      expect(enforced).toContain(
        "Gate review: violation, blocked (enforce, attempt 1): reject blocking=1 advisory=0: criterion-x",
      );

      const observed = (await toolText(mock, "workgraph_status", { id: low }, graph.dir)).split("\n");
      expect(observed).toContain(
        "Gates: review=observe tree-binding=observe check=enforce criteria-evidence=observe weakened-tests=observe unproven-tests=observe scope=observe",
      );
      expect(observed).toContain(
        "Gate review: violation, would block (observe, attempt 1): reject blocking=1 advisory=0: criterion-x",
      );

      // A legacy issue has no tier: medium's modes, and no results yet.
      const untiered = (await toolText(mock, "workgraph_status", { id: legacy }, graph.dir)).split("\n");
      expect(untiered.filter((line) => line.startsWith("Gates: "))).toEqual([
        "Gates: review=enforce tree-binding=enforce check=enforce criteria-evidence=enforce weakened-tests=enforce unproven-tests=enforce scope=enforce",
      ]);
      expect(untiered.filter((line) => line.startsWith("Gate "))).toEqual([]);

      // The tools read the policy the user configured, not the defaults.
      mock.setFlag("workgraph-policy", JSON.stringify({ low: { gates: { review: "off", scope: "off" } } }));
      const configured = await toolText(mock, "workgraph_status", { id: low }, graph.dir);
      expect(configured).toContain("Gates: review=off tree-binding=observe check=enforce");
      expect(configured).toContain("scope=off");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// an invalid policy
// ---------------------------------------------------------------------------

describe("an invalid policy", () => {
  /** A coordinator wired the way index.ts wires it: config resolved from flags on every call. */
  function makeFlagHarness(): Harness {
    const mock = makeMockPi();
    mock.setFlag("workgraph-worker-id", WORKER);
    mock.setFlag("workgraph-discovery-timeout-ms", "40");
    mock.setFlag("workgraph-accept-timeout-ms", "150");
    mock.setFlag("workgraph-compat-in-session-executor", "false");
    setWorkerIdOverride(WORKER);
    registerWorkgraphTools(asExtensionAPI(mock));
    const coordinator = registerCoordinator(asExtensionAPI(mock), {
      getConfig: () => resolveConfig(asExtensionAPI(mock)),
    });
    return { mock, coordinator };
  }

  const REMOVED_KEY =
    'policy.medium.gateMode was replaced by policy.medium.gates.review ("advisory" is "observe", "blocking" is "enforce")';

  it("a tick claims nothing and the skip log names the bad key, once; dispatch resumes when it is fixed", async () => {
    const previousEnv = process.env.WORKGRAPH_POLICY;
    delete process.env.WORKGRAPH_POLICY;
    const graph = makeScratchRepo({ prefix: "gmbad", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeFlagHarness();
    mock.setFlag("workgraph-policy", JSON.stringify({ medium: { gateMode: "blocking" } }));
    const fake = installFakeExecutor(mock.events, {
      workspace: isolatedIn(graph),
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    const logged = captureErrors();
    try {
      await drive(mock, ectx.ctx, 2);

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("open");
      expect(shown.assignee ?? "").toBe("");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(fake.requests).toEqual([]);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(coordinator.current()).toBeNull();
      // Two ticks, one line: the reason is logged once, not per tick.
      expect(logged().filter((line) => line.includes("policy."))).toEqual([
        `[pi-workgraph] coordinator skipping: ${REMOVED_KEY} (set by workgraph-policy/WORKGRAPH_POLICY)`,
      ]);

      // The tools refuse too, with the same message: nothing reports a
      // policy that did not validate.
      await expect(toolText(mock, "workgraph_status", { id }, graph.dir)).rejects.toThrow(REMOVED_KEY);

      // Fixed: the very next tick dispatches.
      mock.setFlag("workgraph-policy", JSON.stringify({ medium: { gates: { review: "enforce" } } }));
      await drive(mock, ectx.ctx);
      expect(graph.showIssue(id).status).toBe("closed");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
      if (previousEnv !== undefined) process.env.WORKGRAPH_POLICY = previousEnv;
    }
  }, 60_000);

  it("session start and teardown do not throw: the poll timer still starts, so every tick can report the key", async () => {
    const previousEnv = process.env.WORKGRAPH_POLICY;
    delete process.env.WORKGRAPH_POLICY;
    const graph = makeScratchGraph({ prefix: "gmbadss", seed: 1 });
    const { mock, coordinator } = makeFlagHarness();
    mock.setFlag("workgraph-policy", JSON.stringify({ urgent: {} }));
    const ectx = makeEventContext(graph.dir);
    const logged = captureErrors();
    try {
      await mock.emit("session_start", { type: "session_start" }, ectx.ctx);
      expect(coordinator.timersActive().poll).toBe(true);
      expect(logged().some((line) => line.includes("policy.urgent is not a risk tier"))).toBe(true);
      await expect(coordinator.teardown(ectx.ctx)).resolves.toBeUndefined();
      expect(coordinator.timersActive().poll).toBe(false);
    } finally {
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
      if (previousEnv !== undefined) process.env.WORKGRAPH_POLICY = previousEnv;
    }
  }, 30_000);

  it("wired by index.ts: every session handler still runs, and only dispatch stops", async () => {
    const previousEnv = process.env.WORKGRAPH_POLICY;
    delete process.env.WORKGRAPH_POLICY;
    const graph = makeScratchRepo({ prefix: "gmbadidx", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const mock = makeMockPi();
    // The whole extension: tools, adapters, coordinator, sweep, compaction.
    piWorkgraph(asExtensionAPI(mock));
    mock.setFlag("workgraph-worker-id", WORKER);
    mock.setFlag("workgraph-discovery-timeout-ms", "40");
    mock.setFlag("workgraph-accept-timeout-ms", "150");
    mock.setFlag("workgraph-compat-in-session-executor", "false");
    mock.setFlag("workgraph-policy", JSON.stringify({ medium: { gates: { chekc: "observe" } } }));
    const fake = installFakeExecutor(mock.events, {
      workspace: isolatedIn(graph),
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    const logged = captureErrors();
    let started = false;
    try {
      // `emit` awaits every handler in turn, so one that threw would reject
      // here: store setup, tiers, the bridge gate, the coordinator's timer
      // and reconciliation, the sweep's timer, the identity wiring.
      await expect(
        mock.emit("session_start", { type: "session_start" }, ectx.ctx),
      ).resolves.toBeDefined();
      started = true;

      await drive(mock, ectx.ctx);
      expect(graph.showIssue(id).status).toBe("open");
      expect(fake.requests).toEqual([]);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(logged().some((line) => line.includes("policy.medium.gates.chekc is not a gate"))).toBe(true);

      // Fixed mid-session: the next tick dispatches and the work closes.
      mock.setFlag("workgraph-policy", undefined);
      await drive(mock, ectx.ctx);
      expect(graph.showIssue(id).status).toBe("closed");
    } finally {
      fake.uninstall();
      // Clears the poll and sweep timers; must not throw either.
      if (started) await mock.emit("session_shutdown", { type: "session_shutdown" }, ectx.ctx);
      graph.cleanup();
      if (previousEnv !== undefined) process.env.WORKGRAPH_POLICY = previousEnv;
    }
  }, 60_000);

  it("a policy that breaks mid-run stops judgment but not the heartbeat, the completion, or the release", async () => {
    const graph = makeScratchRepo({ prefix: "gmbadmid", seed: 2 });
    const [id, waiting] = graph.seededIds as [string, string];
    approve(graph, id);
    approve(graph, waiting);
    const mock = makeMockPi();
    const config = shippedConfig({ workerIdOverride: WORKER });
    let broken = false;
    let clock = Date.now();
    setWorkerIdOverride(WORKER);
    const coordinator = registerCoordinator(asExtensionAPI(mock), {
      getConfig: () => {
        if (broken) throw new PolicyConfigError("policy.medium.gates.chekc is not a gate");
        return config;
      },
      now: () => clock,
    });
    const fake = installFakeExecutor(mock.events, {
      workspace: isolatedIn(graph),
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { behavior: "accept-stall", provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    const logged = captureErrors();
    try {
      // Claimed and accepted under a valid policy; the implementation stalls.
      await drive(mock, ectx.ctx);
      expect(coordinator.current()?.phase).toBe("accepted");
      const before = Date.parse(leaseExpiresAtOf(graph.showIssue(id))!);

      broken = true;
      clock += 60_000;

      // The heartbeat still renews the lease it holds.
      await expect(coordinator.beat(ectx.ctx)).resolves.toBeUndefined();
      const after = Date.parse(leaseExpiresAtOf(graph.showIssue(id))!);
      expect(after - before).toBe(60_000);

      // The implementation completes: recorded, moved to judging, and
      // parked there. No review is requested and nothing closes.
      fake.complete();
      await mock.flushEvents();
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("judging");
      expect(graph.showIssue(id).status).toBe("in_progress");
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      expect(await verdictCount(graph.dir, id)).toBe(0);
      expect(heldLeases(graph.dir)).toHaveLength(1);

      // And nothing new is claimed.
      await drive(mock, ectx.ctx);
      expect(graph.showIssue(waiting).status).toBe("open");
      expect(logged().filter((line) => line.includes("chekc")).length).toBeGreaterThan(0);

      // Teardown releases the held lease instead of throwing.
      await expect(coordinator.teardown(ectx.ctx)).resolves.toBeUndefined();
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(graph.showIssue(id).assignee ?? "").toBe("");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the shared test config every other suite runs on
// ---------------------------------------------------------------------------

describe("shared test config", () => {
  const TIERS = ["low", "medium", "high"] as const;
  const NOT_REVIEW = GATES.filter((gate) => gate !== "review");

  it("preProofConfig turns the six gates without behavior off and leaves review at its tier default", () => {
    const config = preProofConfig();
    for (const tier of TIERS) {
      const policy = resolvePolicy(tier, config.policy);
      expect(policy.gates.review, `${tier} review`).toBe(DEFAULT_POLICY[tier].gates.review);
      for (const gate of NOT_REVIEW) expect(policy.gates[gate], `${tier} ${gate}`).toBe("off");
    }
  });

  it("a suite's policy override merges over the pin per tier and per gate instead of replacing it", () => {
    const base = preProofConfig({ workerIdOverride: "w" });
    // The harness shape: spread the suite config, then the case's overrides.
    const config = preProofConfig({
      ...base,
      policy: { high: { maxRevisions: 1, gates: { review: "observe" } } },
    });
    const high = resolvePolicy("high", config.policy);
    expect(high.maxRevisions).toBe(1);
    expect(high.gates.review).toBe("observe");
    for (const gate of NOT_REVIEW) expect(high.gates[gate], gate).toBe("off");
    // The tiers the override did not name keep the pin too.
    for (const gate of NOT_REVIEW) {
      expect(resolvePolicy("medium", config.policy).gates[gate], gate).toBe("off");
    }
    expect(config.workerIdOverride).toBe("w");
    // Re-applying it changes nothing, and the shared pin was not mutated.
    expect(preProofConfig(config)).toEqual(config);
    expect(PRE_PROOF_POLICY.high?.maxRevisions).toBeUndefined();
    expect(PRE_PROOF_POLICY.high?.gates?.review).toBeUndefined();
  });

  it("shippedConfig adds no policy of its own", () => {
    expect(shippedConfig().policy).toBeUndefined();
    expect(shippedConfig({ policy: { low: {} } }).policy).toEqual({ low: {} });
  });
});

// ---------------------------------------------------------------------------
// documentation
// ---------------------------------------------------------------------------

describe("README", () => {
  const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");

  /** A boolean, so a failure prints the missing name, not the whole README. */
  const mentions = (name: string): boolean => readme.includes(`\`${name}\``);

  it("names every gate in backticks", () => {
    for (const gate of GATES) expect(mentions(gate), gate).toBe(true);
  });

  it("documents the three modes, the removed gateMode key, and the report tool", () => {
    for (const mode of MODES) expect(mentions(mode), mode).toBe(true);
    expect(mentions("gateMode"), "gateMode").toBe(true);
    expect(mentions("workgraph_gates"), "workgraph_gates").toBe(true);
  });
});
