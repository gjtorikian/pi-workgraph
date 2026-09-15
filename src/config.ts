/**
 * Configuration: three timers (lease TTL, heartbeat, poll) plus an identity
 * override. Resolution order per value: CLI flag, then environment variable,
 * then default. The timers are consumed by the Phase 2 lease layer; only the
 * identity override is load-bearing in Phase 1.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PolicyOverrides } from "./policy.ts";
import type { WorkflowClassT } from "./types.ts";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type ThinkingLevels = (typeof THINKING_LEVELS)[number];


//export type ThinkingLevels = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type SubagentsRoleRoutes = Partial<
  Record<
    | "planner"
    | "implementer"
    | "reviewer"
    | "revision"
    | "verifier"
    | "finalizer",
    string
  >
>;

/** Named pi-subagents profiles selected by workflow class and protocol role. */
export type SubagentsWorkflowRoutes = Partial<
  Record<WorkflowClassT, SubagentsRoleRoutes>
>;

/**
 * Opt-in block for the pi-subagents bridge (phase 5). Absent (the default)
 * means the bridge is never registered — index.ts does not call its
 * register function, and the register function re-checks this config before
 * subscribing to anything (the double gate).
 */
export interface SubagentsExecutorConfig {
  enabled: boolean;
  /**
   * Optional strict gate: accepted upstream `major.minor` version prefix
   * (e.g. "0.34" accepts every 0.34.x). Unset (the default) accepts any
   * installed version.
   */
  versionRange?: string;
  /** Optional workflow-class + role overrides for named subagent profiles. */
  routes?: SubagentsWorkflowRoutes;
  /** Optional per-role launch settings; names and model identifiers are opaque. */
  options?: Partial<
    Record<
      keyof SubagentsRoleRoutes,
      {
        model?: string;
        thinking?: string;
        skills?: string[];
      }
    >
  >;
}

export interface WorkgraphConfig {
  /** Optional caller-defined work after verification and before closure. */
  finalization?: { instructions: string; timeoutMs?: number };
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
   * and that each claim initializes lifecycle metadata and enters phase
   * "implementing"; a legacy issue carrying a live lease is respected and
   * never claimed. The phase-6 spec names this `compatLegacyDispatch`; it
   * shipped under this name, which is retained to avoid breaking the
   * flag/env strings.
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
   * Opt-in: set the reasoning level for compaction
   */
  reasoningLevel?: ThinkingLevels
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
      'Opt-in: register the experimental pi-subagents bridge — "true" or JSON with versionRange/routes (default disabled; env WORKGRAPH_SUBAGENTS_EXECUTOR)',
  },
  {
    name: "workgraph-finalization",
    description:
      "Optional post-verification task as JSON with instructions and timeoutMs (env WORKGRAPH_FINALIZATION)",
  },
  {
    name: "workgraph-compaction-reasoning-level",
    description:
      "Optional reasoning level for compaction (env WORKGRAPH_COMPACTION_REASONING_LEVEL)",
  },
] as const;

/**
 * Register the CLI flags. No `default` is passed so an unset flag reads as
 * undefined and the environment variable can take effect.
 */
export function registerConfigFlags(pi: ExtensionAPI): void {
  for (const flag of FLAGS) {
    pi.registerFlag(flag.name, {
      description: flag.description,
      type: "string",
    });
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
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
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
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const routes = parseSubagentsRoutes(record.routes);
    const options = parseSubagentsOptions(record.options);
    return {
      enabled: record.enabled === true,
      ...(typeof record.versionRange === "string" && record.versionRange
        ? { versionRange: record.versionRange }
        : {}),
      ...(routes !== undefined ? { routes } : {}),
      ...(options !== undefined ? { options } : {}),
    };
  } catch {
    console.error(
      `[pi-workgraph] ignoring unparseable ${flag}/${envVar} value (not JSON)`,
    );
    return undefined;
  }
}

function reasoningValue(
  pi: ExtensionAPI,
  flag: string,
  envVar: string,
): ThinkingLevels | undefined {
  const raw = stringValue(pi, flag, envVar);
  if (raw === undefined) return undefined;
  const lowered = raw.toLowerCase();
  return THINKING_LEVELS.find(v=>v===lowered)
}

function parseSubagentsRoutes(
  raw: unknown,
): SubagentsWorkflowRoutes | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const workflowClasses: WorkflowClassT[] = ["oneshot", "reviewed", "planned"];
  const roles: (keyof SubagentsRoleRoutes)[] = [
    "planner",
    "implementer",
    "reviewer",
    "revision",
    "verifier",
    "finalizer",
  ];
  const input = raw as Record<string, unknown>;
  const routes: SubagentsWorkflowRoutes = {};
  for (const workflowClass of workflowClasses) {
    const candidate = input[workflowClass];
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const roleRoutes: SubagentsRoleRoutes = {};
    for (const role of roles) {
      const agent = record[role];
      if (typeof agent === "string" && agent.trim() !== "") {
        roleRoutes[role] = agent.trim();
      }
    }
    if (Object.keys(roleRoutes).length > 0) routes[workflowClass] = roleRoutes;
  }
  return Object.keys(routes).length > 0 ? routes : undefined;
}

function parseSubagentsOptions(
  raw: unknown,
): SubagentsExecutorConfig["options"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const options: NonNullable<SubagentsExecutorConfig["options"]> = {};
  for (const role of [
    "planner",
    "implementer",
    "reviewer",
    "revision",
    "verifier",
    "finalizer",
  ] as const) {
    const input = (raw as Record<string, unknown>)[role];
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    const value = input as Record<string, unknown>;
    options[role] = {
      ...(typeof value.model === "string" && value.model.trim()
        ? { model: value.model.trim() }
        : {}),
      ...(typeof value.thinking === "string" && value.thinking.trim()
        ? { thinking: value.thinking.trim() }
        : {}),
      ...(Array.isArray(value.skills)
        ? {
            skills: value.skills
              .filter(
                (v): v is string =>
                  typeof v === "string" && v.trim().length > 0,
              )
              .map((v) => v.trim()),
          }
        : {}),
    };
  }
  return Object.keys(options).length ? options : undefined;
}

function finalizationValue(pi: ExtensionAPI): WorkgraphConfig["finalization"] {
  const raw = stringValue(
    pi,
    "workgraph-finalization",
    "WORKGRAPH_FINALIZATION",
  );
  if (!raw || raw === "false") return undefined;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("workgraph-finalization must contain instructions");
  const input = value as Record<string, unknown>;
  if (typeof input.instructions !== "string" || !input.instructions.trim())
    throw new Error("workgraph-finalization requires nonempty instructions");
  if (
    input.timeoutMs !== undefined &&
    (typeof input.timeoutMs !== "number" ||
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      input.timeoutMs > 2_147_483_647)
  )
    throw new Error("workgraph-finalization timeoutMs must be positive");
  return {
    instructions: input.instructions,
    ...(typeof input.timeoutMs === "number"
      ? { timeoutMs: input.timeoutMs }
      : {}),
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
    finalization: finalizationValue(pi),
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
    executorId: stringValue(
      pi,
      "workgraph-executor-id",
      "WORKGRAPH_EXECUTOR_ID",
    ),
    workerIdOverride: stringValue(
      pi,
      "workgraph-worker-id",
      "WORKGRAPH_WORKER_ID",
    ),
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
    reasoningLevel: reasoningValue(
      pi,
      "workgraph-compaction-reasoning-level",
      "WORKGRAPH_COMPACTION_REASONING_LEVEL",
    ),
  };
}
