/**
 * Git plumbing for proof: every git call the tree-binding gate makes lives
 * here.
 *
 * A SNAPSHOT is the content of a working tree as it is right now — tracked
 * and untracked files, ignored files excluded — written as a git tree
 * object. Nothing commits today and in-session work happens in the user's
 * own checkout (decision log), so the core takes the snapshot itself and
 * never asks an executor to commit:
 *
 *  - {@link treeOf} stages the working tree into a TEMPORARY index and
 *    writes a tree from it. The real index is copied, never written, so the
 *    user's staged changes and `git status` are exactly what they were.
 *    Copying keeps the stat cache, so unchanged files are not rehashed.
 *  - {@link snapshotWorkspace} wraps that tree in a commit object and
 *    anchors it under a private ref, because `git gc` prunes an
 *    unreferenced tree. The commit is on no branch and moves no `HEAD`.
 *
 * REFS live under `refs/workgraph/` ({@link proofRef}), which is not a
 * branch namespace and is not pushed by default. Linked worktrees share
 * refs, so a reviewer in another worktree of the same repository can
 * resolve them.
 *
 * WHAT A TREE DOES NOT SEE. Submodules and nested repositories are recorded
 * as one gitlink, so an edit inside one never changes the tree. Ignored
 * files are not part of it.
 *
 * FAILURE. Every function throws when git fails ({@link isGitWorkspace} and
 * {@link fileAt} report failure as `false` / `undefined` instead); callers
 * turn a throw into `tree-binding: unknown`. Each call is synchronous and
 * bounded at 20 seconds, so callers keep these out of retry loops.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** A working tree captured as an anchored commit. */
export interface Snapshot {
  commit: string;
  tree: string;
  ref: string;
}

/** One path that differs between two trees. */
export interface ChangedFile {
  status: "A" | "M" | "D" | "R";
  path: string;
  /** The path before a rename (`status: "R"` only). */
  oldPath?: string;
}

/** Namespace of every ref this module creates. */
export const PROOF_REF_NAMESPACE = "refs/workgraph";

const GIT_TIMEOUT_MS = 20_000;

/** Cap on one file read by {@link fileAt}; a larger file reads as undefined. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Variables that redirect git away from `cwd`. A process started from a git
 * hook inherits them, and with them set every call here would operate on
 * the hook's repository instead of the workspace it was given.
 */
const REDIRECTING_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

/**
 * Fixed identity for snapshot commits: `commit-tree` fails on a machine
 * with no configured identity, and a snapshot must not depend on whose
 * machine took it.
 */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "pi-workgraph",
  GIT_AUTHOR_EMAIL: "pi-workgraph@localhost",
  GIT_COMMITTER_NAME: "pi-workgraph",
  GIT_COMMITTER_EMAIL: "pi-workgraph@localhost",
};

/**
 * This process's environment without the variables that redirect git. For
 * anything started in a workspace that may run git itself: the snapshot
 * calls here, and the check command (`src/check.ts`).
 */
export function workspaceEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of REDIRECTING_ENV) delete env[name];
  return env;
}

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...workspaceEnv(), GIT_TERMINAL_PROMPT: "0", ...extra };
}

/**
 * A relative or empty path would make git run in the process's own
 * directory and snapshot the wrong repository.
 */
function assertWorkspacePath(path: string): void {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
    throw new Error(
      `workspace path must be absolute (got ${JSON.stringify(path)})`,
    );
  }
}

function git(
  path: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): string {
  assertWorkspacePath(path);
  return execFileSync("git", args, {
    cwd: path,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: gitEnv(extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Whether `path` is inside a git working tree. Never throws. */
export function isGitWorkspace(path: string): boolean {
  try {
    return git(path, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/**
 * Tree SHA of the working tree as it is now: tracked and untracked files,
 * ignored files excluded. Writes blob and tree objects, and nothing else:
 * the index, `HEAD` and every ref are left as they were.
 */
export function treeOf(path: string): string {
  // Relative to `path` in a main checkout, absolute in a linked worktree.
  const rawIndex = git(path, ["rev-parse", "--git-path", "index"]);
  const realIndex = isAbsolute(rawIndex) ? rawIndex : resolve(path, rawIndex);
  const scratch = mkdtempSync(join(tmpdir(), "pi-workgraph-index-"));
  const tempIndex = join(scratch, "index");
  try {
    // A repository with no commits and nothing staged has no index file;
    // git then creates the temporary one from nothing.
    if (existsSync(realIndex)) copyFileSync(realIndex, tempIndex);
    const env = { GIT_INDEX_FILE: tempIndex };
    git(path, ["add", "-A"], env);
    return git(path, ["write-tree"], env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * {@link treeOf}, wrapped in a commit object and anchored at `ref`. The
 * commit's parent is `HEAD` when the repository has one; a repository with
 * no commits yields a root commit.
 */
export function snapshotWorkspace(
  path: string,
  ref: string,
  message: string,
): Snapshot {
  return anchorTree(path, treeOf(path), ref, message);
}

/**
 * Wrap an EXISTING tree in a commit object and anchor it at `ref`. For a
 * caller that already holds the tree it compared (from {@link treeOf}):
 * anchoring that exact tree leaves no window in which the working tree
 * could move between the comparison and the snapshot.
 */
export function anchorTree(
  path: string,
  tree: string,
  ref: string,
  message: string,
): Snapshot {
  let parent: string | undefined;
  try {
    parent = git(path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    parent = undefined; // no commits yet
  }
  const commit = git(
    path,
    [
      "commit-tree",
      tree,
      ...(parent ? ["-p", parent] : []),
      "--no-gpg-sign",
      "-m",
      message,
    ],
    SNAPSHOT_IDENTITY,
  );
  git(path, ["update-ref", ref, commit]);
  return { commit, tree, ref };
}

/** The tree a commit points at. */
export function treeOfCommit(path: string, commit: string): string {
  return git(path, ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`]);
}

/**
 * The paths that differ between two trees, renames detected. A type change
 * (file to symlink) reports as `M`.
 */
export function changedFiles(
  path: string,
  baseTree: string,
  tree: string,
): ChangedFile[] {
  // `-z`: NUL-separated fields and unquoted paths, so a path with spaces or
  // non-ASCII characters round-trips. Not trimmed: a path may end in space.
  assertWorkspacePath(path);
  const out = execFileSync(
    "git",
    ["diff", "--name-status", "-M", "-z", baseTree, tree],
    {
      cwd: path,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_FILE_BYTES,
    },
  );
  const fields = out.split("\0");
  const changes: ChangedFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++] ?? "";
    if (code === "") continue; // the trailing separator
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = fields[i++] ?? "";
      const newPath = fields[i++] ?? "";
      // The similarity score (`R087`) is dropped. A copy is an added file.
      changes.push(
        letter === "R"
          ? { status: "R", path: newPath, oldPath }
          : { status: "A", path: newPath },
      );
      continue;
    }
    const file = fields[i++] ?? "";
    changes.push({
      status: letter === "A" ? "A" : letter === "D" ? "D" : "M",
      path: file,
    });
  }
  return changes;
}

/**
 * The content of `file` at `tree`, byte for byte. Undefined when the tree
 * has no such file, the file is larger than 16 MiB, or git fails.
 */
export function fileAt(
  path: string,
  tree: string,
  file: string,
): string | undefined {
  try {
    assertWorkspacePath(path);
    // Not through the trimming helper: trimming would change the content.
    return execFileSync("git", ["show", `${tree}:${file}`], {
      cwd: path,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_FILE_BYTES,
    });
  } catch {
    return undefined;
  }
}

/** One ref path component git accepts, whatever the input was. */
function refComponent(raw: string): string {
  let part = raw
    .replace(/[^A-Za-z0-9._-]/g, "-") // whitespace, `@{`, `~^:?*[\`, control chars
    .replace(/\.{2,}/g, "-") // `..`
    .replace(/^\.+/, "") // a leading `.`
    .replace(/\.+$/, ""); // a trailing `.`
  if (part.toLowerCase().endsWith(".lock")) part = `${part.slice(0, -5)}-lock`;
  return part === "" ? "x" : part;
}

/**
 * The private ref for one snapshot of one issue:
 * `refs/workgraph/<issue>/<name>`. `name` may hold `/` to group refs (the
 * coordinator uses `<run key>/base` and `<run key>/result-<attempt>`); each
 * component is sanitized on its own. A caller must not use one name both as
 * a ref and as a prefix of another (`a` and `a/b` cannot coexist in git).
 */
export function proofRef(issueId: string, name: string): string {
  const parts = name
    .split("/")
    .filter((part) => part !== "")
    .map(refComponent);
  return [
    PROOF_REF_NAMESPACE,
    refComponent(issueId),
    ...(parts.length > 0 ? parts : ["x"]),
  ].join("/");
}

/**
 * A workflow-run id as one ref-safe component. Run ids hold a slash
 * (`workgraph-run/<uuid>`); this is the same 20-hex key the bridge uses for
 * its per-run worktree directory.
 */
export function runKey(workflowRunId: string): string {
  return createHash("sha256").update(workflowRunId).digest("hex").slice(0, 20);
}
