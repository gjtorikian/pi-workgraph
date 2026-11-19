import type { compact } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCompactionTakeover } from "./compaction.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockPi,
} from "../test/helpers/mock-pi.ts";

const FLAG = "workgraph-compaction-reasoning-level";
const ENV = "WORKGRAPH_COMPACTION_REASONING_LEVEL";
/** `compact()`'s thinking level is its seventh positional argument. */
const THINKING_LEVEL_ARG = 6;

describe("compaction takeover reasoning level", () => {
  let mock: MockPi;
  let previousEnv: string | undefined;
  const thinkingLevels: unknown[] = [];

  /** Run one compaction in a session at `sessionLevel`; report what `compact()` was handed. */
  async function compactAt(sessionLevel: string | undefined): Promise<unknown> {
    const { ctx } = makeEventContext("/nonexistent", {
      model: {},
      thinkingLevel: sessionLevel,
    });
    const { takenOver } = await mock.simulateForcedCompaction(ctx);
    expect(takenOver).toBe(true);
    return thinkingLevels.at(-1);
  }

  beforeEach(() => {
    previousEnv = process.env[ENV];
    delete process.env[ENV];
    thinkingLevels.length = 0;
    mock = makeMockPi();
    const fakeCompact = (async (...args: unknown[]) => {
      thinkingLevels.push(args[THINKING_LEVEL_ARG]);
      return {
        summary: "fake summary",
        firstKeptEntryId: "entry-0",
        tokensBefore: 9000,
      };
    }) as unknown as typeof compact;
    // Registered BEFORE any flag is set, as at extension load.
    registerCompactionTakeover(asExtensionAPI(mock), {
      compactFn: fakeCompact,
      getCurrent: () => ({ issueId: "wg-1" }),
    });
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = previousEnv;
    vi.restoreAllMocks();
  });

  it("keeps the session's thinking level when the option is unset", async () => {
    expect(await compactAt("high")).toBe("high");
  });

  it("honors a flag that only becomes readable after registration", async () => {
    mock.setFlag(FLAG, "low");

    expect(await compactAt("high")).toBe("low");
  });

  it("honors the environment variable", async () => {
    process.env[ENV] = "off";

    expect(await compactAt("xhigh")).toBe("off");
  });

  it("re-reads the option on every compaction", async () => {
    mock.setFlag(FLAG, "low");
    expect(await compactAt("high")).toBe("low");

    mock.setFlag(FLAG, undefined);
    expect(await compactAt("high")).toBe("high");
  });

  it("falls back to the session's level for an unknown value", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mock.setFlag(FLAG, "hgih");

    expect(await compactAt("medium")).toBe("medium");
  });
});
