/**
 * Verdict durability (proof-of-success phase 1): an issue never closes on a
 * verdict that was not written. The rule has no mode — a failed verdict
 * write escalates under `review: observe` exactly as under `enforce` — and
 * it is about verdicts that were ATTEMPTED: with `review: off` no review
 * runs, so there is no verdict to lose.
 *
 * FAILURE INJECTION keeps the real store. `failCommentWrites` installs a
 * trigger on the scratch database that rejects every comment starting with
 * `workgraph-verdict`, so the store's own `addComment` throws for that one
 * write. Everything else still lands — which matters, because the escalation
 * is audited through the same comment surface (`workgraph-lease escalated`)
 * and these tests read that audit back.
 *
 * This suite does not pin `PRE_PROOF_POLICY`: each case sets its `review`
 * mode explicitly and every other gate runs on its shipped default. The
 * `tree-binding` gate enforces at medium risk, so the integration cases run
 * in a real git repository (`makeScratchRepo`) with a fake that reports its
 * workspace — the setup a user's bridged executor has.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import type { GateModeT, PolicyOverrides } from "../src/policy.ts";
import { listGateRecords } from "../src/proof.ts";
import { listComments } from "../src/store.ts";
import {
  WORKGRAPH_LAST_VERDICT_KEY,
  WORKGRAPH_PHASE_KEY,
  type VerdictT,
} from "../src/types.ts";
import { recordVerdict, VerdictWriteError } from "../src/verdict.ts";
import { shippedConfig } from "./helpers/config.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockPi,
} from "./helpers/mock-pi.ts";
import {
  COMMENT_WRITE_FAILURE,
  failCommentWrites,
  makeScratchGraph,
  makeScratchRepo,
  type ScratchGraph,
  type ScratchRepo,
} from "./helpers/scratch.ts";

const WORKER = "verdict-durability-worker";

const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };

const CLEAN_VERDICT: VerdictT = { findings: [] };
const BLOCKING_VERDICT: VerdictT = {
  findings: [{ criterion: "criterion-x", severity: "blocking", note: "does not hold" }],
};

const VERDICT_MARKER = "workgraph-verdict verdict ";
const ESCALATED_MARKER = "workgraph-lease escalated ";

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
}

function makeHarness(policy: PolicyOverrides): Harness {
  const mock = makeMockPi();
  const config = shippedConfig({ workerIdOverride: WORKER, policy });
  setWorkerIdOverride(WORKER);
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
  });
  return { mock, coordinator };
}

function reviewMode(mode: GateModeT): PolicyOverrides {
  return { medium: { gates: { review: mode } } };
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

/** Approve a medium-risk reviewed issue, from outside this process. */
function approve(graph: ScratchGraph, id: string): void {
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
    "workgraph_risk_tier=medium",
    "--set-metadata",
    "workgraph_workflow_class=reviewed",
    "--actor",
    "approver",
  ]);
}

async function commentsStarting(dir: string, id: string, marker: string): Promise<string[]> {
  const comments = await listComments(dir, id);
  return comments.filter((c) => c.text.startsWith(marker)).map((c) => c.text);
}

/** One issue, one implementation, one review returning `verdict`, driven to rest. */
async function judge(
  graph: ScratchRepo,
  policy: PolicyOverrides,
  verdict: VerdictT,
): Promise<{ id: string; reviews: number; cleanup: () => Promise<void> }> {
  const id = graph.seededIds[0]!;
  approve(graph, id);
  const { mock, coordinator } = makeHarness(policy);
  const fake = installFakeExecutor(mock.events, {
    roles: ["implementer", "reviewer"],
    // Isolated, with its work in the repository and cut from HEAD: the
    // tree-binding gate passes and the case is about the verdict alone.
    workspace: { path: graph.dir, baseRevision: graph.head },
    roleScripts: {
      implementer: { provenance: IMPL_PROV, artifacts: ["src/thing.ts"] },
      reviewer: { provenance: REV_PROV, verdict },
    },
  });
  const ectx = makeEventContext(graph.dir);
  const cleanup = async (): Promise<void> => {
    fake.uninstall();
    await coordinator.teardown(ectx.ctx);
  };
  try {
    await settle(mock, ectx.ctx);
    await mock.flushEvents();
  } catch (e) {
    await cleanup();
    throw e;
  }
  return {
    id,
    reviews: fake.requests.filter((r) => r.role === "reviewer").length,
    cleanup,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLeasesForTest();
  resetIdentityForTest();
});

describe("recordVerdict", () => {
  it("rejects with VerdictWriteError when the comment cannot be written, and says so loudly", async () => {
    const graph = makeScratchGraph({ prefix: "vdunit", seed: 1 });
    const id = graph.seededIds[0]!;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      failCommentWrites(graph.dir, "workgraph-verdict");
      let thrown: unknown;
      try {
        await recordVerdict(graph.dir, id, CLEAN_VERDICT, { attempt: 1 });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(VerdictWriteError);
      const error = thrown as VerdictWriteError;
      expect(error.name).toBe("VerdictWriteError");
      expect(error.issueId).toBe(id);
      expect(error.detail).toContain(COMMENT_WRITE_FAILURE);
      expect(error.message).toContain(id);
      expect(logged.mock.calls.map((args) => args.join(" "))).toEqual([
        expect.stringContaining(`VERDICT WRITE FAILED (${id})`),
      ]);
      expect(await commentsStarting(graph.dir, id, VERDICT_MARKER)).toEqual([]);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("still resolves and persists when the write succeeds", async () => {
    const graph = makeScratchGraph({ prefix: "vdok", seed: 1 });
    const id = graph.seededIds[0]!;
    try {
      await expect(recordVerdict(graph.dir, id, CLEAN_VERDICT, { attempt: 1 })).resolves.toBeUndefined();
      expect(await commentsStarting(graph.dir, id, VERDICT_MARKER)).toHaveLength(1);
    } finally {
      graph.cleanup();
    }
  }, 30_000);
});

describe("a failed verdict write never closes", () => {
  it.each([
    ["enforce", "a clean verdict", CLEAN_VERDICT],
    ["observe", "a clean verdict", CLEAN_VERDICT],
    ["enforce", "blocking findings", BLOCKING_VERDICT],
    ["observe", "blocking findings", BLOCKING_VERDICT],
  ] as const)(
    "review %s, %s: the run escalates and the audit carries the write failure",
    async (mode, _what, verdict) => {
      const graph = makeScratchRepo({ prefix: "vdfail", seed: 1 });
      failCommentWrites(graph.dir, "workgraph-verdict");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const flow = await judge(graph, reviewMode(mode), verdict);
      try {
        const { id } = flow;
        // The review ran and returned a verdict; only its record was lost.
        expect(flow.reviews).toBe(1);

        const shown = graph.showIssue(id);
        expect(shown.status).not.toBe("closed");
        expect(shown.status).toBe("blocked");
        const metadata = metadataOf(graph, id);
        expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("escalated");
        // The verdict never became the issue's last verdict either.
        expect(metadata[WORKGRAPH_LAST_VERDICT_KEY]).toBeUndefined();

        const escalated = await commentsStarting(graph.dir, id, ESCALATED_MARKER);
        expect(escalated).toHaveLength(1);
        const audit = JSON.parse(escalated[0]!.slice(ESCALATED_MARKER.length)) as { reason: string };
        expect(audit.reason).toBe(`verdict record could not be written: ${COMMENT_WRITE_FAILURE}`);

        expect(await commentsStarting(graph.dir, id, VERDICT_MARKER)).toEqual([]);
        expect(await commentsStarting(graph.dir, id, "workgraph-lease judgment-closed ")).toEqual([]);
        // The review gate was never applied: its result is recorded only
        // once the verdict it rests on is durable. (The tree-binding and
        // check gates and the diff guards are evaluated before the review
        // and have their own records.)
        const records = await listGateRecords(graph.dir, id);
        expect(records.filter((r) => r.gate === "review")).toEqual([]);
        expect(records.map((r) => [r.gate, r.result])).toEqual([
          ["tree-binding", "pass"],
          ["check", "pass"],
          ["weakened-tests", "pass"],
          ["scope", "not-applicable"],
          ["unproven-tests", "not-applicable"],
        ]);
        expect(heldLeases(graph.dir)).toHaveLength(0);
      } finally {
        await flow.cleanup();
        graph.cleanup();
      }
    },
    60_000,
  );

  it.each(["enforce", "observe"] as const)(
    "control, review %s: the same clean verdict closes once the write can land",
    async (mode) => {
      const graph = makeScratchRepo({ prefix: "vdctl", seed: 1 });
      const flow = await judge(graph, reviewMode(mode), CLEAN_VERDICT);
      try {
        const { id } = flow;
        expect(graph.showIssue(id).status).toBe("closed");
        expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("accepted");
        expect(await commentsStarting(graph.dir, id, VERDICT_MARKER)).toHaveLength(1);
        expect(await commentsStarting(graph.dir, id, ESCALATED_MARKER)).toEqual([]);
      } finally {
        await flow.cleanup();
        graph.cleanup();
      }
    },
    60_000,
  );

  it("review off attempts no verdict, so an unwritable verdict trail changes nothing", async () => {
    const graph = makeScratchRepo({ prefix: "vdoff", seed: 1 });
    failCommentWrites(graph.dir, "workgraph-verdict");
    const flow = await judge(graph, reviewMode("off"), CLEAN_VERDICT);
    try {
      const { id } = flow;
      expect(flow.reviews).toBe(0);
      expect(graph.showIssue(id).status).toBe("closed");
      expect(metadataOf(graph, id)[WORKGRAPH_LAST_VERDICT_KEY]).toBe("review off");
      expect(await commentsStarting(graph.dir, id, ESCALATED_MARKER)).toEqual([]);
    } finally {
      await flow.cleanup();
      graph.cleanup();
    }
  }, 60_000);
});
