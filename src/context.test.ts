/**
 * Context injection units: section presence and content, append-not-replace
 * chaining, cache TTL (bd exec count), the uninitialized-dir gate, and
 * post-compaction persistence — plus the compaction takeover's instruction
 * assembly and never-block-compaction edges (the `compact()` call itself is
 * mocked; a live-model compaction is the Phase 4 manual smoke item).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { compact } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bindExec, getExecLog, resetExecLog } from "./bd.ts";
import {
  buildCompactionInstructions,
  registerCompactionTakeover,
} from "./compaction.ts";
import {
  cachedGraphState,
  CONTEXT_CACHE_TTL_MS,
  READY_RENDER_LIMIT,
  registerContextInjection,
  renderWorkgraphSection,
  resetContextCacheForTest,
} from "./context.ts";
import {
  defaultLeaseActor,
  resetIdentityForTest,
  setWorkerIdOverride,
} from "./identity.ts";
import { acquireLease, resetLeasesForTest, trackLease } from "./lease.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockPi,
} from "../test/helpers/mock-pi.ts";
import {
  makeScratchGraph,
  type ScratchGraph,
} from "../test/helpers/scratch.ts";

const WORKER = "context-test-worker";
const BASE_PROMPT = "You are pi, a coding agent.";

let nowMs = Date.now();
const graphs: ScratchGraph[] = [];

function makeGraph(seed: number): ScratchGraph {
  const graph = makeScratchGraph({ seed, prefix: "ctxt" });
  graphs.push(graph);
  return graph;
}

function makeInjectionHarness(): MockPi {
  const mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  registerContextInjection(asExtensionAPI(mock), { now: () => nowMs });
  return mock;
}

function readyExecCount(): number {
  return getExecLog().filter((entry) => entry.args[0] === "ready").length;
}

beforeAll(() => {
  setWorkerIdOverride(WORKER);
}, 60_000);

afterAll(() => {
  for (const graph of graphs) graph.cleanup();
  resetIdentityForTest();
});

afterEach(() => {
  resetContextCacheForTest();
  resetLeasesForTest();
  resetExecLog();
  nowMs = Date.now();
});

describe("injection gate", () => {
  it("injects nothing for an uninitialized directory (no .beads/)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-ctx-noinit-"));
    try {
      const mock = makeInjectionHarness();
      const { ctx } = makeEventContext(dir);
      const result = await mock.emitBeforeAgentStart(ctx, {
        systemPrompt: BASE_PROMPT,
      });
      expect(result).toBe(BASE_PROMPT);
      expect(result).not.toContain("<workgraph>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("appends (never replaces): the base prompt survives verbatim", async () => {
    const graph = makeGraph(2);
    const mock = makeInjectionHarness();
    const { ctx } = makeEventContext(graph.dir);
    const result = await mock.emitBeforeAgentStart(ctx, {
      systemPrompt: BASE_PROMPT,
    });
    expect(result.startsWith(BASE_PROMPT)).toBe(true);
    expect(result).toContain("<workgraph>");
    expect(result).toContain("</workgraph>");
  }, 30_000);
});

describe("section content", () => {
  it("zero-ready graph: section present and says so", async () => {
    const graph = makeGraph(0);
    const mock = makeInjectionHarness();
    const { ctx } = makeEventContext(graph.dir);
    const result = await mock.emitBeforeAgentStart(ctx, {
      systemPrompt: BASE_PROMPT,
    });
    expect(result).toContain("<workgraph>");
    expect(result).toContain("Ready issues: none claimable right now.");
    expect(result).toContain("Current claim: none.");
    expect(result).toContain("workgraph_claim");
  }, 30_000);

  it("caps rendering at top-5 and folds the rest into the count", async () => {
    const graph = makeGraph(7);
    const mock = makeInjectionHarness();
    const { ctx } = makeEventContext(graph.dir);
    const result = await mock.emitBeforeAgentStart(ctx, {
      systemPrompt: BASE_PROMPT,
    });
    expect(result).toContain("Ready issues (7 claimable):");
    const listed = graph.seededIds.filter((id) => result.includes(id));
    expect(listed).toHaveLength(READY_RENDER_LIMIT);
    expect(result).toContain("...and 2 more");
  }, 30_000);

  it("shows the current claim with a lease countdown", async () => {
    const graph = makeGraph(2);
    const mock = makeInjectionHarness();
    const { ctx } = makeEventContext(graph.dir);
    const outcome = await acquireLease(graph.dir, {
      ttlMs: 300_000,
      now: () => nowMs,
      actor: defaultLeaseActor(),
    });
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") return;

    const result = await mock.emitBeforeAgentStart(ctx, {
      systemPrompt: BASE_PROMPT,
    });
    expect(result).toContain(`Current claim: ${outcome.lease.issueId}`);
    // ~5 min TTL; rfc3339 truncates to seconds, so allow 4:5x too.
    expect(result).toMatch(/expires in (5:00|4:5\d)/);
  }, 30_000);
});

describe("cache TTL", () => {
  it("two turns inside the TTL cost one bd probe; expiry re-probes", async () => {
    const graph = makeGraph(1);
    const mock = makeInjectionHarness();
    const { ctx } = makeEventContext(graph.dir);

    await mock.emitBeforeAgentStart(ctx, { systemPrompt: BASE_PROMPT });
    const afterFirst = readyExecCount();
    expect(afterFirst).toBe(1);

    nowMs += CONTEXT_CACHE_TTL_MS - 1;
    await mock.emitBeforeAgentStart(ctx, { systemPrompt: BASE_PROMPT });
    expect(readyExecCount()).toBe(afterFirst); // cache hit

    nowMs += 2; // past the TTL
    await mock.emitBeforeAgentStart(ctx, { systemPrompt: BASE_PROMPT });
    expect(readyExecCount()).toBe(afterFirst + 1);
  }, 30_000);

  it("cachedGraphState reflects a mid-session bd init after expiry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-ctx-lateinit-"));
    try {
      makeInjectionHarness(); // binds exec
      const first = await cachedGraphState(dir, { now: () => nowMs });
      expect(first.initialized).toBe(false);

      // `bd init` lands mid-session; the next probe past the TTL picks it
      // up (ensureWorkspace caches successes but never failures).
      execFileSync("bd", ["init", "--prefix", "late"], { cwd: dir });
      nowMs += CONTEXT_CACHE_TTL_MS + 1;
      const second = await cachedGraphState(dir, { now: () => nowMs });
      expect(second.initialized).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("post-compaction persistence (unit)", () => {
  it("a truncated system prompt still gets the fenced section next turn", async () => {
    const graph = makeGraph(2);
    const mock = makeInjectionHarness();
    const { ctx } = makeEventContext(graph.dir);

    // Turn 1: full prompt, section present.
    const full = await mock.emitBeforeAgentStart(ctx, {
      systemPrompt: BASE_PROMPT,
    });
    expect(full).toContain("<workgraph>");

    // Compaction dropped everything: per-turn append re-adds it fresh.
    const truncated = "[conversation compacted: summary only]";
    const next = await mock.emitBeforeAgentStart(ctx, {
      systemPrompt: truncated,
    });
    expect(next.startsWith(truncated)).toBe(true);
    expect(next).toContain("<workgraph>");
    expect(next).toContain(graph.seededIds[0]!);
  }, 30_000);
});

describe("renderWorkgraphSection", () => {
  it("stays within the ~30-line prompt-bloat cap", () => {
    const issues = Array.from({ length: 5 }, (_, i) => ({
      id: `big-${i}`,
      title: `issue ${i}`,
      status: "open",
      priority: 2,
      issue_type: "task",
    }));
    const section = renderWorkgraphSection(
      {
        initialized: true,
        readyCount: 120,
        readyTop: issues,
        fetchedAt: nowMs,
      },
      [{ cwd: "/x", issueId: "big-held", epoch: 3, expiresAt: new Date(nowMs + 60_000).toISOString(), actor: defaultLeaseActor() }],
      nowMs,
    );
    expect(section.split("\n").length).toBeLessThanOrEqual(30);
    expect(section).toContain("...and 115 more");
  });
});

describe("compaction takeover", () => {
  const FAKE_RESULT = {
    summary: "fake summary",
    firstKeptEntryId: "entry-0",
    tokensBefore: 123,
  };

  function makeTakeoverHarness(opts: {
    compactImpl?: (...args: unknown[]) => Promise<unknown>;
  } = {}) {
    const mock = makeMockPi();
    const calls: { instructions?: string }[] = [];
    const impl =
      opts.compactImpl ??
      (async (...args: unknown[]) => {
        calls.push({ instructions: args[4] as string | undefined });
        return FAKE_RESULT;
      });
    registerCompactionTakeover(asExtensionAPI(mock), {
      compactFn: impl as unknown as typeof compact,
    });
    return { mock, calls };
  }

  it("buildCompactionInstructions preserves user instructions and demands the task narrative", () => {
    const text = buildCompactionInstructions("Focus on the API redesign.", {
      issueId: "wg-42",
      title: "Ship the dispatcher",
    });
    expect(text.startsWith("Focus on the API redesign.")).toBe(true);
    expect(text).toContain('wg-42 ("Ship the dispatcher")');
    expect(text).toContain("tried so far");
    expect(text).toContain("acceptance criteria");

    const bare = buildCompactionInstructions(undefined, { issueId: "wg-7" });
    expect(bare).toContain("wg-7");
    expect(bare).toContain("acceptance criteria");
  });

  it("takes over compaction when work is in flight, folding user instructions in", async () => {
    const { mock, calls } = makeTakeoverHarness();
    trackLease("/fake/cwd", {
      issueId: "wg-9",
      epoch: 2,
      expiresAt: new Date(nowMs + 60_000).toISOString(),
    }, defaultLeaseActor());
    const { ctx } = makeEventContext("/fake/cwd", { model: {} });
    const { takenOver, results } = await mock.simulateForcedCompaction(ctx, {
      customInstructions: "keep the user's focus",
    });
    expect(takenOver).toBe(true);
    expect(results[0]).toEqual({ compaction: FAKE_RESULT });
    expect(calls[0]!.instructions).toContain("keep the user's focus");
    expect(calls[0]!.instructions).toContain("wg-9");
  });

  it("falls back to default compaction with nothing in flight", async () => {
    const { mock } = makeTakeoverHarness();
    const { ctx } = makeEventContext("/fake/cwd", { model: {} });
    const { takenOver } = await mock.simulateForcedCompaction(ctx);
    expect(takenOver).toBe(false);
  });

  it("falls back when the model or credentials are unavailable", async () => {
    trackLease("/fake/cwd", {
      issueId: "wg-9",
      epoch: 2,
      expiresAt: new Date(nowMs + 60_000).toISOString(),
    }, defaultLeaseActor());

    const noModel = makeTakeoverHarness();
    const noModelCtx = makeEventContext("/fake/cwd", { model: undefined });
    expect(
      (await noModel.mock.simulateForcedCompaction(noModelCtx.ctx)).takenOver,
    ).toBe(false);

    const badAuth = makeTakeoverHarness();
    const badAuthCtx = makeEventContext("/fake/cwd", {
      model: {},
      auth: { ok: false, error: "no key" },
    });
    expect(
      (await badAuth.mock.simulateForcedCompaction(badAuthCtx.ctx)).takenOver,
    ).toBe(false);
  });

  it("never blocks compaction when compact() throws", async () => {
    trackLease("/fake/cwd", {
      issueId: "wg-9",
      epoch: 2,
      expiresAt: new Date(nowMs + 60_000).toISOString(),
    }, defaultLeaseActor());
    const { mock } = makeTakeoverHarness({
      compactImpl: async () => {
        throw new Error("summarizer exploded");
      },
    });
    const { ctx } = makeEventContext("/fake/cwd", { model: {} });
    const { takenOver, results } = await mock.simulateForcedCompaction(ctx);
    expect(takenOver).toBe(false);
    expect(results[0]).toBeUndefined();
  });
});
