/**
 * Plan critiques: schema validation, size caps, the compact summaries, the
 * comment-trail record and its plan-bound read-back, and the human-only
 * `renderPlanForReview`. Round trips run against a real SQLite workspace.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cappedGaps,
  critiqueSummary,
  latestPlanCritique,
  MAX_GAP_CHARS,
  MAX_GAPS,
  parsePlanCritique,
  PLAN_CRITIQUE_PREFIX,
  PlanCritiqueError,
  recordPlanCritique,
  unavailableSummary,
  type PlanCritiqueDetails,
} from "./critique.ts";
import {
  latestPlan,
  MAX_RENDER_CHARS,
  MAX_REVIEW_RENDER_CHARS,
  MAX_STEP_CHARS,
  MAX_STEPS,
  MAX_SUMMARY_CHARS,
  recordPlan,
  renderPlan,
  renderPlanForReview,
  TRUNCATION_MARKER,
} from "./plan.ts";
import { addComment, listComments } from "./store.ts";
import {
  WORKGRAPH_PLAN_CRITIQUE_KEY,
  type LeaseEvent,
  type PlanCritiqueT,
  type PlanGapT,
  type PlanT,
} from "./types.ts";
import { makeScratchGraph, type ScratchGraph } from "../test/helpers/scratch.ts";

const graphs: ScratchGraph[] = [];

/** A scratch workspace with one issue to hang plan and critique comments on. */
function makeIssue(): { cwd: string; id: string } {
  const graph = makeScratchGraph({ seed: 1, prefix: "crit" });
  graphs.push(graph);
  return { cwd: graph.dir, id: graph.seededIds[0]! };
}

afterEach(() => {
  for (const graph of graphs.splice(0)) graph.cleanup();
});

/** Run `body` with console.error silenced, returning the lines it logged. */
async function loggedErrors(body: () => unknown): Promise<string[]> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await body();
    return spy.mock.calls.map((args) => args.join(" "));
  } finally {
    spy.mockRestore();
  }
}

/** Exercises every block `renderPlan` can print. */
const FULL_PLAN: PlanT = {
  summary: "Retry transient API failures",
  acceptanceCriteria: "Requests retry twice with jitter",
  steps: [
    { description: "Add a RetryPolicy type", targets: ["src/retry.ts", "src/types.ts"], rationale: "one place for the knobs" },
    { description: "Handle retries", targets: ["src/client.ts"] },
    { description: "Wire the policy into ApiClient", rationale: "one call site" },
    { description: "Add tests" },
    { description: "Update src/retry.ts exports", targets: [] },
  ],
  risks: ["does the SDK already retry?", "is 429 retried upstream?"],
};

const FULL_PLAN_RENDERED = [
  "Retry transient API failures",
  "",
  "Acceptance criteria (as refined by the planner; the approved criteria on the issue remain authoritative):",
  "Requests retry twice with jitter",
  "",
  "Steps:",
  "1. Add a RetryPolicy type",
  "   targets: src/retry.ts, src/types.ts",
  "   why: one place for the knobs",
  "2. Handle retries",
  "   targets: src/client.ts",
  "3. Wire the policy into ApiClient",
  "   why: one call site",
  "4. Add tests",
  "5. Update src/retry.ts exports",
  "",
  "Open questions from the planner (advisory — not work items):",
  "- does the SDK already retry?",
  "- is 429 retried upstream?",
].join("\n");

/** The five-step plan from the spec's target output: bare steps, nothing else. */
const BARE_PLAN: PlanT = { steps: FULL_PLAN.steps.map((step) => ({ description: step.description })) };

function numberedPlan(count: number): PlanT {
  return { steps: Array.from({ length: count }, (_, i) => ({ description: `step ${i + 1}` })) };
}

/** Forty steps of 300 characters: about 12,000 rendered, past both render caps. */
const LONG_PLAN: PlanT = {
  steps: Array.from({ length: 40 }, (_, i) => ({ description: `step ${i + 1} ` + "y".repeat(300) })),
};

function gaps(count: number): PlanGapT[] {
  return Array.from({ length: count }, (_, i) => ({ step: i + 1, note: `gap ${i + 1}` }));
}

function details(planExecutionId: string, executionId = `critic-of-${planExecutionId}`): PlanCritiqueDetails {
  return {
    planExecutionId,
    workflowRunId: "workgraph-run/abc",
    executionId,
    executorId: "exec-critic",
    provenance: { harness: "pi", model: "anthropic/claude-opus-5" },
  };
}

/** Record a plan the way the coordinator does: the planner's executionId rides in the details. */
async function recordPlanAs(cwd: string, id: string, executionId: string, plan: PlanT = BARE_PLAN): Promise<void> {
  await recordPlan(cwd, id, plan, { workflowRunId: "workgraph-run/abc", executionId, executorId: "exec-planner" });
}

async function critiqueComments(cwd: string, id: string): Promise<Record<string, unknown>[]> {
  const marker = `${PLAN_CRITIQUE_PREFIX} critique `;
  return (await listComments(cwd, id))
    .filter((comment) => comment.text.startsWith(marker))
    .map((comment) => JSON.parse(comment.text.slice(marker.length)) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe("critique vocabulary", () => {
  it("names the metadata key, the comment prefix, and the two audit kinds", () => {
    expect(WORKGRAPH_PLAN_CRITIQUE_KEY).toBe("workgraph_plan_critique");
    expect(PLAN_CRITIQUE_PREFIX).toBe("workgraph-plan-critique");
    // Compile-time check: both kinds are members of the audit union.
    const kinds: LeaseEvent[] = ["plan-critique", "plan-critique-unavailable"];
    expect(kinds).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parsePlanCritique
// ---------------------------------------------------------------------------

describe("parsePlanCritique", () => {
  it("accepts a critique with zero gaps: that is the build-ready result", () => {
    expect(parsePlanCritique({ gaps: [] })).toEqual({ gaps: [] });
  });

  it("accepts gaps with and without a step, and an optional summary", () => {
    const critique = {
      gaps: [{ step: 2, note: "which errors retry, 429 only or 5xx too?" }, { note: "no step covers the docs criterion" }],
      summary: "two things to settle",
    };
    expect(parsePlanCritique(critique)).toEqual(critique);
  });

  it("rejects a missing or malformed payload with PlanCritiqueError", () => {
    expect(() => parsePlanCritique(undefined)).toThrow(PlanCritiqueError);
    expect(() => parsePlanCritique(null)).toThrow(PlanCritiqueError);
    expect(() => parsePlanCritique({})).toThrow(PlanCritiqueError);
    expect(() => parsePlanCritique({ gaps: "no" })).toThrow(PlanCritiqueError);
    expect(() => parsePlanCritique({ gaps: [{ step: 0, note: "zero is not a step" }] })).toThrow(PlanCritiqueError);
    expect(() => parsePlanCritique({ gaps: [{ step: 1.5, note: "half a step" }] })).toThrow(PlanCritiqueError);
    expect(() => parsePlanCritique({ gaps: [{ step: 1, note: "" }] })).toThrow(PlanCritiqueError);
    expect(() => parsePlanCritique({ gaps: [{ step: 1 }] })).toThrow(PlanCritiqueError);
  });

  it("invalidates the whole critique for one bad gap: no partial salvage", () => {
    expect(() => parsePlanCritique({ gaps: [{ note: "fine" }, { step: 0, note: "not fine" }] })).toThrow(
      PlanCritiqueError,
    );
  });

  it("reports at most three schema details", () => {
    const bad = { gaps: Array.from({ length: 6 }, () => ({ step: 0, note: "" })) };
    let caught: unknown;
    try {
      parsePlanCritique(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PlanCritiqueError);
    const error = caught as PlanCritiqueError;
    expect(error.name).toBe("PlanCritiqueError");
    expect(error.message).toBe(`Invalid plan critique payload: ${error.detail}`);
    expect(error.detail).not.toBe("");
    expect(error.detail.split("; ").length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Caps and summaries
// ---------------------------------------------------------------------------

describe("cappedGaps", () => {
  it("keeps zero and five gaps as they are", () => {
    expect(cappedGaps([])).toEqual([]);
    expect(cappedGaps(gaps(MAX_GAPS))).toEqual(gaps(MAX_GAPS));
  });

  it("keeps the first five of eight, in the critic's order", () => {
    const eight: PlanGapT[] = [
      { step: 7, note: "most important" },
      { note: "about the whole plan" },
      { step: 1, note: "third" },
      { step: 3, note: "fourth" },
      { step: 2, note: "fifth" },
      { step: 4, note: "dropped" },
      { step: 5, note: "dropped" },
      { step: 6, note: "dropped" },
    ];
    expect(cappedGaps(eight)).toEqual(eight.slice(0, MAX_GAPS));
  });

  it("truncates a long note with the plan module's marker and leaves an absent step absent", () => {
    const [capped] = cappedGaps([{ note: "n".repeat(1000) }]);
    expect(capped!.note).toBe("n".repeat(MAX_GAP_CHARS) + TRUNCATION_MARKER);
    expect("step" in capped!).toBe(false);
    expect(cappedGaps([{ step: 3, note: "short" }])).toEqual([{ step: 3, note: "short" }]);
  });
});

describe("critique summaries", () => {
  it("counts gaps, singular and plural", () => {
    expect(critiqueSummary({ gaps: [] })).toBe("0 gaps");
    expect(critiqueSummary({ gaps: gaps(1) })).toBe("1 gap");
    expect(critiqueSummary({ gaps: gaps(3) })).toBe("3 gaps");
  });

  it("counts the gaps that will be shown, not the gaps reported", () => {
    expect(critiqueSummary({ gaps: gaps(8) })).toBe("5 gaps");
  });

  it("appends the same-model note only when asked", () => {
    expect(critiqueSummary({ gaps: gaps(3) }, { sameModel: true })).toBe("3 gaps, same model as planner");
    expect(critiqueSummary({ gaps: [] }, { sameModel: true })).toBe("0 gaps, same model as planner");
    expect(critiqueSummary({ gaps: gaps(3) }, { sameModel: false })).toBe("3 gaps");
    expect(critiqueSummary({ gaps: gaps(3) }, {})).toBe("3 gaps");
  });

  it("unavailableSummary leads with the prefix and is capped", () => {
    expect(unavailableSummary("no plan_critic executor")).toBe("unavailable: no plan_critic executor");
    const long = unavailableSummary("r".repeat(500));
    expect(long.startsWith("unavailable: rrr")).toBe(true);
    expect(long.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(long.length).toBe(MAX_SUMMARY_CHARS + TRUNCATION_MARKER.length);
  });
});

// ---------------------------------------------------------------------------
// Record and read-back
// ---------------------------------------------------------------------------

describe("recordPlanCritique", () => {
  it("writes one machine-readable comment carrying the binding, the context, and the gaps", async () => {
    const { cwd, id } = makeIssue();
    const critique: PlanCritiqueT = {
      gaps: [{ step: 2, note: "which errors retry?" }, { note: "no step covers the docs criterion" }],
      summary: "two things to settle",
    };
    await recordPlanCritique(cwd, id, critique, details("plan-exec-a"), "critic-actor");

    const comments = await listComments(cwd, id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.text.startsWith("workgraph-plan-critique critique {")).toBe(true);
    expect(comments[0]!.author).toBe("critic-actor");
    expect(await critiqueComments(cwd, id)).toEqual([
      {
        planExecutionId: "plan-exec-a",
        workflowRunId: "workgraph-run/abc",
        executionId: "critic-of-plan-exec-a",
        executorId: "exec-critic",
        provenance: { harness: "pi", model: "anthropic/claude-opus-5" },
        summary: "2 gaps",
        gaps: critique.gaps,
        description: "two things to settle",
      },
    ]);
  });

  it("persists five of eight gaps and records the three it folded", async () => {
    const { cwd, id } = makeIssue();
    await recordPlanCritique(cwd, id, { gaps: gaps(8) }, details("plan-exec-a"));
    const [payload] = await critiqueComments(cwd, id);
    expect(payload!.gaps).toEqual(gaps(5));
    expect(payload!.foldedGaps).toBe(3);
    expect(payload!.summary).toBe("5 gaps");
    expect("description" in payload!).toBe(false);
  });

  it("truncates notes and the critic's summary, and omits foldedGaps when nothing was dropped", async () => {
    const { cwd, id } = makeIssue();
    await recordPlanCritique(
      cwd,
      id,
      { gaps: [{ step: 1, note: "n".repeat(1000) }], summary: "s".repeat(1000) },
      details("plan-exec-a"),
    );
    const [payload] = await critiqueComments(cwd, id);
    expect(payload!.gaps).toEqual([{ step: 1, note: "n".repeat(MAX_GAP_CHARS) + TRUNCATION_MARKER }]);
    expect(payload!.description).toBe("s".repeat(MAX_STEP_CHARS) + TRUNCATION_MARKER);
    expect("foldedGaps" in payload!).toBe(false);
  });

  it("resolves and logs when the comment cannot be written", async () => {
    const { cwd } = makeIssue();
    const logged = await loggedErrors(async () => {
      await expect(recordPlanCritique(cwd, "crit-missing", { gaps: gaps(1) }, details("plan-exec-a"))).resolves.toBeUndefined();
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("[pi-workgraph] PLAN CRITIQUE WRITE FAILED (crit-missing)");
  });

  it("resolves and logs when the payload cannot be serialized", async () => {
    const { cwd, id } = makeIssue();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const logged = await loggedErrors(async () => {
      await expect(
        recordPlanCritique(cwd, id, { gaps: [] }, { ...details("plan-exec-a"), provenance: circular }),
      ).resolves.toBeUndefined();
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`PLAN CRITIQUE WRITE FAILED (${id})`);
    expect(await listComments(cwd, id)).toEqual([]);
  });
});

describe("latestPlanCritique", () => {
  it("returns a critique only for the plan it was written against", async () => {
    const { cwd, id } = makeIssue();
    const gapsA: PlanGapT[] = [{ step: 2, note: "gap in plan A" }];
    const gapsB: PlanGapT[] = [{ step: 1, note: "gap in plan B" }, { note: "plan B as a whole" }];

    await recordPlanAs(cwd, id, "plan-exec-a");
    expect(await latestPlanCritique(cwd, id)).toBeUndefined();
    await recordPlanCritique(cwd, id, { gaps: gapsA }, details("plan-exec-a"));
    expect(await latestPlanCritique(cwd, id)).toEqual({ gaps: gapsA });

    // Reject and re-plan: plan B is now the latest, and A's critique is stale.
    await recordPlanAs(cwd, id, "plan-exec-b");
    expect(await latestPlanCritique(cwd, id)).toBeUndefined();

    await recordPlanCritique(cwd, id, { gaps: gapsB }, details("plan-exec-b"));
    expect(await latestPlanCritique(cwd, id)).toEqual({ gaps: gapsB });
  });

  it("round-trips a zero-gap critique and maps the critic's summary back", async () => {
    const { cwd, id } = makeIssue();
    await recordPlanAs(cwd, id, "plan-exec-a");
    await recordPlanCritique(cwd, id, { gaps: [], summary: "nothing to guess at" }, details("plan-exec-a"));
    expect(await latestPlanCritique(cwd, id)).toEqual({ gaps: [], summary: "nothing to guess at" });
  });

  it("reads back the capped gaps: five of eight", async () => {
    const { cwd, id } = makeIssue();
    await recordPlanAs(cwd, id, "plan-exec-a");
    await recordPlanCritique(cwd, id, { gaps: gaps(8) }, details("plan-exec-a"));
    expect(await latestPlanCritique(cwd, id)).toEqual({ gaps: gaps(5) });
  });

  it("ignores a critique that names the latest plan but was written before it", async () => {
    const { cwd, id } = makeIssue();
    await recordPlanCritique(cwd, id, { gaps: gaps(2) }, details("plan-exec-a"));
    await recordPlanAs(cwd, id, "plan-exec-a");
    expect(await latestPlanCritique(cwd, id)).toBeUndefined();
  });

  it("skips a later critique of another plan and still finds the matching one", async () => {
    const { cwd, id } = makeIssue();
    await recordPlanAs(cwd, id, "plan-exec-a");
    await recordPlanAs(cwd, id, "plan-exec-b");
    // A critique of the earlier plan that landed late: after B, but not B's.
    await recordPlanCritique(cwd, id, { gaps: [{ note: "late gap in plan A" }] }, details("plan-exec-a"));
    expect(await latestPlanCritique(cwd, id)).toBeUndefined();

    await recordPlanCritique(cwd, id, { gaps: [{ note: "gap in plan B" }] }, details("plan-exec-b"));
    await recordPlanCritique(cwd, id, { gaps: [{ note: "another late gap in plan A" }] }, details("plan-exec-a"));
    expect(await latestPlanCritique(cwd, id)).toEqual({ gaps: [{ note: "gap in plan B" }] });
  });

  it("returns undefined when there is no plan, or the plan has no executionId to bind to", async () => {
    const { cwd, id } = makeIssue();
    expect(await latestPlanCritique(cwd, id)).toBeUndefined();
    await recordPlanCritique(cwd, id, { gaps: gaps(1) }, details("plan-exec-a"));
    expect(await latestPlanCritique(cwd, id)).toBeUndefined();

    // An older plan record: no executionId in its details.
    await recordPlan(cwd, id, BARE_PLAN, { workflowRunId: "workgraph-run/abc" });
    await recordPlanCritique(cwd, id, { gaps: gaps(1) }, details("plan-exec-a"));
    expect(await latestPlanCritique(cwd, id)).toBeUndefined();
  });

  it("returns undefined when the latest plan comment or the critique comment is unparseable", async () => {
    const broken = makeIssue();
    await recordPlanAs(broken.cwd, broken.id, "plan-exec-a");
    await recordPlanCritique(broken.cwd, broken.id, { gaps: gaps(1) }, details("plan-exec-a"));
    await addComment(broken.cwd, broken.id, "workgraph-plan plan {not json");
    await recordPlanCritique(broken.cwd, broken.id, { gaps: gaps(1) }, details("plan-exec-a"));
    expect(await latestPlanCritique(broken.cwd, broken.id)).toBeUndefined();

    const { cwd, id } = makeIssue();
    await recordPlanAs(cwd, id, "plan-exec-a");
    await recordPlanCritique(cwd, id, { gaps: gaps(1) }, details("plan-exec-a"));
    await addComment(cwd, id, "workgraph-plan-critique critique {not json");
    expect(await latestPlanCritique(cwd, id)).toBeUndefined();
  });

  it("returns undefined for a critique comment whose gaps fail the schema", async () => {
    const { cwd, id } = makeIssue();
    await recordPlanAs(cwd, id, "plan-exec-a");
    await addComment(cwd, id, `workgraph-plan-critique critique ${JSON.stringify({ planExecutionId: "plan-exec-a" })}`);
    // A comment with no gaps field must not read back as "zero gaps, build-ready".
    expect(await latestPlanCritique(cwd, id)).toBeUndefined();

    await addComment(
      cwd,
      id,
      `workgraph-plan-critique critique ${JSON.stringify({ planExecutionId: "plan-exec-a", gaps: [{ step: 0, note: "" }] })}`,
    );
    expect(await latestPlanCritique(cwd, id)).toBeUndefined();
  });
});

describe("prefix safety", () => {
  it("latestPlan still returns the plan when a critique comment is the newest comment", async () => {
    const { cwd, id } = makeIssue();
    await recordPlanAs(cwd, id, "plan-exec-a");
    const before = await latestPlan(cwd, id);
    expect(before).toEqual(BARE_PLAN);

    await recordPlanCritique(cwd, id, { gaps: gaps(3), summary: "three gaps" }, details("plan-exec-a"));
    const comments = await listComments(cwd, id);
    expect(comments.at(-1)!.text.startsWith("workgraph-plan-critique critique ")).toBe(true);
    // The critique marker shares the "workgraph-plan" stem but not the plan marker.
    expect(comments.at(-1)!.text.startsWith("workgraph-plan plan ")).toBe(false);
    expect(await latestPlan(cwd, id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// renderPlan and renderPlanForReview
// ---------------------------------------------------------------------------

describe("renderPlan (the implementer's view)", () => {
  it("is pinned byte for byte, so the shared line builder cannot change a prompt", () => {
    expect(renderPlan(FULL_PLAN)).toBe(FULL_PLAN_RENDERED);
    expect(renderPlan({ steps: [{ description: "only step" }] })).toBe("Steps:\n1. only step");
  });

  it("is pinned for a plan folded past MAX_STEPS", () => {
    const expected = [
      "Steps:",
      ...Array.from({ length: MAX_STEPS }, (_, i) => `${i + 1}. step ${i + 1}`),
      "… and 2 further step(s), folded.",
    ].join("\n");
    expect(renderPlan(numberedPlan(MAX_STEPS + 2))).toBe(expected);
  });

  it("is pinned at the truncation point for a plan that renders past MAX_RENDER_CHARS", () => {
    const untruncated = ["Steps:", ...LONG_PLAN.steps.map((step, i) => `${i + 1}. ${step.description}`)].join("\n");
    expect(untruncated.length).toBeGreaterThan(MAX_RENDER_CHARS);
    expect(renderPlan(LONG_PLAN)).toBe(untruncated.slice(0, MAX_RENDER_CHARS) + TRUNCATION_MARKER);
  });
});

describe("renderPlanForReview (the human's view)", () => {
  it("prints each gap under the step it names and step-less gaps after the last step", () => {
    const critique: PlanCritiqueT = {
      gaps: [
        { step: 2, note: "which errors retry, 429 only or 5xx too?" },
        { step: 4, note: "nothing adds the jitter the acceptance criteria require" },
        { note: 'no step covers the "exponential backoff is documented" criterion' },
      ],
    };
    expect(renderPlanForReview(BARE_PLAN, critique)).toBe(
      [
        "Steps:",
        "1. Add a RetryPolicy type",
        "2. Handle retries",
        "   ? which errors retry, 429 only or 5xx too?",
        "3. Wire the policy into ApiClient",
        "4. Add tests",
        "   ? nothing adds the jitter the acceptance criteria require",
        "5. Update src/retry.ts exports",
        "",
        "Plan as a whole:",
        '? no step covers the "exponential backoff is documented" criterion',
      ].join("\n"),
    );
  });

  it("returns exactly renderPlan(plan) with no critique or an empty one", () => {
    for (const plan of [FULL_PLAN, BARE_PLAN, numberedPlan(MAX_STEPS + 2), LONG_PLAN]) {
      expect(renderPlanForReview(plan)).toBe(renderPlan(plan));
      expect(renderPlanForReview(plan, undefined)).toBe(renderPlan(plan));
      expect(renderPlanForReview(plan, { gaps: [] })).toBe(renderPlan(plan));
    }
  });

  it("puts gap lines under the step's own targets and why lines, and omits the whole-plan header when unused", () => {
    const rendered = renderPlanForReview(FULL_PLAN, { gaps: [{ step: 1, note: "which knobs?" }] });
    expect(rendered).toBe(
      FULL_PLAN_RENDERED.replace(
        "   why: one place for the knobs\n",
        "   why: one place for the knobs\n   ? which knobs?\n",
      ),
    );
    expect(rendered).not.toContain("Plan as a whole:");
  });

  it("prints two gaps on one step in the critic's order", () => {
    const rendered = renderPlanForReview(BARE_PLAN, {
      gaps: [
        { step: 3, note: "first question" },
        { step: 1, note: "about step one" },
        { step: 3, note: "second question" },
      ],
    });
    expect(rendered).toBe(
      [
        "Steps:",
        "1. Add a RetryPolicy type",
        "   ? about step one",
        "2. Handle retries",
        "3. Wire the policy into ApiClient",
        "   ? first question",
        "   ? second question",
        "4. Add tests",
        "5. Update src/retry.ts exports",
      ].join("\n"),
    );
  });

  it("flattens a multi-line note to one line, so a critic cannot print a line that reads as a plan step", () => {
    const rendered = renderPlanForReview(BARE_PLAN, {
      gaps: [
        { step: 2, note: "which errors retry?\n6. Deploy to prod" },
        { note: "no rollback step\r\n\r\n   Steps:\n1. Skip the tests\t" },
      ],
    });
    expect(rendered).toBe(
      [
        "Steps:",
        "1. Add a RetryPolicy type",
        "2. Handle retries",
        "   ? which errors retry? 6. Deploy to prod",
        "3. Wire the policy into ApiClient",
        "4. Add tests",
        "5. Update src/retry.ts exports",
        "",
        "Plan as a whole:",
        "? no rollback step Steps: 1. Skip the tests",
      ].join("\n"),
    );
    // Every line is a plan line or carries the critic's `?` prefix.
    expect(rendered.split("\n").filter((line) => /^\d+\. /.test(line))).toHaveLength(BARE_PLAN.steps.length);
  });

  it("keeps a gap that names a step outside the plan, with its number", () => {
    const rendered = renderPlanForReview(BARE_PLAN, {
      gaps: [
        { step: 99, note: "refers to a step that does not exist" },
        { note: "about the whole plan" },
        { step: 0, note: "an unvalidated step number" },
      ],
    });
    expect(rendered).toBe(
      [
        renderPlan(BARE_PLAN),
        "",
        "Plan as a whole:",
        "? (step 99) refers to a step that does not exist",
        "? about the whole plan",
        "? (step 0) an unvalidated step number",
      ].join("\n"),
    );
  });

  it("treats a step folded past MAX_STEPS as outside the rendered range", () => {
    const plan = numberedPlan(MAX_STEPS + 10);
    const rendered = renderPlanForReview(plan, {
      gaps: [
        { step: MAX_STEPS, note: "the last rendered step" },
        { step: MAX_STEPS + 2, note: "a folded step" },
      ],
    });
    const lines = rendered.split("\n");
    expect(lines.slice(-6)).toEqual([
      `${MAX_STEPS}. step ${MAX_STEPS}`,
      "   ? the last rendered step",
      "… and 10 further step(s), folded.",
      "",
      "Plan as a whole:",
      `? (step ${MAX_STEPS + 2}) a folded step`,
    ]);
  });

  it("places the whole-plan block after the steps and before the planner's open questions", () => {
    const rendered = renderPlanForReview(FULL_PLAN, {
      gaps: [{ note: "no step documents the backoff" }, { step: 5, note: "which exports?" }],
    });
    expect(rendered).toBe(
      FULL_PLAN_RENDERED.replace(
        "5. Update src/retry.ts exports\n",
        "5. Update src/retry.ts exports\n   ? which exports?\n\nPlan as a whole:\n? no step documents the backoff\n",
      ),
    );
  });

  it("has room for a full critique on a plan that already fills the prompt cap", () => {
    // 26 steps of ~300 characters render just under MAX_RENDER_CHARS.
    const plan: PlanT = {
      steps: Array.from({ length: 26 }, () => ({ description: "y".repeat(296) })),
    };
    const base = renderPlan(plan);
    expect(base.endsWith(TRUNCATION_MARKER)).toBe(false);
    expect(base.length).toBeGreaterThan(MAX_RENDER_CHARS - 300);

    const full = cappedGaps([
      { step: 26, note: "a".repeat(1000) },
      { step: 26, note: "b".repeat(1000) },
      { note: "c".repeat(1000) },
      { step: 99, note: "d".repeat(1000) },
      { note: "e".repeat(1000) },
    ]);
    const rendered = renderPlanForReview(plan, { gaps: full });
    expect(rendered.length).toBeGreaterThan(MAX_RENDER_CHARS);
    expect(rendered.length).toBeLessThanOrEqual(MAX_REVIEW_RENDER_CHARS);
    for (const gap of full) expect(rendered).toContain(gap.note);
    expect(rendered.endsWith(`? ${full[4]!.note}`)).toBe(true);
  });

  it("is still bounded when the plan alone exceeds the review cap", () => {
    const rendered = renderPlanForReview(LONG_PLAN, { gaps: [{ step: 1, note: "early gap" }] });
    expect(rendered).toContain("   ? early gap");
    expect(rendered.length).toBe(MAX_REVIEW_RENDER_CHARS + TRUNCATION_MARKER.length);
    expect(rendered.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});
