/**
 * The diff guards (proof-of-success phase 5): three checks on the difference
 * between a run's base tree and its result tree that stop an implementer
 * from moving the bar it is judged against.
 *
 *   weakened-tests  a test file deleted, or a skip marker added
 *   unproven-tests  new or changed tests that pass without the change
 *   scope           a file changed outside the approved plan's paths
 *
 * The first half of this file is the pure parts: the glob matcher, the
 * marker patterns, the scope rule, the plan's path targets, and the two git
 * helpers the guards read through. The second half drives the coordinator
 * on `shippedConfig` with NO policy, in a real git repository, with check
 * commands that are small shell scripts: a violation gets one revision
 * round and then a question for a human; a guard that cannot tell records
 * `unknown` and blocks nothing.
 *
 * This file holds skip markers as fixture text. It is one of the two files
 * the repository's own no-skipped-tests check leaves out; no suite here is
 * skipped.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { barDifferences, barDigest, buildBar, commandDigest, parseBar } from "../src/check.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import { registerCoordinator, type CoordinatorController } from "../src/coordinator.ts";
import {
  DEFAULT_TEST_GLOBS,
  globToRegExp,
  guardQuestion,
  hasSkipMarker,
  isTestFile,
  listFiles,
  MAX_LISTED_FILES,
  scopeGuard,
  SKIP_MARKERS,
  testChanges,
  touchedPaths,
  weakenedTests,
} from "../src/guards.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import { planPathTargets } from "../src/plan.ts";
import type { PolicyOverrides } from "../src/policy.ts";
import {
  latestStamp,
  listGateRecords,
  listReceipts,
  type GateRecord,
} from "../src/proof.ts";
import {
  addedLines,
  changedFiles,
  checkoutPaths,
  treeOf,
  withWorktree,
} from "../src/snapshot.ts";
import { listComments } from "../src/store.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import {
  WORKGRAPH_ATTEMPT_KEY,
  WORKGRAPH_DECISION_GATE_KEY,
  WORKGRAPH_DECISION_QUESTION_KEY,
  WORKGRAPH_GUARD_ALLOWED_BY_KEY,
  WORKGRAPH_GUARD_ALLOWED_KEY,
  WORKGRAPH_GUARD_ROUNDS_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_RESULT_TREE_KEY,
  type FindingT,
  type PlanT,
  type VerdictT,
  type WorkIssue,
} from "../src/types.ts";
import { shippedConfig } from "./helpers/config.ts";
import {
  installFakeExecutor,
  type FakeExecutorHandle,
  type FakeExecutorOptions,
} from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockEventContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchRepo, type ScratchRepo } from "./helpers/scratch.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetLeasesForTest();
  resetIdentityForTest();
});

/** Write a file in the repository, creating its directory. */
function writeIn(repo: ScratchRepo, file: string, content: string): void {
  const path = join(repo.dir, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
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

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

describe("classification", () => {
  it("turns a glob into an anchored pattern: ** crosses directories, * and ? do not", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/lib/a.ts")).toBe(false);
    expect(globToRegExp("src/**").test("src/lib/a.ts")).toBe(true);
    expect(globToRegExp("src/**/a.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**/a.ts").test("src/x/y/a.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("a/.ts")).toBe(false);
    // Every other character is literal.
    expect(globToRegExp("a.ts").test("abts")).toBe(false);
    expect(globToRegExp("app/[id]/page.tsx").test("app/[id]/page.tsx")).toBe(true);
    expect(globToRegExp("app/[id]/page.tsx").test("app/i/page.tsx")).toBe(false);
    expect(globToRegExp("a+b(c).ts").test("a+b(c).ts")).toBe(true);
    // A glob with no slash matches a file name at any depth.
    expect(globToRegExp("*.md").test("docs/guide/a.md")).toBe(true);
    expect(globToRegExp("*.md").test("a.md")).toBe(true);
  });

  it("classifies test files by the default globs", () => {
    for (const path of [
      "src/a.test.ts",
      "a.test.ts",
      "src/widget.spec.tsx",
      "pkg/tests/x.py",
      "pkg/test_retry.py",
      "foo_test.go",
      "internal/retry/retry_test.go",
      "test/helpers/scratch.ts",
      "src/__tests__/a.ts",
    ]) {
      expect([path, isTestFile(path, DEFAULT_TEST_GLOBS)]).toEqual([path, true]);
    }
    for (const path of [
      "src/testing.ts",
      "README.md",
      "contest/a.ts",
      "src/latest/a.ts",
      "src/attest.ts",
      "protest.py",
    ]) {
      expect([path, isTestFile(path, DEFAULT_TEST_GLOBS)]).toEqual([path, false]);
    }
  });

  it("uses the repository's globs instead of the defaults when given", () => {
    const globs = ["spec/**", "*_spec.rb"];
    expect(isTestFile("spec/models/user.rb", globs)).toBe(true);
    expect(isTestFile("lib/user_spec.rb", globs)).toBe(true);
    // Replaced, not extended.
    expect(isTestFile("src/a.test.ts", globs)).toBe(false);
  });

  const MARKED: readonly string[] = [
    `  it.skip("retries twice", async () => {`,
    `test.skip('not yet', () => {});`,
    `describe.skip("the slow suite", () => {`,
    `  it.concurrent.skip("in parallel", async () => {`,
    `  it.todo("handles a timeout");`,
    `  test.only("just this one", () => {`,
    `describe.only("focus", () => {`,
    `  xit("retries twice", () => {`,
    `xdescribe("the slow suite", () => {`,
    `@pytest.mark.skip(reason="flaky")`,
    `@pytest.mark.skipif(sys.platform == "win32", reason="posix only")`,
    `    @unittest.skip("not ready")`,
    `\tt.Skip("needs a database")`,
    `\tt.Skipf("needs %s", dependency)`,
    `\tt.SkipNow()`,
    `    #[ignore]`,
    `    #[ignore = "slow"]`,
    `    @Disabled("until the fix lands")`,
    `    @Ignore`,
  ];

  const UNMARKED: readonly string[] = [
    `// we skip the cache when the key is missing`,
    `  it("skips nothing when the list is empty", () => {`,
    `  process.exit(1);`,
    `  await child.waitForExit();`,
    `@IgnoreProperties(ignoreUnknown = true)`,
    `@DisabledFeatureFlag`,
    `  reader.skip(4);`,
    `  const only = items.filter(isOnly);`,
    `  t.Skipper(next)`,
    `  expect(todo.length).toBe(0);`,
  ];

  it.each(MARKED)("reads %j as a skip marker", (line) => {
    expect(hasSkipMarker(line)).toBe(true);
  });

  it.each(UNMARKED)("does not read %j as a skip marker", (line) => {
    expect(hasSkipMarker(line)).toBe(false);
  });

  it("exports the patterns and caps a long file list", () => {
    expect(SKIP_MARKERS.length).toBeGreaterThan(5);
    const many = Array.from({ length: MAX_LISTED_FILES + 3 }, (_, i) => `f${i}.ts`);
    expect(listFiles(["a.ts", "b.ts"])).toBe("a.ts, b.ts");
    expect(listFiles(many)).toBe(`${many.slice(0, MAX_LISTED_FILES).join(", ")} and 3 more`);
  });
});

// ---------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------

describe("scope", () => {
  const scope = (changed: string[], targets: string[] | undefined) =>
    scopeGuard(changed, targets, DEFAULT_TEST_GLOBS);

  it("passes a change inside the plan's paths, and names the files outside them", () => {
    expect(scope(["src/a.ts"], ["src/a.ts"])).toEqual({ result: "pass", files: [] });
    expect(scope(["src/a.ts", "src/b.ts"], ["src/a.ts"])).toEqual({
      result: "violation",
      files: ["src/b.ts"],
      reason: "files changed outside the approved plan's paths: src/b.ts",
    });
  });

  it("never counts a test file, a lockfile beside a changed manifest, or the store's own directory", () => {
    expect(scope(["src/a.ts", "src/a.test.ts"], ["src/a.ts"]).result).toBe("pass");
    expect(scope(["package.json", "package-lock.json"], ["package.json"]).result).toBe("pass");
    expect(scope(["src/a.ts", ".workgraph/.gitignore"], ["src/a.ts"]).result).toBe("pass");
    // A lockfile on its own is a change nobody planned.
    expect(scope(["src/a.ts", "package-lock.json"], ["src/a.ts"]).files).toEqual([
      "package-lock.json",
    ]);
    // The manifest must be the one beside it: another package's does not count.
    expect(
      scope(
        ["packages/a/package.json", "packages/b/pnpm-lock.yaml"],
        ["packages/a/package.json"],
      ).files,
    ).toEqual(["packages/b/pnpm-lock.yaml"]);
    expect(
      scope(["crates/x/Cargo.toml", "crates/x/Cargo.lock"], ["crates/x/Cargo.toml"]).result,
    ).toBe("pass");
    expect(scope(["go.mod", "go.sum"], ["go.mod"]).result).toBe("pass");
    expect(scope(["pyproject.toml", "uv.lock"], ["pyproject.toml"]).result).toBe("pass");
  });

  it("reads a directory target as everything under it, and a target with * as a glob", () => {
    expect(scope(["src/lib/a.ts", "src/lib/deep/b.ts"], ["src/lib"]).result).toBe("pass");
    expect(scope(["src/lib/a.ts"], ["src/lib/"]).result).toBe("pass");
    expect(scope(["src/library.ts"], ["src/lib"]).files).toEqual(["src/library.ts"]);
    expect(scope(["docs/a.md", "docs/guide/b.md"], ["docs/**/*.md"]).result).toBe("pass");
    expect(scope(["docs/a.md", "docs/a.txt"], ["docs/*.md"]).files).toEqual(["docs/a.txt"]);
  });

  it("is not applicable without an approved plan, or with a plan that names no path", () => {
    expect(scope(["src/a.ts"], undefined)).toEqual({
      result: "not-applicable",
      files: [],
      reason: "no plan was approved at the plan gate",
    });
    expect(scope(["src/a.ts"], [])).toEqual({
      result: "not-applicable",
      files: [],
      reason: "the approved plan names no file paths",
    });
  });

  it("takes the path-like targets of a plan and ignores symbols and prose", () => {
    const plan: PlanT = {
      steps: [
        {
          description: "add the helper",
          targets: [
            "src/retry.ts",
            "./src/client.ts",
            "`src/config.ts`",
            "src/a.ts:42",
            "src/b.ts:42:7,",
            "src/lib/",
            "docs/*.md",
            "package.json",
            ".gitignore",
            "retryWithBackoff()",
            "RetryPolicy",
            "the retry loop",
            "Makefile",
          ],
        },
        // Named twice: listed once.
        { description: "wire it", targets: ["src/retry.ts", "test/retry.test.ts"] },
        { description: "nothing to name" },
      ],
    };
    expect(planPathTargets(plan)).toEqual([
      "src/retry.ts",
      "src/client.ts",
      "src/config.ts",
      "src/a.ts",
      "src/b.ts",
      "src/lib/",
      "docs/*.md",
      "package.json",
      ".gitignore",
      "test/retry.test.ts",
    ]);
    // A plan whose only targets are symbol names has no path to hold to.
    const symbols: PlanT = {
      steps: [{ description: "refactor", targets: ["parseConfig()", "RetryPolicy", "the loader"] }],
    };
    expect(planPathTargets(symbols)).toEqual([]);
    expect(scope(["src/a.ts"], planPathTargets(symbols)).result).toBe("not-applicable");
  });

  it("asks one question that names each gate and says what the two answers do", () => {
    const question = guardQuestion([
      { gate: "weakened-tests", reason: "skip markers added: tests/a.test.sh" },
    ]);
    expect(question).toBe(
      'The weakened-tests guard still finds a violation after one revision round (weakened-tests: skip markers added: tests/a.test.sh). Reply "allow" to accept these changes, or describe what to change.',
    );
    const both = guardQuestion([
      { gate: "weakened-tests", reason: "test files deleted: t.sh" },
      { gate: "scope", reason: "files changed outside the approved plan's paths: b.ts" },
    ]);
    expect(both).toContain("weakened-tests: test files deleted: t.sh; scope: files changed");
    expect(both.endsWith('Reply "allow" to accept these changes, or describe what to change.')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the bar
// ---------------------------------------------------------------------------

describe("what the guards read is frozen on the bar", () => {
  const issue = { id: "x-1", title: "t", metadata: { workgraph_risk_tier: "medium" } } as unknown as WorkIssue;

  it("carries setup, testGlobs and the plan's paths, and leaves a bar without them as it was", () => {
    const plain = buildBar(issue, {});
    expect(plain).not.toHaveProperty("setup");
    expect(plain).not.toHaveProperty("testGlobs");
    expect(plain).not.toHaveProperty("planTargets");

    const bar = buildBar(
      issue,
      { check: { command: "npm test", setup: "npm ci", testGlobs: ["spec/**"] } },
      ["src/a.ts"],
    );
    expect(bar).toMatchObject({ setup: "npm ci", testGlobs: ["spec/**"], planTargets: ["src/a.ts"] });
    expect(barDigest(bar)).not.toBe(barDigest(plain));
    // A restart reads the same bar back from the `bar-frozen` event.
    const restored = parseBar(JSON.parse(JSON.stringify(bar)));
    expect(restored).toEqual(bar);
    expect(barDigest(restored!)).toBe(barDigest(bar));
    // An approved plan that names no path is not the same as no approved plan.
    expect(buildBar(issue, {}, []).planTargets).toEqual([]);
    expect(parseBar({ ...bar, testGlobs: "spec/**" })).toBeUndefined();
  });

  it("names setup, testGlobs and planTargets when they differ", () => {
    const frozen = buildBar(issue, { check: { setup: "npm ci", testGlobs: ["spec/**"] } }, ["src/a.ts"]);
    const current = buildBar(issue, { check: { setup: "exit 1", testGlobs: ["nothing/**"] } }, ["**"]);
    expect(barDifferences(frozen, current)).toEqual(["setup", "testGlobs", "planTargets"]);
    expect(barDifferences(frozen, buildBar(issue, { check: { setup: "npm ci", testGlobs: ["spec/**"] } }, ["src/a.ts"]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reading two trees
// ---------------------------------------------------------------------------

describe("reading the diff between two trees", () => {
  /** Two trees of one repository: the files as given, then as `change` left them. */
  function trees(
    prefix: string,
    files: Record<string, string>,
    change: (repo: ScratchRepo) => void,
  ): { repo: ScratchRepo; base: string; tree: string } {
    const repo = makeScratchRepo({ prefix });
    for (const [file, content] of Object.entries(files)) writeIn(repo, file, content);
    const base = treeOf(repo.dir);
    change(repo);
    return { repo, base, tree: treeOf(repo.dir) };
  }

  const TEST_BODY = `it("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\n`;
  const weakened = (t: { repo: ScratchRepo; base: string; tree: string }) =>
    weakenedTests(t.repo.dir, t.base, t.tree, DEFAULT_TEST_GLOBS);

  it("a deleted test file is a violation", () => {
    const t = trees("dgdel", { "src/a.test.ts": TEST_BODY, "src/a.ts": "export {};\n" }, (repo) =>
      rmSync(join(repo.dir, "src/a.test.ts")),
    );
    try {
      expect(weakened(t)).toEqual({
        result: "violation",
        files: ["src/a.test.ts"],
        reason: "test files deleted: src/a.test.ts",
      });
    } finally {
      t.repo.cleanup();
    }
  });

  it("a renamed test file is not a deletion, unless its new path is no longer a test", () => {
    const moved = trees("dgren", { "src/a.test.ts": TEST_BODY }, (repo) => {
      writeIn(repo, "src/math/add.test.ts", TEST_BODY);
      rmSync(join(repo.dir, "src/a.test.ts"));
    });
    const hidden = trees("dghid", { "src/a.test.ts": TEST_BODY }, (repo) => {
      writeIn(repo, "src/a.disabled.ts", TEST_BODY);
      rmSync(join(repo.dir, "src/a.test.ts"));
    });
    try {
      expect(changedFiles(moved.repo.dir, moved.base, moved.tree)).toEqual([
        { status: "R", path: "src/math/add.test.ts", oldPath: "src/a.test.ts" },
      ]);
      expect(weakened(moved)).toEqual({ result: "pass", files: [] });
      // Renamed and unchanged: nothing for unproven-tests to run either.
      expect(
        testChanges(
          moved.repo.dir,
          moved.base,
          moved.tree,
          changedFiles(moved.repo.dir, moved.base, moved.tree),
          DEFAULT_TEST_GLOBS,
        ),
      ).toEqual({ apply: [], remove: [] });

      expect(weakened(hidden)).toMatchObject({
        result: "violation",
        files: ["src/a.test.ts"],
      });
    } finally {
      moved.repo.cleanup();
      hidden.repo.cleanup();
    }
  });

  it("a skip marker added to an existing test is a violation; one that was already there is not", () => {
    const added = trees("dgskip", { "src/a.test.ts": TEST_BODY }, (repo) =>
      writeIn(repo, "src/a.test.ts", TEST_BODY.replace("it(", "it.skip(")),
    );
    const already = trees(
      "dgold",
      { "src/a.test.ts": `it.skip("later", () => {});\n${TEST_BODY}` },
      (repo) =>
        writeIn(
          repo,
          "src/a.test.ts",
          `it.skip("later", () => {});\n${TEST_BODY}it("subtracts", () => {});\n`,
        ),
    );
    try {
      expect(weakened(added)).toEqual({
        result: "violation",
        files: ["src/a.test.ts"],
        reason: "skip markers added: src/a.test.ts",
      });
      expect(weakened(already)).toEqual({ result: "pass", files: [] });
    } finally {
      added.repo.cleanup();
      already.repo.cleanup();
    }
  });

  it("a new test file with no marker passes, and so does a change to non-test files only", () => {
    const fresh = trees("dgnew", { "src/a.ts": "export {};\n" }, (repo) =>
      writeIn(repo, "src/a.test.ts", TEST_BODY),
    );
    const code = trees("dgcode", { "src/a.ts": "export {};\n", "src/a.test.ts": TEST_BODY }, (repo) =>
      // A marker in product code is not a disabled test.
      writeIn(repo, "src/a.ts", `export const run = () => queue.only("one");\n`),
    );
    try {
      expect(weakened(fresh)).toEqual({ result: "pass", files: [] });
      expect(weakened(code)).toEqual({ result: "pass", files: [] });
      expect(
        testChanges(
          fresh.repo.dir,
          fresh.base,
          fresh.tree,
          changedFiles(fresh.repo.dir, fresh.base, fresh.tree),
          DEFAULT_TEST_GLOBS,
        ),
      ).toEqual({ apply: ["src/a.test.ts"], remove: [] });
      expect(touchedPaths(changedFiles(code.repo.dir, code.base, code.tree))).toEqual(["src/a.ts"]);
    } finally {
      fresh.repo.cleanup();
      code.repo.cleanup();
    }
  });

  it("a same-size edit made in the second the index was written is still in the snapshot", () => {
    const repo = makeScratchRepo({ prefix: "dgracy" });
    try {
      // Commit and overwrite inside one clock second: the case in which a
      // file's cached stat cannot tell the two contents apart.
      const second = (path: string) => Math.floor(statSync(path).mtimeMs / 1000);
      let edited = false;
      for (let tries = 0; tries < 20 && !edited; tries++) {
        writeIn(repo, "value.txt", `v${tries}a\n`);
        commitAll(repo, `test: value ${tries}`);
        writeIn(repo, "value.txt", `v${tries}b\n`);
        edited = second(join(repo.dir, ".git", "index")) === second(join(repo.dir, "value.txt"));
      }
      expect(edited).toBe(true);
      const committed = repo.git("rev-parse", "HEAD^{tree}");
      // Snapshot in a LATER second, when the index looks long settled.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
      const tree = treeOf(repo.dir);
      expect(tree).not.toBe(committed);
      expect(changedFiles(repo.dir, committed, tree)).toEqual([{ status: "M", path: "value.txt" }]);
    } finally {
      repo.cleanup();
    }
  });

  it("a diff git cannot produce is unknown, never a throw", () => {
    const repo = makeScratchRepo({ prefix: "dgbad" });
    try {
      const finding = weakenedTests(repo.dir, "0".repeat(40), "1".repeat(40), DEFAULT_TEST_GLOBS);
      expect(finding.result).toBe("unknown");
      expect(finding.reason).toMatch(/^the diff could not be read: /);
    } finally {
      repo.cleanup();
    }
  });

  it("reads added lines by hunk: a line that starts with ++, a path git would read as a glob, a path with a space", () => {
    const bracketed = "app/[id]/page.test.tsx";
    const spaced = "tests/with space.test.sh";
    const t = trees(
      "dglines",
      { [bracketed]: "first\n", [spaced]: "one\n", "notes.txt": "kept\n" },
      (repo) => {
        writeIn(repo, bracketed, "first\n++counter;\n+plain\n");
        writeIn(repo, spaced, "one\ntwo\n");
        writeIn(repo, "notes.txt", "kept\nignored: not asked for\n");
        writeIn(repo, "new.txt", "brand new\n");
      },
    );
    try {
      expect(addedLines(t.repo.dir, t.base, t.tree, [bracketed, spaced, "new.txt"])).toEqual([
        { file: bracketed, text: "++counter;" },
        { file: bracketed, text: "+plain" },
        { file: "new.txt", text: "brand new" },
        { file: spaced, text: "two" },
      ]);
      expect(addedLines(t.repo.dir, t.base, t.tree, [])).toEqual([]);
    } finally {
      t.repo.cleanup();
    }
  });

  it("runs work in a detached worktree of a commit and always removes it", async () => {
    const repo = makeScratchRepo({ prefix: "dgwt" });
    try {
      writeIn(repo, "tracked.txt", "v0\n");
      writeIn(repo, ".gitignore", "ignored.txt\n");
      const base = commitAll(repo, "test: base");
      writeIn(repo, "tracked.txt", "v1\n");
      writeIn(repo, "ignored.txt", "installed\n");
      const tree = treeOf(repo.dir);

      let seen = "";
      const result = await withWorktree(repo.dir, base, async (path) => {
        seen = path;
        // A fresh checkout of the commit: tracked content, nothing ignored.
        expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("v0\n");
        expect(existsSync(join(path, "ignored.txt"))).toBe(false);
        checkoutPaths(path, tree, ["tracked.txt"]);
        expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("v1\n");
        return "done";
      });
      expect(result).toBe("done");
      expect(existsSync(seen)).toBe(false);
      // The live checkout was never touched, and no worktree entry is left.
      expect(readFileSync(join(repo.dir, "tracked.txt"), "utf8")).toBe("v1\n");
      expect(repo.git("worktree", "list").split("\n")).toHaveLength(1);

      // Removed when the work throws, too.
      await expect(
        withWorktree(repo.dir, base, async (path) => {
          seen = path;
          throw new Error("the work failed");
        }),
      ).rejects.toThrow("the work failed");
      expect(existsSync(seen)).toBe(false);
      expect(repo.git("worktree", "list").split("\n")).toHaveLength(1);

      await expect(withWorktree(repo.dir, "0".repeat(40), async () => "never")).rejects.toThrow();
      expect(repo.git("worktree", "list").split("\n")).toHaveLength(1);
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// the coordinator
// ---------------------------------------------------------------------------

const WORKER = "diff-guards-worker";

/** Distinct author/reviewer provenance — independent under every policy. */
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };
const PLAN_PROV = { harness: "fake", model: "plan-model", provider: "prov-plan" };

const CLEAN_VERDICT: VerdictT = { findings: [] };

/** A check that runs every shell test in `tests/`: the repository's whole suite. */
const RUN_TESTS = 'for t in tests/*.test.sh; do sh "$t" || exit 1; done';

/** The base every case starts from: one passing test and nothing else. */
const BASE_FILES: Record<string, string> = { "tests/a.test.sh": "test -d tests\n" };

const QUESTION_END = 'Reply "allow" to accept these changes, or describe what to change.';

const BASE_RECEIPT_MARKER = "workgraph-proof base-receipt ";

interface Rig {
  repo: ScratchRepo;
  id: string;
  /** The commit the work starts from: what the fake reports as its base. */
  base: string;
  mock: MockPi;
  coordinator: CoordinatorController;
  ectx: MockEventContext;
  /** Install a fake whose work is in the repository, cut from `base`. */
  executor(options: FakeExecutorOptions): FakeExecutorHandle;
  tool(name: string, params: unknown): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
  cleanup(): Promise<void>;
}

/**
 * A repository whose base commit holds `files`, one approved medium-risk
 * issue, and a coordinator on the shipped defaults (no policy unless the
 * case gives one) with the tools registered on the same Pi.
 */
function setUp(
  prefix: string,
  opts: {
    files?: Record<string, string>;
    check?: string;
    workflowClass?: "reviewed" | "planned";
    policy?: PolicyOverrides;
    config?: Partial<WorkgraphConfig>;
  } = {},
): Rig {
  const repo = makeScratchRepo({ prefix, seed: 1 });
  const id = repo.seededIds[0]!;
  for (const [file, content] of Object.entries(opts.files ?? BASE_FILES)) {
    writeIn(repo, file, content);
  }
  const base = commitAll(repo, "test: base");
  repo.op([
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=ready",
    "--set-metadata",
    "workgraph_risk_tier=medium",
    "--set-metadata",
    `workgraph_workflow_class=${opts.workflowClass ?? "reviewed"}`,
    "--set-metadata",
    `workgraph_check=${opts.check ?? RUN_TESTS}`,
    "--actor",
    "approver",
  ]);
  const mock = makeMockPi();
  const config = shippedConfig({
    workerIdOverride: WORKER,
    ...opts.config,
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
  setWorkerIdOverride(WORKER);
  registerWorkgraphTools(asExtensionAPI(mock));
  const coordinator = registerCoordinator(asExtensionAPI(mock), { getConfig: () => config });
  const ectx = makeEventContext(repo.dir);
  const fakes: FakeExecutorHandle[] = [];
  return {
    repo,
    id,
    base,
    mock,
    coordinator,
    ectx,
    executor(options) {
      const fake = installFakeExecutor(mock.events, {
        workspace: { path: repo.dir, baseRevision: base },
        ...options,
      });
      fakes.push(fake);
      return fake;
    },
    async tool(name, params) {
      const def = mock.tools.get(name);
      if (!def) throw new Error(`tool not registered: ${name}`);
      return (await def.execute(
        `call-${name}`,
        params,
        undefined,
        undefined,
        makeToolContext(repo.dir),
      )) as Awaited<ReturnType<Rig["tool"]>>;
    },
    async cleanup() {
      for (const fake of fakes) fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    },
  };
}

/** One coordination pass: claim, run, check, guard, judge, and drain. */
async function drive(rig: Rig): Promise<void> {
  await rig.mock.emit(
    "agent_settled",
    { type: "agent_settled" },
    rig.ectx.ctx as Parameters<MockPi["emit"]>[2],
  );
  await rig.mock.flushEvents();
}

function metadataOf(rig: Rig): Record<string, unknown> {
  return (rig.repo.showIssue(rig.id).metadata ?? {}) as Record<string, unknown>;
}

async function payloads(rig: Rig, marker: string): Promise<Array<Record<string, unknown>>> {
  const comments = await listComments(rig.repo.dir, rig.id);
  return comments
    .filter((c) => c.text.startsWith(marker))
    .map((c) => JSON.parse(c.text.slice(marker.length)) as Record<string, unknown>);
}

const audits = (rig: Rig, kind: string) => payloads(rig, `workgraph-lease ${kind} `);

async function gateRecords(rig: Rig, gate: string): Promise<GateRecord[]> {
  return (await listGateRecords(rig.repo.dir, rig.id)).filter((r) => r.gate === gate);
}

function findingsOf(request: { priorFindings?: string[] }): FindingT[] {
  return (request.priorFindings ?? []).map((text) => JSON.parse(text) as FindingT);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

/** Silence console.error (a parked run logs why) and return what it was given. */
function captureErrors(): () => string[] {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.join(" "));
}

/** A place outside the repository for a command to leave marks in. */
function outside(): { file(name: string): string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-marks-"));
  return {
    file: (name) => join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function lines(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "")
    : [];
}

/** An implementation with a test that depends on it: nothing for a guard to object to. */
function honestWork(repo: ScratchRepo): void {
  writeIn(repo, "impl.txt", "v1\n");
  writeIn(repo, "tests/impl.test.sh", "grep -q v1 impl.txt\n");
}

describe("a change that violates nothing", () => {
  it("closes with a pass or not-applicable record for each guard", async () => {
    const rig = setUp("dgclean");
    const fake = rig.executor({
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, onRequest: () => honestWork(rig.repo) },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);

      expect(rig.repo.showIssue(rig.id).status).toBe("closed");
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "reviewer"]);
      const tree = String(metadataOf(rig)[WORKGRAPH_RESULT_TREE_KEY]);
      const records = await listGateRecords(rig.repo.dir, rig.id);
      // Between the check and the review, in this order, each naming the tree.
      expect(records.map((r) => [r.gate, r.result, r.blocked, r.tree])).toEqual([
        ["tree-binding", "pass", false, tree],
        ["check", "pass", false, tree],
        ["weakened-tests", "pass", false, tree],
        ["scope", "not-applicable", false, tree],
        ["unproven-tests", "pass", false, tree],
        ["criteria-evidence", "not-applicable", false, tree],
        ["review", "pass", false, tree],
      ]);
      // A reviewed issue has no approved plan to hold it to.
      expect(records.find((r) => r.gate === "scope")!.reason).toBe(
        "no plan was approved at the plan gate",
      );
      const stamp = await latestStamp(rig.repo.dir, rig.id);
      expect(stamp!.gates).toMatchObject({
        "weakened-tests": "pass",
        scope: "not-applicable",
        "unproven-tests": "pass",
      });
      // The new test was run on the base: once for the base itself (green),
      // recorded under its own marker, never among the result's receipts.
      expect(await listReceipts(rig.repo.dir, rig.id)).toHaveLength(1);
      const baseReceipts = await payloads(rig, BASE_RECEIPT_MARKER);
      expect(baseReceipts).toHaveLength(1);
      expect(baseReceipts[0]).toMatchObject({
        tree: rig.repo.git("rev-parse", `${rig.base}^{tree}`),
        commandDigest: commandDigest(RUN_TESTS),
        passed: true,
      });
      expect(baseReceipts[0]).not.toHaveProperty("setupDigest");
      // Nothing is left behind: no worktree, no decision, no spent round.
      expect(rig.repo.git("worktree", "list").split("\n")).toHaveLength(1);
      const metadata = metadataOf(rig);
      expect(metadata.workgraph_decision_pending).toBeUndefined();
      expect(metadata[WORKGRAPH_GUARD_ROUNDS_KEY]).toBeUndefined();
      expect(heldLeases(rig.repo.dir)).toHaveLength(0);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  it("with only non-test files changed, unproven-tests does not apply and no base is checked", async () => {
    const rig = setUp("dgnotest");
    rig.executor({
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, onRequest: () => writeIn(rig.repo, "impl.txt", "v1\n") },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);
      expect(rig.repo.showIssue(rig.id).status).toBe("closed");
      expect((await gateRecords(rig, "unproven-tests")).map((r) => [r.result, r.reason])).toEqual([
        ["not-applicable", "no test file was added or modified"],
      ]);
      expect(await payloads(rig, BASE_RECEIPT_MARKER)).toEqual([]);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  it("a gate that is off is skipped: no record, and nothing runs for it", async () => {
    const rig = setUp("dgoff", {
      policy: {
        medium: { gates: { "weakened-tests": "off", "unproven-tests": "off", scope: "off" } },
      },
    });
    rig.executor({
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          // Would violate two guards if they looked.
          onRequest: () => {
            rmSync(join(rig.repo.dir, "tests/a.test.sh"));
            writeIn(rig.repo, "tests/new.test.sh", "true\n");
          },
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);
      expect(rig.repo.showIssue(rig.id).status).toBe("closed");
      expect((await listGateRecords(rig.repo.dir, rig.id)).map((r) => r.gate)).toEqual([
        "tree-binding",
        "check",
        "criteria-evidence",
        "review",
      ]);
      expect(await payloads(rig, BASE_RECEIPT_MARKER)).toEqual([]);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  it("under observe a violation is recorded as a would-block and the issue closes", async () => {
    const rig = setUp("dgobs", {
      files: { ...BASE_FILES, "tests/slow.test.sh": "test -d tests\n" },
      policy: { medium: { gates: { "weakened-tests": "observe" } } },
    });
    const fake = rig.executor({
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => {
            writeIn(rig.repo, "impl.txt", "v1\n");
            rmSync(join(rig.repo.dir, "tests/slow.test.sh"));
          },
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);
      expect(rig.repo.showIssue(rig.id).status).toBe("closed");
      // Recorded exactly as enforce would have blocked it; no revision, no question.
      expect(
        (await gateRecords(rig, "weakened-tests")).map((r) => [r.mode, r.result, r.blocked, r.wouldBlock, r.reason]),
      ).toEqual([["observe", "violation", false, true, "test files deleted: tests/slow.test.sh"]]);
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "reviewer"]);
      expect(metadataOf(rig)[WORKGRAPH_GUARD_ROUNDS_KEY]).toBeUndefined();
      expect((await latestStamp(rig.repo.dir, rig.id))!.gates["weakened-tests"]).toBe("violation");
    } finally {
      await rig.cleanup();
    }
  }, 60_000);
});

describe("each detection gets one revision round, then a human decision", () => {
  const PLAN: PlanT = {
    summary: "bump the value",
    steps: [{ description: "change the value", targets: ["src/a.txt", "valueOf()"] }],
  };

  const DETECTIONS: ReadonlyArray<{
    label: string;
    gate: "weakened-tests" | "unproven-tests" | "scope";
    files?: Record<string, string>;
    check?: string;
    planned?: boolean;
    work(repo: ScratchRepo): void;
    note: RegExp;
    file: string;
  }> = [
    {
      label: "an added skip marker",
      gate: "weakened-tests",
      work: (repo) => {
        writeIn(repo, "impl.txt", "v1\n");
        // The edit makes the test depend on the change (so it is proven),
        // and switches another one off in passing.
        writeIn(repo, "tests/a.test.sh", '# it.skip("the slow case", () => {})\ngrep -q v1 impl.txt\n');
      },
      note: /^skip markers added: tests\/a\.test\.sh$/,
      file: "tests/a.test.sh",
    },
    {
      label: "a deleted test file",
      gate: "weakened-tests",
      files: { ...BASE_FILES, "tests/slow.test.sh": "test -d tests\n" },
      work: (repo) => {
        writeIn(repo, "impl.txt", "v1\n");
        rmSync(join(repo.dir, "tests/slow.test.sh"));
      },
      note: /^test files deleted: tests\/slow\.test\.sh$/,
      file: "tests/slow.test.sh",
    },
    {
      label: "a new test that passes on the base without the change",
      gate: "unproven-tests",
      work: (repo) => {
        writeIn(repo, "impl.txt", "v1\n");
        // Asserts something that was already true before the change.
        writeIn(repo, "tests/impl.test.sh", "test -d tests\n");
      },
      note: /^new or changed tests pass without the change: tests\/impl\.test\.sh$/,
      file: "tests/impl.test.sh",
    },
    {
      label: "a changed file outside the approved plan's path targets",
      gate: "scope",
      files: { ...BASE_FILES, "src/a.txt": "v0\n", "src/b.txt": "v0\n" },
      planned: true,
      work: (repo) => {
        writeIn(repo, "src/a.txt", "v1\n");
        writeIn(repo, "src/b.txt", "v1\n");
      },
      note: /^files changed outside the approved plan's paths: src\/b\.txt$/,
      file: "src/b.txt",
    },
  ];

  for (const detection of DETECTIONS) {
    it(`${detection.label}: one revision with the finding the core wrote, then the issue parks with a question naming the file`, async () => {
      const rig = setUp("dgdet", {
        ...(detection.files ? { files: detection.files } : {}),
        ...(detection.check ? { check: detection.check } : {}),
        ...(detection.planned ? { workflowClass: "planned" as const } : {}),
      });
      const fake = rig.executor({
        roles: ["planner", "implementer", "reviewer", "revision"],
        roleScripts: {
          planner: { provenance: PLAN_PROV, plan: PLAN },
          implementer: { provenance: IMPL_PROV, onRequest: () => detection.work(rig.repo) },
          // The revision leaves the violation in place.
          revision: { provenance: IMPL_PROV },
          reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
        },
      });
      try {
        await drive(rig);
        if (detection.planned) {
          // The plan parks for a human; approving it is what makes its
          // paths binding.
          expect(metadataOf(rig)[WORKGRAPH_PHASE_KEY]).toBe("plan_review");
          await rig.tool("workgraph_approve_plan", { id: rig.id, decision: "approve" });
          await drive(rig);
        }

        // One revision, carrying the finding the core wrote; no reviewer
        // was asked about either tree.
        const work = fake.requests.filter((r) => r.role !== "planner");
        expect(work.map((r) => r.role)).toEqual(["implementer", "revision"]);
        const revision = work[1]!;
        expect(revision.attempt).toBe(2);
        const findings = findingsOf(revision);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
          criterion: detection.gate,
          severity: "blocking",
          author: "code",
          evidence: detection.file,
        });
        expect(findings[0]!.note).toMatch(detection.note);

        // The same violation on the tree the revision left: the guard has
        // had its round, so a human is asked.
        const records = await gateRecords(rig, detection.gate);
        expect(records.map((r) => [r.mode, r.result, r.blocked, r.attempt])).toEqual([
          ["enforce", "violation", true, 1],
          ["enforce", "violation", true, 2],
        ]);
        const metadata = metadataOf(rig);
        expect(rig.repo.showIssue(rig.id).status).toBe("blocked");
        expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("escalated");
        expect(metadata.workgraph_decision_pending).toBe(true);
        expect(metadata[WORKGRAPH_DECISION_GATE_KEY]).toBe(detection.gate);
        expect(metadata[WORKGRAPH_GUARD_ROUNDS_KEY]).toBe(detection.gate);
        const question = String(metadata[WORKGRAPH_DECISION_QUESTION_KEY]);
        expect(question).toContain(detection.gate);
        expect(question).toContain(detection.file);
        expect(question.endsWith(QUESTION_END)).toBe(true);
        const needed = await audits(rig, "decision-needed");
        expect(needed).toHaveLength(1);
        expect(needed[0]).toMatchObject({ question, gates: [detection.gate] });
        expect(String(needed[0]!.decisionId)).toMatch(/^guard-[0-9a-f]{20}-2$/);
        // Parked, not closed, and not held.
        expect(await latestStamp(rig.repo.dir, rig.id)).toBeUndefined();
        expect(heldLeases(rig.repo.dir)).toHaveLength(0);
        // The question is where a human looks, and approval waits on it.
        const status = textOf(await rig.tool("workgraph_status", { id: rig.id }));
        expect(status).toContain(`Decision awaiting your answer`);
        expect(status).toContain(`Guard revision round spent: ${detection.gate}`);
        await expect(rig.tool("workgraph_approve", { id: rig.id })).rejects.toThrow(
          /workgraph_answer_decision/,
        );
      } finally {
        await rig.cleanup();
      }
    }, 60_000);
  }
});

describe("the round and the decision", () => {
  /** The first run adds a skip marker to a test it also makes depend on the change. */
  const addsMarker = (repo: ScratchRepo): void => {
    writeIn(repo, "impl.txt", "v1\n");
    writeIn(repo, "tests/a.test.sh", '# it.skip("the slow case", () => {})\ngrep -q v1 impl.txt\n');
  };

  it("the answer allow, then approval: the next run closes and the gate record says who allowed it", async () => {
    const rig = setUp("dgallow");
    const fake = rig.executor({
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        // The second claim's implementer finds its work in place.
        implementer: [
          { provenance: IMPL_PROV, onRequest: () => addsMarker(rig.repo) },
          { provenance: IMPL_PROV },
        ],
        revision: { provenance: IMPL_PROV }, // leaves the marker
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);
      expect(metadataOf(rig)[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      expect(Number(metadataOf(rig)[WORKGRAPH_ATTEMPT_KEY])).toBe(2);
      const question = String(metadataOf(rig)[WORKGRAPH_DECISION_QUESTION_KEY]);

      const answered = await rig.tool("workgraph_answer_decision", { id: rig.id, answer: " Allow " });
      expect(textOf(answered)).toContain("Allowed weakened-tests");
      expect(answered.details).toMatchObject({ guards: ["weakened-tests"], allowed: true });
      let metadata = metadataOf(rig);
      expect(metadata.workgraph_decision_pending).toBe(false);
      expect(metadata[WORKGRAPH_GUARD_ALLOWED_KEY]).toBe("weakened-tests");
      expect(typeof metadata[WORKGRAPH_GUARD_ALLOWED_BY_KEY]).toBe("string");
      expect(metadata[WORKGRAPH_DECISION_GATE_KEY]).toBe("");
      const answers = await audits(rig, "decision-answered");
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({ question, gates: ["weakened-tests"], allowed: true });
      expect(textOf(await rig.tool("workgraph_status", { id: rig.id }))).toContain(
        `Guards allowed: weakened-tests (by ${String(metadata[WORKGRAPH_GUARD_ALLOWED_BY_KEY])})`,
      );

      // Approved again (the stored check still satisfies the approval
      // rule), claimed again, and this time the marker is accepted.
      await rig.tool("workgraph_approve", { id: rig.id });
      await drive(rig);

      expect(rig.repo.showIssue(rig.id).status).toBe("closed");
      expect(fake.requests.map((r) => r.role)).toEqual([
        "implementer",
        "revision",
        "implementer",
        "reviewer",
      ]);
      const records = await gateRecords(rig, "weakened-tests");
      const last = records[records.length - 1]!;
      expect(last).toMatchObject({ mode: "enforce", result: "pass", blocked: false });
      // Who allowed it, and the files it covers this time.
      expect(last.reason).toBe(
        `allowed by ${String(metadata[WORKGRAPH_GUARD_ALLOWED_BY_KEY])}: tests/a.test.sh`,
      );
      // The other guards still looked: the changed test is proven.
      const unproven = await gateRecords(rig, "unproven-tests");
      expect(unproven[unproven.length - 1]).toMatchObject({ result: "pass" });
      expect(unproven[unproven.length - 1]!.reason).toBeUndefined();
      metadata = metadataOf(rig);
      expect(metadata.workgraph_decision_pending).toBe(false);
      const stamp = await latestStamp(rig.repo.dir, rig.id);
      expect(stamp!.gates).toMatchObject({ "weakened-tests": "pass", "unproven-tests": "pass" });
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  it("a revision that removes the marker closes with no decision, and the round is not charged to maxRevisions", async () => {
    // maxRevisions 0: any ordinary blocking finding would stop at once.
    const rig = setUp("dgfix", { policy: { medium: { maxRevisions: 0 } } });
    const fake = rig.executor({
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, onRequest: () => addsMarker(rig.repo) },
        revision: {
          provenance: IMPL_PROV,
          onRequest: (request) =>
            writeFileSync(join(request.workspace.path!, "tests/a.test.sh"), "grep -q v1 impl.txt\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);

      expect(rig.repo.showIssue(rig.id).status).toBe("closed");
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "revision", "reviewer"]);
      const metadata = metadataOf(rig);
      // The attempt advanced; the bound was not consumed.
      expect(Number(metadata[WORKGRAPH_ATTEMPT_KEY])).toBe(2);
      expect(await audits(rig, "workflow-promoted")).toEqual([]);
      expect(await audits(rig, "escalated")).toEqual([]);
      expect(await audits(rig, "decision-needed")).toEqual([]);
      expect(metadata.workgraph_decision_pending).toBeUndefined();
      // The guard has had its round for this issue, whatever came of it.
      expect(metadata[WORKGRAPH_GUARD_ROUNDS_KEY]).toBe("weakened-tests");
      expect((await gateRecords(rig, "weakened-tests")).map((r) => [r.result, r.blocked, r.attempt])).toEqual([
        ["violation", true, 1],
        ["pass", false, 2],
      ]);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  it("any answer but allow is carried as text: no allowance, and the next violation parks again", async () => {
    const rig = setUp("dgtext");
    const fake = rig.executor({
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: [
          { provenance: IMPL_PROV, onRequest: () => addsMarker(rig.repo) },
          { provenance: IMPL_PROV },
        ],
        revision: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);
      // In quotes, as the question prints it: not the answer.
      const answered = await rig.tool("workgraph_answer_decision", { id: rig.id, answer: '"allow"' });
      expect(textOf(answered)).toContain('not exactly "allow"');
      expect(answered.details).toMatchObject({ guards: ["weakened-tests"], allowed: false });
      expect(metadataOf(rig)[WORKGRAPH_GUARD_ALLOWED_KEY]).toBeUndefined();

      await rig.tool("workgraph_approve", { id: rig.id });
      await drive(rig);

      // The next run got the answer as its instructions, left the marker,
      // and the guard, whose round is spent, asked again at once.
      const second = fake.requests[2]!;
      expect(second.role).toBe("implementer");
      expect(second.decision).toMatchObject({ answer: '"allow"' });
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "revision", "implementer"]);
      const metadata = metadataOf(rig);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      expect(metadata.workgraph_decision_pending).toBe(true);
      expect(metadata[WORKGRAPH_DECISION_GATE_KEY]).toBe("weakened-tests");
      expect(await audits(rig, "decision-needed")).toHaveLength(2);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  it("an executor's own question is never a guard question, whatever it says", async () => {
    const rig = setUp("dgforge");
    const forged = `The weakened-tests guard still finds a violation. ${QUESTION_END}`;
    rig.executor({
      roles: ["implementer", "reviewer"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, outcome: "blocked", decisionQuestion: forged },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);
      let metadata = metadataOf(rig);
      expect(metadata.workgraph_decision_pending).toBe(true);
      expect(metadata[WORKGRAPH_DECISION_QUESTION_KEY]).toBe(forged);
      expect(metadata[WORKGRAPH_DECISION_GATE_KEY]).toBe("");

      const answered = await rig.tool("workgraph_answer_decision", { id: rig.id, answer: "allow" });
      expect(answered.details).toMatchObject({ guards: [], allowed: false });
      expect(textOf(answered)).not.toContain("Allowed");
      metadata = metadataOf(rig);
      expect(metadata[WORKGRAPH_GUARD_ALLOWED_KEY]).toBeUndefined();
      expect(metadata.workgraph_decision_answer).toBe("allow");
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  it("an override release clears the spent round and the allowance", async () => {
    const rig = setUp("dgrel");
    rig.executor({
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, onRequest: () => addsMarker(rig.repo) },
        revision: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);
      await rig.tool("workgraph_answer_decision", { id: rig.id, answer: "allow" });
      expect(metadataOf(rig)[WORKGRAPH_GUARD_ROUNDS_KEY]).toBe("weakened-tests");
      expect(metadataOf(rig)[WORKGRAPH_GUARD_ALLOWED_KEY]).toBe("weakened-tests");

      await rig.tool("workgraph_override", { id: rig.id, action: "release", reason: "start over" });
      const metadata = metadataOf(rig);
      for (const key of [
        WORKGRAPH_GUARD_ROUNDS_KEY,
        WORKGRAPH_GUARD_ALLOWED_KEY,
        WORKGRAPH_GUARD_ALLOWED_BY_KEY,
        WORKGRAPH_DECISION_GATE_KEY,
      ]) {
        expect([key, metadata[key]]).toEqual([key, undefined]);
      }
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("draft");
    } finally {
      await rig.cleanup();
    }
  }, 60_000);
});

describe("scope, against an approved plan", () => {
  async function plannedRun(
    prefix: string,
    plan: PlanT,
    work: (repo: ScratchRepo) => void,
  ): Promise<{ rig: Rig; fake: FakeExecutorHandle }> {
    const rig = setUp(prefix, {
      files: { "src/a.sh": "echo v0\n", "src/a.test.sh": "true\n" },
      // The suite here is the one test beside the source.
      check: "sh src/a.test.sh",
      workflowClass: "planned",
    });
    const fake = rig.executor({
      roles: ["planner", "implementer", "reviewer", "revision"],
      roleScripts: {
        planner: { provenance: PLAN_PROV, plan },
        implementer: { provenance: IMPL_PROV, onRequest: () => work(rig.repo) },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    await drive(rig);
    await rig.tool("workgraph_approve_plan", { id: rig.id, decision: "approve" });
    await drive(rig);
    return { rig, fake };
  }

  /** Changes the planned file and the test beside it, which now needs the change. */
  const changesPlannedFile = (repo: ScratchRepo): void => {
    writeIn(repo, "src/a.sh", "echo v1\n");
    writeIn(repo, "src/a.test.sh", "grep -q v1 src/a.sh\n");
  };

  it("a change to the planned file and its test passes, and the plan's paths are on the frozen bar", async () => {
    const { rig, fake } = await plannedRun(
      "dgplan",
      { steps: [{ description: "bump the script", targets: ["./src/a.sh", "main()"] }] },
      changesPlannedFile,
    );
    try {
      expect(rig.repo.showIssue(rig.id).status).toBe("closed");
      expect(fake.requests.map((r) => r.role)).toEqual(["planner", "implementer", "reviewer"]);
      expect((await gateRecords(rig, "scope")).map((r) => [r.mode, r.result, r.blocked])).toEqual([
        ["enforce", "pass", false],
      ]);
      // The second claim (the one that implements) froze the plan's paths.
      const frozen = await audits(rig, "bar-frozen");
      expect(frozen.map((f) => (f.bar as { planTargets?: string[] }).planTargets)).toEqual([
        undefined,
        ["src/a.sh"],
      ]);
      // A plan comment appended later is not a change to the bar.
      expect(await audits(rig, "bar-changed")).toEqual([]);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  it("a plan whose only targets are symbol names has nothing to hold the change to", async () => {
    const { rig } = await plannedRun(
      "dgsym",
      // `Config.load` ends like a file name; no such file exists in either tree.
      { steps: [{ description: "refactor", targets: ["parseConfig()", "RetryPolicy", "Config.load"] }] },
      changesPlannedFile,
    );
    try {
      expect(rig.repo.showIssue(rig.id).status).toBe("closed");
      expect((await gateRecords(rig, "scope")).map((r) => [r.result, r.reason])).toEqual([
        ["not-applicable", "the approved plan names no file paths"],
      ]);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);
});

describe("the base tree's check result", () => {
  it("base passes, change fails: a revision as before, and the base is checked once per tree", async () => {
    const marks = outside();
    // Green without impl.txt (the base), red with it; counts its base runs.
    const check = `test -f impl.txt || echo base >> ${marks.file("runs")}; test ! -f impl.txt`;
    const rig = setUp("dgbase", { check });
    let round = 0;
    const fake = rig.executor({
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, onRequest: () => writeIn(rig.repo, "impl.txt", "v1\n") },
        // Every revision leaves a new tree that still fails.
        revision: {
          provenance: IMPL_PROV,
          onRequest: () => writeIn(rig.repo, "impl.txt", `v1 round ${++round}\n`),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);

      // The phase 3 loop, unchanged: three revisions, then promoted.
      expect(fake.requests.map((r) => r.role)).toEqual([
        "implementer",
        "revision",
        "revision",
        "revision",
      ]);
      expect(findingsOf(fake.requests[1]!)).toMatchObject([
        { criterion: "check", severity: "blocking", author: "code", note: "exited 1" },
      ]);
      expect(await audits(rig, "workflow-promoted")).toHaveLength(1);
      // Four failing trees, one base: checked once, kept under its own marker.
      expect(await listReceipts(rig.repo.dir, rig.id)).toHaveLength(4);
      expect(lines(marks.file("runs"))).toEqual(["base"]);
      const baseReceipts = await payloads(rig, BASE_RECEIPT_MARKER);
      expect(baseReceipts).toHaveLength(1);
      expect(baseReceipts[0]).toMatchObject({ passed: true, commandDigest: commandDigest(check) });
      // Its log is not one of the numbered logs the receipts name.
      const log = (baseReceipts[0]!.log as { path: string }).path;
      expect(log).toMatch(/\/proof\/[^/]+\/base-[0-9a-f]{8}-1-[0-9a-f]{12}\.log$/);
      expect(existsSync(log)).toBe(true);
    } finally {
      await rig.cleanup();
      marks.cleanup();
    }
  }, 60_000);

  it("base fails, change fails: escalated as already failing on the base, with no revision request", async () => {
    const rig = setUp("dgred", { check: "echo looking; test -f never.txt" });
    const fake = rig.executor({
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, onRequest: () => writeIn(rig.repo, "impl.txt", "v1\n") },
        revision: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);

      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      expect(rig.repo.showIssue(rig.id).status).toBe("blocked");
      const metadata = metadataOf(rig);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      // Not a question: there is nothing for a human to allow.
      expect(metadata.workgraph_decision_pending).toBeUndefined();
      const escalated = await audits(rig, "escalated");
      expect(escalated).toHaveLength(1);
      const reason = String(escalated[0]!.reason);
      expect(reason).toMatch(/^the check already fails on the base tree: exited 1/);
      // The likeliest cause when no setup command is configured.
      expect(reason).toContain("check.setup");
      // The result's own receipt is still the only receipt.
      expect(await listReceipts(rig.repo.dir, rig.id)).toHaveLength(1);
      expect(await payloads(rig, BASE_RECEIPT_MARKER)).toMatchObject([
        { passed: false, reason: "exited 1", exitCode: 1 },
      ]);
      expect((await gateRecords(rig, "check")).map((r) => [r.result, r.blocked])).toEqual([
        ["violation", true],
      ]);
      // The guards never ran: the check did not pass.
      expect(await gateRecords(rig, "weakened-tests")).toEqual([]);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);
});

describe("unproven-tests on a base that needs setup", () => {
  // The check needs a file git ignores, as a real one needs installed
  // dependencies: present in the live checkout, absent from a fresh worktree.
  const FILES = { ...BASE_FILES, ".gitignore": "deps.marker\n" };
  const CHECK = `test -f deps.marker && ${RUN_TESTS}`;

  /** A new test that passes on any tree, beside an implementation it ignores. */
  function unprovenWork(repo: ScratchRepo): void {
    writeIn(repo, "impl.txt", "v1\n");
    writeIn(repo, "tests/impl.test.sh", "true\n");
  }

  function rigWith(prefix: string, setup?: string): { rig: Rig; fake: FakeExecutorHandle } {
    const rig = setUp(prefix, {
      files: FILES,
      check: CHECK,
      ...(setup !== undefined ? { config: { check: { setup } } } : {}),
    });
    writeIn(rig.repo, "deps.marker", "installed\n");
    const fake = rig.executor({
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: { provenance: IMPL_PROV, onRequest: () => unprovenWork(rig.repo) },
        revision: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    return { rig, fake };
  }

  it("a red base: unknown, which does not block, and the gate report shows the guard was blind", async () => {
    const { rig, fake } = rigWith("dgblind");
    try {
      await drive(rig);

      // The change's own check passed in the live checkout; the base's
      // failed in the fresh worktree, so the guard cannot tell.
      expect(rig.repo.showIssue(rig.id).status).toBe("closed");
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "reviewer"]);
      const [record] = await gateRecords(rig, "unproven-tests");
      expect(record).toMatchObject({
        mode: "enforce",
        result: "unknown",
        blocked: false,
        wouldBlock: false,
      });
      expect(record!.reason).toMatch(/^the check fails on the base tree \(exited 1\)/);
      expect(record!.reason).toContain("check.setup");
      expect((await latestStamp(rig.repo.dir, rig.id))!.gates["unproven-tests"]).toBe("unknown");

      const report = textOf(await rig.tool("workgraph_gates", {})).split("\n");
      expect(report).toContain(`unproven-tests: 0 blocked, 0 would block, 1 unknown (${rig.id})`);
      expect(report).toContain("weakened-tests: 0 blocked, 0 would block");
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  it("a configured setup command runs before the check in the fresh worktree, so the guard can see", async () => {
    const { rig, fake } = rigWith("dgsetup", "touch deps.marker");
    try {
      await drive(rig);

      // With setup the base is green, and the new test passes there too.
      const records = await gateRecords(rig, "unproven-tests");
      expect(records[0]).toMatchObject({ result: "violation", blocked: true });
      expect(records[0]!.reason).toBe(
        "new or changed tests pass without the change: tests/impl.test.sh",
      );
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "revision"]);
      // The base result names the setup that prepared its worktree, and it
      // was computed once for both rounds.
      const baseReceipts = await payloads(rig, BASE_RECEIPT_MARKER);
      expect(baseReceipts).toHaveLength(1);
      expect(baseReceipts[0]).toMatchObject({
        passed: true,
        setupDigest: commandDigest("touch deps.marker"),
      });
      // The setup ran in the worktree, not in the checkout: its bar says so.
      const frozen = await audits(rig, "bar-frozen");
      expect((frozen[0]!.bar as { setup?: string }).setup).toBe("touch deps.marker");
      expect(rig.repo.git("worktree", "list").split("\n")).toHaveLength(1);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  it("a setup command that fails: unknown, with the reason, and the issue still closes", async () => {
    const { rig, fake } = rigWith("dgnosetup", "echo no network; exit 1");
    try {
      await drive(rig);

      expect(rig.repo.showIssue(rig.id).status).toBe("closed");
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "reviewer"]);
      expect((await gateRecords(rig, "unproven-tests")).map((r) => [r.result, r.blocked, r.reason])).toEqual([
        ["unknown", false, "setup failed: exited 1"],
      ]);
      // Nothing was learned about the base, so nothing was recorded for it.
      expect(await payloads(rig, BASE_RECEIPT_MARKER)).toEqual([]);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  it("the repository's testGlobs replace the defaults: a file they do not name is not a test", async () => {
    const rig = setUp("dgglobs", {
      config: { check: { testGlobs: ["spec/**"] } },
    });
    rig.executor({
      roles: ["implementer", "reviewer", "revision"],
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          // Under the defaults: a deleted test, and an unproven one.
          onRequest: () => {
            writeIn(rig.repo, "tests/b.test.sh", "true\n# another line so it is not a rename\n");
            rmSync(join(rig.repo.dir, "tests/a.test.sh"));
          },
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    try {
      await drive(rig);
      expect(rig.repo.showIssue(rig.id).status).toBe("closed");
      expect((await gateRecords(rig, "weakened-tests")).map((r) => r.result)).toEqual(["pass"]);
      expect((await gateRecords(rig, "unproven-tests")).map((r) => r.result)).toEqual([
        "not-applicable",
      ]);
      const frozen = await audits(rig, "bar-frozen");
      expect((frozen[0]!.bar as { testGlobs?: string[] }).testGlobs).toEqual(["spec/**"]);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);
});

describe("the hygiene the guards are excluded from", () => {
  it("no other source file holds a marker the repository's own check would match", () => {
    // The contract's check, with this file and src/guards.ts left out.
    let matches = "";
    try {
      matches = execFileSync(
        "grep",
        [
          "-rnE",
          "\\.(skip|todo|only)\\(",
          "test",
          "src",
          "--exclude=diff-guards.test.ts",
          "--exclude=guards.ts",
        ],
        { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
      );
    } catch (e) {
      // grep exits 1 when nothing matches, which is the pass.
      if ((e as { status?: number }).status !== 1) throw e;
    }
    expect(matches).toBe("");
  });
});
