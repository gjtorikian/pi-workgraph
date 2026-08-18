/**
 * The lifecycle and judgment gate (spec-phase-3): guarded phase
 * transitions, the policy/independence table, failure fingerprints, and
 * the coordinator's full judgment loop driven through the per-role
 * scriptable fake executor — clean accept, same-author rejection,
 * fingerprint escalation, revision rounds, revision bounds, and advisory
 * tiers — plus the approved-only claiming rule the gate rests on.
 *
 * Timer discipline follows the repo convention (no fake timers anywhere):
 * huge poll/heartbeat intervals so timers never fire mid-test, tiny REAL
 * discovery/accept timeouts, event-driven ticks via `agent_settled`, and
 * mock-pi's `flushEvents()` draining the completion handler's promise —
 * which spans the whole judgment chain by construction.
 *
 * Run via `npm run test:judgment`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bindExec, listComments, getExecLog, resetExecLog } from "../src/bd.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import {
  escalate,
  LifecycleError,
  lifecycleVersionOf,
  phaseOf,
  transition,
} from "../src/lifecycle.ts";
import {
  checkIndependence,
  DEFAULT_POLICY,
  resolvePolicy,
} from "../src/policy.ts";
import {
  artifactDigest,
  canonicalFindings,
  failureFingerprint,
  MAX_SUMMARY_CHARS,
  parseVerdict,
  TRUNCATION_MARKER,
  VerdictError,
  verdictSummary,
} from "../src/verdict.ts";
import {
  WORKGRAPH_ATTEMPT_KEY,
  WORKGRAPH_LAST_VERDICT_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_WORKFLOW_CLASS_KEY,
  type VerdictT,
} from "../src/types.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "judgment-test-worker";

/** Huge scheduling timers (event-driven ticks only), tiny REAL protocol
 *  timeouts (bounded discovery/accept waits resolve fast). */
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

/** Distinct author/reviewer provenance — independent under every policy. */
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };

const CLEAN_VERDICT: VerdictT = { findings: [] };

function blockingVerdict(criterion: string): VerdictT {
  return {
    findings: [{ criterion, severity: "blocking", note: "does not hold" }],
  };
}

function advisoryVerdict(criterion: string): VerdictT {
  return {
    findings: [{ criterion, severity: "advisory", note: "could be tighter" }],
  };
}

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

/** Approve an issue the way workgraph_approve does, from outside this
 *  process (setup writes go through scratch's synchronous bd). */
function approve(
  graph: ScratchGraph,
  id: string,
  opts: {
    riskTier?: string;
    acceptance?: string;
    workflowClass?: "oneshot" | "reviewed" | "planned";
  } = {},
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
    "--set-metadata",
    `workgraph_workflow_class=${opts.workflowClass ?? "reviewed"}`,
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

async function verdictCount(dir: string, id: string): Promise<number> {
  const comments = await listComments(dir, id);
  return comments.filter((c) => c.text.startsWith("workgraph-verdict verdict "))
    .length;
}

afterEach(() => {
  resetLeasesForTest();
  resetIdentityForTest();
});

// ---------------------------------------------------------------------------
// lifecycle: the transition table
// ---------------------------------------------------------------------------

describe("lifecycle transitions", () => {
  it("walks every legal edge, stamping lifecycle v1 lazily at the entry edges", async () => {
    const mock = makeMockPi();
    bindExec((command, args, options) => mock.exec(command, args, options));
    const graph = makeScratchGraph({ prefix: "lcwalk" });
    try {
      // Legacy entry: <none> → ready stamps v1 (workgraph_approve's edge).
      const id = graph.createIssue("full lifecycle walk");
      expect(lifecycleVersionOf(graph.showIssue(id))).toBeUndefined();
      await transition(graph.dir, id, undefined, "ready");
      let shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("ready");
      expect(lifecycleVersionOf(shown)).toBe(1);

      // The full happy path plus the revision cycle, edge by edge.
      const walk: [
        expect: Parameters<typeof transition>[2],
        to: Parameters<typeof transition>[3],
      ][] = [
        ["ready", "implementing"],
        ["implementing", "judging"],
        ["judging", "revising"],
        ["revising", "revising"], // new execution accepted
        ["revising", "judging"], // implementation completed
        ["judging", "verifying"],
        ["verifying", "accepted"],
      ];
      for (const [from, to] of walk) {
        await transition(graph.dir, id, from, to);
        expect(phaseOf(graph.showIssue(id)), `${from} → ${to}`).toBe(to);
      }

      // Companion fields ride the SAME write as the phase.
      const second = graph.createIssue("draft entry");
      graph.bd(["update", second, "--set-metadata", "workgraph_phase=draft"]);
      await transition(graph.dir, second, "draft", "ready", {
        fields: { workgraph_risk_tier: "high" },
      });
      shown = graph.showIssue(second);
      expect(phaseOf(shown)).toBe("ready");
      expect(lifecycleVersionOf(shown)).toBe(1); // draft entry stamps v1 too
      expect(shown.metadata?.workgraph_risk_tier).toBe("high");
    } finally {
      graph.cleanup();
    }
  }, 60_000);

  it("throws LifecycleError on every illegal edge", async () => {
    const mock = makeMockPi();
    bindExec((command, args, options) => mock.exec(command, args, options));
    const graph = makeScratchGraph({ prefix: "lcbad" });
    try {
      const id = graph.createIssue("illegal edges");
      graph.bd([
        "update",
        id,
        "--set-metadata",
        "workgraph_lifecycle_version=1",
        "--set-metadata",
        "workgraph_phase=implementing",
      ]);
      // implementing → accepted skips the whole gate.
      await expect(
        transition(graph.dir, id, "implementing", "accepted"),
      ).rejects.toThrow(LifecycleError);
      // judging → accepted skips verification.
      graph.bd(["update", id, "--set-metadata", "workgraph_phase=judging"]);
      await expect(
        transition(graph.dir, id, "judging", "accepted"),
      ).rejects.toThrow(LifecycleError);
      // accepted is terminal as a phase (close is a status change).
      graph.bd(["update", id, "--set-metadata", "workgraph_phase=accepted"]);
      await expect(
        transition(graph.dir, id, "accepted", "ready"),
      ).rejects.toThrow(LifecycleError);
      // A LEGACY issue can only enter at ready (approve) or implementing
      // (compat claim), never mid-lifecycle.
      const legacy = graph.createIssue("legacy mid-entry");
      await expect(
        transition(graph.dir, legacy, undefined, "judging"),
      ).rejects.toThrow(LifecycleError);
      // Nothing above wrote a phase to the legacy issue.
      expect(phaseOf(graph.showIssue(legacy))).toBeUndefined();
    } finally {
      graph.cleanup();
    }
  }, 60_000);

  it("loses the compare-and-set race: a stale expect throws and writes nothing", async () => {
    const mock = makeMockPi();
    bindExec((command, args, options) => mock.exec(command, args, options));
    const graph = makeScratchGraph({ prefix: "lccas" });
    try {
      const id = graph.createIssue("raced transition");
      graph.bd([
        "update",
        id,
        "--set-metadata",
        "workgraph_lifecycle_version=1",
        "--set-metadata",
        "workgraph_phase=judging", // a concurrent writer got here first
      ]);
      await expect(
        transition(graph.dir, id, "implementing", "judging"),
      ).rejects.toThrow(LifecycleError);
      // No partial metadata landed.
      expect(phaseOf(graph.showIssue(id))).toBe("judging");
      expect(metadataOf(graph, id)[WORKGRAPH_ATTEMPT_KEY]).toBeUndefined();
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("escalate() is guarded to active phases with the same CAS discipline", async () => {
    const mock = makeMockPi();
    bindExec((command, args, options) => mock.exec(command, args, options));
    const graph = makeScratchGraph({ prefix: "lcesc" });
    try {
      const id = graph.createIssue("escalation");
      graph.bd([
        "update",
        id,
        "--set-metadata",
        "workgraph_lifecycle_version=1",
        "--set-metadata",
        "workgraph_phase=judging",
      ]);
      await escalate(graph.dir, id, "judging");
      expect(phaseOf(graph.showIssue(id))).toBe("escalated");
      // Escalated is terminal: the stale expect now loses the CAS.
      await expect(escalate(graph.dir, id, "judging")).rejects.toThrow(
        LifecycleError,
      );
      // Non-active phases never escalate at all (a runtime guard — the
      // type admits any phase).
      await expect(escalate(graph.dir, id, "accepted")).rejects.toThrow(
        LifecycleError,
      );
    } finally {
      graph.cleanup();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// policy: gate modes, independence, fingerprints
// ---------------------------------------------------------------------------

describe("policy and independence", () => {
  it("resolvePolicy: tier defaults, per-knob merge, conservative fallback", () => {
    expect(resolvePolicy("low")).toEqual(DEFAULT_POLICY.low);
    expect(resolvePolicy("low").gateMode).toBe("advisory");
    expect(resolvePolicy("medium").gateMode).toBe("blocking");
    expect(resolvePolicy("high").requireAuthorIndependence).toEqual({
      model: true,
      provider: true,
    });
    // Unknown/missing tier falls back to medium (blocking — conservative).
    expect(resolvePolicy(undefined).gateMode).toBe("blocking");
    expect(resolvePolicy("bogus").gateMode).toBe("blocking");
    // A partial override changes ONE knob and drops none.
    const merged = resolvePolicy("high", { high: { maxRevisions: 1 } });
    expect(merged.maxRevisions).toBe(1);
    expect(merged.gateMode).toBe("blocking");
    expect(merged.requireAuthorIndependence).toEqual({
      model: true,
      provider: true,
    });
  });

  it("checkIndependence fails closed and floors on executionId equality", () => {
    const blocking = resolvePolicy("medium");
    const advisory = resolvePolicy("low");
    // Same model+provider under a requiring policy → non-independent.
    expect(
      checkIndependence({ author: IMPL_PROV, reviewer: IMPL_PROV }, blocking)
        .independent,
    ).toBe(false);
    // Differing on every required axis → independent.
    expect(
      checkIndependence({ author: IMPL_PROV, reviewer: REV_PROV }, blocking)
        .independent,
    ).toBe(true);
    expect(
      checkIndependence(
        {
          author: IMPL_PROV,
          reviewer: { ...REV_PROV, provider: IMPL_PROV.provider },
        },
        blocking,
      ).independent,
    ).toBe(false);
    expect(
      checkIndependence(
        {
          author: IMPL_PROV,
          reviewer: { ...REV_PROV, model: IMPL_PROV.model },
        },
        blocking,
      ).independent,
    ).toBe(false);
    // FAIL CLOSED: missing provenance on a required axis counts as a match.
    expect(
      checkIndependence(
        { author: IMPL_PROV, reviewer: { harness: "fake" } },
        blocking,
      ).independent,
    ).toBe(false);
    expect(
      checkIndependence({ author: undefined, reviewer: undefined }, blocking)
        .independent,
    ).toBe(false);
    // No requirement (low tier) → provenance is not consulted…
    expect(
      checkIndependence({ author: IMPL_PROV, reviewer: IMPL_PROV }, advisory)
        .independent,
    ).toBe(true);
    // …but the executionId floor applies under EVERY policy.
    expect(
      checkIndependence(
        {
          author: IMPL_PROV,
          reviewer: REV_PROV,
          authorExecutionId: "exec-1",
          reviewerExecutionId: "exec-1",
        },
        advisory,
      ).independent,
    ).toBe(false);
  });

  it("failure fingerprints canonicalize findings and track the artifact digest", () => {
    const a = { criterion: "b-crit", severity: "blocking" as const };
    const b = { criterion: "a-crit", severity: "blocking" as const };
    const digest = artifactDigest(["src/x.ts", "src/y.ts"]);
    // Order-insensitive: canonicalization sorts by criterion+severity.
    expect(failureFingerprint([a, b], digest)).toBe(
      failureFingerprint([b, a], digest),
    );
    expect(artifactDigest(["src/y.ts", "src/x.ts"])).toBe(digest);
    // Different findings or a different artifact digest change the print.
    expect(failureFingerprint([a], digest)).not.toBe(
      failureFingerprint([a, b], digest),
    );
    expect(failureFingerprint([a], digest)).not.toBe(
      failureFingerprint([a], artifactDigest(["src/z.ts"])),
    );
    // The degenerate-but-deliberate case: empty artifact lists digest to a
    // constant, so identical findings on empty artifacts repeat exactly.
    expect(failureFingerprint([a], artifactDigest([]))).toBe(
      failureFingerprint([a], artifactDigest([])),
    );
  });

  it("parseVerdict rejects malformed payloads; summaries and evidence are capped", () => {
    expect(() => parseVerdict(undefined)).toThrow(VerdictError);
    expect(() => parseVerdict({ findings: "nope" })).toThrow(VerdictError);
    expect(() =>
      parseVerdict({ findings: [{ criterion: "x", severity: "fatal" }] }),
    ).toThrow(VerdictError);
    const ok = parseVerdict(blockingVerdict("criterion-x"));
    expect(ok.findings).toHaveLength(1);

    const huge = "e".repeat(5_000);
    const capped = canonicalFindings([
      { criterion: "c", severity: "advisory", evidence: huge },
    ]);
    expect(capped[0]!.evidence!.length).toBeLessThan(huge.length);
    expect(capped[0]!.evidence!.endsWith(TRUNCATION_MARKER)).toBe(true);

    const summary = verdictSummary({
      findings: [
        {
          criterion: "c".repeat(500),
          severity: "blocking",
        },
      ],
    });
    expect(summary.startsWith("reject blocking=1 advisory=0")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(
      MAX_SUMMARY_CHARS + TRUNCATION_MARKER.length,
    );
    expect(verdictSummary(CLEAN_VERDICT)).toBe("pass blocking=0 advisory=0");
  });
});

// ---------------------------------------------------------------------------
// the judgment gate, end to end
// ---------------------------------------------------------------------------

describe("judgment gate flows", () => {
  it("a clean independent verdict verifies, accepts, and closes the issue", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "jgok", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id, { acceptance: "does the thing" });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, artifacts: ["src/thing.ts"] },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("closed");
      const metadata = metadataOf(graph, id);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("accepted");
      expect(String(metadata[WORKGRAPH_LAST_VERDICT_KEY])).toMatch(/^pass/);
      // The reviewer saw the acceptance criteria and the artifacts.
      const review = fake.requests.find((r) => r.role === "reviewer")!;
      expect(review.issue.acceptanceCriteria).toBe("does the thing");
      expect(
        (review as typeof review & { artifacts?: string[] }).artifacts,
      ).toEqual(["src/thing.ts"]);
      // Verdict persisted; close audited; nothing left held or supervised.
      expect(await verdictCount(graph.dir, id)).toBe(1);
      expect(await auditCount(graph.dir, id, "judgment-closed")).toBe(1);
      expect(heldLeases(graph.dir)).toHaveLength(0);
      expect(coordinator.current()).toBeNull();
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("a same-author review is rejected as non-independent; nobody else offers → escalated", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "jgsa", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id); // medium: independence required
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        // The "review" comes from the SAME model+provider as the author.
        reviewer: { provenance: IMPL_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("blocked");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      expect(await auditCount(graph.dir, id, "review-rejected")).toBe(1);
      expect(await auditCount(graph.dir, id, "escalated")).toBe(1);
      // The non-independent verdict was never persisted as judgment.
      expect(await verdictCount(graph.dir, id)).toBe(0);
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("two identical blocking verdicts promote reviewed work to planned — no third revision", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "jgfp", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        revision: { provenance: IMPL_PROV }, // artifacts stay [] — same digest
        // A single script repeats: byte-identical blocking verdict each round.
        reviewer: {
          provenance: REV_PROV,
          verdict: blockingVerdict("criterion-x"),
        },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("open");
      const metadata = metadataOf(graph, id);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(metadata[WORKGRAPH_WORKFLOW_CLASS_KEY]).toBe("planned");
      // Exactly ONE revision ran (the repeat escalated instead of a second).
      expect(await auditCount(graph.dir, id, "revision-requested")).toBe(1);
      // The promoted planned workflow starts a fresh attempt sequence.
      expect(Number(metadata[WORKGRAPH_ATTEMPT_KEY])).toBe(1);
      // Both verdicts were persisted before the gate decided.
      expect(await verdictCount(graph.dir, id)).toBe(2);
      expect(await auditCount(graph.dir, id, "workflow-promoted")).toBe(1);
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("blocking findings then a clean verdict: revising → judging → accepted and closed", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "jgrev", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        revision: { provenance: IMPL_PROV, artifacts: ["src/fixed.ts"] },
        reviewer: [
          { provenance: REV_PROV, verdict: blockingVerdict("criterion-x") },
          { provenance: REV_PROV, verdict: CLEAN_VERDICT },
        ],
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("closed");
      const metadata = metadataOf(graph, id);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("accepted");
      expect(Number(metadata[WORKGRAPH_ATTEMPT_KEY])).toBe(2);
      expect(String(metadata[WORKGRAPH_LAST_VERDICT_KEY])).toMatch(/^pass/);
      expect(await auditCount(graph.dir, id, "revision-requested")).toBe(1);
      expect(await verdictCount(graph.dir, id)).toBe(2);
      // The revision request carried the structured findings, serialized
      // one canonical-JSON finding per entry (protocol v1's string array).
      const revision = fake.requests.find((r) => r.role === "revision")!;
      expect(revision.priorFindings).toHaveLength(1);
      expect(JSON.parse(revision.priorFindings![0]!)).toMatchObject({
        criterion: "criterion-x",
        severity: "blocking",
      });
      expect(revision.attempt).toBe(2);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("maxRevisions exhausted promotes reviewed work to planned", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "jgmax", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id, { riskTier: "high" });
    const { mock, coordinator } = makeHarness({
      policy: { high: { maxRevisions: 1 } },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        revision: { provenance: IMPL_PROV, artifacts: ["src/attempt2.ts"] },
        // DIFFERENT criteria each round: the fingerprint changes, so the
        // revision BOUND (not the fingerprint) is what escalates.
        reviewer: [
          { provenance: REV_PROV, verdict: blockingVerdict("criterion-a") },
          { provenance: REV_PROV, verdict: blockingVerdict("criterion-b") },
        ],
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("open");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(metadataOf(graph, id)[WORKGRAPH_WORKFLOW_CLASS_KEY]).toBe(
        "planned",
      );
      expect(await auditCount(graph.dir, id, "revision-requested")).toBe(1);
      expect(await auditCount(graph.dir, id, "workflow-promoted")).toBe(1);
      expect(await verdictCount(graph.dir, id)).toBe(2);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("advisory findings on a low tier pass the gate and are persisted anyway", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "jgadv", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id, { riskTier: "low" });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      roleScripts: {
        // Low tier: no independence requirement — the default bare
        // provenance is fine (the executionId floor still applies).
        reviewer: { verdict: advisoryVerdict("style-nit") },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("closed");
      const metadata = metadataOf(graph, id);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("accepted");
      expect(String(metadata[WORKGRAPH_LAST_VERDICT_KEY])).toContain(
        "advisory=1",
      );
      // Advisory findings are persisted even when continuation is allowed.
      const comments = await listComments(graph.dir, id);
      const verdicts = comments.filter((c) =>
        c.text.startsWith("workgraph-verdict verdict "),
      );
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]!.text).toContain("style-nit");
      expect(await auditCount(graph.dir, id, "revision-requested")).toBe(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("low-risk one-shot work verifies and closes without requesting review", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "jgones", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id, { riskTier: "low", workflowClass: "oneshot" });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      roleScripts: { implementer: { provenance: IMPL_PROV } },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      expect(fake.requests[0]!.issue.workflowClass).toBe("oneshot");
      expect(graph.showIssue(id).status).toBe("closed");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("accepted");
      expect(await auditCount(graph.dir, id, "oneshot-closed")).toBe(1);
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("failed one-shot work is promoted to reviewed and returned ready", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "jgprom", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id, { riskTier: "low", workflowClass: "oneshot" });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, outcome: "failure" },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("open");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(metadataOf(graph, id)[WORKGRAPH_WORKFLOW_CLASS_KEY]).toBe(
        "reviewed",
      );
      expect(await auditCount(graph.dir, id, "workflow-promoted")).toBe(1);
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// approved-only claiming (what the gate rests on)
// ---------------------------------------------------------------------------

describe("approved-only claiming", () => {
  it("legacy issues are skipped by default — no claim without the compat opt-in", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "jgleg", seed: 1 });
    const { mock, coordinator } = makeHarness(); // compatLegacyIssues unset → false
    const fake = installFakeExecutor(mock.events, { behavior: "accept-complete" });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(coordinator.current()).toBeNull();
      expect(heldLeases(graph.dir)).toHaveLength(0);
      const shown = graph.showIssue(graph.seededIds[0]!);
      expect(shown.status).toBe("open");
      expect(shown.assignee ?? "").toBe("");
      const log = getExecLog();
      expect(log.some((e) => e.args.includes("--claim"))).toBe(false);
      expect(log.some((e) => e.args[0] === "ready")).toBe(true);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("approved issues are claimed atomically BY ID (update --claim), lifecycle stamped in one write", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "jgapv", seed: 2 });
    const approved = graph.seededIds[1]!;
    approve(graph, approved); // the other seed stays legacy
    const { mock, coordinator } = makeHarness();
    // Implementer-only: the run parks in judging (the default production
    // path until phase 5) — which is exactly the state we assert.
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      roleScripts: { implementer: { provenance: IMPL_PROV } },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      // The APPROVED issue was claimed; the legacy one was left alone.
      const shown = graph.showIssue(approved);
      expect(shown.status).toBe("in_progress");
      const metadata = metadataOf(graph, approved);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("judging");
      expect(Number(metadata[WORKGRAPH_ATTEMPT_KEY])).toBe(1);
      expect(graph.showIssue(graph.seededIds[0]!).status).toBe("open");

      // Claim-by-id: atomic `update <id> --claim`, zero bare assignee writes.
      const log = getExecLog();
      const claims = log.filter((e) => e.args.includes("--claim"));
      expect(claims).toHaveLength(1);
      expect(claims[0]!.args[0]).toBe("update");
      expect(claims[0]!.args[1]).toBe(approved);
      expect(log.some((e) => e.args.includes("--assignee"))).toBe(false);

      // Parked in judging with the lease heartbeat-held until shutdown.
      expect(heldLeases(graph.dir)).toHaveLength(1);
      expect(coordinator.current()?.phase).toBe("judging");
      await coordinator.teardown(ectx.ctx);
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);
});
