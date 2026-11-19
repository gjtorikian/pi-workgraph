/**
 * The work store: one SQLite database per repository, opened through
 * Node's built-in `node:sqlite` — either `.workgraph/workgraph.db` inside
 * the repository (gitignored) or, with the `central` store policy, a file
 * under `~/.pi/agent/workgraph/<repo-key>/` so nothing lives in the
 * checkout at all. No external binary, no daemon, nothing to check in.
 *
 * Every function keeps the `cwd`-first, Promise-returning signature the
 * rest of the extension was written against, so callers need no knowledge
 * of the storage engine. The work itself is synchronous (`DatabaseSync`);
 * the async wrappers exist so the API stays a seam, not a commitment.
 *
 * CONCURRENCY. Cross-process safety is SQLite's own file locking: WAL
 * journaling, a busy timeout for lock contention, and `BEGIN IMMEDIATE`
 * around the read-then-write of claim-next. In-process, `DatabaseSync` is
 * synchronous, so there is nothing to serialize — the old exec queue that
 * guarded an embedded SQLite against concurrent access is gone with it.
 *
 * CLAIMS. `claim`/`claimNext` are the only assignee writers besides the
 * loudly documented `overwriteAssigneeForReclaim` (sweep-only, epoch-fenced
 * takeover of expired leases) and `release`. A claim is one conditional
 * UPDATE: it succeeds for an unassigned issue or for the same actor
 * re-claiming (idempotent), and rejects a conflicting claim with
 * `already claimed by <holder>` — the message the lease layer and the
 * cross-process suites match on.
 *
 * METADATA is a JSON column merged per key (`json_patch`), so same-key
 * writers are last-writer-wins exactly as before; the lease layer's
 * post-write verification keeps the fencing contract intact. Values round
 * trip as written: a writer that stamps `"4"` reads back `"4"`. Readers
 * normalize through the accessors in lease.ts / lifecycle.ts and never
 * trust the raw shape.
 *
 * TIMESTAMPS are ISO-8601 UTC with millisecond precision. Every write —
 * including a byte-identical metadata rewrite — bumps `updated_at`, which
 * is what lets a heartbeat double as the expiry sweep's staleness signal.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { WorkIssue, WorkIssueRef } from "./types.ts";
import {
  LEASE_EXPIRES_AT_KEY,
  LEASE_HOLDER_KEY,
  WORKGRAPH_LIFECYCLE_VERSION_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_RISK_TIER_KEY,
  WORKGRAPH_WORKFLOW_CLASS_KEY,
} from "./types.ts";

/** Directory (under the workspace root) that holds the database. */
export const STORE_DIR = ".workgraph";
/** Database file name inside {@link STORE_DIR}. */
export const STORE_FILE = "workgraph.db";
/** Current on-disk schema version (bumped with every migration). */
export const SCHEMA_VERSION = 1;

/** Error thrown for any failed store operation. */
export class StoreError extends Error {
  /** The operation that failed. */
  readonly op: string;

  constructor(message: string, op: string) {
    super(message);
    this.name = "StoreError";
    this.op = op;
  }
}

// ---------------------------------------------------------------------------
// Operation log (tests): which store operations ran, in order. The claim
// invariants ("every claim went through the atomic path, zero bare assignee
// writes") are asserted against this log.
// ---------------------------------------------------------------------------

export type StoreOp =
  | "ready"
  | "claim"
  | "claimNext"
  | "show"
  | "close"
  | "release"
  | "update"
  | "setMetadata"
  | "unsetMetadata"
  | "listInProgressUpdatedBefore"
  | "overwriteAssignee"
  | "addComment"
  | "listComments"
  | "createIssue"
  | "addDependency"
  | "listIssues";

export interface OpLogEntry {
  op: StoreOp;
  issueId?: string;
  timestamp: number;
}

const opLog: OpLogEntry[] = [];

/** Read-only view of every operation recorded since the last reset. */
export function getOpLog(): readonly OpLogEntry[] {
  return opLog;
}

/** Clear the operation log. */
export function resetOpLog(): void {
  opLog.length = 0;
}

function recordOp(op: StoreOp, issueId?: string): void {
  opLog.push({ op, ...(issueId !== undefined ? { issueId } : {}), timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// Workspace discovery and initialization
//
// Two layouts, chosen by the store POLICY (settings `store`, applied at
// session_start via configureStore):
//
//   repo     — `<root>/.workgraph/workgraph.db`, found by walking up from the
//              cwd like git finds `.git`. The directory ships a .gitignore.
//   central  — `<centralDir>/<key>/workgraph.db`, one per repository, where
//              <key> = basename + short hash of the MAIN checkout's absolute
//              path. Nothing is written inside the repository at all.
//
// Discovery always honors an existing in-repo store first, so switching the
// policy never strands a graph; "central" only decides where NEW workspaces
// are created and where to look when the repo has none.
//
// The repository identity is the main checkout: a git worktree's `.git`
// FILE points at `<main>/.git/worktrees/<name>`, and that main checkout is
// the key — so pi-subagents workers in their worktrees see the same graph
// as the session that dispatched them.
// ---------------------------------------------------------------------------

export type StoreMode = "repo" | "central";

export interface StorePolicy {
  mode: StoreMode;
  /** Directory holding per-repository databases in central mode. */
  centralDir: string;
}

const DEFAULT_CENTRAL_DIR = join(homedir(), ".pi", "agent", "workgraph");

let policy: StorePolicy = { mode: "repo", centralDir: DEFAULT_CENTRAL_DIR };

/**
 * Set the store policy. `store` is `"repo"`, `"central"`, or an absolute
 * directory (central mode rooted there). Clears the discovery cache.
 */
export function configureStore(store: string | undefined, opts: { agentDir?: string } = {}): StorePolicy {
  const agentCentral = opts.agentDir ? join(opts.agentDir, "workgraph") : DEFAULT_CENTRAL_DIR;
  const raw = store?.trim();
  if (!raw || raw === "repo") policy = { mode: "repo", centralDir: agentCentral };
  else if (raw === "central") policy = { mode: "central", centralDir: agentCentral };
  else policy = { mode: "central", centralDir: resolve(raw.replace(/^~(?=$|\/)/, homedir())) };
  rootCache.clear();
  return policy;
}

export function storePolicy(): StorePolicy {
  return policy;
}

const rootCache = new Map<string, string>();
const handles = new Map<string, DatabaseSync>();

/**
 * The repository identity for `dir`: the nearest ancestor holding `.git`,
 * resolved through a worktree's `.git` file to the MAIN checkout. A
 * directory outside any git repository is its own root.
 */
export function resolveRepoRoot(dir: string): string {
  let current = resolve(dir);
  for (;;) {
    const dotGit = join(current, ".git");
    if (existsSync(dotGit)) {
      try {
        if (statSync(dotGit).isDirectory()) return current;
        const text = readFileSync(dotGit, "utf8");
        const match = /^gitdir:\s*(.+)$/m.exec(text);
        if (match) {
          const gitDir = resolve(current, match[1]!.trim());
          // <main>/.git/worktrees/<name> → <main>
          const marker = `${sep}.git${sep}worktrees${sep}`;
          const at = gitDir.indexOf(marker);
          if (at !== -1) return gitDir.slice(0, at);
          // A linked `.git` file that is not a worktree (e.g. a submodule):
          // the directory itself is the identity.
        }
      } catch {
        /* unreadable .git: treat the directory as the root */
      }
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(dir);
    current = parent;
  }
}

/** The central-store key for a repository root: `<basename>-<hash12>`. */
export function centralKey(root: string): string {
  const name = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  // Hash the CANONICAL path: a cwd reached through a symlink (macOS `/var`
  // → `/private/var`, or a linked projects dir) must key the same database.
  let canonical = resolve(root);
  try {
    canonical = realpathSync(canonical);
  } catch {
    /* not on disk yet: hash the resolved path */
  }
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `${name}-${hash}`;
}

function repoDbPath(root: string): string {
  return join(root, STORE_DIR, STORE_FILE);
}

function centralDbPath(root: string): string {
  return join(policy.centralDir, centralKey(root), STORE_FILE);
}

/** Where the database for an existing or to-be-created workspace root lives. */
export function databasePathFor(root: string): string {
  const inRepo = repoDbPath(root);
  if (existsSync(inRepo)) return inRepo;
  const central = centralDbPath(root);
  if (existsSync(central)) return central;
  return policy.mode === "central" ? central : inRepo;
}

/**
 * Find the workspace root for `cwd`: the nearest ancestor (inclusive)
 * holding `.workgraph/workgraph.db`; failing that, the repository root when
 * a central database exists for it. Returns undefined when there is none.
 * Successes are cached per cwd; misses are not, so a workspace initialized
 * mid-session is picked up on the next probe.
 */
export function findWorkspaceRoot(cwd: string): string | undefined {
  const start = resolve(cwd);
  const hit = rootCache.get(start);
  if (hit) return hit;
  let dir = start;
  for (;;) {
    if (existsSync(repoDbPath(dir))) {
      rootCache.set(start, dir);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const root = resolveRepoRoot(start);
  if (existsSync(centralDbPath(root))) {
    rootCache.set(start, root);
    return root;
  }
  return undefined;
}

/**
 * Throw unless `cwd` is inside an initialized workspace. The message names
 * the recovery (`workgraph_init`), never a third-party binary.
 */
export async function ensureWorkspace(cwd: string): Promise<void> {
  if (findWorkspaceRoot(cwd) === undefined) {
    throw new StoreError(
      `No workgraph workspace found in ${cwd} — run the workgraph_init tool (or \`/workgraph init\`) first`,
      "ensureWorkspace",
    );
  }
}

export interface InitWorkspaceOptions {
  /** Issue-id prefix (default: a sanitized directory basename, max 8 chars). */
  prefix?: string;
}

function defaultPrefix(root: string): string {
  const raw = basename(root).toLowerCase().replace(/[^a-z0-9]/g, "");
  return raw.slice(0, 8) || "wg";
}

export interface InitWorkspaceResult {
  /** The workspace root (the repository, or the directory itself). */
  root: string;
  /** Absolute path of the database file. */
  databasePath: string;
  prefix: string;
  /** False when the workspace already existed (left untouched). */
  created: boolean;
}

/**
 * Create the workspace for `dir` (idempotent: an existing workspace is left
 * untouched and described). In repo mode the database lands at
 * `<dir>/.workgraph/workgraph.db` with a `.gitignore` beside it; in central
 * mode it lands under the central directory, keyed by the repository, with
 * a `repo` file naming the checkout for humans — nothing inside the repo.
 */
export function initWorkspaceSync(dir: string, opts: InitWorkspaceOptions = {}): InitWorkspaceResult {
  const here = resolve(dir);
  const existing = findWorkspaceRoot(here);
  if (existing !== undefined && (existing === here || resolveRepoRoot(here) === existing)) {
    const db = openAt(existing);
    return { root: existing, databasePath: databasePathFor(existing), prefix: prefixOf(db), created: false };
  }
  const root = policy.mode === "central" ? resolveRepoRoot(here) : here;
  const databasePath = policy.mode === "central" ? centralDbPath(root) : repoDbPath(root);
  mkdirSync(dirname(databasePath), { recursive: true });
  if (policy.mode === "central") {
    writeFileSync(join(dirname(databasePath), "repo"), `${root}\n`);
  } else {
    writeFileSync(join(dirname(databasePath), ".gitignore"), `${STORE_FILE}\n${STORE_FILE}-*\n`);
  }
  const db = openAt(root);
  const prefix = (opts.prefix ?? defaultPrefix(root)).toLowerCase();
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('prefix', ?)").run(prefix);
  rootCache.set(root, root);
  rootCache.set(here, root);
  return { root, databasePath, prefix, created: true };
}

/** Async form of {@link initWorkspaceSync}. */
export async function initWorkspace(dir: string, opts: InitWorkspaceOptions = {}): Promise<InitWorkspaceResult> {
  return initWorkspaceSync(dir, opts);
}

/** Close every open handle (tests; also safe at shutdown). */
export function closeAllWorkspaces(): void {
  for (const db of handles.values()) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  handles.clear();
  rootCache.clear();
}

/** Close the handle for one workspace root (scratch cleanup). */
export function closeWorkspace(dir: string): void {
  const root = findWorkspaceRoot(dir) ?? resolve(dir);
  const db = handles.get(root);
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    handles.delete(root);
  }
  for (const [cwd, r] of rootCache) if (r === root) rootCache.delete(cwd);
}

/** Test-only: forget cached workspace roots (handles stay open). */
export function resetProbesForTest(): void {
  rootCache.clear();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issues (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'open',
  priority            INTEGER NOT NULL DEFAULT 2,
  issue_type          TEXT NOT NULL DEFAULT 'task',
  assignee            TEXT,
  owner               TEXT,
  acceptance_criteria TEXT,
  labels              TEXT NOT NULL DEFAULT '[]',
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  created_by          TEXT,
  updated_at          TEXT NOT NULL,
  updated_by          TEXT,
  closed_at           TEXT,
  close_reason        TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues (status, priority, created_at);
CREATE TABLE IF NOT EXISTS dependencies (
  issue_id        TEXT NOT NULL,
  depends_on      TEXT NOT NULL,
  dependency_type TEXT NOT NULL DEFAULT 'blocks',
  created_at      TEXT NOT NULL,
  PRIMARY KEY (issue_id, depends_on)
);
CREATE INDEX IF NOT EXISTS idx_dependencies_depends_on ON dependencies (depends_on);
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id   TEXT NOT NULL,
  author     TEXT,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments (issue_id, id);
`;

function openAt(root: string): DatabaseSync {
  const cached = handles.get(root);
  if (cached) return cached;
  const db = new DatabaseSync(databasePathFor(root));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    String(SCHEMA_VERSION),
  );
  handles.set(root, db);
  return db;
}

function openDb(cwd: string, op: string): DatabaseSync {
  const root = findWorkspaceRoot(cwd);
  if (root === undefined) {
    throw new StoreError(
      `No workgraph workspace found in ${cwd} — run the workgraph_init tool (or \`/workgraph init\`) first`,
      op,
    );
  }
  return openAt(root);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Run `fn` inside an immediate (write-locked) transaction. */
function transact<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface IssueRow {
  id: string;
  title: string;
  description: string | null;
  notes: string | null;
  status: string;
  priority: number;
  issue_type: string;
  assignee: string | null;
  owner: string | null;
  acceptance_criteria: string | null;
  labels: string;
  metadata: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  closed_at: string | null;
  close_reason: string | null;
}

interface DepRow {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  dependency_type: string;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function dependenciesOf(db: DatabaseSync, id: string): WorkIssueRef[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.title, b.status, b.priority, b.issue_type, d.dependency_type
         FROM dependencies d JOIN issues b ON b.id = d.depends_on
        WHERE d.issue_id = ? ORDER BY d.created_at, b.id`,
    )
    .all(id) as unknown as DepRow[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    issue_type: r.issue_type,
    dependency_type: r.dependency_type,
  }));
}

function rowToIssue(db: DatabaseSync, row: IssueRow): WorkIssue {
  const issue: WorkIssue = {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    issue_type: row.issue_type,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    dependencies: dependenciesOf(db, row.id),
  };
  if (row.assignee) issue.assignee = row.assignee;
  if (row.owner) issue.owner = row.owner;
  if (row.description !== null) issue.description = row.description;
  if (row.notes !== null) issue.notes = row.notes;
  if (row.acceptance_criteria !== null) issue.acceptance_criteria = row.acceptance_criteria;
  const labels = parseJson<string[]>(row.labels, []);
  if (labels.length > 0) issue.labels = labels;
  if (row.created_by) issue.created_by = row.created_by;
  if (row.closed_at) issue.closed_at = row.closed_at;
  if (row.close_reason) issue.close_reason = row.close_reason;
  return issue;
}

function getRow(db: DatabaseSync, id: string): IssueRow | undefined {
  return db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined;
}

function requireRow(db: DatabaseSync, id: string, op: string): IssueRow {
  const row = getRow(db, id);
  if (!row) throw new StoreError(`Issue not found: ${id}`, op);
  return row;
}

// ---------------------------------------------------------------------------
// Synchronous core. Exported as `sync` for callers that are themselves
// synchronous (test fixtures, hooks, read-only tooling); everything else
// uses the async wrappers below.
// ---------------------------------------------------------------------------

const READY_SQL = `
  SELECT i.* FROM issues i
   WHERE i.status = 'open'
     AND (i.assignee IS NULL OR i.assignee = '')
     AND NOT EXISTS (
       SELECT 1 FROM dependencies d JOIN issues b ON b.id = d.depends_on
        WHERE d.issue_id = i.id AND d.dependency_type = 'blocks' AND b.status != 'closed'
     )
   ORDER BY i.priority ASC, i.rowid ASC
   LIMIT ?`;

function readySync(cwd: string, limit = 10): WorkIssue[] {
  recordOp("ready");
  const db = openDb(cwd, "ready");
  const rows = db.prepare(READY_SQL).all(limit > 0 ? limit : -1) as unknown as IssueRow[];
  return rows.map((r) => rowToIssue(db, r));
}

function claimRow(db: DatabaseSync, id: string, actor: string): void {
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE issues
          SET assignee = ?, status = 'in_progress', updated_at = ?, updated_by = ?
        WHERE id = ? AND status != 'closed'
          AND (assignee IS NULL OR assignee = '' OR assignee = ?)`,
    )
    .run(actor, now, actor, id, actor);
  if (result.changes === 1) return;
  const cur = requireRow(db, id, "claim");
  if (cur.status === "closed") {
    throw new StoreError(`Cannot claim ${id}: it is closed`, "claim");
  }
  throw new StoreError(`${id} already claimed by ${cur.assignee}`, "claim");
}

function claimSync(cwd: string, id: string, actor: string): void {
  recordOp("claim", id);
  const db = openDb(cwd, "claim");
  transact(db, () => claimRow(db, id, actor));
}

function claimNextSync(cwd: string, actor: string): WorkIssue | null {
  recordOp("claimNext");
  const db = openDb(cwd, "claimNext");
  return transact(db, () => {
    const next = db.prepare(READY_SQL).get(1) as IssueRow | undefined;
    if (!next) return null;
    claimRow(db, next.id, actor);
    return rowToIssue(db, requireRow(db, next.id, "claimNext"));
  });
}

function showSync(cwd: string, id: string): WorkIssue {
  recordOp("show", id);
  const db = openDb(cwd, "show");
  return rowToIssue(db, requireRow(db, id, "show"));
}

function closeSync(cwd: string, id: string, reason?: string, actor?: string): void {
  recordOp("close", id);
  const db = openDb(cwd, "close");
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE issues
          SET status = 'closed', closed_at = ?, close_reason = COALESCE(?, close_reason),
              updated_at = ?, updated_by = ?
        WHERE id = ?`,
    )
    .run(now, reason ?? null, now, actor ?? null, id);
  if (result.changes !== 1) throw new StoreError(`Issue not found: ${id}`, "close");
}

function releaseSync(cwd: string, id: string, actor?: string): void {
  recordOp("release", id);
  const db = openDb(cwd, "release");
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE issues
          SET assignee = NULL, status = 'open', closed_at = NULL,
              metadata = json_remove(metadata, '$.${LEASE_HOLDER_KEY}', '$.${LEASE_EXPIRES_AT_KEY}'),
              updated_at = ?, updated_by = ?
        WHERE id = ?`,
    )
    .run(now, actor ?? null, id);
  if (result.changes !== 1) throw new StoreError(`Issue not found: ${id}`, "release");
}

/**
 * General field updates. Deliberately excludes the assignee — claims must go
 * through `claim`/`claimNext` and releases through `release`.
 */
export interface UpdateFields {
  title?: string;
  description?: string;
  status?: string;
  priority?: number;
  notes?: string;
  /** Acceptance criteria the judgment gate checks. */
  acceptance?: string;
}

function updateSync(cwd: string, id: string, fields: UpdateFields, actor?: string): void {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  if (fields.title !== undefined) {
    sets.push("title = ?");
    values.push(fields.title);
  }
  if (fields.description !== undefined) {
    sets.push("description = ?");
    values.push(fields.description);
  }
  if (fields.status !== undefined) {
    sets.push("status = ?");
    values.push(fields.status);
    if (fields.status !== "closed") sets.push("closed_at = NULL");
  }
  if (fields.priority !== undefined) {
    sets.push("priority = ?");
    values.push(fields.priority);
  }
  if (fields.notes !== undefined) {
    sets.push("notes = ?");
    values.push(fields.notes);
  }
  if (fields.acceptance !== undefined) {
    sets.push("acceptance_criteria = ?");
    values.push(fields.acceptance);
  }
  if (sets.length === 0) return; // nothing to update
  recordOp("update", id);
  const db = openDb(cwd, "update");
  sets.push("updated_at = ?", "updated_by = ?");
  values.push(nowIso(), actor ?? null, id);
  const result = db.prepare(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  if (result.changes !== 1) throw new StoreError(`Issue not found: ${id}`, "update");
}

/** Metadata values round-trip as written; readers normalize. */
export type MetadataValue = string | number | boolean;

function patchMetadata(
  db: DatabaseSync,
  id: string,
  kv: Record<string, MetadataValue>,
  actor: string | undefined,
  op: string,
  extraSet = "",
  extraValues: SQLInputValue[] = [],
): void {
  const result = db
    .prepare(
      `UPDATE issues SET metadata = json_patch(metadata, ?)${extraSet}, updated_at = ?, updated_by = ? WHERE id = ?`,
    )
    .run(JSON.stringify(kv), ...extraValues, nowIso(), actor ?? null, id);
  if (result.changes !== 1) throw new StoreError(`Issue not found: ${id}`, op);
}

function setMetadataSync(
  cwd: string,
  id: string,
  kv: Record<string, MetadataValue>,
  actor?: string,
): void {
  if (Object.keys(kv).length === 0) return;
  recordOp("setMetadata", id);
  const db = openDb(cwd, "setMetadata");
  patchMetadata(db, id, kv, actor, "setMetadata");
}

function unsetMetadataSync(cwd: string, id: string, keys: string[], actor?: string): void {
  if (keys.length === 0) return;
  recordOp("unsetMetadata", id);
  const db = openDb(cwd, "unsetMetadata");
  const paths = keys.map((k) => `'$.${k.replace(/'/g, "''")}'`).join(", ");
  const result = db
    .prepare(
      `UPDATE issues SET metadata = json_remove(metadata, ${paths}), updated_at = ?, updated_by = ? WHERE id = ?`,
    )
    .run(nowIso(), actor ?? null, id);
  if (result.changes !== 1) throw new StoreError(`Issue not found: ${id}`, "unsetMetadata");
}

function listInProgressUpdatedBeforeSync(cwd: string, cutoff: string): WorkIssue[] {
  recordOp("listInProgressUpdatedBefore");
  const db = openDb(cwd, "listInProgressUpdatedBefore");
  const cutoffMs = Date.parse(cutoff);
  if (Number.isNaN(cutoffMs)) {
    throw new StoreError(`invalid cutoff timestamp: ${cutoff}`, "listInProgressUpdatedBefore");
  }
  const rows = db
    .prepare("SELECT * FROM issues WHERE status = 'in_progress' ORDER BY rowid ASC")
    .all() as unknown as IssueRow[];
  return rows.filter((r) => Date.parse(r.updated_at) < cutoffMs).map((r) => rowToIssue(db, r));
}

function overwriteAssigneeForReclaimSync(
  cwd: string,
  id: string,
  assignee: string,
  leaseMetadata: Record<string, MetadataValue>,
  actor?: string,
): void {
  recordOp("overwriteAssignee", id);
  const db = openDb(cwd, "overwriteAssignee");
  patchMetadata(db, id, leaseMetadata, actor, "overwriteAssignee", ", assignee = ?", [
    assignee || null,
  ]);
}

/** A comment on an issue (the audit, verdict, and plan trails ride here). */
export interface WorkComment {
  id: string;
  issue_id: string;
  author?: string;
  text: string;
  created_at?: string;
}

function addCommentSync(cwd: string, id: string, text: string, actor?: string): void {
  recordOp("addComment", id);
  const db = openDb(cwd, "addComment");
  requireRow(db, id, "addComment");
  db.prepare("INSERT INTO comments (issue_id, author, text, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    actor ?? null,
    text,
    nowIso(),
  );
}

function listCommentsSync(cwd: string, id: string): WorkComment[] {
  recordOp("listComments", id);
  const db = openDb(cwd, "listComments");
  const rows = db
    .prepare("SELECT id, issue_id, author, text, created_at FROM comments WHERE issue_id = ? ORDER BY id ASC")
    .all(id) as unknown as {
    id: number;
    issue_id: string;
    author: string | null;
    text: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: String(r.id),
    issue_id: r.issue_id,
    ...(r.author ? { author: r.author } : {}),
    text: r.text,
    created_at: r.created_at,
  }));
}

/** Input for {@link createIssue}. */
export interface CreateIssueInput {
  title: string;
  description?: string;
  priority?: number;
  issueType?: string;
  labels?: string[];
  /** Acceptance criteria the judgment gate checks. */
  acceptanceCriteria?: string;
  /** Judgment-gate risk tier, stored as `workgraph_risk_tier` metadata. */
  riskTier?: string;
  /** Execution topology, stored as `workgraph_workflow_class` metadata. */
  workflowClass?: "oneshot" | "reviewed" | "planned";
  /** Extra metadata stamped at creation (lifecycle keys above win). */
  metadata?: Record<string, MetadataValue>;
  /**
   * Create the issue already approved: stamps `workgraph_lifecycle_version: 1`
   * and `workgraph_phase: "ready"` at creation (one write — no draft window).
   * Unapproved issues carry no lifecycle metadata and stay legacy/draft until
   * `workgraph_approve`.
   */
  approved?: boolean;
  /** Issue ids this one depends on (is blocked by). */
  dependsOn?: string[];
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomSuffix(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  return out;
}

function prefixOf(db: DatabaseSync): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'prefix'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? "wg";
}

function createIssueSync(cwd: string, input: CreateIssueInput, actor?: string): WorkIssue {
  recordOp("createIssue");
  const db = openDb(cwd, "createIssue");
  const metadata: Record<string, MetadataValue> = { ...(input.metadata ?? {}) };
  if (input.riskTier) metadata[WORKGRAPH_RISK_TIER_KEY] = input.riskTier;
  if (input.workflowClass) {
    // Approved issues bypass workgraph_approve, so apply the same safety
    // promotion here: only explicitly low-risk work may skip judgment.
    const workflowClass =
      input.approved && input.workflowClass === "oneshot" && input.riskTier !== "low"
        ? "reviewed"
        : input.workflowClass;
    metadata[WORKGRAPH_WORKFLOW_CLASS_KEY] = workflowClass;
  }
  if (input.approved) {
    metadata[WORKGRAPH_LIFECYCLE_VERSION_KEY] = 1;
    metadata[WORKGRAPH_PHASE_KEY] = "ready";
  }
  return transact(db, () => {
    for (const dep of input.dependsOn ?? []) requireRow(db, dep, "createIssue");
    const prefix = prefixOf(db);
    const now = nowIso();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO issues
         (id, title, description, status, priority, issue_type, acceptance_criteria, labels,
          metadata, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let id = "";
    for (let attempt = 0; attempt < 16; attempt++) {
      id = `${prefix}-${randomSuffix(attempt < 8 ? 3 : 4)}`;
      const result = insert.run(
        id,
        input.title,
        input.description ?? null,
        input.priority ?? 2,
        input.issueType ?? "task",
        input.acceptanceCriteria ?? null,
        JSON.stringify(input.labels ?? []),
        JSON.stringify(metadata),
        now,
        actor ?? null,
        now,
        actor ?? null,
      );
      if (result.changes === 1) break;
      id = "";
    }
    if (!id) throw new StoreError("could not allocate a unique issue id", "createIssue");
    const dep = db.prepare(
      "INSERT OR IGNORE INTO dependencies (issue_id, depends_on, dependency_type, created_at) VALUES (?, ?, 'blocks', ?)",
    );
    for (const target of input.dependsOn ?? []) dep.run(id, target, now);
    return rowToIssue(db, requireRow(db, id, "createIssue"));
  });
}

function addDependencySync(cwd: string, id: string, dependsOnId: string, actor?: string): void {
  recordOp("addDependency", id);
  const db = openDb(cwd, "addDependency");
  if (id === dependsOnId) throw new StoreError(`${id} cannot depend on itself`, "addDependency");
  transact(db, () => {
    requireRow(db, id, "addDependency");
    requireRow(db, dependsOnId, "addDependency");
    db.prepare(
      "INSERT OR IGNORE INTO dependencies (issue_id, depends_on, dependency_type, created_at) VALUES (?, ?, 'blocks', ?)",
    ).run(id, dependsOnId, nowIso());
    db.prepare("UPDATE issues SET updated_at = ?, updated_by = ? WHERE id = ?").run(
      nowIso(),
      actor ?? null,
      id,
    );
  });
}

export interface ListIssuesOptions {
  /** Filter by status (any status when omitted). */
  status?: string;
  /** Maximum rows (0 or omitted = unlimited). */
  limit?: number;
}

function listIssuesSync(cwd: string, opts: ListIssuesOptions = {}): WorkIssue[] {
  recordOp("listIssues");
  const db = openDb(cwd, "listIssues");
  const where = opts.status !== undefined ? "WHERE status = ?" : "";
  const values: SQLInputValue[] = opts.status !== undefined ? [opts.status] : [];
  values.push(opts.limit && opts.limit > 0 ? opts.limit : -1);
  const rows = db
    .prepare(`SELECT * FROM issues ${where} ORDER BY rowid ASC LIMIT ?`)
    .all(...values) as unknown as IssueRow[];
  return rows.map((r) => rowToIssue(db, r));
}

/** Synchronous surface for synchronous callers (fixtures, hooks, tooling). */
export const sync: {
  ready: typeof readySync;
  claim: typeof claimSync;
  claimNext: typeof claimNextSync;
  show: typeof showSync;
  close: typeof closeSync;
  release: typeof releaseSync;
  update: typeof updateSync;
  setMetadata: typeof setMetadataSync;
  unsetMetadata: typeof unsetMetadataSync;
  listInProgressUpdatedBefore: typeof listInProgressUpdatedBeforeSync;
  overwriteAssigneeForReclaim: typeof overwriteAssigneeForReclaimSync;
  addComment: typeof addCommentSync;
  listComments: typeof listCommentsSync;
  createIssue: typeof createIssueSync;
  addDependency: typeof addDependencySync;
  listIssues: typeof listIssuesSync;
  initWorkspace: typeof initWorkspaceSync;
  getSetting: (cwd: string, key: string) => string | undefined;
  setSetting: (cwd: string, key: string, value: string | null) => void;
} = {
  ready: readySync,
  claim: claimSync,
  claimNext: claimNextSync,
  show: showSync,
  close: closeSync,
  release: releaseSync,
  update: updateSync,
  setMetadata: setMetadataSync,
  unsetMetadata: unsetMetadataSync,
  listInProgressUpdatedBefore: listInProgressUpdatedBeforeSync,
  overwriteAssigneeForReclaim: overwriteAssigneeForReclaimSync,
  addComment: addCommentSync,
  listComments: listCommentsSync,
  createIssue: createIssueSync,
  addDependency: addDependencySync,
  listIssues: listIssuesSync,
  initWorkspace: initWorkspaceSync,
  // Assigned below their definitions (settings live at the end of the file).
  getSetting: undefined as never,
  setSetting: undefined as never,
};

// ---------------------------------------------------------------------------
// Async wrappers — the API the extension is written against.
// ---------------------------------------------------------------------------

/** List claimable issues: open, unassigned, and dependency-unblocked. `limit` 0 = all. */
export async function ready(cwd: string, limit = 10): Promise<WorkIssue[]> {
  return readySync(cwd, limit);
}

/**
 * Atomically claim the first ready issue. Returns the claimed issue, or
 * null when nothing is ready.
 */
export async function claimNext(cwd: string, actor: string): Promise<WorkIssue | null> {
  return claimNextSync(cwd, actor);
}

/**
 * Atomically claim a specific issue (idempotent if already claimed by this
 * actor). A conflicting claim throws `already claimed by <holder>`.
 */
export async function claim(cwd: string, id: string, actor: string): Promise<void> {
  claimSync(cwd, id, actor);
}

/** Fetch one issue; throws when it does not exist. */
export async function show(cwd: string, id: string): Promise<WorkIssue> {
  return showSync(cwd, id);
}

/** Close an issue, optionally with a reason. Idempotent. */
export async function close(cwd: string, id: string, reason?: string, actor?: string): Promise<void> {
  closeSync(cwd, id, reason, actor);
}

/**
 * Voluntary release: clear the assignee, reopen, and unset the lease-holder
 * and lease-expiry metadata. `lease_epoch` is deliberately RETAINED — the
 * fencing token is monotonic per issue and must never reset. Callers who
 * hold a lease must verify their epoch first (lease.ts's `releaseLease`
 * gate); audit records are the caller's job.
 */
export async function release(cwd: string, id: string, actor?: string): Promise<void> {
  releaseSync(cwd, id, actor);
}

export async function update(cwd: string, id: string, fields: UpdateFields, actor?: string): Promise<void> {
  updateSync(cwd, id, fields, actor);
}

/**
 * Merge metadata keys into an issue. Keys not named are untouched; same-key
 * races resolve last-writer-wins. Every write bumps `updated_at`.
 */
export async function setMetadata(
  cwd: string,
  id: string,
  kv: Record<string, MetadataValue>,
  actor?: string,
): Promise<void> {
  setMetadataSync(cwd, id, kv, actor);
}

/** Remove metadata keys from an issue. */
export async function unsetMetadata(cwd: string, id: string, keys: string[], actor?: string): Promise<void> {
  unsetMetadataSync(cwd, id, keys, actor);
}

/**
 * List in_progress issues whose `updated_at` predates `cutoff` (any
 * `Date.parse`-able timestamp) — the store-side half of expiry detection.
 * Unbounded by design: a capped sweep would silently miss expired leases.
 */
export async function listInProgressUpdatedBefore(cwd: string, cutoff: string): Promise<WorkIssue[]> {
  return listInProgressUpdatedBeforeSync(cwd, cutoff);
}

/**
 * DANGER — the one unguarded assignee write in this module. Overwriting the
 * assignee can steal a live claim; the ONLY caller allowed is
 * `src/sweep.ts`'s fenced `reclaim()`. The epoch-bumping lease metadata
 * rides the SAME statement as the assignee overwrite, so there is no window
 * where the assignee moved but the fencing epoch did not.
 */
export async function overwriteAssigneeForReclaim(
  cwd: string,
  id: string,
  assignee: string,
  leaseMetadata: Record<string, MetadataValue>,
  actor?: string,
): Promise<void> {
  overwriteAssigneeForReclaimSync(cwd, id, assignee, leaseMetadata, actor);
}

/** Append a comment — the audit passthrough. */
export async function addComment(cwd: string, id: string, text: string, actor?: string): Promise<void> {
  addCommentSync(cwd, id, text, actor);
}

/** Read all comments on an issue, oldest first (`[]` when there are none). */
export async function listComments(cwd: string, id: string): Promise<WorkComment[]> {
  return listCommentsSync(cwd, id);
}

/** Create a new issue and return it. */
export async function createIssue(cwd: string, input: CreateIssueInput, actor?: string): Promise<WorkIssue> {
  return createIssueSync(cwd, input, actor);
}

/** Wire `id` to depend on (be blocked by) `dependsOnId`. Idempotent. */
export async function addDependency(cwd: string, id: string, dependsOnId: string, actor?: string): Promise<void> {
  addDependencySync(cwd, id, dependsOnId, actor);
}

/** List issues, oldest first, optionally filtered by status. */
export async function listIssues(cwd: string, opts: ListIssuesOptions = {}): Promise<WorkIssue[]> {
  return listIssuesSync(cwd, opts);
}

// ---------------------------------------------------------------------------
// Workspace settings: small per-repository values (the `meta` table) that
// tools set and session_start reads back — "remember this choice here".
// ---------------------------------------------------------------------------

function getSettingSync(cwd: string, key: string): string | undefined {
  const db = openDb(cwd, "getSetting");
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`setting:${key}`) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setSettingSync(cwd: string, key: string, value: string | null): void {
  const db = openDb(cwd, "setSetting");
  if (value === null) {
    db.prepare("DELETE FROM meta WHERE key = ?").run(`setting:${key}`);
    return;
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(`setting:${key}`, value);
}

/** Read one workspace setting (undefined when unset or no workspace). */
export async function getSetting(cwd: string, key: string): Promise<string | undefined> {
  return getSettingSync(cwd, key);
}

/** Write (or with null, clear) one workspace setting. */
export async function setSetting(cwd: string, key: string, value: string | null): Promise<void> {
  setSettingSync(cwd, key, value);
}

sync.getSetting = getSettingSync;
sync.setSetting = setSettingSync;
