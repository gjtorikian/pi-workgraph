/**
 * A reviewer's blocking finding is checked before it counts
 * (proof-of-success phase 4).
 *
 *  - `checkCitations`: the finding must cite a file and line that exist in
 *    the reviewed tree, or it is downgraded to advisory.
 *  - `applyRecheck`: the reviewer's second look can keep a blocker or take
 *    it away, never add one.
 *  - Both in the judgment loop, on the shipped defaults and a git-backed
 *    scratch: keep, downgrade, every way a recheck can fail (the blocker
 *    stands), and a finding the core wrote itself (never asked about).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerCoordinator,
  type CoordinatorController,
  type CoordinatorDeps,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import { listGateRecords } from "../src/proof.ts";
import { fileAt, pathInTree, treeOf } from "../src/snapshot.ts";
import { listComments } from "../src/store.ts";
import {
  BlockerRecheck,
  WORKGRAPH_LAST_VERDICT_KEY,
  WORKGRAPH_PHASE_KEY,
  type FindingT,
  type VerdictT,
} from "../src/types.ts";
import {
  applyRecheck,
  canonicalFindings,
  checkCitations,
  CITATION_DOWNGRADE_NOTE,
  citationOf,
  failureFingerprint,
  MAX_EVIDENCE_CHARS,
  parseRecheck,
  recheckBlockers,
  RECHECK_MARKER,
  VERDICT_MARKER,
} from "../src/verdict.ts";
import { shippedConfig } from "./helpers/config.ts";
import {
  installFakeExecutor,
  type RoleScript,
} from "./helpers/fake-executor.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  type MockPi,
} from "./helpers/mock-pi.ts";
import {
  failCommentWrites,
  makeScratchRepo,
  type ScratchGraph,
  type ScratchRepo,
} from "./helpers/scratch.ts";

/** The known ten-line file: `line 1` to `line 10`, newline-terminated. */
const TEN_LINES =
  Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function blocker(criterion: string, extra: Partial<FindingT> = {}): FindingT {
  return { criterion, severity: "blocking", note: "does not hold", ...extra };
}

/** A reader over a fixed set of files, as `checkCitations` takes one. */
function reader(files: Record<string, string>) {
  return (path: string): string | undefined => files[path];
}

// ---------------------------------------------------------------------------
// citations
// ---------------------------------------------------------------------------

describe("citationOf", () => {
  it("takes the explicit citation, and does not look past it", () => {
    expect(
      citationOf(blocker("x", { citation: { path: "a.ts", line: 3 }, evidence: "b.ts:9" })),
    ).toEqual({ path: "a.ts", line: 3 });
  });

  it("falls back to the first path:line in the evidence", () => {
    expect(citationOf(blocker("x", { evidence: "see src/retry.ts:12 and src/cap.ts:3" }))).toEqual({
      path: "src/retry.ts",
      line: 12,
    });
    expect(citationOf(blocker("x", { evidence: "the loop (src/retry.ts:12) never backs off" }))).toEqual({
      path: "src/retry.ts",
      line: 12,
    });
    // The line, not the column.
    expect(citationOf(blocker("x", { evidence: "file.ts:12:5 is wrong" }))).toEqual({
      path: "file.ts",
      line: 12,
    });
  });

  it("does not read a port, a time or line 0 as a citation", () => {
    expect(citationOf(blocker("x", { evidence: "curl http://host:8080 hangs" }))).toBeUndefined();
    expect(citationOf(blocker("x", { evidence: "failed at 12:30 today" }))).toBeUndefined();
    expect(citationOf(blocker("x", { evidence: "a.ts:0 has no such line" }))).toBeUndefined();
    expect(citationOf(blocker("x"))).toBeUndefined();
    // ... and keeps looking past one.
    expect(citationOf(blocker("x", { evidence: "at 12:30, http://host:8080 and then src/a.ts:7" }))).toEqual({
      path: "src/a.ts",
      line: 7,
    });
  });
});

describe("checkCitations", () => {
  const read = reader({ "ten.txt": TEN_LINES, "empty.txt": "", "bare.txt": "one\ntwo" });
  const check = (finding: FindingT) =>
    checkCitations({ findings: [finding] }, "tree", read).findings[0]!;

  it("a blocker citing a line that exists stands, untouched", () => {
    const finding = blocker("x", { citation: { path: "ten.txt", line: 3 } });
    expect(check(finding)).toBe(finding);
    // The last line of a newline-terminated file, and of one that is not.
    expect(check(blocker("x", { citation: { path: "ten.txt", line: 10 } })).severity).toBe("blocking");
    expect(check(blocker("x", { citation: { path: "bare.txt", line: 2 } })).severity).toBe("blocking");
  });

  it("a blocker citing a line past the end of the file is downgraded, and kept", () => {
    // Ten lines and a trailing newline are ten lines, not eleven.
    expect(check(blocker("x", { citation: { path: "ten.txt", line: 11 } }))).toEqual({
      criterion: "x",
      severity: "advisory",
      note: `does not hold ${CITATION_DOWNGRADE_NOTE}`,
      citation: { path: "ten.txt", line: 11 },
    });
    expect(check(blocker("x", { citation: { path: "bare.txt", line: 3 } })).severity).toBe("advisory");
    // An empty file has no line 1.
    expect(check(blocker("x", { citation: { path: "empty.txt", line: 1 } })).severity).toBe("advisory");
  });

  it("a blocker citing a file that does not exist, or nothing, is downgraded", () => {
    expect(check(blocker("x", { citation: { path: "gone.txt", line: 1 } })).severity).toBe("advisory");
    const uncited = check({ criterion: "x", severity: "blocking" });
    expect(uncited).toEqual({
      criterion: "x",
      severity: "advisory",
      note: CITATION_DOWNGRADE_NOTE,
    });
  });

  it("a path:line embedded in the evidence resolves like a citation", () => {
    expect(check(blocker("x", { evidence: "ten.txt:3 swallows the error" })).severity).toBe("blocking");
    expect(check(blocker("x", { evidence: "ten.txt:11 swallows the error" })).severity).toBe("advisory");
  });

  it("never touches a finding the core wrote, or an advisory one", () => {
    const code: FindingT = { criterion: "check", severity: "blocking", author: "code", note: "exited 1" };
    const advisory: FindingT = { criterion: "style", severity: "advisory" };
    const verdict: VerdictT = { findings: [code, advisory] };
    // Nothing changed, so the same verdict comes back.
    expect(checkCitations(verdict, "tree", read)).toBe(verdict);
  });

  it("with no tree the check is skipped and every blocker stands", () => {
    const verdict: VerdictT = { findings: [blocker("x"), blocker("y", { citation: { path: "gone.txt", line: 9 } })] };
    expect(checkCitations(verdict, undefined, () => undefined)).toBe(verdict);
  });

  it("reads a cited file once, however many findings cite it", () => {
    const reads: string[] = [];
    const checked = checkCitations(
      {
        findings: [
          blocker("a", { citation: { path: "ten.txt", line: 1 } }),
          blocker("b", { citation: { path: "ten.txt", line: 2 } }),
          blocker("c", { citation: { path: "gone.txt", line: 1 } }),
          blocker("d", { citation: { path: "gone.txt", line: 2 } }),
        ],
      },
      "tree",
      (path) => {
        reads.push(path);
        return path === "ten.txt" ? TEN_LINES : undefined;
      },
    );
    expect(reads).toEqual(["ten.txt", "gone.txt"]);
    expect(checked.findings.map((f) => f.severity)).toEqual([
      "blocking",
      "blocking",
      "advisory",
      "advisory",
    ]);
  });

  it("a long note is cut to make room for the reason, never the reason", () => {
    const downgraded = check(blocker("x", { note: "n".repeat(1000) }));
    expect(downgraded.note!.endsWith(CITATION_DOWNGRADE_NOTE)).toBe(true);
    expect(downgraded.note!.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    // So the record's own cap leaves it alone.
    expect(canonicalFindings([downgraded])[0]!.note).toBe(downgraded.note);
  });

  it("against a real tree: a directory is not a file, and a cited path is read from the tree's root", () => {
    const repo = makeScratchRepo({ prefix: "brtree" });
    try {
      writeFileSync(join(repo.dir, "ten.txt"), TEN_LINES);
      mkdirSync(join(repo.dir, "src"));
      writeFileSync(join(repo.dir, "src", "a.ts"), "export {};\n");
      const tree = treeOf(repo.dir);
      // The reader the coordinator builds: normalize, then read the blob.
      const read = (cited: string) => {
        const file = pathInTree(repo.dir, cited);
        return file !== undefined ? fileAt(repo.dir, tree, file) : undefined;
      };
      const severityOf = (path: string, line: number) =>
        checkCitations({ findings: [blocker("x", { citation: { path, line } })] }, tree, read)
          .findings[0]!.severity;

      expect(severityOf("ten.txt", 3)).toBe("blocking");
      expect(severityOf("ten.txt", 11)).toBe("advisory");
      expect(severityOf("missing.txt", 1)).toBe("advisory");
      // However the reviewer spelled the path.
      expect(severityOf("./ten.txt", 10)).toBe("blocking");
      expect(severityOf("src/../ten.txt", 1)).toBe("blocking");
      expect(severityOf(join(repo.dir, "src", "a.ts"), 1)).toBe("blocking");
      // A directory would "resolve" if its listing were read as content.
      expect(severityOf("src", 1)).toBe("advisory");
      // Outside the workspace is not in the tree.
      expect(severityOf("../ten.txt", 1)).toBe("advisory");
      expect(severityOf("/etc/hosts", 1)).toBe("advisory");
      expect(pathInTree(repo.dir, repo.dir)).toBeUndefined();
      expect(pathInTree(repo.dir, "  ")).toBeUndefined();
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// the recheck's answers
// ---------------------------------------------------------------------------

describe("applyRecheck", () => {
  const code: FindingT = { criterion: "check", severity: "blocking", author: "code", note: "exited 1" };
  const advisory: FindingT = { criterion: "style", severity: "advisory" };
  const first = blocker("first", { citation: { path: "ten.txt", line: 3 } });
  const second = blocker("second", { evidence: "ten.txt:4 leaks" });
  // The reviewer's two blockers are numbered 1 and 2, in the verdict's order,
  // whatever sits between them.
  const verdict: VerdictT = { findings: [code, first, advisory, second] };

  it("numbers the reviewer's blockers only, with what a fresh run needs to judge them", () => {
    expect(recheckBlockers(verdict)).toEqual([
      { n: 1, criterion: "first", note: "does not hold", citation: { path: "ten.txt", line: 3 } },
      { n: 2, criterion: "second", note: "does not hold", citation: { path: "ten.txt", line: 4 } },
    ]);
    expect(recheckBlockers({ findings: [code, advisory] })).toEqual([]);
  });

  it("downgrade turns blocker n into advisory with the reason; keep leaves it", () => {
    const applied = applyRecheck(verdict, [
      { n: 1, decision: "keep", reason: "line 3 still throws" },
      { n: 2, decision: "downgrade", reason: "the handle is closed two lines later" },
    ]);
    expect(applied.findings).toEqual([
      code,
      first,
      advisory,
      {
        ...second,
        severity: "advisory",
        note: "does not hold [Not a blocker on a second look: the handle is closed two lines later]",
      },
    ]);
  });

  it("can only take a blocker away: no answer, an unknown n and a repeated keep all leave it standing", () => {
    // No answers at all.
    expect(applyRecheck(verdict, [])).toBe(verdict);
    // An n that names no blocker.
    expect(applyRecheck(verdict, [{ n: 3, decision: "downgrade", reason: "?" }])).toBe(verdict);
    // Only n=2 answered: n=1 stands.
    const partial = applyRecheck(verdict, [{ n: 2, decision: "downgrade", reason: "fine" }]);
    expect(partial.findings.map((f) => f.severity)).toEqual(["blocking", "blocking", "advisory", "advisory"]);
    // Two answers for one n: keep wins, in either order.
    for (const answers of [
      [
        { n: 1, decision: "downgrade", reason: "a" },
        { n: 1, decision: "keep", reason: "b" },
      ],
      [
        { n: 1, decision: "keep", reason: "b" },
        { n: 1, decision: "downgrade", reason: "a" },
      ],
    ] as const) {
      expect(applyRecheck(verdict, [...answers])).toBe(verdict);
    }
    // A finding the core wrote is never numbered, so never downgraded.
    expect(
      applyRecheck({ findings: [code] }, [{ n: 1, decision: "downgrade", reason: "no" }]).findings,
    ).toEqual([code]);
  });

  it("validates the answer's shape", () => {
    const ok = { answers: [{ n: 1, decision: "keep", reason: "line 3" }] };
    expect(parseRecheck(ok)).toEqual(ok);
    expect(parseRecheck({ answers: [] })).toEqual({ answers: [] });
    for (const bad of [
      undefined,
      "keep",
      { findings: [] },
      { answers: [{ n: 0, decision: "keep", reason: "" }] },
      { answers: [{ n: 1.5, decision: "keep", reason: "" }] },
      { answers: [{ n: 1, decision: "maybe", reason: "" }] },
      { answers: [{ n: 1, decision: "keep" }] },
      { answers: [{ decision: "downgrade", reason: "no number" }] },
    ]) {
      expect(() => parseRecheck(bad)).toThrow(/Invalid recheck payload/);
    }
  });
});

describe("findings in records and fingerprints", () => {
  it("a canonical finding keeps its citation and its author", () => {
    expect(
      canonicalFindings([
        { criterion: "b", severity: "blocking", citation: { path: "ten.txt", line: 3 } },
        { criterion: "a", severity: "blocking", author: "code" },
      ]),
    ).toEqual([
      { criterion: "a", severity: "blocking", author: "code" },
      { criterion: "b", severity: "blocking", citation: { path: "ten.txt", line: 3 } },
    ]);
  });

  it("the failure fingerprint ignores the citation: the same complaint is a repeat on any line", () => {
    const at = (line: number) => [blocker("x", { citation: { path: "ten.txt", line } })];
    expect(failureFingerprint(at(3), "tree")).toBe(failureFingerprint(at(4), "tree"));
    expect(failureFingerprint(at(3), "tree")).toBe(failureFingerprint([blocker("x")], "tree"));
  });
});

// ---------------------------------------------------------------------------
// in the judgment loop
// ---------------------------------------------------------------------------

const WORKER = "blocker-recheck-worker";

/** Distinct author/reviewer provenance — independent under every policy. */
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };

const CLEAN: VerdictT = { findings: [] };
/** One blocker whose citation resolves in the result tree. */
const ONE_BLOCKER: VerdictT = {
  findings: [blocker("criterion-x", { citation: { path: "ten.txt", line: 3 } })],
};
const KEEP = { answers: [{ n: 1, decision: "keep", reason: "line 3 still does it" }] };
const DOWNGRADE = {
  answers: [{ n: 1, decision: "downgrade", reason: "line 4 handles it" }],
};

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
}

/** A coordinator on the shipped defaults. */
function makeHarness(deps: Partial<CoordinatorDeps> = {}): Harness {
  const mock = makeMockPi();
  setWorkerIdOverride(WORKER);
  const config = shippedConfig({ workerIdOverride: WORKER });
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
    ...deps,
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

/** Approve a medium-risk issue; `check` is the command the core runs first. */
function approve(graph: ScratchGraph, id: string, check = "true"): void {
  graph.op([
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=ready",
    "--set-metadata",
    `workgraph_check=${check}`,
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

const audits = (dir: string, id: string, kind: string) =>
  payloads(dir, id, `workgraph-lease ${kind} `);

async function reviewRecords(dir: string, id: string) {
  return (await listGateRecords(dir, id)).filter((r) => r.gate === "review");
}

/** What an isolated fake reports: its work is in the repository, cut from HEAD. */
function isolatedIn(repo: ScratchRepo) {
  return { path: repo.dir, baseRevision: repo.head };
}

/** A recorded request with the tolerated extra field a recheck carries. */
type Recorded = {
  role: string;
  outputSchema?: unknown;
  workspace: unknown;
  recheck?: { blockers: unknown[] };
};

/** `review`, `recheck`, or the role itself: the order of what was requested. */
function sequence(fake: { requests: unknown[] }): string[] {
  return (fake.requests as Recorded[]).map((r) =>
    r.role !== "reviewer" ? r.role : r.recheck !== undefined ? "recheck" : "review",
  );
}

/** Silence console.error and return the lines it was given. */
function captureErrors(): () => string[] {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.join(" "));
}

/**
 * One medium-risk issue; an implementer that leaves the ten-line file in the
 * result tree; a reviewer that answers `reviewer` in request order (a
 * recheck is a reviewer request, so it takes the next entry); a revisor
 * unless `revision` is false.
 */
function setUp(
  prefix: string,
  reviewer: RoleScript[],
  opts: {
    revision?: RoleScript | false;
    check?: string;
    deps?: Partial<CoordinatorDeps>;
    before?: (repo: ScratchRepo) => void;
  } = {},
) {
  const repo = makeScratchRepo({ prefix, seed: 1 });
  const id = repo.seededIds[0]!;
  approve(repo, id, opts.check);
  opts.before?.(repo);
  const { mock, coordinator } = makeHarness(opts.deps);
  const fake = installFakeExecutor(mock.events, {
    roles: [
      "implementer",
      "reviewer",
      ...(opts.revision === false ? [] : (["revision"] as const)),
    ],
    workspace: isolatedIn(repo),
    supportsCancellation: true,
    roleScripts: {
      implementer: {
        provenance: IMPL_PROV,
        artifacts: ["ten.txt"],
        onRequest: () => writeFileSync(join(repo.dir, "ten.txt"), TEN_LINES),
      },
      reviewer: reviewer.map((script) => ({ provenance: REV_PROV, ...script })),
      ...(opts.revision === false
        ? {}
        : { revision: { provenance: IMPL_PROV, ...opts.revision } }),
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

describe("the citation check in the judgment loop", () => {
  it.each([
    ["a line past the end of an existing file", { path: "ten.txt", line: 11 }],
    ["a file the reviewed tree does not have", { path: "nowhere.txt", line: 1 }],
  ])(
    "a blocker that cites %s drops to advisory: no recheck, no revision, and the trail says why",
    async (_what, citation) => {
      const t = setUp("brcite", [
        { verdict: { findings: [blocker("criterion-x", { citation })] } },
      ]);
      try {
        await drive(t.mock, t.ectx.ctx);

        expect(t.repo.showIssue(t.id).status).toBe("closed");
        // No blocker survived, so the reviewer was not asked again, and
        // nothing was sent back for a revision.
        expect(sequence(t.fake)).toEqual(["implementer", "review"]);
        expect(await audits(t.repo.dir, t.id, "revision-requested")).toEqual([]);
        expect(metadataOf(t.repo, t.id)[WORKGRAPH_LAST_VERDICT_KEY]).toBe(
          "pass blocking=0 advisory=1: criterion-x",
        );
        expect((await reviewRecords(t.repo.dir, t.id)).map((r) => [r.result, r.blocked])).toEqual([
          ["pass", false],
        ]);

        // The first comment is the reviewer's reply as it came ...
        const [verdict] = await payloads(t.repo.dir, t.id, VERDICT_MARKER);
        expect(verdict!.summary).toBe("reject blocking=1 advisory=0: criterion-x");
        // ... and the second says what the check made of it.
        const [recheck] = await payloads(t.repo.dir, t.id, RECHECK_MARKER);
        expect(recheck).toMatchObject({
          executionId: verdict!.executionId,
          tree: verdict!.tree,
          citationDowngrades: 1,
          summary: "pass blocking=0 advisory=1: criterion-x",
          findings: [
            {
              criterion: "criterion-x",
              severity: "advisory",
              note: `does not hold ${CITATION_DOWNGRADE_NOTE}`,
              citation,
            },
          ],
        });
        expect(recheck).not.toHaveProperty("recheck");
      } finally {
        await t.cleanup();
      }
    },
    60_000,
  );

  it("of five blockers, only the two whose citation resolves are sent to the recheck and block", async () => {
    const t = setUp(
      "brfive",
      [
        {
          verdict: {
            findings: [
              blocker("at-line-3", { citation: { path: "ten.txt", line: 3 } }),
              blocker("at-line-11", { citation: { path: "ten.txt", line: 11 } }),
              blocker("in-a-missing-file", { citation: { path: "nowhere.txt", line: 1 } }),
              blocker("with-no-citation"),
              blocker("in-the-evidence", { evidence: "ten.txt:7 is where it goes wrong" }),
            ],
          },
        },
        {
          recheck: {
            answers: [
              { n: 1, decision: "keep", reason: "line 3" },
              { n: 2, decision: "keep", reason: "line 7" },
            ],
          },
        },
      ],
      { revision: false },
    );
    captureErrors(); // parks in revising: no revision role is offered
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(metadataOf(t.repo, t.id)[WORKGRAPH_PHASE_KEY]).toBe("revising");
      expect(metadataOf(t.repo, t.id)[WORKGRAPH_LAST_VERDICT_KEY]).toBe(
        "reject blocking=2 advisory=3: at-line-3",
      );
      const recheck = (t.fake.requests as Recorded[]).find((r) => r.recheck !== undefined)!;
      expect(recheck.recheck!.blockers).toEqual([
        { n: 1, criterion: "at-line-3", note: "does not hold", citation: { path: "ten.txt", line: 3 } },
        { n: 2, criterion: "in-the-evidence", note: "does not hold", citation: { path: "ten.txt", line: 7 } },
      ]);
      const [record] = await payloads(t.repo.dir, t.id, RECHECK_MARKER);
      expect(record).toMatchObject({
        citationDowngrades: 3,
        recheck: { outcome: "answers", blockers: 2 },
      });
    } finally {
      await t.cleanup();
    }
  }, 60_000);
});

describe("the blocker recheck in the judgment loop", () => {
  it("keep: the blocker stands and the issue goes to revising, after a review and then a recheck", async () => {
    const t = setUp("brkeep", [{ verdict: ONE_BLOCKER }, { recheck: KEEP }, { verdict: CLEAN }]);
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(sequence(t.fake)).toEqual(["implementer", "review", "recheck", "revision", "review"]);
      expect(await audits(t.repo.dir, t.id, "revision-requested")).toHaveLength(1);
      expect((await reviewRecords(t.repo.dir, t.id)).map((r) => [r.result, r.blocked, r.attempt])).toEqual([
        ["violation", true, 1],
        ["pass", false, 2],
      ]);
      expect(t.repo.showIssue(t.id).status).toBe("closed");

      // The recheck went to the reviewer that produced the verdict, with the
      // numbered blocker, the recheck schema, and the review's workspace and
      // trees.
      const [review, recheck] = (t.fake.requests as Recorded[]).filter((r) => r.role === "reviewer");
      expect(recheck!.recheck).toEqual({
        blockers: [
          { n: 1, criterion: "criterion-x", note: "does not hold", citation: { path: "ten.txt", line: 3 } },
        ],
      });
      expect(recheck!.outputSchema).toEqual(BlockerRecheck);
      expect(recheck!.workspace).toEqual(review!.workspace);

      // Two comments for the round: the first reply, then the recheck.
      const [verdict] = await payloads(t.repo.dir, t.id, VERDICT_MARKER);
      const rechecks = await payloads(t.repo.dir, t.id, RECHECK_MARKER);
      expect(rechecks).toHaveLength(1);
      expect(rechecks[0]).toMatchObject({
        executionId: verdict!.executionId,
        citationDowngrades: 0,
        summary: "reject blocking=1 advisory=0: criterion-x",
        recheck: {
          outcome: "answers",
          blockers: 1,
          executionId: t.fake.completions[2]!.executionId,
          answers: KEEP.answers,
        },
      });
      expect(await audits(t.repo.dir, t.id, "recheck-failed")).toEqual([]);
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("downgrade of the only blocker: no revision, and the issue proceeds to close", async () => {
    const t = setUp("brdown", [{ verdict: ONE_BLOCKER }, { recheck: DOWNGRADE }]);
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(sequence(t.fake)).toEqual(["implementer", "review", "recheck"]);
      expect(t.repo.showIssue(t.id).status).toBe("closed");
      expect(await audits(t.repo.dir, t.id, "revision-requested")).toEqual([]);
      expect(metadataOf(t.repo, t.id)[WORKGRAPH_LAST_VERDICT_KEY]).toBe(
        "pass blocking=0 advisory=1: criterion-x",
      );
      // The review gate is computed from the blockers that remain.
      expect((await reviewRecords(t.repo.dir, t.id)).map((r) => [r.result, r.blocked])).toEqual([
        ["pass", false],
      ]);
      const [recheck] = await payloads(t.repo.dir, t.id, RECHECK_MARKER);
      expect(recheck).toMatchObject({
        recheck: { outcome: "answers", answers: DOWNGRADE.answers },
        findings: [
          {
            criterion: "criterion-x",
            severity: "advisory",
            note: "does not hold [Not a blocker on a second look: line 4 handles it]",
          },
        ],
      });
      expect(heldLeases(t.repo.dir)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("one kept and one downgraded: one revision, whose prior findings hold only the kept blocker as blocking", async () => {
    const t = setUp("brmix", [
      {
        verdict: {
          findings: [
            blocker("kept", { citation: { path: "ten.txt", line: 3 } }),
            blocker("dropped", { citation: { path: "ten.txt", line: 4 } }),
          ],
        },
      },
      {
        recheck: {
          answers: [
            { n: 1, decision: "keep", reason: "line 3 still does it" },
            { n: 2, decision: "downgrade", reason: "line 5 handles it" },
          ],
        },
      },
      { verdict: CLEAN },
    ]);
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(t.repo.showIssue(t.id).status).toBe("closed");
      const revisions = t.fake.requests.filter((r) => r.role === "revision");
      expect(revisions).toHaveLength(1);
      const prior = revisions[0]!.priorFindings!.map((f) => JSON.parse(f) as FindingT);
      expect(prior.map((f) => [f.criterion, f.severity])).toEqual([
        ["dropped", "advisory"],
        ["kept", "blocking"],
      ]);
      expect(prior[0]!.note).toContain("[Not a blocker on a second look: line 5 handles it]");
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("a recheck request that is never accepted times out: the blocker stands and the revision starts", async () => {
    const t = setUp("brtime", [{ verdict: ONE_BLOCKER }, { behavior: "silent" }, { verdict: CLEAN }]);
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(sequence(t.fake)).toEqual(["implementer", "review", "recheck", "revision", "review"]);
      expect(await audits(t.repo.dir, t.id, "revision-requested")).toHaveLength(1);
      const failed = await audits(t.repo.dir, t.id, "recheck-failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        executorId: "fake-executor",
        reason: "reviewer did not accept the recheck in time",
        blockers: 1,
      });
      // The recheck was canceled, not waited on, and the run was not dropped.
      expect(t.fake.cancels.map((c) => c.reason)).toEqual(["blocker recheck was not accepted in time"]);
      expect(t.repo.showIssue(t.id).status).toBe("closed");
      const [recheck] = await payloads(t.repo.dir, t.id, RECHECK_MARKER);
      expect(recheck).toMatchObject({
        summary: "reject blocking=1 advisory=0: criterion-x",
        recheck: { outcome: "failed", reason: "reviewer did not accept the recheck in time" },
      });
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  const UNUSABLE: Array<[string, RoleScript, RegExp | undefined]> = [
    ["answers that omit the blocker's number", { recheck: { answers: [] } }, undefined],
    [
      "answers for a number that names no blocker",
      { recheck: { answers: [{ n: 2, decision: "downgrade", reason: "not it" }] } },
      undefined,
    ],
    ["a verdict where a recheck was asked for", { verdict: CLEAN }, /^invalid recheck: /],
    [
      "an answer that is not the recheck's shape",
      { recheck: { answers: [{ n: 1, decision: "drop", reason: "?" }] } },
      /^invalid recheck: /,
    ],
    ["a rejected request", { behavior: "reject", rejectReason: "at-capacity" }, /^reviewer rejected the recheck: at-capacity$/],
    ["a failed completion", { outcome: "failure", evidence: ["ran out of budget"] }, /^reviewer execution failed \(failure\)/],
    [
      "a question instead of an answer",
      { outcome: "blocked", decisionQuestion: "Is line 3 in scope?" },
      /^reviewer asked a question instead of answering the recheck$/,
    ],
    [
      // The author's own model answering would be the author downgrading
      // the finding against it.
      "a downgrade from a run that is not independent of the author",
      { provenance: IMPL_PROV, recheck: DOWNGRADE },
      /^recheck was not independent: /,
    ],
  ];

  it.each(UNUSABLE)(
    "%s leaves the blocker standing",
    async (_what, answer, failure) => {
      const t = setUp("brsafe", [{ verdict: ONE_BLOCKER }, answer], { revision: false });
      captureErrors(); // parks in revising: no revision role is offered
      try {
        await drive(t.mock, t.ectx.ctx);

        expect(sequence(t.fake)).toEqual(["implementer", "review", "recheck"]);
        expect(t.repo.showIssue(t.id).status).toBe("in_progress");
        const metadata = metadataOf(t.repo, t.id);
        expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("revising");
        expect(metadata[WORKGRAPH_LAST_VERDICT_KEY]).toBe("reject blocking=1 advisory=0: criterion-x");
        expect((await reviewRecords(t.repo.dir, t.id)).map((r) => [r.result, r.blocked])).toEqual([
          ["violation", true],
        ]);
        const failed = await audits(t.repo.dir, t.id, "recheck-failed");
        if (failure === undefined) {
          // A well-formed answer that simply does not name the blocker.
          expect(failed).toEqual([]);
        } else {
          expect(failed).toHaveLength(1);
          expect(String(failed[0]!.reason)).toMatch(failure);
        }
        // Never a decision request and never an escalation: a recheck that
        // cannot be had costs the author one second look, not the run.
        expect(metadata.workgraph_decision_pending).toBeUndefined();
        expect(await audits(t.repo.dir, t.id, "escalated")).toEqual([]);
      } finally {
        await t.cleanup();
      }
    },
    60_000,
  );

  it("an accepted recheck that does not finish inside the bound is canceled, and the blocker stands", async () => {
    const t = setUp("brstall", [{ verdict: ONE_BLOCKER }, { behavior: "accept-stall" }], {
      revision: false,
      deps: { recheckWaitMs: 60 },
    });
    captureErrors();
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(metadataOf(t.repo, t.id)[WORKGRAPH_PHASE_KEY]).toBe("revising");
      const failed = await audits(t.repo.dir, t.id, "recheck-failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.reason).toBe("no recheck answer within 0.06 s");
      expect(t.fake.cancels.map((c) => c.reason)).toEqual(["blocker recheck timed out"]);
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("a workspace that changed during the recheck discards the verdict: the new tree is reviewed", async () => {
    const t = setUp("brmoved", [
      { verdict: ONE_BLOCKER },
      {
        recheck: DOWNGRADE,
        // A recheck is told not to modify any file. This one does.
        onRequest: (request) => writeFileSync(join(request.workspace.path!, "stray.txt"), "left behind\n"),
      },
      { verdict: CLEAN },
    ]);
    try {
      await drive(t.mock, t.ectx.ctx);

      // The downgrade was never applied: the round was thrown away whole.
      expect(sequence(t.fake)).toEqual(["implementer", "review", "recheck", "review"]);
      const rejected = await audits(t.repo.dir, t.id, "review-rejected");
      expect(rejected.map((r) => r.reason)).toEqual(["workspace changed during the blocker recheck"]);
      expect(await payloads(t.repo.dir, t.id, RECHECK_MARKER)).toEqual([]);
      expect(await reviewRecords(t.repo.dir, t.id)).toHaveLength(1);
      // The second review judged the tree that holds the stray file.
      const verdicts = await payloads(t.repo.dir, t.id, VERDICT_MARKER);
      expect(verdicts).toHaveLength(2);
      expect(verdicts[1]!.tree).not.toBe(verdicts[0]!.tree);
      expect(fileAt(t.repo.dir, String(verdicts[1]!.tree), "stray.txt")).toBe("left behind\n");
      expect(t.repo.showIssue(t.id).status).toBe("closed");
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("a blocker the core wrote is never rechecked: a failed check goes straight to revision", async () => {
    const t = setUp("brcode", [{ verdict: CLEAN }], {
      // Fails until the revision writes the file it tests for.
      check: "test -f fixed.txt",
      revision: {
        onRequest: (request) => writeFileSync(join(request.workspace.path!, "fixed.txt"), "fixed\n"),
      },
    });
    try {
      await drive(t.mock, t.ectx.ctx);

      // No reviewer request of any kind stands between the failed check and
      // the revision; the one review is of the revised tree.
      expect(sequence(t.fake)).toEqual(["implementer", "revision", "review"]);
      const revision = t.fake.requests.find((r) => r.role === "revision")!;
      expect(revision.priorFindings!.map((f) => JSON.parse(f) as FindingT)).toMatchObject([
        { criterion: "check", severity: "blocking", author: "code" },
      ]);
      expect(await payloads(t.repo.dir, t.id, RECHECK_MARKER)).toEqual([]);
      expect(await audits(t.repo.dir, t.id, "recheck-failed")).toEqual([]);
      expect(t.repo.showIssue(t.id).status).toBe("closed");
    } finally {
      await t.cleanup();
    }
  }, 60_000);
});

describe("the recheck record", () => {
  it("a downgrade that cannot be recorded escalates: the work does not close on it", async () => {
    const t = setUp("brdur", [{ verdict: ONE_BLOCKER }, { recheck: DOWNGRADE }], {
      before: (repo) => failCommentWrites(repo.dir, RECHECK_MARKER),
    });
    const errors = captureErrors();
    try {
      await drive(t.mock, t.ectx.ctx);

      expect(t.repo.showIssue(t.id).status).toBe("blocked");
      expect(metadataOf(t.repo, t.id)[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      const escalated = await audits(t.repo.dir, t.id, "escalated");
      expect(escalated).toHaveLength(1);
      expect(String(escalated[0]!.reason)).toMatch(/^recheck record could not be written: /);
      expect(errors().some((line) => line.includes("VERDICT WRITE FAILED"))).toBe(true);
      // The verdict record itself was written: only the second comment failed.
      expect(await payloads(t.repo.dir, t.id, VERDICT_MARKER)).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("with nothing taken away, a lost recheck record does not stop the revision", async () => {
    const t = setUp("brdurk", [{ verdict: ONE_BLOCKER }, { recheck: KEEP }], {
      revision: false,
      before: (repo) => failCommentWrites(repo.dir, RECHECK_MARKER),
    });
    captureErrors();
    try {
      await drive(t.mock, t.ectx.ctx);

      // The verdict record already says what stands.
      expect(metadataOf(t.repo, t.id)[WORKGRAPH_PHASE_KEY]).toBe("revising");
      expect(await audits(t.repo.dir, t.id, "escalated")).toEqual([]);
    } finally {
      await t.cleanup();
    }
  }, 60_000);
});
