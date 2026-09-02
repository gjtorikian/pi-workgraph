/**
 * Protocol v1: the versioned execution envelopes pi-workgraph delegates
 * through (README "Protocol channels" — the twelve `workgraph:v1:*`
 * channels; the {@link CH} constants must stay name-for-name identical to
 * that table).
 *
 * One TypeBox schema per channel payload, an envelope base every message
 * extends, and {@link parseMessage}, which validates INCOMING payloads
 * before any handler acts on them (outgoing messages are constructed typed
 * and never re-validated). Every run-scoped message carries the fencing
 * triple — `issueId` + `workflowRunId` + `leaseEpoch` — so a stale result
 * can never land as a durable transition.
 *
 * Schemas are deliberately NON-strict (TypeBox `Type.Object` tolerates
 * extra fields): a newer adapter may attach fields this version ignores.
 * `protocolVersion: Type.Literal(1)` is the hard gate — a v2 message is
 * rejected, never half-understood.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { WorkflowClass } from "./types.ts";

export const PROTOCOL_VERSION = 1;

/**
 * The twelve protocol-v1 channels. `runProgress` is reserved (no handler
 * until a consumer exists — decision log) and `activity` is emitted from
 * phase 5; both are named now so the channel table is frozen in one place.
 */
export const CH = {
  discover: "workgraph:v1:executor:discover",
  offer: "workgraph:v1:executor:offer",
  runRequest: "workgraph:v1:run:request",
  runAccepted: "workgraph:v1:run:accepted",
  runRejected: "workgraph:v1:run:rejected",
  runProgress: "workgraph:v1:run:progress", // reserved; no handler in this phase
  runCompleted: "workgraph:v1:run:completed",
  runCancel: "workgraph:v1:run:cancel",
  runCancelled: "workgraph:v1:run:cancelled",
  runStatusRequest: "workgraph:v1:run:status-request",
  runStatus: "workgraph:v1:run:status",
  activity: "workgraph:v1:activity", // reserved; emitted from phase 5
} as const;

export type Channel = (typeof CH)[keyof typeof CH];

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Fields every protocol message carries. */
const envelopeProps = {
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  /** Unique per message; correlation and idempotency both key off it. */
  messageId: Type.String(),
  /** RFC3339 UTC. */
  occurredAt: Type.String(),
};

export const Envelope = Type.Object(envelopeProps);
export type EnvelopeT = Static<typeof Envelope>;

/** Mint the envelope fields for an OUTGOING message. */
export function newEnvelope(now: () => number = Date.now): EnvelopeT {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: crypto.randomUUID(),
    occurredAt: new Date(now()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/**
 * `planner` is a v1-safe ADDITION to the role enum, not a redefinition: an
 * adapter that never offers it is unaffected, and the coordinator only enters
 * the planning phase when some offer advertises the role (README "The planner
 * tier"). Order is narrative — the lifecycle runs planner → implementer →
 * reviewer, with `revision`/`verifier` as the gate's own sub-roles.
 */
export const ExecutorRole = StringEnum([
  "planner",
  "implementer",
  "reviewer",
  "revision",
  "verifier",
]);
export type ExecutorRoleT = Static<typeof ExecutorRole>;

export const IsolationLevel = StringEnum(["none", "worktree", "sandbox"]);
export type IsolationLevelT = Static<typeof IsolationLevel>;

export const RunOutcome = StringEnum(["success", "failure", "blocked"]);
export type RunOutcomeT = Static<typeof RunOutcome>;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** core → adapters: request capability offers. */
export const Discover = Type.Object({ ...envelopeProps });
export type DiscoverT = Static<typeof Discover>;

/**
 * adapter → core: advertise identity and capabilities. The optional
 * profile/capacity/priority fields are protocol-v1 fields whose SELECTION
 * logic lands with the pi-subagents adapter (phase 5) — only `priority`
 * participates in ordering today.
 */
export const ExecutorOffer = Type.Object({
  ...envelopeProps,
  /** messageId of the `discover` broadcast this offer answers. */
  inReplyTo: Type.String(),
  executorId: Type.String(),
  adapterVersion: Type.String(),
  roles: Type.Array(ExecutorRole),
  harness: Type.String(),
  isolation: IsolationLevel,
  supportsCancellation: Type.Boolean(),
  supportsReconciliation: Type.Boolean(),
  // Optional v1 fields — selection logic lands with the pi-subagents adapter (phase 5):
  profileSemantics: Type.Optional(
    StringEnum(["initiating", "named", "executor-defined"]),
  ),
  maxConcurrency: Type.Optional(Type.Number()),
  available: Type.Optional(Type.Boolean()),
  priority: Type.Optional(Type.Number()),
});
export type ExecutorOfferT = Static<typeof ExecutorOffer>;

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/**
 * core → adapter: request a run. Addressed to exactly one executor
 * (`executorId` — selection happened before emission); other adapters on
 * the shared bus must ignore requests not addressed to them.
 */
export const RunRequest = Type.Object({
  ...envelopeProps,
  /** The SELECTED executor this request is addressed to. */
  executorId: Type.String(),
  issue: Type.Object({
    id: Type.String(),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    acceptanceCriteria: Type.Optional(Type.String()),
    dependencies: Type.Optional(Type.Array(Type.String())),
    repoRef: Type.Optional(Type.String()),
    /** Per-issue topology hint; absent means the conservative reviewed path. */
    workflowClass: Type.Optional(WorkflowClass),
    /** Judgment strictness, kept separate from workflow topology. */
    riskTier: Type.Optional(StringEnum(["low", "medium", "high"])),
  }),
  workflowRunId: Type.String(),
  leaseEpoch: Type.Number(),
  role: ExecutorRole,
  attempt: Type.Number(),
  workspace: Type.Object({
    baseRevision: Type.String(),
    requiresIsolation: Type.Boolean(),
  }),
  outputSchema: Type.Optional(Type.Unknown()),
  /** Prior judgment findings — used from phase 3. */
  priorFindings: Type.Optional(Type.Array(Type.String())),
  /**
   * The accepted plan, attached to the runs DOWNSTREAM of a planner run
   * (implementer, and revisions of that implementation). Optional and
   * v1-safe: absent whenever no planner ran, and an adapter that ignores it
   * behaves exactly as it did before the role existed. Carried as text — the
   * structured {@link PlanT} lives in the plan comment trail; what the
   * executor needs is the prompt-ready rendering.
   */
  plan: Type.Optional(Type.String()),
});
export type RunRequestT = Static<typeof RunRequest>;

/** adapter → core: bind the workflow request to an executor run. */
export const RunAccepted = Type.Object({
  ...envelopeProps,
  /** messageId of the `run:request` this accepts. */
  inReplyTo: Type.String(),
  workflowRunId: Type.String(),
  executionId: Type.String(),
  issueId: Type.String(),
  leaseEpoch: Type.Number(),
  executorId: Type.String(),
});
export type RunAcceptedT = Static<typeof RunAccepted>;

/** adapter → core: reject before starting, with a stable reason code. */
export const RunRejected = Type.Object({
  ...envelopeProps,
  /** messageId of the `run:request` this rejects. */
  inReplyTo: Type.String(),
  workflowRunId: Type.String(),
  issueId: Type.String(),
  leaseEpoch: Type.Number(),
  executorId: Type.String(),
  reason: Type.String(),
});
export type RunRejectedT = Static<typeof RunRejected>;

/** adapter → core: advisory progress; never a durable transition by itself. */
export const RunProgress = Type.Object({
  ...envelopeProps,
  workflowRunId: Type.String(),
  executionId: Type.String(),
  issueId: Type.String(),
  leaseEpoch: Type.Number(),
  note: Type.Optional(Type.String()),
});
export type RunProgressT = Static<typeof RunProgress>;

/**
 * adapter → core: structured result, artifacts, evidence, provenance —
 * plus the full fencing triple the coordinator re-validates against Beads.
 */
export const RunCompleted = Type.Object({
  ...envelopeProps,
  workflowRunId: Type.String(),
  executionId: Type.String(),
  issueId: Type.String(),
  leaseEpoch: Type.Number(),
  outcome: RunOutcome,
  /** Changed files / patch refs. */
  artifacts: Type.Array(Type.String()),
  evidence: Type.Array(Type.String()),
  provenance: Type.Object({
    harness: Type.String(),
    profile: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
  }),
});
export type RunCompletedT = Static<typeof RunCompleted>;

/**
 * core → adapter: interrupt a run. `executionId` (optional, v1-safe
 * addition — phase 4) names the RECORDED execution being cancelled so a
 * reordered `run:cancelled` arriving after a NEW run started correlates to
 * the old execution and has no effect on the new one.
 */
export const RunCancel = Type.Object({
  ...envelopeProps,
  workflowRunId: Type.String(),
  issueId: Type.String(),
  executionId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
});
export type RunCancelT = Static<typeof RunCancel>;

/** adapter → core: acknowledge cancellation. */
export const RunCancelled = Type.Object({
  ...envelopeProps,
  workflowRunId: Type.String(),
  issueId: Type.String(),
  executionId: Type.Optional(Type.String()),
});
export type RunCancelledT = Static<typeof RunCancelled>;

/**
 * core → adapter: reconcile a persisted active run after restart (phase 4).
 * `executorId`/`executionId` are optional, v1-safe additions: the request is
 * addressed to the RECORDED executor (adapters must ignore requests not
 * addressed to them — the `RunRequest.executorId` precedent) about the
 * RECORDED execution.
 */
export const RunStatusRequest = Type.Object({
  ...envelopeProps,
  workflowRunId: Type.String(),
  issueId: Type.String(),
  executorId: Type.Optional(Type.String()),
  executionId: Type.Optional(Type.String()),
});
export type RunStatusRequestT = Static<typeof RunStatusRequest>;

/**
 * adapter → core: report active, terminal, missing, or unreachable
 * (phase 4). Optional v1-safe additions: `inReplyTo` correlates to the
 * status request's messageId (fall back to workflowRunId when absent);
 * `completion` carries the terminal result inline so a
 * terminal-during-downtime outcome can flow through the coordinator's
 * normal fenced completion handler — one code path, tested once. A
 * `terminal` answer WITHOUT a completion cannot be applied (RunStatus has
 * no other result payload) and is abandoned to the TTL sweep.
 */
export const RunStatus = Type.Object({
  ...envelopeProps,
  workflowRunId: Type.String(),
  issueId: Type.String(),
  status: StringEnum(["active", "terminal", "missing", "unreachable"]),
  inReplyTo: Type.Optional(Type.String()),
  executionId: Type.Optional(Type.String()),
  completion: Type.Optional(RunCompleted),
});
export type RunStatusT = Static<typeof RunStatus>;

/**
 * core → observers: canonical lifecycle changes for UI/presence (phase 5).
 * Emitted strictly POST-COMMIT (after the corresponding bd write resolved)
 * from the coordinator's transition/escalation/close choke points; nothing
 * in-core subscribes. The optional fields are v1-safe additions for
 * presence/kanban overlays:
 *  - `kind`: what changed — `claim`, `transition`, `verdict`, `escalation`,
 *    or `close` (a string, not an enum, so observers tolerate growth);
 *  - `workflowRunId`/`actor`: correlation and attribution;
 *  - `summary`: one human-readable line (e.g. the compact verdict summary).
 *
 * COVERAGE GAP BY DESIGN: only coordinator-owned canonical changes emit
 * activity. The expiry sweep's reclaim/phase-reset and recovery's
 * re-adopt/abandon paths do not — observers needing those must read the
 * audit trail (README "Optional executor" notes the gap).
 */
export const Activity = Type.Object({
  ...envelopeProps,
  issueId: Type.String(),
  phase: Type.String(),
  note: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  workflowRunId: Type.Optional(Type.String()),
  actor: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
});
export type ActivityT = Static<typeof Activity>;

// ---------------------------------------------------------------------------
// pi-subagents adapter version gate (phase 5)
// ---------------------------------------------------------------------------

/**
 * Version-gate constants for the OPTIONAL pi-subagents bridge
 * (`src/adapters/pi-subagents.ts`). They live HERE deliberately: protocol.ts
 * is the single frozen-vocabulary module, and the gate is part of the
 * bridge's public contract (the spec's file table names this placement).
 *
 * Upstream's event names are NOT a declared public API and upstream
 * advertises no version on its bus (verified: zero handshake/version events
 * anywhere in pi-subagents @ commit 3fc6b6b) — so the bridge probes the
 * INSTALLED package's package.json (a filesystem read, never an import).
 * By default any installed version bridges; an explicit
 * `subagentsExecutor.versionRange` (`major.minor` prefix: `"0.34"` accepts
 * every `0.34.x` patch and nothing else) restores strict gating. The
 * constant below records the last contract-verified upstream line.
 *
 * Re-verified against pi-subagents 0.34.8: event names, request parameters,
 * response shape, structured output, progress, and cancellation are intact.
 */
export const SUBAGENTS_PACKAGE_NAME = "pi-subagents";
export const SUBAGENTS_SUPPORTED_VERSION_RANGE = "0.34";

/** True when `version` (e.g. "0.34.8") falls inside a `major.minor` prefix range. */
export function subagentsVersionInRange(
  version: string,
  range: string = SUBAGENTS_SUPPORTED_VERSION_RANGE,
): boolean {
  return version === range || version.startsWith(`${range}.`);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Thrown when an incoming payload fails schema validation. */
export class ProtocolError extends Error {
  readonly channel: string;
  readonly detail: string;

  constructor(channel: string, detail: string) {
    super(`Invalid message on ${channel}: ${detail}`);
    this.name = "ProtocolError";
    this.channel = channel;
    this.detail = detail;
  }
}

/**
 * Validate an INCOMING payload against its channel schema. Returns the
 * typed message or throws {@link ProtocolError} with the channel and the
 * first few validation failures. Handlers must parse before acting — a
 * malformed message causes zero state change.
 */
export function parseMessage<T extends TSchema>(
  channel: string,
  schema: T,
  raw: unknown,
): Static<T> {
  if (Value.Check(schema, raw)) return raw as Static<T>;
  const detail = [...Value.Errors(schema, raw)]
    .slice(0, 3)
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
  throw new ProtocolError(channel, detail || "schema mismatch");
}

// ---------------------------------------------------------------------------
// Handler idempotency
// ---------------------------------------------------------------------------

/**
 * Bounded seen-set over message ids: the first half of the terminal-handler
 * idempotency contract (the second half is the current-phase check the
 * handler applies to its own state). Duplicate, late, and reordered
 * deliveries are all safe: a duplicate id is recognized regardless of
 * arrival order, and distinct ids are never conflated.
 */
export class SeenMessages {
  private readonly ids = new Set<string>();
  private readonly capacity: number;

  constructor(capacity = 4096) {
    this.capacity = capacity;
  }

  /** True if this id was already seen; records it otherwise (bounded FIFO). */
  seen(messageId: string): boolean {
    if (this.ids.has(messageId)) return true;
    this.ids.add(messageId);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return false;
  }
}
