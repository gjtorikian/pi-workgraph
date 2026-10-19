/**
 * Model tiers: a role → model routing table that executor adapters consult,
 * so one setting ("the planner thinks with the strong model, the builder
 * types with the fast one, the reviewer is independent of the builder")
 * applies to whichever executor ends up running a role.
 *
 * The CORE still does no model routing: the coordinator selects executors
 * by role and validates REPORTED provenance (src/policy.ts). Tiers are data
 * the adapters read — the in-session executor switches the session model
 * for the duration of a run, and the pi-subagents bridge passes the tier as
 * the per-role launch model unless an explicit per-role option overrides it.
 *
 * Specs name models as `provider/id` strings and may use `*` globs. Globs
 * resolve against the session's model registry at `session_start`; among
 * several matches the NEWEST wins, where "newest" means the highest numeric
 * version tuple in the id (`claude-opus-5` beats `claude-opus-4-7`), with
 * the shorter id breaking ties (an undated alias over its dated twin). A
 * role whose spec matches nothing is reported and left untiered — the run
 * then uses whatever model the executor would have used anyway.
 */
import type { Model } from "@earendil-works/pi-ai";
import { getSetting, setSetting } from "./store.ts";

export const TIER_ROLES = [
  "planner",
  "implementer",
  "reviewer",
  "revision",
  "verifier",
  "finalizer",
  // Reserved: the read-only research helper ("who searches"). Accepted in
  // tables today so a roster can name it; dispatched once the role lands.
  "scout",
] as const;
export type TierRole = (typeof TIER_ROLES)[number];

/** Pi thinking levels plus `off`; validated, never interpreted here. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type TierThinking = (typeof THINKING_LEVELS)[number];

export interface TierSpec {
  /** `provider/id`, with optional `*` globs (resolved against the registry). */
  model: string;
  thinking?: TierThinking;
}

export type TierConfig = Partial<Record<TierRole, TierSpec>>;

function isTierRole(raw: string): raw is TierRole {
  return (TIER_ROLES as readonly string[]).includes(raw);
}

function isThinking(raw: unknown): raw is TierThinking {
  return typeof raw === "string" && (THINKING_LEVELS as readonly string[]).includes(raw);
}

/**
 * Parse a flag/env/settings value: JSON mapping roles to either a model
 * string or `{ model, thinking }` (`off` clears). There are no built-in
 * presets — which models play which role is the user's roster, declared in
 * their settings, never hardcoded here. An unset `thinking` is not "off":
 * it inherits the session's current level in-session (often a global
 * default such as `max`) or the launched profile's default in pi-subagents. Returns undefined (after logging)
 * for anything unusable; an unknown role or thinking level is dropped, not
 * fatal, so a partially-right table still routes what it can.
 */
export function parseTiersValue(raw: string): TierConfig | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  if (["off", "false", "0", "none"].includes(lowered)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    console.error(
      `[pi-workgraph] ignoring workgraph-tiers value "${trimmed}": not JSON (expected a role → model table)`,
    );
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("[pi-workgraph] ignoring workgraph-tiers value: expected a JSON object");
    return undefined;
  }
  const config: TierConfig = {};
  for (const [role, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isTierRole(role)) {
      console.error(`[pi-workgraph] workgraph-tiers: unknown role "${role}" ignored`);
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      config[role] = { model: value.trim() };
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.model !== "string" || !record.model.trim()) {
        console.error(`[pi-workgraph] workgraph-tiers: role "${role}" needs a model`);
        continue;
      }
      const spec: TierSpec = { model: record.model.trim() };
      if (record.thinking !== undefined) {
        if (isThinking(record.thinking)) spec.thinking = record.thinking;
        else
          console.error(
            `[pi-workgraph] workgraph-tiers: role "${role}" has an unknown thinking level "${String(record.thinking)}" — ignored`,
          );
      }
      config[role] = spec;
    }
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

// ---------------------------------------------------------------------------
// Resolution against the registry
// ---------------------------------------------------------------------------

/** The registry surface this module needs (the real one is Pi's ModelRegistry). */
export interface TierRegistry {
  getAvailable(): Model<any>[];
}

export interface ResolvedTier {
  role: TierRole;
  /** The spec the tier came from. */
  pattern: string;
  model: Model<any>;
  /** `provider/id` of the resolved model — what adapters pass along. */
  id: string;
  thinking?: TierThinking;
}

export type ResolvedTiers = Partial<Record<TierRole, ResolvedTier>>;

export interface ResolveResult {
  resolved: ResolvedTiers;
  /** Roles whose spec matched no available model. */
  unresolved: { role: TierRole; pattern: string }[];
}

function qualifiedId(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Every available model whose `provider/id` (or bare id) matches `pattern`. */
export function matchModels(models: readonly Model<any>[], pattern: string): Model<any>[] {
  const re = globToRegExp(pattern);
  const qualified = pattern.includes("/");
  return models.filter((m) => re.test(qualified ? qualifiedId(m) : m.id));
}

function versionTuple(id: string): number[] {
  return (id.match(/\d+/g) ?? []).map(Number);
}

function compareNewest(a: Model<any>, b: Model<any>): number {
  const ta = versionTuple(a.id);
  const tb = versionTuple(b.id);
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    if (ta[i] !== tb[i]) return tb[i]! - ta[i]!; // higher first
  }
  // Same prefix: the shorter id (undated alias) first, then stable by id.
  if (a.id.length !== b.id.length) return a.id.length - b.id.length;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The newest of several matches (see the module header for the rule). */
export function pickNewest(models: readonly Model<any>[]): Model<any> | undefined {
  if (models.length === 0) return undefined;
  return [...models].sort(compareNewest)[0];
}

export function resolveTiers(registry: TierRegistry, config: TierConfig): ResolveResult {
  const available = registry.getAvailable();
  const resolved: ResolvedTiers = {};
  const unresolved: ResolveResult["unresolved"] = [];
  for (const role of TIER_ROLES) {
    const spec = config[role];
    if (!spec) continue;
    const model = pickNewest(matchModels(available, spec.model));
    if (!model) {
      unresolved.push({ role, pattern: spec.model });
      continue;
    }
    resolved[role] = {
      role,
      pattern: spec.model,
      model,
      id: qualifiedId(model),
      ...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}),
    };
  }
  return { resolved, unresolved };
}

// ---------------------------------------------------------------------------
// Session-wide resolved table (set once at session_start; adapters read it)
// ---------------------------------------------------------------------------

let current: ResolvedTiers | undefined;

export function setResolvedTiers(tiers: ResolvedTiers | undefined): void {
  current = tiers;
}

export function resolvedTiers(): ResolvedTiers | undefined {
  return current;
}

/** The resolved tier for a role, if any. Unknown roles are untiered. */
export function tierFor(role: string): ResolvedTier | undefined {
  return isTierRole(role) ? current?.[role] : undefined;
}

/** One line per role, for `/workgraph tiers` and the session_start notice. */
export function describeTiers(tiers: ResolvedTiers): string[] {
  return TIER_ROLES.filter((role) => tiers[role]).map((role) => {
    const tier = tiers[role]!;
    return `${role}: ${tier.id}${tier.thinking ? ` (thinking ${tier.thinking})` : ""}`;
  });
}

// ---------------------------------------------------------------------------
// Per-workspace persistence: a workgraph_tiers call is remembered
// in the repository's store and reloaded at session_start. The CLI flag and
// environment variable, when present, still win — they are the headless and
// CI overrides.
// ---------------------------------------------------------------------------

export const TIERS_SETTING_KEY = "tiers";

/** The tier table stored for this workspace, if any. */
export async function loadStoredTiers(cwd: string): Promise<TierConfig | undefined> {
  let raw: string | undefined;
  try {
    raw = await getSetting(cwd, TIERS_SETTING_KEY);
  } catch {
    return undefined; // no workspace here
  }
  return raw === undefined ? undefined : parseTiersValue(raw);
}

/** Persist (or with undefined, clear) the tier table for this workspace. */
export async function storeTiers(cwd: string, config: TierConfig | undefined): Promise<void> {
  await setSetting(cwd, TIERS_SETTING_KEY, config === undefined ? null : JSON.stringify(config));
}
