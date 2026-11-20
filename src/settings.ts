/**
 * Declarative configuration from Pi's own settings files — "write the
 * roster once, it just applies":
 *
 *   ~/.pi/agent/settings.json   (global, every repository)
 *   <repo>/.pi/settings.json    (project, this repository)
 *
 * under one key:
 *
 *   {
 *     "workgraph": {
 *       "tiers": { "planner": "anthropic/claude-opus-*", "implementer": "..." },
 *       "executors": { "planner": "in-session", "implementer": "pi-subagents" },
 *       "subagentsExecutor": true,                   // or the bridge's JSON block
 *       "store": "central",                          // keep databases out of checkouts
 *       "planApproval": "required",                // or "auto"
 *       "planCritique": "off",                     // or "high-risk"
 *       "policy": { "low": { "gates": { "scope": "off" } } }, // gate modes per risk tier
 *       "check": { "command": "npm test", "setup": "npm ci" } // default check, and how to prepare a fresh worktree for it
 *     }
 *   }
 *
 * Precedence per value (most explicit wins):
 *   CLI flag / env  >  project settings  >  workspace store (workgraph_tiers tool)  >  global settings  >  default
 *
 * The files are read fresh on each lookup (session_start, the tiers tool,
 * the slash command): they are small, and an edit should take effect on the
 * next session without a flag dance. Malformed JSON is reported once per
 * path and treated as absent — a typo in settings must never take the
 * extension down.
 *
 * TWO EXCEPTIONS: `policy` and `check`. This module carries both through
 * unvalidated, and config.ts rejects an invalid one instead of dropping it.
 * A dropped policy would fall back to the default gate modes without a
 * word, so work would close, or be blocked, under modes nobody chose; a
 * dropped `check` would leave every issue that relies on the repository
 * default unchecked. The reader stays non-throwing; the rejection stops
 * dispatch and names the bad key.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadStoredTiers, parseTiersValue, type TierConfig } from "./tiers.ts";

/** The settings key this extension owns. */
export const SETTINGS_KEY = "workgraph";

export interface WorkgraphSettings {
  tiers?: TierConfig;
  planApproval?: "required" | "auto";
  /** Advisory plan critique: "off" (default) or "high-risk" (planned issues with riskTier high). */
  planCritique?: "off" | "high-risk";
  /** Per-role executor pins, e.g. { planner: "in-session", implementer: "pi-subagents" }. */
  executors?: Record<string, string>;
  /** The pi-subagents bridge block, as config.ts parses it: `true` or `{ enabled, routes, options, versionRange }`. */
  subagentsExecutor?: string;
  /** Where databases live: "repo" (default), "central" (~/.pi/agent/workgraph), or an absolute directory. */
  store?: string;
  /** The gate policy as raw JSON, for config.ts to validate: the object `--workgraph-policy` takes. */
  policy?: string;
  /** The `check` block as raw JSON, for config.ts to validate: `{ command?, timeoutMs?, setup?, testGlobs? }`. */
  check?: string;
}

export interface SettingsSources {
  global?: WorkgraphSettings;
  project?: WorkgraphSettings;
}

export interface SettingsLocation {
  /** Pi's agent dir (default: `getAgentDir()`, i.e. `~/.pi/agent`). */
  agentDir?: string;
  /** Project directory holding `.pi/settings.json` (default: the session cwd). */
  cwd?: string;
}

let sessionCwd: string | undefined;

/** Record the session's cwd so cwd-less lookups (config.ts) find the project file. */
export function noteSessionCwd(cwd: string | undefined): void {
  sessionCwd = cwd;
}

export function currentSessionCwd(): string | undefined {
  return sessionCwd;
}

/** Pi's agent dir (`~/.pi/agent`, or Pi's env override). */
export function defaultAgentDir(): string {
  return getAgentDir();
}

const warned = new Set<string>();

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (!warned.has(path)) {
      warned.add(path);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[pi-workgraph] ignoring unreadable settings file ${path}: ${msg}`);
    }
    return undefined;
  }
}

/** Parse the `workgraph` block of one settings object. */
export function parseWorkgraphSettings(raw: unknown): WorkgraphSettings | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const block = (raw as Record<string, unknown>)[SETTINGS_KEY];
  if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
  const record = block as Record<string, unknown>;
  const out: WorkgraphSettings = {};
  if (typeof record.tiers === "string") {
    const tiers = parseTiersValue(record.tiers);
    if (tiers) out.tiers = tiers;
  } else if (record.tiers && typeof record.tiers === "object" && !Array.isArray(record.tiers)) {
    const tiers = parseTiersValue(JSON.stringify(record.tiers));
    if (tiers) out.tiers = tiers;
  }
  if (record.executors && typeof record.executors === "object" && !Array.isArray(record.executors)) {
    const executors = parseExecutorPins(record.executors as Record<string, unknown>);
    if (executors) out.executors = executors;
  }
  if (record.subagentsExecutor !== undefined && record.subagentsExecutor !== null) {
    out.subagentsExecutor =
      typeof record.subagentsExecutor === "string"
        ? record.subagentsExecutor
        : JSON.stringify(record.subagentsExecutor);
  }
  if (typeof record.store === "string" && record.store.trim()) out.store = record.store.trim();
  // Carried through as written, valid or not: config.ts validates it and
  // rejects a bad one (see the module comment). An empty string is unset,
  // as it is for the flag.
  if (typeof record.policy === "string") {
    if (record.policy.trim()) out.policy = record.policy.trim();
  } else if (record.policy !== undefined && record.policy !== null) {
    out.policy = JSON.stringify(record.policy);
  }
  // Carried through as written, like the policy: config.ts validates it.
  if (record.check !== undefined && record.check !== null) {
    out.check = JSON.stringify(record.check);
  }
  if (record.planApproval === "required" || record.planApproval === "auto") {
    out.planApproval = record.planApproval;
  } else if (record.planApproval !== undefined) {
    console.error(
      `[pi-workgraph] settings: planApproval must be "required" or "auto", got ${JSON.stringify(record.planApproval)}`,
    );
  }
  if (record.planCritique === "off" || record.planCritique === "high-risk") {
    out.planCritique = record.planCritique;
  } else if (record.planCritique !== undefined) {
    // Dropped, never guessed at: an unknown value must not turn the critique on.
    console.error(
      `[pi-workgraph] settings: planCritique must be "off" or "high-risk", got ${JSON.stringify(record.planCritique)}`,
    );
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Read the global and project `workgraph` settings blocks. */
export function workgraphSettings(location: SettingsLocation = {}): SettingsSources {
  const agentDir = location.agentDir ?? defaultAgentDir();
  const cwd = location.cwd ?? sessionCwd;
  const global = parseWorkgraphSettings(readJsonFile(join(agentDir, "settings.json")));
  const project = cwd
    ? parseWorkgraphSettings(readJsonFile(join(cwd, ".pi", "settings.json")))
    : undefined;
  return {
    ...(global ? { global } : {}),
    ...(project ? { project } : {}),
  };
}

export type TiersOrigin = "flag" | "project settings" | "workspace" | "global settings";

export interface EffectiveTiers {
  tiers: TierConfig;
  origin: TiersOrigin;
}

/**
 * The tier table in force for `cwd`: flag/env (passed in by the caller that
 * resolved config), then the project settings file, then what the
 * `workgraph_tiers` tool stored in the workspace, then global settings.
 */
export async function effectiveTiers(
  fromFlag: TierConfig | undefined,
  cwd: string,
  location: Omit<SettingsLocation, "cwd"> = {},
): Promise<EffectiveTiers | undefined> {
  if (fromFlag) return { tiers: fromFlag, origin: "flag" };
  const sources = workgraphSettings({ ...location, cwd });
  if (sources.project?.tiers) return { tiers: sources.project.tiers, origin: "project settings" };
  const stored = await loadStoredTiers(cwd);
  if (stored) return { tiers: stored, origin: "workspace" };
  if (sources.global?.tiers) return { tiers: sources.global.tiers, origin: "global settings" };
  return undefined;
}

/** Plan-approval mode from settings (project over global), if either sets it. */
export function settingsPlanApproval(
  location: SettingsLocation = {},
): WorkgraphSettings["planApproval"] {
  const sources = workgraphSettings(location);
  return sources.project?.planApproval ?? sources.global?.planApproval;
}

/** Plan-critique mode from settings (project over global), if either sets it. */
export function settingsPlanCritique(
  location: SettingsLocation = {},
): WorkgraphSettings["planCritique"] {
  const sources = workgraphSettings(location);
  return sources.project?.planCritique ?? sources.global?.planCritique;
}

/** Roles an executor pin may name (the protocol's role vocabulary). */
export const PINNABLE_ROLES = [
  "planner",
  "implementer",
  "reviewer",
  "revision",
  "verifier",
  "finalizer",
  "plan_critic",
] as const;

/** Parse `{ role: executorId }`; unknown roles and empty ids are dropped. */
export function parseExecutorPins(raw: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [role, value] of Object.entries(raw)) {
    if (!(PINNABLE_ROLES as readonly string[]).includes(role)) {
      console.error(`[pi-workgraph] settings: executors names unknown role "${role}" — ignored`);
      continue;
    }
    if (typeof value === "string" && value.trim()) out[role] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Per-role executor pins from settings (project over global, merged per role). */
export function settingsExecutors(location: SettingsLocation = {}): Record<string, string> | undefined {
  const sources = workgraphSettings(location);
  const merged = { ...(sources.global?.executors ?? {}), ...(sources.project?.executors ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The raw pi-subagents bridge setting (project over global), for config.ts's parser. */
export function settingsSubagentsExecutor(location: SettingsLocation = {}): string | undefined {
  const sources = workgraphSettings(location);
  return sources.project?.subagentsExecutor ?? sources.global?.subagentsExecutor;
}

/**
 * The raw gate policy from settings (project over global), for config.ts's
 * validator. The project value replaces the global one whole: two files
 * merged tier by tier would hide which file set a gate's mode.
 */
export function settingsPolicy(location: SettingsLocation = {}): string | undefined {
  const sources = workgraphSettings(location);
  return sources.project?.policy ?? sources.global?.policy;
}

/**
 * The raw `check` block from settings (project over global), for config.ts's
 * validator. The project block replaces the global one whole, as the policy
 * does.
 */
export function settingsCheck(location: SettingsLocation = {}): string | undefined {
  const sources = workgraphSettings(location);
  return sources.project?.check ?? sources.global?.check;
}

/** The store policy from settings (project over global), if either sets it. */
export function settingsStore(location: SettingsLocation = {}): string | undefined {
  const sources = workgraphSettings(location);
  return sources.project?.store ?? sources.global?.store;
}
