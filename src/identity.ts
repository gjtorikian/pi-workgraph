/**
 * Worker identity: `{user}@{host}/{short-session-id}`, with an optional
 * configured override that always wins.
 *
 * The session-id component is resolved lazily — `ctx` (and therefore
 * `ctx.sessionManager.getSessionId()`) only exists inside tool handlers and
 * event callbacks, never at module load. Until a session id is observed, a
 * module-scope random id minted at load stands in, so `workerId()` is always
 * callable and stable within a process.
 */
import { randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import type { IdentityProvider, LeaseActor } from "./types.ts";
import { newWorkflowRunId } from "./types.ts";

const bootId = randomUUID().replace(/-/g, "").slice(0, 8);

let override: string | undefined;
let sessionId: string | undefined;

/** Set (or clear) the configured identity override. Override always wins. */
export function setWorkerIdOverride(id: string | undefined): void {
  const trimmed = id?.trim();
  override = trimmed ? trimmed : undefined;
}

/** Record the session id once a ctx is available (first tool call / session_start). */
export function noteSessionId(id: string | undefined): void {
  if (id) sessionId = id;
}

/** The identity this worker claims and closes issues as. */
export function workerId(): string {
  if (override) return override;
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER ?? "unknown";
  }
  const host = hostname().split(".")[0] ?? "localhost";
  const shortSession = (sessionId ?? bootId).replace(/-/g, "").slice(0, 8);
  return `${user}@${host}/${shortSession}`;
}

/**
 * The bridge for callers that act as the local session: holder AND bd
 * `--actor` are both this worker's identity. Phase 2's coordinator replaces
 * this with generated `workgraph-run/<id>` holders (initiator stays the
 * bdActor); until then every call site threads this explicitly — the lease
 * layer itself never reads ambient identity.
 */
export function defaultLeaseActor(): LeaseActor {
  const me = workerId();
  return { holder: me, bdActor: me };
}

/**
 * The default {@link IdentityProvider}: the initiator is this session's
 * `workerId()` and workflow-run identities are freshly minted
 * `workgraph-run/<uuid>` holders. The coordinator consumes the interface, so
 * a future harness can substitute scoped identities without touching it.
 */
export function localIdentityProvider(): IdentityProvider {
  return {
    initiator: () => ({ kind: "initiator", id: workerId() }),
    newWorkflowRun: () => ({ kind: "workflow-run", id: newWorkflowRunId() }),
  };
}

/**
 * An immutable snapshot of the acting identity for audit events: audit
 * details are serialized later (and sometimes after further awaits), so the
 * snapshot is frozen at capture time — a mutated actor can never rewrite an
 * already-recorded event's attribution.
 */
export function identitySnapshot(actor: LeaseActor): Readonly<LeaseActor> {
  return Object.freeze({ holder: actor.holder, bdActor: actor.bdActor });
}

/** Test-only: reset module state. */
export function resetIdentityForTest(): void {
  override = undefined;
  sessionId = undefined;
}
