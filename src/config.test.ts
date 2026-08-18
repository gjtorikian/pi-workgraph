import { describe, expect, it } from "vitest";
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
