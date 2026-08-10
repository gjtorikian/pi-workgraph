/**
 * The OPTIONAL pi-subagents bridge (spec-phase-5): a config-gated,
 * version-gated translator between the workgraph executor protocol and the
 * pi-subagents slash bridge — communicating EXCLUSIVELY by event names. It
 * imports ZERO pi-subagents code, and this package declares no pi-subagents
 * entry in any dependency block (the CI dep-check enforces it). Upstream
 * event names are not a declared public API, so the adapter ships
 * EXPERIMENTAL and refuses to bridge when the installed upstream version
 * falls outside the harvested range (see the version gate below).
 *
 * Two contract rules this module owns:
 *  - UNCONFIGURED = NOT REGISTERED. index.ts never calls
 *    {@link registerPiSubagentsExecutor} when `subagentsExecutor` is
 *    absent/disabled, AND this function re-checks the config itself before
 *    subscribing to anything — an unconfigured extension answers discovery
 *    with no subagents offer and leaves ZERO subscription side effects.
 *  - SELF-ACCEPTANCE IS NEVER JUDGMENT (invariant 6). An upstream
 *    `acceptance` ledger on a response is parent-controlled self-review —
 *    upstream's own guidelines say so verbatim ("acceptance … is not
 *    independent review", extension/index.ts:397-398 @ 3fc6b6b). The bridge
 *    maps it to implementation-completion evidence at most; a reviewer
 *    verdict is emitted ONLY from a separately launched reviewer run's
 *    structured output.
 *
 * UPSTREAM-PR CANDIDATES (recorded, not acted on — spec rollout row):
 *  1. A version/capabilities handshake event. Upstream advertises no
 *     version anywhere on its bus (verified @ 3fc6b6b — the intercom
 *     identity response carries only a sessionId), so the gate below must
 *     probe the installed package.json instead of validating an advertised
 *     version.
 *  2. Adopting the generic workgraph protocol upstream (the refactor plan's
 *     standing proposal) so this bridge becomes a thin rename layer.
 *  3. Explicit provider + model provenance on responses:
 *     `SingleResult.model` is a bare string and `modelAttempts` proves the
 *     effective model can differ from the requested one — see
 *     {@link splitProvider}.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { WorkgraphConfig } from "../config.ts";
import {
  CH,
  newEnvelope,
  parseMessage,
  Discover,
  RunCancel,
  RunRequest,
  SUBAGENTS_PACKAGE_NAME,
  SUBAGENTS_SUPPORTED_VERSION_RANGE,
  subagentsVersionInRange,
  type ExecutorOfferT,
  type ExecutorRoleT,
  type RunCompletedT,
  type RunOutcomeT,
  type RunRequestT,
} from "../protocol.ts";

export const PI_SUBAGENTS_EXECUTOR_ID = "pi-subagents";
export const PI_SUBAGENTS_ADAPTER_VERSION = "0.1.0";

/**
 * Harvested upstream event names — pi-subagents @ commit 3fc6b6b (package
 * version 0.32.0): constants at src/shared/types.ts:1011-1015, payload
 * shapes and semantics at src/slash/slash-bridge.ts. EVENT NAMES ONLY —
 * never import from the package; `test/helpers/fake-subagents.ts` fakes
 * this exact surface and cites the same commit.
 */
export const UPSTREAM_EVENTS = {
  /** `{requestId, params}` → runs `executor.execute` (slash-bridge.ts:74-158). */
  request: "subagent:slash:request",
  /** `{requestId}` — emitted after the cancel-pending check (slash-bridge.ts:114). */
  started: "subagent:slash:started",
  /** `{requestId, progress?, currentTool?, toolCount?}` (slash-bridge.ts:124-130). */
  update: "subagent:slash:update",
  /** `{requestId, result, isError, errorText?}` (slash-bridge.ts:135-154). */
  response: "subagent:slash:response",
  /**
   * `{requestId}` — aborts an in-flight run; an UNKNOWN requestId parks in
   * `pendingCancels` and is never acknowledged (slash-bridge.ts:62-72),
   * which is why the bridge answers unknown-run cancels itself.
   */
  cancel: "subagent:slash:cancel",
} as const;

/**
 * Explicit role mapping (spec key decision). Upstream launches are named
 * agent profiles (`profileSemantics: "named"`); implementer/revision runs
 * request a worktree-isolated fresh worker; reviewer runs are SEPARATE
 * fresh launches carrying the structured-verdict output schema — never a
 * finalization pass on the implementer's own run. `verifier` is
 * deliberately unmapped (and not offered).
 */
export const ROLE_MAP: Partial<
  Record<ExecutorRoleT, { agent: string; worktree: boolean }>
> = {
  implementer: { agent: "worker", worktree: true },
  revision: { agent: "worker", worktree: true },
  reviewer: { agent: "reviewer", worktree: false },
};

export const PI_SUBAGENTS_ROLES: ExecutorRoleT[] = [
  "implementer",
  "reviewer",
  "revision",
];

/** Advertised and enforced concurrent-run cap (a scheduling hint). */
export const PI_SUBAGENTS_MAX_CONCURRENCY = 4;

/**
 * Deliberately above in-session's implicit 0: an operator who opted into
 * the subagents executor prefers isolated background workers over the chat
 * session for implementer selection (the two-executor determinism test
 * pins this choice).
 */
export const PI_SUBAGENTS_PRIORITY = 10;

export interface PiSubagentsDeps {
  /** Effective config; resolved lazily (flags are not readable at load). */
  getConfig: () => WorkgraphConfig;
  /** Clock injection for tests (default Date.now). */
  now?: () => number;
  /**
   * Probe the INSTALLED upstream package version WITHOUT importing any of
   * its code — the default reads pi-subagents/package.json off the
   * filesystem (resolved from this module, then walking node_modules up
   * from the working directory). Injectable so tests fake versions.
   */
  probeVersion?: () => string | undefined;
  /** Warning sink (default console.error). */
  warn?: (message: string) => void;
}

/** Handle returned by {@link registerPiSubagentsExecutor}. */
export interface PiSubagentsController {
  /** True when the bridge actually registered (configured + version-gated). */
  active(): boolean;
  /** Number of live bridged runs (tests). */
  activeRunCount(): number;
  /** Unsubscribe every event-bus handler (tests). */
  teardown(): void;
}

/**
 * Default version probe: a package.json READ, not an import — the smoke
 * test's "probe, not import" rule blesses exactly this mechanism.
 */
export function defaultProbeVersion(): string | undefined {
  const read = (path: string): string | undefined => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const version = (parsed as { version?: unknown } | null)?.version;
      return typeof version === "string" ? version : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve(`${SUBAGENTS_PACKAGE_NAME}/package.json`);
    const version = read(resolved);
    if (version !== undefined) return version;
  } catch {
    // not resolvable from here — fall through to the node_modules walk
  }
  let dir = process.cwd();
  for (;;) {
    const version = read(
      join(dir, "node_modules", SUBAGENTS_PACKAGE_NAME, "package.json"),
    );
    if (version !== undefined) return version;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** One bridged run: the requestId ↔ executionId mapping is OURS — upstream
 *  slash events carry no executionId, so the bridge mints one and keeps the
 *  correlation for update/response/cancel routing. */
interface BridgedRun {
  requestId: string;
  workflowRunId: string;
  executionId: string;
  issueId: string;
  leaseEpoch: number;
  role: ExecutorRoleT;
  /** messageId of the `run:request` (inReplyTo on accepted/rejected). */
  requestMessageId: string;
  /** Upstream emitted `started` — the run was accepted. */
  started: boolean;
  /** A workgraph `run:cancel` was forwarded upstream: the post-cancel
   *  response maps to `run:cancelled`, never to a failed completion —
   *  upstream reports cancellation as an error RESPONSE, not a distinct
   *  event (slash-bridge.ts:100-111 and the AbortSignal path). */
  cancelPending: boolean;
}

/** Minimal structural view of an upstream response (never imported). */
interface UpstreamResponse {
  requestId: string;
  result?: unknown;
  isError?: boolean;
  errorText?: string;
}

/** The slices of upstream's SingleResult the bridge reads (types.ts:388-422). */
interface UpstreamSingleResult {
  model?: unknown;
  structuredOutput?: unknown;
  finalOutput?: unknown;
  error?: unknown;
  acceptance?: unknown;
  artifactPaths?: unknown;
}

function firstResult(result: unknown): UpstreamSingleResult | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (details === null || typeof details !== "object") return undefined;
  const results = (details as { results?: unknown }).results;
  if (!Array.isArray(results)) return undefined;
  const first: unknown = results[0];
  if (first === null || typeof first !== "object") return undefined;
  return first as UpstreamSingleResult;
}

/**
 * Split a provider off a reported model string ONLY when the format is
 * unambiguous — the modelOverride "provider/id" shape with exactly one
 * slash. The model itself is always reported VERBATIM (what upstream
 * REPORTED, never what was requested); anything else leaves `provider`
 * unset (both fields are optional in `RunCompleted.provenance`).
 */
export function splitProvider(model: string): string | undefined {
  const idx = model.indexOf("/");
  if (idx <= 0) return undefined;
  if (model.indexOf("/", idx + 1) !== -1) return undefined;
  const provider = model.slice(0, idx);
  return /\s/.test(provider) ? undefined : provider;
}

/** The task prompt an upstream agent receives for a bridged run. */
export function buildSubagentTask(
  msg: RunRequestT & { artifacts?: string[] },
): string {
  const lines = [
    `[workgraph ${msg.role}] Issue ${msg.issue.id}: "${msg.issue.title}" (workflow run ${msg.workflowRunId}, attempt ${msg.attempt}).`,
  ];
  if (msg.issue.description) lines.push("", msg.issue.description);
  if (msg.issue.acceptanceCriteria) {
    lines.push("", `Acceptance criteria: ${msg.issue.acceptanceCriteria}`);
  }
  if (msg.role === "reviewer") {
    lines.push(
      "",
      "You are an INDEPENDENT reviewer: evaluate the implementation against the acceptance criteria and report your verdict as structured output matching the provided schema.",
    );
    if (Array.isArray(msg.artifacts) && msg.artifacts.length > 0) {
      lines.push("Artifacts under review:", ...msg.artifacts.map((a) => `- ${a}`));
    }
  }
  if (msg.priorFindings !== undefined && msg.priorFindings.length > 0) {
    lines.push(
      "",
      "Prior judgment findings to address:",
      ...msg.priorFindings.map((f) => `- ${f}`),
    );
  }
  lines.push(
    "",
    "Do not close or release the issue yourself — the workgraph coordinator records your result and its judgment gate decides what it means.",
  );
  return lines.join("\n");
}

export function registerPiSubagentsExecutor(
  pi: ExtensionAPI,
  deps: PiSubagentsDeps,
): PiSubagentsController {
  const nowFn = deps.now ?? Date.now;
  const warnSink = deps.warn ?? ((message: string) => console.error(message));
  const warned = new Set<string>();
  function warnOnce(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    warnSink(message);
  }

  const inert: PiSubagentsController = {
    active: () => false,
    activeRunCount: () => 0,
    teardown: () => {},
  };

  // DOUBLE GATE, inner half: index.ts only calls this when configured, and
  // the function re-checks BEFORE any `events.on` — an unconfigured bridge
  // must leave zero subscription side effects (stricter than the in-session
  // gate-per-event pattern; the contract test asserts both halves).
  const configured = deps.getConfig().subagentsExecutor;
  if (configured?.enabled !== true) return inert;

  // VERSION GATE: no handshake exists upstream (PR candidate #1), so probe
  // the installed package. No probe result or an out-of-range version →
  // warn ONCE, register NOTHING.
  const probe = deps.probeVersion ?? defaultProbeVersion;
  const version = probe();
  const range = configured.versionRange ?? SUBAGENTS_SUPPORTED_VERSION_RANGE;
  if (version === undefined || !subagentsVersionInRange(version, range)) {
    warnOnce(
      `[pi-workgraph] pi-subagents bridge disabled: ${
        version === undefined
          ? `no installed ${SUBAGENTS_PACKAGE_NAME} package found (version probe)`
          : `installed version ${version} is outside the supported range ${range}.x`
      } — registering nothing`,
    );
    return inert;
  }

  /** Live bridged runs by upstream requestId. */
  const runs = new Map<string, BridgedRun>();
  const unsubs: (() => void)[] = [];

  function findByWorkflowRun(
    workflowRunId: string,
    executionId?: string,
  ): BridgedRun | undefined {
    for (const run of runs.values()) {
      if (run.workflowRunId !== workflowRunId) continue;
      if (executionId !== undefined && run.executionId !== executionId) continue;
      return run;
    }
    return undefined;
  }

  function emitCancelled(run: BridgedRun): void {
    pi.events.emit(CH.runCancelled, {
      ...newEnvelope(nowFn),
      workflowRunId: run.workflowRunId,
      issueId: run.issueId,
      executionId: run.executionId,
    });
  }

  /** Build the fenced `run:completed` from an upstream response. */
  function emitCompleted(run: BridgedRun, payload: UpstreamResponse): void {
    const first = firstResult(payload.result);
    const outcome: RunOutcomeT = payload.isError === true ? "failure" : "success";
    const evidence: string[] = [];
    if (typeof first?.finalOutput === "string" && first.finalOutput.length > 0) {
      const text = first.finalOutput;
      evidence.push(text.length > 500 ? `${text.slice(0, 500)}…` : text);
    }
    if (typeof payload.errorText === "string" && payload.errorText.length > 0) {
      evidence.push(`upstream error: ${payload.errorText}`);
    }
    // Invariant 6: an acceptance ledger is parent-controlled SELF-review —
    // implementation-completion evidence at most, NEVER a verdict.
    const acceptance = first?.acceptance;
    if (acceptance !== null && typeof acceptance === "object") {
      const status = (acceptance as { status?: unknown }).status;
      evidence.push(
        `upstream self-acceptance ledger (status: ${
          typeof status === "string" ? status : "unknown"
        }) — parent-controlled self-review, not independent judgment`,
      );
    }
    const artifacts: string[] = [];
    const artifactPaths = first?.artifactPaths;
    if (artifactPaths !== null && typeof artifactPaths === "object") {
      for (const value of Object.values(artifactPaths as Record<string, unknown>)) {
        if (typeof value === "string" && value.length > 0) artifacts.push(value);
      }
    }
    // REPORTED provenance: results[0].model verbatim (never the request's),
    // provider split only from the unambiguous "provider/id" shape.
    const model = typeof first?.model === "string" ? first.model : undefined;
    const provider = model !== undefined ? splitProvider(model) : undefined;
    // The verdict rides ONLY a reviewer run's structured output (non-strict
    // schemas tolerate the extra field — the phase-3 transport). Missing or
    // malformed structured output is emitted as-is: the coordinator's
    // verdict-invalid path is the handler; the bridge never synthesizes.
    const verdict =
      run.role === "reviewer" && first?.structuredOutput !== undefined
        ? first.structuredOutput
        : undefined;
    const completed: RunCompletedT & { verdict?: unknown } = {
      ...newEnvelope(nowFn),
      workflowRunId: run.workflowRunId,
      executionId: run.executionId,
      issueId: run.issueId,
      leaseEpoch: run.leaseEpoch,
      outcome,
      artifacts,
      evidence,
      provenance: {
        harness: "pi-subagents",
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider } : {}),
      },
      ...(verdict !== undefined ? { verdict } : {}),
    };
    pi.events.emit(CH.runCompleted, completed);
  }

  // ---- discovery ----
  unsubs.push(
    pi.events.on(CH.discover, (data) => {
      let msg;
      try {
        msg = parseMessage(CH.discover, Discover, data);
      } catch {
        return; // malformed discovery — no state change
      }
      const offer: ExecutorOfferT = {
        ...newEnvelope(nowFn),
        inReplyTo: msg.messageId,
        executorId: PI_SUBAGENTS_EXECUTOR_ID,
        adapterVersion: PI_SUBAGENTS_ADAPTER_VERSION,
        roles: [...PI_SUBAGENTS_ROLES],
        harness: "pi-subagents",
        isolation: "worktree",
        supportsCancellation: true,
        supportsReconciliation: false,
        profileSemantics: "named",
        maxConcurrency: PI_SUBAGENTS_MAX_CONCURRENCY,
        available: true,
        priority: PI_SUBAGENTS_PRIORITY,
      };
      pi.events.emit(CH.offer, offer);
    }),
  );

  // ---- run requests addressed to this executor ----
  unsubs.push(
    pi.events.on(CH.runRequest, (data) => {
      let msg: RunRequestT;
      try {
        msg = parseMessage(CH.runRequest, RunRequest, data);
      } catch {
        return;
      }
      if (msg.executorId !== PI_SUBAGENTS_EXECUTOR_ID) return; // not for us

      const reject = (reason: string): void => {
        pi.events.emit(CH.runRejected, {
          ...newEnvelope(nowFn),
          inReplyTo: msg.messageId,
          workflowRunId: msg.workflowRunId,
          issueId: msg.issue.id,
          leaseEpoch: msg.leaseEpoch,
          executorId: PI_SUBAGENTS_EXECUTOR_ID,
          reason,
        });
      };

      const mapping = ROLE_MAP[msg.role];
      if (!mapping) {
        reject(`unsupported role: ${msg.role}`);
        return;
      }
      if (runs.size >= PI_SUBAGENTS_MAX_CONCURRENCY) {
        reject("at-capacity");
        return;
      }

      const run: BridgedRun = {
        requestId: crypto.randomUUID(),
        workflowRunId: msg.workflowRunId,
        executionId: crypto.randomUUID(),
        issueId: msg.issue.id,
        leaseEpoch: msg.leaseEpoch,
        role: msg.role,
        requestMessageId: msg.messageId,
        started: false,
        cancelPending: false,
      };
      runs.set(run.requestId, run);

      // The bridged launch: a FRESH context per run (a reviewer run is a
      // separate launch by construction, never a continuation of the
      // implementer's session — invariant 6's structural half).
      pi.events.emit(UPSTREAM_EVENTS.request, {
        requestId: run.requestId,
        params: {
          agent: mapping.agent,
          task: buildSubagentTask(msg as RunRequestT & { artifacts?: string[] }),
          worktree: mapping.worktree,
          context: "fresh",
          ...(msg.outputSchema !== undefined
            ? { outputSchema: msg.outputSchema }
            : {}),
        },
      });
      // `run:accepted` waits for upstream's `started` — accepting before
      // upstream confirmed would report a run that may never exist.
    }),
  );

  // ---- upstream: started → run:accepted ----
  unsubs.push(
    pi.events.on(UPSTREAM_EVENTS.started, (data) => {
      if (data === null || typeof data !== "object") return;
      const requestId = (data as { requestId?: unknown }).requestId;
      if (typeof requestId !== "string") return;
      const run = runs.get(requestId);
      if (!run || run.started) return;
      run.started = true;
      pi.events.emit(CH.runAccepted, {
        ...newEnvelope(nowFn),
        inReplyTo: run.requestMessageId,
        workflowRunId: run.workflowRunId,
        executionId: run.executionId,
        issueId: run.issueId,
        leaseEpoch: run.leaseEpoch,
        executorId: PI_SUBAGENTS_EXECUTOR_ID,
      });
    }),
  );

  // ---- upstream: update → run:progress (advisory, fire-and-forget) ----
  unsubs.push(
    pi.events.on(UPSTREAM_EVENTS.update, (data) => {
      if (data === null || typeof data !== "object") return;
      const payload = data as {
        requestId?: unknown;
        currentTool?: unknown;
        toolCount?: unknown;
      };
      if (typeof payload.requestId !== "string") return;
      const run = runs.get(payload.requestId);
      if (!run || !run.started) return;
      const note =
        typeof payload.currentTool === "string"
          ? `tool: ${payload.currentTool}${
              typeof payload.toolCount === "number"
                ? ` (${payload.toolCount} calls)`
                : ""
            }`
          : "progress";
      pi.events.emit(CH.runProgress, {
        ...newEnvelope(nowFn),
        workflowRunId: run.workflowRunId,
        executionId: run.executionId,
        issueId: run.issueId,
        leaseEpoch: run.leaseEpoch,
        note,
      });
    }),
  );

  // ---- upstream: response → run:completed | run:cancelled | run:rejected ----
  unsubs.push(
    pi.events.on(UPSTREAM_EVENTS.response, (data) => {
      if (data === null || typeof data !== "object") return;
      const payload = data as Partial<UpstreamResponse>;
      if (typeof payload.requestId !== "string") return;
      const run = runs.get(payload.requestId);
      if (!run) return; // not one of ours (or already finished) — silence
      runs.delete(run.requestId);

      if (payload.result === null || typeof payload.result !== "object") {
        // Shape drift from the harvest: the version gate is the primary
        // guard; this is the secondary net (spec error-handling row).
        warnOnce(
          `[pi-workgraph] pi-subagents response payload failed validation (requestId ${run.requestId}) — upstream shape drift?`,
        );
        if (!run.started) {
          pi.events.emit(CH.runRejected, {
            ...newEnvelope(nowFn),
            inReplyTo: run.requestMessageId,
            workflowRunId: run.workflowRunId,
            issueId: run.issueId,
            leaseEpoch: run.leaseEpoch,
            executorId: PI_SUBAGENTS_EXECUTOR_ID,
            reason: "upstream-shape-drift",
          });
          return;
        }
        if (run.cancelPending) {
          emitCancelled(run);
          return;
        }
        emitCompleted(run, {
          requestId: run.requestId,
          result: { details: { results: [] } },
          isError: true,
          errorText: "upstream response payload failed validation (shape drift)",
        });
        return;
      }

      const response = payload as UpstreamResponse;
      if (!run.started) {
        // Never accepted (no upstream context, cancelled-before-start, …):
        // the coordinator is still inside its bounded accept window — this
        // is a REJECTION, never a completion.
        if (run.cancelPending) {
          emitCancelled(run);
          return;
        }
        pi.events.emit(CH.runRejected, {
          ...newEnvelope(nowFn),
          inReplyTo: run.requestMessageId,
          workflowRunId: run.workflowRunId,
          issueId: run.issueId,
          leaseEpoch: run.leaseEpoch,
          executorId: PI_SUBAGENTS_EXECUTOR_ID,
          reason:
            typeof response.errorText === "string" && response.errorText.length > 0
              ? `upstream: ${response.errorText}`
              : "upstream error before start",
        });
        return;
      }
      if (run.cancelPending) {
        // Upstream reports an aborted run as an error RESPONSE, not a
        // distinct event — the post-cancel response IS the ack.
        emitCancelled(run);
        return;
      }
      emitCompleted(run, response);
    }),
  );

  // ---- workgraph: run:cancel → upstream cancel (or a no-op ack) ----
  unsubs.push(
    pi.events.on(CH.runCancel, (data) => {
      let msg;
      try {
        msg = parseMessage(CH.runCancel, RunCancel, data);
      } catch {
        return;
      }
      const run = findByWorkflowRun(msg.workflowRunId, msg.executionId);
      if (run) {
        run.cancelPending = true;
        pi.events.emit(UPSTREAM_EVENTS.cancel, { requestId: run.requestId });
        return; // the ack follows upstream's post-cancel response
      }
      // Unknown/finished run: upstream parks unknown requestIds in
      // pendingCancels and NEVER acks them (slash-bridge.ts:62-72) — the
      // no-op-ack contract is satisfied by the BRIDGE answering directly.
      pi.events.emit(CH.runCancelled, {
        ...newEnvelope(nowFn),
        workflowRunId: msg.workflowRunId,
        issueId: msg.issueId,
        ...(msg.executionId !== undefined
          ? { executionId: msg.executionId }
          : {}),
      });
    }),
  );

  return {
    active: () => true,
    activeRunCount: () => runs.size,
    teardown: () => {
      for (const off of unsubs) off();
      unsubs.length = 0;
      runs.clear();
    },
  };
}
