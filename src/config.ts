/**
 * Configuration: three timers (lease TTL, heartbeat, poll) plus an identity
 * override. Resolution order per value: CLI flag, then environment variable,
 * then default. The timers are consumed by the Phase 2 lease layer; only the
 * identity override is load-bearing in Phase 1.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PolicyOverrides } from "./policy.ts";

/**
 * Opt-in block for the pi-subagents bridge (phase 5). Absent (the default)
 * means the bridge is never registered — index.ts does not call its
 * register function, and the register function re-checks this config before
 * subscribing to anything (the double gate).
 */
export interface SubagentsExecutorConfig {
  enabled: boolean;
  /**
   * Accepted upstream `major.minor` version prefix (e.g. "0.32" accepts
   * every 0.32.x). Default: the harvest-verified
   * `SUBAGENTS_SUPPORTED_VERSION_RANGE` from protocol.ts.
   */
  versionRange?: string;
}

/**
 * The tiered executor: one model per role, each run a fresh `pi` process.
 * Absent (the default) means the adapter is never registered — the same
 * double gate the subagents bridge uses.
 *
 * `models` is the whole point: a role with NO entry is NOT OFFERED. That is
 * the safety property. Offering a role with no mapping would spawn on the
 * ambient default model and silently produce untiered work that still
 * reports success — the operator asked for tiers precisely to prevent that.
 */
/**
 * What one role runs as. `model` is the only required field; everything
 * else shapes the spawned process, which is how a role acquires a
 * CHARACTER rather than just a model — a reviewer can be handed an
 * adversarial ruleset and a read-only tool set while the implementer is
 * not.
 */
export interface TieredRoleConfig {
  /** Model id, `provider/id` form (e.g. `anthropic/claude-opus-5`). */
  model: string;
  /**
   * Path to a file appended to this role's system prompt (pi's
   * `--append-system-prompt`). The seam for agent-agnostic rulesets — e.g.
   * pointing a reviewer at a minimalism ruleset makes it adversarial to the
   * implementer's instinct to over-build.
   *
   * `~` is expanded. A path that cannot be read REJECTS the run rather than
   * running without it: a reviewer that quietly lost its ruleset still
   * returns confident verdicts, and nothing downstream could tell.
   */
  appendSystemPrompt?: string;
  /** Tool allowlist for this role (pi's `--tools`). Omit for pi's default. */
  tools?: string[];
  /** Extra args for this role only, appended after the global `piArgs`. */
  piArgs?: string[];
}

export interface TieredExecutorConfig {
  enabled: boolean;
  /** Role name → role config. Built from `roles` and/or the `models`
   *  shorthand at parse time, so consumers read one shape. */
  roles: Record<string, TieredRoleConfig>;
  /** Extra args appended to EVERY spawned `pi` (advanced; default none). */
  piArgs?: string[];
  /** Per-run wall-clock cap before the child is killed (default 30 min). */
  runTimeoutMs?: number;
  /** Concurrent runs this executor advertises and enforces (default 2). */
  maxConcurrency?: number;
}

export interface WorkgraphConfig {
  /** Lease time-to-live in milliseconds (default 5 min). */
  leaseTtlMs: number;
  /** Heartbeat interval in milliseconds (default 60 s). */
  heartbeatMs: number;
  /** Ready-pool poll interval in milliseconds (default 30 s). */
  pollMs: number;
  /** Expiry-sweep interval in milliseconds (default: the poll interval). */
  sweepIntervalMs: number;
  /** Executor-discovery collection window in milliseconds (default 2 s). */
  discoveryTimeoutMs: number;
  /** Run-request accept/reject deadline in milliseconds (default 10 s). */
  acceptTimeoutMs: number;
  /**
   * Register the in-session compatibility executor (the sendMessage wake as
   * an explicit protocol adapter). Default TRUE — it is the only production
   * executor until phase 5; phase 6 documents disabling it.
   */
  compatInSessionExecutor: boolean;
  /** Explicit executor selection; wins over filters, errors when absent. */
  executorId?: string;
  /** Optional worker identity override; wins over the derived id. */
  workerIdOverride?: string;
  /**
   * Per-risk-tier judgment-gate policy overrides, merged over
   * `DEFAULT_POLICY` by `resolvePolicy` (defaults: low = advisory,
   * medium/high = blocking with author independence, maxRevisions 3).
   * Optional so existing config literals keep compiling; a partial object
   * never drops a knob.
   */
  policy?: PolicyOverrides;
  /**
   * Opt-in: let the coordinator auto-dispatch LEGACY issues (no
   * `workgraph_lifecycle_version`). Default FALSE — legacy issues are
   * skipped until approved via `workgraph_approve` (README "Legacy
   * compatibility": never an implicit default). When enabled, the
   * coordinator warns ONCE per session that legacy auto-dispatch is active
   * and that each claim lazily migrates the issue (stamps lifecycle v1,
   * enters phase "implementing"); a legacy issue carrying a live v0.1
   * lease is respected and never claimed. Transitional — for v0.1 graphs
   * mid-upgrade. (The phase-6 spec names this `compatLegacyDispatch`; it
   * shipped in phase 3 under this name, kept to avoid breaking the
   * flag/env strings.)
   */
  compatLegacyIssues?: boolean;
  /**
   * Opt-in: register the experimental pi-subagents bridge (phase 5).
   * Default UNDEFINED (disabled) — the adapter ships off, and even when
   * enabled it registers nothing unless the installed upstream version
   * passes the version gate.
   */
  subagentsExecutor?: SubagentsExecutorConfig;
  /**
   * Opt-in: register the tiered executor (one model per role). Default
   * UNDEFINED (disabled) — the adapter ships off, and even when enabled it
   * offers only the roles that have a model mapped.
   */
  tieredExecutor?: TieredExecutorConfig;
}

export const DEFAULT_LEASE_TTL_MS = 300_000;
export const DEFAULT_HEARTBEAT_MS = 60_000;
export const DEFAULT_POLL_MS = 30_000;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 2_000;
export const DEFAULT_ACCEPT_TIMEOUT_MS = 10_000;

const FLAGS = [
  {
    name: "workgraph-lease-ttl-ms",
    description: `Workgraph lease TTL in milliseconds (default ${DEFAULT_LEASE_TTL_MS}; env WORKGRAPH_LEASE_TTL_MS)`,
  },
  {
    name: "workgraph-heartbeat-ms",
    description: `Workgraph heartbeat interval in milliseconds (default ${DEFAULT_HEARTBEAT_MS}; env WORKGRAPH_HEARTBEAT_MS)`,
  },
  {
    name: "workgraph-poll-ms",
    description: `Workgraph ready-pool poll interval in milliseconds (default ${DEFAULT_POLL_MS}; env WORKGRAPH_POLL_MS)`,
  },
  {
    name: "workgraph-sweep-interval-ms",
    description: `Workgraph expiry-sweep interval in milliseconds (default: the poll interval; env WORKGRAPH_SWEEP_INTERVAL_MS)`,
  },
  {
    name: "workgraph-discovery-timeout-ms",
    description: `Workgraph executor-discovery window in milliseconds (default ${DEFAULT_DISCOVERY_TIMEOUT_MS}; env WORKGRAPH_DISCOVERY_TIMEOUT_MS)`,
  },
  {
    name: "workgraph-accept-timeout-ms",
    description: `Workgraph run-request accept deadline in milliseconds (default ${DEFAULT_ACCEPT_TIMEOUT_MS}; env WORKGRAPH_ACCEPT_TIMEOUT_MS)`,
  },
  {
    name: "workgraph-compat-in-session-executor",
    description:
      "Register the in-session compatibility executor (default true; env WORKGRAPH_COMPAT_IN_SESSION_EXECUTOR; set to false with no other executor for a correctly idle coordinator)",
  },
  {
    name: "workgraph-executor-id",
    description:
      "Pin executor selection to one executorId; the coordinator errors (and claims nothing) when it does not offer (env WORKGRAPH_EXECUTOR_ID)",
  },
  {
    name: "workgraph-worker-id",
    description:
      "Override the workgraph worker identity (default {user}@{host}/{short-session-id}; env WORKGRAPH_WORKER_ID)",
  },
  {
    name: "workgraph-policy",
    description:
      'Per-risk-tier judgment-gate policy overrides as a JSON object, e.g. {"low":{"maxRevisions":1}} (env WORKGRAPH_POLICY; defaults: low advisory, medium/high blocking)',
  },
  {
    name: "workgraph-compat-legacy-issues",
    description:
      "Opt-in: let the coordinator auto-dispatch legacy issues without workgraph_lifecycle_version (default false; env WORKGRAPH_COMPAT_LEGACY_ISSUES)",
  },
  {
    name: "workgraph-subagents-executor",
    description:
      'Opt-in: register the experimental pi-subagents bridge — "true" or a JSON object like {"enabled":true,"versionRange":"0.32"} (default disabled; env WORKGRAPH_SUBAGENTS_EXECUTOR)',
  },
  {
    name: "workgraph-tiered-executor",
    description:
      'Opt-in: register the tiered executor, one model per role — a JSON object like {"enabled":true,"models":{"planner":"anthropic/claude-fable-5","implementer":"anthropic/claude-opus-5","reviewer":"<model>"}}. Only mapped roles are offered (default disabled; env WORKGRAPH_TIERED_EXECUTOR)',
  },
] as const;

/**
 * Register the CLI flags. No `default` is passed so an unset flag reads as
 * undefined and the environment variable can take effect.
 */
export function registerConfigFlags(pi: ExtensionAPI): void {
  for (const flag of FLAGS) {
    pi.registerFlag(flag.name, { description: flag.description, type: "string" });
  }
}

function stringValue(
  pi: ExtensionAPI,
  flag: string,
  envVar: string,
): string | undefined {
  const fromFlag = pi.getFlag(flag);
  const raw = typeof fromFlag === "string" ? fromFlag : process.env[envVar];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function timerValue(
  pi: ExtensionAPI,
  flag: string,
  envVar: string,
  fallback: number,
): number {
  const raw = stringValue(pi, flag, envVar);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function policyValue(
  pi: ExtensionAPI,
  flag: string,
  envVar: string,
): PolicyOverrides | undefined {
  const raw = stringValue(pi, flag, envVar);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    // Structural trust boundary ends here: resolvePolicy merges per-knob
    // over the defaults, so a partially-shaped override degrades safely.
    return parsed as PolicyOverrides;
  } catch {
    console.error(
      `[pi-workgraph] ignoring unparseable ${flag}/${envVar} value (not JSON)`,
    );
    return undefined;
  }
}

function subagentsValue(
  pi: ExtensionAPI,
  flag: string,
  envVar: string,
): SubagentsExecutorConfig | undefined {
  const raw = stringValue(pi, flag, envVar);
  if (raw === undefined) return undefined;
  const lowered = raw.toLowerCase();
  // Boolean-ish shorthand: enable with the default version range.
  if (["true", "1", "yes", "on"].includes(lowered)) return { enabled: true };
  if (["false", "0", "no", "off"].includes(lowered)) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return {
      enabled: record.enabled === true,
      ...(typeof record.versionRange === "string" && record.versionRange
        ? { versionRange: record.versionRange }
        : {}),
    };
  } catch {
    console.error(
      `[pi-workgraph] ignoring unparseable ${flag}/${envVar} value (not JSON)`,
    );
    return undefined;
  }
}

/** Where a standing tiered-executor config lives, relative to the agent dir. */
export const TIERED_CONFIG_REL = "configs/workgraph-tiered.json";

/**
 * Cache TTL for the standing config file, mirroring `CONTEXT_CACHE_TTL_MS`.
 *
 * `resolveConfig` is called on EVERY event by `src/index.ts`'s live
 * getters, so an uncached read means a `readFileSync` per event — and in
 * the overwhelmingly common case (no file) an ENOENT throw per event, with
 * stack capture, which is far more expensive than the read would have been.
 * Ten seconds bounds staleness to about one tick while making the hot path
 * a clock comparison.
 */
export const TIERED_CONFIG_CACHE_TTL_MS = 10_000;

interface TieredFileCacheEntry {
  fetchedAt: number;
  value: TieredExecutorConfig | undefined;
}

const tieredFileCache = new Map<string, TieredFileCacheEntry>();

/** Drop the standing-config cache (tests that write the file mid-run). */
export function resetTieredConfigCacheForTest(): void {
  tieredFileCache.clear();
}

/** String array or undefined, dropping non-strings rather than failing. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v !== "");
  return out.length > 0 ? out : undefined;
}

/**
 * Build the role map from either shape. `roles` (full per-role config) and
 * `models` (role→id shorthand) may both appear; `roles` wins per role, so a
 * config can name most tiers tersely and expand only the one that needs a
 * ruleset. Entries missing a usable model are dropped — the not-offered
 * safety property is enforced by absence, so a malformed entry must not
 * become an offered role.
 */
function parseRoles(record: Record<string, unknown>): Record<string, TieredRoleConfig> {
  const roles: Record<string, TieredRoleConfig> = {};

  const rawModels = record.models;
  if (rawModels && typeof rawModels === "object" && !Array.isArray(rawModels)) {
    for (const [role, model] of Object.entries(rawModels as Record<string, unknown>)) {
      if (typeof model === "string" && model !== "") roles[role] = { model };
    }
  }

  const rawRoles = record.roles;
  if (rawRoles && typeof rawRoles === "object" && !Array.isArray(rawRoles)) {
    for (const [role, value] of Object.entries(rawRoles as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const model = entry.model;
      if (typeof model !== "string" || model === "") continue;
      const tools = stringArray(entry.tools);
      const piArgs = stringArray(entry.piArgs);
      roles[role] = {
        model,
        ...(typeof entry.appendSystemPrompt === "string" &&
        entry.appendSystemPrompt !== ""
          ? { appendSystemPrompt: entry.appendSystemPrompt }
          : {}),
        ...(tools ? { tools } : {}),
        ...(piArgs ? { piArgs } : {}),
      };
    }
  }
  return roles;
}

/** Shape a parsed JSON object into a config, or undefined if unusable. */
function tieredFromRecord(
  record: Record<string, unknown>,
  source: string,
): TieredExecutorConfig | undefined {
  if (record.enabled !== true) return undefined;
  const roles = parseRoles(record);
  if (Object.keys(roles).length === 0) {
    console.error(
      `[pi-workgraph] ${source} is enabled but maps no role to a model — ` +
        `the tiered executor stays DISABLED. Map at least one role, e.g. ` +
        `{"enabled":true,"models":{"implementer":"anthropic/claude-opus-5"}}.`,
    );
    return undefined;
  }
  const piArgs = stringArray(record.piArgs);
  const runTimeoutMs =
    typeof record.runTimeoutMs === "number" && record.runTimeoutMs > 0
      ? record.runTimeoutMs
      : undefined;
  const maxConcurrency =
    typeof record.maxConcurrency === "number" && record.maxConcurrency > 0
      ? record.maxConcurrency
      : undefined;
  return {
    enabled: true,
    roles,
    ...(piArgs ? { piArgs } : {}),
    ...(runTimeoutMs !== undefined ? { runTimeoutMs } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
  };
}

/**
 * Resolve the tiered-executor config: flag, then env, then the standing
 * agent-dir file. There is deliberately NO boolean shorthand — "enabled"
 * with no roles is a request to tier with no tiers, which is the
 * silent-untiered-work failure the adapter exists to prevent, so it
 * resolves to disabled with a named warning rather than a half-on adapter.
 *
 * The FILE is the answer to "every project should use the same tiers": the
 * agent dir is global, so one file governs every project and every session.
 * Flag and env still win, which is what a sandbox or a one-off run needs to
 * differ without editing shared state. The file is not more or less
 * reliable than the env var — it is the STANDING default, where the env var
 * is a per-invocation override.
 */
function tieredValue(
  pi: ExtensionAPI,
  flag: string,
  envVar: string,
  agentDir: string | undefined,
): TieredExecutorConfig | undefined {
  const raw = stringValue(pi, flag, envVar);
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // An explicitly-supplied but broken value does NOT fall through to
      // the file: silently running someone else's tiers because your own
      // JSON had a typo is worse than running none.
      console.error(
        `[pi-workgraph] ignoring unparseable ${flag}/${envVar} value (not JSON)`,
      );
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return tieredFromRecord(parsed as Record<string, unknown>, `${flag}/${envVar}`);
  }
  return agentDir === undefined ? undefined : tieredFromFile(agentDir);
}

/**
 * Read the standing config from `<agent-dir>/configs/workgraph-tiered.json`.
 * A missing file is the normal case (the adapter ships disabled) and is
 * silent; a file that EXISTS but cannot be parsed is loud, because the
 * operator plainly meant to configure something.
 *
 * The agent dir is INJECTED rather than resolved here. Resolving it means
 * calling pi's `getAgentDir()`, and importing that would add the first
 * runtime (non-type) dependency on `@earendil-works/pi-coding-agent` to a
 * module every other module imports — pulling the whole coding agent into
 * every consumer and every test process. `src/index.ts` is the one place
 * pi is already the host, so it supplies the value. Hardcoding
 * `~/.pi/agent` instead was rejected: both the env var name and the config
 * dir are REBRANDABLE (`${APP_NAME}_CODING_AGENT_DIR`,
 * `pkg.piConfig.configDir`), so a hardcoded path silently reads the wrong
 * directory under a rebranded host such as arc.
 */
function tieredFromFile(agentDir: string): TieredExecutorConfig | undefined {
  const path = join(agentDir, TIERED_CONFIG_REL);
  const now = Date.now();
  const hit = tieredFileCache.get(path);
  if (hit && now - hit.fetchedAt < TIERED_CONFIG_CACHE_TTL_MS) return hit.value;
  const value = readTieredFile(path);
  tieredFileCache.set(path, { fetchedAt: now, value });
  return value;
}

function readTieredFile(path: string): TieredExecutorConfig | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined; // absent — the default
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`[pi-workgraph] ${path} is not a JSON object — ignoring`);
      return undefined;
    }
    return tieredFromRecord(parsed as Record<string, unknown>, path);
  } catch {
    console.error(`[pi-workgraph] ${path} is not valid JSON — ignoring`);
    return undefined;
  }
}

function boolValue(
  pi: ExtensionAPI,
  flag: string,
  envVar: string,
  fallback: boolean,
): boolean {
  // The flag is registered as a string (matching the FLAGS convention: no
  // default passed so env vars can take effect), but tolerate a boolean in
  // case a harness sets one directly.
  const fromFlag = pi.getFlag(flag);
  if (typeof fromFlag === "boolean") return fromFlag;
  const raw = typeof fromFlag === "string" ? fromFlag : process.env[envVar];
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed === undefined || trimmed === "") return fallback;
  if (["false", "0", "no", "off"].includes(trimmed)) return false;
  if (["true", "1", "yes", "on"].includes(trimmed)) return true;
  return fallback;
}

/**
 * Resolve the effective configuration (flag > env > default).
 *
 * `agentDir` is optional and only the tiered executor reads it, for its
 * standing config file. Omitting it means no file is consulted — which is
 * what every direct-import consumer (tests, protocol-only users) wants, and
 * why this module still has ZERO runtime dependency on pi. `src/index.ts`
 * passes it.
 */
export function resolveConfig(
  pi: ExtensionAPI,
  agentDir?: string,
): WorkgraphConfig {
  const pollMs = timerValue(
    pi,
    "workgraph-poll-ms",
    "WORKGRAPH_POLL_MS",
    DEFAULT_POLL_MS,
  );
  return {
    leaseTtlMs: timerValue(
      pi,
      "workgraph-lease-ttl-ms",
      "WORKGRAPH_LEASE_TTL_MS",
      DEFAULT_LEASE_TTL_MS,
    ),
    heartbeatMs: timerValue(
      pi,
      "workgraph-heartbeat-ms",
      "WORKGRAPH_HEARTBEAT_MS",
      DEFAULT_HEARTBEAT_MS,
    ),
    pollMs,
    // The sweep defaults to the (resolved) poll cadence: expiry detection
    // does not need to outpace dispatch.
    sweepIntervalMs: timerValue(
      pi,
      "workgraph-sweep-interval-ms",
      "WORKGRAPH_SWEEP_INTERVAL_MS",
      pollMs,
    ),
    discoveryTimeoutMs: timerValue(
      pi,
      "workgraph-discovery-timeout-ms",
      "WORKGRAPH_DISCOVERY_TIMEOUT_MS",
      DEFAULT_DISCOVERY_TIMEOUT_MS,
    ),
    acceptTimeoutMs: timerValue(
      pi,
      "workgraph-accept-timeout-ms",
      "WORKGRAPH_ACCEPT_TIMEOUT_MS",
      DEFAULT_ACCEPT_TIMEOUT_MS,
    ),
    compatInSessionExecutor: boolValue(
      pi,
      "workgraph-compat-in-session-executor",
      "WORKGRAPH_COMPAT_IN_SESSION_EXECUTOR",
      true,
    ),
    executorId: stringValue(pi, "workgraph-executor-id", "WORKGRAPH_EXECUTOR_ID"),
    workerIdOverride: stringValue(pi, "workgraph-worker-id", "WORKGRAPH_WORKER_ID"),
    policy: policyValue(pi, "workgraph-policy", "WORKGRAPH_POLICY"),
    compatLegacyIssues: boolValue(
      pi,
      "workgraph-compat-legacy-issues",
      "WORKGRAPH_COMPAT_LEGACY_ISSUES",
      false,
    ),
    subagentsExecutor: subagentsValue(
      pi,
      "workgraph-subagents-executor",
      "WORKGRAPH_SUBAGENTS_EXECUTOR",
    ),
    tieredExecutor: tieredValue(
      pi,
      "workgraph-tiered-executor",
      "WORKGRAPH_TIERED_EXECUTOR",
      agentDir,
    ),
  };
}
