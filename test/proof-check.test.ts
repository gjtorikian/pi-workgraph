/**
 * The core-run check (proof-of-success phase 3): the runner in
 * `src/check.ts` against real processes, and what the coordinator does with
 * it — one receipt per tree, written before any reviewer is asked; a failed
 * check sent down the revise path as a finding the core wrote itself; the
 * one-shot path; the re-check of a tree finalization produced.
 *
 * Everything here runs REAL shell commands (`exit 1`, `sleep 30`,
 * `kill -9 $$`) in a real git repository (`makeScratchRepo`) and on
 * `shippedConfig` with NO policy: "default config, medium risk" means the
 * defaults a user gets. No fake timers; a timeout case waits out a real,
 * short timeout.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  barDifferences,
  barDigest,
  buildBar,
  commandDigest,
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_LOG_BYTES,
  runCheck,
} from "../src/check.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import {
  MAX_CHECK_RETRIES,
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import type { PolicyOverrides } from "../src/policy.ts";
import { latestStamp, listGateRecords, listReceipts } from "../src/proof.ts";
import { fileAt } from "../src/snapshot.ts";
import { listComments } from "../src/store.ts";
import {
  WORKGRAPH_LAST_VERDICT_KEY,
  WORKGRAPH_PHASE_KEY,
  WORKGRAPH_RESULT_TREE_KEY,
  WORKGRAPH_WORKFLOW_CLASS_KEY,
  type FindingT,
  type PlanT,
  type VerdictT,
} from "../src/types.ts";
import { failureFingerprint, parseVerdict } from "../src/verdict.ts";
import { shippedConfig } from "./helpers/config.ts";
import { installFakeExecutor } from "./helpers/fake-executor.ts";
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

const HEX64 = /^[0-9a-f]{64}$/;

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLeasesForTest();
  resetIdentityForTest();
});

// ---------------------------------------------------------------------------
// the runner
// ---------------------------------------------------------------------------

describe("runCheck", () => {
  function scratch(): { dir: string; log: string; cleanup(): void } {
    const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-check-"));
    return {
      dir,
      log: join(dir, "logs", "1.log"),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("digests the command text", () => {
    expect(commandDigest("npm test")).toMatch(HEX64);
    expect(commandDigest("npm test")).toBe(commandDigest("npm test"));
    expect(commandDigest("npm test")).not.toBe(commandDigest("npm test "));
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(600_000);
  });

  it("passes a command that exits 0, and hashes the log it wrote", async () => {
    const s = scratch();
    try {
      const run = await runCheck(
        { command: "echo out; echo err 1>&2; exit 0", timeoutMs: 10_000 },
        s.dir,
        s.log,
      );
      expect(run).toMatchObject({
        commandDigest: commandDigest("echo out; echo err 1>&2; exit 0"),
        exitCode: 0,
        timedOut: false,
        passed: true,
      });
      expect(run.reason).toBeUndefined();
      expect(run.signal).toBeUndefined();
      expect(Date.parse(run.endedAt)).toBeGreaterThanOrEqual(
        Date.parse(run.startedAt),
      );
      const text = readFileSync(s.log, "utf8");
      expect(text).toContain("out\n");
      expect(text).toContain("err\n");
      expect(run.log.path).toBe(s.log);
      expect(run.log.bytes).toBe(statSync(s.log).size);
      expect(run.log.sha256).toBe(sha256File(s.log));
      expect(run.log.tail).toContain("out");
    } finally {
      s.cleanup();
    }
  });

  it("fails a command that exits non-zero, with the exit code as the reason", async () => {
    const s = scratch();
    try {
      const run = await runCheck(
        { command: "echo nope; exit 3", timeoutMs: 10_000 },
        s.dir,
        s.log,
      );
      expect(run).toMatchObject({
        exitCode: 3,
        timedOut: false,
        passed: false,
        reason: "exited 3",
      });
      expect(run.log.tail).toBe("nope\n");
      expect(run.log.sha256).toBe(sha256File(s.log));
    } finally {
      s.cleanup();
    }
  });

  it("fails a command that outlives its timeout, and kills its whole process group", async () => {
    const s = scratch();
    try {
      const pidFile = join(s.dir, "child.pid");
      const started = Date.now();
      const run = await runCheck(
        // A child of the command, to prove the group is killed and not
        // only the shell.
        { command: `(sleep 30 & echo $! > ${pidFile}; wait)`, timeoutMs: 200 },
        s.dir,
        s.log,
      );
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(run).toMatchObject({
        timedOut: true,
        passed: false,
        reason: "timed out after 0.2s",
      });
      // Never "killed by SIGTERM": the timeout is the reason.
      expect(run.reason).not.toMatch(/killed/);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(0);
      // Give the kernel a moment to reap, then the child must be gone.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(run.log.sha256).toBe(sha256File(s.log));
    } finally {
      s.cleanup();
    }
  }, 30_000);

  it("fails a command killed by a signal: no exit code, never a pass", async () => {
    const s = scratch();
    try {
      const run = await runCheck(
        { command: "kill -9 $$", timeoutMs: 10_000 },
        s.dir,
        s.log,
      );
      expect(run.exitCode).toBeNull();
      expect(run).toMatchObject({
        signal: "SIGKILL",
        timedOut: false,
        passed: false,
        reason: "killed by SIGKILL",
      });
      expect(run.log.sha256).toBe(sha256File(s.log));
    } finally {
      s.cleanup();
    }
  });

  it("fails a command the shell cannot find (exit 127), and one that cannot start at all", async () => {
    const s = scratch();
    try {
      const missing = await runCheck(
        { command: "pi-workgraph-no-such-command-xyz", timeoutMs: 10_000 },
        s.dir,
        s.log,
      );
      // Under a shell a missing command is the shell's exit 127.
      expect(missing).toMatchObject({
        exitCode: 127,
        passed: false,
        reason: "exited 127",
      });

      // A working directory that does not exist: the process never starts.
      const unstarted = await runCheck(
        { command: "exit 0", timeoutMs: 10_000 },
        join(s.dir, "does-not-exist"),
        join(s.dir, "logs", "2.log"),
      );
      expect(unstarted.exitCode).toBeNull();
      expect(unstarted.passed).toBe(false);
      expect(unstarted.reason).toMatch(/^could not start: /);
      expect(unstarted.log.sha256).toBe(sha256File(join(s.dir, "logs", "2.log")));
    } finally {
      s.cleanup();
    }
  });

  it("keeps the first 10 MB of output, says that it cut, and hashes exactly what it wrote", async () => {
    const s = scratch();
    try {
      const run = await runCheck(
        { command: "yes | head -c 20000000; echo THE-END", timeoutMs: 60_000 },
        s.dir,
        s.log,
      );
      // The command itself exited 0: a long log is not a failure.
      expect(run).toMatchObject({ exitCode: 0, passed: true });
      const size = statSync(s.log).size;
      expect(size).toBeGreaterThan(MAX_LOG_BYTES);
      expect(size).toBeLessThan(MAX_LOG_BYTES + 200);
      expect(run.log.bytes).toBe(size);
      expect(run.log.sha256).toBe(sha256File(s.log));
      const end = readFileSync(s.log).subarray(MAX_LOG_BYTES).toString("utf8");
      expect(end).toContain(`log cut at ${MAX_LOG_BYTES} bytes`);
      // The tail follows the output past the cut.
      expect(run.log.tail.endsWith("THE-END\n")).toBe(true);
      expect(run.log.tail.length).toBeLessThanOrEqual(400);
    } finally {
      s.cleanup();
    }
  }, 60_000);

  it("passes a command that exits 0 and leaves a background child holding its output", async () => {
    const s = scratch();
    try {
      const started = Date.now();
      const run = await runCheck(
        { command: "sleep 3 & echo started; exit 0", timeoutMs: 20_000 },
        s.dir,
        s.log,
      );
      // Resolved on the command's exit, not when the child let go of the pipes.
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(run).toMatchObject({ exitCode: 0, timedOut: false, passed: true });
      expect(readFileSync(s.log, "utf8")).toContain("started");
      expect(run.log.sha256).toBe(sha256File(s.log));
    } finally {
      s.cleanup();
    }
  }, 30_000);

  it("replaces whatever was at the log path, and fails when the log cannot be written", async () => {
    const s = scratch();
    try {
      const first = await runCheck({ command: "echo one", timeoutMs: 10_000 }, s.dir, s.log);
      const second = await runCheck({ command: "echo two", timeoutMs: 10_000 }, s.dir, s.log);
      expect(first.passed && second.passed).toBe(true);
      expect(readFileSync(s.log, "utf8")).toBe("two\n");

      // A file where the log's directory should be.
      writeFileSync(join(s.dir, "blocker"), "x");
      const marker = join(s.dir, "ran");
      const blocked = await runCheck(
        { command: `touch ${marker}`, timeoutMs: 10_000 },
        s.dir,
        join(s.dir, "blocker", "1.log"),
      );
      expect(blocked.passed).toBe(false);
      expect(blocked.exitCode).toBeNull();
      expect(blocked.reason).toMatch(/^could not write log/);
      // A run whose output cannot be kept does not start the command.
      expect(existsSync(marker)).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  it("stops when aborted, and is not a pass", async () => {
    const s = scratch();
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const started = Date.now();
      const run = await runCheck(
        { command: "sleep 30", timeoutMs: 60_000 },
        s.dir,
        s.log,
        { signal: controller.signal },
      );
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(run).toMatchObject({ passed: false, reason: "aborted" });
    } finally {
      s.cleanup();
    }
  }, 30_000);

  it("does not hand the command git variables inherited from a hook", async () => {
    const s = scratch();
    const saved = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = "/somewhere/else/.git";
      const run = await runCheck(
        { command: 'echo "GIT_DIR=[${GIT_DIR:-unset}]"', timeoutMs: 10_000 },
        s.dir,
        s.log,
      );
      expect(run.passed).toBe(true);
      expect(readFileSync(s.log, "utf8")).toBe("GIT_DIR=[unset]\n");
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
      s.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

const WORKER = "proof-check-worker";

/** Distinct author/reviewer provenance — independent under every policy. */
const IMPL_PROV = { harness: "fake", model: "impl-model", provider: "prov-impl" };
const REV_PROV = { harness: "fake", model: "rev-model", provider: "prov-rev" };
const PLAN_PROV = { harness: "fake", model: "plan-model", provider: "prov-plan" };

const CLEAN_VERDICT: VerdictT = { findings: [] };
const PLAN: PlanT = { steps: [{ description: "write feature.txt" }] };

const SHA = /^[0-9a-f]{40}$/;
const RECEIPT_MARKER = "workgraph-proof receipt ";

interface Harness {
  mock: MockPi;
  coordinator: CoordinatorController;
}

/** A coordinator on the shipped defaults: no policy unless a case gives one. */
function makeHarness(
  opts: { policy?: PolicyOverrides; config?: Partial<WorkgraphConfig> } = {},
): Harness {
  const mock = makeMockPi();
  const config = shippedConfig({
    workerIdOverride: WORKER,
    ...opts.config,
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
  setWorkerIdOverride(WORKER);
  const coordinator = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => config,
  });
  return { mock, coordinator };
}

function settle(mock: MockPi, ctx: unknown): Promise<unknown[]> {
  return mock.emit(
    "agent_settled",
    { type: "agent_settled" },
    ctx as Parameters<MockPi["emit"]>[2],
  );
}

/** One coordination pass: claim, run, check, judge, and drain. */
async function drive(mock: MockPi, ctx: unknown): Promise<void> {
  await settle(mock, ctx);
  await mock.flushEvents();
}

function metadataOf(graph: ScratchGraph, id: string): Record<string, unknown> {
  return (graph.showIssue(id).metadata ?? {}) as Record<string, unknown>;
}

/** Approve an issue from outside this process, with or without a check. */
function approve(
  graph: ScratchGraph,
  id: string,
  opts: {
    riskTier?: string;
    workflowClass?: string;
    check?: string;
    waiver?: string;
  } = {},
): void {
  graph.op([
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=ready",
    "--set-metadata",
    `workgraph_risk_tier=${opts.riskTier ?? "medium"}`,
    "--set-metadata",
    `workgraph_workflow_class=${opts.workflowClass ?? "reviewed"}`,
    ...(opts.check !== undefined
      ? ["--set-metadata", `workgraph_check=${opts.check}`]
      : []),
    ...(opts.waiver !== undefined
      ? ["--set-metadata", `workgraph_check_waiver=${opts.waiver}`]
      : []),
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

async function checkRecords(dir: string, id: string) {
  return (await listGateRecords(dir, id)).filter((r) => r.gate === "check");
}

/** Silence console.error and return the lines it was given. */
function captureErrors(): () => string[] {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.join(" "));
}

/** What an isolated fake reports: its work is in the repository, cut from HEAD. */
function isolatedIn(repo: ScratchRepo) {
  return { path: repo.dir, baseRevision: repo.head };
}

function write(repo: ScratchRepo, file: string, content: string): void {
  writeFileSync(join(repo.dir, file), content);
}

/**
 * A place outside the repository for a check to leave marks in: a counter
 * of how many times it ran, a pid. Outside, so that the marks never change
 * the tree being checked.
 */
function outside(): { dir: string; file(name: string): string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-marks-"));
  return {
    dir,
    file: (name) => join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function lines(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "")
    : [];
}

describe("the check gate, default config", () => {
  // Each command passes on the base tree and fails on the implementer's
  // (which holds feature.txt): a check that also fails on the base is not
  // the implementer's to fix, and escalates instead of starting a revision
  // (test/diff-guards.test.ts).
  const FAILING: ReadonlyArray<{
    label: string;
    command: string;
    timeoutMs?: number;
    reason: string;
    receipt: Record<string, unknown>;
  }> = [
    {
      label: "exits non-zero",
      command: "echo boom; test ! -f feature.txt",
      reason: "exited 1",
      receipt: { exitCode: 1, timedOut: false },
    },
    {
      label: "times out",
      command: "test -f feature.txt && sleep 30; true",
      timeoutMs: 300,
      reason: "timed out after 0.3s",
      receipt: { timedOut: true },
    },
    {
      label: "is killed by a signal",
      command: "test -f feature.txt && kill -9 $$; true",
      reason: "killed by SIGKILL",
      receipt: { exitCode: null, signal: "SIGKILL", timedOut: false },
    },
  ];

  for (const workflowClass of ["reviewed", "planned"] as const) {
    for (const failing of FAILING) {
      it(`a medium-risk ${workflowClass} issue whose check ${failing.label} does not close, and no reviewer is asked`, async () => {
        const repo = makeScratchRepo({ prefix: "pcfail", seed: 1 });
        const id = repo.seededIds[0]!;
        approve(repo, id, { workflowClass, check: failing.command });
        const { mock, coordinator } = makeHarness({
          config: {
            planApproval: "auto",
            // The timeout comes from the repository's settings block.
            ...(failing.timeoutMs !== undefined
              ? { check: { timeoutMs: failing.timeoutMs } }
              : {}),
          },
        });
        // No revision role: the failed check parks the issue in revising.
        const fake = installFakeExecutor(mock.events, {
          roles: ["planner", "implementer", "reviewer"],
          workspace: isolatedIn(repo),
          roleScripts: {
            planner: { provenance: PLAN_PROV, plan: PLAN },
            implementer: {
              provenance: IMPL_PROV,
              onRequest: () => write(repo, "feature.txt", "v1\n"),
            },
            reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
          },
        });
        const ectx = makeEventContext(repo.dir);
        captureErrors(); // "no revision-capable executor"
        try {
          await drive(mock, ectx.ctx);

          expect(repo.showIssue(id).status).not.toBe("closed");
          const metadata = metadataOf(repo, id);
          expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("revising");
          // The reason is recorded where a human looks first.
          expect(metadata[WORKGRAPH_LAST_VERDICT_KEY]).toBe(
            "reject blocking=1 advisory=0: check",
          );

          // One receipt, for the result tree, saying how the process ended.
          const tree = String(metadata[WORKGRAPH_RESULT_TREE_KEY]);
          const receipts = await listReceipts(repo.dir, id);
          expect(receipts).toHaveLength(1);
          expect(receipts[0]).toMatchObject({
            tree,
            commandDigest: commandDigest(failing.command),
            passed: false,
            reason: failing.reason,
            ...failing.receipt,
          });

          // The gate blocked, with the reason.
          expect(await checkRecords(repo.dir, id)).toEqual([
            expect.objectContaining({
              mode: "enforce",
              result: "violation",
              blocked: true,
              reason: failing.reason,
              tree,
            }),
          ]);

          // No reviewer was asked about the failing tree, and no verdict
          // exists for it.
          expect(fake.requests.some((r) => r.role === "reviewer")).toBe(false);
          expect(await payloads(repo.dir, id, "workgraph-verdict verdict ")).toEqual([]);
          expect(await latestStamp(repo.dir, id)).toBeUndefined();
        } finally {
          fake.uninstall();
          await coordinator.teardown(ectx.ctx);
          repo.cleanup();
        }
      }, 60_000);
    }
  }

  it("a check that exits 0 writes one receipt, then the reviewer is asked, then the issue closes; the tree is not checked again in verifying", async () => {
    const repo = makeScratchRepo({ prefix: "pcpass", seed: 1 });
    const marks = outside();
    const id = repo.seededIds[0]!;
    // Passes only on the implementer's work, and counts its own runs.
    const command = `echo ran >> ${marks.file("runs")}; test -f feature.txt`;
    approve(repo, id, { check: command });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(repo.showIssue(id).status).toBe("closed");
      const tree = String(metadataOf(repo, id)[WORKGRAPH_RESULT_TREE_KEY]);
      expect(tree).toMatch(SHA);

      // Exactly one receipt comment, holding the command digest, the exit
      // code, the log's sha256 and the tree.
      expect(await payloads(repo.dir, id, RECEIPT_MARKER)).toHaveLength(1);
      const [receipt] = await listReceipts(repo.dir, id);
      expect(receipt).toMatchObject({
        tree,
        commandDigest: commandDigest(command),
        exitCode: 0,
        timedOut: false,
        passed: true,
        workflowRunId: fake.requests[0]!.workflowRunId,
        attempt: 1,
      });
      expect(receipt!.reason).toBeUndefined();
      expect(receipt!.log.sha256).toMatch(HEX64);
      // The log is on disk, beside the database, and is what was hashed.
      expect(receipt!.log.path).toBe(
        join(repo.dir, ".workgraph", "proof", id, "1.log"),
      );
      expect(sha256File(receipt!.log.path)).toBe(receipt!.log.sha256);
      // ... and it is not part of the tree it describes.
      expect(fileAt(repo.dir, tree, `.workgraph/proof/${id}/1.log`)).toBeUndefined();
      expect(fileAt(repo.dir, tree, ".workgraph/proof/.gitignore")).toBeUndefined();

      // The receipt was on the trail before the reviewer was asked.
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "reviewer"]);
      const texts = (await listComments(repo.dir, id)).map((c) => c.text);
      const at = (prefix: string) => texts.findIndex((t) => t.startsWith(prefix));
      expect(at(RECEIPT_MARKER)).toBeGreaterThan(-1);
      expect(at(RECEIPT_MARKER)).toBeLessThan(at("workgraph-verdict verdict "));

      // The stamp rests on that receipt, and nothing ran a second time: not
      // for the stamp, not in verifying.
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp).toMatchObject({
        tree,
        check: "passed",
        checkLogSha256: receipt!.log.sha256,
        gates: {
          "tree-binding": "pass",
          check: "pass",
          "criteria-evidence": "not-applicable",
          review: "pass",
        },
      });
      expect(lines(marks.file("runs"))).toHaveLength(1);
      expect(heldLeases(repo.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
      marks.cleanup();
    }
  }, 60_000);

  it("a revision that fixes a failing check: a second receipt for the new tree, then review, then close", async () => {
    const repo = makeScratchRepo({ prefix: "pcfix", seed: 1 });
    const id = repo.seededIds[0]!;
    // Green on the base; red once feature.txt is there without fixed.txt.
    approve(repo, id, {
      check: "echo looking for fixed.txt; test ! -f feature.txt || test -f fixed.txt",
    });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "revision"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        revision: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "fixed.txt", "fixed\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(repo.showIssue(id).status).toBe("closed");
      // The failing tree went to a revisor, never to a reviewer.
      expect(fake.requests.map((r) => r.role)).toEqual([
        "implementer",
        "revision",
        "reviewer",
      ]);

      // The revisor got the finding the core wrote: who wrote it, why it
      // failed, and the end of the log.
      const revision = fake.requests[1]!;
      expect(revision.attempt).toBe(2);
      const findings = (revision.priorFindings ?? []).map(
        (text) => JSON.parse(text) as FindingT,
      );
      expect(findings).toEqual([
        {
          criterion: "check",
          severity: "blocking",
          author: "code",
          note: "exited 1",
          evidence: "looking for fixed.txt\n",
        },
      ]);

      // Two receipts: the tree that failed, then the tree the revision left.
      const receipts = await listReceipts(repo.dir, id);
      expect(receipts.map((r) => [r.passed, r.attempt])).toEqual([
        [false, 1],
        [true, 2],
      ]);
      expect(receipts[0]!.tree).not.toBe(receipts[1]!.tree);
      expect(fileAt(repo.dir, receipts[0]!.tree, "fixed.txt")).toBeUndefined();
      expect(fileAt(repo.dir, receipts[1]!.tree, "fixed.txt")).toBe("fixed\n");
      expect(receipts[0]!.log.path).not.toBe(receipts[1]!.log.path);

      expect((await checkRecords(repo.dir, id)).map((r) => [r.result, r.blocked, r.attempt])).toEqual([
        ["violation", true, 1],
        ["pass", false, 2],
      ]);
      // The reviewer saw the tree that passed, and the stamp names it.
      const review = fake.requests[2]!;
      expect(review.workspace.tree).toBe(receipts[1]!.tree);
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp).toMatchObject({
        tree: receipts[1]!.tree,
        attempt: 2,
        check: "passed",
        checkLogSha256: receipts[1]!.log.sha256,
      });
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a revision that changes nothing is not checked again: the same failure on the same tree stops the loop", async () => {
    const repo = makeScratchRepo({ prefix: "pcsame", seed: 1 });
    const marks = outside();
    const id = repo.seededIds[0]!;
    // Counts its runs on the implementer's tree only, and fails there. (It
    // also runs once on the base tree, where it passes and leaves no mark.)
    approve(repo, id, {
      check: `test -f feature.txt && echo ran >> ${marks.file("runs")}; test ! -f feature.txt`,
    });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "revision"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        revision: { provenance: IMPL_PROV }, // touches nothing
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);

      // One run of the command, one receipt, reused for the unchanged tree.
      expect(lines(marks.file("runs"))).toHaveLength(1);
      expect(await listReceipts(repo.dir, id)).toHaveLength(1);
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "revision"]);
      // A repeat never relaunches a revision: reviewed work is promoted to
      // planned and handed back, still open.
      const metadata = metadataOf(repo, id);
      expect(repo.showIssue(id).status).toBe("open");
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(metadata[WORKGRAPH_WORKFLOW_CLASS_KEY]).toBe("planned");
      const promoted = await audits(repo.dir, id, "workflow-promoted");
      expect(String(promoted[0]!.reason)).toMatch(/repeated blocking-finding fingerprint/);
      expect((await checkRecords(repo.dir, id)).map((r) => r.attempt)).toEqual([1, 2]);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
      marks.cleanup();
    }
  }, 60_000);

  it("a low-risk one-shot whose check fails does not close: it is promoted to reviewed", async () => {
    const repo = makeScratchRepo({ prefix: "pconef", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, { riskTier: "low", workflowClass: "oneshot", check: "exit 1" });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      // One pass only: the next would claim it again, as reviewed work.
      await drive(mock, ectx.ctx);

      const shown = repo.showIssue(id);
      expect(shown.status).toBe("open");
      const metadata = metadataOf(repo, id);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("ready");
      expect(metadata[WORKGRAPH_WORKFLOW_CLASS_KEY]).toBe("reviewed");

      const promoted = await audits(repo.dir, id, "workflow-promoted");
      expect(promoted).toHaveLength(1);
      expect(promoted[0]).toMatchObject({
        from: "oneshot",
        to: "reviewed",
        outcome: "success", // the implementer said so; the check said otherwise
        reason: "check failed: exited 1",
      });
      // Check enforces at every tier, low included.
      const tree = String(metadata[WORKGRAPH_RESULT_TREE_KEY]);
      expect(tree).toMatch(SHA);
      expect(await checkRecords(repo.dir, id)).toEqual([
        expect.objectContaining({
          mode: "enforce",
          result: "violation",
          blocked: true,
          reason: "exited 1",
          tree,
        }),
      ]);
      expect(await listReceipts(repo.dir, id)).toEqual([
        expect.objectContaining({ tree, passed: false, reason: "exited 1" }),
      ]);
      expect(await latestStamp(repo.dir, id)).toBeUndefined();
      expect(await audits(repo.dir, id, "oneshot-closed")).toEqual([]);
      expect(heldLeases(repo.dir)).toHaveLength(0);
      expect(coordinator.current()).toBeNull();
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a low-risk one-shot with no check closes, and its stamp says no check ran", async () => {
    const repo = makeScratchRepo({ prefix: "pconen", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, { riskTier: "low", workflowClass: "oneshot" });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(repo.showIssue(id).status).toBe("closed");
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp!.check).toBe("none");
      expect(stamp).not.toHaveProperty("checkLogSha256");
      expect(stamp!.gates).toEqual({
        check: "not-applicable",
        "tree-binding": "pass",
      });
      expect(await listReceipts(repo.dir, id)).toEqual([]);
      expect(await checkRecords(repo.dir, id)).toEqual([
        expect.objectContaining({
          mode: "enforce",
          result: "not-applicable",
          blocked: false,
          reason: "no check",
        }),
      ]);
      expect(existsSync(join(repo.dir, ".workgraph", "proof"))).toBe(false);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a low-risk one-shot whose check passes closes with a receipt for the stamped tree", async () => {
    const repo = makeScratchRepo({ prefix: "pconep", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, {
      riskTier: "low",
      workflowClass: "oneshot",
      check: "test -f feature.txt",
    });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      const [receipt] = await listReceipts(repo.dir, id);
      const stamp = await latestStamp(repo.dir, id);
      expect(receipt!.passed).toBe(true);
      expect(stamp).toMatchObject({
        tree: receipt!.tree,
        check: "passed",
        checkLogSha256: receipt!.log.sha256,
      });
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("the repository default is the check for an issue that names none, with its timeout", async () => {
    const repo = makeScratchRepo({ prefix: "pcdflt", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id); // no check of its own
    const { mock, coordinator } = makeHarness({
      config: { check: { command: "test -f feature.txt", timeoutMs: 20_000 } },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      const [receipt] = await listReceipts(repo.dir, id);
      expect(receipt).toMatchObject({
        commandDigest: commandDigest("test -f feature.txt"),
        passed: true,
      });
      // The bar frozen at claim names the command and the timeout.
      const frozen = await audits(repo.dir, id, "bar-frozen");
      expect(frozen).toHaveLength(1);
      expect(frozen[0]!.bar).toMatchObject({
        riskTier: "medium",
        check: { command: "test -f feature.txt", timeoutMs: 20_000 },
      });
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);
});

describe("the check gate, other modes and edges", () => {
  it("under observe a failing check is recorded as a would-block, the review still runs, and the stamp says failed", async () => {
    const repo = makeScratchRepo({ prefix: "pcobs", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, { check: "exit 1" });
    const { mock, coordinator } = makeHarness({
      policy: { medium: { gates: { check: "observe" } } },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      expect(await checkRecords(repo.dir, id)).toEqual([
        expect.objectContaining({
          mode: "observe",
          result: "violation",
          blocked: false,
          wouldBlock: true,
          reason: "exited 1",
        }),
      ]);
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer", "reviewer"]);
      const stamp = await latestStamp(repo.dir, id);
      // Not "none": a check ran, and it failed.
      expect(stamp!.check).toBe("failed");
      expect(stamp).not.toHaveProperty("checkLogSha256");
      expect(stamp!.gates.check).toBe("violation");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("with the gate off nothing runs and nothing is recorded", async () => {
    const repo = makeScratchRepo({ prefix: "pcoff", seed: 1 });
    const marks = outside();
    const id = repo.seededIds[0]!;
    approve(repo, id, { check: `echo ran >> ${marks.file("runs")}; exit 1` });
    const { mock, coordinator } = makeHarness({
      policy: { medium: { gates: { check: "off" } } },
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
      expect(lines(marks.file("runs"))).toEqual([]);
      expect(await checkRecords(repo.dir, id)).toEqual([]);
      expect(await listReceipts(repo.dir, id)).toEqual([]);
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp).not.toHaveProperty("check");
      expect(stamp!.gates).toEqual({
        "tree-binding": "pass",
        "weakened-tests": "pass",
        scope: "not-applicable",
        "unproven-tests": "not-applicable",
        "criteria-evidence": "not-applicable",
        review: "pass",
      });
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
      marks.cleanup();
    }
  }, 60_000);

  it("with the review gate off the work is still checked", async () => {
    const repo = makeScratchRepo({ prefix: "pcnorev", seed: 1 });
    const id = repo.seededIds[0]!;
    // Green on the base, red on the implementer's tree.
    approve(repo, id, { check: "test ! -f feature.txt" });
    const { mock, coordinator } = makeHarness({
      policy: { medium: { gates: { review: "off" } } },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
      },
    });
    const ectx = makeEventContext(repo.dir);
    captureErrors();
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).not.toBe("closed");
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("revising");
      expect(await listReceipts(repo.dir, id)).toHaveLength(1);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("a check that leaves stable output in the workspace settles on the tree that holds it", async () => {
    const repo = makeScratchRepo({ prefix: "pcstab", seed: 1 });
    const marks = outside();
    const id = repo.seededIds[0]!;
    // Writes the same file every run: the first run changes the tree, the
    // second leaves it alone.
    approve(repo, id, {
      check: `echo ran >> ${marks.file("runs")}; echo covered > coverage.txt`,
    });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("closed");
      // Two runs, one receipt: the first result described a tree that was
      // gone by the time the command finished, and was discarded.
      expect(lines(marks.file("runs"))).toHaveLength(2);
      const receipts = await listReceipts(repo.dir, id);
      expect(receipts).toHaveLength(1);
      expect(fileAt(repo.dir, receipts[0]!.tree, "coverage.txt")).toBe("covered\n");
      const changed = await audits(repo.dir, id, "workspace-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        when: "during the check",
        tree: receipts[0]!.tree,
      });
      // The reviewer and the stamp got the tree the receipt names.
      const review = fake.requests.find((r) => r.role === "reviewer")!;
      expect(review.workspace.tree).toBe(receipts[0]!.tree);
      expect((await latestStamp(repo.dir, id))!.tree).toBe(receipts[0]!.tree);
      // One check record, for that tree; tree-binding was recorded for both.
      expect((await checkRecords(repo.dir, id)).map((r) => r.tree)).toEqual([
        receipts[0]!.tree,
      ]);
      const binding = (await listGateRecords(repo.dir, id)).filter(
        (r) => r.gate === "tree-binding",
      );
      expect(binding).toHaveLength(2);
      expect(binding[1]!.tree).toBe(receipts[0]!.tree);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
      marks.cleanup();
    }
  }, 60_000);

  it("a check that changes the workspace on every run escalates after the retries, with no receipt", async () => {
    const repo = makeScratchRepo({ prefix: "pcchurn", seed: 1 });
    const marks = outside();
    const id = repo.seededIds[0]!;
    approve(repo, id, {
      check: `echo ran >> ${marks.file("runs")}; echo more >> churn.txt`,
    });
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
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("blocked");
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      const escalated = await audits(repo.dir, id, "escalated");
      expect(escalated).toHaveLength(1);
      expect(escalated[0]!.reason).toBe(
        "check: workspace keeps changing during the check",
      );
      // The first run and the retries, and none of them kept.
      expect(lines(marks.file("runs"))).toHaveLength(1 + MAX_CHECK_RETRIES);
      expect(await listReceipts(repo.dir, id)).toEqual([]);
      expect(await checkRecords(repo.dir, id)).toEqual([
        expect.objectContaining({ result: "unknown", blocked: true }),
      ]);
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      expect(heldLeases(repo.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
      marks.cleanup();
    }
  }, 60_000);

  it("a receipt that cannot be written escalates, whatever the check said", async () => {
    const repo = makeScratchRepo({ prefix: "pcwrite", seed: 1 });
    const id = repo.seededIds[0]!;
    approve(repo, id, { check: "true" });
    const { mock, coordinator } = makeHarness();
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: { provenance: IMPL_PROV },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
      },
    });
    failCommentWrites(repo.dir, RECEIPT_MARKER);
    const errors = captureErrors();
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);
      expect(repo.showIssue(id).status).toBe("blocked");
      const escalated = await audits(repo.dir, id, "escalated");
      expect(String(escalated[0]!.reason)).toMatch(/^check receipt could not be written: /);
      expect(errors().some((line) => line.includes("RECEIPT WRITE FAILED"))).toBe(true);
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      expect(await latestStamp(repo.dir, id)).toBeUndefined();
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("with tree binding off a check has no tree to name: the issue escalates and the reason says what to set", async () => {
    const repo = makeScratchRepo({ prefix: "pcnotree", seed: 2 });
    const marks = outside();
    const [checked, waived] = repo.seededIds as [string, string];
    approve(repo, checked, { check: `echo ran >> ${marks.file("runs")}; true` });
    approve(repo, waived, { waiver: "prose only" });
    const { mock, coordinator } = makeHarness({
      policy: { medium: { gates: { "tree-binding": "off" } } },
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
      await drive(mock, ectx.ctx);

      // The command never ran: a receipt names a tree, and there is none.
      expect(repo.showIssue(checked).status).toBe("blocked");
      expect(lines(marks.file("runs"))).toEqual([]);
      const escalated = await audits(repo.dir, checked, "escalated");
      expect(String(escalated[0]!.reason)).toMatch(
        /^check: the check needs a result tree and there is none \(the tree-binding gate is off\)/,
      );
      expect(String(escalated[0]!.reason)).toContain("gates.tree-binding");

      // Waived work has nothing to run, so it closes — and because the
      // check gate was evaluated, it is stamped, without tree fields.
      expect(repo.showIssue(waived).status).toBe("closed");
      const stamp = await latestStamp(repo.dir, waived);
      expect(stamp).toMatchObject({ check: "waived" });
      expect(stamp).not.toHaveProperty("tree");
      // The diff guards have no tree to compare either: unknown, which
      // never blocks.
      expect(stamp!.gates).toEqual({
        check: "not-applicable",
        "weakened-tests": "unknown",
        scope: "unknown",
        "unproven-tests": "unknown",
        "criteria-evidence": "not-applicable",
        review: "pass",
      });
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
      marks.cleanup();
    }
  }, 60_000);

  it("a check that fails on the tree finalization produced escalates from verifying instead of closing", async () => {
    const repo = makeScratchRepo({ prefix: "pcfin", seed: 1 });
    const id = repo.seededIds[0]!;
    // Passes on the implementer's tree, fails once the finalizer adds a file.
    approve(repo, id, { check: "test ! -f RELEASE.txt" });
    const { mock, coordinator } = makeHarness({
      config: {
        finalization: { instructions: "Publish the verified result", timeoutMs: 5_000 },
      },
    });
    const fake = installFakeExecutor(mock.events, {
      roles: ["implementer", "reviewer", "finalizer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
        reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT },
        finalizer: {
          finalization: { outcome: "success", summary: "Published" },
          onRequest: () => write(repo, "RELEASE.txt", "released\n"),
        },
      },
    });
    const ectx = makeEventContext(repo.dir);
    try {
      await drive(mock, ectx.ctx);

      expect(repo.showIssue(id).status).toBe("blocked");
      const metadata = metadataOf(repo, id);
      expect(metadata[WORKGRAPH_PHASE_KEY]).toBe("escalated");
      const escalated = await audits(repo.dir, id, "escalated");
      expect(escalated).toHaveLength(1);
      expect(String(escalated[0]!.reason)).toMatch(
        /^check failed on the tree finalization produced: exited 1; finalization already ran/,
      );
      // Finalization's own record is left as it was written.
      expect(metadata.workgraph_finalization_status).toBe("success");
      // The stamp was written before finalization and names the tree that
      // passed; the amendment names the tree that did not.
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp!.check).toBe("passed");
      const receipts = await listReceipts(repo.dir, id);
      expect(receipts.map((r) => [r.tree, r.passed])).toEqual([
        [stamp!.tree, true],
        [stamp!.finalizedTree, false],
      ]);
      expect((await checkRecords(repo.dir, id)).map((r) => [r.result, r.blocked, r.tree])).toEqual([
        ["pass", false, stamp!.tree],
        ["violation", true, stamp!.finalizedTree],
      ]);
      expect(await audits(repo.dir, id, "judgment-closed")).toEqual([]);
      expect(heldLeases(repo.dir)).toHaveLength(0);
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
    }
  }, 60_000);

  it("teardown stops a running check, writes no receipt and releases the run", async () => {
    const repo = makeScratchRepo({ prefix: "pcstop", seed: 1 });
    const marks = outside();
    const id = repo.seededIds[0]!;
    approve(repo, id, { check: `echo $$ > ${marks.file("pid")}; sleep 30` });
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
      // Not drained: the completion handler is inside the check.
      await settle(mock, ectx.ctx);
      const deadline = Date.now() + 10_000;
      while (!existsSync(marks.file("pid")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const pid = Number(readFileSync(marks.file("pid"), "utf8").trim());
      expect(pid).toBeGreaterThan(0);
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("judging");

      const started = Date.now();
      await coordinator.teardown(ectx.ctx);
      await mock.flushEvents();
      expect(Date.now() - started).toBeLessThan(10_000);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await listReceipts(repo.dir, id)).toEqual([]);
      expect(await checkRecords(repo.dir, id)).toEqual([]);
      expect(fake.requests.map((r) => r.role)).toEqual(["implementer"]);
      // Released, still in judging: the next session picks it up.
      expect(heldLeases(repo.dir)).toHaveLength(0);
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("judging");
    } finally {
      fake.uninstall();
      await coordinator.teardown(ectx.ctx);
      repo.cleanup();
      marks.cleanup();
    }
  }, 60_000);

  it("after a restart the receipt on the trail is reused: the tree is not checked again", async () => {
    resetLeasesForTest();
    const repo = makeScratchRepo({ prefix: "pcrst", seed: 1 });
    const marks = outside();
    const id = repo.seededIds[0]!;
    approve(repo, id, { check: `echo ran >> ${marks.file("runs")}; true` });
    const first = makeHarness();
    // No reviewer before the crash: the run parks in judging, checked.
    const fakeA = installFakeExecutor(first.mock.events, {
      executorId: "implementer-exec",
      roles: ["implementer"],
      workspace: isolatedIn(repo),
      roleScripts: {
        implementer: {
          provenance: IMPL_PROV,
          onRequest: () => write(repo, "feature.txt", "v1\n"),
        },
      },
    });
    const ectx1 = makeEventContext(repo.dir);
    captureErrors(); // the pre-crash park
    const second = makeHarness();
    const fakeB = installFakeExecutor(second.mock.events, {
      executorId: "reviewer-exec",
      roles: ["reviewer"],
      roleScripts: { reviewer: { provenance: REV_PROV, verdict: CLEAN_VERDICT } },
    });
    const ectx2 = makeEventContext(repo.dir);
    try {
      await drive(first.mock, ectx1.ctx);
      expect(metadataOf(repo, id)[WORKGRAPH_PHASE_KEY]).toBe("judging");
      expect(lines(marks.file("runs"))).toHaveLength(1);
      expect(await listReceipts(repo.dir, id)).toHaveLength(1);
      // The crash: memory is gone, the store keeps everything.
      fakeA.uninstall();
      resetLeasesForTest();

      const report = await second.coordinator.reconcile(ectx2.ctx);
      await second.mock.flushEvents();
      expect(report.readopted).toEqual([id]);

      expect(repo.showIssue(id).status).toBe("closed");
      // Still one run and one receipt: the new process read the trail.
      expect(lines(marks.file("runs"))).toHaveLength(1);
      const receipts = await listReceipts(repo.dir, id);
      expect(receipts).toHaveLength(1);
      const stamp = await latestStamp(repo.dir, id);
      expect(stamp).toMatchObject({
        tree: receipts[0]!.tree,
        check: "passed",
        checkLogSha256: receipts[0]!.log.sha256,
      });
      // The bar the adopted run was judged against is the one frozen at claim.
      expect(await audits(repo.dir, id, "bar-frozen")).toHaveLength(1);
      expect(await audits(repo.dir, id, "bar-changed")).toEqual([]);
    } finally {
      fakeA.uninstall();
      fakeB.uninstall();
      await first.coordinator.teardown(ectx1.ctx);
      await second.coordinator.teardown(ectx2.ctx);
      repo.cleanup();
      marks.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// findings written by code, and the bar's digest
// ---------------------------------------------------------------------------

describe("code-authored findings", () => {
  it("a reviewer cannot claim a finding was written by code", () => {
    const verdict = parseVerdict({
      findings: [
        { criterion: "c1", severity: "blocking", author: "code", note: "trust me" },
        { criterion: "c2", severity: "advisory", author: "anything at all" },
        { criterion: "c3", severity: "advisory" },
      ],
      summary: "forged",
    });
    expect(verdict.findings).toEqual([
      { criterion: "c1", severity: "blocking", note: "trust me" },
      { criterion: "c2", severity: "advisory" },
      { criterion: "c3", severity: "advisory" },
    ]);
    expect(verdict.summary).toBe("forged");
    // Still strict about everything else.
    expect(() => parseVerdict({ findings: [{ criterion: "c1" }] })).toThrow();
    expect(() => parseVerdict(undefined)).toThrow();
  });

  it("the author is part of the failure fingerprint only when set", () => {
    const base: FindingT = { criterion: "check", severity: "blocking", note: "exited 1" };
    const byCode: FindingT = { ...base, author: "code" };
    expect(failureFingerprint([byCode], "tree-a")).toBe(
      failureFingerprint([byCode], "tree-a"),
    );
    expect(failureFingerprint([byCode], "tree-a")).not.toBe(
      failureFingerprint([byCode], "tree-b"),
    );
    expect(failureFingerprint([byCode], "tree-a")).not.toBe(
      failureFingerprint([base], "tree-a"),
    );
  });
});

describe("the bar", () => {
  const issue = (metadata: Record<string, unknown>, criteria?: string) => ({
    id: "bar-1",
    title: "t",
    status: "open",
    priority: 2,
    issue_type: "task",
    metadata,
    ...(criteria !== undefined ? { acceptance_criteria: criteria } : {}),
  });

  it("holds the tier, the resolved policy, the criteria and the effective check", () => {
    const bar = buildBar(
      issue({ workgraph_risk_tier: "high", workgraph_check: " npm test " }, "it works"),
      { check: { command: "make check", timeoutMs: 5_000 } },
    );
    expect(bar).toMatchObject({
      riskTier: "high",
      criteria: "it works",
      // The issue's own command wins; the timeout is the repository's.
      check: { command: "npm test", timeoutMs: 5_000 },
    });
    expect(bar.policy.gates.check).toBe("enforce");
    expect(bar).not.toHaveProperty("checkWaiver");

    // No check of its own: the repository default.
    expect(buildBar(issue({}), { check: { command: "make check" } })).toMatchObject({
      riskTier: "medium", // a missing tier is medium
      check: { command: "make check", timeoutMs: DEFAULT_CHECK_TIMEOUT_MS },
    });
    // A waiver on the issue wins over the repository default.
    const waived = buildBar(issue({ workgraph_check_waiver: "docs only" }), {
      check: { command: "make check" },
    });
    expect(waived.checkWaiver).toBe("docs only");
    expect(waived).not.toHaveProperty("check");
    // `true` is a command, also when a hand-written value landed as a boolean.
    expect(buildBar(issue({ workgraph_check: true }), {}).check?.command).toBe("true");
    expect(buildBar(issue({ workgraph_check: "   " }), {})).not.toHaveProperty("check");
  });

  it("digests the same bar the same way, and names what differs between two", () => {
    const config = { check: { command: "make check" } };
    const a = buildBar(issue({ workgraph_risk_tier: "medium" }, "c"), config);
    const b = buildBar(issue({ workgraph_risk_tier: "medium" }, "c"), config);
    expect(barDigest(a)).toMatch(HEX64);
    expect(barDigest(a)).toBe(barDigest(b));
    expect(barDifferences(a, b)).toEqual([]);
    // Key order does not matter; an absent field and an undefined one agree.
    expect(
      barDigest({ policy: a.policy, check: a.check, criteria: "c", riskTier: "medium" }),
    ).toBe(barDigest(a));
    expect(barDigest({ ...a, checkWaiver: undefined })).toBe(barDigest(a));

    const moved = buildBar(
      issue({ workgraph_risk_tier: "low", workgraph_check: "exit 0" }, "d"),
      { ...config, policy: { low: { maxRevisions: 1 } } },
    );
    expect(barDigest(moved)).not.toBe(barDigest(a));
    expect(barDifferences(a, moved)).toEqual([
      "riskTier",
      "criteria",
      "check",
      "gates.review",
      "gates.tree-binding",
      "gates.criteria-evidence",
      "gates.weakened-tests",
      "gates.unproven-tests",
      "gates.scope",
      "requireAuthorIndependence",
      "maxRevisions",
    ]);
  });
});
