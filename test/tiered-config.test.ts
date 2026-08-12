/**
 * Tiered-executor config resolution: the two accepted shapes and the
 * precedence chain flag → env → agent-dir file.
 *
 * The FILE is what makes tiers a property of the machine rather than of an
 * invocation — the agent dir is global, so one file governs every project
 * and every session, and nobody has to remember a CLI flag. Flag and env
 * still win, which is what a sandbox or a one-off run needs.
 *
 * The agent dir is INJECTED into `resolveConfig`, so these tests pass a
 * scratch directory directly — no process.env mutation, and no runtime
 * dependency on pi.
 *
 * Run via `npm run test:tiered-config`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetTieredConfigCacheForTest,
  resolveConfig,
  TIERED_CONFIG_REL,
} from "../src/config.ts";
import { asExtensionAPI, makeMockPi, type MockPi } from "./helpers/mock-pi.ts";

const FLAG = "workgraph-tiered-executor";
const ENV = "WORKGRAPH_TIERED_EXECUTOR";

let dir: string;
let priorEnv: string | undefined;
let mock: MockPi;

/** Write the standing config into the scratch agent dir. */
function writeStandingConfig(body: unknown): void {
  const target = join(dir, TIERED_CONFIG_REL);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, JSON.stringify(body));
}

function resolved() {
  return resolveConfig(asExtensionAPI(mock), dir).tieredExecutor;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pwg-cfg-"));
  priorEnv = process.env[ENV];
  delete process.env[ENV];
  // Each test writes a fresh file into a fresh dir; the read is cached for
  // 10 s in production, so drop it between cases.
  resetTieredConfigCacheForTest();
  mock = makeMockPi();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (priorEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = priorEnv;
});

describe("tiered config shapes", () => {
  it("accepts the models shorthand and the full roles form, and merges them", () => {
    writeStandingConfig({
      enabled: true,
      models: { planner: "m-plan", implementer: "m-impl" },
      roles: {
        // Same role in both: `roles` wins, so a config can name most tiers
        // tersely and expand only the one that needs a ruleset.
        implementer: { model: "m-impl-2", tools: ["read"] },
        reviewer: { model: "m-rev", appendSystemPrompt: "/rules.md" },
      },
    });
    const config = resolved()!;
    expect(config.roles.planner).toEqual({ model: "m-plan" });
    expect(config.roles.implementer).toEqual({ model: "m-impl-2", tools: ["read"] });
    expect(config.roles.reviewer).toEqual({
      model: "m-rev",
      appendSystemPrompt: "/rules.md",
    });
  });

  it("drops role entries with no usable model rather than offering them", () => {
    writeStandingConfig({
      enabled: true,
      models: { planner: "m-plan", broken: "" },
      roles: { alsoBroken: { tools: ["read"] }, nested: "not-an-object" },
    });
    const config = resolved()!;
    // Absence is how the not-offered safety property is enforced, so a
    // malformed entry must never become an offered role.
    expect(Object.keys(config.roles)).toEqual(["planner"]);
  });

  it("stays DISABLED when enabled with no usable roles", () => {
    writeStandingConfig({ enabled: true, models: {}, roles: {} });
    expect(resolved()).toBeUndefined();
  });

  it("is absent when the file does not exist — the shipped default", () => {
    expect(resolved()).toBeUndefined();
  });

  it("consults no file at all when no agent dir is injected", () => {
    writeStandingConfig({ enabled: true, models: { planner: "from-file" } });
    // Direct-import consumers (tests, protocol-only users) get no file
    // reads, which is what keeps config.ts free of a runtime pi dependency.
    expect(resolveConfig(asExtensionAPI(mock)).tieredExecutor).toBeUndefined();
  });

  it("ignores a malformed file rather than throwing", () => {
    mkdirSync(join(dir, "configs"), { recursive: true });
    writeFileSync(join(dir, TIERED_CONFIG_REL), "{not json");
    expect(resolved()).toBeUndefined();
  });
});

describe("precedence: flag → env → file", () => {
  it("uses the file when neither flag nor env is set", () => {
    writeStandingConfig({ enabled: true, models: { planner: "from-file" } });
    expect(resolved()!.roles.planner!.model).toBe("from-file");
  });

  it("env overrides the file", () => {
    writeStandingConfig({ enabled: true, models: { planner: "from-file" } });
    process.env[ENV] = JSON.stringify({
      enabled: true,
      models: { planner: "from-env" },
    });
    expect(resolved()!.roles.planner!.model).toBe("from-env");
  });

  it("flag overrides both", () => {
    writeStandingConfig({ enabled: true, models: { planner: "from-file" } });
    process.env[ENV] = JSON.stringify({
      enabled: true,
      models: { planner: "from-env" },
    });
    mock.setFlag(
      FLAG,
      JSON.stringify({ enabled: true, models: { planner: "from-flag" } }),
    );
    expect(resolved()!.roles.planner!.model).toBe("from-flag");
  });

  it("an override that REPLACES rather than merges — tiers are all-or-nothing", () => {
    writeStandingConfig({
      enabled: true,
      models: { planner: "from-file", implementer: "from-file" },
    });
    process.env[ENV] = JSON.stringify({
      enabled: true,
      models: { planner: "from-env" },
    });
    // Deep-merging an override into a standing config would silently run a
    // tier the operator did not name in the override they were staring at.
    const config = resolved()!;
    expect(Object.keys(config.roles)).toEqual(["planner"]);
  });

  it("a BROKEN override does not silently fall back to the file", () => {
    writeStandingConfig({ enabled: true, models: { planner: "from-file" } });
    process.env[ENV] = "{not json";
    // Running someone else's standing tiers because your own JSON had a
    // typo is worse than running none.
    expect(resolved()).toBeUndefined();
  });

  it("an explicit disable turns the adapter off without consulting the file", () => {
    writeStandingConfig({ enabled: true, models: { planner: "from-file" } });
    process.env[ENV] = JSON.stringify({ enabled: false });
    expect(resolved()).toBeUndefined();
  });
});
