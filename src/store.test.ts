/**
 * The store's own contract, against a real SQLite workspace in a temp dir:
 * workspace discovery, the atomic claim paths, metadata merge semantics,
 * dependency-aware readiness, and the staleness query the sweep relies on.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addComment,
  addDependency,
  centralKey,
  claim,
  claimNext,
  close,
  closeWorkspace,
  configureStore,
  createIssue,
  ensureWorkspace,
  findWorkspaceRoot,
  getOpLog,
  initWorkspace,
  listComments,
  listInProgressUpdatedBefore,
  listIssues,
  ready,
  release,
  resetOpLog,
  resolveRepoRoot,
  setMetadata,
  show,
  StoreError,
  unsetMetadata,
  update,
} from "./store.ts";
import { makeScratchGraph, type ScratchGraph } from "../test/helpers/scratch.ts";

const graphs: ScratchGraph[] = [];
const dirs: string[] = [];

function makeGraph(seed = 0): ScratchGraph {
  const graph = makeScratchGraph({ seed, prefix: "st" });
  graphs.push(graph);
  return graph;
}

afterEach(() => {
  for (const graph of graphs.splice(0)) graph.cleanup();
  for (const dir of dirs.splice(0)) {
    closeWorkspace(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  resetOpLog();
});

describe("workspace", () => {
  it("initWorkspace creates the database, a .gitignore, and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-store-"));
    dirs.push(dir);
    const { root, prefix, created } = await initWorkspace(dir, { prefix: "init" });
    expect(root).toBe(dir);
    expect(prefix).toBe("init");
    expect(created).toBe(true);
    expect(existsSync(join(dir, ".workgraph", "workgraph.db"))).toBe(true);
    expect(readFileSync(join(dir, ".workgraph", ".gitignore"), "utf8")).toContain("workgraph.db");
    const first = await createIssue(dir, { title: "first" });
    expect(first.id.startsWith("init-")).toBe(true);
    // Second init is a no-op: the issue survives and the prefix is kept.
    expect((await initWorkspace(dir, { prefix: "other" })).created).toBe(false);
    const again = await createIssue(dir, { title: "second" });
    expect(again.id.startsWith("init-")).toBe(true);
  });

  it("findWorkspaceRoot walks up from a nested directory", async () => {
    const graph = makeGraph();
    const nested = join(graph.dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(graph.dir);
    await expect(ready(nested, 0)).resolves.toEqual([]);
  });

  it("ensureWorkspace throws a workgraph_init hint for an uninitialized dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-store-uninit-"));
    dirs.push(dir);
    await expect(ensureWorkspace(dir)).rejects.toThrow(/workgraph_init/);
    await expect(ready(dir)).rejects.toBeInstanceOf(StoreError);
  });
});

describe("issues", () => {
  it("ready lists seeded issues with the guaranteed fields, oldest first within a priority", async () => {
    const graph = makeGraph(3);
    const pool = await ready(graph.dir);
    expect(pool.map((i) => i.id)).toEqual(graph.seededIds);
    for (const issue of pool) {
      expect(issue).toMatchObject({ status: "open", priority: 2, issue_type: "task" });
      expect(typeof issue.title).toBe("string");
      expect(typeof issue.created_at).toBe("string");
      expect(typeof issue.updated_at).toBe("string");
    }
  });

  it("ready honors priority before creation order and returns [] on an empty pool", async () => {
    const graph = makeGraph();
    expect(await ready(graph.dir)).toEqual([]);
    const low = graph.createIssue("low", { priority: 3 });
    const high = graph.createIssue("high", { priority: 0 });
    expect((await ready(graph.dir)).map((i) => i.id)).toEqual([high, low]);
    expect(await ready(graph.dir, 1)).toHaveLength(1);
  });

  it("show throws on a nonexistent id", async () => {
    const graph = makeGraph();
    await expect(show(graph.dir, "st-zzz")).rejects.toThrow(/not found/i);
  });

  it("createIssue stamps lifecycle metadata, promotes unsafe one-shots, and wires dependencies", async () => {
    const graph = makeGraph(1);
    const [blocker] = graph.seededIds;
    const child = await createIssue(graph.dir, {
      title: "child",
      approved: true,
      workflowClass: "oneshot",
      riskTier: "high",
      acceptanceCriteria: "tests green",
      dependsOn: [blocker!],
      metadata: { custom: "kept" },
    });
    expect(child.metadata).toMatchObject({
      workgraph_lifecycle_version: 1,
      workgraph_phase: "ready",
      workgraph_workflow_class: "reviewed",
      workgraph_risk_tier: "high",
      custom: "kept",
    });
    expect(child.acceptance_criteria).toBe("tests green");
    expect(child.dependencies?.map((d) => d.id)).toEqual([blocker]);
    // Blocked until the blocker closes.
    expect((await ready(graph.dir, 0)).map((i) => i.id)).toEqual([blocker]);
    await close(graph.dir, blocker!, "done");
    expect((await ready(graph.dir, 0)).map((i) => i.id)).toEqual([child.id]);
  });

  it("addDependency blocks the dependent until the dependency closes and rejects self-dependency", async () => {
    const graph = makeGraph(2);
    const [a, b] = graph.seededIds;
    await addDependency(graph.dir, a!, b!);
    await addDependency(graph.dir, a!, b!); // idempotent
    expect((await ready(graph.dir, 0)).map((i) => i.id)).toEqual([b]);
    await expect(addDependency(graph.dir, a!, a!)).rejects.toThrow(/itself/);
    await close(graph.dir, b!);
    expect((await ready(graph.dir, 0)).map((i) => i.id)).toEqual([a]);
  });

  it("update changes only the given fields; close records the reason; reopening clears closed_at", async () => {
    const graph = makeGraph(1);
    const id = graph.seededIds[0]!;
    await update(graph.dir, id, { title: "renamed", acceptance: "ac", priority: 1 });
    let shown = await show(graph.dir, id);
    expect(shown).toMatchObject({ title: "renamed", acceptance_criteria: "ac", priority: 1, status: "open" });
    await update(graph.dir, id, {}); // no-op
    await close(graph.dir, id, "because", "closer");
    shown = await show(graph.dir, id);
    expect(shown.status).toBe("closed");
    expect(shown.close_reason).toBe("because");
    expect(typeof shown.closed_at).toBe("string");
    await update(graph.dir, id, { status: "open" });
    shown = await show(graph.dir, id);
    expect(shown.status).toBe("open");
    expect(shown.closed_at).toBeUndefined();
  });

  it("listIssues filters by status", async () => {
    const graph = makeGraph(2);
    await close(graph.dir, graph.seededIds[0]!);
    expect((await listIssues(graph.dir)).map((i) => i.id)).toEqual(graph.seededIds);
    expect((await listIssues(graph.dir, { status: "closed" })).map((i) => i.id)).toEqual([
      graph.seededIds[0],
    ]);
  });
});

describe("claims", () => {
  it("claimNext atomically claims the next ready issue and returns null on an empty pool", async () => {
    const graph = makeGraph(1);
    const claimed = await claimNext(graph.dir, "worker-a");
    expect(claimed?.id).toBe(graph.seededIds[0]);
    expect(claimed).toMatchObject({ status: "in_progress", assignee: "worker-a" });
    expect(await claimNext(graph.dir, "worker-b")).toBeNull();
  });

  it("claim by id rejects a conflicting claim, is idempotent for the same actor, and refuses closed issues", async () => {
    const graph = makeGraph(2);
    const [id, other] = graph.seededIds;
    await claim(graph.dir, id!, "worker-a");
    await claim(graph.dir, id!, "worker-a"); // idempotent
    await expect(claim(graph.dir, id!, "worker-b")).rejects.toThrow(/already claimed by worker-a/);
    expect((await show(graph.dir, id!)).assignee).toBe("worker-a");
    await close(graph.dir, other!);
    await expect(claim(graph.dir, other!, "worker-a")).rejects.toThrow(/closed/);
    await expect(claim(graph.dir, "st-nope", "worker-a")).rejects.toThrow(/not found/i);
  });

  it("release clears the assignee and lease holder/expiry, reopens, and keeps the epoch", async () => {
    const graph = makeGraph(1);
    const id = graph.seededIds[0]!;
    await claim(graph.dir, id, "worker-a");
    await setMetadata(graph.dir, id, {
      lease_holder: "worker-a",
      lease_epoch: "3",
      lease_expires_at: "2030-01-01T00:00:00Z",
    });
    await release(graph.dir, id, "worker-a");
    const shown = await show(graph.dir, id);
    expect(shown.status).toBe("open");
    expect(shown.assignee).toBeUndefined();
    expect(shown.metadata).toEqual({ lease_epoch: "3" });
    expect((await ready(graph.dir, 0)).map((i) => i.id)).toEqual([id]);
  });
});

describe("metadata and comments", () => {
  it("setMetadata merges per key, round-trips values as written, and unsetMetadata removes keys", async () => {
    const graph = makeGraph(1);
    const id = graph.seededIds[0]!;
    await setMetadata(graph.dir, id, { a: "1", b: "two" });
    await setMetadata(graph.dir, id, { b: "three", c: 4 });
    expect((await show(graph.dir, id)).metadata).toEqual({ a: "1", b: "three", c: 4 });
    await unsetMetadata(graph.dir, id, ["a", "missing"]);
    expect((await show(graph.dir, id)).metadata).toEqual({ b: "three", c: 4 });
    await setMetadata(graph.dir, id, {}); // no-op, no error
  });

  it("every write bumps updated_at, which drives listInProgressUpdatedBefore", async () => {
    const graph = makeGraph(2);
    const [stale, fresh] = graph.seededIds;
    await claim(graph.dir, stale!, "w-stale");
    await claim(graph.dir, fresh!, "w-fresh");
    const before = (await show(graph.dir, fresh!)).updated_at!;
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await setMetadata(graph.dir, fresh!, { lease_expires_at: "x" }); // heartbeat-like touch
    expect((await show(graph.dir, fresh!)).updated_at! > before).toBe(true);
    const found = await listInProgressUpdatedBefore(graph.dir, cutoff);
    expect(found.map((i) => i.id)).toEqual([stale]);
    await expect(listInProgressUpdatedBefore(graph.dir, "garbage")).rejects.toThrow(/cutoff/);
  });

  it("comments append in order with their author", async () => {
    const graph = makeGraph(1);
    const id = graph.seededIds[0]!;
    expect(await listComments(graph.dir, id)).toEqual([]);
    await addComment(graph.dir, id, "workgraph-lease claim {}", "w-a");
    await addComment(graph.dir, id, "second");
    const comments = await listComments(graph.dir, id);
    expect(comments.map((c) => c.text)).toEqual(["workgraph-lease claim {}", "second"]);
    expect(comments[0]).toMatchObject({ issue_id: id, author: "w-a" });
    expect(comments[1]!.author).toBeUndefined();
    await expect(addComment(graph.dir, "st-nope", "x")).rejects.toThrow(/not found/i);
  });

  it("records operations into the op log in execution order", async () => {
    const graph = makeGraph(1);
    resetOpLog();
    await ready(graph.dir);
    await claim(graph.dir, graph.seededIds[0]!, "w");
    const ops = getOpLog().map((e) => e.op);
    expect(ops).toEqual(["ready", "claim"]);
    expect(getOpLog()[1]!.issueId).toBe(graph.seededIds[0]);
  });
});

describe("central store policy", () => {
  afterEach(() => {
    configureStore("repo");
  });

  it("keeps the database out of the checkout, keyed by the repository, and finds it from nested dirs", async () => {
    const central = mkdtempSync(join(tmpdir(), "pi-workgraph-central-"));
    const repo = mkdtempSync(join(tmpdir(), "pi-workgraph-repo-"));
    dirs.push(central, repo);
    mkdirSync(join(repo, ".git"), { recursive: true });
    const policy = configureStore(central);
    expect(policy).toEqual({ mode: "central", centralDir: central });

    const nested = join(repo, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const init = await initWorkspace(nested, { prefix: "cen" });
    expect(init.root).toBe(repo);
    expect(init.created).toBe(true);
    expect(init.databasePath).toBe(join(central, centralKey(repo), "workgraph.db"));
    expect(existsSync(init.databasePath)).toBe(true);
    expect(readFileSync(join(central, centralKey(repo), "repo"), "utf8").trim()).toBe(repo);
    expect(existsSync(join(repo, ".workgraph"))).toBe(false);

    expect(findWorkspaceRoot(nested)).toBe(repo);
    const issue = await createIssue(nested, { title: "from a subdir" });
    expect(issue.id.startsWith("cen-")).toBe(true);
    expect((await ready(repo, 0)).map((i) => i.id)).toEqual([issue.id]);
    expect((await initWorkspace(repo)).created).toBe(false);
  });

  it("resolves a git worktree to its main checkout, so workers share the graph", async () => {
    const central = mkdtempSync(join(tmpdir(), "pi-workgraph-central-"));
    const main = mkdtempSync(join(tmpdir(), "pi-workgraph-main-"));
    dirs.push(central, main);
    configureStore(central);
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    const worktree = join(main, ".git", "workgraph-worktrees", "wt");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);

    expect(resolveRepoRoot(worktree)).toBe(main);
    expect(resolveRepoRoot(main)).toBe(main);
    await initWorkspace(main, { prefix: "wt" });
    const issue = await createIssue(main, { title: "shared" });
    expect(findWorkspaceRoot(worktree)).toBe(main);
    expect((await ready(worktree, 0)).map((i) => i.id)).toEqual([issue.id]);
  });

  it("an existing in-repo store wins over the central policy", async () => {
    const central = mkdtempSync(join(tmpdir(), "pi-workgraph-central-"));
    dirs.push(central);
    const graph = makeGraph(1); // repo-mode scratch workspace
    configureStore(central);
    expect(findWorkspaceRoot(graph.dir)).toBe(graph.dir);
    expect((await initWorkspace(graph.dir)).databasePath).toBe(join(graph.dir, ".workgraph", "workgraph.db"));
    expect((await ready(graph.dir, 0)).map((i) => i.id)).toEqual(graph.seededIds);
    expect(existsSync(join(central, centralKey(graph.dir)))).toBe(false);
  });

  it("centralKey is stable, readable, and path-sensitive", () => {
    expect(centralKey("/tmp/My Repo")).toMatch(/^my-repo-[0-9a-f]{12}$/);
    expect(centralKey("/tmp/My Repo")).toBe(centralKey("/tmp/My Repo"));
    expect(centralKey("/tmp/My Repo")).not.toBe(centralKey("/other/My Repo"));
  });
});
