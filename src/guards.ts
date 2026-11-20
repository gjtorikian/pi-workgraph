/**
 * The diff guards: three checks that stop an implementer from moving the bar
 * it is judged against. Each reads the difference between the BASE tree and
 * the RESULT tree of a run (`src/snapshot.ts`) and maps to one gate:
 *
 *   weakened-tests — a test file was deleted, or a line added to a test
 *                    file disables a test (a skip marker).
 *   scope          — a file changed that the approved plan's file paths do
 *                    not cover.
 *   unproven-tests — new or changed tests pass on the base without the
 *                    change, so they prove nothing about it. Decided by
 *                    running the check in a throwaway worktree of the base
 *                    with only the test files applied; the coordinator owns
 *                    that run, and this module says which files to apply
 *                    ({@link testChanges}).
 *
 * WHAT A GUARD RETURNS. A {@link GuardFinding}: `pass`, `violation`,
 * `not-applicable` (nothing for the guard to look at) or `unknown` (it
 * could not tell: git failed, there was no tree, the base was red). A guard
 * never throws, and `unknown` never blocks (`src/proof.ts`): these are
 * heuristics over a diff, and work whose own check and review passed is not
 * held because a heuristic was blind.
 *
 * WHAT COUNTS AS A TEST. A file whose path matches one of the test globs:
 * {@link DEFAULT_TEST_GLOBS}, or the repository's `check.testGlobs` setting,
 * which replaces them. Everything under a `test/` directory is a test file
 * by the defaults, helpers and fixtures included. The matcher is hand-written
 * ({@link globToRegExp}); Node's own glob matching is still experimental on
 * the oldest Node this package supports.
 *
 * WHAT THE GUARDS DO NOT SEE. An assertion loosened without a marker, a
 * test emptied out but left in place, a file the plan named and should not
 * have. The reviewer and the other guards are the remaining lines of
 * defense; this module claims no more than its patterns.
 *
 * A VIOLATION is not the end of the work. The coordinator gives the
 * implementer one revision round per guard and per issue, outside the
 * revision bound, and then parks the issue with a question for a human, who
 * can answer `allow` ({@link GUARD_ALLOW_ANSWER}).
 *
 * This file and `test/diff-guards.test.ts` are the two files the
 * repository's own no-skipped-tests check leaves out, because they hold the
 * marker text as data. The patterns below are still assembled from parts,
 * so no line of this file reads as a disabled test.
 */
import type { GuardGate } from "./policy.ts";
import type { GateResult } from "./proof.ts";
import {
  addedLines,
  changedFiles,
  fileAt,
  type ChangedFile,
} from "./snapshot.ts";

/** What one guard found on one pair of trees. */
export interface GuardFinding {
  result: GateResult;
  /** The files the result is about: the violating ones, or none. */
  files: string[];
  reason?: string;
}

/** Which files are tests, unless the repository's `check.testGlobs` says otherwise. */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test_*.py",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
];

/** The one answer to a guard question that records an allowance. */
export const GUARD_ALLOW_ANSWER = "allow";

/** How many file names a reason, a finding or a question lists before it counts the rest. */
export const MAX_LISTED_FILES = 10;

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * A glob as an anchored regular expression over a `/`-separated path.
 *
 *   `**` followed by `/` matches zero or more whole directories, so
 *        `**` + `/*.test.*` matches a test file at the repository root too
 *   `**` anywhere else matches anything, `/` included
 *   `*`  matches within one path component
 *   `?`  matches one character that is not `/`
 *
 * Every other character is literal. A glob with no `/` matches a file name
 * at any depth.
 */
export function globToRegExp(glob: string): RegExp {
  let source = glob.includes("/") ? "" : "(?:.*/)?";
  for (let i = 0; i < glob.length; ) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      const opensComponent = i === 0 || glob[i - 1] === "/";
      if (opensComponent && glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 3;
      } else {
        source += ".*";
        i += 2;
      }
    } else if (char === "*") {
      source += "[^/]*";
      i += 1;
    } else if (char === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

const compiledGlobs = new Map<string, RegExp>();

function matchesGlob(path: string, glob: string): boolean {
  let pattern = compiledGlobs.get(glob);
  if (pattern === undefined) {
    pattern = globToRegExp(glob);
    compiledGlobs.set(glob, pattern);
  }
  return pattern.test(path);
}

/** Whether `path` (from the tree's root, `/`-separated) matches any of `globs`. */
export function isTestFile(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}

/** `name` called as a method: a dot, the name, an opening parenthesis. */
function methodCall(name: string): string {
  return ["\\.", name, "\\s*\\("].join("");
}

/**
 * What a line that disables a test looks like, across the common runners.
 * Each pattern is anchored on a word boundary where a longer, harmless word
 * would otherwise match: the x-prefixed aliases must not match a call that
 * merely ends in the same letters, and the annotations must not match a
 * longer annotation that starts the same way.
 */
export const SKIP_MARKERS: readonly RegExp[] = [
  // JavaScript runners: a test, suite or bench switched off by a modifier,
  // also through a chain (`.concurrent`, `.each`).
  new RegExp(`\\b(?:it|test|describe|suite|context|bench)\\b(?:\\.\\w+)*${methodCall("skip")}`),
  // A placeholder with no body, and a suite narrowed to one test.
  new RegExp(methodCall("todo")),
  new RegExp(methodCall("only")),
  // The x-prefixed aliases.
  new RegExp(`\\bx(?:it|test|describe|context)\\s*\\(`),
  // Python.
  new RegExp(["@pytest", "mark", "skip"].join("\\.")),
  new RegExp(["@unittest", "skip"].join("\\.")),
  // Go: the three ways a test stops itself.
  new RegExp(`\\bt\\.Skip(?:f|Now)?\\s*\\(`),
  // Rust.
  new RegExp(`#\\[\\s*ignore\\b`),
  // JUnit 5 and JUnit 4.
  new RegExp(`@Disabled\\b`),
  new RegExp(`@Ignore\\b`),
];

/** Whether a line of code holds a skip marker. */
export function hasSkipMarker(line: string): boolean {
  return SKIP_MARKERS.some((marker) => marker.test(line));
}

/** File names for a reason or a question: the first few, then a count of the rest. */
export function listFiles(files: readonly string[]): string {
  if (files.length <= MAX_LISTED_FILES) return files.join(", ");
  return `${files.slice(0, MAX_LISTED_FILES).join(", ")} and ${files.length - MAX_LISTED_FILES} more`;
}

function unique(files: readonly string[]): string[] {
  return [...new Set(files)];
}

function gitError(e: unknown): string {
  const stderr = (e as { stderr?: unknown } | null)?.stderr;
  const detail =
    typeof stderr === "string" && stderr.trim() !== ""
      ? stderr.trim()
      : e instanceof Error
        ? e.message
        : String(e);
  return detail.split("\n")[0] ?? "git failed";
}

// ---------------------------------------------------------------------------
// weakened-tests
// ---------------------------------------------------------------------------

/**
 * Did the change weaken the tests? A violation when a test file was deleted,
 * when a test file was renamed to a path that is no longer a test, or when
 * a line added to a test file holds a skip marker. A rename that stays a
 * test is not a deletion, and only its edited lines are read. No changed
 * test file is a `pass`. Git failing (or a diff too large to read) is
 * `unknown`.
 *
 * `changed` is the tree diff when the caller already has it.
 */
export function weakenedTests(
  repo: string,
  baseTree: string,
  tree: string,
  globs: readonly string[],
  changed?: readonly ChangedFile[],
): GuardFinding {
  try {
    const deleted: string[] = [];
    const diffed: string[] = [];
    const tests = new Set<string>();
    for (const change of changed ?? changedFiles(repo, baseTree, tree)) {
      if (change.status === "D") {
        if (isTestFile(change.path, globs)) deleted.push(change.path);
        continue;
      }
      const wasTest =
        change.oldPath !== undefined && isTestFile(change.oldPath, globs);
      if (!isTestFile(change.path, globs)) {
        if (wasTest) deleted.push(change.oldPath!);
        continue;
      }
      tests.add(change.path);
      // Both paths of a rename, so git pairs them and the diff is the edit.
      if (change.oldPath !== undefined) diffed.push(change.oldPath);
      diffed.push(change.path);
    }
    const marked = unique(
      addedLines(repo, baseTree, tree, diffed)
        .filter((line) => tests.has(line.file) && hasSkipMarker(line.text))
        .map((line) => line.file),
    );
    if (deleted.length === 0 && marked.length === 0) {
      return { result: "pass", files: [] };
    }
    const parts = [
      ...(deleted.length > 0 ? [`test files deleted: ${listFiles(deleted)}`] : []),
      ...(marked.length > 0 ? [`skip markers added: ${listFiles(marked)}`] : []),
    ];
    return {
      result: "violation",
      files: unique([...deleted, ...marked]),
      reason: parts.join("; "),
    };
  } catch (e) {
    return {
      result: "unknown",
      files: [],
      reason: `the diff could not be read: ${gitError(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------

/** A lockfile, and the manifest whose change explains a change to it. */
const LOCKFILE_MANIFESTS: Readonly<Record<string, string>> = {
  "package-lock.json": "package.json",
  "pnpm-lock.yaml": "package.json",
  "yarn.lock": "package.json",
  "bun.lockb": "package.json",
  "Cargo.lock": "Cargo.toml",
  "go.sum": "go.mod",
  "Gemfile.lock": "Gemfile",
  "poetry.lock": "pyproject.toml",
  "uv.lock": "pyproject.toml",
};

/** Whether one target of the approved plan covers `file`. */
function targetCovers(target: string, file: string): boolean {
  if (target.includes("*") || target.includes("?")) {
    return matchesGlob(file, target);
  }
  const path = target.replace(/\/+$/, "");
  // The file itself, or anything under it when it names a directory.
  return file === path || file.startsWith(`${path}/`);
}

/**
 * Did the change stay inside the approved plan? `changed` is every path the
 * change touched (both paths of a rename, deleted files included);
 * `targets` is the plan's file paths, or undefined when the run implements
 * no approved plan.
 *
 *   no approved plan, or one that names no file path → `not-applicable`
 *   every changed file is covered or exempt          → `pass`
 *   otherwise                                        → `violation`
 *
 * A target names a file, a directory (everything under it) or, with a `*`
 * or `?`, a glob. Never out of scope: a test file; anything under
 * `.workgraph/`; a lockfile when the manifest beside it changed too, in the
 * same directory, so a monorepo package's lockfile is explained by that
 * package's manifest and by no other.
 */
export function scopeGuard(
  changed: readonly string[],
  targets: readonly string[] | undefined,
  globs: readonly string[],
): GuardFinding {
  if (targets === undefined) {
    return {
      result: "not-applicable",
      files: [],
      reason: "no plan was approved at the plan gate",
    };
  }
  if (targets.length === 0) {
    return {
      result: "not-applicable",
      files: [],
      reason: "the approved plan names no file paths",
    };
  }
  const touched = new Set(changed);
  const outside = unique(changed).filter((file) => {
    if (file.startsWith(".workgraph/") || isTestFile(file, globs)) return false;
    const slash = file.lastIndexOf("/");
    const manifest = LOCKFILE_MANIFESTS[file.slice(slash + 1)];
    if (
      manifest !== undefined &&
      touched.has(`${file.slice(0, slash + 1)}${manifest}`)
    ) {
      return false;
    }
    return !targets.some((target) => targetCovers(target, file));
  });
  if (outside.length === 0) return { result: "pass", files: [] };
  return {
    result: "violation",
    files: outside,
    reason: `files changed outside the approved plan's paths: ${listFiles(outside)}`,
  };
}

/** Every path a tree diff touched: both paths of a rename, deleted files included. */
export function touchedPaths(changed: readonly ChangedFile[]): string[] {
  return unique(
    changed.flatMap((change) =>
      change.oldPath !== undefined ? [change.oldPath, change.path] : [change.path],
    ),
  );
}

// ---------------------------------------------------------------------------
// unproven-tests
// ---------------------------------------------------------------------------

/** The test-file part of a change, as it is applied to a checkout of the base. */
export interface TestChanges {
  /** Test files to take from the result tree: added, modified, or renamed and edited. */
  apply: string[];
  /** Old paths of those renames, removed so the tests do not exist twice. */
  remove: string[];
}

/**
 * The added and modified test files of a change. A test file that was only
 * renamed, content unchanged, is left out: it says nothing new. One that was
 * renamed and edited is applied under its new path, and its old path is
 * removed. Reads file content through git, so it can throw.
 */
export function testChanges(
  repo: string,
  baseTree: string,
  tree: string,
  changed: readonly ChangedFile[],
  globs: readonly string[],
): TestChanges {
  const apply: string[] = [];
  const remove: string[] = [];
  for (const change of changed) {
    if (change.status === "D" || !isTestFile(change.path, globs)) continue;
    if (change.status === "R" && change.oldPath !== undefined) {
      const before = fileAt(repo, baseTree, change.oldPath);
      if (before !== undefined && before === fileAt(repo, tree, change.path)) {
        continue;
      }
      remove.push(change.oldPath);
    }
    apply.push(change.path);
  }
  return { apply, remove };
}

// ---------------------------------------------------------------------------
// The round and the decision
// ---------------------------------------------------------------------------

/**
 * The question a human is asked when a guard still finds a violation after
 * its one revision round. It names each gate with what it found, and ends
 * by saying what the two possible answers do.
 */
export function guardQuestion(
  violations: ReadonlyArray<{ gate: GuardGate; reason: string }>,
): string {
  const found = violations
    .map(({ gate, reason }) => `${gate}: ${reason}`)
    .join("; ");
  const subject =
    violations.length === 1
      ? `The ${violations[0]!.gate} guard still finds a violation`
      : "The diff guards still find violations";
  return `${subject} after one revision round (${found}). Reply "${GUARD_ALLOW_ANSWER}" to accept these changes, or describe what to change.`;
}
