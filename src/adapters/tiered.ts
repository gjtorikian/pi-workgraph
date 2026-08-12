/**
 * The tiered executor: ONE MODEL PER ROLE, each run a fresh `pi` process.
 *
 * This is the adapter the planner tier exists for. The coordinator selects
 * by role and validates reported provenance; it deliberately does no model
 * routing (`src/policy.ts`: "model routing and credentials stay OUTSIDE
 * it"). Routing lives here, and nowhere else in this package.
 *
 * The mechanism is pi's own subagent invocation, verified against the
 * version-matched example that ships with the coding agent:
 *
 *     pi --mode json -p --no-session --model <id> [--tools …] "Task: …"
 *
 * stdout is NDJSON; `{type: "message_end", message: {...}}` events carry the
 * assistant turns, and `message.model` reports the model the run ACTUALLY
 * used. That reported value — never the requested one — becomes
 * `provenance.model`, which is what the judgment gate's
 * `requireAuthorIndependence` check reads. A silent provider-side model
 * substitution therefore shows up as a failed independence check rather
 * than as fake tiering.
 *
 * THE SAFETY PROPERTY: a role with no configured model is NOT OFFERED.
 * Falling back to the ambient default would produce untiered work that
 * still reports success — indistinguishable from the tiering the operator
 * asked for, which is the whole failure this adapter exists to prevent.
 * `selectExecutor` filters on advertised roles, so not offering is
 * sufficient; the coordinator simply looks elsewhere (and for the planner
 * role, skips the tier entirely).
 *
 * ISOLATION IS `"none"`, HONESTLY. Runs execute in the session's cwd; this
 * adapter creates no worktrees. Advertising `"worktree"` without creating
 * one would be a lie the coordinator relies on when it filters offers for
 * isolation-requiring requests. Worktree isolation is a follow-up, and it
 * is the reason `maxConcurrency` defaults to a cautious 2: concurrent
 * mutating runs in ONE tree can interleave writes.
 *
 * STRUCTURED OUTPUT rides the prompt, not a flag. pi's CLI exposes no
 * output-schema flag (the subagent example passes none), so a request
 * carrying `outputSchema` gets the schema inlined with an instruction to
 * end on a bare JSON object. The final assistant message is then parsed and
 * attached to `run:completed` under the field the core expects — `verdict`
 * for reviewers, `plan` for planners — the same non-strict-schema transport
 * `src/verdict.ts` and `src/plan.ts` document. Unparseable output is
 * reported as a completion WITHOUT that field: the core already treats a
 * missing verdict/plan as invalid and audits it, so this adapter never has
 * to invent one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  TieredExecutorConfig,
  TieredRoleConfig,
  WorkgraphConfig,
} from "../config.ts";
import {
  CH,
  Discover,
  newEnvelope,
  parseMessage,
  RunCancel,
  RunRequest,
  RunStatusRequest,
  splitProvider,
  type ExecutorOfferT,
  type ExecutorRoleT,
  type RunCompletedT,
  type RunOutcomeT,
  type RunRequestT,
  type RunStatusT,
} from "../protocol.ts";

export const TIERED_EXECUTOR_ID = "tiered";
export const TIERED_ADAPTER_VERSION = "1.0.0";

/** Roles this adapter can serve at all; config picks the subset offered. */
export const TIERED_SUPPORTED_ROLES: readonly ExecutorRoleT[] = [
  "planner",
  "implementer",
  "reviewer",
  "revision",
];

/** Default wall-clock cap per run (30 min) — a hung child never holds a
 *  lease past its TTL, but killing it releases the concurrency slot. */
export const DEFAULT_RUN_TIMEOUT_MS = 1_800_000;

/** Cautious default: mutating runs share one working tree (isolation none). */
export const DEFAULT_MAX_CONCURRENCY = 2;

/** Roles whose output the core parses as structured JSON, and the field it
 *  reads it from. Both ride `run:completed` as extra non-strict fields. */
const STRUCTURED_FIELD: Partial<Record<ExecutorRoleT, "verdict" | "plan">> = {
  reviewer: "verdict",
  planner: "plan",
};

export interface TieredDeps {
  /** Effective config; resolved lazily (flags are not readable at load). */
  getConfig: () => WorkgraphConfig;
  /** Clock injection for tests (default Date.now). */
  now?: () => number;
  /**
   * Spawn seam. Defaults to `node:child_process.spawn`; tests substitute a
   * fake so the suite never launches a real model.
   */
  spawnFn?: typeof spawn;
  /** Working directory for spawned runs (default `process.cwd()`). */
  cwd?: string;
}

/** One in-flight tiered run. */
export interface TieredRun {
  workflowRunId: string;
  executionId: string;
  issueId: string;
  leaseEpoch: number;
  role: ExecutorRoleT;
  /** The model this run was LAUNCHED with (the requested one). */
  requestedModel: string;
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set when a cancel arrived — its completion is suppressed. */
  cancelled: boolean;
}

export interface TieredController {
  /** In-flight runs by executionId (tests). */
  activeRuns(): TieredRun[];
  /** Unsubscribe handlers and kill every in-flight child (tests, shutdown). */
  teardown(): void;
}

/** The roles actually offered: supported ∩ configured. */
export function offeredRoles(config: TieredExecutorConfig): ExecutorRoleT[] {
  return TIERED_SUPPORTED_ROLES.filter((role) =>
    Object.prototype.hasOwnProperty.call(config.roles, role),
  );
}

/** Expand a leading `~` so config files can use home-relative paths. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Build the argv for one role's run. Per-role `piArgs` land AFTER the
 * global ones, so a role can override a global choice; the prompt is always
 * last.
 *
 * A configured-but-unreadable `appendSystemPrompt` THROWS rather than
 * dropping the flag. A reviewer silently stripped of its ruleset still
 * returns confident verdicts, and nothing downstream — not the fencing
 * check, not the independence check, not the audit trail — could tell that
 * the review recorded was not the review configured.
 */
export function buildRunArgs(
  role: TieredRoleConfig,
  config: TieredExecutorConfig,
  prompt: string,
): string[] {
  const args = ["--mode", "json", "-p", "--no-session", "--model", role.model];
  if (role.appendSystemPrompt !== undefined) {
    const path = expandHome(role.appendSystemPrompt);
    if (!existsSync(path)) {
      throw new Error(`appendSystemPrompt file not readable: ${path}`);
    }
    args.push("--append-system-prompt", path);
  }
  if (role.tools && role.tools.length > 0) {
    args.push("--tools", role.tools.join(","));
  }
  if (config.piArgs) args.push(...config.piArgs);
  if (role.piArgs) args.push(...role.piArgs);
  args.push(prompt);
  return args;
}

/**
 * The task prompt handed to the spawned run. Role-specific, because the
 * three tiers want genuinely different things: a planner must not edit, an
 * implementer must not close, a reviewer must not fix what it reviews.
 */
export function buildTieredPrompt(request: RunRequestT): string {
  const lines = [
    `You are executing work-graph issue ${request.issue.id}: "${request.issue.title}".`,
  ];
  if (request.issue.description) lines.push("", request.issue.description);
  if (request.issue.acceptanceCriteria) {
    lines.push("", `Acceptance criteria: ${request.issue.acceptanceCriteria}`);
  }
  if (request.plan) {
    lines.push("", "An accepted plan for this issue:", request.plan);
  }
  if (request.priorFindings && request.priorFindings.length > 0) {
    lines.push(
      "",
      "Findings from review that must be addressed:",
      ...request.priorFindings.map((f) => `- ${f}`),
    );
  }

  lines.push("");
  switch (request.role) {
    case "planner":
      lines.push(
        "You are PLANNING this work. Do not edit, create, or delete any file.",
        "Read what you need, then produce an ordered implementation plan.",
        "Your refined acceptance criteria are advisory — the approved criteria above remain authoritative.",
      );
      break;
    case "implementer":
      lines.push(
        "Implement this issue now.",
        "Your completion is reported to the workgraph coordinator, which records the result and moves the issue to judging — do not close or release the issue yourself.",
      );
      break;
    case "revision":
      lines.push(
        "Revise the existing implementation to address the findings above.",
        "Do not close or release the issue; the judgment gate re-reviews your work.",
      );
      break;
    case "reviewer":
    case "verifier":
      lines.push(
        "You are REVIEWING work you did not author. Do not fix what you find — report it.",
        "Judge the implementation strictly against the acceptance criteria above.",
      );
      break;
  }

  if (request.outputSchema !== undefined) {
    lines.push(
      "",
      "Your FINAL message must be a bare JSON object matching this schema, with no prose, code fences, or commentary around it:",
      JSON.stringify(request.outputSchema),
    );
  }
  return lines.join("\n");
}

/**
 * Pull the structured payload out of a run's final assistant text. Returns
 * undefined when there is nothing parseable — the caller reports a
 * completion without the field, and the core's existing invalid-payload
 * path (audited, bounded) takes over. Tolerates a fenced block because
 * models add them despite instructions; does NOT tolerate prose around a
 * JSON object it cannot isolate.
 */
export function extractStructured(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed !== null && typeof parsed === "object") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

export function registerTieredExecutor(
  pi: ExtensionAPI,
  deps: TieredDeps,
): TieredController {
  const nowFn = deps.now ?? Date.now;
  const spawnFn = deps.spawnFn ?? spawn;
  const cwd = deps.cwd ?? process.cwd();
  const runs = new Map<string, TieredRun>();
  const unsubs: (() => void)[] = [];

  /** Effective config, or undefined when the adapter is off. The re-check
   *  on every event is the second half of the double gate: index.ts also
   *  declines to call this function when the block is absent. */
  function conf(): TieredExecutorConfig | undefined {
    const c = deps.getConfig().tieredExecutor;
    return c?.enabled === true && Object.keys(c.roles).length > 0 ? c : undefined;
  }

  function reject(msg: RunRequestT, reason: string): void {
    pi.events.emit(CH.runRejected, {
      ...newEnvelope(nowFn),
      inReplyTo: msg.messageId,
      workflowRunId: msg.workflowRunId,
      issueId: msg.issue.id,
      leaseEpoch: msg.leaseEpoch,
      executorId: TIERED_EXECUTOR_ID,
      reason,
    });
  }

  function finish(
    run: TieredRun,
    outcome: RunOutcomeT,
    finalText: string,
    reportedModel: string | undefined,
    evidence: string[],
  ): void {
    if (run.timer) clearTimeout(run.timer);
    runs.delete(run.executionId);
    if (run.cancelled) return; // cancelled runs report nothing

    const field = STRUCTURED_FIELD[run.role];
    const structured = field ? extractStructured(finalText) : undefined;
    const effectiveModel = reportedModel ?? run.requestedModel;
    const provider = splitProvider(effectiveModel);
    const completion: RunCompletedT = {
      ...newEnvelope(nowFn),
      workflowRunId: run.workflowRunId,
      executionId: run.executionId,
      issueId: run.issueId,
      leaseEpoch: run.leaseEpoch,
      outcome,
      artifacts: [],
      evidence,
      provenance: {
        harness: "pi",
        profile: `tiered:${run.role}`,
        // The model the run REPORTED using, never the one requested — a
        // provider-side substitution must surface, not be papered over.
        // Falls back to the requested id only when the child reported none.
        model: effectiveModel,
        // The provider axis must be POPULATED to be worth anything:
        // `checkIndependence` fails closed, so an undefined axis counts as
        // a match and silently reduces the independence check to the model
        // axis alone. Split with the same unambiguous-`provider/id` rule
        // the subagents bridge uses, so the two adapters report provenance
        // identically.
        ...(provider !== undefined ? { provider } : {}),
      },
      ...(field && structured !== undefined ? { [field]: structured } : {}),
    } as RunCompletedT;
    pi.events.emit(CH.runCompleted, completion);
  }

  // ---- discovery ---------------------------------------------------------
  unsubs.push(
    pi.events.on(CH.discover, (data) => {
      const config = conf();
      if (!config) return;
      let msg;
      try {
        msg = parseMessage(CH.discover, Discover, data);
      } catch {
        return;
      }
      const roles = offeredRoles(config);
      if (roles.length === 0) return; // nothing mapped → offer nothing
      const offer: ExecutorOfferT = {
        ...newEnvelope(nowFn),
        inReplyTo: msg.messageId,
        executorId: TIERED_EXECUTOR_ID,
        adapterVersion: TIERED_ADAPTER_VERSION,
        roles,
        harness: "pi",
        // Honest: no worktree is created (see the module docblock).
        isolation: "none",
        supportsCancellation: true,
        supportsReconciliation: false,
        profileSemantics: "executor-defined",
        maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
        // Priority above the in-session compat adapter: an operator who
        // configured explicit per-role models means them to be used.
        priority: 10,
      };
      pi.events.emit(CH.offer, offer);
    }),
  );

  // ---- run requests ------------------------------------------------------
  unsubs.push(
    pi.events.on(CH.runRequest, (data) => {
      const config = conf();
      if (!config) return;
      let msg: RunRequestT;
      try {
        msg = parseMessage(CH.runRequest, RunRequest, data);
      } catch {
        return;
      }
      if (msg.executorId !== TIERED_EXECUTOR_ID) return; // addressed elsewhere

      const role = config.roles[msg.role];
      if (role === undefined) {
        // Not offered, so this should be unreachable — but a request for an
        // unmapped role is rejected rather than run on the ambient default.
        reject(msg, `no model configured for role ${msg.role}`);
        return;
      }
      const model = role.model;
      const cap = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
      if (runs.size >= cap) {
        reject(msg, "at-capacity");
        return;
      }

      let invocation: { command: string; args: string[] };
      try {
        invocation = piInvocation(buildRunArgs(role, config, buildTieredPrompt(msg)));
      } catch (e) {
        // A missing ruleset file is a REJECTED run, not a degraded one —
        // see buildRunArgs.
        reject(msg, e instanceof Error ? e.message : String(e));
        return;
      }

      let child: ChildProcess;
      try {
        child = spawnFn(invocation.command, invocation.args, {
          cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        // A run we could not start is rejected, never accepted-and-dropped.
        reject(msg, `spawn-failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }

      const run: TieredRun = {
        workflowRunId: msg.workflowRunId,
        executionId: crypto.randomUUID(),
        issueId: msg.issue.id,
        leaseEpoch: msg.leaseEpoch,
        role: msg.role,
        requestedModel: model,
        child,
        timer: null,
        cancelled: false,
      };
      runs.set(run.executionId, run);

      // Collect the NDJSON stream: the last assistant text is the result,
      // and the last reported model is the provenance.
      let buffer = "";
      let finalText = "";
      let reportedModel: string | undefined;
      let stderr = "";

      const onLine = (line: string): void => {
        if (!line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return; // non-JSON chatter on stdout is ignored, never fatal
        }
        const e = event as {
          type?: string;
          message?: { role?: string; content?: unknown; model?: string };
        };
        if (e.type !== "message_end" || !e.message) return;
        if (e.message.role !== "assistant") return;
        if (typeof e.message.model === "string") reportedModel = e.message.model;
        const text = textOf(e.message.content);
        if (text) finalText = text;
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      const timeoutMs = config.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
      run.timer = setTimeout(() => {
        // Killing frees the concurrency slot; the completion reports
        // `failure` so the gate — not this adapter — decides what it means.
        child.kill("SIGTERM");
      }, timeoutMs);

      child.on("error", (e: Error) => {
        finish(run, "failure", "", reportedModel, [
          `tiered ${run.role} run failed to execute: ${e.message}`,
        ]);
      });

      child.on("close", (code: number | null) => {
        if (buffer.trim()) onLine(buffer);
        const ok = code === 0;
        const evidence = [
          `tiered ${run.role} run on ${reportedModel ?? model} exited ${code ?? "null"}`,
        ];
        if (!ok && stderr.trim()) {
          evidence.push(`stderr: ${stderr.trim().slice(0, 400)}`);
        }
        finish(run, ok ? "success" : "failure", finalText, reportedModel, evidence);
      });

      pi.events.emit(CH.runAccepted, {
        ...newEnvelope(nowFn),
        inReplyTo: msg.messageId,
        workflowRunId: run.workflowRunId,
        executionId: run.executionId,
        issueId: run.issueId,
        leaseEpoch: run.leaseEpoch,
        executorId: TIERED_EXECUTOR_ID,
      });
    }),
  );

  // ---- cancellation ------------------------------------------------------
  unsubs.push(
    pi.events.on(CH.runCancel, (data) => {
      let msg;
      try {
        msg = parseMessage(CH.runCancel, RunCancel, data);
      } catch {
        return;
      }
      for (const run of [...runs.values()]) {
        if (run.workflowRunId !== msg.workflowRunId) continue;
        if (msg.executionId !== undefined && msg.executionId !== run.executionId) {
          continue; // names an older execution — not this one
        }
        run.cancelled = true;
        if (run.timer) clearTimeout(run.timer);
        run.child.kill("SIGTERM");
        runs.delete(run.executionId);
        pi.events.emit(CH.runCancelled, {
          ...newEnvelope(nowFn),
          workflowRunId: run.workflowRunId,
          executionId: run.executionId,
          issueId: run.issueId,
        });
        return;
      }
      // The no-op ack contract: an unknown or finished run is still acked,
      // so a coordinator awaiting the ack never waits out its window.
      pi.events.emit(CH.runCancelled, {
        ...newEnvelope(nowFn),
        workflowRunId: msg.workflowRunId,
        issueId: msg.issueId,
        ...(msg.executionId !== undefined ? { executionId: msg.executionId } : {}),
      });
    }),
  );

  // ---- status ------------------------------------------------------------
  // Child processes die with this session, so a pre-restart execution is
  // `missing` BY DEFINITION — after a restart `runs` is empty and the
  // missing-when-unknown answer below is trivially correct.
  unsubs.push(
    pi.events.on(CH.runStatusRequest, (data) => {
      if (!conf()) return;
      let msg;
      try {
        msg = parseMessage(CH.runStatusRequest, RunStatusRequest, data);
      } catch {
        return;
      }
      if (msg.executorId !== TIERED_EXECUTOR_ID) return; // not for us
      const run = [...runs.values()].find(
        (r) => r.workflowRunId === msg.workflowRunId,
      );
      const status: RunStatusT = {
        ...newEnvelope(nowFn),
        inReplyTo: msg.messageId,
        workflowRunId: msg.workflowRunId,
        issueId: msg.issueId,
        status: run ? "active" : "missing",
        ...(run ? { executionId: run.executionId } : {}),
      };
      pi.events.emit(CH.runStatus, status);
    }),
  );

  return {
    activeRuns: () => [...runs.values()],
    teardown: () => {
      for (const off of unsubs) off();
      unsubs.length = 0;
      for (const run of runs.values()) {
        run.cancelled = true;
        if (run.timer) clearTimeout(run.timer);
        run.child.kill("SIGTERM");
      }
      runs.clear();
    },
  };
}

/**
 * How to invoke pi, mirroring the subagent example's resolution order:
 * re-run the CURRENT script under the current runtime when that script is a
 * real file on disk (so a locally-checked-out pi runs itself), else the
 * compiled binary when the runtime is not a generic `node`/`bun`, else a
 * `pi` on PATH. The bun single-file-binary case (`/$bunfs/`) has no real
 * script to re-run and falls through.
 */
export function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  const isBunVirtual = script?.startsWith("/$bunfs/root/") ?? false;
  if (script && !isBunVirtual && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const exec = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(exec)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

/** Flatten a pi message's content to text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}
