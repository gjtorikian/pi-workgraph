/**
 * Plan critiques: validation, size caps, comment persistence, and the
 * plan-bound read-back.
 *
 * This module is `src/plan.ts` for the plan_critic role, and deliberately
 * mirrors it decision-for-decision, with two differences called out below.
 *
 * TRANSPORT: protocol-v1 schemas are non-strict, so a critic completion
 * carries its critique as an extra `critique` field on `run:completed` — no
 * protocol change. An invalid critique causes zero state change: the plan
 * parks for human review without one.
 *
 * PERSISTENCE follows the audit-trail pattern: one machine-readable comment
 * per critique under a stable prefix, written fire-and-forget, read back via
 * `listComments`. Metadata is NOT an event store — only the compact summary
 * lands in `workgraph_plan_critique`.
 *
 * BINDING (difference one): a critique belongs to exactly one plan. Its
 * comment records the `executionId` of the planner completion that produced
 * that plan, and {@link latestPlanCritique} returns a critique only when it
 * names the LATEST recorded plan and was written after it. A newest-comment
 * read would print the first plan's gaps under the second plan's steps after
 * a reject and re-plan whose critique never arrived.
 *
 * ZERO GAPS IS VALID (difference two): `parsePlan` rejects a plan with no
 * steps, but a critic that finds nothing an implementer would have to guess
 * at reports an empty list, and that is the "build-ready" result.
 *
 * SIZE CAPS: gaps are capped and notes truncated with the plan module's
 * marker before serialization, so a critic returning forty long gaps can
 * never produce an unwritable comment or an unreadable display.
 *
 * WHAT A CRITIQUE IS NOT: it is advice for the human reviewing the plan,
 * never authority. The core does not act on a gap, and no gap is ever handed
 * to an implementer — `renderPlanForReview` in `src/plan.ts` is the only
 * renderer that prints them, and it is human-only.
 */
import { Value } from "typebox/value";
import { MAX_STEP_CHARS, MAX_SUMMARY_CHARS, PLAN_PREFIX, TRUNCATION_MARKER } from "./plan.ts";
import { addComment, listComments } from "./store.ts";
import type { PlanCritiqueT, PlanGapT } from "./types.ts";
import { PlanCritique } from "./types.ts";

/** Prefix on every critique comment; tests and humans grep for it. */
export const PLAN_CRITIQUE_PREFIX = "workgraph-plan-critique";

/** Cap on gaps persisted per critique (the rest fold into a count). */
export const MAX_GAPS = 5;

/** Cap on a single gap note before truncation. */
export const MAX_GAP_CHARS = 300;

/** Thrown when a reported critique payload fails schema validation. */
export class PlanCritiqueError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Invalid plan critique payload: ${detail}`);
    this.name = "PlanCritiqueError";
    this.detail = detail;
  }
}

/**
 * Validate a reported critique payload. Returns the typed critique or throws
 * {@link PlanCritiqueError}; a missing payload (`undefined`) is invalid — the
 * coordinator never infers a critique from silence. An empty `gaps` list is
 * VALID (see the module header). One bad gap invalidates the whole critique:
 * there is no partial salvage.
 */
export function parsePlanCritique(raw: unknown): PlanCritiqueT {
  if (Value.Check(PlanCritique, raw)) return raw;
  const detail = [...Value.Errors(PlanCritique, raw)]
    .slice(0, 3)
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
  throw new PlanCritiqueError(detail || "schema mismatch");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + TRUNCATION_MARKER;
}

function capGap(gap: PlanGapT): PlanGapT {
  return {
    ...(gap.step !== undefined ? { step: gap.step } : {}),
    note: truncate(gap.note, MAX_GAP_CHARS),
  };
}

/**
 * Cap gaps for persistence: the first {@link MAX_GAPS}, each note truncated
 * to {@link MAX_GAP_CHARS}. ORDER IS MEANING, as it is for plan steps — a
 * critic reports the most important gap first, so this never sorts.
 */
export function cappedGaps(gaps: readonly PlanGapT[]): PlanGapT[] {
  return gaps.slice(0, MAX_GAPS).map(capGap);
}

/**
 * The compact summary written to `workgraph_plan_critique` metadata: the
 * count of gaps that will be SHOWN (so eight reported gaps summarize as
 * "5 gaps"), plus a note when the critic ran on the planner's own model.
 * Readers match these strings by prefix; treat the format as an interface.
 */
export function critiqueSummary(critique: PlanCritiqueT, opts: { sameModel?: boolean } = {}): string {
  const count = Math.min(critique.gaps.length, MAX_GAPS);
  const gaps = `${count} gap${count === 1 ? "" : "s"}`;
  return opts.sameModel ? `${gaps}, same model as planner` : gaps;
}

/**
 * The `workgraph_plan_critique` value for a critique that could not be
 * obtained: `unavailable: <reason>`, capped like the plan summary.
 */
export function unavailableSummary(reason: string): string {
  return truncate(`unavailable: ${reason}`, MAX_SUMMARY_CHARS);
}

/** What a critique comment records beside the critique itself. */
export interface PlanCritiqueDetails {
  /** executionId of the planner completion that produced the plan being critiqued. */
  planExecutionId: string;
  workflowRunId: string;
  executionId: string;
  executorId: string;
  provenance?: unknown;
}

/**
 * Persist one critique as a machine-readable comment:
 * `workgraph-plan-critique critique {json}` — gaps capped/truncated, the
 * binding and run context (`details`) folded in. Resolves (never rejects)
 * even when the write fails, mirroring `recordPlan`: a broken comment
 * surface must not cost the plan its trip to human review.
 */
export async function recordPlanCritique(
  cwd: string,
  issueId: string,
  critique: PlanCritiqueT,
  details: PlanCritiqueDetails,
  actor?: string,
): Promise<void> {
  try {
    const gaps = cappedGaps(critique.gaps);
    const folded = critique.gaps.length - gaps.length;
    const payload = {
      ...details,
      summary: critiqueSummary(critique),
      gaps,
      ...(folded > 0 ? { foldedGaps: folded } : {}),
      ...(critique.summary !== undefined ? { description: truncate(critique.summary, MAX_STEP_CHARS) } : {}),
    };
    const text = `${PLAN_CRITIQUE_PREFIX} critique ${JSON.stringify(payload)}`;
    await addComment(cwd, issueId, text, actor);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Loud, but non-blocking — the plan parks without the trail.
    console.error(`[pi-workgraph] PLAN CRITIQUE WRITE FAILED (${issueId}): ${msg}`);
  }
}

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * The critique written against the LATEST recorded plan, rebuilt from the
 * comment trail, or undefined. The binding rule, walking from the end:
 *
 *   1. the newest `workgraph-plan plan ` comment names the plan in force,
 *      through the planner completion's `executionId`;
 *   2. the newest `workgraph-plan-critique critique ` comment that sits
 *      AFTER it and carries that id as `planExecutionId` is its critique.
 *
 * Both checks are needed: position alone would accept a critique of an
 * earlier plan that landed late, and the id alone would accept one recorded
 * before a re-plan that reused an id. A plan comment with no `executionId`
 * (an older record) cannot be bound to, and an unparseable comment on either
 * side reads as no critique.
 */
export async function latestPlanCritique(cwd: string, issueId: string): Promise<PlanCritiqueT | undefined> {
  const comments = await listComments(cwd, issueId);
  const planMarker = `${PLAN_PREFIX} plan `;
  const critiqueMarker = `${PLAN_CRITIQUE_PREFIX} critique `;

  let planIndex = comments.length - 1;
  while (planIndex >= 0 && !comments[planIndex]!.text.startsWith(planMarker)) planIndex--;
  if (planIndex < 0) return undefined;
  const planExecutionId = parseObject(comments[planIndex]!.text.slice(planMarker.length))?.executionId;
  if (typeof planExecutionId !== "string" || planExecutionId === "") return undefined;

  for (let i = comments.length - 1; i > planIndex; i--) {
    const text = comments[i]!.text;
    if (!text.startsWith(critiqueMarker)) continue;
    const payload = parseObject(text.slice(critiqueMarker.length));
    if (payload === undefined) return undefined;
    if (payload.planExecutionId !== planExecutionId) continue;
    const critique = {
      gaps: payload.gaps,
      ...(typeof payload.description === "string" ? { summary: payload.description } : {}),
    };
    return Value.Check(PlanCritique, critique) ? critique : undefined;
  }
  return undefined;
}
