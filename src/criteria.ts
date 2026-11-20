/**
 * Numbered acceptance criteria, and what a verdict's answers to them add up
 * to. Pure functions: no store, no git, no config.
 *
 * NUMBERING. Acceptance criteria are one stored string (decision log: no
 * structured criteria table). {@link parseCriteria} splits it into one
 * criterion per non-blank line and numbers them `C1`, `C2`, ... in order.
 * Ids are positional, so they are stable only because the source is the
 * string frozen on the run's bar at claim (`src/check.ts`): the same string
 * gives the same ids on the request, in the reviewer's answers and after a
 * restart. Text with no newline is one criterion, which keeps every
 * single-line criteria string valid.
 *
 * EVALUATION. A reviewer answers each criterion as `met`, `unmet` or
 * `unanswered` ({@link CriterionAnswerT}); {@link evaluateCriteria} decides
 * what the answers are worth, and it never rounds up:
 *
 *   no criteria                        → `not-applicable`
 *   any criterion `unmet`              → `violation`
 *   else any criterion not `met` with
 *   non-empty evidence                 → `unknown`
 *   every criterion `met` with evidence → `pass`
 *
 * A criterion with no answer is unanswered, `met` with empty evidence is
 * unanswered, and when one id is answered twice the worst answer wins. An
 * answer for an id that does not exist is ignored. Evidence is checked for
 * being there, not for being true: that is the reviewer's claim, recorded
 * on the verdict where a human can read it.
 */
import type { GateResult } from "./proof.ts";
import type { CriterionAnswerT, FindingT, VerdictT } from "./types.ts";

/** One numbered acceptance criterion. `id` is `C1`, `C2`, ... */
export interface Criterion {
  id: string;
  text: string;
}

/** Cap on numbered criteria; lines past it fold into the last item. */
export const MAX_CRITERIA = 30;

/** What joins the lines folded into the last criterion. */
const FOLD_SEPARATOR = "; ";

/**
 * One list marker at the start of a line: a bullet (`-`, `*`, `+`), a number
 * (`1.`, `1)`) or a checkbox (`[ ]`, `[x]`, `[X]`). It must be followed by
 * whitespace or end the line, so `-1 is returned`, `1.5 s timeout` and
 * `*args are forwarded` keep their first characters.
 */
const LIST_MARKER = /^(?:[-*+]|\d+[.)]|\[[ xX]\])(?:\s+|$)/;

/** A line with its leading list markers removed (`- [ ] text` has two). */
function stripMarkers(line: string): string {
  let text = line.trim();
  for (;;) {
    const stripped = text.replace(LIST_MARKER, "");
    if (stripped === text) return text;
    text = stripped;
  }
}

/**
 * Split a criteria string into numbered criteria: one per line, markers
 * stripped, blank lines dropped (a line that is only a marker is blank).
 * `undefined`, `""` and whitespace give `[]`. More than
 * {@link MAX_CRITERIA} lines: the rest is folded into the last item.
 */
export function parseCriteria(text: string | undefined): Criterion[] {
  if (text === undefined) return [];
  let items = text
    .split("\n")
    .map((line) => stripMarkers(line.replace(/\r/g, "")))
    .filter((line) => line !== "");
  if (items.length > MAX_CRITERIA) {
    items = [
      ...items.slice(0, MAX_CRITERIA - 1),
      items.slice(MAX_CRITERIA - 1).join(FOLD_SEPARATOR),
    ];
  }
  return items.map((item, index) => ({ id: `C${index + 1}`, text: item }));
}

/** What a verdict's criterion answers add up to. */
export interface CriteriaEvaluation {
  /** pass | violation | unknown | not-applicable */
  result: GateResult;
  /** Answered `met` with non-empty evidence. */
  met: Criterion[];
  /** Answered `unmet` (by any answer for the id). */
  unmet: Criterion[];
  /** Missing, `unanswered`, or `met` with no evidence. */
  unanswered: Criterion[];
}

type AnswerStatus = "met" | "unmet" | "unanswered";

function sameId(answer: CriterionAnswerT, criterion: Criterion): boolean {
  return answer.id.trim().toUpperCase() === criterion.id;
}

function hasEvidence(answer: CriterionAnswerT): boolean {
  return answer.evidence !== undefined && answer.evidence.trim() !== "";
}

/** The standing of one criterion across every answer given for its id. */
function statusOf(
  criterion: Criterion,
  answers: readonly CriterionAnswerT[],
): AnswerStatus {
  const mine = answers.filter((answer) => sameId(answer, criterion));
  if (mine.some((answer) => answer.status === "unmet")) return "unmet";
  if (mine.length === 0) return "unanswered";
  return mine.every((answer) => answer.status === "met" && hasEvidence(answer))
    ? "met"
    : "unanswered";
}

/** Evaluate a verdict's answers against the numbered criteria. */
export function evaluateCriteria(
  criteria: readonly Criterion[],
  verdict: VerdictT,
): CriteriaEvaluation {
  const met: Criterion[] = [];
  const unmet: Criterion[] = [];
  const unanswered: Criterion[] = [];
  const answers = verdict.criteria ?? [];
  for (const criterion of criteria) {
    const status = statusOf(criterion, answers);
    if (status === "met") met.push(criterion);
    else if (status === "unmet") unmet.push(criterion);
    else unanswered.push(criterion);
  }
  const result: GateResult =
    criteria.length === 0
      ? "not-applicable"
      : unmet.length > 0
        ? "violation"
        : unanswered.length > 0
          ? "unknown"
          : "pass";
  return { result, met, unmet, unanswered };
}

/**
 * The blocking findings an evaluation's `unmet` criteria stand for: one per
 * criterion, `criterion` its text and `note` what the reviewer said is
 * missing. Written by the core from the reviewer's answer, so `author` is
 * `reviewer`. They need no citation: what is wrong is an absence.
 */
export function unmetFindings(
  evaluation: CriteriaEvaluation,
  verdict: VerdictT,
): FindingT[] {
  const answers = verdict.criteria ?? [];
  return evaluation.unmet.map((criterion) => {
    const missing = answers.find(
      (answer) =>
        sameId(answer, criterion) &&
        answer.status === "unmet" &&
        hasEvidence(answer),
    )?.evidence;
    return {
      criterion: criterion.text,
      severity: "blocking",
      ...(missing !== undefined ? { note: missing.trim() } : {}),
      author: "reviewer",
    };
  });
}

/** The ids of a list of criteria, as an escalation or a prompt names them. */
export function criteriaIds(criteria: readonly Criterion[]): string {
  return criteria.map((criterion) => criterion.id).join(", ");
}
