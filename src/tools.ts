/**
 * The nine workgraph tools. Thin handlers over the src/bd.ts wrappers:
 * errors are THROWN (never returned as content), output is truncated with
 * pi's truncateTail, and every tool declares `executionMode: "sequential"`
 * because bd's embedded Dolt panics on concurrent in-process access.
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
  createChild,
  ensureWorkspace,
  ready,
  release,
  setMetadata,
  show,
  update,
} from "./bd.ts";
import { resolveConfig, type WorkgraphConfig } from "./config.ts";
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
import {
  attemptOf,
  isLifecycleV1,
  lastVerdictOf,
  phaseOf,
  reapprove,
  riskTierOf,
  transition,
  workflowClassOf,
  workflowRunIdOf,
} from "./lifecycle.ts";
import { DEFAULT_RISK_TIER } from "./policy.ts";
import type { BeadsIssue } from "./types.ts";
import {
  ApproveParams,
  ClaimParams,
  CloseParams,
  HeartbeatParams,
  OverrideParams,
  ReadyParams,
  ReleaseParams,
  SplitParams,
  StatusParams,
  DEFAULT_WORKFLOW_CLASS,
  WORKGRAPH_EXECUTOR_ID_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_RISK_TIER_KEY,
  WORKGRAPH_WORKFLOW_CLASS_KEY,
} from "./types.ts";

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

function renderIssue(issue: BeadsIssue): string {
  const assignee = issue.assignee ? ` @${issue.assignee}` : "";
  return `${issue.id} [P${issue.priority}] (${issue.status})${assignee} ${issue.title}`;
}

function renderIssueList(issues: BeadsIssue[]): string {
  if (issues.length === 0) return "No ready issues.";
  return issues.map(renderIssue).join("\n");
}

export function registerWorkgraphTools(pi: ExtensionAPI): void {
  /**
   * Per-call prologue: resolve identity config lazily (flags are not
   * readable at load), record the session id for workerId(), and verify the
   * bd binary + workspace before touching the graph.
   */
  async function prepare(ctx: ExtensionContext): Promise<WorkgraphConfig> {
    const config = resolveConfig(pi);
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
      "Use workgraph_ready to find work; never parse bd output from bash.",
    ],
    parameters: ReadyParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepare(ctx);
      const limit = params.limit ?? 10;
      // Fetch unlimited and filter client-side (`-n 0`): lifecycle phase is
      // metadata, which bd's ready query cannot filter on.
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
      await prepare(ctx);
      const lease = getHeldLease(ctx.cwd, params.id);
      if (!lease) {
        // No unfenced fallback: an untracked release used to fall through to
        // a bare `bd update --assignee "" --status open` with no holder or
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
      "Split an issue into child issues; the parent is blocked until every child closes",
    promptSnippet: "Split a work-graph issue into children",
    promptGuidelines: [
      "Use workgraph_split when an issue is too large to claim whole.",
    ],
    parameters: SplitParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepare(ctx);
      const actor = workerId();
      // Fail before creating anything if the parent doesn't exist.
      const parent = await show(ctx.cwd, params.id);

      // Create children first, deps second; on partial failure report exactly
      // what exists so no orphan is silently left behind.
      const created: BeadsIssue[] = [];
      for (const child of params.children) {
        try {
          created.push(
            await createChild(
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
      "Approve a draft or legacy issue for dispatch: records acceptance criteria (bd's native field), " +
      "stamps lifecycle v1 with a risk tier and workflow class, and transitions the issue to phase ready. " +
      "Also re-approves escalated work (back to ready, reopened). " +
      "The coordinator only dispatches approved ready work.",
    promptSnippet: "Approve a work-graph issue for dispatch",
    promptGuidelines: [
      "Use workgraph_approve to move a draft, legacy, or escalated issue into the dispatchable ready pool, with acceptance criteria the judgment gate will check.",
    ],
    parameters: ApproveParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepare(ctx);
      const actor = defaultLeaseActor();
      const cur = await show(ctx.cwd, params.id);
      const phase = phaseOf(cur);
      if (phase !== undefined && phase !== "draft" && phase !== "escalated") {
        throw new Error(
          `Cannot approve ${params.id}: approval moves draft, legacy, or escalated issues ` +
            `to ready, but its phase is "${phase}". Mid-flight work is recovered with ` +
            `workgraph_override (action: release), which resets it to draft for re-approval.`,
        );
      }
      const riskTier = params.riskTier ?? DEFAULT_RISK_TIER;
      const requestedWorkflowClass =
        params.workflowClass ??
        (phase === "escalated"
          ? workflowClassOf(cur)
          : DEFAULT_WORKFLOW_CLASS);
      // One-shot intentionally skips independent judgment. A blocking risk
      // tier therefore promotes to reviewed instead of weakening policy.
      const workflowClass =
        requestedWorkflowClass === "oneshot" && riskTier !== "low"
          ? "reviewed"
          : requestedWorkflowClass;
      const approvalFields = {
        [WORKGRAPH_RISK_TIER_KEY]: riskTier,
        [WORKGRAPH_WORKFLOW_CLASS_KEY]: workflowClass,
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
          actor: identitySnapshot(actor),
        },
        actor.bdActor,
      );
      return textResult(
        `Approved ${params.id} for dispatch (workflow ${workflowClass}, risk tier ${riskTier}, phase ready).` +
          (workflowClass !== requestedWorkflowClass
            ? ` Requested ${requestedWorkflowClass} was promoted because only low-risk work may skip independent review.`
            : ""),
        { id: params.id, riskTier, workflowClass, requestedWorkflowClass },
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
      await prepare(ctx);
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
        await close(ctx.cwd, params.id, `override: ${params.reason}`, actor.bdActor);
        untrackLease(ctx.cwd, params.id);
        return textResult(
          `Override-closed ${params.id} (reason: ${params.reason}) — audited as ${actor.bdActor}.`,
          { id: params.id, action: params.action },
        );
      }
      // Release: the deliberate unfenced path — clears the assignee and the
      // lease holder/expiry metadata regardless of who holds it.
      await release(ctx.cwd, params.id, actor.bdActor);
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
    name: "workgraph_status",
    label: "Work status",
    description:
      "Show one issue's full workgraph state: lifecycle phase, acceptance criteria, risk tier, " +
      "workflow run, attempt, last verdict, executor, and the lease (holder, epoch, expiry).",
    promptSnippet: "Show a work-graph issue's lifecycle and lease state",
    promptGuidelines: [
      "Use workgraph_status to inspect where an issue is in the lifecycle before acting on it.",
    ],
    parameters: StatusParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await prepare(ctx);
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
      const riskTier = riskTierOf(issue);
      if (riskTier) lines.push(`Risk tier: ${riskTier}`);
      const workflowClass = workflowClassOf(issue);
      if (isLifecycleV1(issue)) lines.push(`Workflow class: ${workflowClass}`);
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
      const config = await prepare(ctx);
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
}
