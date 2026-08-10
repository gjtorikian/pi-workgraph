/**
 * Shared data shapes and tool parameter schemas for pi-workgraph.
 *
 * bd guarantees five fields on every issue (`id`, `title`, `status`,
 * `priority`, `issue_type`); everything else is optional — issues created
 * with a bare `bd create <title>` omit assignee, description, metadata, etc.
 * Treating any non-guaranteed field as required is how prior art crashed on
 * minimally-populated issues.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

/** A reference to another issue inside a `dependencies` array. */
export interface BeadsIssueRef {
  id: string;
  title?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  dependency_type?: string;
}

/** An issue as returned by `bd ... --json`. */
export interface BeadsIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  assignee?: string;
  owner?: string;
  description?: string;
  notes?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
  dependencies?: BeadsIssueRef[];
  created_at?: string;
  created_by?: string;
  updated_at?: string;
  closed_at?: string;
  close_reason?: string;
  schema_version?: number;
  /** bd's native acceptance-criteria field (`--acceptance`, bd >= 1.1.2). */
  acceptance_criteria?: string;
}

/**
 * Lease state attached to claimed issues, stored in issue metadata. These
 * three key names are the interop surface — FROZEN from Phase 2 forward;
 * renaming one after v0.1 publishes is a breaking protocol change.
 */
export interface LeaseFields {
  /** workerId() of the holder */
  lease_holder: string;
  /** fencing token — integer, monotonic per issue, never resets */
  lease_epoch: number;
  /** RFC3339 UTC, second precision */
  lease_expires_at: string;
}

/** The lease metadata keys, in one place (release unsets a subset of these). */
export const LEASE_HOLDER_KEY = "lease_holder";
export const LEASE_EPOCH_KEY = "lease_epoch";
export const LEASE_EXPIRES_AT_KEY = "lease_expires_at";

/**
 * The explicit identity a lease operation acts as. Lease functions have ZERO
 * ambient identity — callers always thread one of these (built from
 * `defaultLeaseActor()` until phase 2 starts generating workflow-run
 * holders), so the interactive session's lifetime never silently becomes the
 * lease's lifetime.
 */
export interface LeaseActor {
  /** Value written to the lease_holder metadata key. */
  holder: string;
  /** bd `--actor` for audit attribution (may differ from holder: the initiator). */
  bdActor: string;
}

/** Prefix of generated workflow-run lease holders (phase 2+). */
export const WORKFLOW_RUN_PREFIX = "workgraph-run/";

/** Mint a fresh workflow-run holder id, e.g. `workgraph-run/6f9a…`. */
export function newWorkflowRunId(): string {
  return `${WORKFLOW_RUN_PREFIX}${crypto.randomUUID()}`;
}

/**
 * Lifecycle metadata keys the coordinator writes (README "Durable lifecycle
 * metadata"). Intent (`workgraph_workflow_run_id` + `workgraph_executor_id`)
 * is persisted BEFORE a run request is emitted, so a crash between claim and
 * accept is reconcilable (phase 4) and never orphans silently.
 */
export const WORKGRAPH_PHASE_KEY = "workgraph_phase";
export const WORKGRAPH_WORKFLOW_RUN_ID_KEY = "workgraph_workflow_run_id";
export const WORKGRAPH_EXECUTOR_ID_KEY = "workgraph_executor_id";
export const WORKGRAPH_LIFECYCLE_VERSION_KEY = "workgraph_lifecycle_version";
export const WORKGRAPH_ATTEMPT_KEY = "workgraph_attempt";
export const WORKGRAPH_RISK_TIER_KEY = "workgraph_risk_tier";
export const WORKGRAPH_ACTIVE_EXECUTION_ID_KEY = "workgraph_active_execution_id";
export const WORKGRAPH_AUTHOR_PROVENANCE_KEY = "workgraph_author_provenance";
export const WORKGRAPH_LAST_VERDICT_KEY = "workgraph_last_verdict";
export const WORKGRAPH_FAILURE_FINGERPRINT_KEY = "workgraph_failure_fingerprint";

/**
 * The lifecycle phase union (README "Durable lifecycle metadata"). Beads'
 * four native statuses stay untouched; this is workgraph semantics stored in
 * `workgraph_phase`. Legal edges live in `src/lifecycle.ts`'s LEGAL table.
 */
export type WorkgraphPhase =
  | "draft"
  | "ready"
  | "implementing"
  | "judging"
  | "revising"
  | "verifying"
  | "accepted"
  | "escalated";

// ---------------------------------------------------------------------------
// Identity seam (phase 3). Three nominal identity shapes plus the provider
// interface the coordinator consumes; `localIdentityProvider()` in
// identity.ts is the default (workerId-backed) implementation.
// ---------------------------------------------------------------------------

/** The human/session that initiated coordination (bd `--actor` attribution). */
export interface InitiatorIdentity {
  kind: "initiator";
  id: string;
}

/** A generated workflow-run identity — the lease holder for delegated work. */
export interface WorkflowRunIdentity {
  kind: "workflow-run";
  id: string;
}

/** An executor adapter's advertised identity. */
export interface ExecutorIdentity {
  kind: "executor";
  id: string;
}

/** Mints the identities coordination acts as; injectable for tests/harnesses. */
export interface IdentityProvider {
  initiator(): InitiatorIdentity;
  newWorkflowRun(): WorkflowRunIdentity;
}

/**
 * A held lease as tracked by the holder. `epoch` is the fencing token: every
 * holder write first re-reads the issue and verifies this epoch is still
 * current; a stale holder that wakes up after a reclaim finds a higher epoch
 * and aborts.
 */
export interface Lease {
  issueId: string;
  epoch: number;
  /** RFC3339 expiry as last written by this holder. */
  expiresAt: string;
}

/** Audit-trail event kinds for lease transitions. */
export type LeaseEvent =
  | "claim"
  | "renew"
  | "release"
  | "expire-detected"
  | "reclaim"
  | "lost-acquisition-race"
  /** A holder's heartbeat discovered its lease was reclaimed (Phase 3 dispatch). */
  | "fencing-loss"
  /** Coordinator (phase 2): the executor rejected the run request. */
  | "executor-rejected"
  /** Coordinator (phase 2): no accept/reject inside the deadline — released. */
  | "accept-timeout"
  /** Coordinator (phase 2): a fenced run:completed landed; issue → judging. */
  | "run-completed"
  /** Coordinator (phase 2): a run:completed failed the fencing triple — ignored. */
  | "stale-result-rejected"
  /** workgraph_approve: draft/legacy issue approved into the ready phase. */
  | "approve"
  /** workgraph_override: audited human close/release bypassing phase guards. */
  | "override"
  /** Judgment (phase 3): a review was discarded (non-independent or invalid). */
  | "review-rejected"
  /** Judgment (phase 3): a reviewer completion carried no parseable verdict. */
  | "verdict-invalid"
  /** Judgment (phase 3): blocking verdict → a revision run was requested. */
  | "revision-requested"
  /** Judgment (phase 3): escalated (fingerprint repeat, bounds, no reviewer). */
  | "escalated"
  /** Judgment (phase 3): verdict passed the gate — issue accepted and closed. */
  | "judgment-closed"
  /** Recovery (phase 4): a persisted run was re-adopted after a restart. */
  | "re-adopted"
  /** Recovery (phase 4): a persisted run was abandoned (missing, unreachable,
   *  status timeout, or no recorded execution) — left for the TTL sweep. */
  | "recovery-abandoned"
  /** Shutdown (phase 4): run:cancel went unacknowledged — heartbeat stopped,
   *  lease left INTACT for TTL reclaim (never released under a live mutator). */
  | "abandoned-unacked-cancel"
  /** Phase 4: best-effort run:cancel published for a recorded execution. */
  | "cancel-published";

// ---------------------------------------------------------------------------
// Verdict shapes (phase 3). A reviewer completion carries a `verdict` field
// (protocol-v1 schemas are non-strict, so the extra field rides RunCompleted
// untouched); `src/verdict.ts` validates it against these schemas before the
// judgment gate acts on it.
// ---------------------------------------------------------------------------

export const Finding = Type.Object({
  /** The acceptance criterion (or invariant) this finding is about. */
  criterion: Type.String(),
  /** `blocking` findings gate continuation under a blocking policy;
   *  `advisory` findings are persisted but never block. */
  severity: StringEnum(["blocking", "advisory"]),
  note: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
});
export type FindingT = Static<typeof Finding>;

export const Verdict = Type.Object({
  findings: Type.Array(Finding),
  summary: Type.Optional(Type.String()),
});
export type VerdictT = Static<typeof Verdict>;

// ---------------------------------------------------------------------------
// Tool parameter schemas (TypeBox). Pi validates tool-call arguments against
// these before the handler runs.
// ---------------------------------------------------------------------------

export const ReadyParams = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: "Maximum number of issues to list (default 10)",
    }),
  ),
  legacy: Type.Optional(
    Type.Boolean({
      description:
        "List legacy issues (no workgraph_lifecycle_version) instead of the default approved lifecycle-v1 ready pool",
    }),
  ),
});
export type ReadyParamsT = Static<typeof ReadyParams>;

export const ClaimParams = Type.Object({
  id: Type.Optional(
    Type.String({
      description:
        "Issue id to claim. Omit to atomically claim the next ready issue.",
    }),
  ),
});
export type ClaimParamsT = Static<typeof ClaimParams>;

export const ReleaseParams = Type.Object({
  id: Type.String({ description: "Issue id to release back to the ready pool" }),
});
export type ReleaseParamsT = Static<typeof ReleaseParams>;

export const CloseParams = Type.Object({
  id: Type.String({ description: "Issue id to close" }),
  reason: Type.Optional(Type.String({ description: "Reason for closing" })),
});
export type CloseParamsT = Static<typeof CloseParams>;

export const SplitParams = Type.Object({
  id: Type.String({ description: "Parent issue id to split into child issues" }),
  children: Type.Array(
    Type.Object({
      title: Type.String({ minLength: 1, description: "Child issue title" }),
      description: Type.Optional(
        Type.String({ description: "Child issue description" }),
      ),
      priority: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 4,
          description: "Priority 0-4 (0 = highest); defaults to the parent's",
        }),
      ),
      acceptanceCriteria: Type.Optional(
        Type.String({ description: "Acceptance criteria for the child issue" }),
      ),
      riskTier: Type.Optional(
        StringEnum(["low", "medium", "high"], {
          description: "Judgment-gate risk tier for the child issue",
        }),
      ),
      approved: Type.Optional(
        Type.Boolean({
          description:
            "Create the child already approved (lifecycle v1, phase ready) instead of draft",
        }),
      ),
    }),
    { minItems: 1, maxItems: 20, description: "Child issues to create" },
  ),
});
export type SplitParamsT = Static<typeof SplitParams>;

export const HeartbeatParams = Type.Object({});
export type HeartbeatParamsT = Static<typeof HeartbeatParams>;

export const ApproveParams = Type.Object({
  id: Type.String({
    description: "Draft, legacy, or escalated issue id to approve",
  }),
  acceptanceCriteria: Type.Optional(
    Type.String({
      description: "Acceptance criteria recorded on the issue (bd --acceptance)",
    }),
  ),
  riskTier: Type.Optional(
    StringEnum(["low", "medium", "high"], {
      description:
        "Judgment-gate risk tier (default medium: blocking gate + author independence)",
    }),
  ),
});
export type ApproveParamsT = Static<typeof ApproveParams>;

export const OverrideParams = Type.Object({
  id: Type.String({ description: "Issue id to override" }),
  action: StringEnum(["close", "release"], {
    description: "close the issue or release it back to the pool",
  }),
  reason: Type.String({
    minLength: 1,
    description: "REQUIRED reason, recorded in the audit trail with the actor",
  }),
});
export type OverrideParamsT = Static<typeof OverrideParams>;

export const StatusParams = Type.Object({
  id: Type.String({ description: "Issue id to inspect" }),
});
export type StatusParamsT = Static<typeof StatusParams>;
