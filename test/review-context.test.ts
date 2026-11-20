/**
 * What a review ran in, and what the real bridge sends a reviewer
 * (proof-of-success phase 4).
 *
 *  - The bridge reports the context it launched a run in (`fresh`) as
 *    provenance, the verdict record keeps it, and `workgraph_status` prints
 *    it under the last verdict.
 *  - A bridged recheck: the second launch gets the numbered blockers, and
 *    its structured output comes back as `recheck`, never as a verdict.
 *  - The reviewer task text: numbered criteria, the citation rule and the
 *    retry feedback, each only when the request carries what it names.
 *
 * The coordinator and the REAL pi-subagents bridge on one bus, with the
 * upstream runtime faked (`installFakeSubagents`) and an in-session-style
 * implementer, on the shipped defaults and a git-backed scratch.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSubagentTask,
  PI_SUBAGENTS_EXECUTOR_ID,
  registerPiSubagentsExecutor,
} from "../src/adapters/pi-subagents.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { resetLeasesForTest } from "../src/lease.ts";
import {
  CH,
  newEnvelope,
  parseMessage,
  ProtocolError,
  RunCompleted,
  type RunCompletedT,
  type RunRequestT,
} from "../src/protocol.ts";
import { listComments } from "../src/store.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import {
  BlockerRecheck,
  Verdict,
  WORKGRAPH_BASE_TREE_KEY,
  WORKGRAPH_LAST_VERDICT_KEY,
  WORKGRAPH_RESULT_TREE_KEY,
  type VerdictT,
} from "../src/types.ts";
import {
  latestVerdictRecord,
  RECHECK_MARKER,
  reviewContextOf,
  VERDICT_MARKER,
} from "../src/verdict.ts";
import { shippedConfig } from "./helpers/config.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
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

const WORKER = "review-context-worker";

/** The author; the bridged reviewer reports a different model. */
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };

const CLEAN_VERDICT: VerdictT = { findings: [] };

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
  config: WorkgraphConfig;
}

/** The coordinator on the shipped defaults, with judgment sent to the bridge. */
function makeHarness(): Harness {
  const mock = makeMockPi();
  setWorkerIdOverride(WORKER);
  mock.setFlag("workgraph-worker-id", WORKER);
  const config = shippedConfig({
    workerIdOverride: WORKER,
    subagentsExecutor: { enabled: true },
    executorByRole: {
      implementer: "in-session-style",
      reviewer: PI_SUBAGENTS_EXECUTOR_ID,
    },
  });
  registerWorkgraphTools(asExtensionAPI(mock));
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
  });
  return { mock, coordinator, config };
}

function approve(graph: ScratchGraph, id: string): void {
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
    "workgraph_risk_tier=medium",
    "--set-metadata",
    "workgraph_workflow_class=reviewed",
    "--actor",
    "approver",
  ]);
}

function metadataOf(graph: ScratchGraph, id: string): Record<string, unknown> {
  return (graph.showIssue(id).metadata ?? {}) as Record<string, unknown>;
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

/** Every `run:completed` the bridge put on the bus, in order. */
function bridgeCompletions(
  mock: MockPi,
): Array<RunCompletedT & { verdict?: unknown; recheck?: unknown }> {
  return mock.busEvents
    .filter((e) => e.channel === CH.runCompleted)
    .map((e) => e.data as RunCompletedT & { verdict?: unknown; recheck?: unknown })
    .filter((c) => c.provenance.harness === "pi-subagents");
}

async function statusText(mock: MockPi, id: string, cwd: string): Promise<string> {
  const result = (await mock.tools
    .get("workgraph_status")!
    .execute("call-status", { id }, undefined, undefined, makeToolContext(cwd))) as {
    content: { type: string; text?: string }[];
  };
  return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

/**
 * One medium-risk issue implemented in the session's checkout by an
 * in-session-style fake, and judged through the real bridge. `upstream` is
 * what the faked pi-subagents runtime answers, in launch order.
 */
function setUp(prefix: string, upstream: Array<{ structuredOutput: unknown }>) {
  const repo: ScratchRepo = makeScratchRepo({ prefix, seed: 1 });
  const id = repo.seededIds[0]!;
  approve(repo, id);
  const { mock, coordinator, config } = makeHarness();
  const bridge = registerPiSubagentsExecutor(asExtensionAPI(mock), {
    getConfig: () => config,
    probeVersion: () => "0.34.8",
  });
  const implementer = installFakeExecutor(mock.events, {
    executorId: "in-session-style",
    roles: ["implementer"],
    isolation: "none",
    workspace: { path: repo.dir },
    provenance: IMPL_PROV,
    onRequest: () => writeFileSync(join(repo.dir, "feature.txt"), "v1\n"),
  });
  const runtime = installFakeSubagents(mock.events, {
    script: upstream.map((entry) => ({ model: "provider/reviewer", ...entry })),
  });
  const ectx = makeEventContext(repo.dir);
  return {
    repo,
    id,
    mock,
    runtime,
    async drive() {
      await mock.emit(
        "agent_settled",
        { type: "agent_settled" },
        ectx.ctx as Parameters<MockPi["emit"]>[2],
      );
      await mock.flushEvents();
      await expect
        .poll(() => repo.showIssue(id).status, { timeout: 30_000, interval: 50 })
        .toBe("closed");
    },
    async cleanup() {
      await coordinator.teardown(ectx.ctx);
      implementer.uninstall();
      runtime.uninstall();
      bridge.teardown();
      repo.cleanup();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLeasesForTest();
  resetIdentityForTest();
});

describe("the context a review ran in", () => {
  it("one bridged review: the completion's provenance says fresh, the verdict record keeps it, and status prints it", async () => {
    const t = setUp("rcfresh", [{ structuredOutput: CLEAN_VERDICT }]);
    try {
      await t.drive();

      // The launch really was fresh, and the report is read back from it.
      expect(t.runtime.requests).toHaveLength(1);
      expect(t.runtime.requests[0]!.params.context).toBe("fresh");
      const completions = bridgeCompletions(t.mock);
      expect(completions).toHaveLength(1);
      expect(completions[0]!.provenance).toEqual({
        harness: "pi-subagents",
        model: "provider/reviewer",
        provider: "provider",
        context: "fresh",
      });

      // The persisted verdict comment carries the provenance whole.
      const verdicts = await payloads(t.repo.dir, t.id, VERDICT_MARKER);
      expect(verdicts).toHaveLength(1);
      expect(
        (verdicts[0]!.reviewerProvenance as { context?: unknown }).context,
      ).toBe("fresh");
      expect(reviewContextOf(await latestVerdictRecord(t.repo.dir, t.id))).toBe("fresh");

      // Printed directly under the last verdict.
      const status = (await statusText(t.mock, t.id, t.repo.dir)).split("\n");
      const at = status.indexOf(
        `Last verdict: ${String(metadataOf(t.repo, t.id)[WORKGRAPH_LAST_VERDICT_KEY])}`,
      );
      expect(at).toBeGreaterThan(-1);
      expect(status[at + 1]).toBe("Review context: fresh");
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("status prints no context for an issue with no verdict, or a verdict that names none", async () => {
    const graph = makeScratchGraph({ prefix: "rcnone", seed: 1 });
    const id = graph.seededIds[0]!;
    const { mock, coordinator } = makeHarness();
    try {
      expect(await latestVerdictRecord(graph.dir, id)).toBeUndefined();
      expect(await statusText(mock, id, graph.dir)).not.toContain("Review context");

      // A verdict recorded before the field existed, and an unreadable one
      // written after it: the newest READABLE record is the one consulted.
      graph.op([
        "comment",
        id,
        `${VERDICT_MARKER}${JSON.stringify({ summary: "pass blocking=0 advisory=0", findings: [], reviewerProvenance: { harness: "fake" } })}`,
      ]);
      graph.op(["comment", id, `${VERDICT_MARKER}{not json`]);
      expect(reviewContextOf(await latestVerdictRecord(graph.dir, id))).toBeUndefined();
      expect(await statusText(mock, id, graph.dir)).not.toContain("Review context");

      // A recheck record is not a verdict record.
      graph.op([
        "comment",
        id,
        `${RECHECK_MARKER}${JSON.stringify({ reviewerProvenance: { harness: "fake", context: "warm" } })}`,
      ]);
      expect(reviewContextOf(await latestVerdictRecord(graph.dir, id))).toBeUndefined();
    } finally {
      await coordinator.teardown();
      graph.cleanup();
    }
  });

  it("a completion whose context is not a string is not a valid message", () => {
    const completion = {
      ...newEnvelope(),
      workflowRunId: "workgraph-run/x",
      executionId: "exec-1",
      issueId: "wg-1",
      leaseEpoch: 1,
      outcome: "success",
      artifacts: [],
      evidence: [],
      provenance: { harness: "fake", context: "fresh" },
    };
    expect(parseMessage(CH.runCompleted, RunCompleted, completion).provenance.context).toBe("fresh");
    expect(() =>
      parseMessage(CH.runCompleted, RunCompleted, {
        ...completion,
        provenance: { harness: "fake", context: { fresh: true } },
      }),
    ).toThrow(ProtocolError);
  });
});

describe("a bridged blocker recheck", () => {
  it("the second launch is given the numbered blocker, and its answer comes back as a recheck that takes the blocker away", async () => {
    const blocking: VerdictT = {
      findings: [
        {
          criterion: "criterion-x",
          severity: "blocking",
          note: "does not hold",
          citation: { path: "feature.txt", line: 1 },
        },
      ],
    };
    const t = setUp("rcrecheck", [
      { structuredOutput: blocking },
      {
        structuredOutput: {
          answers: [{ n: 1, decision: "downgrade", reason: "line 1 is the fix" }],
        },
      },
    ]);
    try {
      await t.drive();

      const metadata = metadataOf(t.repo, t.id);
      const tree = String(metadata[WORKGRAPH_RESULT_TREE_KEY]);
      const baseTree = String(metadata[WORKGRAPH_BASE_TREE_KEY]);
      const [review, recheck] = t.runtime.requests;
      expect(t.runtime.requests).toHaveLength(2);

      // The review asks for a verdict; with trees bound it asks for citations.
      expect(review!.params.outputSchema).toEqual(Verdict);
      expect(String(review!.params.task)).toContain('Give every blocking finding a "citation"');

      // The recheck is a new launch with no memory of the review, so its
      // task carries the blocker, its citation and the same tree sentence.
      expect(recheck!.params.context).toBe("fresh");
      expect(recheck!.params.cwd).toBe(t.repo.dir);
      expect(recheck!.params.outputSchema).toEqual(BlockerRecheck);
      const task = String(recheck!.params.task).split("\n");
      expect(task).toContain(
        `The change under review is "git diff ${baseTree} ${tree}" in ${t.repo.dir}. Do not modify any file.`,
      );
      expect(task).toContain("Blocking findings to recheck:");
      expect(task).toContain("1. criterion-x — does not hold (cited: feature.txt:1)");
      expect(task).toContain(
        "For each numbered blocker reply keep with the lines that prove it, or downgrade with why it does not hold.",
      );
      // It is not asked to review again.
      expect(task.join("\n")).not.toContain("report your verdict");

      // The bridge routed each structured output by what was asked for.
      const [first, second] = bridgeCompletions(t.mock);
      expect(first).toHaveProperty("verdict");
      expect(first).not.toHaveProperty("recheck");
      expect(second).toHaveProperty("recheck");
      expect(second).not.toHaveProperty("verdict");
      expect(second!.provenance.context).toBe("fresh");

      // So the downgrade landed: no revision, and the trail shows both replies.
      expect(t.repo.showIssue(t.id).status).toBe("closed");
      expect(metadata[WORKGRAPH_LAST_VERDICT_KEY]).toBe("pass blocking=0 advisory=1: criterion-x");
      const [record] = await payloads(t.repo.dir, t.id, RECHECK_MARKER);
      expect(record).toMatchObject({
        recheck: { outcome: "answers", executionId: second!.executionId },
      });
    } finally {
      await t.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the reviewer task text
// ---------------------------------------------------------------------------

function reviewRequest(extra: Record<string, unknown> = {}): RunRequestT {
  return {
    ...newEnvelope(),
    executorId: PI_SUBAGENTS_EXECUTOR_ID,
    issue: {
      id: "wg-7",
      title: "wire the flux capacitor",
      acceptanceCriteria: "retries back off\ncapped at five attempts",
    },
    workflowRunId: "workgraph-run/review-ctx",
    leaseEpoch: 3,
    role: "reviewer",
    attempt: 1,
    workspace: { baseRevision: "", requiresIsolation: false },
    outputSchema: Verdict,
    ...extra,
  } as RunRequestT;
}

const BOUND = {
  baseRevision: "c0ffee",
  requiresIsolation: false,
  path: "/work/checkout",
  baseTree: "aaa111",
  tree: "bbb222",
};

describe("the reviewer task", () => {
  const plain = buildSubagentTask(reviewRequest());

  it("lists the numbered criteria and asks for an answer to each, only when the request numbers them", () => {
    const task = buildSubagentTask(
      reviewRequest({
        criteria: [
          { id: "C1", text: "retries back off" },
          { id: "C2", text: "capped at five attempts" },
        ],
      }),
    ).split("\n");
    const at = task.indexOf("Acceptance criteria by id:");
    expect(at).toBeGreaterThan(-1);
    expect(task.slice(at + 1, at + 4)).toEqual([
      "- C1: retries back off",
      "- C2: capped at five attempts",
      'Answer every criterion by id in "criteria": met with evidence (a file path and line, or the check receipt), unmet with what is missing, or unanswered if you could not determine it.',
    ]);

    // No list, an empty one, or one that is not the shape: the task text is
    // what it was without the field.
    for (const criteria of [undefined, [], "C1", [{ id: "C1" }], [null], [{ id: 1, text: "x" }]]) {
      expect(buildSubagentTask(reviewRequest({ criteria }))).toBe(plain);
    }
  });

  it("asks for citations beside the tree sentence, and only with it", () => {
    const sentence =
      'The change under review is "git diff aaa111 bbb222" in /work/checkout. Do not modify any file.';
    const task = buildSubagentTask(reviewRequest({ workspace: BOUND })).split("\n");
    const at = task.indexOf(sentence);
    expect(at).toBeGreaterThan(-1);
    expect(task[at + 1]).toMatch(/^Give every blocking finding a "citation": /);
    expect(task[at + 1]).toContain("cite the nearest existing line");
    // Unbound work has no tree to check a citation against.
    expect(plain).not.toContain("citation");
  });

  it("passes on what the last verdict left unanswered", () => {
    const task = buildSubagentTask(
      reviewRequest({ feedback: "Your previous verdict did not answer these acceptance criteria: C2." }),
    ).split("\n");
    const at = task.indexOf("Your previous verdict for this result was not accepted — address this:");
    expect(at).toBeGreaterThan(-1);
    expect(task[at + 1]).toBe("Your previous verdict did not answer these acceptance criteria: C2.");
    expect(plain).not.toContain("was not accepted");
  });

  it("a recheck request replaces the review instructions; a malformed one is an ordinary review", () => {
    const task = buildSubagentTask(
      reviewRequest({
        workspace: BOUND,
        outputSchema: BlockerRecheck,
        criteria: [{ id: "C1", text: "retries back off" }],
        recheck: {
          blockers: [
            { n: 1, criterion: "criterion-x", note: "does not hold", citation: { path: "a.ts", line: 3 } },
            { n: 2, criterion: "criterion-y" },
          ],
        },
      }),
    );
    expect(task).toContain("1. criterion-x — does not hold (cited: a.ts:3)\n2. criterion-y\n");
    expect(task).toContain('"git diff aaa111 bbb222" in /work/checkout');
    // Not a review: no verdict, no criteria to answer, no citation rule.
    expect(task).not.toContain("report your verdict");
    expect(task).not.toContain("Acceptance criteria by id:");
    expect(task).not.toContain('Give every blocking finding a "citation"');

    for (const recheck of [
      undefined,
      null,
      {},
      { blockers: [] },
      { blockers: "all of them" },
      { blockers: [{ n: 0, criterion: "x" }] },
      { blockers: [{ n: 1 }] },
      { blockers: [null] },
    ]) {
      expect(buildSubagentTask(reviewRequest({ recheck }))).toBe(plain);
    }
    // Only a reviewer rechecks.
    expect(
      buildSubagentTask(
        reviewRequest({ role: "revision", recheck: { blockers: [{ n: 1, criterion: "x" }] } }),
      ),
    ).not.toContain("Blocking findings to recheck:");
  });
});
