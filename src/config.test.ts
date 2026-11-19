import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.ts";
import { asExtensionAPI, makeMockPi } from "../test/helpers/mock-pi.ts";

describe("subagents routing config", () => {
  it("parses non-empty named-profile routes and drops malformed entries", () => {
    const mock = makeMockPi();
    mock.setFlag(
      "workgraph-subagents-executor",
      JSON.stringify({
        enabled: true,
        versionRange: "0.34",
        routes: {
          oneshot: { implementer: " economy-worker ", reviewer: 42 },
          reviewed: { implementer: "worker", reviewer: "reviewer" },
          unknown: { implementer: "ignored" },
        },
      }),
    );

    expect(resolveConfig(asExtensionAPI(mock)).subagentsExecutor).toEqual({
      enabled: true,
      versionRange: "0.34",
      routes: {
        oneshot: { implementer: "economy-worker" },
        reviewed: { implementer: "worker", reviewer: "reviewer" },
      },
    });
  });
});

describe("compaction reasoning level config", () => {
  const FLAG = "workgraph-compaction-reasoning-level";
  const ENV = "WORKGRAPH_COMPACTION_REASONING_LEVEL";
  let previousEnv: string | undefined;

  beforeEach(() => {
    previousEnv = process.env[ENV];
    delete process.env[ENV];
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = previousEnv;
    vi.restoreAllMocks();
  });

  it("is unset by default", () => {
    const mock = makeMockPi();

    expect(
      resolveConfig(asExtensionAPI(mock)).compactionReasoningLevel,
    ).toBeUndefined();
  });

  it("parses the flag case-insensitively", () => {
    const mock = makeMockPi();
    mock.setFlag(FLAG, " Low ");

    expect(resolveConfig(asExtensionAPI(mock)).compactionReasoningLevel).toBe(
      "low",
    );
  });

  it("falls back to the environment variable, and the flag wins over it", () => {
    const mock = makeMockPi();
    process.env[ENV] = "off";

    expect(resolveConfig(asExtensionAPI(mock)).compactionReasoningLevel).toBe(
      "off",
    );

    mock.setFlag(FLAG, "minimal");

    expect(resolveConfig(asExtensionAPI(mock)).compactionReasoningLevel).toBe(
      "minimal",
    );
  });

  it("ignores an unknown level and says so", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = makeMockPi();
    mock.setFlag(FLAG, "hgih");

    expect(
      resolveConfig(asExtensionAPI(mock)).compactionReasoningLevel,
    ).toBeUndefined();
    expect(logged.mock.calls.map((args) => args.join(" "))).toEqual([
      expect.stringContaining(`${FLAG}/${ENV} value "hgih"`),
    ]);
  });
});
