/**
 * Declarative settings: the `workgraph` block in Pi's global and project
 * settings files, and the precedence that decides which tier table is in
 * force (flag > project settings > workspace store > global settings).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./config.ts";
import {
  effectiveTiers,
  noteSessionCwd,
  parseWorkgraphSettings,
  settingsExecutors,
  settingsPlanApproval,
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

afterEach(() => {
  noteSessionCwd(undefined);
  for (const graph of graphs.splice(0)) graph.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

describe("executor pins from settings", () => {
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
