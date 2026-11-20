/**
 * The core-run check: one shell command, run by the coordinator itself
 * against a result tree, whose exit code is the one proof of work that does
 * not rest on a model's word. The README's rule that the core never executes
 * model work stands: a shell command with an exit code is not model work.
 *
 * THE RUNNER ({@link runCheck}) spawns its own process. It does not go
 * through `pi.exec`, which reports exit code 0 for a child killed by a
 * signal (decision log). A run passes only when the command exited 0 on its
 * own: a non-zero exit, a timeout, a signal, a command that could not start
 * and a log that could not be written are each a failed run with a reason,
 * never a pass. The child gets its own process group, so a timeout kills
 * everything the command started. Output goes to a log that is hashed as it
 * is written; the log keeps the first 10 MB and says so when it cut.
 *
 * WHEN A RUN ENDS. The run ends when the command's process exits, not when
 * its output pipes close: a command that leaves a background child holding
 * the pipes (`server &`) has still finished. Output that arrives shortly
 * after the exit is still read; a process that keeps writing is cut off
 * after a bounded wait.
 *
 * THE EFFECTIVE CHECK ({@link resolveCheck}): the issue's own command, else
 * the issue's waiver, else the repository default from the `workgraph.check`
 * setting. A waiver on the issue wins over the repository default, because
 * it is how one issue opts out of it.
 *
 * THE BAR ({@link Bar}) is everything a run is judged against: the risk
 * tier, the resolved gate policy, the acceptance criteria, the check or its
 * waiver, and what the diff guards read (`src/guards.ts`): the setup
 * command, the test-file globs and the approved plan's file paths. The
 * coordinator captures it when it claims the issue and uses only that copy
 * until the claim ends, because settings are read from a file inside the
 * checkout on every lookup and an implementer could otherwise edit what it
 * is judged against (decision log).
 *
 * POSIX only: the group kill and `shell: true` assume `sh`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { checkOf, checkWaiverOf, riskTierOf } from "./lifecycle.ts";
import {
  GATES,
  resolvePolicy,
  type GatePolicy,
  type PolicyOverrides,
  type RiskTier,
} from "./policy.ts";
import { workspaceEnv } from "./snapshot.ts";
import type { WorkIssue } from "./types.ts";

/** A check to run: the command text and how long it may take. */
export interface CheckSpec {
  command: string;
  timeoutMs: number;
}

/** What one run of a check found. */
export interface CheckRun {
  /** sha256 of the command text */
  commandDigest: string;
  /** null when the process was killed or never started */
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  /** the command exited 0 on its own, and its log was written */
  passed: boolean;
  /** why the run did not pass: `exited 1`, `timed out after 600s`,
   *  `killed by SIGKILL`, `could not start: ...`, `could not write log: ...` */
  reason?: string;
  startedAt: string;
  endedAt: string;
  log: {
    path: string;
    /** bytes in the log file, the cut note included */
    bytes: number;
    /** sha256 of exactly those bytes */
    sha256: string;
    /** the last {@link LOG_TAIL_CHARS} characters the command printed */
    tail: string;
  };
}

/** A check run bound to the tree it ran against. */
export interface CheckReceipt extends CheckRun {
  tree: string;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

/** The log keeps this many bytes of output, then a note that it cut. */
export const MAX_LOG_BYTES = 10 * 1024 * 1024;

/** How much of the end of the output a run carries for findings and status. */
export const LOG_TAIL_CHARS = 400;

/** After SIGTERM, how long the process group gets before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** After the exit, how long quiet output pipes are waited on. */
const EXIT_IDLE_MS = 100;

/** After the exit, the longest a still-writing descendant is read from. */
const EXIT_DRAIN_MS = 2_000;

const LOG_CUT_NOTE = `\n[pi-workgraph] log cut at ${MAX_LOG_BYTES} bytes; the rest of the output was not kept\n`;

/** sha256 of a command's text: what a receipt and the frozen bar compare. */
export function commandDigest(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

export interface RunCheckOptions {
  /** Aborting kills the process group; the run ends with the reason `aborted`. */
  signal?: AbortSignal;
}

/**
 * Run `spec.command` through the shell in `cwd`, writing everything it
 * prints to `logPath`. Never rejects: every way a run can go wrong is a
 * {@link CheckRun} with `passed: false` and a `reason`.
 */
export function runCheck(
  spec: CheckSpec,
  cwd: string,
  logPath: string,
  options: RunCheckOptions = {},
): Promise<CheckRun> {
  const startedAt = new Date().toISOString();
  const digest = commandDigest(spec.command);
  const hash = createHash("sha256");
  let bytes = 0;
  let cut = false;
  let logError: string | undefined;
  let tail = "";

  const finish = (
    outcome: Pick<CheckRun, "exitCode" | "timedOut"> & {
      signal?: string;
      reason?: string;
    },
  ): CheckRun => {
    const reason = outcome.reason ?? logError;
    return {
      commandDigest: digest,
      exitCode: outcome.exitCode,
      ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
      timedOut: outcome.timedOut,
      passed:
        reason === undefined &&
        outcome.exitCode === 0 &&
        !outcome.timedOut &&
        outcome.signal === undefined,
      ...(reason !== undefined ? { reason } : {}),
      startedAt,
      endedAt: new Date().toISOString(),
      log: {
        path: logPath,
        bytes,
        sha256: hash.digest("hex"),
        tail: tail.slice(-LOG_TAIL_CHARS),
      },
    };
  };

  // The log first: a run whose output cannot be kept is not a pass, so
  // there is no point starting the command.
  let fd: number;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    rmSync(logPath, { recursive: true, force: true });
    fd = openSync(logPath, "wx");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Promise.resolve(
      finish({
        exitCode: null,
        timedOut: false,
        reason: `could not write log: ${msg}`,
      }),
    );
  }

  const keep = (chunk: Buffer): void => {
    if (logError !== undefined) return;
    try {
      writeSync(fd, chunk);
      hash.update(chunk);
      bytes += chunk.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError = `could not write log: ${msg}`;
    }
  };

  const onOutput = (chunk: Buffer): void => {
    // The tail follows the output, also past the cut: the end of a long
    // run is where its failure is.
    tail = (tail + chunk.toString("utf8")).slice(-LOG_TAIL_CHARS * 4);
    if (cut) return;
    const room = MAX_LOG_BYTES - bytes;
    if (chunk.length <= room) {
      keep(chunk);
      return;
    }
    if (room > 0) keep(chunk.subarray(0, room));
    cut = true;
    keep(Buffer.from(LOG_CUT_NOTE, "utf8"));
  };

  return new Promise<CheckRun>((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    let child: ReturnType<typeof spawn>;

    /** Signal the whole process group. A group that is already gone is fine. */
    const killGroup = (signal: NodeJS.Signals): void => {
      const pid = child?.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        // ESRCH: nothing left to signal.
      }
    };

    const stop = (): void => {
      if (exited !== undefined || settled) return;
      killGroup("SIGTERM");
      killTimer ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };

    const onAbort = (): void => {
      aborted = true;
      stop();
    };

    const settle = (spawnError?: string): void => {
      if (settled) return;
      settled = true;
      for (const timer of [timeoutTimer, killTimer, idleTimer, drainTimer]) {
        if (timer) clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      // A run that was stopped leaves nothing behind: whatever in the group
      // outlived the command's own process is killed now, since the timer
      // that would have done it was just cleared.
      if (timedOut || aborted) killGroup("SIGKILL");
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      try {
        closeSync(fd);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logError ??= `could not write log: ${msg}`;
      }
      const signal = exited?.signal ?? undefined;
      resolve(
        finish({
          exitCode: exited?.code ?? null,
          ...(signal !== undefined && signal !== null ? { signal } : {}),
          timedOut,
          ...(spawnError !== undefined
            ? { reason: `could not start: ${spawnError}` }
            : aborted
              ? { reason: "aborted" }
              : timedOut
                ? { reason: `timed out after ${seconds(spec.timeoutMs)}s` }
                : signal
                  ? { reason: `killed by ${signal}` }
                  : exited !== undefined && exited.code !== 0
                    ? { reason: `exited ${exited.code}` }
                    : {}),
        }),
      );
    };

    try {
      child = spawn(spec.command, {
        shell: true,
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: workspaceEnv(),
      });
    } catch (e) {
      settle(e instanceof Error ? e.message : String(e));
      return;
    }

    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => settle(), EXIT_IDLE_MS);
    };

    const onData = (chunk: Buffer): void => {
      onOutput(chunk);
      // Output still arriving after the exit: keep reading while it flows.
      if (exited !== undefined && !settled) armIdle();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.once("error", (e) => {
      // No pid: the process never started (a working directory that does
      // not exist). With a pid, the exit that follows decides.
      if (child.pid === undefined) settle(e.message);
    });
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      if (timeoutTimer) clearTimeout(timeoutTimer);
      armIdle();
      drainTimer = setTimeout(() => settle(), EXIT_DRAIN_MS);
    });
    child.once("close", () => {
      if (exited !== undefined) settle();
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);

    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A failed run for a check that never got as far as a process: the place
 * for its log could not be prepared. Same shape as any other failed run, so
 * the caller treats it as one.
 */
export function unstartedRun(spec: CheckSpec, reason: string): CheckRun {
  const now = new Date().toISOString();
  return {
    commandDigest: commandDigest(spec.command),
    exitCode: null,
    timedOut: false,
    passed: false,
    reason,
    startedAt: now,
    endedAt: now,
    log: {
      path: "",
      bytes: 0,
      sha256: createHash("sha256").digest("hex"),
      tail: "",
    },
  };
}

// ---------------------------------------------------------------------------
// The repository default (`workgraph.check` in Pi settings)
// ---------------------------------------------------------------------------

/** The `check` settings block. */
export interface CheckSettings {
  /** The repository's default check command. */
  command?: string;
  /** How long any check may run, in milliseconds (default {@link DEFAULT_CHECK_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** A command that prepares a fresh worktree for the check (install
   *  dependencies, build). The core runs it before the first check in every
   *  throwaway worktree of a base tree; the check in the implementer's own
   *  workspace never needs it. */
  setup?: string;
  /** Globs naming the repository's test files. Replaces the defaults
   *  (`DEFAULT_TEST_GLOBS` in `src/guards.ts`); never extends them. */
  testGlobs?: string[];
}

/** Thrown when the `check` settings block does not validate. The message names the key. */
export class CheckConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckConfigError";
  }
}

const CHECK_SETTINGS_KEYS = ["command", "timeoutMs", "setup", "testGlobs"] as const;

/** The largest delay a timer accepts. */
const MAX_TIMEOUT_MS = 2_147_483_647;

function described(raw: unknown): string {
  if (Array.isArray(raw)) return "an array";
  if (raw !== null && typeof raw === "object") return "an object";
  return typeof raw === "string" ? JSON.stringify(raw) : String(raw);
}

/**
 * Validate the `check` settings block. Returns a copy holding only what
 * validated; throws {@link CheckConfigError} naming the first bad key. A bad
 * block is never dropped: a dropped repository default would leave work
 * unchecked without a word.
 */
export function validateCheckSettings(raw: unknown): CheckSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CheckConfigError(
      `check must be an object with ${CHECK_SETTINGS_KEYS.join(", ")}, got ${described(raw)}`,
    );
  }
  const settings: CheckSettings = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "command":
      case "setup":
        if (typeof value !== "string" || value.trim() === "") {
          throw new CheckConfigError(
            `check.${key} must be a non-empty command string, got ${described(value)}`,
          );
        }
        settings[key] = value.trim();
        break;
      case "timeoutMs":
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value <= 0 ||
          value > MAX_TIMEOUT_MS
        ) {
          throw new CheckConfigError(
            `check.timeoutMs must be a positive number of milliseconds, got ${described(value)}`,
          );
        }
        settings.timeoutMs = value;
        break;
      case "testGlobs":
        // An empty list would make every file a non-test and switch two
        // guards off without a word, so it is an error, not "no tests".
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          value.some((glob) => typeof glob !== "string" || glob.trim() === "")
        ) {
          throw new CheckConfigError(
            `check.testGlobs must be a non-empty array of glob strings, got ${
              Array.isArray(value) && value.length === 0 ? "an empty array" : described(value)
            }`,
          );
        }
        settings.testGlobs = (value as string[]).map((glob) => glob.trim());
        break;
      default:
        throw new CheckConfigError(
          `check.${key} is not a check setting (expected ${CHECK_SETTINGS_KEYS.join(", ")})`,
        );
    }
  }
  return settings;
}

// ---------------------------------------------------------------------------
// The effective check for an issue
// ---------------------------------------------------------------------------

/** The slice of the configuration the check and the bar are resolved from. */
export interface CheckConfig {
  check?: CheckSettings;
  policy?: PolicyOverrides;
}

/** What applies to an issue: a check to run, a waiver, or neither. */
export interface ResolvedCheck {
  spec?: CheckSpec;
  waiver?: string;
  /** Where the command came from, when there is one. */
  source?: "issue" | "repository default";
}

/**
 * The check that applies to an issue: its own command, else its waiver,
 * else the repository default. The timeout always comes from the
 * configuration.
 */
export function resolveCheck(issue: WorkIssue, config: CheckConfig): ResolvedCheck {
  const timeoutMs = config.check?.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const own = checkOf(issue);
  if (own !== undefined) {
    return { spec: { command: own, timeoutMs }, source: "issue" };
  }
  const waiver = checkWaiverOf(issue);
  if (waiver !== undefined) return { waiver };
  const fallback = config.check?.command;
  if (fallback !== undefined && fallback.trim() !== "") {
    return {
      spec: { command: fallback.trim(), timeoutMs },
      source: "repository default",
    };
  }
  return {};
}

/** The tier the policy uses for an issue: a missing or unknown one is medium. */
export function effectiveTier(riskTier: string | undefined): RiskTier {
  return riskTier === "low" || riskTier === "medium" || riskTier === "high"
    ? riskTier
    : "medium";
}

/** Whether work at this tier needs a check or a waiver: medium and high do. */
export function tierRequiresCheck(riskTier: string | undefined): boolean {
  return effectiveTier(riskTier) !== "low";
}

/**
 * The `check` and `checkWaiver` a tool call carries, trimmed. Whitespace
 * alone is unset. Both together is an error: a waiver says no check applies.
 */
export function authoredCheck(input: {
  check?: string;
  checkWaiver?: string;
}): { check?: string; waiver?: string } {
  const check = input.check?.trim() || undefined;
  const waiver = input.checkWaiver?.trim() || undefined;
  if (check !== undefined && waiver !== undefined) {
    throw new Error(
      "Pass check or checkWaiver, not both: a waiver records that no check applies.",
    );
  }
  return {
    ...(check !== undefined ? { check } : {}),
    ...(waiver !== undefined ? { waiver } : {}),
  };
}

/**
 * Why work may not be approved as it stands, or undefined when it may. The
 * rule: at medium or high risk, with the `check` gate enforcing at that
 * tier, there must be a check on the issue, a repository default or a
 * waiver. With the gate at `observe` or `off` approval is never refused.
 */
export function approvalRefusal(
  riskTier: string | undefined,
  has: { check?: string; waiver?: string },
  config: CheckConfig,
): string | undefined {
  if (!tierRequiresCheck(riskTier)) return undefined;
  if (resolvePolicy(riskTier, config.policy).gates.check !== "enforce") {
    return undefined;
  }
  if (has.check !== undefined || has.waiver !== undefined) return undefined;
  if (config.check?.command !== undefined) return undefined;
  return (
    `${effectiveTier(riskTier)}-risk work needs a check command (check: "npm test") ` +
    `or an explicit waiver (checkWaiver: "<why no check applies>").`
  );
}

// ---------------------------------------------------------------------------
// The frozen bar
// ---------------------------------------------------------------------------

/** What a run is judged against, captured at claim. */
export interface Bar {
  riskTier: RiskTier;
  /** resolved gates, independence, maxRevisions */
  policy: GatePolicy;
  criteria?: string;
  check?: CheckSpec;
  checkWaiver?: string;
  /** `check.setup` as configured at claim. Unset when none is configured. */
  setup?: string;
  /** `check.testGlobs` as configured at claim. Unset means the defaults. */
  testGlobs?: string[];
  /**
   * The file paths the plan approved at the plan gate names
   * (`planPathTargets`), which the `scope` guard holds the change to. Unset
   * when the claim implements no approved plan; empty when the approved
   * plan names no file path.
   */
  planTargets?: string[];
}

/**
 * The bar for an issue as it stands now, under a configuration.
 * `planTargets` is the one part neither of them holds: the claim passes the
 * paths of the approved plan it loaded, and a later comparison passes the
 * frozen ones back, because a plan comment appended after the claim must
 * not move the bar.
 */
export function buildBar(
  issue: WorkIssue,
  config: CheckConfig,
  planTargets?: readonly string[],
): Bar {
  const tier = riskTierOf(issue);
  const policy = resolvePolicy(tier, config.policy);
  const resolved = resolveCheck(issue, config);
  const criteria = issue.acceptance_criteria;
  const setup = config.check?.setup;
  const testGlobs = config.check?.testGlobs;
  return {
    riskTier: effectiveTier(tier),
    // A copy: the defaults are shared objects, and a bar must not change
    // when something else does.
    policy: {
      gates: { ...policy.gates },
      requireAuthorIndependence: { ...policy.requireAuthorIndependence },
      maxRevisions: policy.maxRevisions,
      escalate: policy.escalate,
    },
    ...(criteria !== undefined ? { criteria } : {}),
    ...(resolved.spec !== undefined ? { check: { ...resolved.spec } } : {}),
    ...(resolved.waiver !== undefined ? { checkWaiver: resolved.waiver } : {}),
    // Left out when unset, so a bar frozen before these existed keeps its
    // digest.
    ...(setup !== undefined && setup.trim() !== "" ? { setup: setup.trim() } : {}),
    ...(testGlobs !== undefined && testGlobs.length > 0
      ? { testGlobs: [...testGlobs] }
      : {}),
    ...(planTargets !== undefined ? { planTargets: [...planTargets] } : {}),
  };
}

/** JSON with object keys sorted and `undefined` left out, at every depth. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${fields.join(",")}}`;
}

/** sha256 of the bar's canonical JSON. */
export function barDigest(bar: Bar): string {
  return createHash("sha256").update(canonicalJson(bar)).digest("hex");
}

/**
 * The names of what differs between two bars, in a fixed order: `riskTier`,
 * `criteria`, `check`, `checkWaiver`, `setup`, `testGlobs`, `planTargets`,
 * `gates.<gate>`, `requireAuthorIndependence`, `maxRevisions`.
 */
export function barDifferences(frozen: Bar, current: Bar): string[] {
  const fields: string[] = [];
  const differs = (a: unknown, b: unknown): boolean =>
    canonicalJson(a ?? null) !== canonicalJson(b ?? null);
  if (frozen.riskTier !== current.riskTier) fields.push("riskTier");
  if (differs(frozen.criteria, current.criteria)) fields.push("criteria");
  if (differs(frozen.check, current.check)) fields.push("check");
  if (differs(frozen.checkWaiver, current.checkWaiver)) {
    fields.push("checkWaiver");
  }
  if (differs(frozen.setup, current.setup)) fields.push("setup");
  if (differs(frozen.testGlobs, current.testGlobs)) fields.push("testGlobs");
  if (differs(frozen.planTargets, current.planTargets)) {
    fields.push("planTargets");
  }
  for (const gate of GATES) {
    if (frozen.policy.gates[gate] !== current.policy.gates[gate]) {
      fields.push(`gates.${gate}`);
    }
  }
  if (
    differs(
      frozen.policy.requireAuthorIndependence,
      current.policy.requireAuthorIndependence,
    )
  ) {
    fields.push("requireAuthorIndependence");
  }
  if (frozen.policy.maxRevisions !== current.policy.maxRevisions) {
    fields.push("maxRevisions");
  }
  return fields;
}

const GATE_MODE_VALUES = ["off", "observe", "enforce"];

/**
 * A bar read back from a `bar-frozen` event, or undefined when the payload
 * is not one. Strict: a restart must not judge work on half a bar.
 */
export function parseBar(raw: unknown): Bar | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const riskTier = value.riskTier;
  if (riskTier !== "low" && riskTier !== "medium" && riskTier !== "high") {
    return undefined;
  }
  const policy = value.policy as Record<string, unknown> | null | undefined;
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return undefined;
  }
  const rawGates = policy.gates as Record<string, unknown> | null | undefined;
  if (rawGates === null || typeof rawGates !== "object") return undefined;
  const gates = {} as GatePolicy["gates"];
  for (const gate of GATES) {
    const mode = rawGates[gate];
    if (typeof mode !== "string" || !GATE_MODE_VALUES.includes(mode)) {
      return undefined;
    }
    gates[gate] = mode as GatePolicy["gates"][typeof gate];
  }
  const independence = policy.requireAuthorIndependence as
    | Record<string, unknown>
    | null
    | undefined;
  if (
    independence === null ||
    typeof independence !== "object" ||
    typeof policy.maxRevisions !== "number"
  ) {
    return undefined;
  }
  const check = value.check as Record<string, unknown> | null | undefined;
  let spec: CheckSpec | undefined;
  if (check !== undefined && check !== null) {
    if (
      typeof check !== "object" ||
      typeof check.command !== "string" ||
      check.command === "" ||
      typeof check.timeoutMs !== "number"
    ) {
      return undefined;
    }
    spec = { command: check.command, timeoutMs: check.timeoutMs };
  }
  const strings = (raw: unknown): string[] | undefined | null =>
    raw === undefined
      ? undefined
      : Array.isArray(raw) && raw.every((item) => typeof item === "string")
        ? (raw as string[])
        : null;
  const testGlobs = strings(value.testGlobs);
  const planTargets = strings(value.planTargets);
  if (testGlobs === null || planTargets === null) return undefined;
  if (value.setup !== undefined && typeof value.setup !== "string") {
    return undefined;
  }
  return {
    riskTier,
    policy: {
      gates,
      requireAuthorIndependence: {
        ...(typeof independence.model === "boolean"
          ? { model: independence.model }
          : {}),
        ...(typeof independence.provider === "boolean"
          ? { provider: independence.provider }
          : {}),
      },
      maxRevisions: policy.maxRevisions,
      escalate: "block",
    },
    ...(typeof value.criteria === "string" ? { criteria: value.criteria } : {}),
    ...(spec !== undefined ? { check: spec } : {}),
    ...(typeof value.checkWaiver === "string" && value.checkWaiver !== ""
      ? { checkWaiver: value.checkWaiver }
      : {}),
    ...(typeof value.setup === "string" && value.setup !== ""
      ? { setup: value.setup }
      : {}),
    ...(testGlobs !== undefined && testGlobs.length > 0 ? { testGlobs } : {}),
    ...(planTargets !== undefined ? { planTargets } : {}),
  };
}
