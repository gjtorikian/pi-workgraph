/**
 * The `criteria-evidence` gate (proof-of-success phase 4): a pass has to be
 * positive.
 *
 *  - `parseCriteria`: one stored string in, a numbered list out.
 *  - `evaluateCriteria`: what a verdict's answers add up to.
 *  - The gate in the judgment loop, on the shipped defaults (no gate
 *    configuration at all) and a git-backed scratch: an empty verdict, a
 *    partial one and an unevidenced one are not a pass; an unmet criterion
 *    is a blocking finding; only a verdict that answers every criterion as
 *    met, with evidence, closes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import {
  criteriaIds,
  evaluateCriteria,
  MAX_CRITERIA,
  parseCriteria,
  unmetFindings,
} from "../src/criteria.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import type { PolicyOverrides } from "../src/policy.ts";
import { latestStamp, listGateRecords } from "../src/proof.ts";
import { listComments } from "../src/store.ts";
import {
  WORKGRAPH_LAST_VERDICT_KEY,
  WORKGRAPH_PHASE_KEY,
  type VerdictT,
} from "../src/types.ts";
import {
  MAX_EVIDENCE_CHARS,
  parseVerdict,
  recordVerdict,
  TRUNCATION_MARKER,
  VERDICT_MARKER,
  verdictSummary,
} from "../src/verdict.ts";
import { shippedConfig } from "./helpers/config.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockPi,
} from "./helpers/mock-pi.ts";
import {
  makeScratchGraph,
  makeScratchRepo,
  type ScratchGraph,
  type ScratchRepo,
} from "./helpers/scratch.ts";

// ---------------------------------------------------------------------------
// parseCriteria
// ---------------------------------------------------------------------------

describe("parseCriteria", () => {
  it("gives no criteria for a missing, empty or blank string", () => {
    expect(parseCriteria(undefined)).toEqual([]);
    expect(parseCriteria("")).toEqual([]);
    expect(parseCriteria("  \n\t\n  ")).toEqual([]);
  });

  it("reads text with no newline as one criterion", () => {
    expect(parseCriteria("the capacitor fluxes")).toEqual([
      { id: "C1", text: "the capacitor fluxes" },
    ]);
  });

  it("numbers bulleted lines in order and strips the bullets", () => {
    expect(parseCriteria("- retries back off\n* capped at five attempts\n+ logged once")).toEqual([
      { id: "C1", text: "retries back off" },
      { id: "C2", text: "capped at five attempts" },
      { id: "C3", text: "logged once" },
    ]);
  });

  it("strips list numbers and drops the blank lines between them", () => {
    expect(parseCriteria("1. retries back off\n\n2) capped at five attempts\n\n\n3. logged once\n")).toEqual([
      { id: "C1", text: "retries back off" },
      { id: "C2", text: "capped at five attempts" },
      { id: "C3", text: "logged once" },
    ]);
  });

  it("strips checkboxes, stacked markers and Windows line endings", () => {
    expect(
      parseCriteria("- [ ] first\r\n1. [x] second\r\n[X] third\r\n  -   fourth  \r\n"),
    ).toEqual([
      { id: "C1", text: "first" },
      { id: "C2", text: "second" },
      { id: "C3", text: "third" },
      { id: "C4", text: "fourth" },
    ]);
  });

  it("drops a line that is only a marker", () => {
    expect(parseCriteria("-\n1.\n[ ]\n- [ ]\nreal")).toEqual([{ id: "C1", text: "real" }]);
  });

  it("keeps text that only looks like a marker", () => {
    expect(
      parseCriteria("-1 is returned on error\n1.5 s timeout\n*args are forwarded\n[a] is not a checkbox"),
    ).toEqual([
      { id: "C1", text: "-1 is returned on error" },
      { id: "C2", text: "1.5 s timeout" },
      { id: "C3", text: "*args are forwarded" },
      { id: "C4", text: "[a] is not a checkbox" },
    ]);
  });

  it("folds the lines past the cap into the last item", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `- criterion ${i + 1}`);
    const criteria = parseCriteria(lines.join("\n"));
    expect(criteria).toHaveLength(MAX_CRITERIA);
    expect(criteria[0]).toEqual({ id: "C1", text: "criterion 1" });
    expect(criteria[28]).toEqual({ id: "C29", text: "criterion 29" });
    expect(criteria[29]!.id).toBe("C30");
    // Nothing is lost: lines 30 to 40 are all in C30.
    for (let n = 30; n <= 40; n++) {
      expect(criteria[29]!.text).toContain(`criterion ${n}`);
    }
    // Exactly at the cap nothing is folded.
    const exact = parseCriteria(lines.slice(0, MAX_CRITERIA).join("\n"));
    expect(exact).toHaveLength(MAX_CRITERIA);
    expect(exact[29]).toEqual({ id: "C30", text: "criterion 30" });
  });

  it("gives the same ids for the same string every time", () => {
    const text = "retries back off\ncapped at five attempts";
    expect(parseCriteria(text)).toEqual(parseCriteria(text));
    expect(criteriaIds(parseCriteria(text))).toBe("C1, C2");
  });
});

// ---------------------------------------------------------------------------
// evaluateCriteria
// ---------------------------------------------------------------------------

const TWO = parseCriteria("retries back off\ncapped at five attempts");

describe("evaluateCriteria", () => {
  it("does not apply to an issue with no criteria", () => {
    expect(evaluateCriteria([], { findings: [] })).toEqual({
      result: "not-applicable",
      met: [],
      unmet: [],
      unanswered: [],
    });
    // Answers to criteria that do not exist change nothing.
    expect(
      evaluateCriteria([], {
        findings: [],
        criteria: [{ id: "C1", status: "unmet", evidence: "x" }],
      }).result,
    ).toBe("not-applicable");
  });

  it("passes only when every criterion is met with evidence", () => {
    const evaluation = evaluateCriteria(TWO, {
      findings: [],
      criteria: [
        { id: "C1", status: "met", evidence: "src/retry.ts:12" },
        { id: "C2", status: "met", evidence: "the check receipt" },
      ],
    });
    expect(evaluation.result).toBe("pass");
    expect(evaluation.met.map((c) => c.id)).toEqual(["C1", "C2"]);
  });

  it("an old-shape verdict with no answers is unknown, never a pass", () => {
    const evaluation = evaluateCriteria(TWO, { findings: [] });
    expect(evaluation.result).toBe("unknown");
    expect(evaluation.unanswered.map((c) => c.id)).toEqual(["C1", "C2"]);
  });

  it("a missing answer, an explicit unanswered and met without evidence are all unanswered", () => {
    expect(
      evaluateCriteria(TWO, {
        findings: [],
        criteria: [{ id: "C1", status: "met", evidence: "src/retry.ts:12" }],
      }),
    ).toMatchObject({ result: "unknown", unanswered: [TWO[1]] });
    expect(
      evaluateCriteria(TWO, {
        findings: [],
        criteria: [
          { id: "C1", status: "met", evidence: "src/retry.ts:12" },
          { id: "C2", status: "unanswered", evidence: "could not run it" },
        ],
      }),
    ).toMatchObject({ result: "unknown", unanswered: [TWO[1]] });
    for (const evidence of [undefined, "", "   \n"]) {
      expect(
        evaluateCriteria(TWO, {
          findings: [],
          criteria: [
            { id: "C1", status: "met", evidence: "src/retry.ts:12" },
            { id: "C2", status: "met", ...(evidence !== undefined ? { evidence } : {}) },
          ],
        }),
      ).toMatchObject({ result: "unknown", met: [TWO[0]], unanswered: [TWO[1]] });
    }
  });

  it("any unmet criterion is a violation, even beside an unanswered one", () => {
    const evaluation = evaluateCriteria(TWO, {
      findings: [],
      criteria: [{ id: "C2", status: "unmet", evidence: "no cap anywhere" }],
    });
    expect(evaluation.result).toBe("violation");
    expect(evaluation.unmet).toEqual([TWO[1]]);
    expect(evaluation.unanswered).toEqual([TWO[0]]);
  });

  it("two answers for one id: the worst one wins", () => {
    const answered = { id: "C2", status: "met", evidence: "src/cap.ts:3" } as const;
    expect(
      evaluateCriteria(TWO, {
        findings: [],
        criteria: [
          { id: "C1", status: "met", evidence: "src/retry.ts:12" },
          answered,
          { id: "C2", status: "unmet", evidence: "no cap" },
        ],
      }).result,
    ).toBe("violation");
    expect(
      evaluateCriteria(TWO, {
        findings: [],
        criteria: [
          { id: "C1", status: "met", evidence: "src/retry.ts:12" },
          answered,
          { id: "C2", status: "unanswered" },
        ],
      }).result,
    ).toBe("unknown");
  });

  it("ignores an answer for an id that does not exist, and reads ids leniently", () => {
    const evaluation = evaluateCriteria(TWO, {
      findings: [],
      criteria: [
        { id: " c1 ", status: "met", evidence: "src/retry.ts:12" },
        { id: "C2", status: "met", evidence: "src/cap.ts:3" },
        { id: "C9", status: "unmet", evidence: "there is no C9" },
      ],
    });
    expect(evaluation.result).toBe("pass");
  });

  it("an unmet criterion becomes a blocking finding the core wrote from the reviewer's answer", () => {
    const verdict: VerdictT = {
      findings: [],
      criteria: [
        { id: "C1", status: "met", evidence: "src/retry.ts:12" },
        { id: "C2", status: "unmet", evidence: " no cap anywhere " },
      ],
    };
    expect(unmetFindings(evaluateCriteria(TWO, verdict), verdict)).toEqual([
      {
        criterion: "capped at five attempts",
        severity: "blocking",
        note: "no cap anywhere",
        author: "reviewer",
      },
    ]);
    // With nothing said about what is missing, the finding has no note.
    const bare: VerdictT = { findings: [], criteria: [{ id: "C2", status: "unmet" }] };
    expect(unmetFindings(evaluateCriteria(TWO, bare), bare)).toEqual([
      { criterion: "capped at five attempts", severity: "blocking", author: "reviewer" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// the verdict shape and its record
// ---------------------------------------------------------------------------

describe("the verdict carries the answers", () => {
  it("parses a verdict with criterion answers and one without", () => {
    expect(parseVerdict({ findings: [] })).toEqual({ findings: [] });
    const answered = {
      findings: [],
      criteria: [{ id: "C1", status: "met", evidence: "src/retry.ts:12" }],
    };
    expect(parseVerdict(answered)).toEqual(answered);
    expect(() =>
      parseVerdict({ findings: [], criteria: [{ id: "C1", status: "probably" }] }),
    ).toThrow(/Invalid verdict payload/);
  });

  it("the summary counts met criteria only when it is given the criteria", () => {
    const verdict: VerdictT = {
      findings: [],
      criteria: [{ id: "C1", status: "met", evidence: "src/retry.ts:12" }],
    };
    // Byte-stable for an issue without criteria, or a gate that is off.
    expect(verdictSummary(verdict)).toBe("pass blocking=0 advisory=0");
    expect(verdictSummary(verdict, [])).toBe("pass blocking=0 advisory=0");
    expect(verdictSummary(verdict, TWO)).toBe("pass blocking=0 advisory=0 criteria=1/2");
    expect(
      verdictSummary(
        { findings: [{ criterion: "criterion-x", severity: "blocking" }] },
        TWO,
      ),
    ).toBe("reject blocking=1 advisory=0 criteria=0/2: criterion-x");
  });

  it("the verdict record keeps the answers, capped and truncated", async () => {
    const graph = makeScratchGraph({ prefix: "cevrec", seed: 1 });
    const id = graph.seededIds[0]!;
    try {
      const answers = Array.from({ length: MAX_CRITERIA + 5 }, (_, i) => ({
        id: `C${i + 1}`,
        status: "met" as const,
        evidence: i === 0 ? "e".repeat(MAX_EVIDENCE_CHARS + 50) : `src/a.ts:${i + 1}`,
      }));
      await recordVerdict(
        graph.dir,
        id,
        { findings: [], criteria: answers },
        { workflowRunId: "workgraph-run/x", attempt: 1 },
        undefined,
        TWO,
      );
      const [comment] = (await listComments(graph.dir, id)).filter((c) =>
        c.text.startsWith(VERDICT_MARKER),
      );
      const payload = JSON.parse(comment!.text.slice(VERDICT_MARKER.length)) as {
        summary: string;
        criteria: Array<{ id: string; status: string; evidence: string }>;
        foldedCriteria: number;
      };
      expect(payload.summary).toBe("pass blocking=0 advisory=0 criteria=2/2");
      expect(payload.criteria).toHaveLength(MAX_CRITERIA);
      expect(payload.foldedCriteria).toBe(5);
      expect(payload.criteria[0]!.evidence).toBe(
        "e".repeat(MAX_EVIDENCE_CHARS) + TRUNCATION_MARKER,
      );
      expect(payload.criteria[1]).toEqual({ id: "C2", status: "met", evidence: "src/a.ts:2" });
    } finally {
      graph.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// the gate in the judgment loop
// ---------------------------------------------------------------------------

const WORKER = "criteria-evidence-worker";

/** Distinct author/reviewer provenance — independent under every policy. */
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };

const CRITERIA = "retries back off\ncapped at five attempts";
const C1 = { id: "C1", status: "met", evidence: "src/retry.ts:12" } as const;
const C2 = { id: "C2", status: "met", evidence: "the check receipt" } as const;

/** The five verdict shapes of the spec's experiment. */
const EMPTY: VerdictT = { findings: [] };
const C1_ONLY: VerdictT = { findings: [], criteria: [C1] };
const C2_NO_EVIDENCE: VerdictT = {
  findings: [],
  criteria: [C1, { id: "C2", status: "met", evidence: "" }],
};
const C2_UNMET: VerdictT = {
  findings: [],
  criteria: [C1, { id: "C2", status: "unmet", evidence: "nothing caps the attempts" }],
};
const BOTH_MET: VerdictT = { findings: [], criteria: [C1, C2] };

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
}

/** A coordinator on the shipped defaults, or on exactly the `policy` given. */
function makeHarness(policy?: PolicyOverrides): Harness {
  const mock = makeMockPi();
  setWorkerIdOverride(WORKER);
  const config = shippedConfig({
    workerIdOverride: WORKER,
    ...(policy ? { policy } : {}),
  });
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
  });
  return { mock, coordinator };
}

async function drive(mock: MockPi, ctx: unknown): Promise<void> {
  await mock.emit(
    "agent_settled",
    { type: "agent_settled" },
    ctx as Parameters<MockPi["emit"]>[2],
  );
  await mock.flushEvents();
}

/** Approve a medium-risk issue with a passing check and, optionally, criteria. */
function approve(graph: ScratchGraph, id: string, criteria?: string): void {
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
    ...(criteria !== undefined ? ["--acceptance", criteria] : []),
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

const audits = (dir: string, id: string, kind: string) =>
  payloads(dir, id, `workgraph-lease ${kind} `);

async function criteriaRecords(dir: string, id: string) {
  return (await listGateRecords(dir, id)).filter((r) => r.gate === "criteria-evidence");
}

/** What an isolated fake reports: its work is in the repository, cut from HEAD. */
function isolatedIn(repo: ScratchRepo) {
  return { path: repo.dir, baseRevision: repo.head };
}

/** The tolerated extra fields of a recorded review request. */
type ReviewRequest = { role: string; feedback?: string; criteria?: unknown };

function reviewsOf(fake: { requests: unknown[] }): ReviewRequest[] {
  return (fake.requests as ReviewRequest[]).filter((r) => r.role === "reviewer");
}

/** Silence console.error and return the lines it was given. */
function captureErrors(): () => string[] {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.join(" "));
}

/**
 * One medium-risk issue with the two criteria, an implementer and a reviewer
 * that returns `verdicts` in request order (the last one repeats).
 */
function setUp(
  prefix: string,
  verdicts: VerdictT[],
  opts: { policy?: PolicyOverrides; criteria?: string | null } = {},
) {
  const repo = makeScratchRepo({ prefix, seed: 1 });
  const id = repo.seededIds[0]!;
  approve(repo, id, opts.criteria === null ? undefined : (opts.criteria ?? CRITERIA));
  const { mock, coordinator } = makeHarness(opts.policy);
  const fake = installFakeExecutor(mock.events, {
    roles: ["implementer", "reviewer"],
    workspace: isolatedIn(repo),
    roleScripts: {
      implementer: { provenance: IMPL_PROV },
      reviewer: verdicts.map((verdict) => ({ provenance: REV_PROV, verdict })),
    },
  });
  const ectx = makeEventContext(repo.dir);
  return {
    repo,
    id,
    mock,
    coordinator,
    fake,
    ectx,
    async cleanup() {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLeasesForTest();
  resetIdentityForTest();
});

describe("the criteria-evidence gate, default config, medium risk", () => {
  it.each([
    ["an empty verdict", EMPTY, "C1, C2", "0/2"],
    ["a verdict that answers C1 only", C1_ONLY, "C2", "1/2"],
    ["a verdict whose C2 is met with empty evidence", C2_NO_EVIDENCE, "C2", "1/2"],
  ] as const)(
    "%s is not a pass: the review is asked again, then the run escalates naming the ids",
    async (_what, verdict, ids, met) => {
      const t = setUp("ceunk", [verdict]);
      try {
        await drive(t.mock, t.ectx.ctx);

        expect(t.repo.showIssue(t.id).status).toBe("blocked");
        const metadata = metadataOf(t.repo, t.id);
        expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("escalated");
        expect(metadata[WORKGRAPH_LAST_VERDICT_KEY]).toBe(
          `pass blocking=0 advisory=0 criteria=${met}`,
        );

        // Three reviews: the first, and one per retry of the shared bound.
        const reviews = reviewsOf(t.fake);
        expect(reviews).toHaveLength(3);
        // Every review got the numbered criteria ...
        for (const review of reviews) {
          expect(review.criteria).toEqual([
            { id: "C1", text: "retries back off" },
            { id: "C2", text: "capped at five attempts" },
          ]);
        }
        // ... and each follow-up names what the last verdict left open.
        expect(reviews[0]!.feedback).toBeUndefined();
        expect(reviews[1]!.feedback).toContain(`acceptance criteria: ${ids}.`);
        expect(reviews[2]!.feedback).toContain(`acceptance criteria: ${ids}.`);

        const escalated = await audits(t.repo.dir, t.id, "escalated");
        expect(escalated).toHaveLength(1);
        expect(String(escalated[0]!.reason)).toMatch(
          new RegExp(`^criteria unanswered after 3 reviews: ${ids}; set gates\\.criteria-evidence to observe`),
        );
        const rejected = await audits(t.repo.dir, t.id, "review-rejected");
        expect(rejected.map((r) => [r.reason, r.retry])).toEqual([
          [`criteria unanswered: ${ids}`, 1],
          [`criteria unanswered: ${ids}`, 2],
          [`criteria unanswered: ${ids}`, 3],
        ]);

        // One gate record per round, each blocked on `unknown`; every round's
        // verdict was recorded before the gate read it.
        const records = await criteriaRecords(t.repo.dir, t.id);
        expect(records.map((r) => [r.mode, r.result, r.blocked, r.reason])).toEqual([
          ["enforce", "unknown", true, `unanswered: ${ids}`],
          ["enforce", "unknown", true, `unanswered: ${ids}`],
          ["enforce", "unknown", true, `unanswered: ${ids}`],
        ]);
        expect(await payloads(t.repo.dir, t.id, VERDICT_MARKER)).toHaveLength(3);
        // Never a revision: nothing is wrong with the work that anyone said.
        expect(await audits(t.repo.dir, t.id, "revision-requested")).toEqual([]);
        expect(await latestStamp(t.repo.dir, t.id)).toBeUndefined();
        expect(heldLeases(t.repo.dir)).toHaveLength(0);
      } finally {
        await t.cleanup();
      }
    },
    60_000,
  );

  it("an unmet criterion sends the issue to revising with a finding whose criterion is C2's text", async () => {
    const t = setUp("ceunmet", [C2_UNMET]);
    captureErrors(); // "no revision-capable executor" is expected noise
    try {
      await drive(t.mock, t.ectx.ctx);

      // Nothing offers the revision role, so the run parks where the gate
      // sent it: in revising, under its lease.
      expect(t.repo.showIssue(t.id).status).toBe("in_progress");
      const metadata = metadataOf(t.repo, t.id);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("revising");
      expect(metadata[WORKGRAPH_LAST_VERDICT_KEY]).toBe(
        "reject blocking=1 advisory=0 criteria=1/2: capped at five attempts",
      );
      // One review. An unmet criterion is not a reviewer blocker: it has no
      // line to cite and nothing for a second look to weigh, so no recheck.
      expect(t.fake.requests.map((r) => r.role)).toEqual(["implementer", "reviewer"]);

      const records = await listGateRecords(t.repo.dir, t.id);
      expect(
        records
          .filter((r) => r.gate === "criteria-evidence" || r.gate === "review")
          .map((r) => [r.gate, r.result, r.blocked, r.reason]),
      ).toEqual([
        ["criteria-evidence", "violation", true, "unmet: C2"],
        // The reviewer reported no blocker of its own: its gate passed.
        ["review", "pass", false, undefined],
      ]);
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("the revision is handed the unmet criterion as a blocking finding, and the answered re-review closes", async () => {
    const repo = makeScratchRepo({ prefix: "celoop", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, CRITERIA);
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "revision"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        revision: { provenance: IMPL_PROV },
        reviewer: [
          { provenance: REV_PROV, verdict: C2_UNMET },
          { provenance: REV_PROV, verdict: BOTH_MET },
        ],
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(repo.showIssue(id).status).toBe("closed");
      const revision = fake.requests.find((r) => r.role === "revision")!;
      expect(revision.priorFindings!.map((f) => JSON.parse(f) as unknown)).toEqual([
        {
          criterion: "capped at five attempts",
          severity: "blocking",
          note: "nothing caps the attempts",
          author: "reviewer",
        },
      ]);
      expect((await criteriaRecords(repo.dir, id)).map((r) => [r.result, r.attempt])).toEqual([
        ["violation", 1],
        ["pass", 2],
      ]);
      expect((await latestStamp(repo.dir, id))!.gates["criteria-evidence"]).toBe("pass");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a verdict that answers every criterion as met, with evidence, closes", async () => {
    const t = setUp("cepass", [BOTH_MET]);
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(t.repo.showIssue(t.id).status).toBe("closed");
      expect(metadataOf(t.repo, t.id)[WORKGRAPH_LAST_VERDICT_KEY]).toBe(
        "pass blocking=0 advisory=0 criteria=2/2",
      );
      expect(reviewsOf(t.fake)).toHaveLength(1);
      expect((await criteriaRecords(t.repo.dir, t.id)).map((r) => [r.mode, r.result, r.blocked, r.reason])).toEqual([
        ["enforce", "pass", false, undefined],
      ]);
      const stamp = await latestStamp(t.repo.dir, t.id);
      expect(stamp!.gates).toEqual({
        "tree-binding": "pass",
        check: "pass",
        "criteria-evidence": "pass",
        review: "pass",
      });
      expect(stamp!.verdict!.summary).toBe("pass blocking=0 advisory=0 criteria=2/2");
      // The answers a close rests on are on the verdict record.
      const [verdict] = await payloads(t.repo.dir, t.id, VERDICT_MARKER);
      expect(verdict!.criteria).toEqual([C1, C2]);
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("an unanswered verdict followed by an answered one closes after one retry", async () => {
    const t = setUp("ceretry", [EMPTY, BOTH_MET]);
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(t.repo.showIssue(t.id).status).toBe("closed");
      const reviews = reviewsOf(t.fake);
      expect(reviews).toHaveLength(2);
      expect(reviews[1]!.feedback).toContain("C1, C2");
      expect((await criteriaRecords(t.repo.dir, t.id)).map((r) => [r.result, r.blocked])).toEqual([
        ["unknown", true],
        ["pass", false],
      ]);
      // A retry is not a revision: the attempt did not move.
      expect((await latestStamp(t.repo.dir, t.id))!.attempt).toBe(1);
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("an issue with no criteria and a clean verdict still closes: the gate does not apply", async () => {
    const t = setUp("cenone", [EMPTY], { criteria: null });
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(t.repo.showIssue(t.id).status).toBe("closed");
      expect(reviewsOf(t.fake)[0]!.criteria).toEqual([]);
      expect((await criteriaRecords(t.repo.dir, t.id)).map((r) => [r.result, r.blocked, r.reason])).toEqual([
        ["not-applicable", false, "no acceptance criteria"],
      ]);
      expect((await latestStamp(t.repo.dir, t.id))!.gates["criteria-evidence"]).toBe(
        "not-applicable",
      );
      // No criteria, no count: the summary reads as it always did.
      expect(metadataOf(t.repo, t.id)[WORKGRAPH_LAST_VERDICT_KEY]).toBe(
        "pass blocking=0 advisory=0",
      );
    } finally {
      await t.cleanup();
    }
  }, 60_000);
});

describe("the criteria-evidence gate, other modes", () => {
  it("observe: the empty verdict closes, with one would-block record", async () => {
    const t = setUp("ceobs", [EMPTY], {
      policy: { medium: { gates: { "criteria-evidence": "observe" } } },
    });
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(t.repo.showIssue(t.id).status).toBe("closed");
      expect(reviewsOf(t.fake)).toHaveLength(1);
      expect((await criteriaRecords(t.repo.dir, t.id)).map((r) => [r.mode, r.result, r.blocked, r.wouldBlock])).toEqual([
        ["observe", "unknown", false, true],
      ]);
      expect((await latestStamp(t.repo.dir, t.id))!.gates["criteria-evidence"]).toBe("unknown");
      // What was not answered still shows where a human reads the verdict.
      expect(metadataOf(t.repo, t.id)[WORKGRAPH_LAST_VERDICT_KEY]).toBe(
        "pass blocking=0 advisory=0 criteria=0/2",
      );
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("observe: an unmet criterion is recorded and does not become a finding", async () => {
    const t = setUp("ceobsun", [C2_UNMET], {
      policy: { medium: { gates: { "criteria-evidence": "observe" } } },
    });
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(t.repo.showIssue(t.id).status).toBe("closed");
      expect((await criteriaRecords(t.repo.dir, t.id)).map((r) => [r.result, r.blocked, r.wouldBlock])).toEqual([
        ["violation", false, true],
      ]);
      expect(metadataOf(t.repo, t.id)[WORKGRAPH_LAST_VERDICT_KEY]).toBe(
        "pass blocking=0 advisory=0 criteria=1/2",
      );
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("off: the reviewer is not asked for answers and nothing is counted or recorded", async () => {
    const t = setUp("ceoff", [EMPTY], {
      policy: { medium: { gates: { "criteria-evidence": "off" } } },
    });
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(t.repo.showIssue(t.id).status).toBe("closed");
      const review = reviewsOf(t.fake)[0]!;
      expect(review).not.toHaveProperty("criteria");
      expect(await criteriaRecords(t.repo.dir, t.id)).toEqual([]);
      expect((await latestStamp(t.repo.dir, t.id))!.gates).not.toHaveProperty("criteria-evidence");
      expect(metadataOf(t.repo, t.id)[WORKGRAPH_LAST_VERDICT_KEY]).toBe(
        "pass blocking=0 advisory=0",
      );
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("an unmet criterion blocks even when the review gate only observes", async () => {
    const t = setUp("cecross", [C2_UNMET], {
      policy: { medium: { gates: { review: "observe" } } },
    });
    captureErrors(); // parks in revising: no revision role is offered
    try {
      await drive(t.mock, t.ectx.ctx);

      // Either gate blocks. Entering the revise path on the review gate
      // alone would have recorded the criterion as blocked and then closed.
      expect(t.repo.showIssue(t.id).status).toBe("in_progress");
      expect(metadataOf(t.repo, t.id)[WORKGRAPH_PHASE_KEY]).toBe("revising");
    } finally {
      await t.cleanup();
    }
  }, 60_000);
});
