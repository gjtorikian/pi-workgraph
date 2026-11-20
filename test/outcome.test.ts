/**
 * The outcome record, its tool, the scorecard, and the caller-defined
 * outcome step (proof-of-success phase 6).
 *
 * Four layers, each on the smallest harness that can show it:
 *  - the record and the scorecard: `src/outcome.ts` against a scratch graph
 *    and hand-built rows;
 *  - the tools: registered on a mock, called through `execute`, against
 *    issues closed by hand the three ways an issue can be (by the gate, by
 *    an override, not at all), with no executor installed;
 *  - the step: a coordinator on `shippedConfig` in a real git repository
 *    (`makeScratchRepo`), so every close is stamped, with a fake executor
 *    that offers `finalizer` in the background and an injected clock for
 *    the deadline;
 *  - the background launch: the real pi-subagents bridge over the fake
 *    upstream (`installFakeSubagents`).
 *
 * Timer discipline is the repo's: no fake timers, huge scheduling intervals,
 * tiny REAL protocol timeouts, ticks driven through `agent_settled`, and
 * `flushEvents()` to drain the completion handler.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOutcomeTask,
  PI_SUBAGENTS_EXECUTOR_ID,
  registerPiSubagentsExecutor,
  type PiSubagentsController,
} from "../src/adapters/pi-subagents.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import { resolveConfig } from "../src/config.ts";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import {
  DEFAULT_OUTCOME_TIMEOUT_MS,
  latestOutcome,
  MAX_OUTCOME_SUMMARY_CHARS,
  Outcome,
  OUTCOME_MARKER,
  outcomeReportInstruction,
  recordOutcome,
  renderScorecard,
  scorecard,
  type ScorecardRow,
} from "../src/outcome.ts";
import { latestStamp, recordStamp, type StampCheck } from "../src/proof.ts";
import {
  CH,
  newEnvelope,
  subagentsSupportsBackground,
  type ExecutorOfferT,
  type RunCompletedT,
  type RunRequestT,
} from "../src/protocol.ts";
import { pendingOutcomes } from "../src/recovery.ts";
import { addComment, listComments } from "../src/store.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import {
  RecordOutcomeParams,
  WORKGRAPH_OUTCOME_DEADLINE_KEY,
  WORKGRAPH_OUTCOME_EXECUTION_ID_KEY,
  WORKGRAPH_OUTCOME_KEY,
  WORKGRAPH_OUTCOME_STATUS_KEY,
  type VerdictT,
} from "../src/types.ts";
import { preProofConfig, shippedConfig } from "./helpers/config.ts";
import {
  installFakeExecutor,
  type FakeExecutorOptions,
} from "./helpers/fake-executor.ts";
import { installFakeSubagents } from "./helpers/fake-subagents.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import {
  makeScratchGraph,
  makeScratchRepo,
  type ScratchGraph,
  type ScratchRepo,
} from "./helpers/scratch.ts";

const WORKER = "outcome-worker";

/** Distinct author/reviewer provenance: independent under every policy. */
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };
const CLEAN_VERDICT: VerdictT = { findings: [] };

/**
 * The caller's instructions, with the kind of whitespace a trim or a
 * reformat would lose. "Verbatim" is asserted against this exact string.
 */
const INSTRUCTIONS =
  "  Watch the change named in the finalization result until it can be merged.\n\nReport how many fix rounds it needed.  ";

const STEP_SILENT = "the outcome step ended without reporting";
const STEP_LATE = "the outcome step did not report before its deadline";

function metadataOf(graph: ScratchGraph, id: string): Record<string, unknown> {
  return (graph.showIssue(id).metadata ?? {}) as Record<string, unknown>;
}

/** The JSON payloads of every comment on `id` that starts with `marker`. */
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

/**
 * Close an issue the way the gate leaves one: phase `accepted`, the close
 * stamp of its run, then the close with the gate's reason. Built by hand so
 * the tools can be exercised with no coordinator and no executor at all.
 */
async function gateClosed(
  graph: ScratchGraph,
  title: string,
  opts: { check?: StampCheck } = {},
): Promise<string> {
  const id = graph.createIssue(title);
  const workflowRunId = `workgraph-run/${id}`;
  graph.op([
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=accepted",
    "--set-metadata",
    `workgraph_workflow_run_id=${workflowRunId}`,
  ]);
  await recordStamp(graph.dir, id, {
    workflowRunId,
    attempt: 1,
    gates: { check: "pass" },
    check: opts.check ?? "passed",
  });
  graph.op(["close", id, "--reason", "accepted by the judgment gate"]);
  return id;
}

/** The text a tool result shows. */
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((c) => c.text ?? "").join("\n");

afterEach(() => {
  vi.restoreAllMocks();
  resetLeasesForTest();
  resetIdentityForTest();
});

// ---------------------------------------------------------------------------
// the record
// ---------------------------------------------------------------------------

describe("record", () => {
  it("validates the four outcomes and nothing else", () => {
    for (const outcome of ["clean", "needed_fixes", "abandoned", "unknown"]) {
      expect(Value.Check(Outcome, { outcome, summary: "s" })).toBe(true);
    }
    expect(Value.Check(Outcome, { outcome: "weird", summary: "s" })).toBe(false);
    expect(Value.Check(Outcome, { outcome: "clean" })).toBe(false);
    expect(Value.Check(Outcome, { outcome: "clean", summary: "" })).toBe(false);
    expect(
      Value.Check(Outcome, { outcome: "needed_fixes", fixRounds: -1, summary: "s" }),
    ).toBe(false);
    expect(
      Value.Check(Outcome, {
        outcome: "needed_fixes",
        fixRounds: 2,
        summary: "s",
        data: { anything: [1, "two"] },
      }),
    ).toBe(true);
  });

  it("recording again is allowed: the latest wins and the history stays on the trail", async () => {
    const graph = makeScratchGraph({ prefix: "ocrec", seed: 1 });
    const id = graph.seededIds[0]!;
    try {
      expect(await latestOutcome(graph.dir, id)).toBeUndefined();

      await recordOutcome(
        graph.dir,
        id,
        { outcome: "clean", summary: "merged untouched" },
        { actor: "someone" },
        "someone",
      );
      expect(await latestOutcome(graph.dir, id)).toMatchObject({
        outcome: "clean",
        summary: "merged untouched",
        actor: "someone",
      });
      expect(metadataOf(graph, id)[WORKGRAPH_OUTCOME_KEY]).toBe("clean");

      await recordOutcome(
        graph.dir,
        id,
        { outcome: "needed_fixes", fixRounds: 2, summary: "two rounds of CI fixes" },
        { actor: "someone", executionId: "exec-9" },
        "someone",
      );
      const latest = await latestOutcome(graph.dir, id);
      expect(latest).toMatchObject({
        outcome: "needed_fixes",
        fixRounds: 2,
        summary: "two rounds of CI fixes",
        executionId: "exec-9",
      });
      // `at` is the comment's own creation time.
      expect(Number.isNaN(Date.parse(latest!.at))).toBe(false);

      const records = await payloads(graph.dir, id, OUTCOME_MARKER);
      expect(records.map((r) => r.outcome)).toEqual(["clean", "needed_fixes"]);
      const metadata = metadataOf(graph, id);
      expect(metadata[WORKGRAPH_OUTCOME_KEY]).toBe("needed_fixes:2");
      expect(metadata[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("recorded");
      expect(await audits(graph.dir, id, "outcome-recorded")).toHaveLength(2);
    } finally {
      graph.cleanup();
    }
  });

  it("stores needed_fixes with no round count as given, and caps a long summary", async () => {
    const graph = makeScratchGraph({ prefix: "occap", seed: 1 });
    const id = graph.seededIds[0]!;
    try {
      await recordOutcome(
        graph.dir,
        id,
        { outcome: "needed_fixes", summary: "x".repeat(2_000) },
        {},
      );
      const latest = await latestOutcome(graph.dir, id);
      expect(latest!.outcome).toBe("needed_fixes");
      expect(latest).not.toHaveProperty("fixRounds");
      expect(latest!.summary.length).toBe(MAX_OUTCOME_SUMMARY_CHARS);
      expect(latest!.summary.endsWith("[truncated]")).toBe(true);
      expect(metadataOf(graph, id)[WORKGRAPH_OUTCOME_KEY]).toBe("needed_fixes");
    } finally {
      graph.cleanup();
    }
  });

  it("skips a newest record that does not parse or validate and falls back to the valid one", async () => {
    const graph = makeScratchGraph({ prefix: "ocbad", seed: 1 });
    const id = graph.seededIds[0]!;
    try {
      await recordOutcome(graph.dir, id, { outcome: "abandoned", summary: "reverted" }, {});
      await addComment(graph.dir, id, `${OUTCOME_MARKER}{not json`);
      await addComment(
        graph.dir,
        id,
        `${OUTCOME_MARKER}${JSON.stringify({ outcome: "weird", summary: "s" })}`,
      );
      await addComment(graph.dir, id, `${OUTCOME_MARKER}[]`);
      expect(await latestOutcome(graph.dir, id)).toMatchObject({
        outcome: "abandoned",
        summary: "reverted",
      });
    } finally {
      graph.cleanup();
    }
  });

  it("an outcome belongs to one close: a record for an earlier run is not the latest close's", async () => {
    const graph = makeScratchGraph({ prefix: "octie", seed: 1 });
    const id = graph.seededIds[0]!;
    try {
      await recordStamp(graph.dir, id, {
        workflowRunId: "workgraph-run/first",
        attempt: 1,
        gates: {},
      });
      await recordOutcome(
        graph.dir,
        id,
        { outcome: "clean", summary: "first close held" },
        { workflowRunId: "workgraph-run/first" },
      );
      expect((await latestOutcome(graph.dir, id))!.outcome).toBe("clean");

      // Released, re-approved and closed again by another run.
      await recordStamp(graph.dir, id, {
        workflowRunId: "workgraph-run/second",
        attempt: 1,
        gates: {},
      });
      expect(await latestOutcome(graph.dir, id)).toBeUndefined();
    } finally {
      graph.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// the scorecard
// ---------------------------------------------------------------------------

describe("scorecard", () => {
  const NOW = new Date("2026-06-15T12:00:00.000Z");
  const daysAgo = (days: number): string =>
    new Date(NOW.getTime() - days * 86_400_000).toISOString();
  const row = (
    n: number,
    over: Partial<ScorecardRow> = {},
  ): ScorecardRow => ({
    issueId: `wg-${n}`,
    title: `issue ${n}`,
    closedAt: daysAgo(1),
    check: "passed",
    ...over,
  });

  it("zero rows: nothing is counted and nothing is divided", () => {
    const card = scorecard([], { now: NOW, windowDays: 7 });
    expect(card).toMatchObject({
      windowDays: 7,
      total: 0,
      clean: 0,
      neededFixes: 0,
      abandoned: 0,
      unknown: 0,
      none: 0,
      worst: [],
    });
    const text = renderScorecard(card);
    expect(text).toBe("No gate-closed issues in the last 7 days.");
    expect(text).not.toMatch(/NaN|%/);
  });

  it("four rows print counts, never a percentage, and none is not clean", () => {
    const card = scorecard(
      [
        row(1, { outcome: "clean" }),
        row(2, { outcome: "clean", check: "waived" }),
        row(3, { outcome: "needed_fixes", fixRounds: 2 }),
        row(4),
      ],
      { now: NOW, windowDays: 7 },
    );
    expect(card).toMatchObject({
      total: 4,
      clean: 2,
      neededFixes: 1,
      abandoned: 0,
      unknown: 0,
      none: 1,
    });
    expect(card.byCheck).toEqual({
      passed: { total: 3, clean: 1 },
      waived: { total: 1, clean: 1 },
      none: { total: 0, clean: 0 },
      failed: { total: 0, clean: 0 },
    });
    expect(card.worst).toEqual([
      { issueId: "wg-3", title: "issue 3", outcome: "needed_fixes", fixRounds: 2 },
    ]);
    const text = renderScorecard(card);
    expect(text).toContain("2 of 4 needed nothing");
    expect(text).not.toContain("%");
    expect(text).toContain("1 of 4 have no outcome recorded");
    expect(text).toContain("check passed: 1 of 3 needed nothing");
    expect(text).toContain("check waived: 1 of 1 needed nothing");
  });

  it("twelve rows print a percentage beside the counts", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row(i + 1, { outcome: i < 9 ? "clean" : "needed_fixes" }),
    );
    const card = scorecard(rows, { now: NOW, windowDays: 7 });
    expect(card.total).toBe(12);
    expect(card.clean).toBe(9);
    expect(renderScorecard(card)).toContain("75% needed nothing (9 of 12)");
  });

  it("counts a close exactly windowDays old and leaves out an older or undated one", () => {
    const card = scorecard(
      [
        row(1, { outcome: "clean", closedAt: daysAgo(7) }),
        row(2, { outcome: "clean", closedAt: daysAgo(7.01) }),
        row(3, { outcome: "clean", closedAt: "not a date" }),
        { issueId: "wg-4", title: "undated", outcome: "clean" },
        row(5, { outcome: "abandoned", closedAt: daysAgo(30) }),
      ],
      { now: NOW, windowDays: 7 },
    );
    expect(card.total).toBe(1);
    expect(card.clean).toBe(1);
    expect(card.abandoned).toBe(0);
    expect(scorecard([row(5, { closedAt: daysAgo(30) })], { now: NOW, windowDays: 31 }).total).toBe(1);
  });

  it("orders the worst: abandoned, then fix rounds descending (none given is one), then unknown", () => {
    const card = scorecard(
      [
        row(1, { outcome: "unknown" }),
        row(2, { outcome: "needed_fixes" }),
        row(3, { outcome: "needed_fixes", fixRounds: 3 }),
        row(4, { outcome: "abandoned" }),
        row(5, { outcome: "clean" }),
        row(6),
        row(7, { outcome: "needed_fixes", fixRounds: 1 }),
      ],
      { now: NOW, windowDays: 7 },
    );
    expect(card.worst.map((w) => w.issueId)).toEqual([
      "wg-4",
      "wg-3",
      "wg-2",
      "wg-7",
      "wg-1",
    ]);
    // A missing count sorts as one round but is not printed as one.
    expect(card.worst[2]).toEqual({
      issueId: "wg-2",
      title: "issue 2",
      outcome: "needed_fixes",
    });
  });

  it("prints the none count first when most counted issues have no outcome", () => {
    const card = scorecard(
      [row(1), row(2), row(3), row(4, { outcome: "clean" })],
      { now: NOW, windowDays: 7 },
    );
    expect(card.none).toBe(3);
    const lines = renderScorecard(card).split("\n");
    expect(lines[1]).toContain("3 of 4 have no outcome recorded");
    expect(lines[2]).toBe("1 of 4 needed nothing");
  });

  it("splits by the stamp's check field: failed has a column, and no field counts under none", () => {
    const card = scorecard(
      [
        row(1, { outcome: "clean", check: "failed" }),
        { issueId: "wg-2", title: "gate off", closedAt: daysAgo(1), outcome: "clean" },
        row(3, { check: "none" }),
      ],
      { now: NOW, windowDays: 7 },
    );
    expect(card.byCheck.failed).toEqual({ total: 1, clean: 1 });
    expect(card.byCheck.none).toEqual({ total: 2, clean: 1 });
  });
});

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------

describe("workgraph_record_outcome", () => {
  function toolHarness() {
    const mock = makeMockPi();
    registerWorkgraphTools(asExtensionAPI(mock));
    const run = (name: string, params: unknown, cwd: string) =>
      mock.tools
        .get(name)!
        .execute(`call-${name}`, params, undefined, undefined, makeToolContext(cwd));
    return { mock, run };
  }
  it("records only on a gate-closed issue, with no executor installed, and names the failed condition otherwise", async () => {
    const graph = makeScratchGraph({ prefix: "octool" });
    const { run } = toolHarness();
    try {
      const closed = await gateClosed(graph, "accepted work");
      const open = graph.createIssue("still open");
      const overridden = graph.createIssue("force-closed");
      graph.op(["close", overridden, "--reason", "override: not needed any more"]);
      // Closed by the gate, but with nothing stamped (both gates off).
      const unstamped = graph.createIssue("closed with no stamp");
      graph.op(["close", unstamped, "--reason", "accepted by the judgment gate"]);

      const result = await run(
        "workgraph_record_outcome",
        { id: closed, outcome: "needed_fixes", fixRounds: 2, summary: " two CI fixes " },
        graph.dir,
      );
      expect(textOf(result)).toBe(`Recorded outcome needed_fixes:2 for ${closed}.`);
      const record = await latestOutcome(graph.dir, closed);
      expect(record).toMatchObject({
        outcome: "needed_fixes",
        fixRounds: 2,
        summary: "two CI fixes",
        workflowRunId: `workgraph-run/${closed}`,
      });
      expect(record!.actor).toBeTruthy();
      const metadata = metadataOf(graph, closed);
      expect(metadata[WORKGRAPH_OUTCOME_KEY]).toBe("needed_fixes:2");
      expect(metadata[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("recorded");
      // An annotation: the issue is exactly as closed as it was.
      expect(graph.showIssue(closed).status).toBe("closed");
      expect(metadata.workgraph_phase).toBe("accepted");

      await expect(
        run("workgraph_record_outcome", { id: open, outcome: "clean", summary: "s" }, graph.dir),
      ).rejects.toThrow(/is not closed \(status open\)/);
      await expect(
        run(
          "workgraph_record_outcome",
          { id: overridden, outcome: "clean", summary: "s" },
          graph.dir,
        ),
      ).rejects.toThrow(/closed by an override/);
      await expect(
        run(
          "workgraph_record_outcome",
          { id: unstamped, outcome: "clean", summary: "s" },
          graph.dir,
        ),
      ).rejects.toThrow(/no close stamp/);
      await expect(
        run(
          "workgraph_record_outcome",
          { id: "octool-nope", outcome: "clean", summary: "s" },
          graph.dir,
        ),
      ).rejects.toThrow();
      for (const id of [open, overridden, unstamped]) {
        expect(await payloads(graph.dir, id, OUTCOME_MARKER)).toHaveLength(0);
        expect(metadataOf(graph, id)[WORKGRAPH_OUTCOME_KEY]).toBeUndefined();
      }
    } finally {
      graph.cleanup();
    }
  });

  it("rejects an outcome outside the schema, and unknown, which only the core writes", async () => {
    const graph = makeScratchGraph({ prefix: "ocschema" });
    const { run } = toolHarness();
    try {
      const closed = await gateClosed(graph, "accepted work");
      const good = { id: closed, outcome: "clean", summary: "held up" };
      // Pi validates parameters against this schema before `execute` runs.
      expect(Value.Check(RecordOutcomeParams, good)).toBe(true);
      expect(Value.Check(RecordOutcomeParams, { ...good, outcome: "weird" })).toBe(false);
      expect(Value.Check(RecordOutcomeParams, { ...good, outcome: "unknown" })).toBe(false);
      expect(Value.Check(RecordOutcomeParams, { ...good, fixRounds: -1 })).toBe(false);
      expect(Value.Check(RecordOutcomeParams, { ...good, summary: "" })).toBe(false);
      // A direct caller gets the same answer.
      for (const outcome of ["weird", "unknown"]) {
        await expect(
          run("workgraph_record_outcome", { ...good, outcome }, graph.dir),
        ).rejects.toThrow(/clean, needed_fixes, abandoned/);
      }
      await expect(
        run("workgraph_record_outcome", { ...good, summary: "   " }, graph.dir),
      ).rejects.toThrow(/summary/);
      expect(await payloads(graph.dir, closed, OUTCOME_MARKER)).toHaveLength(0);
    } finally {
      graph.cleanup();
    }
  });

  it("workgraph_status shows the outcome, and only when there is one", async () => {
    const graph = makeScratchGraph({ prefix: "ocstat" });
    const { run } = toolHarness();
    try {
      const closed = await gateClosed(graph, "accepted work");
      const before = await run("workgraph_status", { id: closed }, graph.dir);
      expect(textOf(before)).not.toContain("Outcome:");
      expect(before.details.outcome).toBeNull();

      await run(
        "workgraph_record_outcome",
        { id: closed, outcome: "abandoned", summary: "reverted the next day" },
        graph.dir,
      );
      const after = await run("workgraph_status", { id: closed }, graph.dir);
      expect(textOf(after)).toMatch(/Outcome: abandoned: reverted the next day \(recorded by .+\)/);
      expect(after.details.outcome).toMatchObject({ outcome: "abandoned" });
      expect(after.details.outcomeStatus).toBe("recorded");
    } finally {
      graph.cleanup();
    }
  });

  it("an override release clears the outcome keys, so the next close starts with none", async () => {
    const graph = makeScratchGraph({ prefix: "ocrel" });
    const { run } = toolHarness();
    try {
      const closed = await gateClosed(graph, "accepted work");
      await run(
        "workgraph_record_outcome",
        { id: closed, outcome: "clean", summary: "held up" },
        graph.dir,
      );
      graph.op([
        "update",
        closed,
        "--set-metadata",
        `${WORKGRAPH_OUTCOME_DEADLINE_KEY}=2020-01-01T00:00:00.000Z`,
      ]);
      await run(
        "workgraph_override",
        { id: closed, action: "release", reason: "redo it" },
        graph.dir,
      );
      const metadata = metadataOf(graph, closed);
      for (const key of [
        WORKGRAPH_OUTCOME_KEY,
        WORKGRAPH_OUTCOME_STATUS_KEY,
        WORKGRAPH_OUTCOME_EXECUTION_ID_KEY,
        WORKGRAPH_OUTCOME_DEADLINE_KEY,
      ]) {
        expect(metadata[key]).toBeUndefined();
      }
      // The trail keeps the history.
      expect(await payloads(graph.dir, closed, OUTCOME_MARKER)).toHaveLength(1);
    } finally {
      graph.cleanup();
    }
  });

  it("workgraph_scorecard counts gate-closed issues only and prints counts for four of them", async () => {
    const graph = makeScratchGraph({ prefix: "occard" });
    const { run } = toolHarness();
    try {
      const a = await gateClosed(graph, "first");
      const b = await gateClosed(graph, "second", { check: "waived" });
      const c = await gateClosed(graph, "third");
      await gateClosed(graph, "fourth");
      // Not counted: open, and closed by an override.
      graph.createIssue("open");
      const overridden = graph.createIssue("force-closed");
      graph.op(["update", overridden, "--set-metadata", "workgraph_phase=accepted"]);
      graph.op(["close", overridden, "--reason", "override: drop it"]);

      await run("workgraph_record_outcome", { id: a, outcome: "clean", summary: "ok" }, graph.dir);
      await run("workgraph_record_outcome", { id: b, outcome: "clean", summary: "ok" }, graph.dir);
      await run(
        "workgraph_record_outcome",
        { id: c, outcome: "needed_fixes", fixRounds: 1, summary: "one fix" },
        graph.dir,
      );

      const result = await run("workgraph_scorecard", {}, graph.dir);
      const text = textOf(result);
      expect(text).toContain("Gate-closed issues in the last 7 days: 4");
      expect(text).toContain("2 of 4 needed nothing");
      expect(text).not.toContain("%");
      expect(text).toContain("1 of 4 have no outcome recorded");
      expect(text).toContain("check waived: 1 of 1 needed nothing");
      expect(text).toContain(`Worst: ${c} third: needed_fixes (1 round)`);
      expect(result.details.scorecard).toMatchObject({
        windowDays: 7,
        total: 4,
        clean: 2,
        neededFixes: 1,
        none: 1,
      });
      const wide = await run("workgraph_scorecard", { windowDays: 30 }, graph.dir);
      expect(wide.details.scorecard.windowDays).toBe(30);
    } finally {
      graph.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

describe("the outcome configuration", () => {
  it("round trips the instructions exactly as written", () => {
    const mock = makeMockPi();
    mock.setFlag(
      "workgraph-outcome",
      JSON.stringify({ instructions: INSTRUCTIONS, timeoutMs: 60_000 }),
    );
    expect(resolveConfig(asExtensionAPI(mock)).outcome).toEqual({
      instructions: INSTRUCTIONS,
      timeoutMs: 60_000,
    });
    const unset = makeMockPi();
    expect(resolveConfig(asExtensionAPI(unset)).outcome).toBeUndefined();
  });

  it.each([
    "{}",
    "not json",
    '{"instructions":""}',
    '{"instructions":"Watch","timeoutMs":-1}',
  ])("fails startup on an invalid value instead of silently disabling the step (%s)", (value) => {
    const mock = makeMockPi();
    mock.setFlag("workgraph-outcome", value);
    expect(() => resolveConfig(asExtensionAPI(mock))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// the step, launched by the coordinator
// ---------------------------------------------------------------------------

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
  config: WorkgraphConfig;
}

function makeHarness(
  opts: { config?: Partial<WorkgraphConfig>; now?: () => number } = {},
): Harness {
  const mock = makeMockPi();
  const config = shippedConfig({
    workerIdOverride: WORKER,
    ...opts.config,
  });
  setWorkerIdOverride(WORKER);
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { mock, coordinator, config };
}

function settle(mock: MockPi, ctx: unknown): Promise<unknown[]> {
  return mock.emit(
    "agent_settled",
    { type: "agent_settled" },
    ctx as Parameters<MockPi["emit"]>[2],
  );
}

/** One coordination pass: claim, run, judge, close, launch, and drain. */
async function drive(mock: MockPi, ctx: unknown): Promise<void> {
  await settle(mock, ctx);
  await mock.flushEvents();
}

/** Approve the way workgraph_approve does, with a check that passes. */
function approve(
  graph: ScratchGraph,
  id: string,
  opts: { riskTier?: string; workflowClass?: string } = {},
): void {
  graph.op([
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=ready",
    "--set-metadata",
    "workgraph_check=true",
    "--set-metadata",
    `workgraph_risk_tier=${opts.riskTier ?? "medium"}`,
    "--set-metadata",
    `workgraph_workflow_class=${opts.workflowClass ?? "reviewed"}`,
    "--actor",
    "approver",
  ]);
}

/**
 * A fake that implements and reviews in the repository and offers the
 * outcome step: `finalizer`, in the background. By default the step is
 * accepted and then waits for the test (`completeBackground`).
 */
function installStepExecutor(
  mock: MockPi,
  repo: ScratchRepo,
  over: FakeExecutorOptions = {},
) {
  return installFakeExecutor(mock.events, {
    roles: ["implementer", "reviewer", "finalizer"],
    supportsBackground: true,
    workspace: { path: repo.dir, baseRevision: repo.head },
    background: { behavior: "accept-stall" },
    ...over,
    roleScripts: {
      implementer: {
        provenance: IMPL_PROV,
        onRequest: (request) =>
          writeFileSync(join(repo.dir, `${request.issue.id}.txt`), "v1\n"),
      },
      reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      ...over.roleScripts,
    },
  });
}

const backgroundRequests = (fake: { requests: RunRequestT[] }) =>
  fake.requests.filter((request) => request.background === true);

const OUTCOME = { instructions: INSTRUCTIONS };

describe("the outcome step", () => {
  it("is launched after the close with the caller's instructions verbatim and the close stamp, and its report is the record", async () => {
    const repo = makeScratchRepo({ prefix: "ocstep", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness({ config: { outcome: OUTCOME } });
    registerWorkgraphTools(asExtensionAPI(mock));
    const fake = installStepExecutor(mock, repo);
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");

      // One background request, after the review, under the finalizer role.
      expect(fake.requests.map((r) => r.role)).toEqual([
        "implementer",
        "reviewer",
        "finalizer",
      ]);
      const [step] = backgroundRequests(fake);
      expect(step).toBeDefined();
      expect(step!.instructions).toBe(INSTRUCTIONS);
      expect(step).not.toHaveProperty("outputSchema");
      expect(step!.workflowRunId).toBe(fake.requests[0]!.workflowRunId);
      expect(step!.leaseEpoch).toBe(fake.requests[0]!.leaseEpoch);
      expect(step!.workspace.path).toBe(repo.dir);
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp).toBeDefined();
      const report = (step as RunRequestT & { outcomeReport: Record<string, unknown> })
        .outcomeReport;
      expect(report).toEqual({
        issueId: id,
        stamp,
        instruction: outcomeReportInstruction(id),
      });
      expect(report.instruction).toBe(
        `When finished, call workgraph_record_outcome for issue ${id} with outcome clean, needed_fixes or abandoned, the number of fix rounds, and a one-line summary.`,
      );

      // Pending, with the step's execution and a deadline. No lease.
      const pending = metadataOf(repo, id);
      expect(pending[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");
      expect(pending[WORKGRAPH_OUTCOME_EXECUTION_ID_KEY]).toBe("fake-executor-exec-3");
      expect(Number.isNaN(Date.parse(String(pending[WORKGRAPH_OUTCOME_DEADLINE_KEY])))).toBe(
        false,
      );
      expect(heldLeases(repo.dir)).toHaveLength(0);
      expect(coordinator.current()).toBeNull();
      expect(coordinator.timersActive().heartbeat).toBe(false);
      const launched = await audits(repo.dir, id, "outcome-launched");
      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({
        executionId: "fake-executor-exec-3",
        executorId: "fake-executor",
        workflowRunId: step!.workflowRunId,
      });
      const status = await mock.tools
        .get("workgraph_status")!
        .execute("call", { id }, undefined, undefined, makeToolContext(repo.dir));
      expect(textOf(status)).toMatch(
        /Outcome: pending, outcome step fake-executor-exec-3, recorded as unknown after /,
      );

      // The step reports through the tool, then ends.
      await mock.tools
        .get("workgraph_record_outcome")!
        .execute(
          "call",
          { id, outcome: "needed_fixes", fixRounds: 2, summary: "two rounds of CI fixes" },
          undefined,
          undefined,
          makeToolContext(repo.dir),
        );
      fake.completeBackground();
      await mock.flushEvents();

      const record = await latestOutcome(repo.dir, id);
      expect(record).toMatchObject({
        outcome: "needed_fixes",
        fixRounds: 2,
        summary: "two rounds of CI fixes",
        // The reporter does not know its own execution: the record has it.
        executionId: "fake-executor-exec-3",
        workflowRunId: step!.workflowRunId,
      });
      expect(await payloads(repo.dir, id, OUTCOME_MARKER)).toHaveLength(1);
      const metadata = metadataOf(repo, id);
      expect(metadata[WORKGRAPH_OUTCOME_KEY]).toBe("needed_fixes:2");
      expect(metadata[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("recorded");
      // Nothing about the close moved.
      expect(repo.showIssue(id).status).toBe("closed");
      expect(metadata.workgraph_phase).toBe("accepted");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a step that ends without reporting is recorded as unknown, with its execution error", async () => {
    const repo = makeScratchRepo({ prefix: "ocsil", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness({ config: { outcome: OUTCOME } });
    const fake = installStepExecutor(mock, repo, {
      background: { behavior: "accept-stall", executionError: "child crashed" },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(metadataOf(repo, id)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");
      fake.completeBackground(id);
      await mock.flushEvents();

      const record = await latestOutcome(repo.dir, id);
      expect(record).toMatchObject({
        outcome: "unknown",
        summary: STEP_SILENT,
        data: { executionError: "child crashed" },
        executionId: "fake-executor-exec-3",
      });
      const metadata = metadataOf(repo, id);
      expect(metadata[WORKGRAPH_OUTCOME_KEY]).toBe("unknown");
      expect(metadata[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("recorded");
      // A duplicate of the completion settles nothing twice.
      fake.reemit(fake.completions.at(-1)!);
      await mock.flushEvents();
      expect(await payloads(repo.dir, id, OUTCOME_MARKER)).toHaveLength(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a step that finishes inside the request emit is settled, never left pending", async () => {
    const repo = makeScratchRepo({ prefix: "ocfast", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness({ config: { outcome: OUTCOME } });
    // accept-complete: the completion arrives before the acceptance resolves.
    const fake = installStepExecutor(mock, repo, { background: {} });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(backgroundRequests(fake)).toHaveLength(1);
      expect(await latestOutcome(repo.dir, id)).toMatchObject({
        outcome: "unknown",
        summary: STEP_SILENT,
      });
      expect(metadataOf(repo, id)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("recorded");
      expect((await pendingOutcomes(repo.dir, Date.now())).waiting).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a report stands even when the step's own run then fails", async () => {
    const repo = makeScratchRepo({ prefix: "ockeep", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness({ config: { outcome: OUTCOME } });
    registerWorkgraphTools(asExtensionAPI(mock));
    const fake = installStepExecutor(mock, repo, {
      background: {
        behavior: "accept-stall",
        outcome: "failure",
        executionError: "timed out after reporting",
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      await mock.tools
        .get("workgraph_record_outcome")!
        .execute(
          "call",
          { id, outcome: "clean", summary: "merged untouched" },
          undefined,
          undefined,
          makeToolContext(repo.dir),
        );
      fake.completeBackground();
      await mock.flushEvents();
      expect(await latestOutcome(repo.dir, id)).toMatchObject({ outcome: "clean" });
      expect(await payloads(repo.dir, id, OUTCOME_MARKER)).toHaveLength(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a step that never completes is recorded as unknown once the clock passes its deadline, and not before", async () => {
    const repo = makeScratchRepo({ prefix: "ocdead", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    let clock = Date.now();
    const { mock, coordinator } = makeHarness({
      config: { outcome: { instructions: INSTRUCTIONS, timeoutMs: 60_000 } },
      now: () => clock,
    });
    const fake = installStepExecutor(mock, repo, { cancel: "ignore" });
    const ectx = makeEventContext(repo.dir);
    try {
      const launchedAt = clock;
      await drive(mock, ectx.ctx);
      const deadline = String(metadataOf(repo, id)[WORKGRAPH_OUTCOME_DEADLINE_KEY]);
      expect(Date.parse(deadline)).toBe(launchedAt + 60_000);

      clock = launchedAt + 59_000;
      await drive(mock, ectx.ctx);
      expect(metadataOf(repo, id)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");
      expect(await latestOutcome(repo.dir, id)).toBeUndefined();

      clock = launchedAt + 60_001;
      await drive(mock, ectx.ctx);
      expect(await latestOutcome(repo.dir, id)).toMatchObject({
        outcome: "unknown",
        summary: STEP_LATE,
        executionId: "fake-executor-exec-3",
      });
      expect(metadataOf(repo, id)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("recorded");
      // A courtesy cancel went out for the step's execution; nothing waits on it.
      expect(fake.cancels.at(-1)).toMatchObject({
        issueId: id,
        executionId: "fake-executor-exec-3",
      });

      // The sweep runs every tick and settles once.
      await drive(mock, ectx.ctx);
      expect(await payloads(repo.dir, id, OUTCOME_MARKER)).toHaveLength(1);
      // A completion that straggles in afterwards changes nothing.
      fake.completeBackground();
      await mock.flushEvents();
      expect(await payloads(repo.dir, id, OUTCOME_MARKER)).toHaveLength(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("uses a two-hour deadline when none is configured", async () => {
    const repo = makeScratchRepo({ prefix: "octwo", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const clock = Date.now();
    const { mock, coordinator } = makeHarness({
      config: { outcome: OUTCOME },
      now: () => clock,
    });
    const fake = installStepExecutor(mock, repo);
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(DEFAULT_OUTCOME_TIMEOUT_MS).toBe(7_200_000);
      expect(Date.parse(String(metadataOf(repo, id)[WORKGRAPH_OUTCOME_DEADLINE_KEY]))).toBe(
        clock + 7_200_000,
      );
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("after a restart a pending step is left alone until its deadline, then recorded as unknown", async () => {
    const repo = makeScratchRepo({ prefix: "ocrest", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    let clock = Date.now();
    const launchedAt = clock;
    const config = { outcome: { instructions: INSTRUCTIONS, timeoutMs: 60_000 } };
    const first = makeHarness({ config, now: () => clock });
    const fakeA = installStepExecutor(first.mock, repo);
    const ectxA = makeEventContext(repo.dir);
    let second: Harness | undefined;
    const ectxB = makeEventContext(repo.dir);
    try {
      await drive(first.mock, ectxA.ctx);
      expect(metadataOf(repo, id)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");

      // The session ends. The step is left running; nothing is settled.
      await first.coordinator.teardown(ectxA.ctx);
      fakeA.uninstall();
      expect(metadataOf(repo, id)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");

      // A new session, before the deadline: re-tracked, left alone.
      clock = launchedAt + 30_000;
      second = makeHarness({ config, now: () => clock });
      const report = await second.coordinator.reconcile(ectxB.ctx);
      expect(report.readopted).toEqual([]);
      expect(metadataOf(repo, id)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");
      expect(await latestOutcome(repo.dir, id)).toBeUndefined();
      expect(heldLeases(repo.dir)).toHaveLength(0);

      // The child never reports and the deadline passes.
      clock = launchedAt + 60_001;
      await drive(second.mock, ectxB.ctx);
      expect(await latestOutcome(repo.dir, id)).toMatchObject({
        outcome: "unknown",
        summary: STEP_LATE,
      });
      expect(metadataOf(repo, id)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("recorded");
    } finally {
      await first.coordinator.teardown(ectxA.ctx);
      if (second) await second.coordinator.teardown(ectxB.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a session that starts after the deadline records unknown at reconciliation, and a re-tracked step's end is still recognized", async () => {
    const repo = makeScratchRepo({ prefix: "oclate", seed: 2 });
    const [late, live] = repo.seededIds as [string, string];
    approve(repo, late);
    approve(repo, live);
    let clock = Date.now();
    const launchedAt = clock;
    const config = { outcome: { instructions: INSTRUCTIONS, timeoutMs: 60_000 } };
    const first = makeHarness({ config, now: () => clock });
    const fakeA = installStepExecutor(first.mock, repo);
    const ectxA = makeEventContext(repo.dir);
    let second: Harness | undefined;
    const ectxB = makeEventContext(repo.dir);
    try {
      await drive(first.mock, ectxA.ctx);
      // The second issue's step is launched half a minute later.
      clock = launchedAt + 30_000;
      await drive(first.mock, ectxA.ctx);
      expect(repo.showIssue(live).status).toBe("closed");
      const liveStep = backgroundRequests(fakeA).find((r) => r.issue.id === live)!;
      const liveExecution = String(
        metadataOf(repo, live)[WORKGRAPH_OUTCOME_EXECUTION_ID_KEY],
      );
      await first.coordinator.teardown(ectxA.ctx);
      fakeA.uninstall();

      // Restart between the two deadlines.
      clock = launchedAt + 70_000;
      second = makeHarness({ config, now: () => clock });
      await second.coordinator.reconcile(ectxB.ctx);
      expect(await latestOutcome(repo.dir, late)).toMatchObject({
        outcome: "unknown",
        summary: STEP_LATE,
      });
      expect(metadataOf(repo, live)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");

      // The surviving step ends without reporting: the new session knows it.
      const completion: RunCompletedT = {
        ...newEnvelope(),
        workflowRunId: liveStep.workflowRunId,
        executionId: liveExecution,
        issueId: live,
        leaseEpoch: liveStep.leaseEpoch,
        outcome: "success",
        artifacts: [],
        evidence: [],
        provenance: { harness: "fake" },
      };
      second.mock.events.emit(CH.runCompleted, completion);
      await second.mock.flushEvents();
      expect(await latestOutcome(repo.dir, live)).toMatchObject({
        outcome: "unknown",
        summary: STEP_SILENT,
      });
    } finally {
      await first.coordinator.teardown(ectxA.ctx);
      if (second) await second.coordinator.teardown(ectxB.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("with no outcome configured nothing is launched and nothing is marked", async () => {
    const repo = makeScratchRepo({ prefix: "ocoff", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness();
    const fake = installStepExecutor(mock, repo);
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      expect(backgroundRequests(fake)).toHaveLength(0);
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "reviewer"]);
      const metadata = metadataOf(repo, id);
      expect(metadata[WORKGRAPH_OUTCOME_STATUS_KEY]).toBeUndefined();
      expect(metadata[WORKGRAPH_OUTCOME_KEY]).toBeUndefined();
      expect(await audits(repo.dir, id, "outcome-launched")).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("holds no lease while the step is pending: the next ready issue is claimed and closed", async () => {
    const repo = makeScratchRepo({ prefix: "ocnext", seed: 2 });
    const [first, second] = repo.seededIds as [string, string];
    approve(repo, first);
    approve(repo, second);
    const { mock, coordinator } = makeHarness({ config: { outcome: OUTCOME } });
    const fake = installStepExecutor(mock, repo);
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(first).status).toBe("closed");
      expect(metadataOf(repo, first)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");
      // Right after the close, with the step still running.
      expect(heldLeases(repo.dir)).toHaveLength(0);
      expect(repo.showIssue(second).status).toBe("open");

      await drive(mock, ectx.ctx);
      expect(repo.showIssue(second).status).toBe("closed");
      expect(heldLeases(repo.dir)).toHaveLength(0);
      // Both steps are pending at once; neither held anything up.
      expect(backgroundRequests(fake).map((r) => r.issue.id)).toEqual([first, second]);
      expect(metadataOf(repo, first)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");
      expect(metadataOf(repo, second)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");

      // Each completion settles its own issue.
      fake.completeBackground(first);
      await mock.flushEvents();
      expect(metadataOf(repo, first)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("recorded");
      expect(metadataOf(repo, second)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("is launched after a one-shot close too", async () => {
    const repo = makeScratchRepo({ prefix: "ocone", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, { riskTier: "low", workflowClass: "oneshot" });
    const { mock, coordinator } = makeHarness({ config: { outcome: OUTCOME } });
    const fake = installStepExecutor(mock, repo);
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      expect(repo.showIssue(id).close_reason).toBe("accepted by the one-shot workflow");
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "finalizer"]);
      const [step] = backgroundRequests(fake);
      expect(step!.instructions).toBe(INSTRUCTIONS);
      expect(metadataOf(repo, id)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");
      expect(heldLeases(repo.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("carries the finalization result, and finalization and the step each get their own request", async () => {
    const repo = makeScratchRepo({ prefix: "ocfin", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const RECEIPT = {
      outcome: "success",
      summary: "Published",
      data: { change: "change-42" },
    };
    const { mock, coordinator } = makeHarness({
      config: {
        outcome: OUTCOME,
        finalization: { instructions: "Publish the change", timeoutMs: 5_000 },
      },
    });
    const fake = installStepExecutor(mock, repo, {
      roleScripts: { finalizer: { finalization: RECEIPT } },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      const finalizers = fake.requests.filter((r) => r.role === "finalizer");
      expect(finalizers).toHaveLength(2);
      expect(finalizers[0]!.background).toBeUndefined();
      expect(finalizers[0]!.instructions).toBe("Publish the change");
      expect(finalizers[1]!.background).toBe(true);
      expect(finalizers[1]!.instructions).toBe(INSTRUCTIONS);
      const report = (finalizers[1] as RunRequestT & {
        outcomeReport: Record<string, unknown>;
      }).outcomeReport;
      expect(report.finalization).toEqual(RECEIPT);
      expect(report.stamp).toEqual(await latestStamp(repo.dir, id));
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it.each([
    [
      "no executor offers a background launch",
      { supportsBackground: false },
      "no executor can run a background outcome step",
      0,
    ],
    [
      "the launch is rejected",
      { background: { behavior: "reject", rejectReason: "not today" } },
      "the outcome step was rejected: not today",
      1,
    ],
    [
      "the launch is not accepted in time",
      { background: { behavior: "silent" } },
      "the outcome step was not accepted in time",
      1,
    ],
  ] as const)(
    "%s: the outcome is unknown with the reason, and the close stands",
    async (_label, over, summary, requests) => {
      const repo = makeScratchRepo({ prefix: "ocno", seed: 1 });
      const id = repo.seededIds[0]!;
      approve(repo, id);
      const { mock, coordinator } = makeHarness({ config: { outcome: OUTCOME } });
      const fake = installStepExecutor(mock, repo, over as FakeExecutorOptions);
      const ectx = makeEventContext(repo.dir);
      try {
        await drive(mock, ectx.ctx);
        expect(repo.showIssue(id).status).toBe("closed");
        expect(metadataOf(repo, id).workgraph_phase).toBe("accepted");
        expect(backgroundRequests(fake)).toHaveLength(requests);
        expect(await latestOutcome(repo.dir, id)).toMatchObject({
          outcome: "unknown",
          summary,
        });
        const metadata = metadataOf(repo, id);
        expect(metadata[WORKGRAPH_OUTCOME_KEY]).toBe("unknown");
        expect(metadata[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("recorded");
        expect(await audits(repo.dir, id, "outcome-launched")).toHaveLength(0);
        // Never retried.
        await drive(mock, ectx.ctx);
        expect(backgroundRequests(fake)).toHaveLength(requests);
        expect(await payloads(repo.dir, id, OUTCOME_MARKER)).toHaveLength(1);
      } finally {
        fake.uninstall();
        await coordinator.teardown(ectx.ctx);
        repo.cleanup();
      }
    },
    60_000,
  );

  it("a pinned finalizer that cannot launch in the background is not used", async () => {
    const repo = makeScratchRepo({ prefix: "ocpin", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const { mock, coordinator } = makeHarness({
      config: { outcome: OUTCOME, executorByRole: { finalizer: "fake-executor" } },
    });
    const fake = installStepExecutor(mock, repo, { supportsBackground: false });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(backgroundRequests(fake)).toHaveLength(0);
      expect(await latestOutcome(repo.dir, id)).toMatchObject({
        outcome: "unknown",
        summary: "no executor can run a background outcome step",
      });
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a close that left no stamp is not graded, so no step is launched for it, and the log says why", async () => {
    const repo = makeScratchRepo({ prefix: "ocbare", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id);
    const mock = makeMockPi();
    const config = preProofConfig({ workerIdOverride: WORKER, outcome: OUTCOME });
    setWorkerIdOverride(WORKER);
    const coordinator = registerCoordinator(asExtensionAPI(mock), {
      getConfig: () => config,
    });
    const fake = installStepExecutor(mock, repo);
    const ectx = makeEventContext(repo.dir);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      expect(await latestStamp(repo.dir, id)).toBeUndefined();
      expect(backgroundRequests(fake)).toHaveLength(0);
      expect(metadataOf(repo, id)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBeUndefined();
      expect(await payloads(repo.dir, id, OUTCOME_MARKER)).toHaveLength(0);
      // A configured step that does not run is said, once for the close.
      const lines = logged.mock.calls
        .map((args) => args.join(" "))
        .filter((line) => line.includes("outcome step for"));
      expect(lines).toEqual([
        `[pi-workgraph] coordinator skipping: outcome step for ${id} not launched: the close wrote no stamp to grade (tree-binding and check are both off for it)`,
      ]);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the background launch, through the real bridge
// ---------------------------------------------------------------------------

interface BridgeHarness {
  mock: MockPi;
  bridge: PiSubagentsController;
  config: WorkgraphConfig;
}

function makeBridgeHarness(
  overrides: Partial<WorkgraphConfig> = {},
  version = "0.41.0",
): BridgeHarness {
  const mock = makeMockPi();
  const config = preProofConfig({
    subagentsExecutor: { enabled: true },
    outcome: OUTCOME,
    ...overrides,
  });
  const bridge = registerPiSubagentsExecutor(asExtensionAPI(mock), {
    getConfig: () => config,
    probeVersion: () => version,
    warn: () => {},
  });
  return { mock, bridge, config };
}

function busOn(mock: MockPi, channel: string): unknown[] {
  return mock.busEvents.filter((e) => e.channel === channel).map((e) => e.data);
}

function offerOf(mock: MockPi): ExecutorOfferT {
  mock.events.emit(CH.discover, newEnvelope());
  return busOn(mock, CH.offer).at(-1) as ExecutorOfferT;
}

function bridgeRequest(
  overrides: Partial<RunRequestT> & { outcomeReport?: unknown } = {},
): RunRequestT {
  return {
    ...newEnvelope(),
    executorId: PI_SUBAGENTS_EXECUTOR_ID,
    issue: {
      id: "wg-7",
      title: "wire the flux capacitor",
      workflowClass: "reviewed",
      riskTier: "medium",
    },
    workflowRunId: "workgraph-run/closed-run",
    leaseEpoch: 3,
    role: "finalizer",
    attempt: 1,
    workspace: {
      baseRevision: "",
      requiresIsolation: false,
      path: "/work/checkout",
    },
    ...overrides,
  } as RunRequestT;
}

const REPORT = {
  issueId: "wg-7",
  stamp: { workflowRunId: "workgraph-run/closed-run", attempt: 1, gates: { check: "pass" } },
  finalization: { outcome: "success", summary: "Published" },
  instruction: outcomeReportInstruction("wg-7"),
};

const stepRequest = (overrides: Partial<RunRequestT> = {}) =>
  bridgeRequest({
    background: true,
    instructions: INSTRUCTIONS,
    outcomeReport: REPORT,
    ...overrides,
  });

describe("background launch in the bridge", () => {
  it("offers a background launch only on an upstream line it was verified on", () => {
    expect(subagentsSupportsBackground("0.41.0")).toBe(true);
    expect(subagentsSupportsBackground("0.89.1")).toBe(true);
    expect(subagentsSupportsBackground("0.34.8")).toBe(false);
    expect(subagentsSupportsBackground("0.4.1")).toBe(false);

    const verified = makeBridgeHarness();
    const unverified = makeBridgeHarness({}, "0.34.8");
    try {
      const offer = offerOf(verified.mock);
      expect(offer.supportsBackground).toBe(true);
      // `finalizer` once, with only the outcome step configured.
      expect(offer.roles.filter((role) => role === "finalizer")).toHaveLength(1);
      expect(offerOf(unverified.mock)).not.toHaveProperty("supportsBackground");
    } finally {
      verified.bridge.teardown();
      unverified.bridge.teardown();
    }
    const both = makeBridgeHarness({
      finalization: { instructions: "Publish" },
    });
    const neither = makeBridgeHarness({ outcome: undefined });
    try {
      expect(offerOf(both.mock).roles.filter((r) => r === "finalizer")).toHaveLength(1);
      expect(offerOf(neither.mock).roles).not.toContain("finalizer");
    } finally {
      both.bridge.teardown();
      neither.bridge.teardown();
    }
  });

  it("the task is the caller's instructions verbatim, then a separate block from the core", () => {
    const task = buildOutcomeTask(stepRequest());
    expect(task.startsWith(`${INSTRUCTIONS}\n\n---\n`)).toBe(true);
    const block = task.slice(INSTRUCTIONS.length);
    expect(block).toContain("[workgraph outcome step] Issue wg-7");
    expect(block).toContain(`Close stamp: ${JSON.stringify(REPORT.stamp)}`);
    expect(block).toContain(`Finalization result: ${JSON.stringify(REPORT.finalization)}`);
    expect(block.trimEnd().endsWith(REPORT.instruction)).toBe(true);
    // None of the sentences a supervised role gets.
    expect(task).not.toContain("Workflow instructions");
    expect(task).not.toContain("structured_output");
    expect(task).not.toContain("Do not close or release the issue yourself");
    // A report with the wrong shape renders nothing: the instructions alone.
    for (const outcomeReport of [undefined, "text", { issueId: 7 }, []]) {
      expect(buildOutcomeTask(stepRequest({ outcomeReport } as Partial<RunRequestT>))).toBe(
        INSTRUCTIONS,
      );
    }
  });

  it("a background step does not delay a foreground review, and its end is one run:completed", async () => {
    const { mock, bridge } = makeBridgeHarness({
      subagentsExecutor: {
        enabled: true,
        options: { finalizer: { skills: ["watch-change"] } },
      },
    });
    const fake = installFakeSubagents(mock.events, {
      singleForeground: true,
      script: { mode: "stall", structuredOutput: { findings: [] } },
    });
    try {
      const step = stepRequest();
      mock.events.emit(CH.runRequest, step);

      // Launched at once, in the background.
      expect(fake.requests).toHaveLength(1);
      const params = fake.requests[0]!.params;
      expect(params.async).toBe(true);
      expect(params).not.toHaveProperty("foregroundOnly");
      expect(params).not.toHaveProperty("worktree");
      expect(params).not.toHaveProperty("outputSchema");
      expect(params.cwd).toBe("/work/checkout");
      expect(params.task).toBe(buildOutcomeTask(step));
      expect(params.skill).toEqual(["watch-change"]);
      expect(params.timeoutMs).toBe(7_200_000);
      expect(params.context).toBe("fresh");

      // The launch receipt is the acceptance.
      const accepted = busOn(mock, CH.runAccepted) as Array<Record<string, unknown>>;
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({
        inReplyTo: step.messageId,
        workflowRunId: step.workflowRunId,
        executionState: "starting",
      });
      const stepExecution = accepted[0]!.executionId;
      expect(bridge.backgroundRunCount()).toBe(1);
      expect(bridge.activeRunCount()).toBe(0);

      // A review for another issue, while the step is still running: its
      // upstream request goes out immediately.
      mock.events.emit(
        CH.runRequest,
        bridgeRequest({
          role: "reviewer",
          workflowRunId: "workgraph-run/under-review",
          issue: { id: "wg-8", title: "next issue" },
        }),
      );
      expect(fake.requests).toHaveLength(2);
      expect(fake.requests[1]!.params).toMatchObject({
        agent: "reviewer",
        async: false,
        foregroundOnly: true,
      });
      expect(busOn(mock, CH.runRejected)).toHaveLength(0);
      expect(
        (busOn(mock, CH.runAccepted) as Array<Record<string, unknown>>).at(-1),
      ).toMatchObject({
        workflowRunId: "workgraph-run/under-review",
        executionState: "starting",
      });
      expect(bridge.activeRunCount()).toBe(1);
      expect(busOn(mock, CH.runCompleted)).toHaveLength(0);

      // An async-complete for a run the bridge never launched changes nothing.
      mock.events.emit("subagent:async-complete", {
        id: "someone-elses-run",
        runId: "someone-elses-run",
        success: true,
        state: "complete",
      });
      expect(busOn(mock, CH.runCompleted)).toHaveLength(0);

      // The step ends: one run:completed for its execution, no structured result.
      fake.completeBackground();
      const completed = busOn(mock, CH.runCompleted) as Array<
        RunCompletedT & { finalization?: unknown }
      >;
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        executionId: stepExecution,
        workflowRunId: step.workflowRunId,
        issueId: "wg-7",
        leaseEpoch: 3,
        outcome: "success",
      });
      expect(completed[0]).not.toHaveProperty("finalization");
      expect(completed[0]).not.toHaveProperty("executionError");
      expect(bridge.backgroundRunCount()).toBe(0);

      // A repeat of the event is not a second completion, and the review
      // is still the one foreground run.
      mock.events.emit("subagent:async-complete", {
        id: "background-id",
        runId: "background-id",
        success: true,
        state: "complete",
      });
      expect(busOn(mock, CH.runCompleted)).toHaveLength(1);
      fake.respond();
      await Promise.resolve();
      expect(busOn(mock, CH.runCompleted)).toHaveLength(2);
      expect(bridge.activeRunCount()).toBe(0);
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("background steps take none of the foreground slots", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, {
      singleForeground: true,
      script: { mode: "stall" },
    });
    try {
      for (let n = 0; n < 5; n++) {
        mock.events.emit(
          CH.runRequest,
          stepRequest({ workflowRunId: `workgraph-run/closed-${n}` }),
        );
      }
      expect(bridge.backgroundRunCount()).toBe(5);
      expect(busOn(mock, CH.runAccepted)).toHaveLength(5);
      expect(busOn(mock, CH.runRejected)).toHaveLength(0);
      expect(offerOf(mock).available).toBe(true);
      // Each launch has its own upstream id, so each end finds its own run.
      expect(new Set(fake.backgroundRuns).size).toBe(5);
      fake.completeBackground(fake.backgroundRuns[2]);
      const completed = busOn(mock, CH.runCompleted) as RunCompletedT[];
      expect(completed.map((c) => c.workflowRunId)).toEqual(["workgraph-run/closed-2"]);
      expect(bridge.backgroundRunCount()).toBe(4);
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("maps a run that did not succeed to a failed completion with its state", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events);
    try {
      mock.events.emit(CH.runRequest, stepRequest());
      fake.completeBackground(undefined, { success: false, state: "failed" });
      const [completed] = busOn(mock, CH.runCompleted) as RunCompletedT[];
      expect(completed).toMatchObject({
        outcome: "failure",
        executionError: "upstream background run ended failed",
      });
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("refuses a background launch it cannot make: an unverified upstream, the step not configured, another role", () => {
    const cases: Array<[BridgeHarness, RunRequestT, RegExp]> = [
      [makeBridgeHarness({}, "0.34.8"), stepRequest(), /not verified for pi-subagents 0\.34\.8/],
      [makeBridgeHarness({ outcome: undefined }), stepRequest(), /outcome step is disabled/],
      [makeBridgeHarness(), stepRequest({ role: "reviewer" }), /not supported for role reviewer/],
      // With only the outcome step configured, a foreground finalizer
      // request is still a finalization request, and that is off.
      [makeBridgeHarness(), bridgeRequest(), /finalization is disabled/],
    ];
    for (const [harness, request, reason] of cases) {
      const fake = installFakeSubagents(harness.mock.events);
      try {
        harness.mock.events.emit(CH.runRequest, request);
        expect(fake.requests).toHaveLength(0);
        const rejected = busOn(harness.mock, CH.runRejected) as Array<{ reason: string }>;
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.reason).toMatch(reason);
        expect(harness.bridge.backgroundRunCount()).toBe(0);
      } finally {
        fake.uninstall();
        harness.bridge.teardown();
      }
    }
  });

  it("an upstream answer that is not a launch receipt is a rejection, never an acceptance", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events, { script: { mode: "silent" } });
    try {
      // Force the foreground path upstream so nothing answers by itself.
      const step = stepRequest();
      const off = mock.events.on("subagent:slash:request", (data) => {
        const { requestId } = data as { requestId: string };
        mock.events.emit("subagent:slash:started", { requestId });
        mock.events.emit("subagent:slash:response", {
          requestId,
          isError: true,
          errorText: "Unknown agent: worker",
          result: { details: { mode: "single", results: [] } },
        });
      });
      fake.uninstall();
      mock.events.emit(CH.runRequest, step);
      off();
      expect(busOn(mock, CH.runAccepted)).toHaveLength(0);
      const rejected = busOn(mock, CH.runRejected) as Array<{ reason: string }>;
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBe("upstream: Unknown agent: worker");
      expect(bridge.backgroundRunCount()).toBe(0);
    } finally {
      bridge.teardown();
    }
  });

  it("cancels a background run with the upstream interrupt, and acknowledges when the run ends", () => {
    const { mock, bridge } = makeBridgeHarness();
    const fake = installFakeSubagents(mock.events);
    try {
      const step = stepRequest();
      mock.events.emit(CH.runRequest, step);
      const [accepted] = busOn(mock, CH.runAccepted) as Array<{ executionId: string }>;
      mock.events.emit(CH.runCancel, {
        ...newEnvelope(),
        workflowRunId: step.workflowRunId,
        issueId: "wg-7",
        executionId: accepted!.executionId,
        reason: "the outcome step did not report before its deadline",
      });
      expect(fake.interrupts).toEqual(["background-id"]);
      // The interrupt's own receipt is not the run's exit.
      expect(busOn(mock, CH.runCancelled)).toHaveLength(0);
      expect(bridge.backgroundRunCount()).toBe(1);

      fake.completeBackground("background-id", { success: false, state: "paused" });
      expect(busOn(mock, CH.runCancelled)).toHaveLength(1);
      expect(busOn(mock, CH.runCancelled)[0]).toMatchObject({
        workflowRunId: step.workflowRunId,
        executionId: accepted!.executionId,
      });
      expect(busOn(mock, CH.runCompleted)).toHaveLength(0);
      expect(bridge.backgroundRunCount()).toBe(0);
    } finally {
      fake.uninstall();
      bridge.teardown();
    }
  });

  it("end to end: the coordinator launches the step through the bridge and settles it on the async completion", async () => {
    const repo = makeScratchRepo({ prefix: "ocbridge", seed: 2 });
    const [reported, silent] = repo.seededIds as [string, string];
    approve(repo, reported);
    approve(repo, silent);
    const { mock, coordinator, config } = makeHarness({
      config: {
        outcome: OUTCOME,
        subagentsExecutor: { enabled: true },
        // Implementation and review stay with the fake; only the bridge can
        // launch in the background.
        executorByRole: { implementer: "fake-executor", reviewer: "fake-executor" },
      },
    });
    registerWorkgraphTools(asExtensionAPI(mock));
    const bridge = registerPiSubagentsExecutor(asExtensionAPI(mock), {
      getConfig: () => config,
      probeVersion: () => "0.41.0",
      warn: () => {},
    });
    const upstream = installFakeSubagents(mock.events, { singleForeground: true });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: { path: repo.dir, baseRevision: repo.head },
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: (request) =>
            writeFileSync(join(repo.dir, `${request.issue.id}.txt`), "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(reported).status).toBe("closed");
      expect(repo.showIssue(silent).status).toBe("closed");

      // Two background launches upstream, each in the work's directory,
      // each carrying the instructions verbatim first.
      expect(upstream.requests).toHaveLength(2);
      for (const request of upstream.requests) {
        expect(request.params.async).toBe(true);
        expect(request.params.cwd).toBe(repo.dir);
        expect(String(request.params.task).startsWith(`${INSTRUCTIONS}\n\n---\n`)).toBe(true);
      }
      expect(String(upstream.requests[0]!.params.task)).toContain(
        outcomeReportInstruction(reported),
      );
      expect(metadataOf(repo, reported)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");
      expect(metadataOf(repo, silent)[WORKGRAPH_OUTCOME_STATUS_KEY]).toBe("pending");
      expect(bridge.backgroundRunCount()).toBe(2);
      expect(heldLeases(repo.dir)).toHaveLength(0);

      // The first step reports through the tool and ends.
      await mock.tools
        .get("workgraph_record_outcome")!
        .execute(
          "call",
          { id: reported, outcome: "clean", summary: "merged untouched" },
          undefined,
          undefined,
          makeToolContext(repo.dir),
        );
      upstream.completeBackground("background-id");
      await mock.flushEvents();
      expect(await latestOutcome(repo.dir, reported)).toMatchObject({ outcome: "clean" });
      expect(await payloads(repo.dir, reported, OUTCOME_MARKER)).toHaveLength(1);

      // The second ends without reporting.
      upstream.completeBackground("background-id-2");
      await mock.flushEvents();
      expect(await latestOutcome(repo.dir, silent)).toMatchObject({
        outcome: "unknown",
        summary: STEP_SILENT,
      });
      expect(bridge.backgroundRunCount()).toBe(0);
    } finally {
      fake.uninstall();
      upstream.uninstall();
      bridge.teardown();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);
});
