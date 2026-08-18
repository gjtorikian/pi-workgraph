/**
 * The single bd module. Every bd invocation in this extension flows through
 * `execBd`, which serializes calls on one promise-chain queue — bd embeds
 * Dolt, which panics on concurrent in-process DB access.
 *
 * The exec wrapper bakes in the two prior-art regressions:
 *  - `timeout` is MILLISECONDS (pi feeds it straight to setTimeout); and
 *  - a signal-killed process resolves `code: 0, killed: true`, so `killed`
 *    MUST be checked before `code` or a timeout reads as success.
 *
 * The exported function signatures are the future adapter seam — there is
 * deliberately no interface layer. Note that no general-purpose assignee
 * writer is exported: claims go through bd's atomic `--claim`
 * (`claim`/`claimNext`) and voluntary release through `release`, so no
 * ordinary code path can steal a claim by writing `--assignee` directly.
 * The single, loudly-documented exception is `overwriteAssigneeForReclaim`,
 * which exists only for `src/sweep.ts`'s epoch-fenced takeover of expired
 * leases.
 */
import { spawnSync } from "node:child_process";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { BeadsIssue } from "./types.ts";
import {
  LEASE_EXPIRES_AT_KEY,
  LEASE_HOLDER_KEY,
  WORKGRAPH_LIFECYCLE_VERSION_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_RISK_TIER_KEY,
  WORKGRAPH_WORKFLOW_CLASS_KEY,
} from "./types.ts";

/** Signature of `pi.exec`, injected via {@link bindExec}. */
export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/** Error thrown for any failed bd invocation. */
export class BdError extends Error {
  /** The argv (without the binary) of the failed invocation. */
  readonly args: readonly string[];

  constructor(message: string, args: readonly string[]) {
    super(message);
    this.name = "BdError";
    this.args = args;
  }
}

export interface ExecBdOptions {
  /** Working directory for the bd invocation — always passed, never inherited. */
  cwd: string;
  /** Timeout in MILLISECONDS (default 15 000). */
  timeoutMs?: number;
  /** Actor recorded in bd's audit trail; passed as `--actor` argv. */
  actor?: string;
}

export interface ExecLogEntry {
  args: readonly string[];
  timestamp: number;
}

let execFn: ExecFn | undefined;
let queue: Promise<unknown> = Promise.resolve();
const execLog: ExecLogEntry[] = [];

/** Bind the executor (normally `pi.exec`). Tests bind a recording mock. */
export function bindExec(fn: ExecFn): void {
  execFn = fn;
}

/**
 * In-memory log of every bd invocation, in actual (serialized) execution
 * order. Phase 3's dispatch tests assert claims went through `ready --claim`
 * on exactly this log.
 */
export function getExecLog(): readonly ExecLogEntry[] {
  return execLog;
}

/** Test-only: clear the exec log. */
export function resetExecLog(): void {
  execLog.length = 0;
}

/**
 * Run bd with `args`, serialized behind every earlier bd call. Resolves with
 * stdout; throws {@link BdError} on timeout/kill or non-zero exit.
 */
export function execBd(args: string[], opts: ExecBdOptions): Promise<string> {
  const run = async (): Promise<string> => {
    if (!execFn) {
      throw new BdError("bd executor not bound — call bindExec() first", args);
    }
    const fullArgs = opts.actor ? [...args, "--actor", opts.actor] : args;
    execLog.push({ args: fullArgs, timestamp: Date.now() });
    const result = await execFn("bd", fullArgs, {
      timeout: opts.timeoutMs ?? 15_000, // MILLISECONDS — pi passes this to setTimeout
      cwd: opts.cwd, // always pass; pi falls back to load-time cwd otherwise
    });
    // killed !== failure code: pi resolves killed processes with code 0.
    if (result.killed) {
      throw new BdError(`bd ${args[0]} timed out`, args);
    }
    if (result.code !== 0) {
      throw new BdError(
        result.stderr.trim() || `bd ${args[0]} exited ${result.code}`,
        args,
      );
    }
    return result.stdout;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {}); // failures don't wedge the queue
  return p;
}

// ---------------------------------------------------------------------------
// bd availability / workspace probes
// ---------------------------------------------------------------------------

let bdProbe: boolean | undefined;

/**
 * Whether the bd binary is on PATH. Probed via spawnSync (the only reliable
 * bd-missing detection — pi's exec resolves spawn failures as `code: 1` with
 * empty stderr, indistinguishable from a bd usage error). Cached; pass
 * `force` to re-probe (e.g. at session_start).
 */
export function bdBinaryAvailable(force = false): boolean {
  if (bdProbe === undefined || force) {
    const result = spawnSync("bd", ["--version"], { stdio: "ignore" });
    bdProbe = !result.error;
  }
  return bdProbe;
}

const verifiedWorkspaces = new Set<string>();

/**
 * Throw unless `cwd` is inside an initialized beads workspace. Distinguishes
 * bd-missing (spawnSync probe) from uninitialized (`bd where` exits 1) —
 * relying on `bd where`'s exit code only, never on stderr content.
 * Successes are cached per cwd; failures are not (the dir may get
 * `bd init`-ed later).
 */
export async function ensureWorkspace(cwd: string): Promise<void> {
  if (!bdBinaryAvailable()) {
    throw new Error(
      "bd CLI not found — install beads (https://github.com/steveyegge/beads) to use workgraph tools",
    );
  }
  if (verifiedWorkspaces.has(cwd)) return;
  try {
    await execBd(["where"], { cwd });
  } catch {
    throw new Error(
      `No beads workspace found in ${cwd} — run \`bd init\` first`,
    );
  }
  verifiedWorkspaces.add(cwd);
}

/** Test-only: forget probe results and verified workspaces. */
export function resetProbesForTest(): void {
  bdProbe = undefined;
  verifiedWorkspaces.clear();
}

// ---------------------------------------------------------------------------
// JSON parsing — bd's --json shapes differ per subcommand:
//   list/ready/show emit ARRAYS; create emits a single object.
// ---------------------------------------------------------------------------

function parseJsonArray<T>(out: string, context: string): T[] {
  try {
    const parsed: unknown = JSON.parse(out);
    if (!Array.isArray(parsed)) throw new Error("expected JSON array");
    return parsed as T[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BdError(`Failed to parse bd output (${context}): ${msg}`, []);
  }
}

function parseJsonObject<T>(out: string, context: string): T {
  try {
    const parsed: unknown = JSON.parse(out);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("expected JSON object");
    }
    return parsed as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BdError(`Failed to parse bd output (${context}): ${msg}`, []);
  }
}

// ---------------------------------------------------------------------------
// Typed wrappers
// ---------------------------------------------------------------------------

/**
 * List claimable issues: dependency-unblocked AND unassigned. `-u` matters —
 * bare `bd ready` also lists assigned-but-open issues that `--claim` refuses.
 */
export async function ready(cwd: string, limit = 10): Promise<BeadsIssue[]> {
  const out = await execBd(["ready", "-u", "--json", "-n", String(limit)], {
    cwd,
  });
  return parseJsonArray<BeadsIssue>(out, "ready");
}

/**
 * Atomically claim the first ready issue (bd's race-safe `ready --claim`;
 * verified exactly-one-winner under 8/10-way races). Returns the claimed
 * issue, or null when nothing is ready (bd exits 0 with `[]`).
 */
export async function claimNext(
  cwd: string,
  actor: string,
): Promise<BeadsIssue | null> {
  const out = await execBd(["ready", "--claim", "--json"], { cwd, actor });
  const issues = parseJsonArray<BeadsIssue>(out, "ready --claim");
  return issues[0] ?? null;
}

/**
 * Atomically claim a specific issue (idempotent if already claimed by this
 * actor). A conflicting claim exits 1; the bd stderr ("already claimed by
 * ...") surfaces verbatim in the thrown BdError.
 */
export async function claim(
  cwd: string,
  id: string,
  actor: string,
): Promise<void> {
  await execBd(["update", id, "--claim"], { cwd, actor });
}

/**
 * Fetch one issue. `bd show --json` returns an ARRAY; take `[0]` and throw
 * when empty.
 */
export async function show(cwd: string, id: string): Promise<BeadsIssue> {
  const out = await execBd(["show", id, "--json"], { cwd });
  const issues = parseJsonArray<BeadsIssue>(out, `show ${id}`);
  const issue = issues[0];
  if (!issue) throw new BdError(`Issue not found: ${id}`, ["show", id]);
  return issue;
}

/** Close an issue, optionally with a reason. */
export async function close(
  cwd: string,
  id: string,
  reason?: string,
  actor?: string,
): Promise<void> {
  const args = ["close", id];
  if (reason) args.push("--reason", reason);
  await execBd(args, { cwd, actor });
}

/**
 * Voluntary release: clear the assignee, reopen, and unset the lease-holder
 * and lease-expiry metadata. `lease_epoch` is deliberately RETAINED — the
 * fencing token is monotonic per issue and must never reset, so the next
 * acquisition continues the sequence instead of restarting at 1. Callers who
 * hold a lease must verify their epoch first (lease.ts's `releaseLease` gate);
 * audit records are the caller's job (bd.ts stays below the audit layer).
 */
export async function release(
  cwd: string,
  id: string,
  actor?: string,
): Promise<void> {
  await execBd(
    [
      "update",
      id,
      "--assignee",
      "",
      "--status",
      "open",
      "--unset-metadata",
      LEASE_HOLDER_KEY,
      "--unset-metadata",
      LEASE_EXPIRES_AT_KEY,
    ],
    { cwd, actor },
  );
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
  /** Acceptance criteria (bd's native `--acceptance` field, bd >= 1.1.2). */
  acceptance?: string;
}

export async function update(
  cwd: string,
  id: string,
  fields: UpdateFields,
  actor?: string,
): Promise<void> {
  const args = ["update", id];
  if (fields.title !== undefined) args.push("--title", fields.title);
  if (fields.description !== undefined) args.push("-d", fields.description);
  if (fields.status !== undefined) args.push("--status", fields.status);
  if (fields.priority !== undefined) args.push("-p", String(fields.priority));
  if (fields.notes !== undefined) args.push("--notes", fields.notes);
  if (fields.acceptance !== undefined) args.push("--acceptance", fields.acceptance);
  if (args.length === 2) return; // nothing to update
  await execBd(args, { cwd, actor });
}

/**
 * Set metadata keys on an issue (`--set-metadata k=v`, repeatable).
 *
 * Merge semantics (verified against bd 1.1.2): `--set-metadata` merges
 * PER-KEY server-side — keys not named here are untouched, and same-key
 * races resolve last-writer-wins. Numeric-looking values are stored as JSON
 * numbers (`lease_epoch=4` reads back as `4`, not `"4"`); readers should
 * still normalize via `Number(...)` rather than trust the inference. Every
 * write — including a byte-identical rewrite — bumps `updated_at` at second
 * precision, which is what makes the heartbeat double as the staleness
 * signal for the expiry sweep.
 */
export async function setMetadata(
  cwd: string,
  id: string,
  kv: Record<string, string>,
  actor?: string,
): Promise<void> {
  const entries = Object.entries(kv);
  if (entries.length === 0) return;
  const args = ["update", id];
  for (const [key, value] of entries) {
    args.push("--set-metadata", `${key}=${value}`);
  }
  await execBd(args, { cwd, actor });
}

/**
 * List in_progress issues whose `updated_at` predates `cutoff` (RFC3339 or
 * YYYY-MM-DD) — the server-side half of expiry detection. `-n 0` is
 * REQUIRED: bd's default limit is 50, and a capped sweep silently misses
 * expired leases past the first page.
 */
export async function listInProgressUpdatedBefore(
  cwd: string,
  cutoff: string,
): Promise<BeadsIssue[]> {
  const out = await execBd(
    [
      "list",
      "--status",
      "in_progress",
      "--updated-before",
      cutoff,
      "--json",
      "-n",
      "0",
    ],
    { cwd },
  );
  return parseJsonArray<BeadsIssue>(out, "list --updated-before");
}

/**
 * DANGER — the one unguarded assignee write in this module. bd has no CAS,
 * so overwriting `--assignee` can steal a live claim; the ONLY caller
 * allowed is `src/sweep.ts`'s fenced `reclaim()`. The epoch-bumping lease
 * metadata rides the SAME `bd update` as the assignee overwrite, so there is
 * no window where the assignee moved but the fencing epoch did not — any
 * stale holder verifying mid-reclaim already sees the new epoch and aborts.
 * Everything else must claim via `claim`/`claimNext` and release via
 * `release` — do not add callers.
 */
export async function overwriteAssigneeForReclaim(
  cwd: string,
  id: string,
  assignee: string,
  leaseMetadata: Record<string, string>,
  actor?: string,
): Promise<void> {
  const args = ["update", id, "--assignee", assignee];
  for (const [key, value] of Object.entries(leaseMetadata)) {
    args.push("--set-metadata", `${key}=${value}`);
  }
  await execBd(args, { cwd, actor });
}

/** A comment as returned by `bd comments <id> --json`. */
export interface BeadsComment {
  id: string;
  issue_id: string;
  author?: string;
  text: string;
  created_at?: string;
}

/**
 * Append a comment (`bd comment <id> <text>`) — the audit passthrough.
 * bd 1.1.2 has no `bd audit` subcommand, and `--claim`/`--set-metadata`
 * write zero interactions.jsonl entries, so lease events ride comments:
 * they round-trip cleanly through `bd comments <id> --json` (verified).
 */
export async function addComment(
  cwd: string,
  id: string,
  text: string,
  actor?: string,
): Promise<void> {
  await execBd(["comment", id, text], { cwd, actor });
}

/** Read all comments on an issue (`[]` when there are none). */
export async function listComments(
  cwd: string,
  id: string,
): Promise<BeadsComment[]> {
  const out = await execBd(["comments", id, "--json"], { cwd });
  return parseJsonArray<BeadsComment>(out, `comments ${id}`);
}

/** Input for {@link createChild}. */
export interface CreateChildInput {
  title: string;
  description?: string;
  priority?: number;
  issueType?: string;
  /** Acceptance criteria, written via bd's native `--acceptance` field. */
  acceptanceCriteria?: string;
  /** Judgment-gate risk tier, stored as `workgraph_risk_tier` metadata. */
  riskTier?: string;
  /** Execution topology, stored as `workgraph_workflow_class` metadata. */
  workflowClass?: "oneshot" | "reviewed" | "planned";
  /**
   * Create the issue already approved: stamps `workgraph_lifecycle_version: 1`
   * and `workgraph_phase: "ready"` at creation (one write — no draft window).
   * Unapproved issues carry no lifecycle metadata and stay legacy/draft until
   * `workgraph_approve`.
   */
  approved?: boolean;
}

/**
 * Create a new issue and return it (`bd create --json` emits a single
 * object, unlike the array-shaped read commands). Lifecycle metadata
 * (risk tier / approval) rides the same `bd create` via `--metadata`, so an
 * approved child is never observable in a half-stamped state.
 */
export async function createChild(
  cwd: string,
  input: CreateChildInput,
  actor?: string,
): Promise<BeadsIssue> {
  const args = [
    "create",
    input.title,
    "--json",
    "-t",
    input.issueType ?? "task",
    "-p",
    String(input.priority ?? 2),
  ];
  if (input.description) args.push("-d", input.description);
  if (input.acceptanceCriteria) args.push("--acceptance", input.acceptanceCriteria);
  const metadata: Record<string, unknown> = {};
  if (input.riskTier) metadata[WORKGRAPH_RISK_TIER_KEY] = input.riskTier;
  if (input.workflowClass) {
    // Approved children bypass workgraph_approve, so apply the same safety
    // promotion here: only explicitly low-risk work may skip judgment.
    const workflowClass =
      input.approved &&
      input.workflowClass === "oneshot" &&
      input.riskTier !== "low"
        ? "reviewed"
        : input.workflowClass;
    metadata[WORKGRAPH_WORKFLOW_CLASS_KEY] = workflowClass;
  }
  if (input.approved) {
    metadata[WORKGRAPH_LIFECYCLE_VERSION_KEY] = 1;
    metadata[WORKGRAPH_PHASE_KEY] = "ready";
  }
  if (Object.keys(metadata).length > 0) {
    args.push("--metadata", JSON.stringify(metadata));
  }
  const out = await execBd(args, { cwd, actor });
  return parseJsonObject<BeadsIssue>(out, "create");
}

/** Wire `id` to depend on (be blocked by) `dependsOnId`. */
export async function addDependency(
  cwd: string,
  id: string,
  dependsOnId: string,
  actor?: string,
): Promise<void> {
  await execBd(["dep", "add", id, "--depends-on", dependsOnId], { cwd, actor });
}
