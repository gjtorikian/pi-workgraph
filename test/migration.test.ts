/**
 * Migration + packaging (spec-phase-6): the lazy, non-destructive legacy
 * path as a unit — legacy visibility under the default and under the
 * `compatLegacyIssues` opt-in, the once-per-session compat warning, v0.1
 * lease respect (live leases are never claimed, expired ones are migrated
 * over), metadata preservation on stamping, the CAS-throw idempotency
 * contract of the migration entry — plus the subpath-export smoke tests
 * (`pi-workgraph/protocol` and the two adapter subpaths resolve through
 * the package export map via Node's package self-reference).
 *
 * Timer discipline follows the repo convention (no fake timers anywhere):
 * huge poll/heartbeat intervals so timers never fire mid-test, tiny REAL
 * discovery/accept timeouts, event-driven ticks via `agent_settled`.
 *
 * Run via `npm run test:migration`.
 */
import { describe, expect, it } from "vitest";
import { bindExec, getExecLog, resetExecLog } from "../src/bd.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import {
  heldLeases,
  leaseEpochOf,
  leaseHolderOf,
  resetLeasesForTest,
  rfc3339,
} from "../src/lease.ts";
import {
  LifecycleError,
  lifecycleVersionOf,
  phaseOf,
  transition,
} from "../src/lifecycle.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "migration-test-worker";

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

const COMPAT_WARNING_MARKER = "workgraph-compat-legacy-issues is enabled";

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
  config: WorkgraphConfig;
  /** Everything the coordinator warned, in order (the injectable sink). */
  warnings: string[];
}

function makeHarness(overrides: Partial<WorkgraphConfig> = {}): Harness {
  const mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  const config: WorkgraphConfig = { ...CONFIG, ...overrides };
  setWorkerIdOverride(WORKER);
  const warnings: string[] = [];
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
    warn: (message) => warnings.push(message),
  });
  return { mock, coordinator, config, warnings };
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

/** The metadata snapshot minus the `workgraph_*` keys stamping adds — the
 *  preservation assertion compares bd-normalized (JSON-typed) values on
 *  both sides, tolerating bd's numeric round-trip. */
function withoutWorkgraphKeys(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !key.startsWith("workgraph_")),
  );
}

/** A tools-only mock (approve-path tests drive the real tool handler). */
function makeToolsMock(): MockPi {
  const mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  registerWorkgraphTools(asExtensionAPI(mock));
  mock.setFlag("workgraph-worker-id", WORKER);
  setWorkerIdOverride(WORKER);
  return mock;
}

function runTool(mock: MockPi, name: string, params: unknown, cwd: string) {
  const def = mock.tools.get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def.execute(
    `migration-${name}`,
    params,
    undefined,
    undefined,
    makeToolContext(cwd),
  );
}

// ---------------------------------------------------------------------------
// Legacy visibility + compat dispatch
// ---------------------------------------------------------------------------

describe("legacy visibility and compat dispatch", () => {
  it("default off: the coordinator never claims a legacy issue and never warns (two ticks)", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "migoff", seed: 1 });
    const { mock, coordinator, warnings } = makeHarness(); // compatLegacyIssues unset → false
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      behavior: "accept-complete",
    });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(coordinator.current()).toBeNull();
      expect(heldLeases(graph.dir)).toHaveLength(0);
      const shown = graph.showIssue(graph.seededIds[0]!);
      expect(shown.status).toBe("open");
      expect(lifecycleVersionOf(shown)).toBeUndefined();
      expect(getExecLog().some((e) => e.args.includes("--claim"))).toBe(false);
      expect(warnings).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("workgraph_ready excludes legacy issues by default; legacy: true lists them", async () => {
    const graph = makeScratchGraph({ prefix: "migvis" });
    const mock = makeToolsMock();
    try {
      const legacyId = graph.createIssue("legacy artifact");
      const approvedId = graph.createIssue("approved work");
      await runTool(mock, "workgraph_approve", { id: approvedId }, graph.dir);

      const byDefault = await runTool(mock, "workgraph_ready", {}, graph.dir);
      const defaultText = JSON.stringify(byDefault.content);
      expect(defaultText).toContain(approvedId);
      expect(defaultText).not.toContain(legacyId);

      const legacy = await runTool(
        mock,
        "workgraph_ready",
        { legacy: true },
        graph.dir,
      );
      const legacyText = JSON.stringify(legacy.content);
      expect(legacyText).toContain(legacyId);
      expect(legacyText).not.toContain(approvedId);
    } finally {
      graph.cleanup();
      resetIdentityForTest();
    }
  }, 30_000);

  it("compat on, no executor: warns exactly once across two ticks and claims nothing", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "migwrn", seed: 1 });
    const { mock, coordinator, warnings } = makeHarness({
      compatLegacyIssues: true,
    });
    // NO executor on the bus: the warning fires at eligibility time, before
    // discovery; zero offers then leave the pool untouched (no executor →
    // no claim), so the second tick retraverses the same warn point.
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const compatWarnings = warnings.filter((w) =>
        w.includes(COMPAT_WARNING_MARKER),
      );
      expect(compatWarnings).toHaveLength(1);
      // The warning names the setting and its migration effect.
      expect(compatWarnings[0]).toContain("workgraph-compat-legacy-issues");
      expect(compatWarnings[0]).toContain("lifecycle v1");
      expect(coordinator.current()).toBeNull();
      expect(graph.showIssue(graph.seededIds[0]!).status).toBe("open");
      expect(getExecLog().some((e) => e.args.includes("--claim"))).toBe(false);
    } finally {
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("compat on: the claim lazily migrates — stamps lifecycle v1, enters implementing, preserves pre-existing metadata", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "migclm" });
    const id = graph.createIssue("v0.1-era task");
    // Pre-existing metadata a v0.1 graph might carry: a foreign tooling key
    // and a released-lease epoch (epoch survives release — Convention §2.7).
    graph.bd([
      "update",
      id,
      "--set-metadata",
      "v01_custom=preserved",
      "--set-metadata",
      "lease_epoch=4",
      "--actor",
      "v01-tool",
    ]);
    const { mock, coordinator, warnings } = makeHarness({
      compatLegacyIssues: true,
    });
    // accept-stall: the run parks in implementing — pinning the MIGRATION
    // ENTRY phase (legacy → implementing, never ready) before the normal
    // flow moves on (risk note: only workgraph_approve produces ready).
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      behavior: "accept-stall",
    });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(lifecycleVersionOf(shown)).toBe(1);
      expect(phaseOf(shown)).toBe("implementing");
      const metadata = metadataOf(graph, id);
      expect(metadata["v01_custom"]).toBe("preserved");
      expect(String(metadata["workgraph_workflow_run_id"])).toMatch(
        /^workgraph-run\//,
      );
      expect(Number(metadata["workgraph_attempt"])).toBe(1);
      // The claim bumped the surviving epoch — monotonic, never reset.
      expect(leaseEpochOf(shown)).toBe(5);
      expect(
        warnings.filter((w) => w.includes(COMPAT_WARNING_MARKER)),
      ).toHaveLength(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Lazy migration via workgraph_approve
// ---------------------------------------------------------------------------

describe("lazy migration via workgraph_approve", () => {
  it("approve on a legacy issue stamps v1 + ready + risk tier, preserving every pre-existing metadata key", async () => {
    const graph = makeScratchGraph({ prefix: "migapv" });
    const mock = makeToolsMock();
    try {
      const id = graph.createIssue("legacy with history");
      graph.bd([
        "update",
        id,
        "--set-metadata",
        "custom_str=hello world",
        "--set-metadata",
        "custom_num=42",
        "--set-metadata",
        "lease_epoch=7",
        "--actor",
        "v01-tool",
      ]);
      const before = metadataOf(graph, id);

      await runTool(
        mock,
        "workgraph_approve",
        { id, acceptanceCriteria: "all tests green" },
        graph.dir,
      );

      const shown = graph.showIssue(id);
      expect(lifecycleVersionOf(shown)).toBe(1);
      expect(phaseOf(shown)).toBe("ready");
      const after = metadataOf(graph, id);
      expect(after["workgraph_risk_tier"]).toBe("medium");
      // Non-destructive stamping: the snapshot minus the added workgraph_*
      // keys is IDENTICAL to the pre-approval snapshot (both sides read
      // through bd's JSON typing, so numeric round-trips compare equal).
      expect(withoutWorkgraphKeys(after)).toEqual(before);
      expect(shown.acceptance_criteria).toBe("all tests green");
    } finally {
      graph.cleanup();
      resetIdentityForTest();
    }
  }, 30_000);

  it("the migration entry is CAS-safe, not silently repeatable: re-running it throws", async () => {
    const graph = makeScratchGraph({ prefix: "migcas" });
    const mock = makeToolsMock();
    try {
      const id = graph.createIssue("stamp me once");
      await runTool(mock, "workgraph_approve", { id }, graph.dir);
      expect(phaseOf(graph.showIssue(id))).toBe("ready");

      // Direct re-entry from <legacy>: the phase changed underneath
      // `expect: undefined` → LifecycleError, never a second stamp.
      await expect(
        transition(graph.dir, id, undefined, "ready"),
      ).rejects.toThrow(LifecycleError);
      // And the tool guard rejects re-approval of ready work.
      await expect(
        runTool(mock, "workgraph_approve", { id }, graph.dir),
      ).rejects.toThrow(/Cannot approve/);
      // The issue is untouched by either failed re-entry.
      const shown = graph.showIssue(id);
      expect(phaseOf(shown)).toBe("ready");
      expect(lifecycleVersionOf(shown)).toBe(1);
    } finally {
      graph.cleanup();
      resetIdentityForTest();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// v0.1 leases on legacy issues
// ---------------------------------------------------------------------------

describe("v0.1 leases on legacy issues", () => {
  /** Seed the anomaly shape: an OPEN legacy issue carrying live v0.1 lease
   *  keys (crash artifact / manual edit). A realistic in-flight claim is
   *  `in_progress` and invisible to the ready scan (tested separately). */
  function seedOpenLeasedLegacy(graph: ScratchGraph, expiresAt: string): string {
    const id = graph.createIssue("v0.1 leased artifact");
    graph.bd([
      "update",
      id,
      "--set-metadata",
      "lease_holder=v01-worker",
      "--set-metadata",
      "lease_epoch=1",
      "--set-metadata",
      `lease_expires_at=${expiresAt}`,
      "--actor",
      "v01-worker",
    ]);
    return id;
  }

  it("an open legacy issue with a live v0.1 lease is never claimed — even under compat (anomaly shape, guard reads the lease keys)", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "miglv" });
    const id = seedOpenLeasedLegacy(graph, rfc3339(Date.now() + 3_600_000));
    const { mock, coordinator } = makeHarness({ compatLegacyIssues: true });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      behavior: "accept-complete",
    });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(coordinator.current()).toBeNull();
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("open");
      expect(lifecycleVersionOf(shown)).toBeUndefined();
      // The foreign lease is untouched: holder and epoch as v0.1 wrote them.
      expect(leaseHolderOf(shown)).toBe("v01-worker");
      expect(leaseEpochOf(shown)).toBe(1);
      expect(getExecLog().some((e) => e.args.includes("--claim"))).toBe(false);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("the same live-leased legacy issue is equally untouchable with compat off", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "miglvo" });
    const id = seedOpenLeasedLegacy(graph, rfc3339(Date.now() + 3_600_000));
    const { mock, coordinator } = makeHarness(); // compat off
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      behavior: "accept-complete",
    });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(coordinator.current()).toBeNull();
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("open");
      expect(leaseHolderOf(shown)).toBe("v01-worker");
      expect(getExecLog().some((e) => e.args.includes("--claim"))).toBe(false);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("a real v0.1 in-flight claim (in_progress) is invisible to the ready scan under compat", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "migip" });
    const id = graph.createIssue("v0.1 in-flight work");
    graph.bd(["update", id, "--claim", "--actor", "v01-worker"]);
    graph.bd([
      "update",
      id,
      "--set-metadata",
      "lease_holder=v01-worker",
      "--set-metadata",
      "lease_epoch=1",
      "--set-metadata",
      `lease_expires_at=${rfc3339(Date.now() + 3_600_000)}`,
      "--actor",
      "v01-worker",
    ]);
    const { mock, coordinator } = makeHarness({ compatLegacyIssues: true });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      behavior: "accept-complete",
    });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(coordinator.current()).toBeNull();
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(leaseHolderOf(shown)).toBe("v01-worker");
      expect(lifecycleVersionOf(shown)).toBeUndefined();
      expect(getExecLog().some((e) => e.args.includes("--claim"))).toBe(false);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("an unparseable v0.1 lease expiry is treated as leased: skipped and warned once across two ticks", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "miggbg" });
    const id = seedOpenLeasedLegacy(graph, "not-a-timestamp");
    const { mock, coordinator, warnings } = makeHarness({
      compatLegacyIssues: true,
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      behavior: "accept-complete",
    });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      expect(coordinator.current()).toBeNull();
      expect(graph.showIssue(id).status).toBe("open");
      expect(getExecLog().some((e) => e.args.includes("--claim"))).toBe(false);
      const leaseWarnings = warnings.filter((w) =>
        w.includes("unparseable lease_expires_at"),
      );
      expect(leaseWarnings).toHaveLength(1);
      expect(leaseWarnings[0]).toContain(id);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);

  it("an EXPIRED v0.1 lease does not block compat migration — the claim bumps the epoch over it", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "migexp" });
    const id = seedOpenLeasedLegacy(graph, rfc3339(Date.now() - 60_000));
    const { mock, coordinator } = makeHarness({ compatLegacyIssues: true });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      behavior: "accept-stall",
    });
    const ectx = makeEventContext(graph.dir);
    try {
      resetExecLog();
      await settle(mock, ectx.ctx);
      await mock.flushEvents();

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(lifecycleVersionOf(shown)).toBe(1);
      expect(phaseOf(shown)).toBe("implementing");
      expect(leaseHolderOf(shown)).toMatch(/^workgraph-run\//);
      expect(leaseEpochOf(shown)).toBe(2);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Subpath exports (packaging smoke)
// ---------------------------------------------------------------------------

describe("subpath exports (packaging smoke)", () => {
  it("pi-workgraph/protocol subpath imports standalone with working parsers and no extension entry", async () => {
    // Through the package self-reference — this exercises the exports map
    // itself (a relative import here would gut the test's purpose).
    const proto = await import("pi-workgraph/protocol");

    expect(proto.PROTOCOL_VERSION).toBe(1);
    expect(proto.CH.runRequest).toBe("workgraph:v1:run:request");
    expect(proto.CH.offer).toBe("workgraph:v1:executor:offer");

    // Schema parse round-trip: mint an envelope, validate it back in.
    const envelope = proto.newEnvelope();
    const parsed = proto.parseMessage(proto.CH.discover, proto.Discover, {
      ...envelope,
    });
    expect(parsed.messageId).toBe(envelope.messageId);
    expect(() =>
      proto.parseMessage(proto.CH.discover, proto.Discover, {
        protocolVersion: 2,
      }),
    ).toThrow(proto.ProtocolError);

    // No extension side effects: protocol.ts is session-free by contract —
    // it exposes no default export (extension registration lives solely in
    // the root entry's default export) and imports nothing session-bound.
    expect("default" in proto).toBe(false);
  }, 30_000);

  it("adapter subpaths resolve through the export map", async () => {
    const inSession = await import("pi-workgraph/adapters/in-session");
    expect(typeof inSession.registerInSessionExecutor).toBe("function");
    expect(inSession.IN_SESSION_EXECUTOR_ID).toBe("in-session");

    const piSubagents = await import("pi-workgraph/adapters/pi-subagents");
    expect(typeof piSubagents.registerPiSubagentsExecutor).toBe("function");
  }, 30_000);
});
