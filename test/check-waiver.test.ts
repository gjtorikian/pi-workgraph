/**
 * Authoring the check, the waiver, and the frozen bar (proof-of-success
 * phase 3).
 *
 *  - The approval rule, through the real tools: medium- and high-risk work
 *    is refused without a check command, a repository default or an explicit
 *    waiver — in `workgraph_approve`, in `workgraph_create` with `approve`,
 *    and for every approved child of `workgraph_split`.
 *  - What waived work and unapproved (legacy) work do at the gate.
 *  - The bar: frozen at claim, so a check command, a gate mode or the
 *    criteria changed afterwards do not change what the run is judged
 *    against, and the change is recorded once.
 *
 * Tools resolve their configuration from flags and Pi settings, never from a
 * harness's injected config, so the tool cases here run on the shipped
 * policy unless a case sets `workgraph-policy` or writes a settings file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckConfigError, commandDigest } from "../src/check.ts";
import {
  resolveConfig,
  resolveConfigWithoutPolicy,
  type WorkgraphConfig,
} from "../src/config.ts";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import { latestStamp, listGateRecords, listReceipts } from "../src/proof.ts";
import { noteSessionCwd } from "../src/settings.ts";
import { listComments } from "../src/store.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import {
  ApproveParams,
  CreateParams,
  SplitParams,
  WORKGRAPH_BAR_DIGEST_KEY,
  WORKGRAPH_CHECK_KEY,
  WORKGRAPH_CHECK_WAIVER_KEY,
  WORKGRAPH_PHASE_KEY,
  type VerdictT,
} from "../src/types.ts";
import { shippedConfig } from "./helpers/config.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import {
  failCommentWrites,
  makeScratchGraph,
  makeScratchRepo,
  type ScratchGraph,
  type ScratchRepo,
} from "./helpers/scratch.ts";
import type { WorkIssue } from "../src/types.ts";

const WORKER = "check-waiver-worker";

/** Distinct author/reviewer provenance — independent under every policy. */
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };

const CLEAN_VERDICT: VerdictT = { findings: [] };

const refusal = (tier: string): string =>
  `${tier}-risk work needs a check command (check: "npm test") or an explicit waiver (checkWaiver: "<why no check applies>").`;

/** A mock with the tools registered, on the shipped policy. */
function makeTools(): MockPi {
  const mock = makeMockPi();
  setWorkerIdOverride(WORKER);
  mock.setFlag("workgraph-worker-id", WORKER);
  registerWorkgraphTools(asExtensionAPI(mock));
  return mock;
}

interface ToolResult {
  content: { type: string; text?: string }[];
  details: unknown;
}

async function run(
  mock: MockPi,
  name: string,
  params: unknown,
  cwd: string,
): Promise<ToolResult> {
  const def = mock.tools.get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return (await def.execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    makeToolContext(cwd),
  )) as ToolResult;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

function metadataOf(graph: ScratchGraph, id: string): Record<string, unknown> {
  return (graph.showIssue(id).metadata ?? {}) as Record<string, unknown>;
}

function issueCount(graph: ScratchGraph): number {
  return (JSON.parse(graph.op(["list", "--json"])) as WorkIssue[]).length;
}

/** Write `<dir>/.pi/settings.json` and make it the session's project file. */
function writeProjectSettings(dir: string, workgraph: unknown): void {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ workgraph }));
  noteSessionCwd(dir);
}

/** Silence console.error and return the lines it was given. */
function captureErrors(): () => string[] {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.join(" "));
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLeasesForTest();
  resetIdentityForTest();
  noteSessionCwd(undefined);
});

// ---------------------------------------------------------------------------
// the approval rule
// ---------------------------------------------------------------------------

describe("workgraph_approve and the check", () => {
  it("refuses medium- and high-risk work with no check, no repository default and no waiver, and writes nothing", async () => {
    const graph = makeScratchGraph({ prefix: "cwref" });
    const mock = makeTools();
    try {
      for (const riskTier of ["medium", "high"]) {
        const id = graph.createIssue(`${riskTier} work`);
        await expect(
          run(mock, "workgraph_approve", { id, riskTier, acceptanceCriteria: "works" }, graph.dir),
        ).rejects.toThrow(`Cannot approve ${id}: ${refusal(riskTier)}`);
        // Refused before any state was written.
        const shown = graph.showIssue(id);
        expect(shown.metadata?.[WORKGRAPH_PHASE_KEY]).toBeUndefined();
        expect(shown.acceptance_criteria).toBeUndefined();
        expect(
          (await listComments(graph.dir, id)).filter((c) =>
            c.text.startsWith("workgraph-lease approve "),
          ),
        ).toEqual([]);
      }
      // The default tier is medium.
      const untiered = graph.createIssue("no tier given");
      await expect(
        run(mock, "workgraph_approve", { id: untiered }, graph.dir),
      ).rejects.toThrow(refusal("medium"));
      // Low-risk work may have no check.
      const low = graph.createIssue("low work");
      await run(mock, "workgraph_approve", { id: low, riskTier: "low" }, graph.dir);
      expect(metadataOf(graph, low)[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(metadataOf(graph, low)[WORKGRAPH_CHECK_KEY]).toBeUndefined();
    } finally {
      graph.cleanup();
    }
  });

  it("accepts a check or a waiver at every tier, stores it, audits it, and refuses both together", async () => {
    const graph = makeScratchGraph({ prefix: "cwacc" });
    const mock = makeTools();
    try {
      for (const riskTier of ["low", "medium", "high"]) {
        const checked = graph.createIssue(`${riskTier} checked`);
        await run(
          mock,
          "workgraph_approve",
          { id: checked, riskTier, check: "  npm test  " },
          graph.dir,
        );
        // Trimmed, and stored as a string.
        expect(metadataOf(graph, checked)[WORKGRAPH_CHECK_KEY]).toBe("npm test");
        expect(metadataOf(graph, checked)[WORKGRAPH_PHASE_KEY]).toBe("ready");

        const waived = graph.createIssue(`${riskTier} waived`);
        const result = await run(
          mock,
          "workgraph_approve",
          { id: waived, riskTier, checkWaiver: "prose only, nothing to run" },
          graph.dir,
        );
        expect(textOf(result)).toContain("Check waived: prose only, nothing to run");
        expect(metadataOf(graph, waived)[WORKGRAPH_CHECK_WAIVER_KEY]).toBe(
          "prose only, nothing to run",
        );
        expect(metadataOf(graph, waived)[WORKGRAPH_PHASE_KEY]).toBe("ready");
        const audit = (await listComments(graph.dir, waived)).find((c) =>
          c.text.startsWith("workgraph-lease approve "),
        )!;
        expect(JSON.parse(audit.text.slice("workgraph-lease approve ".length))).toMatchObject({
          check: null,
          checkWaiver: "prose only, nothing to run",
        });

        const both = graph.createIssue(`${riskTier} both`);
        await expect(
          run(
            mock,
            "workgraph_approve",
            { id: both, riskTier, check: "npm test", checkWaiver: "why not" },
            graph.dir,
          ),
        ).rejects.toThrow(/check or checkWaiver, not both/);
        expect(metadataOf(graph, both)[WORKGRAPH_PHASE_KEY]).toBeUndefined();
      }
      // `true` is a command, and stays one through the store.
      const builtin = graph.createIssue("builtin");
      await run(mock, "workgraph_approve", { id: builtin, check: "true" }, graph.dir);
      expect(metadataOf(graph, builtin)[WORKGRAPH_CHECK_KEY]).toBe("true");
      // Whitespace alone is no check at all.
      const blank = graph.createIssue("blank");
      await expect(
        run(mock, "workgraph_approve", { id: blank, check: "   " }, graph.dir),
      ).rejects.toThrow(refusal("medium"));
      await expect(
        run(mock, "workgraph_approve", { id: blank, checkWaiver: " \t" }, graph.dir),
      ).rejects.toThrow(refusal("medium"));
    } finally {
      graph.cleanup();
    }
  });

  it("the schemas take both parameters and reject an empty one", () => {
    expect(Value.Check(ApproveParams, { id: "x", check: "npm test" })).toBe(true);
    expect(Value.Check(ApproveParams, { id: "x", checkWaiver: "docs" })).toBe(true);
    expect(Value.Check(ApproveParams, { id: "x", check: "" })).toBe(false);
    expect(Value.Check(ApproveParams, { id: "x", checkWaiver: "" })).toBe(false);
    expect(Value.Check(CreateParams, { title: "t", check: "npm test" })).toBe(true);
    expect(Value.Check(CreateParams, { title: "t", check: "" })).toBe(false);
    expect(
      Value.Check(SplitParams, {
        id: "x",
        children: [{ title: "c", check: "npm test" }, { title: "d", checkWaiver: "docs" }],
      }),
    ).toBe(true);
    expect(
      Value.Check(SplitParams, { id: "x", children: [{ title: "c", checkWaiver: "" }] }),
    ).toBe(false);
  });

  it("a repository default satisfies the rule, and workgraph_status says where the check comes from", async () => {
    const graph = makeScratchGraph({ prefix: "cwdef" });
    const mock = makeTools();
    try {
      writeProjectSettings(graph.dir, { check: { command: "make check" } });
      const byDefault = graph.createIssue("relies on the default");
      await run(mock, "workgraph_approve", { id: byDefault }, graph.dir);
      expect(metadataOf(graph, byDefault)[WORKGRAPH_PHASE_KEY]).toBe("ready");
      // Nothing was copied onto the issue: the default is resolved at claim.
      expect(metadataOf(graph, byDefault)[WORKGRAPH_CHECK_KEY]).toBeUndefined();
      const defaultStatus = textOf(
        await run(mock, "workgraph_status", { id: byDefault }, graph.dir),
      ).split("\n");
      expect(defaultStatus).toContain("Check: make check (repository default)");

      const own = graph.createIssue("has its own");
      await run(
        mock,
        "workgraph_approve",
        { id: own, check: "npm test", acceptanceCriteria: "works" },
        graph.dir,
      );
      const ownStatus = textOf(await run(mock, "workgraph_status", { id: own }, graph.dir)).split(
        "\n",
      );
      expect(ownStatus).toContain("Check: npm test");
      // Next to the criteria, above the gate lines.
      expect(ownStatus.indexOf("Check: npm test")).toBe(
        ownStatus.indexOf("Acceptance: works") + 1,
      );
      expect(ownStatus.indexOf("Check: npm test")).toBeLessThan(
        ownStatus.findIndex((line) => line.startsWith("Gates: ")),
      );

      // A waiver on the issue wins over the repository default.
      const waived = graph.createIssue("opts out");
      await run(mock, "workgraph_approve", { id: waived, checkWaiver: "docs only" }, graph.dir);
      const waivedStatus = textOf(
        await run(mock, "workgraph_status", { id: waived }, graph.dir),
      );
      expect(waivedStatus).toContain("Check waived: docs only");
      expect(waivedStatus).not.toContain("make check");
    } finally {
      graph.cleanup();
    }
  });

  it("with the check gate at observe or off for the tier, approval is never refused", async () => {
    const graph = makeScratchGraph({ prefix: "cwobs" });
    const mock = makeTools();
    try {
      mock.setFlag(
        "workgraph-policy",
        JSON.stringify({
          medium: { gates: { check: "observe" } },
          high: { gates: { check: "off" } },
        }),
      );
      const medium = graph.createIssue("medium, observed");
      await run(mock, "workgraph_approve", { id: medium }, graph.dir);
      expect(metadataOf(graph, medium)[WORKGRAPH_PHASE_KEY]).toBe("ready");
      const high = graph.createIssue("high, off");
      await run(mock, "workgraph_approve", { id: high, riskTier: "high" }, graph.dir);
      expect(metadataOf(graph, high)[WORKGRAPH_PHASE_KEY]).toBe("ready");
    } finally {
      graph.cleanup();
    }
  });

  it("a stored check satisfies a later approval, and a new check or waiver replaces the other kind", async () => {
    const graph = makeScratchGraph({ prefix: "cwre" });
    const mock = makeTools();
    try {
      // A draft created with a check: the approval needs no new one.
      const draft = await run(
        mock,
        "workgraph_create",
        { title: "draft with a check", check: "npm test" },
        graph.dir,
      );
      const id = (draft.details as { issue: { id: string } }).issue.id;
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBeUndefined();
      expect(metadataOf(graph, id)[WORKGRAPH_CHECK_KEY]).toBe("npm test");
      await run(mock, "workgraph_approve", { id }, graph.dir);
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(metadataOf(graph, id)[WORKGRAPH_CHECK_KEY]).toBe("npm test");

      // Back to draft, then approved with a waiver: the check is cleared.
      await run(mock, "workgraph_override", { id, action: "release", reason: "retry" }, graph.dir);
      await run(mock, "workgraph_approve", { id, checkWaiver: "docs only" }, graph.dir);
      expect(metadataOf(graph, id)[WORKGRAPH_CHECK_KEY]).toBe("");
      expect(metadataOf(graph, id)[WORKGRAPH_CHECK_WAIVER_KEY]).toBe("docs only");
      expect(textOf(await run(mock, "workgraph_status", { id }, graph.dir))).toContain(
        "Check waived: docs only",
      );

      // And the other way round.
      await run(mock, "workgraph_override", { id, action: "release", reason: "retry" }, graph.dir);
      await run(mock, "workgraph_approve", { id, check: "make check" }, graph.dir);
      expect(metadataOf(graph, id)[WORKGRAPH_CHECK_KEY]).toBe("make check");
      expect(metadataOf(graph, id)[WORKGRAPH_CHECK_WAIVER_KEY]).toBe("");
      const status = textOf(await run(mock, "workgraph_status", { id }, graph.dir));
      expect(status).toContain("Check: make check");
      expect(status).not.toContain("Check waived");
    } finally {
      graph.cleanup();
    }
  });
});

describe("workgraph_create and workgraph_split and the check", () => {
  it("create with approve is held to the rule; a draft is not", async () => {
    const graph = makeScratchGraph({ prefix: "cwcre" });
    const mock = makeTools();
    try {
      const before = issueCount(graph);
      await expect(
        run(mock, "workgraph_create", { title: "approved, unchecked", approve: true }, graph.dir),
      ).rejects.toThrow(`Cannot create approved work: ${refusal("medium")}`);
      await expect(
        run(
          mock,
          "workgraph_create",
          { title: "high, unchecked", approve: true, riskTier: "high" },
          graph.dir,
        ),
      ).rejects.toThrow(refusal("high"));
      await expect(
        run(
          mock,
          "workgraph_create",
          { title: "both", check: "npm test", checkWaiver: "why" },
          graph.dir,
        ),
      ).rejects.toThrow(/not both/);
      // Nothing was created by a refused call.
      expect(issueCount(graph)).toBe(before);

      const checked = await run(
        mock,
        "workgraph_create",
        { title: "approved, checked", approve: true, check: "npm test" },
        graph.dir,
      );
      const checkedId = (checked.details as { issue: { id: string } }).issue.id;
      expect(metadataOf(graph, checkedId)).toMatchObject({
        [WORKGRAPH_PHASE_KEY]: "ready",
        [WORKGRAPH_CHECK_KEY]: "npm test",
      });

      const waived = await run(
        mock,
        "workgraph_create",
        { title: "approved, waived", approve: true, checkWaiver: "docs only" },
        graph.dir,
      );
      const waivedId = (waived.details as { issue: { id: string } }).issue.id;
      expect(metadataOf(graph, waivedId)).toMatchObject({
        [WORKGRAPH_PHASE_KEY]: "ready",
        [WORKGRAPH_CHECK_WAIVER_KEY]: "docs only",
      });

      const low = await run(
        mock,
        "workgraph_create",
        { title: "approved, low", approve: true, riskTier: "low", workflowClass: "oneshot" },
        graph.dir,
      );
      const lowId = (low.details as { issue: { id: string } }).issue.id;
      expect(metadataOf(graph, lowId)[WORKGRAPH_PHASE_KEY]).toBe("ready");

      // A draft with nothing is fine to create; the rule meets it at approval.
      const draft = await run(mock, "workgraph_create", { title: "a draft" }, graph.dir);
      const draftId = (draft.details as { issue: { id: string } }).issue.id;
      await expect(
        run(mock, "workgraph_approve", { id: draftId }, graph.dir),
      ).rejects.toThrow(refusal("medium"));
    } finally {
      graph.cleanup();
    }
  });

  it("split validates every approved child before creating any, and a child takes nothing from its parent", async () => {
    const graph = makeScratchGraph({ prefix: "cwspl" });
    const mock = makeTools();
    try {
      const parent = graph.createIssue("too big");
      // The parent's own check is not the children's.
      graph.op(["update", parent, "--set-metadata", "workgraph_check=npm test"]);
      const before = issueCount(graph);

      // The THIRD child is the one refused: the first two must not exist.
      await expect(
        run(
          mock,
          "workgraph_split",
          {
            id: parent,
            children: [
              { title: "first", approved: true, check: "npm test" },
              { title: "second", approved: true, riskTier: "low" },
              { title: "third", approved: true },
            ],
          },
          graph.dir,
        ),
      ).rejects.toThrow(`Cannot split ${parent}: child "third": ${refusal("medium")}`);
      expect(issueCount(graph)).toBe(before);

      await expect(
        run(
          mock,
          "workgraph_split",
          {
            id: parent,
            children: [{ title: "high", approved: true, riskTier: "high" }],
          },
          graph.dir,
        ),
      ).rejects.toThrow(refusal("high"));
      await expect(
        run(
          mock,
          "workgraph_split",
          {
            id: parent,
            children: [{ title: "both", check: "npm test", checkWaiver: "why" }],
          },
          graph.dir,
        ),
      ).rejects.toThrow(/not both/);
      expect(issueCount(graph)).toBe(before);

      const result = await run(
        mock,
        "workgraph_split",
        {
          id: parent,
          children: [
            { title: "checked", approved: true, check: "npm test -- a" },
            { title: "waived", approved: true, riskTier: "high", checkWaiver: "docs only" },
            { title: "low", approved: true, riskTier: "low" },
            { title: "draft" }, // not approved: the rule meets it later
          ],
        },
        graph.dir,
      );
      const children = (result.details as { children: WorkIssue[] }).children;
      expect(children).toHaveLength(4);
      const [checked, waived, low, draft] = children as [
        WorkIssue,
        WorkIssue,
        WorkIssue,
        WorkIssue,
      ];
      expect(metadataOf(graph, checked.id)).toMatchObject({
        [WORKGRAPH_PHASE_KEY]: "ready",
        [WORKGRAPH_CHECK_KEY]: "npm test -- a",
      });
      expect(metadataOf(graph, waived.id)).toMatchObject({
        [WORKGRAPH_PHASE_KEY]: "ready",
        [WORKGRAPH_CHECK_WAIVER_KEY]: "docs only",
      });
      expect(metadataOf(graph, low.id)[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(metadataOf(graph, low.id)[WORKGRAPH_CHECK_KEY]).toBeUndefined();
      expect(metadataOf(graph, draft.id)[WORKGRAPH_PHASE_KEY]).toBeUndefined();
      expect(metadataOf(graph, draft.id)[WORKGRAPH_CHECK_KEY]).toBeUndefined();
    } finally {
      graph.cleanup();
    }
  });

  it("split under a repository default, and under an observing gate, refuses nothing", async () => {
    const graph = makeScratchGraph({ prefix: "cwspd" });
    const mock = makeTools();
    try {
      const parent = graph.createIssue("too big");
      writeProjectSettings(graph.dir, { check: { command: "make check" } });
      const first = await run(
        mock,
        "workgraph_split",
        { id: parent, children: [{ title: "by default", approved: true }] },
        graph.dir,
      );
      expect((first.details as { children: WorkIssue[] }).children).toHaveLength(1);

      noteSessionCwd(undefined);
      mock.setFlag("workgraph-policy", JSON.stringify({ medium: { gates: { check: "observe" } } }));
      const second = await run(
        mock,
        "workgraph_split",
        { id: parent, children: [{ title: "observed", approved: true }] },
        graph.dir,
      );
      expect((second.details as { children: WorkIssue[] }).children).toHaveLength(1);
    } finally {
      graph.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// the repository default
// ---------------------------------------------------------------------------

describe("the workgraph.check setting", () => {
  it("is read from Pi settings, validated, and never dropped when it is wrong", async () => {
    const graph = makeScratchGraph({ prefix: "cwset" });
    const mock = makeTools();
    captureErrors();
    try {
      const api = asExtensionAPI(mock);
      expect(resolveConfig(api).check).toBeUndefined();

      writeProjectSettings(graph.dir, {
        check: { command: " npm test ", timeoutMs: 120_000, setup: "npm ci" },
      });
      expect(resolveConfig(api).check).toEqual({
        command: "npm test",
        timeoutMs: 120_000,
        setup: "npm ci",
      });

      const invalid: ReadonlyArray<[unknown, RegExp]> = [
        ["npm test", /check must be an object/],
        [{ command: "" }, /check\.command must be a non-empty command string/],
        [{ command: 5 }, /check\.command/],
        [{ timeoutMs: 0 }, /check\.timeoutMs must be a positive number/],
        [{ timeoutMs: "60s" }, /check\.timeoutMs/],
        [{ comand: "npm test" }, /check\.comand is not a check setting \(expected command, timeoutMs, setup\)/],
      ];
      for (const [block, message] of invalid) {
        writeProjectSettings(graph.dir, { check: block });
        expect(() => resolveConfig(api)).toThrow(CheckConfigError);
        expect(() => resolveConfig(api)).toThrow(message);
        expect(() => resolveConfig(api)).toThrow(/set by the "workgraph\.check" setting/);
        // Readers that never consult it keep working.
        expect(() => resolveConfigWithoutPolicy(api)).not.toThrow();
      }
      // A tool call under an invalid block fails with the same message
      // instead of approving against "no default".
      const id = graph.createIssue("under a broken block");
      await expect(
        run(mock, "workgraph_approve", { id, check: "npm test" }, graph.dir),
      ).rejects.toThrow(/check\.comand is not a check setting/);
      expect(metadataOf(graph, id)[WORKGRAPH_PHASE_KEY]).toBeUndefined();
    } finally {
      graph.cleanup();
    }
  });

  it("an invalid block stops dispatch, and dispatch resumes once it is fixed", async () => {
    const repo = makeScratchRepo({ prefix: "cwstop", seed: 1 });
    const id = repo.seededIds[0]!;
    const mock = makeTools();
    mock.setFlag("workgraph-discovery-timeout-ms", "40");
    mock.setFlag("workgraph-accept-timeout-ms", "150");
    mock.setFlag("workgraph-compat-in-session-executor", "false");
    const coordinator = registerCoordinator(asExtensionAPI(mock), {
      getConfig: () => resolveConfig(asExtensionAPI(mock)),
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      behavior: "accept-stall",
    });
    const errors = captureErrors();
    const ectx = makeEventContext(repo.dir);
    try {
      writeProjectSettings(repo.dir, { check: { command: "true" } });
      await run(mock, "workgraph_approve", { id }, repo.dir);

      writeProjectSettings(repo.dir, { check: { timeoutMs: -5 } });
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(fake.requests).toEqual([]);
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(errors().filter((line) => line.includes("check.timeoutMs"))).toHaveLength(1);

      writeProjectSettings(repo.dir, { check: { command: "true" } });
      await settle(mock, ectx.ctx);
      await mock.flushEvents();
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// at the gate: waived work, and work that never met the rule
// ---------------------------------------------------------------------------

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
  /** Replace the config the coordinator resolves from now on. */
  setConfig(overrides: Partial<WorkgraphConfig>): void;
}

/** Tools and a coordinator; the coordinator's config can change mid-test. */
function makeHarness(overrides: Partial<WorkgraphConfig> = {}): Harness {
  const mock = makeTools();
  let config = shippedConfig({ workerIdOverride: WORKER, ...overrides });
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
  });
  return {
    mock,
    coordinator,
    setConfig: (next) => {
      config = shippedConfig({ workerIdOverride: WORKER, ...next });
    },
  };
}

function settle(mock: MockPi, ctx: unknown): Promise<unknown[]> {
  return mock.emit(
    "agent_settled",
    { type: "agent_settled" },
    ctx as Parameters<MockPi["emit"]>[2],
  );
}

async function drive(mock: MockPi, ctx: unknown): Promise<void> {
  await settle(mock, ctx);
  await mock.flushEvents();
}

function isolatedIn(repo: ScratchRepo) {
  return { path: repo.dir, baseRevision: repo.head };
}

/** Approve from outside this process, as the fixtures of the gate suites do. */
function approve(
  graph: ScratchGraph,
  id: string,
  opts: { check?: string; criteria?: string } = {},
): void {
  graph.op([
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=ready",
    "--set-metadata",
    "workgraph_risk_tier=medium",
    "--set-metadata",
    "workgraph_workflow_class=reviewed",
    ...(opts.check !== undefined
      ? ["--set-metadata", `workgraph_check=${opts.check}`]
      : []),
    ...(opts.criteria !== undefined ? ["--acceptance", opts.criteria] : []),
    "--actor",
    "approver",
  ]);
}

async function payloads(
  dir: string,
  id: string,
  marker: string,
): Promise<Array<Record<string, unknown>>> {
  const comments = await listComments(dir, id);
  return comments
    .filter((c) => c.text.startsWith(marker))
    .map((c) => JSON.parse(c.text.slice(marker.length)) as Record<string, unknown>);
}

const audits = (dir: string, id: string, kind: string) =>
  payloads(dir, id, `workgraph-lease ${kind} `);

describe("waived and unapproved work at the gate", () => {
  it("a waived medium-risk issue closes with a stamp that says waived, and the gate report lists it with the reason", async () => {
    const repo = makeScratchRepo({ prefix: "cwwv", seed: 2 });
    const [waived, checked] = repo.seededIds as [string, string];
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      // Approved through the real tool, with the human's reason.
      await run(
        mock,
        "workgraph_approve",
        { id: waived, checkWaiver: "prose only, nothing to run" },
        repo.dir,
      );
      await run(mock, "workgraph_approve", { id: checked, check: "true" }, repo.dir);
      await drive(mock, ectx.ctx);
      await drive(mock, ectx.ctx);

      expect(repo.showIssue(waived).status).toBe("closed");
      expect(repo.showIssue(checked).status).toBe("closed");

      // No command ran for the waived issue, and the stamp says why.
      expect(await listReceipts(repo.dir, waived)).toEqual([]);
      const stamp = await latestStamp(repo.dir, waived);
      expect(stamp!.check).toBe("waived");
      expect(stamp).not.toHaveProperty("checkLogSha256");
      expect(stamp!.gates).toEqual({
        "tree-binding": "pass",
        check: "not-applicable",
        review: "pass",
      });
      const record = (await listGateRecords(repo.dir, waived)).find((r) => r.gate === "check")!;
      expect(record).toMatchObject({
        mode: "enforce",
        result: "not-applicable",
        blocked: false,
        wouldBlock: false,
        reason: "waived: prose only, nothing to run",
      });
      // The reviewer still reviewed it.
      expect(fake.requests.filter((r) => r.issue.id === waived).map((r) => r.role)).toEqual([
        "implementer",
        "reviewer",
      ]);

      // The gate report: under `check`, as not applicable, with the reason.
      const report = textOf(await run(mock, "workgraph_gates", {}, repo.dir)).split("\n");
      expect(report[2]).toBe(
        `check: 0 blocked, 0 would block, 1 not applicable, waived (${waived}: prose only, nothing to run)`,
      );
      // A gate nobody waived keeps its two columns.
      expect(report[0]).toBe("review: 0 blocked, 0 would block");
      const narrowed = await run(mock, "workgraph_gates", { id: checked }, repo.dir);
      expect(textOf(narrowed).split("\n")[2]).toBe("check: 0 blocked, 0 would block");
      expect(
        (narrowed.details as { gates: { check: { waived: unknown[] } } }).gates.check.waived,
      ).toEqual([]);
      const status = textOf(await run(mock, "workgraph_status", { id: waived }, repo.dir));
      expect(status).toContain("Check waived: prose only, nothing to run");
      expect(status).toContain(
        "Gate check: not-applicable (enforce, attempt 1): waived: prose only, nothing to run",
      );
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a legacy issue dispatched without approval and without a check does not close, and the reason names the waiver", async () => {
    const repo = makeScratchRepo({ prefix: "cwleg", seed: 1 });
    const id = repo.seededIds[0]!; // never approved: no lifecycle metadata
    const { mock, coordinator } = makeHarness({ compatLegacyIssues: true });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    captureErrors(); // the once-per-session compat warning
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);

      // Claimed through the compat path, judged at the medium default.
      expect(repo.showIssue(id).status).toBe("blocked");
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      const escalated = await audits(repo.dir, id, "escalated");
      expect(escalated).toHaveLength(1);
      expect(escalated[0]!.reason).toBe(
        "check: no check command; approve with a check or a checkWaiver",
      );
      expect((await listGateRecords(repo.dir, id)).find((r) => r.gate === "check")).toMatchObject({
        mode: "enforce",
        result: "unknown",
        blocked: true,
      });
      // It never reached a reviewer.
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      expect(await latestStamp(repo.dir, id)).toBeUndefined();

      // The fix the reason names works: a waiver on re-approval, and it closes.
      await run(mock, "workgraph_approve", { id, checkWaiver: "legacy import" }, repo.dir);
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      expect((await latestStamp(repo.dir, id))!.check).toBe("waived");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("under observe, medium-risk work with no check is recorded as a would-block and goes on to review", async () => {
    const repo = makeScratchRepo({ prefix: "cwobsg", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness({
      policy: { medium: { gates: { check: "observe" } } },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      expect((await listGateRecords(repo.dir, id)).find((r) => r.gate === "check")).toMatchObject({
        mode: "observe",
        result: "unknown",
        blocked: false,
        wouldBlock: true,
      });
      expect((await latestStamp(repo.dir, id))!.check).toBe("none");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the frozen bar
// ---------------------------------------------------------------------------

describe("the frozen bar", () => {
  it("a check command changed after the claim does not change what runs: the frozen command's receipt, one bar-changed", async () => {
    const repo = makeScratchRepo({ prefix: "cwfrz", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, { check: "exit 1" });
    const { mock, coordinator } = makeHarness();
    // The implementer stalls, which is the window an implementer has to
    // edit what it will be judged against.
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: { behavior: "accept-stall", provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    captureErrors(); // "no revision-capable executor"
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("implementing");

      // The bar was frozen at claim: on the trail, with its digest on the issue.
      const frozen = await audits(repo.dir, id, "bar-frozen");
      expect(frozen).toHaveLength(1);
      expect(frozen[0]).toMatchObject({
        workflowRunId: fake.requests[0]!.workflowRunId,
        digest: metadataOf(repo, id)[WORKGRAPH_BAR_DIGEST_KEY],
        bar: {
          riskTier: "medium",
          check: { command: "exit 1", timeoutMs: 600_000 },
        },
      });
      expect(String(frozen[0]!.digest)).toMatch(/^[0-9a-f]{64}$/);

      // The implementer makes its own check trivially pass.
      repo.op(["update", id, "--set-metadata", "workgraph_check=exit 0", "--actor", "implementer"]);
      fake.complete();
      await mock.flushEvents();

      // The frozen command ran, and failed: the issue did not close.
      expect(repo.showIssue(id).status).not.toBe("closed");
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("revising");
      const receipts = await listReceipts(repo.dir, id);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        commandDigest: commandDigest("exit 1"),
        passed: false,
        reason: "exited 1",
      });
      expect(receipts[0]!.commandDigest).toBe(
        commandDigest((frozen[0]!.bar as { check: { command: string } }).check.command),
      );
      expect(fake.requests.some((r) => r.role === "reviewer")).toBe(false);

      // The change is on the record, once, naming what moved.
      const changed = await audits(repo.dir, id, "bar-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        workflowRunId: fake.requests[0]!.workflowRunId,
        frozenDigest: frozen[0]!.digest,
        fields: ["check"],
      });
      expect(changed[0]!.currentDigest).not.toBe(frozen[0]!.digest);
      // The digest on the issue is still the frozen one.
      expect(metadataOf(repo, id)[WORKGRAPH_BAR_DIGEST_KEY]).toBe(frozen[0]!.digest);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a gate switched off and criteria rewritten after the claim do not apply: the frozen modes and criteria do, and one bar-changed covers every round", async () => {
    const repo = makeScratchRepo({ prefix: "cwfrg", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, { check: "true", criteria: "the strict criteria" });
    const { mock, coordinator, setConfig } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: { behavior: "accept-stall", provenance: IMPL_PROV },
        // Two review rounds: an unparseable verdict, then a clean one.
        reviewer: [
          { provenance: REV_PROV, verdict: "not a verdict" },
          { provenance: REV_PROV, verdict: CLEAN_VERDICT },
        ],
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(fake.requests[0]!.issue.acceptanceCriteria).toBe("the strict criteria");

      // After the claim: the check gate is switched off in the settings the
      // coordinator reads, and the criteria are weakened on the issue.
      setConfig({ policy: { medium: { gates: { check: "off" } } } });
      repo.op(["update", id, "--acceptance", "anything goes", "--actor", "implementer"]);
      fake.complete();
      await mock.flushEvents();

      expect(repo.showIssue(id).status).toBe("closed");
      // The check still ran, under the mode frozen at claim.
      expect(await listReceipts(repo.dir, id)).toHaveLength(1);
      const record = (await listGateRecords(repo.dir, id)).find((r) => r.gate === "check")!;
      expect(record).toMatchObject({ mode: "enforce", result: "pass" });
      expect((await latestStamp(repo.dir, id))!.check).toBe("passed");
      // Both reviewers were given the frozen criteria.
      const reviews = fake.requests.filter((r) => r.role === "reviewer");
      expect(reviews).toHaveLength(2);
      for (const review of reviews) {
        expect(review.issue.acceptanceCriteria).toBe("the strict criteria");
        expect(review.issue.riskTier).toBe("medium");
      }
      // Two rounds of the loop, one record of the change.
      const changed = await audits(repo.dir, id, "bar-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]!.fields).toEqual(["criteria", "gates.check"]);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("the next claim is judged against the new bar", async () => {
    const repo = makeScratchRepo({ prefix: "cwnext", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, { check: "exit 1" });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    captureErrors();
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("revising");

      // A human fixes the command: release, then approve with the new one.
      await run(mock, "workgraph_override", { id, action: "release", reason: "wrong check" }, repo.dir);
      await run(mock, "workgraph_approve", { id, check: "true" }, repo.dir);
      await drive(mock, ectx.ctx);

      expect(repo.showIssue(id).status).toBe("closed");
      const frozen = await audits(repo.dir, id, "bar-frozen");
      expect(frozen.map((f) => (f.bar as { check: { command: string } }).check.command)).toEqual([
        "exit 1",
        "true",
      ]);
      expect(metadataOf(repo, id)[WORKGRAPH_BAR_DIGEST_KEY]).toBe(frozen[1]!.digest);
      const receipts = await listReceipts(repo.dir, id);
      expect(receipts.map((r) => [r.commandDigest, r.passed])).toEqual([
        [commandDigest("exit 1"), false],
        [commandDigest("true"), true],
      ]);
      // The same tree, checked once per command.
      expect(receipts[0]!.tree).toBe(receipts[1]!.tree);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  /**
   * A run parked in judging (no reviewer), then a crash: memory is dropped,
   * the store keeps everything. A graceful teardown would release the run
   * and leave nothing to adopt.
   */
  async function crashInJudging(prefix: string, check: string, before?: (repo: ScratchRepo) => void) {
    resetLeasesForTest();
    const repo = makeScratchRepo({ prefix, seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, { check });
    before?.(repo);
    const first = makeHarness();
    const fakeA = installFakeExecutor(first.mock.events, {
      executorId: "implementer-exec",
      roles: ["implementer"],
      workspace: isolatedIn(repo),
      roleScripts: { implementer: { provenance: IMPL_PROV } },
    });
    const ectx1 = makeEventContext(repo.dir);
    await drive(first.mock, ectx1.ctx);
    expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("judging");
    fakeA.uninstall();
    resetLeasesForTest();
    return { repo, id, teardownFirst: () => first.coordinator.teardown(ectx1.ctx) };
  }

  it("a restart rebuilds the bar from the bar-frozen event, not from the issue as it is now", async () => {
    captureErrors();
    const crashed = await crashInJudging("cwrst", "true");
    const { repo, id } = crashed;
    const second = makeHarness();
    const fakeB = installFakeExecutor(second.mock.events, {
      executorId: "reviewer-exec",
      roles: ["reviewer"],
      roleScripts: { reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT } },
    });
    const ectx2 = makeEventContext(repo.dir);
    try {
      // Edited while nobody was watching: the stored command now fails.
      repo.op(["update", id, "--set-metadata", "workgraph_check=exit 1", "--actor", "someone"]);

      await second.coordinator.reconcile(ectx2.ctx);
      await second.mock.flushEvents();

      // Judged on the frozen command, whose receipt was already on the trail.
      expect(repo.showIssue(id).status).toBe("closed");
      const receipts = await listReceipts(repo.dir, id);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.commandDigest).toBe(commandDigest("true"));
      expect(await audits(repo.dir, id, "bar-frozen")).toHaveLength(1);
      const changed = await audits(repo.dir, id, "bar-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]!.fields).toEqual(["check"]);
    } finally {
      fakeB.uninstall();
      await crashed.teardownFirst();
      await second.coordinator.teardown(ectx2.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a run whose bar-frozen record was lost freezes a bar at re-adoption and says the bar may have moved", async () => {
    const errors = captureErrors();
    const crashed = await crashInJudging("cwlost", "true", (repo) => {
      // The claim's event write fails; its digest still lands in metadata.
      failCommentWrites(repo.dir, "workgraph-lease bar-frozen ");
    });
    const { repo, id } = crashed;
    const second = makeHarness();
    const fakeB = installFakeExecutor(second.mock.events, {
      executorId: "reviewer-exec",
      roles: ["reviewer"],
      roleScripts: { reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT } },
    });
    const ectx2 = makeEventContext(repo.dir);
    try {
      expect(await audits(repo.dir, id, "bar-frozen")).toEqual([]);
      const claimed = String(metadataOf(repo, id)[WORKGRAPH_BAR_DIGEST_KEY]);
      expect(claimed).toMatch(/^[0-9a-f]{64}$/);
      repo.op(["update", id, "--acceptance", "rewritten while down", "--actor", "someone"]);

      await second.coordinator.reconcile(ectx2.ctx);
      await second.mock.flushEvents();

      // The new bar does not match the digest the claim recorded.
      const changed = await audits(repo.dir, id, "bar-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({ frozenDigest: claimed, fields: [] });
      expect(String(changed[0]!.reason)).toMatch(/could not be read back/);
      expect(metadataOf(repo, id)[WORKGRAPH_BAR_DIGEST_KEY]).toBe(changed[0]!.currentDigest);
      expect(errors().some((line) => line.includes("AUDIT WRITE FAILED (bar-frozen"))).toBe(true);
      // The run goes on, on the bar frozen at re-adoption.
      expect(repo.showIssue(id).status).toBe("closed");
      expect(heldLeases(repo.dir)).toHaveLength(0);
    } finally {
      fakeB.uninstall();
      await crashed.teardownFirst();
      await second.coordinator.teardown(ectx2.ctx);
      repo.cleanup();
    }
  }, 60_000);
});
