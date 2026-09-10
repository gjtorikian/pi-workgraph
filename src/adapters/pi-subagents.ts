/**
 * The OPTIONAL pi-subagents bridge (spec-phase-5): a config-gated,
 * version-gated translator between the workgraph executor protocol and the
 * pi-subagents slash bridge — communicating EXCLUSIVELY by event names. It
 * imports ZERO pi-subagents code, and this package declares no pi-subagents
 * entry in any dependency block (the CI dep-check enforces it). Upstream
 * event names are not a declared public API, so the adapter ships
 * EXPERIMENTAL and bridges any installed upstream version by default — an
 * explicit `versionRange` config restores strict gating (see below).
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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  SubagentsExecutorConfig,
  SubagentsRoleRoutes,
  WorkgraphConfig,
} from "../config.ts";
import {
  CH,
  newEnvelope,
  parseMessage,
  Discover,
  RunCancel,
  RunRequest,
  SUBAGENTS_PACKAGE_NAME,
  subagentsVersionInRange,
  type ExecutorOfferT,
  type ExecutorRoleT,
  type RunCompletedT,
  type RunOutcomeT,
  type RunRequestT,
} from "../protocol.ts";
import { DEFAULT_WORKFLOW_CLASS, type WorkflowClassT } from "../types.ts";
import { ISSUE_HALT_EVENT, issueHaltNotice } from "../issue-control.ts";
import { workflowWorkspace, type WorkflowWorkspace } from "./workspace.ts";

export const PI_SUBAGENTS_EXECUTOR_ID = "pi-subagents";
export const PI_SUBAGENTS_ADAPTER_VERSION = "0.1.0";

/** Pi's child runtime may inherit ambient extensions. It must not start a
 * second workgraph scheduler while executing a role for its parent. */
export function isPiSubagentProcess(env = process.env): boolean {
  return !!env.PI_SUBAGENT_RUN_ID;
}

/**
 * Upstream event names and shapes re-verified against pi-subagents 0.34.8.
 * EVENT NAMES ONLY — never import from the package;
 * `test/helpers/fake-subagents.ts` fakes this exact surface.
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
 * finalization pass on the implementer's own run. Planner runs use the
 * upstream `planner` profile and structured output. `verifier` is
 * deliberately unmapped (and not offered).
 */
export const ROLE_MAP: Partial<
  Record<ExecutorRoleT, { agent: string; worktree: boolean }>
> = {
  planner: { agent: "planner", worktree: false },
  implementer: { agent: "worker", worktree: true },
  revision: { agent: "worker", worktree: true },
  reviewer: { agent: "reviewer", worktree: false },
  finalizer: { agent: "worker", worktree: false },
};

export const PI_SUBAGENTS_ROLES: ExecutorRoleT[] = [
  "planner",
  "implementer",
  "reviewer",
  "revision",
];

/** Resolve a named upstream profile without coupling the core to model IDs. */
export function resolveSubagentAgent(
  config: SubagentsExecutorConfig,
  workflowClass: WorkflowClassT,
  role: ExecutorRoleT,
): string | undefined {
  return (
    config.routes?.[workflowClass]?.[role as keyof SubagentsRoleRoutes] ??
    ROLE_MAP[role]?.agent
  );
}

/** Accepted runs, including queued work. Upstream foreground calls are serial. */
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
    // not resolvable from here — fall through to the pi package store
  }
  // Pi installs `npm:` packages under `<config dir>/npm/node_modules`, which
  // node resolution from a git-installed extension never visits — probe it
  // directly (PI_CODING_AGENT_DIR is pi's documented config-dir override).
  const agentDir =
    process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const fromStore = read(
    join(
      agentDir,
      "npm",
      "node_modules",
      SUBAGENTS_PACKAGE_NAME,
      "package.json",
    ),
  );
  if (fromStore !== undefined) return fromStore;
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
  workspace?: WorkflowWorkspace;
  requestId: string;
  workflowRunId: string;
  executionId: string;
  issueId: string;
  leaseEpoch: number;
  role: ExecutorRoleT;
  /** messageId of the `run:request` (inReplyTo on accepted/rejected). */
  requestMessageId: string;
  /** Accepted by our queue or by upstream's started event. */
  accepted: boolean;
  /** The request has been forwarded upstream. */
  submitted: boolean;
  params: Record<string, unknown>;
  /** Upstream emitted `started`. */
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
  exitCode?: unknown;
  interrupted?: unknown;
  detached?: unknown;
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
  if (msg.plan) lines.push("", "Accepted implementation plan:", msg.plan);
  if (msg.instructions)
    lines.push("", "Workflow instructions:", msg.instructions);
  if (msg.role === "reviewer") {
    lines.push(
      "",
      "You are an INDEPENDENT reviewer: evaluate the implementation against the acceptance criteria and report your verdict as structured output matching the provided schema.",
    );
    if (Array.isArray(msg.artifacts) && msg.artifacts.length > 0) {
      lines.push(
        "Artifacts under review:",
        ...msg.artifacts.map((a) => `- ${a}`),
      );
    }
  }
  if (msg.role === "planner") {
    lines.push(
      "",
      "Produce a concrete implementation plan as structured output matching the provided schema. Do not modify product code.",
    );
  }
  if (msg.priorFindings !== undefined && msg.priorFindings.length > 0) {
    lines.push(
      "",
      "Prior judgment findings to address:",
      ...msg.priorFindings.map((f) => `- ${f}`),
    );
  }
  if (msg.role === "finalizer") {
    lines.push(
      "",
      "Perform the supplied post-verification task and report its actual outcome using the requested structured output.",
    );
  }
  if (msg.role === "implementer" || msg.role === "revision") {
    lines.push(
      "",
      "Implement and validate the changes. Leave the result in this workspace for independent review and subsequent workflow stages.",
    );
  }
  if (msg.outputSchema !== undefined) {
    lines.push(
      "",
      "Completion contract for this workflow: finish by calling the structured_output tool with { value: <your result> }, where value matches the supplied outputSchema. A Markdown answer or a plan.md file alone does not submit a result. This workflow contract takes precedence over the agent profile's default output format. If validation fails, correct the value and call structured_output again.",
    );
  }
  lines.push(
    "",
    "Helper tooling: use Node.js for ad hoc JSON/JSONL, XML test-report summaries, manifests, transcripts, and file processing. Do not use Python, python3, pyenv, or mise for these helper scripts. Continue to use the repository's own build and test commands.",
    "Run reporting helpers separately from builds/tests and give each helper an explicit 60-second bash timeout. Give builds/tests an appropriate finite timeout. If a helper times out, change the approach rather than repeating it unchanged; replace a stalled Python helper with Node.js.",
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

  // VERSION GATE (opt-in): no handshake exists upstream (PR candidate #1),
  // so probe the installed package. Default: any installed version bridges.
  // An explicit `versionRange` restores strict gating; a missing package
  // (no probe result) always refuses — warn ONCE, register NOTHING.
  const probe = deps.probeVersion ?? defaultProbeVersion;
  const version = probe();
  const range = configured.versionRange;
  if (
    version === undefined ||
    (range !== undefined && !subagentsVersionInRange(version, range))
  ) {
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
  const haltedEpochs = new Map<string, number>();
  unsubs.push(
    pi.events.on(ISSUE_HALT_EVENT, (value) => {
      const notice = issueHaltNotice(value);
      if (!notice) return;
      haltedEpochs.set(
        notice.issueId,
        Math.max(haltedEpochs.get(notice.issueId) ?? 0, notice.leaseEpoch),
      );
      for (const run of runs.values()) {
        if (
          run.issueId === notice.issueId &&
          run.leaseEpoch <= notice.leaseEpoch
        )
          notice.workflowRunIds.push(run.workflowRunId);
      }
    }),
  );

  function accept(run: BridgedRun): void {
    if (run.accepted) return;
    run.accepted = true;
    pi.events.emit(CH.runAccepted, {
      ...newEnvelope(nowFn),
      inReplyTo: run.requestMessageId,
      workflowRunId: run.workflowRunId,
      executionId: run.executionId,
      issueId: run.issueId,
      leaseEpoch: run.leaseEpoch,
      executorId: PI_SUBAGENTS_EXECUTOR_ID,
      executionState: run.submitted ? "starting" : "queued",
      ...(!run.submitted
        ? {
            queuePosition:
              [...runs.values()]
                .filter((entry) => !entry.submitted)
                .indexOf(run) + 1,
          }
        : {}),
    });
  }

  function reportState(
    run: BridgedRun,
    executionState: "queued" | "starting",
    queuePosition?: number,
  ): void {
    pi.events.emit(CH.runProgress, {
      ...newEnvelope(nowFn),
      workflowRunId: run.workflowRunId,
      executionId: run.executionId,
      issueId: run.issueId,
      leaseEpoch: run.leaseEpoch,
      role: run.role,
      executionState,
      ...(queuePosition ? { queuePosition } : {}),
      note:
        executionState === "queued"
          ? "Waiting for an executor slot"
          : "Executor launching worker",
    });
  }

  function reportQueue(): void {
    let position = 0;
    for (const run of runs.values()) {
      if (!run.submitted) reportState(run, "queued", ++position);
    }
  }

  // pi-subagents rejects overlapping foreground calls, even though its slash
  // bridge emits started before checking that lock. Own queued requests so
  // they can be accepted within the protocol deadline and cancelled locally.
  function launchNext(): void {
    if ([...runs.values()].some((run) => run.submitted)) {
      reportQueue();
      return;
    }
    const run = runs.values().next().value as BridgedRun | undefined;
    if (!run) return;
    run.submitted = true;
    if (run.accepted) reportState(run, "starting");
    reportQueue();
    pi.events.emit(UPSTREAM_EVENTS.request, {
      requestId: run.requestId,
      params: run.params,
    });
  }

  function findByWorkflowRun(
    workflowRunId: string,
    executionId?: string,
  ): BridgedRun | undefined {
    for (const run of runs.values()) {
      if (run.workflowRunId !== workflowRunId) continue;
      if (executionId !== undefined && run.executionId !== executionId)
        continue;
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
    const childError =
      typeof first?.error === "string" ? first.error : undefined;
    const outcome: RunOutcomeT =
      payload.isError !== true &&
      first?.exitCode === 0 &&
      first.interrupted !== true &&
      first.detached !== true &&
      !first.error
        ? "success"
        : "failure";
    const evidence: string[] = [];
    if (!first) evidence.push("upstream returned no completed child result");
    else if (outcome !== "success") {
      evidence.push(
        `upstream child did not complete successfully (exitCode: ${String(first.exitCode)})`,
      );
      if (typeof first.error === "string") evidence.push(first.error);
    }
    if (
      typeof first?.finalOutput === "string" &&
      first.finalOutput.length > 0
    ) {
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
    if (run.workspace) artifacts.push(run.workspace.path);
    const artifactPaths = first?.artifactPaths;
    if (artifactPaths !== null && typeof artifactPaths === "object") {
      for (const value of Object.values(
        artifactPaths as Record<string, unknown>,
      )) {
        if (typeof value === "string" && value.length > 0)
          artifacts.push(value);
      }
    }
    // REPORTED provenance: the effective model, without Pi's thinking suffix.
    // A thinking-level change does not make the same model independent.
    // provider split only from the unambiguous "provider/id" shape.
    const model =
      typeof first?.model === "string"
        ? first.model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")
        : undefined;
    const provider = model !== undefined ? splitProvider(model) : undefined;
    // The verdict rides ONLY a reviewer run's structured output (non-strict
    // schemas tolerate the extra field — the phase-3 transport). Missing or
    // malformed structured output is emitted as-is: the coordinator's
    // verdict-invalid path is the handler; the bridge never synthesizes.
    const verdict =
      run.role === "reviewer" && first?.structuredOutput !== undefined
        ? first.structuredOutput
        : undefined;
    const plan =
      run.role === "planner" && first?.structuredOutput !== undefined
        ? first.structuredOutput
        : undefined;
    const completed: RunCompletedT & {
      verdict?: unknown;
      plan?: unknown;
      finalization?: unknown;
      workspace?: WorkflowWorkspace;
    } = {
      ...newEnvelope(nowFn),
      workflowRunId: run.workflowRunId,
      executionId: run.executionId,
      issueId: run.issueId,
      leaseEpoch: run.leaseEpoch,
      outcome,
      artifacts,
      evidence,
      ...(!first || childError
        ? {
            executionError:
              childError ||
              payload.errorText ||
              "upstream returned no completed child result",
          }
        : {}),
      provenance: {
        harness: "pi-subagents",
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider } : {}),
      },
      ...(verdict !== undefined ? { verdict } : {}),
      ...(plan !== undefined ? { plan } : {}),
      ...(run.role === "finalizer"
        ? { finalization: first?.structuredOutput }
        : {}),
      ...(run.workspace ? { workspace: run.workspace } : {}),
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
        roles: deps.getConfig().finalization
          ? [...PI_SUBAGENTS_ROLES, "finalizer"]
          : [...PI_SUBAGENTS_ROLES],
        harness: "pi-subagents",
        isolation: "worktree",
        supportsCancellation: true,
        supportsReconciliation: false,
        profileSemantics: "named",
        maxConcurrency: PI_SUBAGENTS_MAX_CONCURRENCY,
        available: runs.size < PI_SUBAGENTS_MAX_CONCURRENCY,
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

      if (msg.leaseEpoch <= (haltedEpochs.get(msg.issue.id) ?? -1)) {
        reject("Issue halted by the user");
        return;
      }

      const mapping = ROLE_MAP[msg.role];
      if (msg.role === "finalizer" && !deps.getConfig().finalization) {
        reject("finalization is disabled");
        return;
      }
      const requestedWorkflowClass = msg.issue.workflowClass;
      const workflowClass: WorkflowClassT =
        requestedWorkflowClass === "oneshot" ||
        requestedWorkflowClass === "reviewed" ||
        requestedWorkflowClass === "planned"
          ? requestedWorkflowClass
          : DEFAULT_WORKFLOW_CLASS;
      const agent = resolveSubagentAgent(configured, workflowClass, msg.role);
      if (!mapping || !agent) {
        reject(`unsupported role: ${msg.role}`);
        return;
      }
      if (runs.size >= PI_SUBAGENTS_MAX_CONCURRENCY) {
        reject("at-capacity");
        return;
      }

      let workspace: WorkflowWorkspace | undefined;
      if (deps.getConfig().finalization && msg.role !== "planner") {
        try {
          if (!msg.workspace.repoPath)
            throw new Error("workflow request is missing its repository path");
          workspace = workflowWorkspace(
            msg.workspace.repoPath,
            msg.workspace.sourceWorkflowRunId ?? msg.workflowRunId,
            msg.issue.id,
            msg.role === "implementer",
          );
        } catch (error) {
          reject(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      const roleOptions =
        configured.options?.[msg.role as keyof SubagentsRoleRoutes];
      if (roleOptions?.thinking && !roleOptions.model) {
        reject("a thinking override requires an explicit model");
        return;
      }
      const model =
        roleOptions?.model && roleOptions.thinking
          ? `${roleOptions.model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")}:${roleOptions.thinking}`
          : roleOptions?.model;
      const run: BridgedRun = {
        requestId: crypto.randomUUID(),
        workflowRunId: msg.workflowRunId,
        executionId: crypto.randomUUID(),
        issueId: msg.issue.id,
        leaseEpoch: msg.leaseEpoch,
        role: msg.role,
        requestMessageId: msg.messageId,
        accepted: false,
        submitted: false,
        started: false,
        cancelPending: false,
        ...(workspace ? { workspace } : {}),
        params: {
          agent,
          // The slash response must contain the finished child result. Pi's
          // default background mode returns a launch receipt immediately.
          async: false,
          foregroundOnly: true,
          task: buildSubagentTask(
            msg as RunRequestT & { artifacts?: string[] },
          ),
          worktree: workspace ? false : mapping.worktree,
          ...(workspace ? { cwd: workspace.path } : {}),
          ...(model ? { model } : {}),
          ...(roleOptions?.skills ? { skill: roleOptions.skills } : {}),
          ...(msg.role === "finalizer"
            ? {
                timeoutMs:
                  deps.getConfig().finalization?.timeoutMs ?? 3_600_000,
              }
            : {}),
          context: "fresh",
          ...(msg.outputSchema !== undefined
            ? { outputSchema: msg.outputSchema }
            : {}),
        },
      };
      runs.set(run.requestId, run);
      // A queued acceptance reserves an execution owned by this adapter;
      // it does not claim that an upstream child has already started.
      if (runs.size > 1) {
        accept(run);
        reportQueue();
      }
      launchNext();
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
      accept(run);
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
        progress?: Array<{ model?: unknown; recentOutput?: unknown }>;
      };
      if (typeof payload.requestId !== "string") return;
      const run = runs.get(payload.requestId);
      if (!run || !run.started) return;
      const progress = Array.isArray(payload.progress)
        ? payload.progress[0]
        : undefined;
      const model =
        typeof progress?.model === "string"
          ? progress.model.replace(
              /:(off|minimal|low|medium|high|xhigh|max)$/,
              "",
            )
          : undefined;
      // Upstream exposes visible assistant/tool output here, never thinking.
      // Bound this advisory snapshot; consumers choose what to display.
      const output = Array.isArray(progress?.recentOutput)
        ? progress.recentOutput
            .filter((line): line is string => typeof line === "string")
            .slice(-10)
            .map((line) => line.slice(0, 500))
        : undefined;
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
        executionState: "working",
        role: run.role,
        ...(model ? { model } : {}),
        ...(output?.length ? { output } : {}),
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
      if (!run || !run.submitted) return; // not an upstream execution
      const details = (
        payload.result as
          { details?: { asyncId?: unknown; results?: unknown[] } } | undefined
      )?.details;
      if (
        payload.isError !== true &&
        typeof details?.asyncId === "string" &&
        details.results?.length === 0
      ) {
        // Unexpected background handoff is nonterminal. Keep ownership until
        // a terminal response or an acknowledged cancellation, never judge it.
        warnOnce(
          "[pi-workgraph] upstream returned a background launch receipt despite foregroundOnly; run remains pending",
        );
        return;
      }
      runs.delete(run.requestId);
      // Finish emitting this result before starting the next upstream call.
      queueMicrotask(launchNext);

      if (payload.result === null || typeof payload.result !== "object") {
        // Shape drift from the harvest: the version gate is the primary
        // guard; this is the secondary net (spec error-handling row).
        warnOnce(
          `[pi-workgraph] pi-subagents response payload failed validation (requestId ${run.requestId}) — upstream shape drift?`,
        );
        if (!run.accepted) {
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
          errorText:
            "upstream response payload failed validation (shape drift)",
        });
        return;
      }

      const response = payload as UpstreamResponse;
      if (!run.accepted) {
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
            typeof response.errorText === "string" &&
            response.errorText.length > 0
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
        if (!run.submitted) {
          runs.delete(run.requestId);
          emitCancelled(run);
          launchNext();
          return;
        }
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
