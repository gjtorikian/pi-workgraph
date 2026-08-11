/**
 * Configuration: three timers (lease TTL, heartbeat, poll) plus an identity
 * override. Resolution order per value: CLI flag, then environment variable,
 * then default. The timers are consumed by the Phase 2 lease layer; only the
 * identity override is load-bearing in Phase 1.
 */
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
export interface TieredExecutorConfig {
  enabled: boolean;
  /** Role name → model id (e.g. `{"planner": "anthropic/claude-fable-5"}`). */
  models: Record<string, string>;
  /** Extra args appended to every spawned `pi` (advanced; default none). */
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

/**
 * Parse the tiered-executor block. Unlike the subagents block there is NO
 * boolean shorthand: "enabled" without a `models` map would be a request to
 * tier with no tiers, which is exactly the silent-untiered-work failure the
 * adapter exists to prevent. A config that parses but maps no role resolves
 * to undefined (disabled) with a named warning, never to a half-on adapter.
 */
function tieredValue(
  pi: ExtensionAPI,
  flag: string,
  envVar: string,
): TieredExecutorConfig | undefined {
  const raw = stringValue(pi, flag, envVar);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(
      `[pi-workgraph] ignoring unparseable ${flag}/${envVar} value (not JSON)`,
    );
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.enabled !== true) return undefined;

  const models: Record<string, string> = {};
  const rawModels = record.models;
  if (rawModels !== null && typeof rawModels === "object" && !Array.isArray(rawModels)) {
    for (const [role, model] of Object.entries(rawModels as Record<string, unknown>)) {
      if (typeof model === "string" && model !== "") models[role] = model;
    }
  }
  if (Object.keys(models).length === 0) {
    console.error(
      `[pi-workgraph] ${flag}/${envVar} is enabled but maps no role to a model — ` +
        `the tiered executor stays DISABLED. Map at least one role, e.g. ` +
        `{"enabled":true,"models":{"implementer":"anthropic/claude-opus-5"}}.`,
    );
    return undefined;
  }

  const piArgs = Array.isArray(record.piArgs)
    ? record.piArgs.filter((a): a is string => typeof a === "string")
    : undefined;
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
    models,
    ...(piArgs && piArgs.length > 0 ? { piArgs } : {}),
    ...(runTimeoutMs !== undefined ? { runTimeoutMs } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
  };
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

/** Resolve the effective configuration (flag > env > default). */
export function resolveConfig(pi: ExtensionAPI): WorkgraphConfig {
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
    ),
  };
}
