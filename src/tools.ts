/**
 * The workgraph tools. Thin handlers over the src/store.ts wrappers:
 * errors are THROWN (never returned as content), output is truncated with
 * pi's truncateTail, and every tool declares `executionMode: "sequential"`
 * so lease reads and writes never interleave within one session.
 *
 * Phase 3 re-cuts the surface (plan §8): `workgraph_approve` moves
 * draft/legacy work into the approved ready pool with acceptance criteria,
 * workflow class, and risk tier; `workgraph_close` permits only `accepted`
 * work (reviewed/planned work closes through judgment; one-shot work through
 * the coordinator's verification tail — executors never self-close);
 * `workgraph_override` is the ONE unguarded mutation left — an explicit
 * human close/release that bypasses phase and fencing guards and is always
 * audited with the actor and a REQUIRED reason.
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { recordLeaseEvent } from "./audit.ts";
import {
  addDependency,
  close,
  createIssue,
  ensureWorkspace,
  initWorkspace,
  ready,
  release,
  setMetadata,
  show,
  unsetMetadata,
  update,
} from "./store.ts";
import { approvalRefusal, authoredCheck, resolveCheck } from "./check.ts";
import {
  resolveConfig,
  resolveConfigWithoutPolicy,
  type WorkgraphConfig,
} from "./config.ts";
import {
  defaultLeaseActor,
  identitySnapshot,
  noteSessionId,
  setWorkerIdOverride,
  workerId,
} from "./identity.ts";
import {
  acquireLease,
  FencingError,
  getHeldLease,
  heldLeases,
  leaseEpochOf,
  leaseExpiresAtOf,
  leaseHolderOf,
  releaseLease,
  renewLease,
  untrackLease,
} from "./lease.ts";
import { GUARD_ALLOW_ANSWER } from "./guards.ts";
import {
  attemptOf,
  checkOf,
  checkWaiverOf,
  decisionGatesOf,
  guardAllowedByOf,
  guardAllowedOf,
  guardRoundsOf,
  isLifecycleV1,
  lastVerdictOf,
  outcomeDeadlineOf,
  outcomeExecutionIdOf,
  outcomeOf,
  outcomeStatusOf,
  phaseOf,
  planApprovedOf,
  reapprove,
  riskTierOf,
  transition,
  workflowClassOf,
  workflowRunIdOf,
} from "./lifecycle.ts";
import { latestPlanCritique } from "./critique.ts";
import {
  compactOutcome,
  DEFAULT_SCORECARD_WINDOW_DAYS,
  gradableClose,
  latestOutcome,
  OVERRIDE_CLOSE_PREFIX,
  recordOutcome,
  renderScorecard,
  scorecard,
  scorecardRows,
  type OutcomeT,
} from "./outcome.ts";
import { latestPlan, renderPlanForReview } from "./plan.ts";
import {
  DEFAULT_RISK_TIER,
  GATES,
  GUARD_GATES,
  resolvePolicy,
  type GateName,
} from "./policy.ts";
import {
  latestGateRecords,
  listGateRecords,
  summarizeGates,
  type GateRecord,
  type GateSummary,
} from "./proof.ts";
import { resolveConfig as resolveFlags } from "./config.ts";
import { effectiveTiers } from "./settings.ts";
import {
  describeTiers,
  parseTiersValue,
  resolveTiers,
  setResolvedTiers,
  storeTiers,
  type TierConfig,
} from "./tiers.ts";
import type { WorkIssue, WorkflowClassT } from "./types.ts";
import { latestVerdictRecord, reviewContextOf } from "./verdict.ts";
import {
  AnswerDecisionParams,
  ApproveParams,
  ApprovePlanParams,
  ClaimParams,
  CloseParams,
  CreateParams,
  GatesParams,
  HeartbeatParams,
  InitParams,
  OverrideParams,
  ReadyParams,
  RecordOutcomeParams,
  ReleaseParams,
  ScorecardParams,
  SplitParams,
  StatusParams,
  TiersParams,
  DEFAULT_WORKFLOW_CLASS,
  WORKGRAPH_CHECK_KEY,
  WORKGRAPH_CHECK_WAIVER_KEY,
  WORKGRAPH_DECISION_ANSWER_KEY,
  WORKGRAPH_DECISION_GATE_KEY,
  WORKGRAPH_DECISION_QUESTION_KEY,
  WORKGRAPH_EXECUTOR_ID_KEY,
  WORKGRAPH_GUARD_ALLOWED_BY_KEY,
  WORKGRAPH_GUARD_ALLOWED_KEY,
  WORKGRAPH_GUARD_KEYS,
  WORKGRAPH_OUTCOME_KEYS,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_TREE_BINDING_KEYS,
  WORKGRAPH_PLAN_APPROVED_KEY,
  WORKGRAPH_PLAN_CRITIQUE_KEY,
  WORKGRAPH_PLAN_FEEDBACK_KEY,
  WORKGRAPH_PLAN_SUMMARY_KEY,
  WORKGRAPH_RISK_TIER_KEY,
  WORKGRAPH_WORKFLOW_CLASS_KEY,
} from "./types.ts";

/** The outcomes a caller may report (`workgraph_record_outcome`). */
const REPORTABLE_OUTCOMES = ["clean", "needed_fixes", "abandoned"] as const;

const CRITIQUE_UNAVAILABLE_PREFIX = "unavailable:";

/** Whether a `workgraph_plan_critique` value reports gaps a reader can look up. */
function critiqueHasGaps(summary: string): boolean {
  return summary !== "" && !summary.startsWith(CRITIQUE_UNAVAILABLE_PREFIX) && !summary.startsWith("0 gaps");
}

/**
 * The line `workgraph_status` prints between the review header and the plan,
 * from the `workgraph_plan_critique` metadata value (formats owned by
 * `critiqueSummary` / `unavailableSummary` in critique.ts, matched by
 * prefix). Undefined when no critique was attempted for this plan.
 * `detailsReadable` is whether the gaps themselves could be read back; when
 * they could not (the comment write failed), the count is all there is.
 */
function planCritiqueLine(summary: string, detailsReadable: boolean): string | undefined {
  if (summary === "") return undefined;
  if (summary.startsWith(CRITIQUE_UNAVAILABLE_PREFIX)) {
    const reason = summary.slice(CRITIQUE_UNAVAILABLE_PREFIX.length).trim();
    return `Critique unavailable: ${reason.replace(/\.+$/, "")}.`;
  }
  if (summary.startsWith("0 gaps")) return `Critique (advisory): build-ready, ${summary}.`;
  return detailsReadable
    ? `Critique (advisory): ${summary}, marked "?" under the steps they concern.`
    : `Critique (advisory): ${summary}, but its details could not be read.`;
}

/**
 * One line of `workgraph_status`: what a gate last found on the issue. The
 * mode shown is the one the gate ran under, which a later policy change may
 * have moved on from (the `Gates:` line above it shows the current modes).
 */
function gateResultLine(record: GateRecord): string {
  const effect = record.blocked ? ", blocked" : record.wouldBlock ? ", would block" : "";
  const reason = record.reason !== undefined ? `: ${record.reason}` : "";
  return `Gate ${record.gate}: ${record.result}${effect} (${record.mode}, attempt ${record.attempt})${reason}`;
}

/**
 * One line of `workgraph_gates`: the issues a gate blocked and would have
 * blocked, then (only when there are any) the issues a human waived it for,
 * each with its reason, and the issues a diff guard could not decide. A
 * gate with neither keeps the two-column line.
 *
 * `unknown` is listed for the diff guards only. For every other gate an
 * `unknown` blocks, so the first two columns already count it; for a guard
 * it never does, and this is the one place a blind guard shows.
 */
function gateReportLine(gate: GateName, summary: GateSummary): string {
  if (summary.records === 0) return `${gate}: no records`;
  const list = (ids: string[]): string => (ids.length > 0 ? ` (${ids.join(", ")})` : "");
  const unknown =
    summary.unknown.length > 0 && GUARD_GATES.some((guard) => guard === gate)
      ? `, ${summary.unknown.length} unknown${list(summary.unknown)}`
      : "";
  const waived =
    summary.waived.length > 0
      ? `, ${summary.waived.length} not applicable, waived (${summary.waived
          .map((w) => `${w.issueId}: ${w.reason}`)
          .join("; ")})`
      : "";
  return (
    `${gate}: ${summary.blocked.length} blocked${list(summary.blocked)}, ` +
    `${summary.wouldBlock.length} would block${list(summary.wouldBlock)}${waived}${unknown}`
  );
}

/** The metadata a check or a waiver given at creation is stored as. */
function checkMetadata(authored: { check?: string; waiver?: string }): Record<string, string> {
  return {
    ...(authored.check !== undefined ? { [WORKGRAPH_CHECK_KEY]: authored.check } : {}),
    ...(authored.waiver !== undefined ? { [WORKGRAPH_CHECK_WAIVER_KEY]: authored.waiver } : {}),
  };
}

function textResult<TDetails>(
  text: string,
  details: TDetails,
): AgentToolResult<TDetails> {
  const truncated = truncateTail(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return { content: [{ type: "text", text: truncated.content }], details };
}

function renderIssue(issue: WorkIssue): string {
  const assignee = issue.assignee ? ` @${issue.assignee}` : "";
  return `${issue.id} [P${issue.priority}] (${issue.status})${assignee} ${issue.title}`;
}

function renderIssueList(issues: WorkIssue[]): string {
  if (issues.length === 0) return "No ready issues.";
  return issues.map(renderIssue).join("\n");
}

export function registerWorkgraphTools(pi: ExtensionAPI): void {
  /**
   * Per-call prologue: resolve identity config lazily (flags are not
   * readable at load), record the session id for workerId(), and verify the
   * store + workspace before touching the graph.
   */
  async function prepare(ctx: ExtensionContext): Promise<WorkgraphConfig> {
    const config = resolveConfig(pi);
    setWorkerIdOverride(config.workerIdOverride);
    noteSessionId(ctx.sessionManager.getSessionId());
    await ensureWorkspace(ctx.cwd);
    return config;
  }

  /**
   * The same prologue for the tools that protect or end work ALREADY under
   * a lease, let a human take it back, or report on work that is closed:
   * heartbeat, release, override, record_outcome. They read nothing of the
   * policy or the check, so an invalid one must not stop them: a typo would
   * otherwise let a held lease lapse and leave the recovery tools unusable
   * until it was fixed. The coordinator makes the same split (`heldConfig`).
   * The return type leaves `policy` and `check` out, so a tool that starts
   * to read either has to move back to {@link prepare}.
   */
  async function prepareHeld(
    ctx: ExtensionContext,
  ): Promise<Omit<WorkgraphConfig, "policy" | "check">> {
    const config = resolveConfigWithoutPolicy(pi);
    setWorkerIdOverride(config.workerIdOverride);
    noteSessionId(ctx.sessionManager.getSessionId());
    await ensureWorkspace(ctx.cwd);
    return config;
  }

  pi.registerTool({
    name: "workgraph_ready",
    label: "Ready work",
    description:
      "List dispatchable issues in the work graph: approved lifecycle-v1 issues in phase ready (dependency-unblocked, unassigned). " +
      "Pass legacy: true to list legacy issues (no lifecycle version) awaiting workgraph_approve instead.",
    promptSnippet: "List claimable work-graph issues",
    promptGuidelines: [
      "Use workgraph_ready to find work; never read or edit the store from bash.",
    ],
    parameters: ReadyParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepare(ctx);
      const limit = params.limit ?? 10;
      // Fetch unlimited and filter client-side (`-n 0`): lifecycle phase is
      // metadata, which the store's ready query cannot filter on.
      const pool = await ready(ctx.cwd, 0);
      const issues = (
        params.legacy
          ? pool.filter((issue) => !isLifecycleV1(issue))
          : pool.filter(
              (issue) => isLifecycleV1(issue) && phaseOf(issue) === "ready",
            )
      ).slice(0, limit);
      const text = params.legacy
        ? issues.length === 0
          ? "No legacy issues awaiting approval."
          : renderIssueList(issues)
        : issues.length === 0
          ? "No approved issues ready to dispatch. (Drafts and legacy issues need workgraph_approve; list them with legacy: true.)"
          : renderIssueList(issues);
      return textResult(text, { issues });
    },
  });

  pi.registerTool({
    name: "workgraph_claim",
    label: "Claim work",
    description:
      "Atomically claim an issue: pass an id to claim that issue, or omit it to claim the next ready one",
    promptSnippet: "Atomically claim a work-graph issue",
    promptGuidelines: [
      "Use workgraph_claim before starting work on an issue; claiming is atomic and race-safe.",
    ],
    parameters: ClaimParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = await prepare(ctx);
      // Behavior-identical bridge until phase 2: the lease holder is this
      // session's worker id, threaded explicitly (lease ops have no ambient
      // identity).
      const actor = defaultLeaseActor();
      const outcome = await acquireLease(ctx.cwd, {
        issueId: params.id,
        ttlMs: config.leaseTtlMs,
        actor,
      });
      switch (outcome.kind) {
        case "empty":
          return textResult("Nothing ready to claim.", { issue: null });
        case "lost-race":
          // Someone reclaimed between our claim and our lease stamp —
          // extremely narrow, still handled: this issue is not ours.
          throw new Error(
            `Lost the acquisition race for ${outcome.issueId} — another worker ` +
              `reclaimed it before the lease stamp landed; claim different work.`,
          );
        case "acquired":
          return textResult(
            `Claimed as ${actor.holder} (lease epoch ${outcome.lease.epoch}, ` +
              `expires ${outcome.lease.expiresAt}):\n${renderIssue(outcome.issue)}`,
            { issue: outcome.issue, lease: outcome.lease },
          );
      }
    },
  });

  pi.registerTool({
    name: "workgraph_release",
    label: "Release work",
    description:
      "Voluntarily release an issue this session claimed back to the ready pool (clears assignee, reopens). " +
      "Fencing requirement: releases only a lease this session holds, verified against the lease_epoch fencing token. " +
      "A human unsticking someone else's claim uses workgraph_override (action: release) with a reason.",
    promptSnippet: "Release a claimed work-graph issue",
    promptGuidelines: [
      "Use workgraph_release to hand back an issue you will not finish; it only works for issues this session claimed.",
    ],
    parameters: ReleaseParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepareHeld(ctx);
      const lease = getHeldLease(ctx.cwd, params.id);
      if (!lease) {
        // No unfenced fallback: an untracked release used to fall through to
        // a bare assignee-clearing write with no holder or
        // epoch check — exactly how one worker released another's claim.
        throw new Error(
          `Cannot release ${params.id}: this session holds no tracked lease on it, ` +
            `and releasing requires passing the lease fencing check (epoch + holder). ` +
            `If another worker holds it, leave it to them or to the expiry sweep; ` +
            `a human override uses workgraph_override (action: release) with a reason.`,
        );
      }
      // Fenced release: verifies the epoch, unsets holder/expiry metadata,
      // and writes the audit record. Throws FencingError if reclaimed.
      // Released as the actor stored at acquire time — never ambient identity.
      await releaseLease(ctx.cwd, lease, lease.actor);
      return textResult(`Released ${params.id} back to the ready pool.`, {
        id: params.id,
      });
    },
  });

  pi.registerTool({
    name: "workgraph_close",
    label: "Close work",
    description:
      "Close an ACCEPTED issue this session claimed, optionally recording a reason. " +
      "Judgment gate: only issues whose workgraph_phase is accepted (past judgment) may be closed — " +
      "implementation completion is reported to the coordinator and judged, never self-closed. " +
      "Fencing requirement: close is a holder write — it requires a lease this session holds, verified against the lease_epoch fencing token. " +
      "A human closing anything else uses workgraph_override (action: close) with a reason.",
    promptSnippet: "Close an accepted work-graph issue",
    promptGuidelines: [
      "Use workgraph_close with a short reason only when an issue you claimed has passed judgment (phase accepted).",
    ],
    parameters: CloseParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepare(ctx);
      // Close is a holder write: it is gated on the fencing token, so it
      // requires a tracked lease (no unfenced fallback) — a stale holder
      // whose lease was reclaimed must abort, not close the new holder's
      // work, and a session that never claimed must not close at all.
      const lease = getHeldLease(ctx.cwd, params.id);
      if (!lease) {
        throw new Error(
          `Cannot close ${params.id}: this session holds no tracked lease on it, ` +
            `and closing requires passing the lease fencing check (epoch + holder). ` +
            `Claim it first with workgraph_claim; a human override uses ` +
            `workgraph_override (action: close) with a reason.`,
        );
      }
      const cur = await show(ctx.cwd, params.id);
      // The fence first: a stale holder must learn it lost the lease, not
      // that judgment is pending on work that is no longer its own.
      if (
        leaseEpochOf(cur) !== lease.epoch ||
        leaseHolderOf(cur) !== lease.actor.holder
      ) {
        untrackLease(ctx.cwd, params.id);
        throw new FencingError(
          params.id,
          lease.epoch,
          leaseEpochOf(cur),
          leaseHolderOf(cur) ?? cur.assignee ?? "unknown",
        );
      }
      // THE JUDGMENT GATE (a code check, not prompt text): only accepted
      // work closes here. Successful implementation transitions to judging
      // and is closed by the coordinator's policy-approved tail — an
      // implementer close pre-acceptance is rejected even when it holds a
      // perfectly valid lease. Phase-less issues (legacy or self-claimed)
      // have not passed judgment either.
      const phase = phaseOf(cur);
      if (phase !== "accepted") {
        throw new Error(
          `Cannot close ${params.id}: only issues in lifecycle phase "accepted" may be closed ` +
            `(current phase: ${phase ?? "none — not under lifecycle management"}). ` +
            `Completed implementation is judged by the coordinator's judgment gate before closing; ` +
            `a human override uses workgraph_override (action: close) with a reason.`,
        );
      }
      // Close as the actor stored at acquire time — never ambient identity.
      await close(ctx.cwd, params.id, params.reason, lease.actor.bdActor);
      untrackLease(ctx.cwd, params.id);
      const reasonNote = params.reason ? `: ${params.reason}` : "";
      return textResult(`Closed ${params.id}${reasonNote}`, { id: params.id });
    },
  });

  pi.registerTool({
    name: "workgraph_split",
    label: "Split work",
    description:
      "Split an issue into child issues; the parent is blocked until every child closes. " +
      "A child created approved at medium or high risk (the default tier is medium) needs its own check command, a repository default, or a checkWaiver; " +
      "a child does not inherit the parent's.",
    promptSnippet: "Split a work-graph issue into children",
    promptGuidelines: [
      "Use workgraph_split when an issue is too large to claim whole.",
      "Give each approved child the check command the human named; pass checkWaiver only on explicit human instruction, with the human's reason.",
    ],
    parameters: SplitParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = await prepare(ctx);
      const actor = workerId();
      // Fail before creating anything if the parent doesn't exist.
      const parent = await show(ctx.cwd, params.id);

      // Every child is validated before any is created: a refusal on the
      // third child must not leave two behind. An approved child with no
      // tier is medium by policy, so it is held to the medium rule.
      const authored = params.children.map((child) => {
        const given = authoredCheck(child);
        if (child.approved) {
          const refusal = approvalRefusal(child.riskTier, given, config);
          if (refusal !== undefined) {
            throw new Error(`Cannot split ${params.id}: child "${child.title}": ${refusal}`);
          }
        }
        return given;
      });

      // Create children first, deps second; on partial failure report exactly
      // what exists so no orphan is silently left behind.
      const created: WorkIssue[] = [];
      for (const [index, child] of params.children.entries()) {
        try {
          created.push(
            await createIssue(
              ctx.cwd,
              {
                title: child.title,
                description: child.description,
                priority: child.priority ?? parent.priority,
                acceptanceCriteria: child.acceptanceCriteria,
                riskTier: child.riskTier,
                workflowClass: child.workflowClass as
                  | "oneshot"
                  | "reviewed"
                  | "planned"
                  | undefined,
                approved: child.approved,
                metadata: checkMetadata(authored[index]!),
              },
              actor,
            ),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(
            `workgraph_split partial failure: created ${
              created.length
            } of ${params.children.length} children (${created
              .map((c) => c.id)
              .join(", ") || "none"}); creating "${child.title}" failed: ${msg}`,
          );
        }
      }
      const linked: string[] = [];
      for (const child of created) {
        try {
          await addDependency(ctx.cwd, params.id, child.id, actor);
          linked.push(child.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(
            `workgraph_split partial failure: all ${created.length} children created (${created
              .map((c) => c.id)
              .join(", ")}) but only [${linked.join(", ")}] linked to ${
              params.id
            }; linking ${child.id} failed: ${msg}`,
          );
        }
      }
      const lines = created.map(renderIssue).join("\n");
      return textResult(
        `Split ${params.id} into ${created.length} children (parent blocked until they close):\n${lines}`,
        { parentId: params.id, children: created },
      );
    },
  });

  pi.registerTool({
    name: "workgraph_approve",
    label: "Approve work",
    description:
      "Approve a draft or legacy issue for dispatch: records acceptance criteria and the check command, " +
      "stamps lifecycle v1 with a risk tier and workflow class, and transitions the issue to phase ready. " +
      "Also re-approves escalated work (back to ready, reopened). " +
      "The coordinator only dispatches approved ready work, and runs the check itself before any review. " +
      "Medium- and high-risk work is refused without a check (here, already on the issue, or the repository default in Pi settings) " +
      "unless checkWaiver records why no check applies; waived work closes stamped waived.",
    promptSnippet: "Approve a work-graph issue for dispatch",
    promptGuidelines: [
      "Use workgraph_approve to move a draft, legacy, or escalated issue into the dispatchable ready pool, with acceptance criteria the judgment gate will check and the check command the human named.",
      "Pass checkWaiver only on explicit human instruction, with the human's reason; never invent a waiver to get an approval through.",
    ],
    parameters: ApproveParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = await prepare(ctx);
      const actor = defaultLeaseActor();
      const cur = await show(ctx.cwd, params.id);
      const phase = phaseOf(cur);
      if (
        cur.metadata?.workgraph_decision_pending === true ||
        cur.metadata?.workgraph_decision_pending === "true"
      )
        throw new Error(
          "This issue needs a human decision. workgraph_status shows the question; answer it with workgraph_answer_decision, then approve again.",
        );
      if (phase !== undefined && phase !== "draft" && phase !== "escalated") {
        throw new Error(
          `Cannot approve ${params.id}: approval moves draft, legacy, or escalated issues ` +
            `to ready, but its phase is "${phase}". Mid-flight work is recovered with ` +
            `workgraph_override (action: release), which resets it to draft for re-approval.`,
        );
      }
      // Explicit params win; a draft created with a class/tier (workgraph_create)
      // or an escalated issue keeps what it had; else the conservative defaults.
      const riskTier = params.riskTier ?? riskTierOf(cur) ?? DEFAULT_RISK_TIER;
      const requestedWorkflowClass = params.workflowClass ?? workflowClassOf(cur);
      // One-shot intentionally skips independent judgment. A blocking risk
      // tier therefore promotes to reviewed instead of weakening policy.
      const workflowClass =
        requestedWorkflowClass === "oneshot" && riskTier !== "low"
          ? "reviewed"
          : requestedWorkflowClass;
      // The check rule, after the two guards above and before any write. A
      // check or a waiver already on the issue (a draft created with one, a
      // re-approval) satisfies it; a new one replaces the other kind, so an
      // issue never carries both.
      const given = authoredCheck(params);
      const replaces = given.check !== undefined || given.waiver !== undefined;
      const check = given.check ?? (replaces ? undefined : checkOf(cur));
      const waiver = given.waiver ?? (replaces ? undefined : checkWaiverOf(cur));
      const refusal = approvalRefusal(riskTier, { check, waiver }, config);
      if (refusal !== undefined) {
        throw new Error(`Cannot approve ${params.id}: ${refusal}`);
      }
      const approvalFields = {
        [WORKGRAPH_RISK_TIER_KEY]: riskTier,
        [WORKGRAPH_WORKFLOW_CLASS_KEY]: workflowClass,
        // A re-approved planned issue plans afresh; stale approvals never carry.
        [WORKGRAPH_PLAN_APPROVED_KEY]: false,
        // Rides the guarded write: an approval that loses the race leaves
        // the stored check as it was.
        ...(replaces
          ? {
              [WORKGRAPH_CHECK_KEY]: given.check ?? "",
              [WORKGRAPH_CHECK_WAIVER_KEY]: given.waiver ?? "",
            }
          : {}),
      };
      if (phase === "escalated") {
        // The re-approve recovery path (failure-modes table: "escalation is
        // recoverable via re-approve"): escalated → ready under the same CAS
        // discipline, then reopen — escalation parked the issue as `blocked`,
        // and a blocked issue never re-enters the ready pool.
        await reapprove(ctx.cwd, params.id, {
          fields: approvalFields,
          actor: actor.bdActor,
        });
        await update(ctx.cwd, params.id, { status: "open" }, actor.bdActor);
      } else {
        // draft/legacy → ready: initializes workgraph_lifecycle_version,
        // risk tier, and workflow class in one guarded write.
        await transition(ctx.cwd, params.id, phase, "ready", {
          fields: approvalFields,
          actor: actor.bdActor,
        });
      }
      // Acceptance criteria land AFTER the guarded transition: an approval
      // that lost the CAS race throws above without touching the issue —
      // writing criteria first would overwrite them on an issue whose
      // approval failed.
      if (params.acceptanceCriteria !== undefined) {
        await update(
          ctx.cwd,
          params.id,
          { acceptance: params.acceptanceCriteria },
          actor.bdActor,
        );
      }
      await recordLeaseEvent(
        ctx.cwd,
        "approve",
        params.id,
        {
          riskTier,
          workflowClass,
          requestedWorkflowClass,
          acceptanceCriteria: params.acceptanceCriteria ?? null,
          check: check ?? null,
          checkWaiver: waiver ?? null,
          actor: identitySnapshot(actor),
        },
        actor.bdActor,
      );
      return textResult(
        `Approved ${params.id} for dispatch (workflow ${workflowClass}, risk tier ${riskTier}, phase ready).` +
          (workflowClass !== requestedWorkflowClass
            ? ` Requested ${requestedWorkflowClass} was promoted because only low-risk work may skip independent review.`
            : "") +
          (waiver !== undefined ? ` Check waived: ${waiver}` : ""),
        {
          id: params.id,
          riskTier,
          workflowClass,
          requestedWorkflowClass,
          check: check ?? null,
          checkWaiver: waiver ?? null,
        },
      );
    },
  });

  pi.registerTool({
    name: "workgraph_override",
    label: "Override",
    description:
      "EXPLICIT human override: close an issue or release it back to the pool, bypassing the " +
      "lifecycle phase guards and lease fencing. Release also resets any lifecycle phase to " +
      "draft (audited) so the issue is recoverable via workgraph_approve. The only unguarded " +
      "mutation in the tool surface — always audited with the acting identity and the REQUIRED reason.",
    promptSnippet: "Human override: force-close or force-release an issue",
    promptGuidelines: [
      "Use workgraph_override only on explicit human instruction, with the human's reason; normal completion goes through the coordinator's judgment gate.",
    ],
    parameters: OverrideParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepareHeld(ctx);
      const actor = defaultLeaseActor();
      // A release of a lifecycle-v1 issue also resets the phase to draft:
      // without it the phase would stay wherever the run left it (judging,
      // escalated, ...), workgraph_approve would refuse it, and the
      // coordinator would never claim it — stranded outside the tool
      // surface. Read the prior phase first so the reset is audited.
      const priorPhase = phaseOf(await show(ctx.cwd, params.id));
      const resetsPhase =
        params.action === "release" &&
        priorPhase !== undefined &&
        priorPhase !== "draft";
      // Audit FIRST: an override that fails half-way must still be visible.
      await recordLeaseEvent(
        ctx.cwd,
        "override",
        params.id,
        {
          action: params.action,
          reason: params.reason,
          ...(resetsPhase ? { phaseReset: `${priorPhase} -> draft` } : {}),
          actor: identitySnapshot(actor),
        },
        actor.bdActor,
      );
      if (params.action === "close") {
        await close(
          ctx.cwd,
          params.id,
          `${OVERRIDE_CLOSE_PREFIX}${params.reason}`,
          actor.bdActor,
        );
        untrackLease(ctx.cwd, params.id);
        return textResult(
          `Override-closed ${params.id} (reason: ${params.reason}) — audited as ${actor.bdActor}.`,
          { id: params.id, action: params.action },
        );
      }
      // Release: the deliberate unfenced path — clears the assignee and the
      // lease holder/expiry metadata regardless of who holds it.
      await release(ctx.cwd, params.id, actor.bdActor);
      // A released issue starts over: its next run must not inherit the
      // previous one's workspace, base or result tree. This is the one
      // place those keys are cleared — a re-claim, a promotion and a
      // re-approval all keep the base on purpose (`src/snapshot.ts`). The
      // diff-guard keys go with them: a spent revision round and a human's
      // allowance both belong to the work that was just given up. So do the
      // outcome keys: an outcome grades one close, and the next close of
      // this issue starts with none (and with no stale deadline to sweep).
      await unsetMetadata(
        ctx.cwd,
        params.id,
        [
          ...WORKGRAPH_TREE_BINDING_KEYS,
          ...WORKGRAPH_GUARD_KEYS,
          ...WORKGRAPH_OUTCOME_KEYS,
        ],
        actor.bdActor,
      );
      if (resetsPhase) {
        await setMetadata(
          ctx.cwd,
          params.id,
          { [WORKGRAPH_PHASE_KEY]: "draft" },
          actor.bdActor,
        );
      }
      untrackLease(ctx.cwd, params.id);
      return textResult(
        `Override-released ${params.id} back to the pool (reason: ${params.reason})` +
          (resetsPhase
            ? ` — phase reset ${priorPhase} → draft (re-approve with workgraph_approve)`
            : "") +
          ` — audited as ${actor.bdActor}.`,
        { id: params.id, action: params.action },
      );
    },
  });

  pi.registerTool({
    name: "workgraph_answer_decision",
    label: "Answer decision",
    description:
      "Answer the question a run of this issue parked for a human (phase escalated, decision pending). " +
      "Records the answer, audits it, and clears the block; then workgraph_approve resumes the issue and " +
      "every later run receives the question and the answer. " +
      "When the question comes from a diff guard (weakened-tests, unproven-tests, scope), the exact answer allow " +
      "accepts the change: that guard passes for the rest of the issue. Any other answer is carried as instructions and the guard still applies.",
    promptSnippet: "Answer a parked decision request on a work-graph issue",
    promptGuidelines: [
      "When workgraph_approve refuses an escalated issue because it needs a human decision, read the question with workgraph_status, get the human's answer, call workgraph_answer_decision with it, then approve again.",
      "Answer allow to a diff-guard question only when the human said to accept the change it names; never choose allow yourself to get work through.",
    ],
    parameters: AnswerDecisionParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepare(ctx);
      const actor = defaultLeaseActor();
      const cur = await show(ctx.cwd, params.id);
      const metadata = cur.metadata ?? {};
      if (
        metadata.workgraph_decision_pending !== true &&
        metadata.workgraph_decision_pending !== "true"
      ) {
        throw new Error(`${params.id} has no pending decision request.`);
      }
      const question = metadata[WORKGRAPH_DECISION_QUESTION_KEY];
      // A guard question is one the CORE marked with the gates it is about.
      // The text of the question decides nothing: an executor can write a
      // question that reads like a guard's, and its answer must never
      // switch a guard off.
      const guards = decisionGatesOf(cur);
      const allows =
        guards.length > 0 &&
        params.answer.trim().toLowerCase() === GUARD_ALLOW_ANSWER;
      const allowed = allows
        ? [...new Set([...guardAllowedOf(cur), ...guards])]
        : [];
      // Audit FIRST, as override does: a half-applied answer must still be visible.
      await recordLeaseEvent(
        ctx.cwd,
        "decision-answered",
        params.id,
        {
          decisionId: metadata.workgraph_decision_id,
          question,
          answer: params.answer,
          ...(guards.length > 0 ? { gates: guards, allowed: allows } : {}),
          actor: identitySnapshot(actor),
        },
        actor.bdActor,
      );
      await setMetadata(
        ctx.cwd,
        params.id,
        {
          workgraph_decision_pending: false,
          [WORKGRAPH_DECISION_ANSWER_KEY]: params.answer,
          workgraph_decision_answered_at: new Date().toISOString(),
          // Answered: the next question starts unmarked.
          [WORKGRAPH_DECISION_GATE_KEY]: "",
          // The allowance and who gave it, in the same write as the answer.
          ...(allows
            ? {
                [WORKGRAPH_GUARD_ALLOWED_KEY]: allowed.join(","),
                [WORKGRAPH_GUARD_ALLOWED_BY_KEY]: actor.bdActor,
              }
            : {}),
        },
        actor.bdActor,
      );
      // Say which of the two happened: `"allow"` in quotes or `Allow.` is
      // not the answer, and a human who meant it should learn that now.
      const outcome = allows
        ? ` Allowed ${guards.join(", ")}: from the next run on, that guard records these changes as accepted for this issue.`
        : guards.length > 0
          ? ` The answer was not exactly "${GUARD_ALLOW_ANSWER}", so ${guards.join(", ")} still applies: the next run receives the answer as instructions, and another violation parks the issue again.`
          : "";
      return textResult(
        `Answered the decision on ${params.id}.${outcome} Re-approve it with workgraph_approve; every later run receives the question and this answer.`,
        {
          id: params.id,
          question: question ?? null,
          guards,
          allowed: allows,
        },
      );
    },
  });

  pi.registerTool({
    name: "workgraph_status",
    label: "Work status",
    description:
      "Show one issue's full workgraph state: lifecycle phase, acceptance criteria, the check command or its waiver, risk tier, " +
      "workflow run, attempt, last verdict and the context its review ran in, the gate modes that apply and each gate's latest result, " +
      "the outcome recorded after the close (or that an outcome step is still expected to report), " +
      "executor, and the lease (holder, epoch, expiry).",
    promptSnippet: "Show a work-graph issue's lifecycle and lease state",
    promptGuidelines: [
      "Use workgraph_status to inspect where an issue is in the lifecycle before acting on it.",
    ],
    parameters: StatusParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = await prepare(ctx);
      const issue = await show(ctx.cwd, params.id);
      const phase = phaseOf(issue);
      const metadata = issue.metadata ?? {};
      const executorId = metadata[WORKGRAPH_EXECUTOR_ID_KEY];
      const lines = [
        renderIssue(issue),
        `Lifecycle: ${
          isLifecycleV1(issue)
            ? `v1, phase ${phase ?? "unknown"}`
            : "legacy (not yet approved — workgraph_approve moves it to ready)"
        }`,
      ];
      if (issue.acceptance_criteria) {
        lines.push(`Acceptance: ${issue.acceptance_criteria}`);
      }
      // The check as it would be frozen at the next claim: the issue's own
      // command, else its waiver, else the repository default.
      const effectiveCheck = resolveCheck(issue, config);
      if (effectiveCheck.spec !== undefined) {
        lines.push(
          `Check: ${effectiveCheck.spec.command}${
            effectiveCheck.source === "repository default" ? " (repository default)" : ""
          }`,
        );
      } else if (effectiveCheck.waiver !== undefined) {
        lines.push(`Check waived: ${effectiveCheck.waiver}`);
      }
      const riskTier = riskTierOf(issue);
      if (riskTier) lines.push(`Risk tier: ${riskTier}`);
      const workflowClass = workflowClassOf(issue);
      if (isLifecycleV1(issue)) lines.push(`Workflow class: ${workflowClass}`);
      if (phase === "plan_review") {
        const plan = await latestPlan(ctx.cwd, params.id);
        // The critique is read only when the summary says there are gaps to
        // show: the summary is rewritten on every park, so it — not the
        // comment trail — says whether THIS plan was critiqued.
        const summary = metadata[WORKGRAPH_PLAN_CRITIQUE_KEY];
        const critiqued = typeof summary === "string" && critiqueHasGaps(summary);
        const critique = critiqued ? await latestPlanCritique(ctx.cwd, params.id) : undefined;
        // Gaps are only "marked under the steps" when there are steps to mark.
        const critiqueLine =
          typeof summary === "string"
            ? planCritiqueLine(summary, plan !== undefined && critique !== undefined)
            : undefined;
        lines.push(
          "Plan awaiting your review — workgraph_approve_plan with decision approve, or reject plus feedback:",
          ...(critiqueLine !== undefined ? [critiqueLine] : []),
          plan ? renderPlanForReview(plan, critique) : "(no readable plan recorded — reject to plan again)",
        );
      } else if (typeof metadata[WORKGRAPH_PLAN_SUMMARY_KEY] === "string" && metadata[WORKGRAPH_PLAN_SUMMARY_KEY]) {
        lines.push(`Plan: ${metadata[WORKGRAPH_PLAN_SUMMARY_KEY]}${planApprovedOf(issue) ? " (approved)" : ""}`);
      }
      const runId = workflowRunIdOf(issue);
      if (runId) {
        const attempt = attemptOf(issue);
        lines.push(
          `Run: ${runId}${attempt !== undefined ? ` (attempt ${attempt})` : ""}${
            typeof executorId === "string" && executorId !== ""
              ? ` via ${executorId}`
              : ""
          }`,
        );
      }
      const verdict = lastVerdictOf(issue);
      if (verdict) lines.push(`Last verdict: ${verdict}`);
      // The context the latest recorded review ran in, as its executor
      // reported it (`fresh`: launched with no memory of the implementation).
      // Read from the verdict record: the summary above is metadata and
      // carries no provenance.
      const reviewContext = reviewContextOf(
        await latestVerdictRecord(ctx.cwd, params.id),
      );
      if (reviewContext) lines.push(`Review context: ${reviewContext}`);
      // The gate modes in force for this issue's tier (a missing or unknown
      // tier resolves to medium, as it does for the gate itself), then what
      // each gate last found. Kept below the plan block: readers of a parked
      // plan find its lines relative to the review header.
      const policy = resolvePolicy(riskTier, config.policy);
      lines.push(`Gates: ${GATES.map((gate) => `${gate}=${policy.gates[gate]}`).join(" ")}`);
      const gateResults = latestGateRecords(await listGateRecords(ctx.cwd, params.id));
      for (const record of gateResults) lines.push(gateResultLine(record));
      // What happened after the close, printed only when there is something
      // to print: a record for the latest close, or a step still expected
      // to report. Below the gate results, like them clear of the plan
      // block.
      const outcomeStatus = outcomeStatusOf(issue);
      const outcome =
        outcomeOf(issue) !== undefined || outcomeStatus !== undefined
          ? await latestOutcome(ctx.cwd, params.id)
          : undefined;
      if (outcome !== undefined) {
        lines.push(
          `Outcome: ${compactOutcome(outcome)}: ${outcome.summary}${
            outcome.actor !== undefined ? ` (recorded by ${outcome.actor})` : ""
          }`,
        );
      } else if (outcomeStatus === "pending") {
        const step = outcomeExecutionIdOf(issue);
        const deadline = outcomeDeadlineOf(issue);
        lines.push(
          `Outcome: pending${step !== undefined ? `, outcome step ${step}` : ""}${
            deadline !== undefined ? `, recorded as unknown after ${deadline}` : ""
          }`,
        );
      }
      const question = metadata[WORKGRAPH_DECISION_QUESTION_KEY];
      if (
        metadata.workgraph_decision_pending === true ||
        metadata.workgraph_decision_pending === "true"
      ) {
        lines.push(`Decision awaiting your answer (workgraph_answer_decision, then workgraph_approve): ${question}`);
      } else if (typeof metadata[WORKGRAPH_DECISION_ANSWER_KEY] === "string") {
        lines.push(`Decision answered: ${question} → ${metadata[WORKGRAPH_DECISION_ANSWER_KEY]}`);
      }
      // The diff guards a human allowed for this issue, and the ones whose
      // one revision round is spent (the next violation asks a human).
      const guardsAllowed = guardAllowedOf(issue);
      if (guardsAllowed.length > 0) {
        const by = guardAllowedByOf(issue);
        lines.push(`Guards allowed: ${guardsAllowed.join(", ")}${by !== undefined ? ` (by ${by})` : ""}`);
      }
      const guardsSpent = guardRoundsOf(issue).filter((gate) => !guardsAllowed.includes(gate));
      if (guardsSpent.length > 0) {
        lines.push(`Guard revision round spent: ${guardsSpent.join(", ")}`);
      }
      const holder = leaseHolderOf(issue);
      if (holder) {
        lines.push(
          `Lease: held by ${holder} (epoch ${leaseEpochOf(issue)}, expires ${
            leaseExpiresAtOf(issue) ?? "unknown"
          })`,
        );
      } else {
        lines.push(`Lease: none (epoch ${leaseEpochOf(issue)})`);
      }
      return textResult(lines.join("\n"), {
        issue,
        phase: phase ?? null,
        riskTier: riskTier ?? null,
        workflowClass: isLifecycleV1(issue) ? workflowClass : null,
        workflowRunId: runId ?? null,
        attempt: attemptOf(issue) ?? null,
        lastVerdict: verdict ?? null,
        reviewContext: reviewContext ?? null,
        check: effectiveCheck.spec?.command ?? null,
        checkWaiver: effectiveCheck.waiver ?? null,
        gates: policy.gates,
        gateResults,
        outcome: outcome ?? null,
        outcomeStatus: outcome !== undefined ? "recorded" : outcomeStatus ?? null,
      });
    },
  });

  pi.registerTool({
    name: "workgraph_record_outcome",
    label: "Record outcome",
    description:
      "Record what happened to accepted work after it closed. " +
      "The issue must be closed by the gate and carry its close stamp; an open issue or one closed by workgraph_override is refused. " +
      "Recording again is allowed: the latest record counts and the earlier ones stay on the trail.",
    promptSnippet: "Record what happened to accepted work after it closed",
    promptGuidelines: [
      "Use workgraph_record_outcome only for what actually happened after the close: clean when nothing more was needed, needed_fixes with the number of fix rounds, abandoned when the work was dropped or reverted. Do not record clean for work nobody followed up on.",
    ],
    parameters: RecordOutcomeParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepareHeld(ctx);
      const actor = defaultLeaseActor();
      // An unknown id throws here, before any guard is read.
      const issue = await show(ctx.cwd, params.id);
      const gradable = await gradableClose(ctx.cwd, issue);
      if (!gradable.ok) throw new Error(gradable.refusal);
      const summary = params.summary.trim();
      if (summary === "") {
        throw new Error("workgraph_record_outcome needs a one-line summary.");
      }
      // Pi checks parameters against the schema before `execute`; a direct
      // caller gets the same answer here. `unknown` is the core's own word
      // for a step that never reported, and is not a caller's to write.
      const reported = REPORTABLE_OUTCOMES.find((value) => value === params.outcome);
      if (reported === undefined) {
        throw new Error(
          `workgraph_record_outcome takes outcome ${REPORTABLE_OUTCOMES.join(", ")}; got "${params.outcome}".`,
        );
      }
      const outcome: OutcomeT = {
        outcome: reported,
        ...(params.fixRounds !== undefined ? { fixRounds: params.fixRounds } : {}),
        summary,
      };
      // The reporter does not know which execution it is: while a step is
      // still expected to report, the record takes the launched step's id.
      const executionId =
        outcomeStatusOf(issue) === "pending"
          ? outcomeExecutionIdOf(issue)
          : undefined;
      await recordOutcome(
        ctx.cwd,
        params.id,
        outcome,
        {
          actor: actor.bdActor,
          ...(executionId !== undefined ? { executionId } : {}),
          workflowRunId: gradable.stamp.workflowRunId,
        },
        actor.bdActor,
      );
      return textResult(
        `Recorded outcome ${compactOutcome(outcome)} for ${params.id}.`,
        {
          id: params.id,
          outcome: params.outcome,
          fixRounds: params.fixRounds ?? null,
          executionId: executionId ?? null,
        },
      );
    },
  });

  pi.registerTool({
    name: "workgraph_scorecard",
    label: "Scorecard",
    description:
      "Report how accepted work held up: of the issues the gate closed in the window (default 7 days), how many needed nothing, needed fixes, " +
      "were abandoned, ended unknown, or have no outcome recorded (never counted as clean), split by whether their check passed or was waived, " +
      "with the issues that fared worst. Under ten counted issues it prints counts, not a percentage.",
    promptSnippet: "Report how accepted work held up after it closed",
    promptGuidelines: [
      "Use workgraph_scorecard to see whether accepted work needed fixes after it closed; an issue with no outcome recorded is not a clean one.",
    ],
    parameters: ScorecardParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepare(ctx);
      const card = scorecard(await scorecardRows(ctx.cwd), {
        now: new Date(),
        windowDays: params.windowDays ?? DEFAULT_SCORECARD_WINDOW_DAYS,
      });
      return textResult(renderScorecard(card), { scorecard: card });
    },
  });

  pi.registerTool({
    name: "workgraph_gates",
    label: "Gate report",
    description:
      "Report what the proof gates did: for each gate, the issues it blocked (mode enforce) and the issues it would have blocked (mode observe). " +
      "A gate that is off records nothing. Work whose check was waived is listed under check as not applicable, with the waiver reason. " +
      "A diff guard (weakened-tests, unproven-tests, scope) also lists the issues it could not decide as unknown: a guard that is blind in this repository shows there. " +
      "Pass an id to narrow the report to one issue.",
    promptSnippet: "Report which gates blocked work, or would have",
    promptGuidelines: [
      "Use workgraph_gates to see what each gate blocked or would have blocked before changing a gate's mode in the policy.",
    ],
    parameters: GatesParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepare(ctx);
      // An unknown id is an error, not an empty report.
      if (params.id !== undefined) await show(ctx.cwd, params.id);
      const summary = summarizeGates(await listGateRecords(ctx.cwd, params.id));
      const lines = GATES.map((gate) => gateReportLine(gate, summary[gate]));
      return textResult(lines.join("\n"), {
        id: params.id ?? null,
        gates: summary,
      });
    },
  });

  pi.registerTool({
    name: "workgraph_heartbeat",
    label: "Heartbeat",
    description:
      "Renew the leases on the issues this worker currently holds (extends lease_expires_at; verifies the fencing epoch first)",
    promptSnippet: "Renew the lease on claimed work-graph issues",
    promptGuidelines: [
      "Call workgraph_heartbeat periodically while working a claimed issue so the lease does not expire and get reclaimed.",
    ],
    parameters: HeartbeatParams,
    executionMode: "sequential",
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const config = await prepareHeld(ctx);
      const leases = heldLeases(ctx.cwd);
      if (leases.length === 0) {
        return textResult("No active lease to renew — claim an issue first.", {
          renewed: false,
          leases: [],
        });
      }
      const renewed = [];
      const reclaimed: { issueId: string; by: string }[] = [];
      for (const lease of leases) {
        try {
          renewed.push(
            await renewLease(ctx.cwd, lease, {
              ttlMs: config.leaseTtlMs,
              // Renew as the actor stored at acquire time.
              actor: lease.actor,
            }),
          );
        } catch (e) {
          if (e instanceof FencingError) {
            reclaimed.push({ issueId: e.issueId, by: e.currentHolder });
            continue; // renew the rest before reporting the loss
          }
          throw e;
        }
      }
      if (reclaimed.length > 0) {
        const lost = reclaimed
          .map((r) => `your lease on ${r.issueId} was reclaimed by ${r.by}`)
          .join("; ");
        throw new Error(
          `${lost} — do not continue ${
            reclaimed.length === 1 ? "that issue" : "those issues"
          }.` + (renewed.length > 0 ? ` (${renewed.length} other lease(s) renewed)` : ""),
        );
      }
      const lines = renewed
        .map((l) => `${l.issueId} (epoch ${l.epoch}) → expires ${l.expiresAt}`)
        .join("\n");
      return textResult(`Renewed ${renewed.length} lease(s):\n${lines}`, {
        renewed: true,
        leases: renewed,
      });
    },
  });

  pi.registerTool({
    name: "workgraph_init",
    label: "Initialize work graph",
    description:
      "Create the workgraph workspace for this repository (.workgraph/workgraph.db, gitignored). Idempotent: an existing workspace is left untouched.",
    promptSnippet: "Initialize a work-graph workspace here",
    promptGuidelines: [
      "Use workgraph_init once per repository before creating issues; calling it again is harmless.",
      "When asked to set up workgraph for a feature: call workgraph_init, then workgraph_create with approve: true, workflowClass planned, acceptance criteria derived from the request, and check set to the command that proves the work (the repository's test command, e.g. npm test) unless Pi settings already name a default under workgraph.check; if the request names models for roles, call workgraph_tiers first (otherwise the roster in Pi settings applies).",
    ],
    parameters: InitParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await initWorkspace(ctx.cwd, { prefix: params.prefix });
      return textResult(
        `${result.created ? "Initialized" : "Found an existing"} workgraph workspace for ${result.root} — database ${result.databasePath} (issue ids prefixed "${result.prefix}-").`,
        result,
      );
    },
  });

  pi.registerTool({
    name: "workgraph_create",
    label: "Create work",
    description:
      "Create an issue in the work graph. With approve: true it is dispatchable immediately (phase ready); " +
      "workflowClass planned makes the coordinator plan first and wait for workgraph_approve_plan before any code is written. " +
      "check is the shell command the core itself runs against the result before any review. " +
      "With approve: true, medium- and high-risk work (the default tier is medium) is refused without a check or a repository default " +
      "unless checkWaiver records why no check applies.",
    promptSnippet: "Create a work-graph issue",
    promptGuidelines: [
      "Use workgraph_create to add work. Pass approve: true with acceptance criteria and a check command to dispatch it; use workflowClass planned when you want to review a plan before implementation.",
      "Pass checkWaiver only on explicit human instruction, with the human's reason; never invent a waiver to get work approved.",
    ],
    parameters: CreateParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = await prepare(ctx);
      const actor = defaultLeaseActor();
      const riskTier = params.riskTier ?? (params.approve ? DEFAULT_RISK_TIER : undefined);
      const requestedWorkflowClass =
        params.workflowClass ?? (params.approve ? DEFAULT_WORKFLOW_CLASS : undefined);
      // A draft may carry a check or a waiver for its later approval; the
      // rule itself applies only to work created approved.
      const given = authoredCheck(params);
      if (params.approve) {
        const refusal = approvalRefusal(riskTier, given, config);
        if (refusal !== undefined) throw new Error(`Cannot create approved work: ${refusal}`);
      }
      const issue = await createIssue(
        ctx.cwd,
        {
          title: params.title,
          description: params.description,
          priority: params.priority,
          issueType: params.issueType,
          acceptanceCriteria: params.acceptanceCriteria,
          riskTier,
          workflowClass: requestedWorkflowClass as WorkflowClassT | undefined,
          approved: params.approve,
          dependsOn: params.dependsOn,
          metadata: checkMetadata(given),
        },
        actor.bdActor,
      );
      if (params.approve) {
        await recordLeaseEvent(
          ctx.cwd,
          "approve",
          issue.id,
          {
            riskTier,
            workflowClass: workflowClassOf(issue),
            requestedWorkflowClass,
            acceptanceCriteria: params.acceptanceCriteria ?? null,
            check: given.check ?? null,
            checkWaiver: given.waiver ?? null,
            actor: identitySnapshot(actor),
            via: "workgraph_create",
          },
          actor.bdActor,
        );
      }
      const note = params.approve
        ? `Approved: phase ready, workflow ${workflowClassOf(issue)}, risk ${riskTier}. The coordinator dispatches it on its next tick.`
        : "Draft: approve it with workgraph_approve when it is ready to dispatch.";
      return textResult(`Created ${renderIssue(issue)}\n${note}`, { issue });
    },
  });

  pi.registerTool({
    name: "workgraph_approve_plan",
    label: "Review plan",
    description:
      "Approve or reject the plan recorded for an issue in phase plan_review. Approve: the next coordinator tick claims it for implementation with the plan attached. " +
      "Reject (feedback required): it is planned again with your feedback.",
    promptSnippet: "Approve or reject a recorded plan",
    promptGuidelines: [
      "When an issue waits in plan_review, read its plan with workgraph_status, then call workgraph_approve_plan with decision approve, or reject plus feedback.",
    ],
    parameters: ApprovePlanParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepare(ctx);
      const actor = defaultLeaseActor();
      const cur = await show(ctx.cwd, params.id);
      const phase = phaseOf(cur);
      if (phase !== "plan_review") {
        throw new Error(
          `Cannot review a plan for ${params.id}: its phase is "${phase ?? "<legacy>"}", not plan_review.`,
        );
      }
      const feedback = params.feedback?.trim() ?? "";
      if (params.decision === "reject" && feedback === "") {
        throw new Error("Rejecting a plan needs feedback: say what the next plan must change.");
      }
      const plan = await latestPlan(ctx.cwd, params.id);
      if (params.decision === "approve" && plan === undefined) {
        throw new Error(
          `No readable plan is recorded for ${params.id}; reject it (with feedback) to plan again.`,
        );
      }
      await transition(ctx.cwd, params.id, "plan_review", "ready", {
        fields: {
          [WORKGRAPH_PLAN_APPROVED_KEY]: params.decision === "approve",
          [WORKGRAPH_PLAN_FEEDBACK_KEY]: params.decision === "approve" ? "" : feedback,
        },
        actor: actor.bdActor,
      });
      await recordLeaseEvent(
        ctx.cwd,
        params.decision === "approve" ? "plan-approved" : "plan-rejected",
        params.id,
        {
          feedback: feedback || null,
          steps: plan?.steps.length ?? null,
          actor: identitySnapshot(actor),
        },
        actor.bdActor,
      );
      const text =
        params.decision === "approve"
          ? `Approved the plan for ${params.id} (${plan!.steps.length} steps). The coordinator implements it on its next tick.`
          : `Rejected the plan for ${params.id}. It will be planned again with your feedback.`;
      return textResult(text, {
        id: params.id,
        decision: params.decision,
        steps: plan?.steps.length ?? null,
      });
    },
  });

  pi.registerTool({
    name: "workgraph_tiers",
    label: "Model tiers",
    description:
      "Set or show which model each workgraph role runs on (planner, implementer, reviewer, revision, verifier, finalizer) for this repository. " +
      "Setting it here stores the choice in this repository's workspace. The usual home is Pi settings under \"workgraph\": { \"tiers\": { role: model } } — ~/.pi/agent/settings.json for every repository or .pi/settings.json for one. " +
      "Precedence: --workgraph-tiers flag/env > project settings > this tool > global settings. With no arguments, shows the table in force and where it came from.",
    promptSnippet: "Set or show per-role model tiers for this repository",
    promptGuidelines: [
      "Use workgraph_tiers with a table when the user names which model should plan, implement, or review; the roster in Pi settings applies otherwise.",
    ],
    parameters: TiersParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepare(ctx);
      const registry =
        ctx.modelRegistry && typeof ctx.modelRegistry.getAvailable === "function"
          ? ctx.modelRegistry
          : undefined;
      const describe = (config: TierConfig | undefined, origin: string): AgentToolResult<unknown> => {
        if (!config) {
          setResolvedTiers(undefined);
          return textResult(`No model tiers ${origin}; every role uses its executor's default model.`, {
            tiers: null,
          });
        }
        if (!registry) {
          return textResult(
            `Tiers ${origin}: ${JSON.stringify(config)} (model registry unavailable in this context; resolved at the next session start).`,
            { tiers: config, resolved: null },
          );
        }
        const { resolved, unresolved } = resolveTiers(registry, config);
        setResolvedTiers(resolved);
        const lines = describeTiers(resolved);
        for (const miss of unresolved) {
          lines.push(`${miss.role}: no available model matches "${miss.pattern}" — runs untiered`);
        }
        return textResult(`Model tiers ${origin}:\n${lines.join("\n") || "(none resolved)"}`, {
          tiers: config,
          resolved: Object.fromEntries(
            Object.entries(resolved).map(([role, tier]) => [role, { model: tier.id, thinking: tier.thinking ?? null }]),
          ),
          unresolved,
        });
      };

      if (!params.clear && params.table === undefined) {
        const effective = await effectiveTiers(resolveFlags(pi).tiers, ctx.cwd);
        return describe(
          effective?.tiers,
          effective
            ? `in force (from ${effective.origin})`
            : 'configured — declare "workgraph": { "tiers": { "planner": "provider/id", ... } } in ~/.pi/agent/settings.json (all repos) or .pi/settings.json (this repo), or call this tool with a table',
        );
      }
      let config: TierConfig | undefined;
      if (params.table !== undefined) {
        config = parseTiersValue(JSON.stringify(params.table));
        if (!config) throw new Error("The tier table named no known role or model; nothing stored.");
      } else {
        config = undefined; // clear
      }
      await storeTiers(ctx.cwd, config);
      return describe(config, config ? "stored for this workspace" : "stored (cleared)");
    },
  });
}
