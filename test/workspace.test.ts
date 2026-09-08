import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      writeFileSync(join(dir, "dirty.txt"), "user work");
      expect(() => workflowWorkspace(dir, "run/two", "ISSUE-2", true)).toThrow(
        "clean source checkout",
      );
      expect(readFileSync(join(dir, "dirty.txt"), "utf8")).toBe("user work");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
