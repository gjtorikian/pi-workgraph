import {
  WORKGRAPH_DECISION_ANSWER_KEY,
  WORKGRAPH_DECISION_QUESTION_KEY,
} from "./types.ts";

/** Notification from an explicit human halt, after the UI persisted a new
 * fencing epoch. Synchronous listeners append workflow ids they own before
 * the control bridge sends cancellation and waits for acknowledgements. */
export const ISSUE_HALT_EVENT = "workgraph:ui:issue-halted";
export interface IssueHaltNotice {
  issueId: string;
  leaseEpoch: number;
  workflowRunIds: string[];
}
export function issueHaltNotice(value: unknown): IssueHaltNotice | null {
  if (!value || typeof value !== "object") return null;
  const v = value as IssueHaltNotice;
  return typeof v.issueId === "string" &&
    v.issueId.length > 0 &&
    Number.isSafeInteger(v.leaseEpoch) &&
    v.leaseEpoch > 0 &&
    Array.isArray(v.workflowRunIds) &&
    v.workflowRunIds.every((id) => typeof id === "string")
    ? v
    : null;
}

/** The answered question from an earlier run of this issue, for every
 * later run's request (`decision`); empty until a human answers. */
export function decisionAnswer(
  metadata: Record<string, unknown> | undefined,
): { decision?: { question: string; answer: string } } {
  const answer = metadata?.[WORKGRAPH_DECISION_ANSWER_KEY];
  const question = metadata?.[WORKGRAPH_DECISION_QUESTION_KEY];
  return typeof answer === "string" && answer.trim() !== ""
    ? { decision: { question: typeof question === "string" ? question : "", answer } }
    : {};
}

/** Prompt lines for a request's `decision`, so no role asks the question again. */
export function renderDecision(decision: { question: string; answer: string }): string[] {
  return [
    "An earlier run of this issue stopped to ask a human. Follow the answer; do not ask again:",
    `Question: ${decision.question}`,
    `Answer: ${decision.answer}`,
  ];
}

/** A new lease/run still owns cancellation and fencing; only the retained
 * checkout is shared with the previous attempt. */
export function sourceWorkspace(
  metadata: Record<string, unknown> | undefined,
): { sourceWorkflowRunId?: string } {
  const value = metadata?.workgraph_workspace_run_id;
  return typeof value === "string" && value
    ? { sourceWorkflowRunId: value }
    : {};
}
