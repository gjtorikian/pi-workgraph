import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.ts";
import { noteSessionCwd } from "./settings.ts";
import { asExtensionAPI, makeMockPi } from "../test/helpers/mock-pi.ts";

const dirs: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-workgraph-${label}-`));
  dirs.push(dir);
  return dir;
}

function writeSettings(dir: string, sub: string | undefined, body: unknown): void {
  const target = sub ? join(dir, sub) : dir;
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "settings.json"), JSON.stringify(body));
}

/** Run `body` with the given env vars set (or, for `undefined`, unset), restoring them afterwards. */
function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const previous = new Map(Object.keys(vars).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

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

afterEach(() => {
  noteSessionCwd(undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

  it("keeps a plan_critic route and plan_critic launch options", () => {
    const mock = makeMockPi();
    mock.setFlag(
      "workgraph-subagents-executor",
      JSON.stringify({
        enabled: true,
        routes: { planned: { planner: "planner", plan_critic: " plan-critic " } },
        options: { plan_critic: { model: " anthropic/claude-opus-5 ", thinking: "high", skills: ["critique", ""] } },
      }),
    );

    expect(resolveConfig(asExtensionAPI(mock)).subagentsExecutor).toEqual({
      enabled: true,
      routes: { planned: { planner: "planner", plan_critic: "plan-critic" } },
      options: { plan_critic: { model: "anthropic/claude-opus-5", thinking: "high", skills: ["critique"] } },
    });
  });
});

describe("planCritique resolution", () => {
  /** resolveConfig().planCritique with the agent dir and env under the test's control. */
  function planCritique(
    opts: { agentDir?: string; project?: string; env?: string; flag?: string } = {},
  ): "off" | "high-risk" | undefined {
    const mock = makeMockPi();
    if (opts.flag !== undefined) mock.setFlag("workgraph-plan-critique", opts.flag);
    noteSessionCwd(opts.project);
    return withEnv(
      { WORKGRAPH_PLAN_CRITIQUE: opts.env, PI_CODING_AGENT_DIR: opts.agentDir ?? tempDir("agent") },
      () => resolveConfig(asExtensionAPI(mock)).planCritique,
    );
  }

  it("defaults to off when nothing sets it", () => {
    expect(planCritique()).toBe("off");
    expect(planCritique({ project: tempDir("project") })).toBe("off");
  });

  it("reads settings when no flag or env is set, project over global", () => {
    const agentDir = tempDir("agent");
    const project = tempDir("project");
    writeSettings(agentDir, undefined, { workgraph: { planCritique: "high-risk" } });
    expect(planCritique({ agentDir, project })).toBe("high-risk");

    writeSettings(project, ".pi", { workgraph: { planCritique: "off" } });
    expect(planCritique({ agentDir, project })).toBe("off");
  });

  it("the env var overrides settings, and the flag overrides the env var", () => {
    const agentDir = tempDir("agent");
    const project = tempDir("project");
    writeSettings(agentDir, undefined, { workgraph: { planCritique: "off" } });
    writeSettings(project, ".pi", { workgraph: { planCritique: "off" } });
    expect(planCritique({ agentDir, project, env: "high-risk" })).toBe("high-risk");
    expect(planCritique({ agentDir, project, env: "high-risk", flag: "off" })).toBe("off");

    writeSettings(project, ".pi", { workgraph: { planCritique: "high-risk" } });
    expect(planCritique({ agentDir, project, env: "off" })).toBe("off");
    expect(planCritique({ agentDir, project, flag: "high-risk", env: "off" })).toBe("high-risk");
  });

  it("accepts the flag forms case-insensitively, with false as off", () => {
    const agentDir = tempDir("agent");
    writeSettings(agentDir, undefined, { workgraph: { planCritique: "high-risk" } });
    expect(planCritique({ flag: "HIGH-RISK" })).toBe("high-risk");
    expect(planCritique({ env: " High-Risk " })).toBe("high-risk");
    expect(planCritique({ agentDir, flag: "false" })).toBe("off");
    expect(planCritique({ agentDir, flag: "OFF" })).toBe("off");
  });

  it("an unknown planCritique value resolves to off and logs once, even over settings that say high-risk", () => {
    const agentDir = tempDir("agent");
    const project = tempDir("project");
    writeSettings(agentDir, undefined, { workgraph: { planCritique: "high-risk" } });
    writeSettings(project, ".pi", { workgraph: { planCritique: "high-risk" } });

    const aboutPlanCritique = (logged: string[]) => logged.filter((line) => line.includes("planCritique"));
    for (const garbage of ["banana", "true", "on", "all", "high"]) {
      const viaEnv = withLoggedErrors(() => planCritique({ agentDir, project, env: garbage }));
      expect(viaEnv.result, `env ${garbage}`).toBe("off");
      expect(aboutPlanCritique(viaEnv.logged)).toEqual([
        `[pi-workgraph] ignoring workgraph-plan-critique value "${garbage}": planCritique must be "off" or "high-risk"`,
      ]);

      const viaFlag = withLoggedErrors(() => planCritique({ agentDir, project, flag: garbage }));
      expect(viaFlag.result, `flag ${garbage}`).toBe("off");
      expect(aboutPlanCritique(viaFlag.logged)).toHaveLength(1);
    }
  });

  it("an invalid value in a settings file is dropped, so the default stays off", () => {
    const agentDir = tempDir("agent");
    writeSettings(agentDir, undefined, { workgraph: { planCritique: "banana" } });
    const { result, logged } = withLoggedErrors(() => planCritique({ agentDir }));
    expect(result).toBe("off");
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).toContain('planCritique must be "off" or "high-risk", got "banana"');
  });
});
