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
 *       "planApproval": "required"                 // or "auto"
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
  /** Per-role executor pins, e.g. { planner: "in-session", implementer: "pi-subagents" }. */
  executors?: Record<string, string>;
  /** The pi-subagents bridge block, as config.ts parses it: `true` or `{ enabled, routes, options, versionRange }`. */
  subagentsExecutor?: string;
  /** Where databases live: "repo" (default), "central" (~/.pi/agent/workgraph), or an absolute directory. */
  store?: string;
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
  if (record.planApproval === "required" || record.planApproval === "auto") {
    out.planApproval = record.planApproval;
  } else if (record.planApproval !== undefined) {
    console.error(
      `[pi-workgraph] settings: planApproval must be "required" or "auto", got ${JSON.stringify(record.planApproval)}`,
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

/** Roles an executor pin may name (the protocol's role vocabulary). */
export const PINNABLE_ROLES = [
  "planner",
  "implementer",
  "reviewer",
  "revision",
  "verifier",
  "finalizer",
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

/** The store policy from settings (project over global), if either sets it. */
export function settingsStore(location: SettingsLocation = {}): string | undefined {
  const sources = workgraphSettings(location);
  return sources.project?.store ?? sources.global?.store;
}
