/**
 * The judgment-gate policy engine: pure functions over config + reported
 * provenance. The policy owns gate modes, author independence, and revision
 * bounds — model routing and credentials stay OUTSIDE it (decision log):
 * executors report effective provenance and the coordinator only validates
 * what was reported.
 *
 * GATES. A policy names seven gates and gives each a mode per risk tier:
 * `off` (not evaluated, nothing recorded), `observe` (evaluated and
 * recorded, never blocks) or `enforce` (evaluated, recorded, and blocks).
 * Two have an evaluation today: `review` (the reviewer's blocking findings)
 * and `tree-binding` (the work is bound to a base tree and a result tree,
 * `src/snapshot.ts`). The other five are declared, defaulted and validated
 * here so that a later check only adds an evaluation, never a config
 * surface. What a gate
 * result means, and when it blocks, lives in `src/proof.ts`.
 *
 * The remaining knobs are deliberately trimmed to what a criterion exercises
 * (decision log): author independence, max revisions, and escalation
 * behavior. Minimum reviewer count and fresh-context requirements land with
 * the stretch reviewer work — a setting with one exercised value is a
 * constant.
 *
 * VALIDATION. A policy comes from a flag, an environment variable or a
 * settings file, so {@link validatePolicyOverrides} checks every tier, knob,
 * gate and mode and throws {@link PolicyConfigError} naming the first bad
 * one. An invalid policy never degrades to the defaults: a typo in a gate
 * name would otherwise leave that gate at a mode nobody chose.
 *
 * TRUST BOUNDARY (plan §15, acknowledged in the README): an executor can
 * lie about provenance. `executionId` equality is checked as a floor — a
 * reviewer completion reusing the author's execution is never independent,
 * which is what makes a future self-accepting adapter safe by construction
 * — but full trust requires scoped authz, out of scope here.
 */

export type RiskTier = "low" | "medium" | "high";

const RISK_TIERS: readonly RiskTier[] = ["low", "medium", "high"];

/** Every gate a policy can set a mode for, in report order. */
export const GATES = [
  "review",
  "tree-binding",
  "check",
  "criteria-evidence",
  "weakened-tests",
  "unproven-tests",
  "scope",
] as const;
export type GateName = (typeof GATES)[number];

/** `off`: not evaluated. `observe`: recorded, never blocks. `enforce`: blocks. */
export type GateModeT = "off" | "observe" | "enforce";

const GATE_MODES: readonly GateModeT[] = ["off", "observe", "enforce"];

export type GateModes = Record<GateName, GateModeT>;

/** Which provenance axes the reviewer must differ from the author on. */
export interface IndependenceRequirement {
  model?: boolean;
  provider?: boolean;
}

export interface GatePolicy {
  /** The mode of every gate at this tier. */
  gates: GateModes;
  /** Empty object = no provenance independence required (executionId floor
   *  still applies). */
  requireAuthorIndependence: IndependenceRequirement;
  /** Maximum revision runs before escalation. */
  maxRevisions: number;
  /** What escalation does; `block` = store status blocked + phase escalated. */
  escalate: "block";
}

export type PolicyConfig = Record<RiskTier, GatePolicy>;

/** Config-surface shape: any subset of tiers, any subset of knobs and gates. */
export type PolicyOverrides = Partial<
  Record<
    RiskTier,
    Partial<Omit<GatePolicy, "gates">> & { gates?: Partial<GateModes> }
  >
>;

/** Risk tier assumed for issues approved without one. */
export const DEFAULT_RISK_TIER: RiskTier = "medium";

/** A tier's gate map: one mode for `check`, one for the other six. */
function tierGates(check: GateModeT, others: GateModeT): GateModes {
  return {
    review: others,
    "tree-binding": others,
    check,
    "criteria-evidence": others,
    "weakened-tests": others,
    "unproven-tests": others,
    scope: others,
  };
}

/**
 * Defaults: `check` enforces at every tier; the other six gates enforce at
 * medium and high and observe at low. Medium and high also require author
 * independence on the model axis.
 */
export const DEFAULT_POLICY: PolicyConfig = {
  low: {
    gates: tierGates("enforce", "observe"),
    requireAuthorIndependence: {},
    maxRevisions: 3,
    escalate: "block",
  },
  medium: {
    gates: tierGates("enforce", "enforce"),
    requireAuthorIndependence: { model: true },
    maxRevisions: 3,
    escalate: "block",
  },
  high: {
    gates: tierGates("enforce", "enforce"),
    requireAuthorIndependence: { model: true },
    maxRevisions: 3,
    escalate: "block",
  },
};

function isRiskTier(raw: string | undefined): raw is RiskTier {
  return raw === "low" || raw === "medium" || raw === "high";
}

/** Thrown when a policy override does not validate. The message names the key. */
export class PolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyConfigError";
  }
}

const POLICY_KNOBS = [
  "gates",
  "requireAuthorIndependence",
  "maxRevisions",
  "escalate",
] as const;

const INDEPENDENCE_AXES = ["model", "provider"] as const;

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

/** `a, b or c`, for the "expected ..." half of a validation message. */
function oneOf(names: readonly string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** The rejected value, for the "got ..." half of a validation message. */
function received(raw: unknown): string {
  if (Array.isArray(raw)) return "an array";
  if (raw !== null && typeof raw === "object") return "an object";
  return typeof raw === "string" ? JSON.stringify(raw) : String(raw);
}

function validateGates(path: string, raw: unknown): Partial<GateModes> {
  if (!isPlainObject(raw)) {
    throw new PolicyConfigError(
      `${path} must be an object of gate modes, got ${received(raw)}`,
    );
  }
  const gates: Partial<GateModes> = {};
  for (const [name, mode] of Object.entries(raw)) {
    const gate = GATES.find((candidate) => candidate === name);
    if (gate === undefined) {
      throw new PolicyConfigError(
        `${path}.${name} is not a gate (expected ${oneOf(GATES)})`,
      );
    }
    const known = GATE_MODES.find((candidate) => candidate === mode);
    if (known === undefined) {
      throw new PolicyConfigError(
        `${path}.${name} must be ${oneOf(GATE_MODES.map((m) => `"${m}"`))}, got ${received(mode)}`,
      );
    }
    gates[gate] = known;
  }
  return gates;
}

function validateIndependence(
  path: string,
  raw: unknown,
): IndependenceRequirement {
  if (!isPlainObject(raw)) {
    throw new PolicyConfigError(
      `${path} must be an object with ${oneOf(INDEPENDENCE_AXES)}, got ${received(raw)}`,
    );
  }
  const requirement: IndependenceRequirement = {};
  for (const [name, value] of Object.entries(raw)) {
    const axis = INDEPENDENCE_AXES.find((candidate) => candidate === name);
    if (axis === undefined) {
      throw new PolicyConfigError(
        `${path}.${name} is not a provenance axis (expected ${oneOf(INDEPENDENCE_AXES)})`,
      );
    }
    if (typeof value !== "boolean") {
      throw new PolicyConfigError(
        `${path}.${name} must be true or false, got ${received(value)}`,
      );
    }
    requirement[axis] = value;
  }
  return requirement;
}

/**
 * Validate a policy override as it arrives from a flag, an environment
 * variable or a settings file. Returns a copy holding only what validated.
 * Throws {@link PolicyConfigError} naming the first invalid tier, knob, gate
 * or mode.
 */
export function validatePolicyOverrides(raw: unknown): PolicyOverrides {
  if (!isPlainObject(raw)) {
    throw new PolicyConfigError(
      `policy must be an object keyed by risk tier (${oneOf(RISK_TIERS)}), got ${received(raw)}`,
    );
  }
  const overrides: PolicyOverrides = {};
  for (const [tierName, tierRaw] of Object.entries(raw)) {
    const tier = RISK_TIERS.find((candidate) => candidate === tierName);
    if (tier === undefined) {
      throw new PolicyConfigError(
        `policy.${tierName} is not a risk tier (expected ${oneOf(RISK_TIERS)})`,
      );
    }
    const path = `policy.${tier}`;
    if (!isPlainObject(tierRaw)) {
      throw new PolicyConfigError(
        `${path} must be an object of policy knobs, got ${received(tierRaw)}`,
      );
    }
    const override: NonNullable<PolicyOverrides[RiskTier]> = {};
    for (const [knob, value] of Object.entries(tierRaw)) {
      switch (knob) {
        case "gateMode":
          throw new PolicyConfigError(
            `${path}.gateMode was replaced by ${path}.gates.review ("advisory" is "observe", "blocking" is "enforce")`,
          );
        case "gates":
          override.gates = validateGates(`${path}.gates`, value);
          break;
        case "requireAuthorIndependence":
          override.requireAuthorIndependence = validateIndependence(
            `${path}.requireAuthorIndependence`,
            value,
          );
          break;
        case "maxRevisions":
          if (
            typeof value !== "number" ||
            !Number.isInteger(value) ||
            value < 0
          ) {
            throw new PolicyConfigError(
              `${path}.maxRevisions must be a whole number of 0 or more, got ${received(value)}`,
            );
          }
          override.maxRevisions = value;
          break;
        case "escalate":
          if (value !== "block") {
            throw new PolicyConfigError(
              `${path}.escalate must be "block", got ${received(value)}`,
            );
          }
          override.escalate = value;
          break;
        default:
          throw new PolicyConfigError(
            `${path}.${knob} is not a policy knob (expected ${oneOf(POLICY_KNOBS)})`,
          );
      }
    }
    overrides[tier] = override;
  }
  return overrides;
}

/**
 * The effective policy for an issue's risk tier. An unknown or missing tier
 * resolves to {@link DEFAULT_RISK_TIER} (medium — the conservative default:
 * every gate enforced, with author independence). Per-tier overrides merge
 * over the defaults knob by knob, and `gates` gate by gate, so a partial
 * config never drops a knob and an override naming one gate never drops the
 * other six.
 */
export function resolvePolicy(
  riskTier: string | undefined,
  config?: PolicyOverrides,
): GatePolicy {
  const tier = isRiskTier(riskTier) ? riskTier : DEFAULT_RISK_TIER;
  const base = DEFAULT_POLICY[tier];
  const override = config?.[tier];
  if (!override) return base;
  const gates = { ...base.gates };
  for (const gate of GATES) {
    gates[gate] = override.gates?.[gate] ?? base.gates[gate];
  }
  return {
    gates,
    requireAuthorIndependence:
      override.requireAuthorIndependence ?? base.requireAuthorIndependence,
    maxRevisions: override.maxRevisions ?? base.maxRevisions,
    escalate: override.escalate ?? base.escalate,
  };
}

/** Provenance as reported on a `run:completed` (protocol v1 shape). */
export interface ReportedProvenance {
  harness: string;
  profile?: string;
  model?: string;
  provider?: string;
}

export interface IndependenceInput {
  /** The implementation completion's provenance (the author). */
  author: ReportedProvenance | undefined;
  /** The review completion's provenance (the reviewer). */
  reviewer: ReportedProvenance | undefined;
  /** The author run's executionId, when known. */
  authorExecutionId?: string;
  /** The reviewer run's executionId, when known. */
  reviewerExecutionId?: string;
}

export interface IndependenceResult {
  independent: boolean;
  reason?: string;
}

/**
 * Whether the reviewer counts as independent judgment of the author's work.
 *
 * FAIL CLOSED: on any required axis, a missing value on either side counts
 * as a match — a reviewer that does not report its model/provider is never
 * independent under a policy that requires them. The reviewer is
 * independent when it provably differs on every required axis.
 *
 * The executionId floor applies under EVERY policy: a "review" reported
 * from the author's own execution is self-acceptance, never judgment.
 */
export function checkIndependence(
  input: IndependenceInput,
  policy: GatePolicy,
): IndependenceResult {
  if (
    input.authorExecutionId !== undefined &&
    input.authorExecutionId === input.reviewerExecutionId
  ) {
    return {
      independent: false,
      reason: `reviewer executionId ${input.reviewerExecutionId} equals the author's — self-acceptance is never independent judgment`,
    };
  }

  const required: (keyof IndependenceRequirement)[] = [];
  if (policy.requireAuthorIndependence.model) required.push("model");
  if (policy.requireAuthorIndependence.provider) required.push("provider");
  if (required.length === 0) return { independent: true };

  const matches = (axis: keyof IndependenceRequirement): boolean => {
    const a = input.author?.[axis];
    const b = input.reviewer?.[axis];
    // Fail closed: unknown provenance on a required axis counts as a match.
    if (a === undefined || b === undefined) return true;
    return a === b;
  };

  const differs = required.every((axis) => !matches(axis));
  if (differs) return { independent: true };
  return {
    independent: false,
    reason:
      `reviewer provenance does not differ from the author on every required axis ` +
      `(${required.join(", ")}) — missing values fail closed`,
  };
}
