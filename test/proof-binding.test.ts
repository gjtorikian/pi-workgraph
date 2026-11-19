/**
 * Tree binding (proof-of-success phase 2): the git plumbing in
 * `src/snapshot.ts`, and what the coordinator does with it — a base tree
 * and a result tree for every run, the result tree on the verdict, the gate
 * records and the close stamp, the workspace compared against it during
 * review and again before the stamp, the stamp written before finalization,
 * and the `tree-binding` gate when there is no git repository to snapshot.
 *
 * Everything here runs against REAL git in a temp directory
 * (`makeScratchRepo`) and on `shippedConfig`: a case with no `policy` runs
 * on the defaults a user gets, so "default config, medium risk" means
 * exactly that. Fake executors do their "work" through an `onRequest` hook
 * that writes files into the repository.
 *
 * Timer discipline is the repo's: no fake timers, huge scheduling intervals,
 * tiny REAL protocol timeouts, ticks driven through `agent_settled`, and
 * `flushEvents()` to drain the completion handler.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkgraphConfig } from "../src/config.ts";
import {
  MAX_REVIEW_RETRIES,
  registerCoordinator,
  type CoordinatorController,
  type CoordinatorDeps,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import type { PolicyOverrides } from "../src/policy.ts";
import { latestStamp, listGateRecords } from "../src/proof.ts";
import {
  changedFiles,
  fileAt,
  isGitWorkspace,
  proofRef,
  runKey,
  snapshotWorkspace,
  treeOf,
  treeOfCommit,
} from "../src/snapshot.ts";
import { listComments } from "../src/store.ts";
import {
  WORKGRAPH_ACCEPTED_TREE_KEY,
  WORKGRAPH_BASE_COMMIT_KEY,
  WORKGRAPH_BASE_TREE_KEY,
  WORKGRAPH_FAILURE_FINGERPRINT_KEY,
  WORKGRAPH_FINALIZED_TREE_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_RESULT_COMMIT_KEY,
  WORKGRAPH_RESULT_TREE_KEY,
  WORKGRAPH_WORKSPACE_PATH_KEY,
  type VerdictT,
} from "../src/types.ts";
import { shippedConfig } from "./helpers/config.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockPi,
} from "./helpers/mock-pi.ts";
import {
  failCommentWrites,
  makeScratchGraph,
  makeScratchRepo,
  type ScratchGraph,
  type ScratchRepo,
} from "./helpers/scratch.ts";

const WORKER = "proof-binding-worker";

/** Distinct author/reviewer provenance — independent under every policy. */
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };

const CLEAN_VERDICT: VerdictT = { findings: [] };
const BLOCKING_VERDICT: VerdictT = {
  findings: [
    { criterion: "criterion-x", severity: "blocking", note: "does not hold" },
  ],
};

const SHA = /^[0-9a-f]{40}$/;
const VERDICT_MARKER = "workgraph-verdict verdict ";
const STAMP_MARKER = "workgraph-proof stamp ";

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
}

/** A coordinator on the shipped defaults, or on exactly the `policy` given. */
function makeHarness(
  opts: {
    policy?: PolicyOverrides;
    config?: Partial<WorkgraphConfig>;
    beforeAcceptance?: CoordinatorDeps["beforeAcceptance"];
  } = {},
): Harness {
  const mock = makeMockPi();
  const config = shippedConfig({
    workerIdOverride: WORKER,
    ...opts.config,
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
  setWorkerIdOverride(WORKER);
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
    ...(opts.beforeAcceptance
      ? { beforeAcceptance: opts.beforeAcceptance }
      : {}),
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

/** One coordination pass: claim, run, judge, and drain. */
async function drive(mock: MockPi, ctx: unknown): Promise<void> {
  await settle(mock, ctx);
  await mock.flushEvents();
}

function metadataOf(graph: ScratchGraph, id: string): Record<string, unknown> {
  return (graph.showIssue(id).metadata ?? {}) as Record<string, unknown>;
}

/** Approve an issue the way workgraph_approve does, from outside this process. */
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
    "--set-metadata",
    `workgraph_risk_tier=${opts.riskTier ?? "medium"}`,
    "--set-metadata",
    `workgraph_workflow_class=${opts.workflowClass ?? "reviewed"}`,
    "--actor",
    "approver",
  ]);
}

/** The JSON payloads of every comment on `id` that starts with `marker`. */
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

/** Silence console.error and return the lines it was given. */
function captureErrors(): () => string[] {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.join(" "));
}

/** What an isolated fake reports: its work is in the repository, cut from HEAD. */
function isolatedIn(repo: ScratchRepo) {
  return { path: repo.dir, baseRevision: repo.head };
}

function write(repo: ScratchRepo, file: string, content: string): void {
  writeFileSync(join(repo.dir, file), content);
}

/** Commit everything in the repository (fixture setup only). */
function commitAll(repo: ScratchRepo, message: string): string {
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
  return repo.git("rev-parse", "HEAD");
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLeasesForTest();
  resetIdentityForTest();
});

// ---------------------------------------------------------------------------
// snapshot plumbing
// ---------------------------------------------------------------------------

describe("snapshot", () => {
  /** What a snapshot must never change. */
  function userState(repo: ScratchRepo) {
    return {
      status: repo.git("status", "--porcelain"),
      staged: repo.git("diff", "--cached", "--name-only"),
      head: repo.git("rev-parse", "HEAD"),
      branch: repo.git("branch", "--show-current"),
    };
  }

  it("follows tracked, untracked, deleted and staged changes, ignores ignored files, and never touches the index", () => {
    const repo = makeScratchRepo({ prefix: "snap" });
    try {
      write(repo, ".gitignore", "ignored.log\n");
      write(repo, "tracked.txt", "one\n");
      write(repo, "doomed.txt", "bye\n");
      commitAll(repo, "test: fixture");

      const trees: string[] = [];
      /** Snapshot, assert the user's state did not move, return the tree. */
      const snap = (label: string): string => {
        const before = userState(repo);
        const snapshot = snapshotWorkspace(
          repo.dir,
          proofRef("snap-1", `key/${label}`),
          `test ${label}`,
        );
        expect(userState(repo)).toEqual(before);
        expect(snapshot.tree).toMatch(SHA);
        expect(snapshot.commit).toMatch(SHA);
        expect(treeOfCommit(repo.dir, snapshot.commit)).toBe(snapshot.tree);
        expect(repo.git("rev-parse", snapshot.ref)).toBe(snapshot.commit);
        trees.push(snapshot.tree);
        return snapshot.tree;
      };

      const clean = snap("clean");
      // A clean checkout snapshots to itself, twice over.
      expect(treeOf(repo.dir)).toBe(clean);

      write(repo, "tracked.txt", "two\n");
      const modified = snap("modified");
      expect(modified).not.toBe(clean);

      write(repo, "untracked.txt", "new\n");
      const untracked = snap("untracked");
      expect(untracked).not.toBe(modified);

      write(repo, "ignored.log", "noise\n");
      expect(snap("ignored")).toBe(untracked);

      unlinkSync(join(repo.dir, "doomed.txt"));
      const deleted = snap("deleted");
      expect(deleted).not.toBe(untracked);

      write(repo, "staged.txt", "staged\n");
      repo.git("add", "staged.txt");
      const staged = snap("staged");
      expect(staged).not.toBe(deleted);
      // The staged file is still staged, and only it.
      expect(repo.git("diff", "--cached", "--name-only")).toBe("staged.txt");

      // The trees hold the content, not just a different hash.
      expect(fileAt(repo.dir, staged, "tracked.txt")).toBe("two\n");
      expect(fileAt(repo.dir, staged, "untracked.txt")).toBe("new\n");
      expect(fileAt(repo.dir, staged, "ignored.log")).toBeUndefined();
      expect(fileAt(repo.dir, staged, "doomed.txt")).toBeUndefined();
      expect(fileAt(repo.dir, clean, "doomed.txt")).toBe("bye\n");

      // Anchored: every snapshot survives an aggressive gc.
      repo.git("gc", "--prune=now", "--quiet");
      for (const tree of trees) {
        expect(repo.git("cat-file", "-t", tree)).toBe("tree");
      }
      expect(fileAt(repo.dir, modified, "tracked.txt")).toBe("two\n");
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("lists what changed between two trees, with renames and odd paths", () => {
    const repo = makeScratchRepo({ prefix: "diff" });
    try {
      const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
      write(repo, "old name.txt", `${body}\n`);
      write(repo, "edited.txt", "before\n");
      write(repo, "removed.txt", "gone\n");
      commitAll(repo, "test: fixture");
      const base = treeOf(repo.dir);

      repo.git("mv", "old name.txt", "néw name.txt");
      write(repo, "edited.txt", "after\n");
      unlinkSync(join(repo.dir, "removed.txt"));
      write(repo, "added.txt", "hello\n");
      const result = treeOf(repo.dir);

      const changes = changedFiles(repo.dir, base, result);
      expect(changes).toEqual(
        expect.arrayContaining([
          { status: "A", path: "added.txt" },
          { status: "M", path: "edited.txt" },
          { status: "D", path: "removed.txt" },
          { status: "R", path: "néw name.txt", oldPath: "old name.txt" },
        ]),
      );
      expect(changes).toHaveLength(4);
      expect(changedFiles(repo.dir, base, base)).toEqual([]);
    } finally {
      repo.cleanup();
    }
  }, 60_000);

  it("snapshots a repository with no commits, and a linked worktree", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-empty-"));
    const repo = makeScratchRepo({ prefix: "wt" });
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "first.txt"), "first\n");
      const rooted = snapshotWorkspace(dir, proofRef("empty-1", "k/base"), "root");
      expect(fileAt(dir, rooted.tree, "first.txt")).toBe("first\n");
      // A root commit: no parent to name.
      expect(
        execFileSync("git", ["rev-list", "--count", rooted.commit], {
          cwd: dir,
          encoding: "utf8",
        }).trim(),
      ).toBe("1");

      // A linked worktree keeps its index elsewhere and shares refs.
      const linked = join(repo.dir, "..", `linked-${Date.now()}`);
      repo.git("worktree", "add", "-q", "-b", "side", linked, repo.head);
      try {
        writeFileSync(join(linked, "in-worktree.txt"), "wt\n");
        const snapshot = snapshotWorkspace(
          linked,
          proofRef("wt-1", "k/result-1"),
          "linked",
        );
        expect(fileAt(linked, snapshot.tree, "in-worktree.txt")).toBe("wt\n");
        // The ref resolves from the MAIN checkout too.
        expect(repo.git("rev-parse", snapshot.ref)).toBe(snapshot.commit);
        expect(
          execFileSync("git", ["status", "--porcelain"], {
            cwd: linked,
            encoding: "utf8",
          }).trim(),
        ).toBe("?? in-worktree.txt");
      } finally {
        rmSync(linked, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      repo.cleanup();
    }
  }, 60_000);

  it("reports a non-git directory, a missing one and a relative path as failures", () => {
    const graph = makeScratchGraph({ prefix: "nogit" });
    try {
      expect(isGitWorkspace(graph.dir)).toBe(false);
      expect(isGitWorkspace(join(graph.dir, "does-not-exist"))).toBe(false);
      expect(isGitWorkspace("")).toBe(false);
      expect(() => treeOf(graph.dir)).toThrow();
      expect(() => treeOf(join(graph.dir, "does-not-exist"))).toThrow();
      // "" would make git run in the test runner's own repository.
      expect(() => treeOf("")).toThrow(/absolute/);
      expect(() => treeOf("relative/path")).toThrow(/absolute/);
      expect(fileAt(graph.dir, "HEAD", "x")).toBeUndefined();
    } finally {
      graph.cleanup();
    }
  });

  it("ignores git variables inherited from a hook", () => {
    const repo = makeScratchRepo({ prefix: "env" });
    const elsewhere = makeScratchRepo({ prefix: "other" });
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    };
    try {
      write(repo, "mine.txt", "mine\n");
      const expected = treeOf(repo.dir);
      process.env.GIT_DIR = join(elsewhere.dir, ".git");
      process.env.GIT_WORK_TREE = elsewhere.dir;
      process.env.GIT_INDEX_FILE = join(elsewhere.dir, ".git", "index");
      expect(isGitWorkspace(repo.dir)).toBe(true);
      const tree = treeOf(repo.dir);
      expect(tree).toBe(expected);
      expect(fileAt(repo.dir, tree, "mine.txt")).toBe("mine\n");
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      repo.cleanup();
      elsewhere.cleanup();
    }
  });

  it("builds refs git accepts from any issue id and name", () => {
    const repo = makeScratchRepo({ prefix: "ref" });
    try {
      expect(proofRef("abc-12", "0123/result-1")).toBe(
        "refs/workgraph/abc-12/0123/result-1",
      );
      // A workflow-run id holds a slash; its key does not.
      expect(runKey("workgraph-run/6f9a")).toMatch(/^[0-9a-f]{20}$/);
      expect(runKey("workgraph-run/6f9a")).toBe(runKey("workgraph-run/6f9a"));
      const hostile = [
        proofRef("..", "base"),
        proofRef(".hidden", "x.lock"),
        proofRef("a b\tc", "re@{f}"),
        proofRef("", ""),
        proofRef("a..b~^:?*[\\", "//"),
      ];
      for (const ref of hostile) {
        expect(ref.startsWith("refs/workgraph/")).toBe(true);
        // git is the judge of what a valid ref is.
        expect(() => repo.git("check-ref-format", ref)).not.toThrow();
        repo.git("update-ref", ref, repo.head);
        expect(repo.git("rev-parse", ref)).toBe(repo.head);
      }
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// base and result
// ---------------------------------------------------------------------------

describe("the tree-binding gate", () => {
  it("default config, medium risk, git repository: the verdict, the stamp and the accepted tree are one SHA", async () => {
    const repo = makeScratchRepo({ prefix: "pbgit", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          artifacts: ["feature.txt"],
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      const stagedBefore = repo.git("diff", "--cached", "--name-only");
      await drive(mock, ectx.ctx);

      expect(repo.showIssue(id).status).toBe("closed");
      const metadata = metadataOf(repo, id);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("accepted");

      const tree = String(metadata[WORKGRAPH_RESULT_TREE_KEY]);
      expect(tree).toMatch(SHA);
      expect(fileAt(repo.dir, tree, "feature.txt")).toBe("v1\n");
      const baseTree = repo.git("rev-parse", `${repo.head}^{tree}`);
      expect(metadata[WORKGRAPH_WORKSPACE_PATH_KEY]).toBe(repo.dir);
      expect(metadata[WORKGRAPH_BASE_COMMIT_KEY]).toBe(repo.head);
      expect(metadata[WORKGRAPH_BASE_TREE_KEY]).toBe(baseTree);
      expect(metadata[WORKGRAPH_ACCEPTED_TREE_KEY]).toBe(tree);
      expect(metadata[WORKGRAPH_FINALIZED_TREE_KEY]).toBeUndefined();

      // The verdict names the tree it judged.
      const verdicts = await payloads(repo.dir, id, VERDICT_MARKER);
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]!.tree).toBe(tree);

      // The stamp: one, naming the same tree, its base, the anchored commit,
      // the verdict it rests on and both evaluated gates.
      expect(await payloads(repo.dir, id, STAMP_MARKER)).toHaveLength(1);
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp).toEqual({
        tree,
        baseTree,
        commit: metadata[WORKGRAPH_RESULT_COMMIT_KEY],
        workflowRunId: fake.requests[0]!.workflowRunId,
        attempt: 1,
        verdict: {
          executionId: fake.completions[1]!.executionId,
          summary: "pass blocking=0 advisory=0",
        },
        gates: { "tree-binding": "pass", review: "pass" },
      });
      expect(repo.git("rev-parse", `${stamp!.commit}^{tree}`)).toBe(tree);

      // Both gate records carry the tree.
      const records = await listGateRecords(repo.dir, id);
      expect(records.map((r) => [r.gate, r.result, r.blocked, r.tree])).toEqual([
        ["tree-binding", "pass", false, tree],
        ["review", "pass", false, tree],
      ]);

      // The reviewer was sent to the workspace, with both trees.
      const review = fake.requests.find((r) => r.role === "reviewer")!;
      expect(review.workspace).toMatchObject({
        repoPath: repo.dir,
        path: repo.dir,
        baseRevision: repo.head,
        baseTree,
        tree,
      });
      // The implementer request predates all of it.
      expect(fake.requests[0]!.workspace.path).toBeUndefined();
      expect(fake.requests[0]!.workspace.tree).toBeUndefined();

      // What a restart rebuilds from.
      const completed = await audits(repo.dir, id, "run-completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ workspacePath: repo.dir, tree });

      // Anchored under the private namespace; the user's index is untouched.
      const refs = repo.git("for-each-ref", "--format=%(refname)", "refs/workgraph");
      expect(refs.split("\n")).toEqual([
        proofRef(id, `${runKey(fake.requests[0]!.workflowRunId)}/result-1`),
      ]);
      expect(repo.git("diff", "--cached", "--name-only")).toBe(stagedBefore);
      expect(repo.git("rev-parse", "HEAD")).toBe(repo.head);
      expect(heldLeases(repo.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("default config, medium risk, no git repository: the issue does not close and the reason names git", async () => {
    const graph = makeScratchGraph({ prefix: "pbnogit", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
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
      await drive(mock, ectx.ctx);

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("blocked");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("escalated");

      const escalated = await audits(graph.dir, id, "escalated");
      expect(escalated).toHaveLength(1);
      expect(String(escalated[0]!.reason)).toMatch(/not a git repository/);
      expect(String(escalated[0]!.reason)).toMatch(
        /set gates\.tree-binding to observe to close without it/,
      );

      const records = await listGateRecords(graph.dir, id);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        gate: "tree-binding",
        mode: "enforce",
        result: "unknown",
        blocked: true,
        wouldBlock: false,
      });
      expect(records[0]!.reason).toMatch(/not a git repository/);
      expect(records[0]!.tree).toBeUndefined();

      // Blocked before any review: no reviewer ran, nothing was stamped.
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      expect(await payloads(graph.dir, id, VERDICT_MARKER)).toEqual([]);
      expect(await latestStamp(graph.dir, id)).toBeUndefined();
      expect(await audits(graph.dir, id, "judgment-closed")).toEqual([]);
      expect(heldLeases(graph.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("no git repository under observe: the issue closes, with one would-block and records that name no tree", async () => {
    const graph = makeScratchGraph({ prefix: "pbobs", seed: 1 });
    const id = graph.seededIds[0]!;
    approve(graph, id);
    const { mock, coordinator } = makeHarness({
      policy: { medium: { gates: { "tree-binding": "observe" } } },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(graph.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(graph.showIssue(id).status).toBe("closed");
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("accepted");

      const binding = (await listGateRecords(graph.dir, id)).filter(
        (r) => r.gate === "tree-binding",
      );
      expect(binding).toHaveLength(1);
      expect(binding[0]).toMatchObject({
        mode: "observe",
        result: "unknown",
        blocked: false,
        wouldBlock: true,
      });

      // Every record is there; none names a tree.
      const verdicts = await payloads(graph.dir, id, VERDICT_MARKER);
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]).not.toHaveProperty("tree");
      const stamp = await latestStamp(graph.dir, id);
      expect(stamp).toBeDefined();
      expect(stamp).not.toHaveProperty("tree");
      expect(stamp).not.toHaveProperty("baseTree");
      expect(stamp).not.toHaveProperty("commit");
      expect(stamp!.gates).toEqual({ "tree-binding": "unknown", review: "pass" });
      const review = fake.requests.find((r) => r.role === "reviewer")!;
      expect(review.workspace.path).toBe(graph.dir);
      expect(review.workspace.tree).toBeUndefined();
      expect(review.workspace.baseTree).toBeUndefined();
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      graph.cleanup();
    }
  }, 60_000);

  it("an isolated executor that reports no base revision is unknown, even in a git repository", async () => {
    const repo = makeScratchRepo({ prefix: "pbnobase", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness();
    // The default fake: isolated, and says nothing about its workspace.
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("blocked");
      const escalated = await audits(repo.dir, id, "escalated");
      expect(String(escalated[0]!.reason)).toMatch(/reported no base revision/);
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a dirty checkout before the claim is part of the base, never of the change", async () => {
    const repo = makeScratchRepo({ prefix: "pbdirty", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    write(repo, "committed.txt", "committed\n");
    commitAll(repo, "test: fixture");
    // The user's own uncommitted work, there before the issue is claimed.
    write(repo, "committed.txt", "edited by the user\n");
    write(repo, "notes.txt", "the user's scratch notes\n");
    const statusBefore = repo.git("status", "--porcelain");

    const { mock, coordinator } = makeHarness();
    // In-session style: not isolated, working in the user's checkout.
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      isolation: "none",
      workspace: { path: repo.dir },
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "the issue's work\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");

      const metadata = metadataOf(repo, id);
      const baseTree = String(metadata[WORKGRAPH_BASE_TREE_KEY]);
      const tree = String(metadata[WORKGRAPH_RESULT_TREE_KEY]);
      // The base holds what the user had; the diff holds only the issue.
      expect(fileAt(repo.dir, baseTree, "notes.txt")).toBe(
        "the user's scratch notes\n",
      );
      expect(fileAt(repo.dir, baseTree, "committed.txt")).toBe(
        "edited by the user\n",
      );
      expect(changedFiles(repo.dir, baseTree, tree)).toEqual([
        { status: "A", path: "feature.txt" },
      ]);
      // The base is an anchored snapshot, and the implementer was told of it.
      const baseCommit = String(metadata[WORKGRAPH_BASE_COMMIT_KEY]);
      expect(repo.git("rev-parse", `${baseCommit}^{tree}`)).toBe(baseTree);
      expect(fake.requests[0]!.workspace.baseRevision).toBe(baseCommit);
      expect(
        repo.git("for-each-ref", "--format=%(refname)", "refs/workgraph").split("\n"),
      ).toContain(
        proofRef(id, `${runKey(fake.requests[0]!.workflowRunId)}/base`),
      );
      // The user's checkout is as they left it, plus the issue's file.
      expect(repo.git("status", "--porcelain").split("\n").sort()).toEqual(
        [...statusBefore.split("\n"), "?? feature.txt"].sort(),
      );
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("off: nothing is snapshotted, stamped or recorded, and later roles still go to the workspace", async () => {
    const repo = makeScratchRepo({ prefix: "pboff", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness({
      policy: { medium: { gates: { "tree-binding": "off" } } },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");

      const metadata = metadataOf(repo, id);
      for (const key of [
        WORKGRAPH_WORKSPACE_PATH_KEY,
        WORKGRAPH_BASE_TREE_KEY,
        WORKGRAPH_RESULT_TREE_KEY,
        WORKGRAPH_ACCEPTED_TREE_KEY,
      ]) {
        expect(metadata[key]).toBeUndefined();
      }
      expect(await latestStamp(repo.dir, id)).toBeUndefined();
      expect((await listGateRecords(repo.dir, id)).map((r) => r.gate)).toEqual([
        "review",
      ]);
      expect(repo.git("for-each-ref", "refs/workgraph")).toBe("");
      const verdicts = await payloads(repo.dir, id, VERDICT_MARKER);
      expect(verdicts[0]).not.toHaveProperty("tree");
      // Routing is not proof: the reviewer is still sent where the work is.
      const review = fake.requests.find((r) => r.role === "reviewer")!;
      expect(review.workspace.path).toBe(repo.dir);
      expect(review.workspace.tree).toBeUndefined();
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the workspace against the tree
// ---------------------------------------------------------------------------

describe("a workspace that changes under judgment", () => {
  it("a reviewer that edits a file has its verdict discarded, and the new tree is reviewed", async () => {
    const repo = makeScratchRepo({ prefix: "pbrev", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: [
          {
            provenance: REV_PROV,
            verdict: CLEAN_VERDICT,
            // A reviewer is told not to modify anything. This one does.
            onRequest: () => write(repo, "feature.txt", "v1, fixed up by the reviewer\n"),
          },
          { provenance: REV_PROV, verdict: CLEAN_VERDICT },
        ],
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");

      const reviews = fake.requests.filter((r) => r.role === "reviewer");
      expect(reviews).toHaveLength(2);
      const reviewed = reviews.map((r) => r.workspace.tree);
      expect(reviewed[0]).toMatch(SHA);
      expect(reviewed[1]).toMatch(SHA);
      expect(reviewed[1]).not.toBe(reviewed[0]);

      // The first verdict was never recorded: only the second review's is,
      // and it names the tree that review was sent.
      const verdicts = await payloads(repo.dir, id, VERDICT_MARKER);
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]!.tree).toBe(reviewed[1]);
      expect(verdicts[0]!.executionId).toBe(fake.completions[2]!.executionId);

      const rejected = await audits(repo.dir, id, "review-rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        reason: "workspace changed during review",
        reviewedTree: reviewed[0],
        tree: reviewed[1],
        retry: 1,
      });
      const changed = await audits(repo.dir, id, "workspace-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        previousTree: reviewed[0],
        tree: reviewed[1],
        when: "during review",
      });

      // The close rests on the tree that is actually there.
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp!.tree).toBe(reviewed[1]);
      expect(metadataOf(repo, id)[WORKGRAPH_ACCEPTED_TREE_KEY]).toBe(reviewed[1]);
      expect(fileAt(repo.dir, stamp!.tree!, "feature.txt")).toBe(
        "v1, fixed up by the reviewer\n",
      );
      expect(repo.git("rev-parse", `${stamp!.commit}^{tree}`)).toBe(reviewed[1]);
      // One gate record per result: the first tree, then the second.
      const binding = (await listGateRecords(repo.dir, id)).filter(
        (r) => r.gate === "tree-binding",
      );
      expect(binding.map((r) => r.tree)).toEqual(reviewed);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a workspace that never stops changing escalates once the review retries run out", async () => {
    const repo = makeScratchRepo({ prefix: "pbspin", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness();
    let edits = 0;
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: {
          provenance: REV_PROV,
          verdict: CLEAN_VERDICT,
          onRequest: () => write(repo, "scratch.txt", `edit ${++edits}\n`),
        },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(repo.showIssue(id).status).toBe("blocked");
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      // The first review plus MAX_REVIEW_RETRIES more, then no further.
      expect(fake.requests.filter((r) => r.role === "reviewer")).toHaveLength(
        MAX_REVIEW_RETRIES + 1,
      );
      const escalated = await audits(repo.dir, id, "escalated");
      expect(escalated).toHaveLength(1);
      expect(String(escalated[0]!.reason)).toMatch(
        /workspace changed during review/,
      );
      expect(await payloads(repo.dir, id, VERDICT_MARKER)).toEqual([]);
      expect(await latestStamp(repo.dir, id)).toBeUndefined();
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a file edited after the verdict: no close on the old tree, and a second review runs", async () => {
    const repo = makeScratchRepo({ prefix: "pblate", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    let passes = 0;
    const { mock, coordinator } = makeHarness({
      // The window between the recorded verdict and the stamp: no executor
      // runs in it, so the coordinator's test seam is the only way in.
      beforeAcceptance: ({ workspacePath }) => {
        passes += 1;
        if (passes === 1) {
          writeFileSync(join(workspacePath!, "late.txt"), "after the verdict\n");
        }
      },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      expect(passes).toBe(2);

      const reviews = fake.requests.filter((r) => r.role === "reviewer");
      expect(reviews).toHaveLength(2);
      const [oldTree, newTree] = reviews.map((r) => r.workspace.tree);
      expect(newTree).not.toBe(oldTree);

      // Both verdicts stand on the trail, each naming the tree it judged.
      const verdicts = await payloads(repo.dir, id, VERDICT_MARKER);
      expect(verdicts.map((v) => v.tree)).toEqual([oldTree, newTree]);

      // Exactly one stamp, and it is not for the old tree.
      const stamps = await payloads(repo.dir, id, STAMP_MARKER);
      expect(stamps).toHaveLength(1);
      expect(stamps[0]!.tree).toBe(newTree);
      expect((stamps[0]!.verdict as { executionId: string }).executionId).toBe(
        verdicts[1]!.executionId,
      );
      expect(fileAt(repo.dir, String(newTree), "late.txt")).toBe(
        "after the verdict\n",
      );
      expect(fileAt(repo.dir, String(oldTree), "late.txt")).toBeUndefined();
      expect(metadataOf(repo, id)[WORKGRAPH_ACCEPTED_TREE_KEY]).toBe(newTree);
      const changed = await audits(repo.dir, id, "workspace-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({ when: "after the verdict" });
      expect(await audits(repo.dir, id, "judgment-closed")).toHaveLength(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("with the review gate off, a file edited before the stamp is still caught", async () => {
    const repo = makeScratchRepo({ prefix: "pboffl", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    let passes = 0;
    const { mock, coordinator } = makeHarness({
      policy: { medium: { gates: { review: "off" } } },
      beforeAcceptance: ({ workspacePath }) => {
        passes += 1;
        if (passes === 1) {
          writeFileSync(join(workspacePath!, "late.txt"), "late\n");
        }
      },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      const stamp = await latestStamp(repo.dir, id);
      expect(fileAt(repo.dir, stamp!.tree!, "late.txt")).toBe("late\n");
      // No review ran, so the stamp rests on no verdict.
      expect(stamp).not.toHaveProperty("verdict");
      expect(stamp!.gates).toEqual({ "tree-binding": "pass" });
      expect(stamp!.tree).toBe(treeOf(repo.dir));
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the stamp and finalization
// ---------------------------------------------------------------------------

describe("the close stamp", () => {
  const FINALIZATION = {
    instructions: "Publish the verified result",
    timeoutMs: 5_000,
  };
  const RECEIPT = { outcome: "success", summary: "Published" };

  it("is written before finalization, and a tree finalization changes is recorded on it", async () => {
    const repo = makeScratchRepo({ prefix: "pbfin", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness({
      config: { finalization: FINALIZATION },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "finalizer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
        finalizer: {
          finalization: RECEIPT,
          onRequest: () => write(repo, "CHANGELOG.txt", "released\n"),
        },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");

      const stamp = await latestStamp(repo.dir, id);
      const metadata = metadataOf(repo, id);
      expect(stamp!.tree).toBe(metadata[WORKGRAPH_ACCEPTED_TREE_KEY]);
      expect(stamp!.finalizedTree).toMatch(SHA);
      expect(stamp!.finalizedTree).not.toBe(stamp!.tree);
      expect(stamp!.finalizedTree).toBe(metadata[WORKGRAPH_FINALIZED_TREE_KEY]);
      expect(fileAt(repo.dir, stamp!.tree!, "CHANGELOG.txt")).toBeUndefined();
      expect(fileAt(repo.dir, stamp!.finalizedTree!, "CHANGELOG.txt")).toBe(
        "released\n",
      );
      // The finalizer was sent to the workspace, with the accepted tree.
      const finalizer = fake.requests.find((r) => r.role === "finalizer")!;
      expect(finalizer.workspace).toMatchObject({
        path: repo.dir,
        tree: stamp!.tree,
      });

      // Order on the trail: stamp, then finalization, then the amendment.
      const texts = (await listComments(repo.dir, id)).map((c) => c.text);
      const at = (prefix: string) => texts.findIndex((t) => t.startsWith(prefix));
      expect(at(STAMP_MARKER)).toBeGreaterThan(-1);
      expect(at(STAMP_MARKER)).toBeLessThan(
        at("workgraph-lease finalization-completed "),
      );
      expect(at("workgraph-lease finalization-completed ")).toBeLessThan(
        at("workgraph-proof stamp-amended "),
      );
      // The finalized tree survives gc as well.
      repo.git("gc", "--prune=now", "--quiet");
      expect(repo.git("cat-file", "-t", stamp!.finalizedTree!)).toBe("tree");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("carries no finalized tree when finalization leaves the workspace alone", async () => {
    const repo = makeScratchRepo({ prefix: "pbfinq", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness({
      config: { finalization: FINALIZATION },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "finalizer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
        finalizer: { finalization: RECEIPT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp!.tree).toMatch(SHA);
      expect(stamp).not.toHaveProperty("finalizedTree");
      expect(metadataOf(repo, id)[WORKGRAPH_FINALIZED_TREE_KEY]).toBeUndefined();
      expect(await payloads(repo.dir, id, "workgraph-proof stamp-amended ")).toEqual([]);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("that cannot be written escalates from verifying and closes nothing", async () => {
    const repo = makeScratchRepo({ prefix: "pbstampfail", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness({
      config: { finalization: FINALIZATION },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "finalizer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
        finalizer: { finalization: RECEIPT },
      },
    });
    // Only the stamp: gate records and the audit trail keep writing.
    failCommentWrites(repo.dir, STAMP_MARKER);
    const errors = captureErrors();
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(repo.showIssue(id).status).toBe("blocked");
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      const escalated = await audits(repo.dir, id, "escalated");
      expect(escalated).toHaveLength(1);
      expect(String(escalated[0]!.reason)).toMatch(
        /close stamp could not be written/,
      );
      expect(errors().some((line) => line.includes("STAMP WRITE FAILED"))).toBe(true);
      // The verdict passed and was recorded; the close still did not happen,
      // and finalization — which has external effects — never started.
      expect(await payloads(repo.dir, id, VERDICT_MARKER)).toHaveLength(1);
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "reviewer"]);
      expect(await audits(repo.dir, id, "judgment-closed")).toEqual([]);
      expect(metadataOf(repo, id)[WORKGRAPH_ACCEPTED_TREE_KEY]).toBeUndefined();
      expect(heldLeases(repo.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("one-shot work is snapshotted, stamped and amended the same way", async () => {
    const repo = makeScratchRepo({ prefix: "pbone", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, { riskTier: "low", workflowClass: "oneshot" });
    const { mock, coordinator } = makeHarness({
      config: { finalization: FINALIZATION },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "finalizer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        finalizer: {
          finalization: RECEIPT,
          onRequest: () => write(repo, "CHANGELOG.txt", "released\n"),
        },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "finalizer"]);

      const metadata = metadataOf(repo, id);
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp!.tree).toBe(metadata[WORKGRAPH_RESULT_TREE_KEY]);
      expect(stamp!.tree).toBe(metadata[WORKGRAPH_ACCEPTED_TREE_KEY]);
      expect(stamp).not.toHaveProperty("verdict");
      expect(stamp!.gates).toEqual({ "tree-binding": "pass" });
      expect(stamp!.finalizedTree).toBe(metadata[WORKGRAPH_FINALIZED_TREE_KEY]);
      expect(fileAt(repo.dir, stamp!.finalizedTree!, "CHANGELOG.txt")).toBe(
        "released\n",
      );
      // Low tier observes by default: recorded, would not have blocked.
      const records = await listGateRecords(repo.dir, id);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        gate: "tree-binding",
        mode: "observe",
        result: "pass",
        wouldBlock: false,
        tree: stamp!.tree,
      });
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("one-shot work with no git repository: observed by default, escalated from verifying under enforce", async () => {
    for (const enforce of [false, true]) {
      const graph = makeScratchGraph({ prefix: enforce ? "pboneenf" : "pboneobs", seed: 1 });
      const id = graph.seededIds[0]!;
      approve(graph, id, { riskTier: "low", workflowClass: "oneshot" });
      const { mock, coordinator } = makeHarness(
        enforce
          ? { policy: { low: { gates: { "tree-binding": "enforce" } } } }
          : {},
      );
      const fake = installFakeExecutor(mock.events, {
        roles: ["implementer"],
        roleScripts: { implementer: { provenance: IMPL_PROV } },
      });
      const ectx = makeEventContext(graph.dir);
      try {
        await drive(mock, ectx.ctx);
        const records = await listGateRecords(graph.dir, id);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          gate: "tree-binding",
          result: "unknown",
          blocked: enforce,
          wouldBlock: !enforce,
        });
        if (enforce) {
          expect(graph.showIssue(id).status).toBe("blocked");
          const escalated = await audits(graph.dir, id, "escalated");
          expect(String(escalated[0]!.reason)).toMatch(/not a git repository/);
          expect(await latestStamp(graph.dir, id)).toBeUndefined();
          expect(coordinator.current()).toBeNull();
        } else {
          expect(graph.showIssue(id).status).toBe("closed");
          expect(await latestStamp(graph.dir, id)).not.toHaveProperty("tree");
        }
        expect(heldLeases(graph.dir)).toHaveLength(0);
      } finally {
        fake.uninstall();
        await coordinator.teardown(ectx.ctx);
        graph.cleanup();
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the failure fingerprint
// ---------------------------------------------------------------------------

describe("the failure fingerprint follows the tree", () => {
  /**
   * A reviewer that returns the SAME blocking finding every time, and a
   * revisor whose `revise` hook decides whether the content changes. The
   * artifact list is identical on every attempt, so before tree binding the
   * two cases below were indistinguishable.
   */
  async function run(revise: (repo: ScratchRepo, n: number) => void) {
    const repo = makeScratchRepo({ prefix: "pbfp", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness({
      policy: { medium: { maxRevisions: 2 } },
    });
    let revisions = 0;
    const fingerprints: string[] = [];
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "revision"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          artifacts: ["feature.txt"],
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: BLOCKING_VERDICT },
        revision: {
          provenance: IMPL_PROV,
          artifacts: ["feature.txt"],
          onRequest: () => {
            fingerprints.push(
              String(metadataOf(repo, id)[WORKGRAPH_FAILURE_FINGERPRINT_KEY]),
            );
            revise(repo, ++revisions);
          },
        },
      },
    });
    const ectx = makeEventContext(repo.dir);
    captureErrors(); // promotion leaves planned work with no planner offered
    try {
      await drive(mock, ectx.ctx);
      const promoted = await audits(repo.dir, id, "workflow-promoted");
      return {
        revisions,
        fingerprints,
        reasons: promoted.map((p) => String(p.reason)),
        trees: (await payloads(repo.dir, id, VERDICT_MARKER)).map((v) => v.tree),
      };
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }

  it("identical findings on an unchanged tree are a repeat", async () => {
    const outcome = await run(() => {}); // the revision changes nothing
    expect(outcome.revisions).toBe(1);
    expect(outcome.trees).toHaveLength(2);
    expect(outcome.trees[1]).toBe(outcome.trees[0]);
    expect(outcome.reasons).toEqual([
      "repeated blocking-finding fingerprint on an unchanged artifact digest",
    ]);
  }, 60_000);

  it("identical findings on changed content are a new failure", async () => {
    const outcome = await run((repo, n) =>
      write(repo, "feature.txt", `v${n + 1}\n`),
    );
    // Never a repeat: every revision is spent, then the bound ends it.
    expect(outcome.revisions).toBe(2);
    expect(new Set(outcome.trees).size).toBe(3);
    expect(outcome.fingerprints).toHaveLength(2);
    expect(outcome.fingerprints[1]).not.toBe(outcome.fingerprints[0]);
    expect(outcome.reasons).toEqual(["maxRevisions (2) exhausted"]);
  }, 60_000);
});
