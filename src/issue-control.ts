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
