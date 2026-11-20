/**
 * The shared test config, and the policy that pins suites written before
 * the proof gates to the behavior they were written against.
 *
 * WHY THIS EXISTS. The shipped defaults enforce every gate at the default
 * medium tier. Suites that predate the gates run on scratch directories
 * with no git repository and assert on the judgment loop alone, so under
 * the shipped defaults they would start failing as each gate gains a real
 * check. `PRE_PROOF_POLICY` sets the six gates that had no behavior to
 * `off` and leaves `review` at its tier default, which is exactly the old
 * `gateMode` (low observes, medium and high enforce).
 *
 * HOW TO USE IT. No suite writes a `WorkgraphConfig` literal of its own;
 * `grep -ln "WorkgraphConfig = {" test src` must name this file only.
 *
 *  - A suite that predates the gates builds every config through
 *    {@link preProofConfig}.
 *  - A suite that tests the gates themselves builds through
 *    {@link shippedConfig}: the same timers with NO policy pin, so it runs
 *    on the shipped defaults unless a case sets modes explicitly.
 */
import type { WorkgraphConfig } from "../../src/config.ts";
import type { PolicyOverrides, RiskTier } from "../../src/policy.ts";

/**
 * The timers every suite repeats: huge scheduling intervals, so no timer
 * fires mid-test and ticks are event-driven, and tiny REAL protocol
 * timeouts, so bounded discovery and accept waits resolve fast. No policy:
 * a config spread from this alone runs on the shipped defaults.
 */
export const BASE_TEST_CONFIG: WorkgraphConfig = {
  leaseTtlMs: 300_000,
  heartbeatMs: 600_000,
  pollMs: 600_000,
  sweepIntervalMs: 600_000,
  discoveryTimeoutMs: 40,
  acceptTimeoutMs: 150,
  compatInSessionExecutor: false,
};

/**
 * A config for a suite that tests the gates themselves: the base timers and
 * the suite's own keys, with no policy pin. Whatever `overrides.policy` says
 * is the whole override, exactly as a user's flag or settings would be.
 */
export function shippedConfig(
  overrides: Partial<WorkgraphConfig> = {},
): WorkgraphConfig {
  return { ...BASE_TEST_CONFIG, ...overrides };
}

const OFF = {
  "tree-binding": "off",
  check: "off",
  "criteria-evidence": "off",
  "weakened-tests": "off",
  "unproven-tests": "off",
  scope: "off",
} as const;

/** Today's behavior: only the review gate exists, at its default mode per tier. */
export const PRE_PROOF_POLICY: PolicyOverrides = {
  low: { gates: OFF },
  medium: { gates: OFF },
  high: { gates: OFF },
};

const TIERS: readonly RiskTier[] = ["low", "medium", "high"];

/**
 * `over` merged onto `base` tier by tier, and `gates` gate by gate — the
 * same shape `resolvePolicy` merges overrides onto the defaults with. A
 * plain spread would let `{ high: { maxRevisions: 1 } }` drop the whole
 * high tier of `base`.
 */
export function mergePolicy(
  base: PolicyOverrides,
  over: PolicyOverrides | undefined,
): PolicyOverrides {
  if (!over) return base;
  const merged: PolicyOverrides = {};
  for (const tier of TIERS) {
    const b = base[tier];
    const o = over[tier];
    if (!b && !o) continue;
    const gates = { ...b?.gates, ...o?.gates };
    merged[tier] = {
      ...b,
      ...o,
      ...(Object.keys(gates).length > 0 ? { gates } : {}),
    };
  }
  return merged;
}

/**
 * A config for a suite that predates the proof gates: the base timers, the
 * suite's own keys, and `PRE_PROOF_POLICY` with the suite's `policy` (if
 * any) merged over it per tier and per gate. Safe to re-apply to its own
 * output, so a harness can pass `{ ...CONFIG, ...overrides }` and an
 * override's `policy` still keeps the pin instead of replacing it.
 */
export function preProofConfig(
  overrides: Partial<WorkgraphConfig> = {},
): WorkgraphConfig {
  return {
    ...BASE_TEST_CONFIG,
    ...overrides,
    policy: mergePolicy(PRE_PROOF_POLICY, overrides.policy),
  };
}
