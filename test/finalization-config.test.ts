import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.ts";
import { parseFinalizationResult } from "../src/finalization.ts";
import piWorkgraph from "../src/index.ts";
import { checkIndependence, resolvePolicy } from "../src/policy.ts";
import { asExtensionAPI, makeMockPi } from "./helpers/mock-pi.ts";

describe("generic workflow configuration", () => {
  it("keeps inherited workgraph tools from starting a scheduler in Pi executor children", () => {
    const previous = process.env.PI_SUBAGENT_RUN_ID;
    process.env.PI_SUBAGENT_RUN_ID = "test-child";
    try {
      const mock = makeMockPi();
      piWorkgraph(asExtensionAPI(mock));
      expect(mock.tools.size).toBeGreaterThan(0);
      expect(mock.handlers.has("agent_settled")).toBe(false);
      expect(mock.handlers.has("session_start")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
      else process.env.PI_SUBAGENT_RUN_ID = previous;
    }
  });
  it("round trips arbitrary finalizer instructions and per-role skill names", () => {
    const mock = makeMockPi();
    mock.setFlag(
      "workgraph-finalization",
      JSON.stringify({ instructions: "Export the result", timeoutMs: 42000 }),
    );
    mock.setFlag(
      "workgraph-subagents-executor",
      JSON.stringify({
        enabled: true,
        routes: { planned: { finalizer: "exporter" } },
        options: {
          planner: { model: "vendor/model" },
          finalizer: { skills: ["custom-export"] },
        },
      }),
    );
    const config = resolveConfig(asExtensionAPI(mock));
    expect(config.finalization).toEqual({
      instructions: "Export the result",
      timeoutMs: 42000,
    });
    expect(config.subagentsExecutor?.options?.finalizer?.skills).toEqual([
      "custom-export",
    ]);
    expect(config.subagentsExecutor?.routes?.planned?.finalizer).toBe(
      "exporter",
    );
  });

  it.each([
    "{}",
    "not json",
    '{"instructions":""}',
    '{"instructions":"Export","timeoutMs":-1}',
  ])(
    "fails startup for invalid finalization instead of silently disabling it (%s)",
    (value) => {
      const mock = makeMockPi();
      mock.setFlag("workgraph-finalization", value);
      expect(() => resolveConfig(asExtensionAPI(mock))).toThrow();
    },
  );

  it("keeps domain-specific result data opaque", () => {
    const result = {
      outcome: "success",
      summary: "Exported",
      data: { destination: "arbitrary-system", receipt: [42] },
    };
    expect(parseFinalizationResult(result)).toEqual(result);
    expect(() => parseFinalizationResult({ outcome: "success" })).toThrow();
  });

  it("allows the same provider by default while preserving explicit provider independence", () => {
    const input = {
      author: { harness: "test", model: "first", provider: "vendor" },
      reviewer: { harness: "test", model: "second", provider: "vendor" },
    };
    expect(checkIndependence(input, resolvePolicy("medium")).independent).toBe(
      true,
    );
    expect(
      checkIndependence(
        input,
        resolvePolicy("medium", {
          medium: {
            requireAuthorIndependence: { model: true, provider: true },
          },
        }),
      ).independent,
    ).toBe(false);
  });
});
