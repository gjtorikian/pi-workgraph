/**
 * Structured plans: validation, comment persistence, and the prompt-ready
 * rendering handed to the implementer.
 *
 * This module is `src/verdict.ts` for the planner tier, and deliberately
 * mirrors it decision-for-decision:
 *
 * TRANSPORT: protocol-v1 schemas are non-strict, so a planner completion
 * carries its plan as an extra `plan` field on `run:completed` — no protocol
 * change on the RETURN path. (The outbound path does add one optional
 * `plan` string to `run:request`, which an older adapter simply ignores.)
 * An invalid plan causes zero state change: the coordinator discards the
 * attempt and audits it, exactly as it does for an invalid verdict.
 *
 * PERSISTENCE follows the audit-trail pattern: one machine-readable comment
 * per plan under a stable prefix, written fire-and-forget, read back via
 * `listComments`. Metadata is NOT an event store — only the compact summary
 * lands in `workgraph_plan_summary`, riding the same `setMetadata` call as
 * the phase transition.
 *
 * SIZE CAPS: steps are capped and strings truncated with a marker before
 * serialization, so a planner returning a huge plan can never produce an
 * unwritable comment — and `renderPlan` caps again independently, because
 * what goes into a prompt is bounded by context, not by comment size.
 *
 * WHAT A PLAN IS NOT: it is evidence, never authority. The core does not
 * interpret steps, does not enforce `targets`, and does not let a planner's
 * `acceptanceCriteria` overwrite the approved criteria on the issue — a
 * planner that could rewrite its own bar would defeat the judgment gate.
 */
import { Value } from "typebox/value";
import { addComment } from "./bd.ts";
import type { PlanStepT, PlanT } from "./types.ts";
import { Plan } from "./types.ts";

/** Prefix on every plan comment; tests and humans grep for it. */
export const PLAN_PREFIX = "workgraph-plan";

/** Cap on steps persisted per plan (the rest fold into a count). */
export const MAX_STEPS = 50;

/** Cap on a single description/rationale/risk string before truncation. */
export const MAX_STEP_CHARS = 400;

/** Cap on `targets` entries kept per step. */
export const MAX_TARGETS = 20;

/** Marker appended to truncated strings. */
export const TRUNCATION_MARKER = "…[truncated]";

/** Cap on the compact `workgraph_plan_summary` metadata value. */
export const MAX_SUMMARY_CHARS = 160;

/** Cap on the rendered plan text handed to an executor. */
export const MAX_RENDER_CHARS = 8000;

/** Thrown when a reported plan payload fails schema validation. */
export class PlanError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Invalid plan payload: ${detail}`);
    this.name = "PlanError";
    this.detail = detail;
  }
}

/**
 * Validate a reported plan payload. Returns the typed plan or throws
 * {@link PlanError}; a missing payload (`undefined`) is invalid — the
 * coordinator never infers a plan from silence, the same way the judgment
 * gate never infers a verdict from it.
 *
 * A plan with zero steps is REJECTED: an executor that answers the planner
 * role owes a plan, and an empty one is indistinguishable from a planner
 * that did nothing — which would otherwise hand the implementer an empty
 * prompt section and look like a successful tier.
 */
export function parsePlan(raw: unknown): PlanT {
  if (Value.Check(Plan, raw)) {
    if (raw.steps.length === 0) {
      throw new PlanError("plan carries no steps");
    }
    return raw;
  }
  const detail = [...Value.Errors(Plan, raw)]
    .slice(0, 3)
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
  throw new PlanError(detail || "schema mismatch");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + TRUNCATION_MARKER;
}

function capStep(step: PlanStepT): PlanStepT {
  return {
    description: truncate(step.description, MAX_STEP_CHARS),
    ...(step.targets !== undefined
      ? {
          targets: step.targets
            .slice(0, MAX_TARGETS)
            .map((t) => truncate(t, MAX_STEP_CHARS)),
        }
      : {}),
    ...(step.rationale !== undefined
      ? { rationale: truncate(step.rationale, MAX_STEP_CHARS) }
      : {}),
  };
}

/**
 * Cap a plan for persistence. Unlike `canonicalFindings`, step ORDER IS
 * MEANING here — a plan is a sequence, so this never sorts. That asymmetry
 * with the verdict path is deliberate: findings are a set (and are sorted so
 * two verdicts fingerprint identically regardless of arrival order), steps
 * are a list.
 */
export function cappedSteps(steps: readonly PlanStepT[]): PlanStepT[] {
  return steps.map(capStep);
}

/**
 * The compact summary written to `workgraph_plan_summary` metadata: step
 * count plus the first step's description, capped.
 */
export function planSummary(plan: PlanT): string {
  const head = plan.summary ?? plan.steps[0]?.description;
  const parts = [`${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}`];
  if (head) parts.push(head);
  return truncate(parts.join(": "), MAX_SUMMARY_CHARS);
}

/**
 * Render a plan as the prompt-ready text attached to downstream
 * `run:request`s. Numbered so the implementer can report progress against
 * step numbers, and hard-capped at {@link MAX_RENDER_CHARS} — a plan that
 * would blow an executor's context is truncated with a marker rather than
 * silently dropped, because a partial plan is still worth more to the
 * implementer than none.
 *
 * Risks are rendered LAST and labelled advisory: they are the planner's open
 * questions, not instructions, and an implementer that treats them as work
 * items would expand scope past what was approved.
 */
export function renderPlan(plan: PlanT): string {
  const lines: string[] = [];
  if (plan.summary) lines.push(plan.summary, "");
  if (plan.acceptanceCriteria) {
    lines.push(
      "Acceptance criteria (as refined by the planner; the approved criteria on the issue remain authoritative):",
      plan.acceptanceCriteria,
      "",
    );
  }
  lines.push("Steps:");
  const steps = cappedSteps(plan.steps).slice(0, MAX_STEPS);
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.description}`);
    if (step.targets && step.targets.length > 0) {
      lines.push(`   targets: ${step.targets.join(", ")}`);
    }
    if (step.rationale) lines.push(`   why: ${step.rationale}`);
  });
  const folded = plan.steps.length - steps.length;
  if (folded > 0) lines.push(`… and ${folded} further step(s), folded.`);
  if (plan.risks && plan.risks.length > 0) {
    lines.push("", "Open questions from the planner (advisory — not work items):");
    for (const risk of plan.risks.slice(0, MAX_STEPS)) {
      lines.push(`- ${truncate(risk, MAX_STEP_CHARS)}`);
    }
  }
  return truncate(lines.join("\n"), MAX_RENDER_CHARS);
}

/**
 * Persist one plan as a machine-readable comment:
 * `workgraph-plan plan {json}` — steps capped/truncated, extra context
 * (`details`: workflowRunId, executionId, planner provenance, attempt)
 * folded in. Resolves (never rejects) even when the write fails, mirroring
 * `recordVerdict` and `recordLeaseEvent`: a broken comment surface must not
 * take the lifecycle down.
 */
export async function recordPlan(
  cwd: string,
  issueId: string,
  plan: PlanT,
  details: Record<string, unknown>,
  actor?: string,
): Promise<void> {
  const capped = cappedSteps(plan.steps);
  const folded = capped.length - MAX_STEPS;
  const payload = {
    ...details,
    summary: planSummary(plan),
    steps: capped.slice(0, MAX_STEPS),
    ...(folded > 0 ? { foldedSteps: folded } : {}),
    ...(plan.acceptanceCriteria !== undefined
      ? { acceptanceCriteria: truncate(plan.acceptanceCriteria, MAX_STEP_CHARS) }
      : {}),
    ...(plan.risks !== undefined
      ? {
          risks: plan.risks
            .slice(0, MAX_STEPS)
            .map((r) => truncate(r, MAX_STEP_CHARS)),
        }
      : {}),
  };
  const text = `${PLAN_PREFIX} plan ${JSON.stringify(payload)}`;
  try {
    await addComment(cwd, issueId, text, actor);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Loud, but non-blocking — the lifecycle proceeds without the trail.
    console.error(`[pi-workgraph] PLAN WRITE FAILED (${issueId}): ${msg}`);
  }
}
