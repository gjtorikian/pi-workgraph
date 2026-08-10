/**
 * Contract criterion 5: after a forced compaction, the next
 * `before_agent_start` output still contains the fenced `<workgraph>`
 * section with live graph data — per-turn re-injection is the
 * compaction-survival workhorse, and the Full-tier takeover shapes the
 * summary itself (mocked `compact()`; live model is Phase 4's smoke test).
 *
 * Run via `npm run test:context`.
 */
import type { compact } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindExec, resetExecLog } from "../src/bd.ts";
import { registerCompactionTakeover } from "../src/compaction.ts";
import {
  CONTEXT_CACHE_TTL_MS,
  registerContextInjection,
  resetContextCacheForTest,
} from "../src/context.ts";
import {
  defaultLeaseActor,
  resetIdentityForTest,
  setWorkerIdOverride,
} from "../src/identity.ts";
import { acquireLease, resetLeasesForTest } from "../src/lease.ts";
import type { Lease } from "../src/types.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockEventContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const WORKER = "context-drain-worker";
const BASE_PROMPT = "You are pi, a coding agent. Original system prompt.";

let mock: MockPi;
let graph: ScratchGraph;
let ectx: MockEventContext;
let nowMs = Date.now();
let heldLease: Lease;
const compactInstructions: (string | undefined)[] = [];

beforeAll(async () => {
  mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  setWorkerIdOverride(WORKER);
  graph = makeScratchGraph({ seed: 3, prefix: "ctxi" });
  ectx = makeEventContext(graph.dir, { model: {} });

  registerContextInjection(asExtensionAPI(mock), { now: () => nowMs });
  const fakeCompact = (async (...args: unknown[]) => {
    compactInstructions.push(args[4] as string | undefined);
    return { summary: "fake summary", firstKeptEntryId: "entry-0", tokensBefore: 9000 };
  }) as unknown as typeof compact;
  // Default getCurrent: the held-lease registry — live claim data.
  registerCompactionTakeover(asExtensionAPI(mock), { compactFn: fakeCompact });

  // Work in flight: one seeded issue claimed and leased.
  const outcome = await acquireLease(graph.dir, {
    ttlMs: 300_000,
    now: () => nowMs,
    actor: defaultLeaseActor(),
  });
  if (outcome.kind !== "acquired") {
    throw new Error(`expected a claim, got ${outcome.kind}`);
  }
  heldLease = outcome.lease;
  resetExecLog();
}, 60_000);

afterAll(() => {
  graph?.cleanup();
  resetLeasesForTest();
  resetContextCacheForTest();
  resetIdentityForTest();
});

describe("criterion 5: context survives forced compaction", () => {
  it("injects live graph state, survives the takeover, and re-injects after truncation", async () => {
    // Turn 1: the section rides the full prompt.
    const before = await mock.emitBeforeAgentStart(ectx.ctx, {
      systemPrompt: BASE_PROMPT,
    });
    expect(before).toContain("<workgraph>");
    expect(before).toContain(`Current claim: ${heldLease.issueId}`);

    // Forced compaction: the Full-tier takeover shapes the summary and
    // preserves the user's own instructions.
    const { takenOver } = await mock.simulateForcedCompaction(ectx.ctx, {
      customInstructions: "keep the migration checklist",
    });
    expect(takenOver).toBe(true);
    expect(compactInstructions[0]).toContain("keep the migration checklist");
    expect(compactInstructions[0]).toContain(heldLease.issueId);
    expect(compactInstructions[0]).toContain("acceptance criteria");

    // The compaction dropped the graph state from the prompt. Next turn:
    // re-injected fresh, with LIVE data (cache expired = fresh bd probe).
    nowMs += CONTEXT_CACHE_TTL_MS + 1;
    const truncated = "[conversation compacted]\nfake summary";
    const after = await mock.emitBeforeAgentStart(ectx.ctx, {
      systemPrompt: truncated,
    });

    expect(after.startsWith(truncated)).toBe(true);
    expect(after).toContain("<workgraph>");
    expect(after).toContain("</workgraph>");
    // Live claim line with countdown, and the still-ready seeded issues.
    expect(after).toContain(`Current claim: ${heldLease.issueId}`);
    const stillReady = graph.seededIds.filter(
      (id) => id !== heldLease.issueId,
    );
    expect(stillReady).toHaveLength(2);
    for (const id of stillReady) {
      expect(after).toContain(id);
    }
    expect(after).toContain("Ready issues (2 claimable):");
    expect(after).toContain("workgraph_close");
  }, 60_000);
});
