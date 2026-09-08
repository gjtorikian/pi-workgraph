import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface WorkflowWorkspace {
  repoPath: string;
  path: string;
  branch: string;
  baseRevision: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** One retained branch per workflow, shared by every downstream role.
 * The manifest lives in Git's common directory, outside the tracked tree.
 * No cleanup occurs automatically: failed runs and published PRs keep their work.
 */
export function workflowWorkspace(
  repoPath: string,
  workflowRunId: string,
  issueId: string,
  create: boolean,
): WorkflowWorkspace {
  const root = git(repoPath, "rev-parse", "--show-toplevel");
  const commonRaw = git(root, "rev-parse", "--git-common-dir");
  const common = isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw);
  const key = createHash("sha256")
    .update(workflowRunId)
    .digest("hex")
    .slice(0, 20);
  const dir = join(common, "workgraph", "runs", key);
  const file = join(dir, "workspace.json");
  const checkout = join(dir, "checkout");
  let workspace: WorkflowWorkspace;
  if (existsSync(file)) {
    workspace = JSON.parse(readFileSync(file, "utf8")) as WorkflowWorkspace;
    if (
      workspace.repoPath !== root ||
      workspace.path !== checkout ||
      !workspace.branch ||
      !workspace.baseRevision
    ) {
      throw new Error(
        "workflow workspace manifest does not match this repository",
      );
    }
  } else {
    if (!create)
      throw new Error(
        "workflow has no implementation worktree to review or publish",
      );
    if (git(root, "status", "--porcelain")) {
      throw new Error(
        "workgraph requires a clean source checkout before creating an implementation branch",
      );
    }
    const label =
      issueId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "issue";
    workspace = {
      repoPath: root,
      path: checkout,
      branch: `workgraph/${label}-${key.slice(0, 8)}`,
      baseRevision: git(root, "rev-parse", "HEAD"),
    };
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(workspace, null, 2)}\n`);
    renameSync(tmp, file);
  }
  if (!existsSync(checkout)) {
    if (!create)
      throw new Error(
        "workflow worktree is missing; refusing to review or publish the source checkout",
      );
    git(
      root,
      "worktree",
      "add",
      "-b",
      workspace.branch,
      checkout,
      workspace.baseRevision,
    );
  }
  if (git(checkout, "symbolic-ref", "--short", "HEAD") !== workspace.branch) {
    throw new Error("workflow worktree changed branches; refusing to continue");
  }
  return workspace;
}
