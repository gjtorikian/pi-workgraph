/**
 * The judgment-gate policy engine: pure functions over config + reported
 * provenance. The policy owns gate mode, author independence, and revision
 * bounds — model routing and credentials stay OUTSIDE it (decision log):
 * executors report effective provenance and the coordinator only validates
 * what was reported.
 *
 * The knob set is deliberately trimmed to what a criterion exercises
 * (decision log): gate mode per risk tier, author independence, max
 * revisions, and escalation behavior. Minimum reviewer count and
 * fresh-context requirements land with the stretch reviewer work — a
 * setting with one exercised value is a constant.
 *
 * TRUST BOUNDARY (plan §15, acknowledged in the README): an executor can
 * lie about provenance. `executionId` equality is checked as a floor — a
 * reviewer completion reusing the author's execution is never independent,
 * which is what makes a future self-accepting adapter safe by construction
 * — but full trust requires scoped authz, out of scope here.
 */

export type RiskTier = "low" | "medium" | "high";

export type GateMode = "advisory" | "blocking";

/** Which provenance axes the reviewer must differ from the author on. */
export interface IndependenceRequirement {
  model?: boolean;
  provider?: boolean;
}

export interface GatePolicy {
  /** `blocking`: blocking findings gate continuation. `advisory`: recorded only. */
  gateMode: GateMode;
  /** Empty object = no provenance independence required (executionId floor
   *  still applies). */
  requireAuthorIndependence: IndependenceRequirement;
  /** Maximum revision runs before escalation. */
  maxRevisions: number;
  /** What escalation does; `block` = bd status blocked + phase escalated. */
  escalate: "block";
}

export type PolicyConfig = Record<RiskTier, GatePolicy>;

/** Config-surface shape: any subset of tiers, any subset of knobs. */
export type PolicyOverrides = Partial<Record<RiskTier, Partial<GatePolicy>>>;

/** Risk tier assumed for issues approved without one. */
export const DEFAULT_RISK_TIER: RiskTier = "medium";

/** Defaults: low = advisory; medium/high = blocking with independence. */
export const DEFAULT_POLICY: PolicyConfig = {
  low: {
    gateMode: "advisory",
    requireAuthorIndependence: {},
    maxRevisions: 3,
    escalate: "block",
  },
  medium: {
    gateMode: "blocking",
    requireAuthorIndependence: { model: true, provider: true },
    maxRevisions: 3,
    escalate: "block",
  },
  high: {
    gateMode: "blocking",
    requireAuthorIndependence: { model: true, provider: true },
    maxRevisions: 3,
    escalate: "block",
  },
};

function isRiskTier(raw: string | undefined): raw is RiskTier {
  return raw === "low" || raw === "medium" || raw === "high";
}

/**
 * The effective policy for an issue's risk tier. An unknown or missing tier
 * resolves to {@link DEFAULT_RISK_TIER} (medium — the conservative default:
 * blocking gate with author independence). Per-tier overrides merge over
 * the defaults, so a partial config never drops a knob.
 */
export function resolvePolicy(
  riskTier: string | undefined,
  config?: PolicyOverrides,
): GatePolicy {
  const tier = isRiskTier(riskTier) ? riskTier : DEFAULT_RISK_TIER;
  const base = DEFAULT_POLICY[tier];
  const override = config?.[tier];
  if (!override) return base;
  return {
    gateMode: override.gateMode ?? base.gateMode,
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
