/**
 * Per-turn context injection: `before_agent_start` appends a fenced
 * `<workgraph>` section to the system prompt every turn — current claim,
 * lease countdown, ready count, and the collision-free claiming rules.
 *
 * Per-turn append is the compaction-survival workhorse: even when a summary
 * drops graph state, the next turn re-adds it fresh. APPEND, never replace —
 * a returned `systemPrompt` replaces the prompt for the turn and multiple
 * extensions chain, so the handler always returns
 * `event.systemPrompt + section`.
 *
 * Graph state is TTL-cached (10 s) per cwd so back-to-back turns cost one bd
 * probe, not one per turn. Held-lease state is NOT cached — the registry is
 * in-memory and free, so the current-claim line is always live.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bdBinaryAvailable, ensureWorkspace, ready, show } from "./bd.ts";
import { heldLeases, type HeldLease } from "./lease.ts";
import {
  attemptOf,
  lastVerdictOf,
  phaseOf,
  workflowRunIdOf,
} from "./lifecycle.ts";
import { formatCountdown } from "./status.ts";
import type { BeadsIssue } from "./types.ts";

/** Cache TTL: bounds both bd churn and staleness (stale-list conflicts
 *  resolve as clean claim failures, so 10 s is acceptable). */
export const CONTEXT_CACHE_TTL_MS = 10_000;

/** Top-N ready issues rendered; the rest fold into the count (prompt-bloat
 *  cap — the section stays ~30 lines no matter the pool size). */
export const READY_RENDER_LIMIT = 5;

/** The bd-derived half of the injected section (cacheable). */
export interface GraphState {
  /** False when bd is missing OR the dir has no .beads/ — inject nothing. */
  initialized: boolean;
  /** Total claimable issues (dependency-unblocked, unassigned). */
  readyCount: number;
  /** Top {@link READY_RENDER_LIMIT} ready issues. */
  readyTop: BeadsIssue[];
  /** Clock reading when this state was probed. */
  fetchedAt: number;
}

export interface ContextInjectionOptions {
  /** Cache TTL override (tests). */
  ttlMs?: number;
  /** Clock injection (tests). */
  now?: () => number;
}

/** Lifecycle view of one HELD issue, rendered under its claim line. */
export interface HeldIssueView {
  phase?: string;
  attempt?: number;
  workflowRunId?: string;
  /** First ~120 chars of the acceptance criteria. */
  acceptance?: string;
  lastVerdict?: string;
}

const cache = new Map<string, GraphState>();
const heldViewCache = new Map<string, { view: HeldIssueView; fetchedAt: number }>();

/** Test-only: drop all cached graph state. */
export function resetContextCacheForTest(): void {
  cache.clear();
  heldViewCache.clear();
}

async function probeGraphState(cwd: string, nowMs: number): Promise<GraphState> {
  const empty: GraphState = {
    initialized: false,
    readyCount: 0,
    readyTop: [],
    fetchedAt: nowMs,
  };
  // Distinguish bd-missing (cached spawnSync probe, no subprocess) from
  // uninitialized (`ensureWorkspace` throws on `bd where` exit 1); both mean
  // "inject nothing" — no regex heuristics in v0.
  if (!bdBinaryAvailable()) return empty;
  try {
    await ensureWorkspace(cwd);
  } catch {
    return empty;
  }
  try {
    // `-n 0` is unlimited (verified against bd 1.1.2): full count in one
    // call, render capped at READY_RENDER_LIMIT.
    const pool = await ready(cwd, 0);
    return {
      initialized: true,
      readyCount: pool.length,
      readyTop: pool.slice(0, READY_RENDER_LIMIT),
      fetchedAt: nowMs,
    };
  } catch {
    // bd broke mid-session: inject nothing this turn; the cached failure
    // bounds re-probing to once per TTL.
    return empty;
  }
}

function truncateLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * TTL-cached lifecycle view for one HELD issue (phase, run, attempt,
 * acceptance summary, last verdict). Held-lease EXISTENCE stays live (the
 * in-memory registry is free), but rendering these fields costs a `bd show`
 * per issue — cached on the same TTL as the graph state so back-to-back
 * turns stay at one probe. Failures resolve to an empty view (cached too).
 */
async function cachedHeldIssueView(
  cwd: string,
  issueId: string,
  nowMs: number,
  ttl: number,
): Promise<HeldIssueView> {
  const key = `${cwd}\u0000${issueId}`;
  const hit = heldViewCache.get(key);
  if (hit && nowMs - hit.fetchedAt < ttl) return hit.view;
  let view: HeldIssueView = {};
  try {
    const issue = await show(cwd, issueId);
    view = {
      phase: phaseOf(issue),
      attempt: attemptOf(issue),
      workflowRunId: workflowRunIdOf(issue),
      ...(issue.acceptance_criteria
        ? { acceptance: truncateLine(issue.acceptance_criteria) }
        : {}),
      lastVerdict: lastVerdictOf(issue),
    };
  } catch {
    // bd broke or the issue vanished: render the bare claim line this turn.
  }
  heldViewCache.set(key, { view, fetchedAt: nowMs });
  return view;
}

/**
 * The TTL-cached graph state for `cwd`. Failures are cached too — a broken
 * bd must not add a fresh probe on every turn.
 */
export async function cachedGraphState(
  cwd: string,
  opts: ContextInjectionOptions = {},
): Promise<GraphState> {
  const nowFn = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? CONTEXT_CACHE_TTL_MS;
  const nowMs = nowFn();
  const hit = cache.get(cwd);
  if (hit && nowMs - hit.fetchedAt < ttl) return hit;
  const state = await probeGraphState(cwd, nowMs);
  cache.set(cwd, state);
  return state;
}

function renderIssueLine(issue: BeadsIssue): string {
  return `- ${issue.id} [P${issue.priority}] ${issue.title}`;
}

/**
 * Render the fenced `<workgraph>` section (leading newlines included so it
 * appends cleanly). Fenced in `<workgraph>` tags for testability.
 */
export function renderWorkgraphSection(
  state: GraphState,
  held: HeldLease[],
  nowMs: number,
  heldViews?: Map<string, HeldIssueView>,
): string {
  const lines: string[] = ["", "", "<workgraph>", "Work graph (beads) status:"];

  if (held.length === 0) {
    lines.push("Current claim: none.");
  } else {
    for (const lease of held) {
      const remaining = Date.parse(lease.expiresAt) - nowMs;
      const view = heldViews?.get(lease.issueId);
      const phaseNote = view?.phase ? `phase ${view.phase}, ` : "";
      lines.push(
        `Current claim: ${lease.issueId} (${phaseNote}lease epoch ${lease.epoch}, expires in ${formatCountdown(remaining)}).`,
      );
      if (view?.workflowRunId || view?.attempt !== undefined) {
        const runBits = [
          ...(view.workflowRunId ? [`run ${view.workflowRunId}`] : []),
          ...(view.attempt !== undefined ? [`attempt ${view.attempt}`] : []),
        ];
        lines.push(`  ${runBits.join(", ")}.`);
      }
      if (view?.acceptance) lines.push(`  Acceptance: ${view.acceptance}`);
      if (view?.lastVerdict) lines.push(`  Last verdict: ${view.lastVerdict}`);
    }
  }

  if (state.readyCount === 0) {
    lines.push("Ready issues: none claimable right now.");
  } else {
    lines.push(`Ready issues (${state.readyCount} claimable):`);
    for (const issue of state.readyTop) {
      lines.push(renderIssueLine(issue));
    }
    const more = state.readyCount - state.readyTop.length;
    if (more > 0) lines.push(`- ...and ${more} more (workgraph_ready lists them).`);
  }

  lines.push(
    "Claiming rules:",
    "1. Ready work is dispatched by the workgraph coordinator to a registered executor — do not claim from the ready pool yourself. To deliberately pick up one specific issue, use workgraph_claim (atomic, race-safe); never claim with `bd update` or by editing assignees from bash.",
    "2. Never write an assignee field from bash — claims and releases go through the workgraph tools so leases stay consistent.",
    "3. Completion is REPORTED to the coordinator, which records the result and runs the judgment gate (review, revision, verification) — implementers never close their own work. workgraph_close succeeds only for issues whose lifecycle phase is accepted (past judgment); an explicit human override uses workgraph_override with a reason. Hand back a claim you will not finish with workgraph_release; never leave one dangling.",
    "</workgraph>",
  );
  return lines.join("\n");
}

/**
 * Register the `before_agent_start` injector. Returns nothing when the
 * workspace is uninitialized (no `.beads/`) or bd is unavailable.
 */
export function registerContextInjection(
  pi: ExtensionAPI,
  opts: ContextInjectionOptions = {},
): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const state = await cachedGraphState(ctx.cwd, opts);
    if (!state.initialized) return;
    const nowFn = opts.now ?? Date.now;
    const nowMs = nowFn();
    const ttl = opts.ttlMs ?? CONTEXT_CACHE_TTL_MS;
    const held = heldLeases(ctx.cwd);
    const heldViews = new Map<string, HeldIssueView>();
    for (const lease of held) {
      heldViews.set(
        lease.issueId,
        await cachedHeldIssueView(ctx.cwd, lease.issueId, nowMs, ttl),
      );
    }
    return {
      systemPrompt:
        event.systemPrompt +
        renderWorkgraphSection(state, held, nowMs, heldViews),
    };
  });
}
