import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowWorkspace } from "../src/adapters/workspace.ts";

describe("retained workflow workspace", () => {
  it("shares uncommitted changes across roles and never changes the source checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "workgraph-workspace-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "test: seed repository",
      );
      const sourceBranch = git("branch", "--show-current");
      const workspace = workflowWorkspace(dir, "run/one", "ISSUE-1", true);
      writeFileSync(
        join(workspace.path, "implementation.txt"),
        "accepted plan implementation",
      );
      expect(workflowWorkspace(dir, "run/one", "ISSUE-1", false)).toEqual(
        workspace,
      );
      expect(
        readFileSync(
          join(
            workflowWorkspace(dir, "run/one", "ISSUE-1", true).path,
            "implementation.txt",
          ),
          "utf8",
        ),
      ).toContain("accepted plan");
      expect(git("status", "--porcelain")).toBe("");
      expect(git("branch", "--show-current")).toBe(sourceBranch);
      expect(() =>
        workflowWorkspace(dir, "run/missing", "ISSUE-1", false),
      ).toThrow("no implementation worktree");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts from HEAD while preserving staged, unstaged, and untracked source changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "workgraph-workspace-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      writeFileSync(join(dir, "tracked.txt"), "committed content\n");
      git("add", "tracked.txt");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "test: seed repository",
      );
      const sourceBranch = git("branch", "--show-current");
      const sourceHead = git("rev-parse", "HEAD");
      writeFileSync(join(dir, "tracked.txt"), "staged content\n");
      git("add", "tracked.txt");
      writeFileSync(join(dir, "tracked.txt"), "unstaged content\n");
      writeFileSync(join(dir, "untracked.txt"), "untracked content\n");
      const sourceStatus = git("status", "--porcelain");
      const stagedDiff = git("diff", "--cached");
      const unstagedDiff = git("diff");

      const workspace = workflowWorkspace(dir, "run/dirty", "ISSUE-2", true);
      expect(workspace.baseRevision).toBe(sourceHead);
      expect(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: workspace.path,
          encoding: "utf8",
        }).trim(),
      ).toBe("");
      expect(readFileSync(join(workspace.path, "tracked.txt"), "utf8")).toBe(
        "committed content\n",
      );
      expect(existsSync(join(workspace.path, "untracked.txt"))).toBe(false);

      writeFileSync(join(workspace.path, "tracked.txt"), "implementation\n");
      expect(workflowWorkspace(dir, "run/dirty", "ISSUE-2", false)).toEqual(
        workspace,
      );
      expect(git("branch", "--show-current")).toBe(sourceBranch);
      expect(git("rev-parse", "HEAD")).toBe(sourceHead);
      expect(git("status", "--porcelain")).toBe(sourceStatus);
      expect(git("diff", "--cached")).toBe(stagedDiff);
      expect(git("diff")).toBe(unstagedDiff);
      expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe(
        "unstaged content\n",
      );
      expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe(
        "untracked content\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
