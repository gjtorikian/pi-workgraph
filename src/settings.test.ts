/**
 * Declarative settings: the `workgraph` block in Pi's global and project
 * settings files, the `workgraph.json` beside each, and the precedence that
 * decides which tier table is in force (flag > project settings > workspace
 * store > global settings).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.ts";
import { PolicyConfigError } from "./policy.ts";
import {
  effectiveTiers,
  noteSessionCwd,
  parseExecutorPins,
  parseWorkgraphSettings,
  settingsExecutors,
  settingsPlanApproval,
  settingsPlanCritique,
  settingsPolicy,
  settingsStore,
  workgraphSettings,
} from "./settings.ts";
import { storeTiers } from "./tiers.ts";
import { asExtensionAPI, makeMockPi } from "../test/helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "../test/helpers/scratch.ts";

const dirs: string[] = [];
const graphs: ScratchGraph[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-workgraph-${label}-`));
  dirs.push(dir);
  return dir;
}

function writeSettings(dir: string, sub: string | undefined, body: unknown): void {
  const target = sub ? join(dir, sub) : dir;
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "settings.json"), typeof body === "string" ? body : JSON.stringify(body));
}

/** Write a `workgraph.json`: the block itself, with no `workgraph` key around it. */
function writeWorkgraphFile(dir: string, sub: string | undefined, body: unknown): void {
  const target = sub ? join(dir, sub) : dir;
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "workgraph.json"), typeof body === "string" ? body : JSON.stringify(body));
}

afterEach(() => {
  noteSessionCwd(undefined);
  for (const graph of graphs.splice(0)) graph.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run `body` with console.error silenced, returning its result and the lines it logged. */
function withLoggedErrors<T>(body: () => T): { result: T; logged: string[] } {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = body();
    return { result, logged: spy.mock.calls.map((args) => args.join(" ")) };
  } finally {
    spy.mockRestore();
  }
}

describe("parseWorkgraphSettings", () => {
  it("accepts a table for tiers and a plan-approval mode", () => {
    expect(
      parseWorkgraphSettings({
        workgraph: { tiers: { planner: { model: "anthropic/claude-opus-*", thinking: "high" } }, planApproval: "auto" },
      }),
    ).toEqual({
      tiers: { planner: { model: "anthropic/claude-opus-*", thinking: "high" } },
      planApproval: "auto",
    });
    expect(
      parseWorkgraphSettings({ workgraph: { tiers: { planner: "openai/gpt-5", scout: "anthropic/claude-haiku-*" } } }),
    ).toEqual({ tiers: { planner: { model: "openai/gpt-5" }, scout: { model: "anthropic/claude-haiku-*" } } });
  });

  it("ignores missing, malformed, or foreign blocks", () => {
    expect(parseWorkgraphSettings(undefined)).toBeUndefined();
    expect(parseWorkgraphSettings({ theme: "dark" })).toBeUndefined();
    expect(parseWorkgraphSettings({ workgraph: "yes" })).toBeUndefined();
    expect(parseWorkgraphSettings({ workgraph: { planApproval: "sometimes" } })).toBeUndefined();
  });
});

describe("workgraphSettings", () => {
  it("reads the global and project files, tolerating a broken one", () => {
    const agentDir = tempDir("agent");
    const project = tempDir("project");
    writeSettings(agentDir, undefined, { workgraph: { tiers: { planner: "anthropic/claude-opus-*" } } });
    writeSettings(project, ".pi", { workgraph: { planApproval: "auto" } });
    const sources = workgraphSettings({ agentDir, cwd: project });
    expect(sources.global?.tiers?.planner?.model).toBe("anthropic/claude-opus-*");
    expect(sources.project).toEqual({ planApproval: "auto" });
    expect(settingsPlanApproval({ agentDir, cwd: project })).toBe("auto");

    writeSettings(project, ".pi", "{ not json");
    expect(workgraphSettings({ agentDir, cwd: project }).project).toBeUndefined();
  });
});

describe("effectiveTiers precedence", () => {
  it("flag > project settings > workspace store > global settings", async () => {
    const agentDir = tempDir("agent");
    const graph = makeScratchGraph({ prefix: "prec" });
    graphs.push(graph);
    const cwd = graph.dir;
    const location = { agentDir };

    expect(await effectiveTiers(undefined, cwd, location)).toBeUndefined();

    writeSettings(agentDir, undefined, { workgraph: { tiers: { planner: "g/global" } } });
    expect(await effectiveTiers(undefined, cwd, location)).toEqual({
      tiers: { planner: { model: "g/global" } },
      origin: "global settings",
    });

    await storeTiers(cwd, { planner: { model: "w/workspace" } });
    expect((await effectiveTiers(undefined, cwd, location))?.origin).toBe("workspace");

    writeSettings(cwd, ".pi", { workgraph: { tiers: { planner: "p/project" } } });
    expect(await effectiveTiers(undefined, cwd, location)).toEqual({
      tiers: { planner: { model: "p/project" } },
      origin: "project settings",
    });

    expect((await effectiveTiers({ planner: { model: "f/flag" } }, cwd, location))?.origin).toBe("flag");
  });
});

describe("planApproval from settings", () => {
  it("falls back to the project settings file when no flag or env is set", () => {
    const project = tempDir("project");
    writeSettings(project, ".pi", { workgraph: { planApproval: "auto" } });
    const mock = makeMockPi();
    const previous = process.env.WORKGRAPH_PLAN_APPROVAL;
    delete process.env.WORKGRAPH_PLAN_APPROVAL;
    try {
      noteSessionCwd(project);
      expect(resolveConfig(asExtensionAPI(mock)).planApproval).toBe("auto");
      mock.setFlag("workgraph-plan-approval", "required");
      expect(resolveConfig(asExtensionAPI(mock)).planApproval).toBe("required");
    } finally {
      if (previous !== undefined) process.env.WORKGRAPH_PLAN_APPROVAL = previous;
    }
  });
});

describe("planCritique from settings", () => {
  it("parses both modes from the block", () => {
    expect(parseWorkgraphSettings({ workgraph: { planCritique: "high-risk" } })).toEqual({ planCritique: "high-risk" });
    expect(parseWorkgraphSettings({ workgraph: { planCritique: "off" } })).toEqual({ planCritique: "off" });
  });

  it("the project value wins over the global one; unset in both reads as undefined", () => {
    const agentDir = tempDir("agent");
    const project = tempDir("project");
    expect(settingsPlanCritique({ agentDir, cwd: project })).toBeUndefined();

    writeSettings(agentDir, undefined, { workgraph: { planCritique: "high-risk" } });
    expect(settingsPlanCritique({ agentDir, cwd: project })).toBe("high-risk");

    writeSettings(project, ".pi", { workgraph: { planCritique: "off" } });
    expect(settingsPlanCritique({ agentDir, cwd: project })).toBe("off");
    // A project block that does not set the key leaves the global value in force.
    writeSettings(project, ".pi", { workgraph: { planApproval: "auto" } });
    expect(settingsPlanCritique({ agentDir, cwd: project })).toBe("high-risk");
  });

  it("drops an invalid planCritique value with one log line, never turning the critique on", () => {
    for (const value of ["banana", "HIGH-RISK", "all", true, 1, null]) {
      const { result, logged } = withLoggedErrors(() =>
        parseWorkgraphSettings({ workgraph: { planCritique: value, store: "central" } }),
      );
      expect(result, `planCritique ${JSON.stringify(value)} must be dropped`).toEqual({ store: "central" });
      expect(logged).toEqual([
        `[pi-workgraph] settings: planCritique must be "off" or "high-risk", got ${JSON.stringify(value)}`,
      ]);
    }
  });

  it("an invalid project value does not mask a valid global one", () => {
    const agentDir = tempDir("agent");
    const project = tempDir("project");
    writeSettings(agentDir, undefined, { workgraph: { planCritique: "high-risk" } });
    writeSettings(project, ".pi", { workgraph: { planCritique: "sometimes" } });
    const { result } = withLoggedErrors(() => settingsPlanCritique({ agentDir, cwd: project }));
    expect(result).toBe("high-risk");
  });
});

describe("executor pins from settings", () => {
  it("keeps a plan_critic pin", () => {
    const { result, logged } = withLoggedErrors(() => parseExecutorPins({ plan_critic: "pi-subagents" }));
    expect(result).toEqual({ plan_critic: "pi-subagents" });
    expect(logged).toEqual([]);
    expect(
      parseWorkgraphSettings({ workgraph: { executors: { planner: "in-session", plan_critic: " pi-subagents " } } }),
    ).toEqual({ executors: { planner: "in-session", plan_critic: "pi-subagents" } });
  });

  it("parses the executors block, merges project over global, and feeds config", () => {
    expect(
      parseWorkgraphSettings({
        workgraph: { executors: { planner: "in-session", implementer: "pi-subagents", mystery: "x", reviewer: "" } },
      }),
    ).toEqual({ executors: { planner: "in-session", implementer: "pi-subagents" } });

    const agentDir = tempDir("agent");
    const project = tempDir("project");
    writeSettings(agentDir, undefined, {
      workgraph: { executors: { planner: "in-session", implementer: "pi-subagents" } },
    });
    writeSettings(project, ".pi", { workgraph: { executors: { implementer: "in-session" } } });
    expect(settingsExecutors({ agentDir, cwd: project })).toEqual({
      planner: "in-session",
      implementer: "in-session",
    });

    const mock = makeMockPi();
    const previousEnv = process.env.WORKGRAPH_EXECUTORS;
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    delete process.env.WORKGRAPH_EXECUTORS;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      noteSessionCwd(project);
      expect(resolveConfig(asExtensionAPI(mock)).executorByRole).toEqual({
        planner: "in-session",
        implementer: "in-session",
      });
      mock.setFlag("workgraph-executors", JSON.stringify({ reviewer: "workers" }));
      expect(resolveConfig(asExtensionAPI(mock)).executorByRole).toEqual({ reviewer: "workers" });
    } finally {
      if (previousEnv !== undefined) process.env.WORKGRAPH_EXECUTORS = previousEnv;
      if (previousAgent !== undefined) process.env.PI_CODING_AGENT_DIR = previousAgent;
      else delete process.env.PI_CODING_AGENT_DIR;
    }
  });
});

describe("subagents bridge from settings", () => {
  it("enables the bridge from the settings block when no flag or env is set", () => {
    const agentDir = tempDir("agent");
    const project = tempDir("project");
    writeSettings(agentDir, undefined, { workgraph: { subagentsExecutor: true } });
    writeSettings(project, ".pi", {
      workgraph: { subagentsExecutor: { enabled: true, routes: { planned: { implementer: "worker" } } } },
    });
    const mock = makeMockPi();
    const previousEnv = process.env.WORKGRAPH_SUBAGENTS_EXECUTOR;
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    delete process.env.WORKGRAPH_SUBAGENTS_EXECUTOR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      noteSessionCwd(project);
      expect(resolveConfig(asExtensionAPI(mock)).subagentsExecutor).toEqual({
        enabled: true,
        routes: { planned: { implementer: "worker" } },
      });
      noteSessionCwd(tempDir("elsewhere"));
      expect(resolveConfig(asExtensionAPI(mock)).subagentsExecutor).toEqual({ enabled: true });
      mock.setFlag("workgraph-subagents-executor", "false");
      expect(resolveConfig(asExtensionAPI(mock)).subagentsExecutor).toBeUndefined();
    } finally {
      if (previousEnv !== undefined) process.env.WORKGRAPH_SUBAGENTS_EXECUTOR = previousEnv;
      if (previousAgent !== undefined) process.env.PI_CODING_AGENT_DIR = previousAgent;
      else delete process.env.PI_CODING_AGENT_DIR;
    }
  });
});

describe("store policy from settings", () => {
  it("reads store from the block and config falls back to it", () => {
    expect(parseWorkgraphSettings({ workgraph: { store: "central" } })).toEqual({ store: "central" });
    const agentDir = tempDir("agent");
    const project = tempDir("project");
    writeSettings(agentDir, undefined, { workgraph: { store: "central" } });
    writeSettings(project, ".pi", { workgraph: { store: "/tmp/elsewhere" } });
    expect(settingsStore({ agentDir, cwd: project })).toBe("/tmp/elsewhere");
    const mock = makeMockPi();
    const previousEnv = process.env.WORKGRAPH_STORE;
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    delete process.env.WORKGRAPH_STORE;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      noteSessionCwd(project);
      expect(resolveConfig(asExtensionAPI(mock)).store).toBe("/tmp/elsewhere");
      noteSessionCwd(tempDir("plain"));
      expect(resolveConfig(asExtensionAPI(mock)).store).toBe("central");
      mock.setFlag("workgraph-store", "repo");
      expect(resolveConfig(asExtensionAPI(mock)).store).toBe("repo");
    } finally {
      if (previousEnv !== undefined) process.env.WORKGRAPH_STORE = previousEnv;
      if (previousAgent !== undefined) process.env.PI_CODING_AGENT_DIR = previousAgent;
      else delete process.env.PI_CODING_AGENT_DIR;
    }
  });
});

describe("gate policy from settings", () => {
  it("carries the policy through as raw JSON, valid or not, and never logs or drops it", () => {
    const { result, logged } = withLoggedErrors(() => [
      parseWorkgraphSettings({ workgraph: { policy: { low: { gates: { scope: "off" } } } } }),
      // Not validated here: config.ts rejects this one, so it must arrive.
      parseWorkgraphSettings({ workgraph: { policy: { low: { gateMode: "advisory" } } } }),
      parseWorkgraphSettings({ workgraph: { policy: ["not", "a", "policy"] } }),
      parseWorkgraphSettings({ workgraph: { policy: " {} " } }),
    ]);
    expect(result).toEqual([
      { policy: '{"low":{"gates":{"scope":"off"}}}' },
      { policy: '{"low":{"gateMode":"advisory"}}' },
      { policy: '["not","a","policy"]' },
      { policy: "{}" },
    ]);
    expect(logged).toEqual([]);
  });

  it("treats an empty string or null as unset", () => {
    expect(parseWorkgraphSettings({ workgraph: { policy: "  " } })).toBeUndefined();
    expect(parseWorkgraphSettings({ workgraph: { policy: null } })).toBeUndefined();
  });

  it("the project value replaces the global one whole", () => {
    const agentDir = tempDir("agent");
    const project = tempDir("project");
    writeSettings(agentDir, undefined, { workgraph: { policy: { low: { gates: { scope: "off" } } } } });
    expect(settingsPolicy({ agentDir, cwd: project })).toBe('{"low":{"gates":{"scope":"off"}}}');
    writeSettings(project, ".pi", { workgraph: { policy: { high: { maxRevisions: 1 } } } });
    expect(settingsPolicy({ agentDir, cwd: project })).toBe('{"high":{"maxRevisions":1}}');
    expect(settingsPolicy({ agentDir: tempDir("empty"), cwd: tempDir("plain") })).toBeUndefined();
  });
});

describe("workgraph.json beside settings.json", () => {
  it("reads the file as the block itself, in the agent dir and in the project's .pi", () => {
    const agentDir = tempDir("agent");
    const project = tempDir("project");
    writeWorkgraphFile(agentDir, undefined, { tiers: { planner: "anthropic/claude-opus-*" }, store: "central" });
    writeWorkgraphFile(project, ".pi", { planApproval: "auto" });
    expect(workgraphSettings({ agentDir, cwd: project })).toEqual({
      global: { tiers: { planner: { model: "anthropic/claude-opus-*" } }, store: "central" },
      project: { planApproval: "auto" },
    });
  });

  it("reads the two files of one directory as one block: workgraph.json wins per key, executors merge per role", () => {
    const agentDir = tempDir("agent");
    writeSettings(agentDir, undefined, {
      workgraph: {
        store: "central",
        planApproval: "auto",
        policy: { low: { gates: { scope: "off" } } },
        executors: { planner: "in-session", implementer: "in-session" },
      },
    });
    writeWorkgraphFile(agentDir, undefined, {
      planApproval: "required",
      policy: { high: { maxRevisions: 1 } },
      executors: { implementer: "pi-subagents" },
    });
    expect(workgraphSettings({ agentDir, cwd: tempDir("plain") }).global).toEqual({
      store: "central",
      planApproval: "required",
      // Replaced whole, as a project policy replaces a global one.
      policy: '{"high":{"maxRevisions":1}}',
      executors: { planner: "in-session", implementer: "pi-subagents" },
    });
  });

  it("the directory decides before the file does: project > workspace store > global", async () => {
    const agentDir = tempDir("agent");
    const graph = makeScratchGraph({ prefix: "file" });
    graphs.push(graph);
    const cwd = graph.dir;
    const location = { agentDir };

    writeSettings(agentDir, undefined, { workgraph: { tiers: { planner: "g/settings" } } });
    writeWorkgraphFile(agentDir, undefined, { tiers: { planner: "g/file" } });
    expect(await effectiveTiers(undefined, cwd, location)).toEqual({
      tiers: { planner: { model: "g/file" } },
      origin: "global settings",
    });

    await storeTiers(cwd, { planner: { model: "w/workspace" } });
    expect((await effectiveTiers(undefined, cwd, location))?.origin).toBe("workspace");

    // A project settings.json outranks the global workgraph.json.
    writeSettings(cwd, ".pi", { workgraph: { tiers: { planner: "p/settings" } } });
    expect(await effectiveTiers(undefined, cwd, location)).toEqual({
      tiers: { planner: { model: "p/settings" } },
      origin: "project settings",
    });

    writeWorkgraphFile(cwd, ".pi", { tiers: { planner: "p/file" } });
    expect(await effectiveTiers(undefined, cwd, location)).toEqual({
      tiers: { planner: { model: "p/file" } },
      origin: "project settings",
    });
  });

  it("reports a broken workgraph.json once and leaves settings.json in force", () => {
    const agentDir = tempDir("agent");
    writeSettings(agentDir, undefined, { workgraph: { store: "central" } });
    writeWorkgraphFile(agentDir, undefined, "{ not json");
    const location = { agentDir, cwd: tempDir("plain") };
    const { result, logged } = withLoggedErrors(() => [workgraphSettings(location), workgraphSettings(location)]);
    expect(result).toEqual([{ global: { store: "central" } }, { global: { store: "central" } }]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`ignoring unreadable settings file ${join(agentDir, "workgraph.json")}`);
  });

  it("reports a pasted-in workgraph key once and reads only the top-level keys", () => {
    const project = tempDir("project");
    writeWorkgraphFile(project, ".pi", { workgraph: { planApproval: "auto" }, store: "central" });
    const location = { agentDir: tempDir("agent"), cwd: project };
    const { result, logged } = withLoggedErrors(() => [workgraphSettings(location), workgraphSettings(location)]);
    expect(result).toEqual([{ project: { store: "central" } }, { project: { store: "central" } }]);
    expect(logged).toEqual([
      `[pi-workgraph] ${join(project, ".pi", "workgraph.json")}: ignoring the "workgraph" key — this file is the block itself, so move its keys to the top level`,
    ]);
  });

  it("feeds config as the settings.json block does, and an invalid policy still stops it", () => {
    const project = tempDir("project");
    writeWorkgraphFile(project, ".pi", {
      check: { command: "npm test" },
      policy: { low: { gates: { scope: "off" } } },
    });
    const mock = makeMockPi();
    const previous = process.env.WORKGRAPH_POLICY;
    delete process.env.WORKGRAPH_POLICY;
    try {
      noteSessionCwd(project);
      const config = resolveConfig(asExtensionAPI(mock));
      expect(config.check).toEqual({ command: "npm test" });
      expect(config.policy).toEqual({ low: { gates: { scope: "off" } } });

      writeWorkgraphFile(project, ".pi", { policy: { low: { gateMode: "advisory" } } });
      expect(() => resolveConfig(asExtensionAPI(mock))).toThrow(PolicyConfigError);
    } finally {
      if (previous !== undefined) process.env.WORKGRAPH_POLICY = previous;
    }
  });
});
