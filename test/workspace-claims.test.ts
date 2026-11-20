/**
 * Workspaces across runs (proof-of-success phase 2): who may claim into a
 * checkout that holds work under judgment, what a restart keeps, what a
 * re-claim keeps, and where a bridged reviewer goes when the implementation
 * was done in the session's own checkout.
 *
 *  - CLAIM-WAIT: a non-isolated executor is not given a second issue while
 *    the first is in judging in the same checkout; an isolated one is.
 *  - RESTART: workspace path, base and result tree are rebuilt from the
 *    trail, so the resumed review, the verdict and the stamp name the tree
 *    recorded before the restart — or the tree that is there now, if the
 *    workspace was edited while nothing was watching.
 *  - RE-CLAIM: a second attempt into the same checkout keeps the first base.
 *  - ROUTING: the real pi-subagents bridge launches a reviewer (and a
 *    finalizer) in the directory the implementer's completion reported.
 *
 * Real git (`makeScratchRepo`), shipped defaults (`shippedConfig`), and the
 * repo's timer discipline. Where a review is deliberately left stalled the
 * judgment chain's promise never settles, so those cases poll in-memory
 * state instead of calling `flushEvents()`.
 */
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PI_SUBAGENTS_EXECUTOR_ID,
  registerPiSubagentsExecutor,
} from "../src/adapters/pi-subagents.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import { latestStamp } from "../src/proof.ts";
import { changedFiles, fileAt, treeOf } from "../src/snapshot.ts";
import { listComments } from "../src/store.ts";
import {
  WORKGRAPH_ACCEPTED_TREE_KEY,
  WORKGRAPH_BASE_COMMIT_KEY,
  WORKGRAPH_BASE_TREE_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_RESULT_COMMIT_KEY,
  WORKGRAPH_RESULT_TREE_KEY,
  WORKGRAPH_WORKFLOW_RUN_ID_KEY,
  WORKGRAPH_WORKSPACE_PATH_KEY,
  type VerdictT,
} from "../src/types.ts";
import { shippedConfig } from "./helpers/config.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import { installFakeSubagents } from "./helpers/fake-subagents.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockPi,
} from "./helpers/mock-pi.ts";
import {
  makeScratchRepo,
  type ScratchGraph,
  type ScratchRepo,
} from "./helpers/scratch.ts";

const WORKER = "workspace-claims-worker";

/** Distinct author/reviewer provenance — independent under every policy. */
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };

const CLEAN_VERDICT: VerdictT = { findings: [] };
const SHA = /^[0-9a-f]{40}$/;
const VERDICT_MARKER = "workgraph-verdict verdict ";

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
  config: WorkgraphConfig;
}

function makeHarness(overrides: Partial<WorkgraphConfig> = {}): Harness {
  const mock = makeMockPi();
  const config = shippedConfig({ workerIdOverride: WORKER, ...overrides });
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

function approve(
  graph: ScratchGraph,
  id: string,
  opts: { riskTier?: string; workflowClass?: string } = {},
): void {
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
    `workgraph_risk_tier=${opts.riskTier ?? "medium"}`,
    "--set-metadata",
    `workgraph_workflow_class=${opts.workflowClass ?? "reviewed"}`,
    "--actor",
    "approver",
  ]);
}

async function payloads(
  dir: string,
  id: string,
  marker: string,
): Promise<Array<Record<string, unknown>>> {
  const comments = await listComments(dir, id);
  return comments
    .filter((c) => c.text.startsWith(marker))
    .map((c) => JSON.parse(c.text.slice(marker.length)) as Record<string, unknown>);
}

const audits = (dir: string, id: string, kind: string) =>
  payloads(dir, id, `workgraph-lease ${kind} `);

/**
 * Poll a CHEAP, in-memory condition. For the cases that leave a review
 * stalled: `flushEvents()` would await the judgment chain and never return.
 */
async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("until: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Silence console.error and return the lines it was given. */
function captureErrors(): () => string[] {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.join(" "));
}

function commitAll(repo: ScratchRepo, message: string): void {
  repo.git("add", "-A");
  repo.git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    message,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLeasesForTest();
  resetIdentityForTest();
});

// ---------------------------------------------------------------------------
// the claim-wait rule
// ---------------------------------------------------------------------------

describe("claim-wait", () => {
  /**
   * Two ready issues, an implementer that writes `<issue>.txt`, and a
   * separate reviewer that accepts and then stalls until the test completes
   * it. Only the implementer's isolation differs between the two cases.
   */
  function setup(isolation: "none" | "worktree") {
    const repo = makeScratchRepo({ prefix: "wcwait", seed: 2 });
    const [first, second] = repo.seededIds as [string, string];
    approve(repo, first);
    approve(repo, second);
    const harness = makeHarness();
    const implementer = installFakeExecutor(harness.mock.events, {
      executorId: "implementer-exec",
      roles: ["implementer"],
      isolation,
      workspace:
        isolation === "none"
          ? { path: repo.dir }
          : { path: repo.dir, baseRevision: repo.head },
      provenance: IMPL_PROV,
      onRequest: (request) =>
        writeFileSync(join(repo.dir, `${request.issue.id}.txt`), "done\n"),
    });
    const reviewer = installFakeExecutor(harness.mock.events, {
      executorId: "reviewer-exec",
      roles: ["reviewer"],
      behavior: "accept-stall",
      provenance: REV_PROV,
      roleScripts: { reviewer: { verdict: CLEAN_VERDICT } },
    });
    const ectx = makeEventContext(repo.dir);
    const cleanup = async (): Promise<void> => {
      implementer.uninstall();
      reviewer.uninstall();
      await harness.coordinator.teardown(ectx.ctx);
      repo.cleanup();
    };
    return { repo, first, second, harness, implementer, reviewer, ectx, cleanup };
  }

  it("a non-isolated executor is not given a second issue while the first is under review, and is once it resolves", async () => {
    const t = setup("none");
    const { repo, first, second, reviewer, implementer } = t;
    const { mock } = t.harness;
    const errors = captureErrors();
    try {
      await settle(mock, t.ectx.ctx);
      await until(() => reviewer.requests.length === 1);
      expect(metadataOf(repo, first)[WORKGRAPH_PHASE_KEY]).toBe("judging");

      // The checkout is occupied: settle as often as you like.
      await settle(mock, t.ectx.ctx);
      await settle(mock, t.ectx.ctx);
      expect(repo.showIssue(second).status).toBe("open");
      const waiting = metadataOf(repo, second);
      expect(waiting[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(waiting[WORKGRAPH_WORKFLOW_RUN_ID_KEY]).toBeUndefined();
      expect(implementer.requests.map((r) => r.issue.id)).toEqual([first]);
      // The skip names the issue in the way, once.
      const skips = errors().filter((line) =>
        line.includes(`workspace under review: ${first}`),
      );
      expect(skips).toHaveLength(1);

      // The review resolves; the first issue closes and frees the checkout.
      reviewer.complete();
      await mock.flushEvents();
      expect(repo.showIssue(first).status).toBe("closed");

      await settle(mock, t.ectx.ctx);
      await until(() => reviewer.requests.length === 2);
      expect(implementer.requests.map((r) => r.issue.id)).toEqual([first, second]);
      expect(metadataOf(repo, second)[WORKGRAPH_PHASE_KEY]).toBe("judging");

      // Why the rule exists: the second issue's base was taken AFTER the
      // first was accepted, so the first issue's file is base, not change.
      const meta = metadataOf(repo, second);
      const base = String(meta[WORKGRAPH_BASE_TREE_KEY]);
      const result = String(meta[WORKGRAPH_RESULT_TREE_KEY]);
      expect(fileAt(repo.dir, base, `${first}.txt`)).toBe("done\n");
      expect(changedFiles(repo.dir, base, result)).toEqual([
        { status: "A", path: `${second}.txt` },
      ]);

      reviewer.complete();
      await mock.flushEvents();
      expect(repo.showIssue(second).status).toBe("closed");
      expect(heldLeases(repo.dir)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("an isolated executor is given the second issue while the first is still in review", async () => {
    const t = setup("worktree");
    const { repo, first, second, reviewer, implementer } = t;
    const { mock } = t.harness;
    const errors = captureErrors();
    try {
      await settle(mock, t.ectx.ctx);
      await until(() => reviewer.requests.length === 1);
      expect(metadataOf(repo, first)[WORKGRAPH_PHASE_KEY]).toBe("judging");

      await settle(mock, t.ectx.ctx);
      await until(() => reviewer.requests.length === 2);
      expect(implementer.requests.map((r) => r.issue.id)).toEqual([first, second]);
      // Both under judgment at once; the first review never resolved.
      expect(metadataOf(repo, first)[WORKGRAPH_PHASE_KEY]).toBe("judging");
      expect(metadataOf(repo, second)[WORKGRAPH_PHASE_KEY]).toBe("judging");
      expect(
        errors().filter((line) => line.includes("workspace under review")),
      ).toEqual([]);
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  /**
   * The planner tier with `planApproval: "auto"`: the plan flows straight
   * to an implementer under the claim the planner was given, so the rule has
   * to look past the planner. One reviewed issue goes into review in the
   * shared checkout; the second issue is planned, and its planner is
   * isolated.
   */
  function setupPlanned() {
    const repo = makeScratchRepo({ prefix: "wcplan", seed: 2 });
    const [first, second] = repo.seededIds as [string, string];
    approve(repo, first);
    approve(repo, second, { workflowClass: "planned" });
    const harness = makeHarness({ planApproval: "auto" });
    const implementer = installFakeExecutor(harness.mock.events, {
      executorId: "implementer-exec",
      roles: ["implementer"],
      isolation: "none",
      workspace: { path: repo.dir },
      provenance: IMPL_PROV,
      onRequest: (request) =>
        writeFileSync(join(repo.dir, `${request.issue.id}.txt`), "done\n"),
    });
    const reviewer = installFakeExecutor(harness.mock.events, {
      executorId: "reviewer-exec",
      roles: ["reviewer"],
      behavior: "accept-stall",
      provenance: REV_PROV,
      roleScripts: { reviewer: { verdict: CLEAN_VERDICT } },
    });
    const ectx = makeEventContext(repo.dir);
    return { repo, first, second, harness, implementer, reviewer, ectx };
  }

  /** No path-like targets: the scope guard has nothing to say about it. */
  const PLAN = {
    summary: "write the issue's file",
    steps: [{ description: "write one file named after the issue" }],
  };
  const PLAN_PROV = { harness: "fake", model: "plan-model", provider: "prov-plan" };

  it("a planned issue with an auto-approved plan waits too when its implementer is non-isolated, even though its planner is isolated", async () => {
    const t = setupPlanned();
    const { repo, first, second, reviewer, implementer } = t;
    const { mock } = t.harness;
    const planner = installFakeExecutor(mock.events, {
      executorId: "planner-exec",
      roles: ["planner"],
      isolation: "worktree",
      provenance: PLAN_PROV,
      roleScripts: { planner: { plan: PLAN } },
    });
    const errors = captureErrors();
    try {
      await settle(mock, t.ectx.ctx);
      await until(() => reviewer.requests.length === 1);
      expect(metadataOf(repo, first)[WORKGRAPH_PHASE_KEY]).toBe("judging");

      // The planner is isolated and free, but the plan it wrote would be
      // implemented in the occupied checkout: no claim, and no plan.
      await settle(mock, t.ectx.ctx);
      await settle(mock, t.ectx.ctx);
      expect(planner.requests).toEqual([]);
      expect(implementer.requests.map((r) => r.issue.id)).toEqual([first]);
      expect(repo.showIssue(second).status).toBe("open");
      const waiting = metadataOf(repo, second);
      expect(waiting[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(waiting[WORKGRAPH_WORKFLOW_RUN_ID_KEY]).toBeUndefined();
      expect(
        errors().filter((line) =>
          line.includes(`workspace under review: ${first}`),
        ),
      ).toHaveLength(1);

      // The review resolves and frees the checkout: planned, then built.
      reviewer.complete();
      await mock.flushEvents();
      expect(repo.showIssue(first).status).toBe("closed");

      await settle(mock, t.ectx.ctx);
      await until(() => reviewer.requests.length === 2);
      expect(planner.requests.map((r) => r.issue.id)).toEqual([second]);
      expect(implementer.requests.map((r) => r.issue.id)).toEqual([first, second]);
      expect(metadataOf(repo, second)[WORKGRAPH_PHASE_KEY]).toBe("judging");
    } finally {
      planner.uninstall();
      t.implementer.uninstall();
      t.reviewer.uninstall();
      await t.harness.coordinator.teardown(t.ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("when the offers change while the plan is written, the implementer does not start in the occupied checkout: the issue goes back to the pool and is not planned again", async () => {
    const t = setupPlanned();
    const { repo, first, second, reviewer, implementer } = t;
    const { mock } = t.harness;
    const errors = captureErrors();
    let planner: ReturnType<typeof installFakeExecutor> | undefined;
    let isolated: ReturnType<typeof installFakeExecutor> | undefined;
    try {
      await settle(mock, t.ectx.ctx);
      await until(() => reviewer.requests.length === 1);
      expect(metadataOf(repo, first)[WORKGRAPH_PHASE_KEY]).toBe("judging");

      // An isolated implementer that outranks the in-checkout one comes
      // online, so the tick expects the plan to be built in isolation and
      // claims the planned issue. The planner stalls on it.
      isolated = installFakeExecutor(mock.events, {
        executorId: "isolated-impl",
        roles: ["implementer"],
        isolation: "worktree",
        priority: 10,
        workspace: { path: repo.dir, baseRevision: repo.head },
        provenance: IMPL_PROV,
      });
      planner = installFakeExecutor(mock.events, {
        executorId: "planner-exec",
        roles: ["planner"],
        isolation: "worktree",
        behavior: "accept-stall",
        provenance: PLAN_PROV,
        roleScripts: { planner: { plan: PLAN } },
      });
      await settle(mock, t.ectx.ctx);
      await until(() => planner!.requests.length === 1);
      expect(metadataOf(repo, second)[WORKGRAPH_PHASE_KEY]).toBe("planning");
      expect(heldLeases(repo.dir)).toHaveLength(2);

      // The isolated implementer leaves before the plan lands. What remains
      // is the non-isolated one, in a checkout that is still under review.
      isolated.uninstall();
      isolated = undefined;
      planner.complete();
      await until(() => heldLeases(repo.dir).length === 1);

      expect(implementer.requests.map((r) => r.issue.id)).toEqual([first]);
      expect(repo.showIssue(second).status).toBe("open");
      expect(metadataOf(repo, second)[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(metadataOf(repo, first)[WORKGRAPH_PHASE_KEY]).toBe("judging");
      expect(
        errors().some((line) =>
          line.includes(
            `${second}: workspace under review: ${first} — returned to the ready pool`,
          ),
        ),
      ).toBe(true);

      // Back in the pool it waits like any other claim: the tick now sees
      // the non-isolated implementer and does not have the plan rewritten.
      await settle(mock, t.ectx.ctx);
      await settle(mock, t.ectx.ctx);
      expect(planner.requests).toHaveLength(1);
      expect(implementer.requests.map((r) => r.issue.id)).toEqual([first]);
    } finally {
      planner?.uninstall();
      isolated?.uninstall();
      t.implementer.uninstall();
      t.reviewer.uninstall();
      await t.harness.coordinator.teardown(t.ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------

describe("restart during judgment", () => {
  /**
   * Life before the crash: a real coordinator takes one issue to judging,
   * where it parks because nothing offers the reviewer role. Then the
   * crash: the in-memory state is dropped, the store keeps everything. (A
   * graceful teardown would RELEASE the parked run, leaving nothing to
   * adopt, so the crash is simulated, as test/recovery.test.ts does.)
   */
  async function crashInJudging(prefix: string, seed = 1) {
    resetLeasesForTest();
    const repo = makeScratchRepo({ prefix, seed });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const first = makeHarness();
    const fakeA = installFakeExecutor(first.mock.events, {
      executorId: "implementer-exec",
      roles: ["implementer"],
      isolation: "none",
      workspace: { path: repo.dir },
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          artifacts: ["feature.txt"],
          onRequest: () => writeFileSync(join(repo.dir, "feature.txt"), "v1\n"),
        },
      },
    });
    const ectx1 = makeEventContext(repo.dir);
    await settle(first.mock, ectx1.ctx);
    await first.mock.flushEvents();
    expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("judging");
    const before = metadataOf(repo, id);
    fakeA.uninstall();
    resetLeasesForTest();
    return {
      repo,
      id,
      before: {
        tree: String(before[WORKGRAPH_RESULT_TREE_KEY]),
        commit: String(before[WORKGRAPH_RESULT_COMMIT_KEY]),
        baseTree: String(before[WORKGRAPH_BASE_TREE_KEY]),
        baseCommit: String(before[WORKGRAPH_BASE_COMMIT_KEY]),
        runId: String(before[WORKGRAPH_WORKFLOW_RUN_ID_KEY]),
      },
      teardownFirst: () => first.coordinator.teardown(ectx1.ctx),
    };
  }

  function reviewerOn(mock: MockPi) {
    return installFakeExecutor(mock.events, {
      executorId: "reviewer-exec",
      roles: ["reviewer"],
      roleScripts: { reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT } },
    });
  }

  it("the resumed review, the verdict and the stamp carry the tree recorded before the restart", async () => {
    captureErrors(); // the pre-crash park ("no reviewer-capable executor")
    const crashed = await crashInJudging("wcrst");
    const { repo, id, before } = crashed;
    expect(before.tree).toMatch(SHA);
    const second = makeHarness();
    const fakeB = reviewerOn(second.mock);
    const ectx2 = makeEventContext(repo.dir);
    try {
      const report = await second.coordinator.reconcile(ectx2.ctx);
      expect(report.readopted).toEqual([id]);

      // Rebuilt from the trail and sent on: path, base and the same tree.
      const review = fakeB.requests.find((r) => r.role === "reviewer")!;
      expect(review.workspace).toMatchObject({
        path: repo.dir,
        baseRevision: before.baseCommit,
        baseTree: before.baseTree,
        tree: before.tree,
      });

      expect(repo.showIssue(id).status).toBe("closed");
      const verdicts = await payloads(repo.dir, id, VERDICT_MARKER);
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]!.tree).toBe(before.tree);
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp).toMatchObject({
        tree: before.tree,
        baseTree: before.baseTree,
        commit: before.commit,
        workflowRunId: before.runId,
      });
      expect(metadataOf(repo, id)[WORKGRAPH_ACCEPTED_TREE_KEY]).toBe(before.tree);
      // Nothing moved, so nothing was re-snapshotted.
      expect(await audits(repo.dir, id, "workspace-changed")).toEqual([]);
      expect(heldLeases(repo.dir)).toHaveLength(0);
    } finally {
      fakeB.uninstall();
      await second.coordinator.teardown(ectx2.ctx);
      await crashed.teardownFirst();
      repo.cleanup();
    }
  }, 60_000);

  it("a file edited while the coordinator was down goes back through review as a new tree", async () => {
    captureErrors();
    const crashed = await crashInJudging("wcrste");
    const { repo, id, before } = crashed;
    // Nobody is watching: the workspace is edited between the two lives.
    writeFileSync(join(repo.dir, "feature.txt"), "v1, edited while down\n");
    const second = makeHarness();
    const fakeB = reviewerOn(second.mock);
    const ectx2 = makeEventContext(repo.dir);
    try {
      const report = await second.coordinator.reconcile(ectx2.ctx);
      expect(report.readopted).toEqual([id]);

      const live = treeOf(repo.dir);
      expect(live).not.toBe(before.tree);
      const changed = await audits(repo.dir, id, "workspace-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        previousTree: before.tree,
        tree: live,
        when: "while the coordinator was down",
      });

      // The review that ran was of the edited tree, against the SAME base.
      const reviews = fakeB.requests.filter((r) => r.role === "reviewer");
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.workspace).toMatchObject({
        baseTree: before.baseTree,
        tree: live,
      });
      expect(repo.showIssue(id).status).toBe("closed");
      const verdicts = await payloads(repo.dir, id, VERDICT_MARKER);
      expect(verdicts.map((v) => v.tree)).toEqual([live]);
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp!.tree).toBe(live);
      expect(stamp!.baseTree).toBe(before.baseTree);
      expect(repo.git("rev-parse", `${stamp!.commit}^{tree}`)).toBe(live);
      expect(fileAt(repo.dir, live, "feature.txt")).toBe("v1, edited while down\n");
    } finally {
      fakeB.uninstall();
      await second.coordinator.teardown(ectx2.ctx);
      await crashed.teardownFirst();
      repo.cleanup();
    }
  }, 60_000);

  it("a run adopted in judging still holds its checkout against new claims", async () => {
    const errors = captureErrors();
    const crashed = await crashInJudging("wcrstw", 2);
    const { repo, id } = crashed;
    const other = repo.seededIds[1]!;
    approve(repo, other);
    // After the restart: still nothing to review with, and a non-isolated
    // implementer ready to take the next issue.
    const second = makeHarness();
    const fakeB = installFakeExecutor(second.mock.events, {
      executorId: "implementer-exec",
      roles: ["implementer"],
      isolation: "none",
      workspace: { path: repo.dir },
      provenance: IMPL_PROV,
    });
    const ectx2 = makeEventContext(repo.dir);
    try {
      const report = await second.coordinator.reconcile(ectx2.ctx);
      expect(report.readopted).toEqual([id]);
      await settle(second.mock, ectx2.ctx);
      await second.mock.flushEvents();

      expect(fakeB.requests).toEqual([]);
      expect(repo.showIssue(other).status).toBe("open");
      expect(
        errors().some((line) => line.includes(`workspace under review: ${id}`)),
      ).toBe(true);
    } finally {
      fakeB.uninstall();
      await second.coordinator.teardown(ectx2.ctx);
      await crashed.teardownFirst();
      repo.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the base across re-claims
// ---------------------------------------------------------------------------

describe("the base across re-claims", () => {
  it("a re-claim into the same checkout keeps the first base, so the first attempt's deletion still shows", async () => {
    const repo = makeScratchRepo({ prefix: "wcbase", seed: 1 });
    const id = repo.seededIds[0]!;
    writeFileSync(join(repo.dir, "legacy.txt"), "old code\n");
    commitAll(repo, "test: fixture");
    // One-shot, low risk: a reported failure promotes the issue to the
    // reviewed workflow and returns it to the pool — a re-claim with no
    // human in between.
    approve(repo, id, { riskTier: "low", workflowClass: "oneshot" });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      isolation: "none",
      workspace: { path: repo.dir },
      roleScripts: {
        implementer: [
          {
            provenance: IMPL_PROV,
            outcome: "failure",
            // Attempt one deletes a file, then gives up.
            onRequest: () => unlinkSync(join(repo.dir, "legacy.txt")),
          },
          {
            provenance: IMPL_PROV,
            onRequest: () => writeFileSync(join(repo.dir, "feature.txt"), "new code\n"),
          },
        ],
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      const afterFirst = metadataOf(repo, id);
      expect(afterFirst[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(afterFirst.workgraph_workflow_class).toBe("reviewed");
      const firstBase = String(afterFirst[WORKGRAPH_BASE_TREE_KEY]);
      const firstBaseCommit = String(afterFirst[WORKGRAPH_BASE_COMMIT_KEY]);
      expect(firstBase).toMatch(SHA);
      expect(afterFirst[WORKGRAPH_WORKSPACE_PATH_KEY]).toBe(repo.dir);
      expect(fileAt(repo.dir, firstBase, "legacy.txt")).toBe("old code\n");

      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(repo.showIssue(id).status).toBe("closed");
      const [run1, run2] = fake.requests
        .filter((r) => r.role === "implementer")
        .map((r) => r.workflowRunId);
      expect(run2).not.toBe(run1);

      // A new run, the SAME base: a snapshot taken at the second claim
      // would already lack legacy.txt and hide the deletion.
      const metadata = metadataOf(repo, id);
      expect(metadata[WORKGRAPH_BASE_TREE_KEY]).toBe(firstBase);
      expect(metadata[WORKGRAPH_BASE_COMMIT_KEY]).toBe(firstBaseCommit);
      const tree = String(metadata[WORKGRAPH_RESULT_TREE_KEY]);
      expect(changedFiles(repo.dir, firstBase, tree)).toEqual(
        expect.arrayContaining([
          { status: "D", path: "legacy.txt" },
          { status: "A", path: "feature.txt" },
        ]),
      );
      expect(changedFiles(repo.dir, firstBase, tree)).toHaveLength(2);
      // The second implementer was told of the kept base; one base ref exists.
      expect(fake.requests.filter((r) => r.role === "implementer")[1]!.workspace.baseRevision).toBe(
        firstBaseCommit,
      );
      const refs = repo
        .git("for-each-ref", "--format=%(refname)", "refs/workgraph")
        .split("\n");
      expect(refs.filter((ref) => ref.endsWith("/base"))).toHaveLength(1);
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp).toMatchObject({ tree, baseTree: firstBase, workflowRunId: run2 });
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// a bridged reviewer for an in-session implementation
// ---------------------------------------------------------------------------

describe("a bridged reviewer for work done in the session's checkout", () => {
  const RECEIPT = { outcome: "success", summary: "Published" };

  it.each([
    ["finalization not configured", false],
    ["finalization configured", true],
  ] as const)(
    "%s: the upstream reviewer is launched in the reported workspace and accepted",
    async (_label, finalizes) => {
      const repo = makeScratchRepo({ prefix: "wcbridge", seed: 1 });
      const id = repo.seededIds[0]!;
      approve(repo, id);
      const { mock, coordinator, config } = makeHarness({
        subagentsExecutor: { enabled: true },
        // The implementation is in-session style; judgment is bridged.
        executorByRole: {
          implementer: "in-session-style",
          reviewer: PI_SUBAGENTS_EXECUTOR_ID,
          finalizer: PI_SUBAGENTS_EXECUTOR_ID,
        },
        ...(finalizes
          ? { finalization: { instructions: "Publish it", timeoutMs: 5_000 } }
          : {}),
      });
      const bridge = registerPiSubagentsExecutor(asExtensionAPI(mock), {
        getConfig: () => config,
        probeVersion: () => "0.34.8",
      });
      const implementer = installFakeExecutor(mock.events, {
        executorId: "in-session-style",
        roles: ["implementer"],
        isolation: "none",
        // What the in-session adapter reports: a path, no base revision.
        workspace: { path: repo.dir },
        provenance: IMPL_PROV,
        onRequest: () => writeFileSync(join(repo.dir, "feature.txt"), "v1\n"),
      });
      const upstream = installFakeSubagents(mock.events, {
        script: [
          { model: "provider/reviewer", structuredOutput: CLEAN_VERDICT },
          { model: "provider/finalizer", structuredOutput: RECEIPT },
        ],
      });
      const ectx = makeEventContext(repo.dir);
      try {
        await settle(mock, ectx.ctx);
        await mock.flushEvents();
        await expect
          .poll(() => repo.showIssue(id).status, { timeout: 30_000, interval: 50 })
          .toBe("closed");

        const metadata = metadataOf(repo, id);
        const tree = String(metadata[WORKGRAPH_RESULT_TREE_KEY]);
        const baseTree = String(metadata[WORKGRAPH_BASE_TREE_KEY]);
        expect(upstream.requests.map((r) => r.params.agent)).toEqual(
          finalizes ? ["reviewer", "worker"] : ["reviewer"],
        );
        // Every bridged role runs where the implementer said its work is:
        // the user's checkout, with no worktree of the bridge's own. Before
        // this, a reviewer with no manifest of its own was rejected.
        for (const request of upstream.requests) {
          expect(request.params.cwd).toBe(repo.dir);
          expect(request.params).not.toHaveProperty("worktree");
        }
        expect(String(upstream.requests[0]!.params.task)).toContain(
          `The change under review is "git diff ${baseTree} ${tree}" in ${repo.dir}. Do not modify any file.`,
        );
        expect(await audits(repo.dir, id, "executor-rejected")).toEqual([]);
        // No worktree was cut: the bridge implemented nothing.
        expect(repo.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);

        const stamp = await latestStamp(repo.dir, id);
        expect(stamp!.tree).toBe(tree);
        expect(stamp!.verdict).toBeDefined();
        expect(fileAt(repo.dir, tree, "feature.txt")).toBe("v1\n");
      } finally {
        await coordinator.teardown(ectx.ctx);
        implementer.uninstall();
        upstream.uninstall();
        bridge.teardown();
        repo.cleanup();
      }
    },
    60_000,
  );
});
