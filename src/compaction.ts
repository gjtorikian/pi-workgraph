/**
 * Compaction takeover (Full tier): `session_before_compact` → Pi's exported
 * `compact()` with custom instructions that preserve the task narrative a
 * default summary can drop — the in-flight issue id + title, what's been
 * tried, and the acceptance criteria. Pre-existing user instructions
 * (`event.customInstructions`) are always preserved, never replaced.
 *
 * `SessionBeforeCompactResult` has NO instructions field (verified against
 * 0.83 types) — returning a full `compaction: CompactionResult` from our own
 * `compact()` call is the only way to shape an in-flight compaction.
 *
 * Errors NEVER block compaction: any failure — no in-flight issue, no model,
 * unresolvable credentials (`auth.ok === false`), or a thrown `compact()` —
 * returns `undefined` so the default compaction proceeds.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { heldLeases } from "./lease.ts";

/** The in-flight work the summary must retain. */
export interface CurrentWork {
  issueId: string;
  title?: string;
  /** The supervising workflow run (phase 4: recovery correlates by it). */
  workflowRunId?: string;
  /** The run's coordination phase (requested/accepted/judging/...). */
  phase?: string;
  /** The current implementation/revision attempt. */
  attempt?: number;
  /** Evidence refs from the latest fenced completion. */
  evidence?: string[];
}

export interface CompactionTakeoverOptions {
  /**
   * The summarizer — injected for tests (the live `compact()` call is a
   * Phase 4 manual smoke item); defaults to Pi's exported `compact()`.
   */
  compactFn?: typeof compact;
  /**
   * Where to read the in-flight issue. index.ts wires the dispatch
   * controller (which knows the title); the default falls back to the
   * held-lease registry (id only).
   */
  getCurrent?: (cwd: string) => CurrentWork | null;
}

/**
 * Assemble the takeover instructions: user instructions first (preserved
 * verbatim), then the task-narrative requirements. Exported for tests.
 */
export function buildCompactionInstructions(
  userInstructions: string | undefined,
  current: CurrentWork,
): string {
  const parts: string[] = [];
  const user = userInstructions?.trim();
  if (user) parts.push(user);
  const issueLabel = current.title
    ? `${current.issueId} ("${current.title}")`
    : current.issueId;
  parts.push(
    "This session is an agent worker driving a beads work-graph issue. The summary MUST retain:",
    `- The in-flight issue: ${issueLabel} — keep its id and title verbatim.`,
  );
  // Run references (phase 4): the workflow-run id and phase are what
  // restart reconciliation and fencing correlate by — a summary that drops
  // them strands the model without its coordination context.
  if (current.workflowRunId) {
    const attempt =
      current.attempt !== undefined ? `, attempt ${current.attempt}` : "";
    parts.push(
      `- The workflow run: ${current.workflowRunId} (phase ${current.phase ?? "unknown"}${attempt}) — keep the run id and phase verbatim.`,
    );
  }
  if (current.evidence && current.evidence.length > 0) {
    parts.push(
      `- Evidence recorded for this run: ${current.evidence.join("; ")}`,
    );
  }
  parts.push(
    "- What has been tried so far on this issue: approaches, failures, and partial progress.",
    "- The acceptance criteria / definition of done for this issue.",
  );
  return parts.join("\n");
}

/** Register the `session_before_compact` takeover. */
export function registerCompactionTakeover(
  pi: ExtensionAPI,
  opts: CompactionTakeoverOptions = {},
): void {
  const compactFn = opts.compactFn ?? compact;
  const getCurrent =
    opts.getCurrent ??
    ((cwd: string): CurrentWork | null => {
      const lease = heldLeases(cwd)[0];
      return lease ? { issueId: lease.issueId } : null;
    });

  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const current = getCurrent(ctx.cwd);
      if (!current) return undefined; // nothing in flight — default compaction
      const model = ctx.model; // use as-is, mid-switch included; never hardcode
      if (!model) return undefined;
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return undefined;
      const instructions = buildCompactionInstructions(
        event.customInstructions,
        current,
      );
      const result = await compactFn(
        event.preparation,
        model,
        auth.apiKey,
        auth.headers,
        instructions,
        event.signal,
        ctx.thinkingLevel,
        undefined,
        auth.env,
      );
      return { compaction: result };
    } catch {
      return undefined; // never block compaction
    }
  });
}
