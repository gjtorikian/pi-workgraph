import { afterEach, describe, expect, it } from "vitest";
import {
  describeTiers,
  matchModels,
  parseTiersValue,
  pickNewest,
  resolveTiers,
  resolvedTiers,
  setResolvedTiers,
  tierFor,
} from "./tiers.ts";

function model(provider: string, id: string) {
  return { provider, id, name: id } as never;
}

const REGISTRY = {
  getAvailable: () => [
    model("anthropic", "claude-opus-4-1"),
    model("anthropic", "claude-opus-4-7"),
    model("anthropic", "claude-opus-5"),
    model("anthropic", "claude-opus-5-20260101"),
    model("anthropic", "claude-sonnet-4-5"),
    model("anthropic", "claude-haiku-4-5"),
    model("openai", "gpt-5"),
  ],
};

afterEach(() => setResolvedTiers(undefined));

describe("parseTiersValue", () => {
  it("accepts JSON with string or object specs and drops unknown roles/levels", () => {
    const tiers = parseTiersValue(
      '{"planner":"anthropic/claude-opus-*","implementer":{"model":"openai/gpt-5","thinking":"low"},"reviewer":{"model":"x","thinking":"bogus"},"mystery":"y","verifier":{}}',
    );
    expect(tiers).toEqual({
      planner: { model: "anthropic/claude-opus-*" },
      implementer: { model: "openai/gpt-5", thinking: "low" },
      reviewer: { model: "x" },
    });
  });

  it("returns undefined for off, garbage, and empty tables", () => {
    expect(parseTiersValue("off")).toBeUndefined();
    expect(parseTiersValue("not json")).toBeUndefined();
    expect(parseTiersValue("[1]")).toBeUndefined();
    expect(parseTiersValue('{"mystery":"y"}')).toBeUndefined();
  });
});

describe("resolution", () => {
  it("matches provider/id globs or bare ids", () => {
    const models = REGISTRY.getAvailable();
    expect(matchModels(models, "anthropic/claude-opus-*").map((m) => m.id)).toEqual([
      "claude-opus-4-1",
      "claude-opus-4-7",
      "claude-opus-5",
      "claude-opus-5-20260101",
    ]);
    expect(matchModels(models, "gpt-5").map((m) => m.provider)).toEqual(["openai"]);
    expect(matchModels(models, "anthropic/claude-sonnet-4-5")).toHaveLength(1);
    expect(matchModels(models, "mistral/*")).toEqual([]);
  });

  it("picks the newest match: highest version tuple, shorter id on a tie", () => {
    const models = REGISTRY.getAvailable();
    expect(pickNewest(matchModels(models, "anthropic/claude-opus-*"))?.id).toBe("claude-opus-5");
    expect(pickNewest(matchModels(models, "anthropic/claude-opus-4*"))?.id).toBe("claude-opus-4-7");
    expect(pickNewest([])).toBeUndefined();
  });

  it("resolves a roster and reports unresolved roles", () => {
    const { resolved, unresolved } = resolveTiers(REGISTRY, {
      planner: { model: "anthropic/claude-opus-*", thinking: "high" },
      implementer: { model: "anthropic/claude-sonnet-*", thinking: "medium" },
      reviewer: { model: "anthropic/claude-opus-*", thinking: "high" },
      revision: { model: "anthropic/claude-sonnet-*", thinking: "medium" },
      verifier: { model: "mistral/*" },
    });
    expect(resolved.planner).toMatchObject({ id: "anthropic/claude-opus-5", thinking: "high" });
    expect(resolved.implementer).toMatchObject({ id: "anthropic/claude-sonnet-4-5", thinking: "medium" });
    expect(resolved.reviewer).toMatchObject({ id: "anthropic/claude-opus-5", thinking: "high" });
    expect(unresolved).toEqual([{ role: "verifier", pattern: "mistral/*" }]);
    expect(describeTiers(resolved)).toEqual([
      "planner: anthropic/claude-opus-5 (thinking high)",
      "implementer: anthropic/claude-sonnet-4-5 (thinking medium)",
      "reviewer: anthropic/claude-opus-5 (thinking high)",
      "revision: anthropic/claude-sonnet-4-5 (thinking medium)",
    ]);
  });

  it("the session-wide table answers tierFor by role and nothing for unknown roles", () => {
    expect(tierFor("planner")).toBeUndefined();
    const { resolved } = resolveTiers(REGISTRY, { planner: { model: "openai/gpt-5" } });
    setResolvedTiers(resolved);
    expect(resolvedTiers()).toBe(resolved);
    expect(tierFor("planner")?.id).toBe("openai/gpt-5");
    expect(tierFor("implementer")).toBeUndefined();
    expect(tierFor("nonsense")).toBeUndefined();
  });
});
