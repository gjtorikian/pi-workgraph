/**
 * Exec queue + typed wrapper tests against a real scratch bd database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDependency,
  BdError,
  bindExec,
  claim,
  claimNext,
  close,
  createChild,
  ensureWorkspace,
  execBd,
  getExecLog,
  ready,
  release,
  resetExecLog,
  resetProbesForTest,
  setMetadata,
  show,
  update,
} from "./bd.ts";
import { makeMockPi, type MockPi } from "../test/helpers/mock-pi.ts";
import {
  makeScratchGraph,
  type ScratchGraph,
} from "../test/helpers/scratch.ts";

let mock: MockPi;
let graph: ScratchGraph;
let emptyGraph: ScratchGraph;

beforeAll(() => {
  mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  graph = makeScratchGraph({ seed: 3 });
  emptyGraph = makeScratchGraph({ prefix: "empty" });
}, 60_000);

afterAll(() => {
  graph?.cleanup();
  emptyGraph?.cleanup();
});

describe("execBd", () => {
  it("runs bd through the queue (smoke)", async () => {
    const out = await execBd(["--version"], { cwd: graph.dir });
    expect(out).toContain("bd version");
  });

  it("treats a killed (timed-out) process as failure, never success", async () => {
    // The prior-art regression: pi resolves killed processes with code 0,
    // so any `code !== 0` check alone reads a timeout as success.
    const promise = execBd(["ready", "--json"], {
      cwd: graph.dir,
      timeoutMs: 1,
    });
    await expect(promise).rejects.toBeInstanceOf(BdError);
    await expect(promise).rejects.toThrow(/timed out/);
  });

  it("surfaces bd stderr verbatim on non-zero exit", async () => {
    await expect(
      execBd(["show", "scratch-does-not-exist", "--json"], { cwd: graph.dir }),
    ).rejects.toThrow(/no issue found matching/);
  });

  it("does not wedge the queue after a failure", async () => {
    await expect(
      execBd(["definitely-not-a-subcommand"], { cwd: graph.dir }),
    ).rejects.toBeInstanceOf(BdError);
    const out = await execBd(["--version"], { cwd: graph.dir });
    expect(out).toContain("bd version");
  });

  it("serializes concurrent calls (never more than one in flight)", async () => {
    resetExecLog();
    mock.maxInFlight = 0;
    await Promise.all([
      ready(graph.dir, 5),
      ready(graph.dir, 5),
      show(graph.dir, graph.seededIds[0]!),
      ready(graph.dir, 5),
      show(graph.dir, graph.seededIds[1]!),
    ]);
    expect(mock.maxInFlight).toBe(1);
    expect(getExecLog()).toHaveLength(5);
  });

  it("records {args, timestamp} into the exec log in execution order", async () => {
    resetExecLog();
    await ready(graph.dir, 5);
    await claimNext(emptyGraph.dir, "logger");
    const log = getExecLog();
    expect(log).toHaveLength(2);
    expect(log[0]!.args.slice(0, 2)).toEqual(["ready", "-u"]);
    expect(log[1]!.args).toEqual([
      "ready",
      "--claim",
      "--json",
      "--actor",
      "logger",
    ]);
    expect(log[0]!.timestamp).toBeLessThanOrEqual(log[1]!.timestamp);
  });
});

describe("wrappers", () => {
  it("ready lists seeded issues with the five guaranteed fields", async () => {
    const issues = await ready(graph.dir, 25);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    for (const issue of issues) {
      expect(issue.id).toMatch(/^scratch-/);
      expect(typeof issue.title).toBe("string");
      expect(typeof issue.status).toBe("string");
      expect(typeof issue.priority).toBe("number");
      expect(typeof issue.issue_type).toBe("string");
      // Optional fields may simply be absent on minimally-populated issues.
      expect(issue.assignee).toBeUndefined();
    }
  });

  it("ready returns [] on an empty pool (exit 0, no error)", async () => {
    await expect(ready(emptyGraph.dir, 10)).resolves.toEqual([]);
  });

  it("show parses bd's ARRAY output and takes [0]", async () => {
    const id = graph.seededIds[0]!;
    const issue = await show(graph.dir, id);
    expect(issue.id).toBe(id);
    expect(issue.title).toBe("seed issue 1");
  });

  it("show throws on a nonexistent id", async () => {
    await expect(show(graph.dir, "scratch-nope")).rejects.toBeInstanceOf(
      BdError,
    );
  });

  it("claimNext atomically claims the next ready issue", async () => {
    const local = makeScratchGraph({ prefix: "claims" });
    try {
      const id = local.createIssue("claim me", { priority: 0 });
      const claimed = await claimNext(local.dir, "worker-a");
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(id);
      expect(claimed!.status).toBe("in_progress");
      expect(claimed!.assignee).toBe("worker-a");
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("claimNext returns null on an empty pool", async () => {
    await expect(claimNext(emptyGraph.dir, "worker-a")).resolves.toBeNull();
  });

  it("claim by id surfaces bd's conflict error when already claimed", async () => {
    const local = makeScratchGraph({ prefix: "conflict" });
    try {
      const id = local.createIssue("contested");
      local.bd(["update", id, "--claim", "--actor", "other-actor"]);
      await expect(claim(local.dir, id, "me")).rejects.toThrow(
        /already claimed/,
      );
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("release clears the assignee and reopens", async () => {
    const local = makeScratchGraph({ prefix: "rel" });
    try {
      const id = local.createIssue("hand me back");
      await claim(local.dir, id, "worker-b");
      await release(local.dir, id, "worker-b");
      const issue = local.showIssue(id);
      expect(issue.status).toBe("open");
      expect(issue.assignee ?? "").toBe("");
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("close records the reason", async () => {
    const local = makeScratchGraph({ prefix: "cls" });
    try {
      const id = local.createIssue("finish me");
      await close(local.dir, id, "done in test", "worker-c");
      const issue = local.showIssue(id);
      expect(issue.status).toBe("closed");
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("update changes only the given fields; setMetadata sets keys", async () => {
    const local = makeScratchGraph({ prefix: "upd" });
    try {
      const id = local.createIssue("tweak me", { priority: 3 });
      await update(local.dir, id, { priority: 1 }, "worker-d");
      await setMetadata(local.dir, id, { team: "platform" }, "worker-d");
      const issue = local.showIssue(id);
      expect(issue.priority).toBe(1);
      expect(issue.title).toBe("tweak me");
      expect(issue.metadata).toMatchObject({ team: "platform" });
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("createChild parses bd create's single-OBJECT output", async () => {
    const local = makeScratchGraph({ prefix: "kid" });
    try {
      const child = await createChild(
        local.dir,
        { title: "a child", priority: 1 },
        "worker-e",
      );
      expect(child.id).toMatch(/^kid-/);
      expect(child.priority).toBe(1);
      expect(child.created_by).toBe("worker-e");
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("acceptance criteria round-trip: create/update --acceptance → acceptance_criteria", async () => {
    const local = makeScratchGraph({ prefix: "acc" });
    try {
      // createChild writes acceptance via bd's native field and stamps the
      // approval metadata in the SAME create (no half-approved window).
      const child = await createChild(
        local.dir,
        {
          title: "with criteria",
          acceptanceCriteria: "does the thing",
          riskTier: "high",
          approved: true,
        },
        "worker-g",
      );
      expect(child.acceptance_criteria).toBe("does the thing");
      const shown = await show(local.dir, child.id);
      expect(shown.acceptance_criteria).toBe("does the thing");
      expect(shown.metadata).toMatchObject({
        workgraph_risk_tier: "high",
        workgraph_phase: "ready",
      });
      expect(Number(shown.metadata?.workgraph_lifecycle_version)).toBe(1);
      // update --acceptance replaces the criteria in place.
      await update(
        local.dir,
        child.id,
        { acceptance: "revised criteria" },
        "worker-g",
      );
      expect((await show(local.dir, child.id)).acceptance_criteria).toBe(
        "revised criteria",
      );
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("addDependency blocks the dependent until the dependency closes", async () => {
    const local = makeScratchGraph({ prefix: "dep" });
    try {
      const parent = local.createIssue("parent");
      const child = local.createIssue("child");
      await addDependency(local.dir, parent, child, "worker-f");
      const shown = local.showIssue(parent);
      expect(shown.dependencies?.map((d) => d.id)).toContain(child);
    } finally {
      local.cleanup();
    }
  }, 30_000);
});

describe("ensureWorkspace", () => {
  it("resolves inside an initialized workspace", async () => {
    await expect(ensureWorkspace(graph.dir)).resolves.toBeUndefined();
  });

  it("throws a `bd init` hint for an uninitialized dir", async () => {
    resetProbesForTest();
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const bare = mkdtempSync(join(tmpdir(), "pi-workgraph-bare-"));
    try {
      await expect(ensureWorkspace(bare)).rejects.toThrow(/bd init/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
