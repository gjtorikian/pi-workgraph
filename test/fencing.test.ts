/**
 * Contract criterion 2: a stale holder's write is rejected after reclaim.
 *
 * Worker A (real child process) acquires with a 2 s TTL, then is SIGSTOP'd —
 * not killed: it must wake up and TRY to write. Worker B (this process)
 * sweeps at expiry and reclaims (epoch 2). On SIGCONT, A's final write goes
 * through the fencing gate, sees the higher epoch, and aborts; the issue
 * remains B's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindExec, listComments, type BeadsComment } from "../src/bd.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import {
  acquireLease,
  FencingError,
  leaseEpochOf,
  leaseHolderOf,
  releaseLease,
  renewLease,
  resetLeasesForTest,
  trackLease,
  verifyHolding,
} from "../src/lease.ts";
import { findExpired, reclaim } from "../src/sweep.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import { newWorkflowRunId, type LeaseActor } from "../src/types.ts";
import {
  asExtensionAPI,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph } from "./helpers/scratch.ts";
import { spawnWorker, type WorkerProc } from "./helpers/worker-proc.ts";

const TTL = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let mock: MockPi;

/** Direct tool execution (the src/tools.test.ts pattern). */
function runTool(name: string, params: unknown, cwd: string) {
  const def = mock.tools.get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def.execute(
    `fence-${name}`,
    params,
    undefined,
    undefined,
    makeToolContext(cwd),
  );
}

beforeAll(() => {
  mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  // The run-scoped suite drives workgraph_close/workgraph_heartbeat — the
  // tool-level holder writes — through their fencing gates.
  registerWorkgraphTools(asExtensionAPI(mock));
});

afterAll(() => {
  resetLeasesForTest();
  resetIdentityForTest();
});

describe("fencing (contract criterion 2)", () => {
  it("a SIGSTOP'd holder that wakes after reclaim aborts its write; the issue stays with the reclaimer", async () => {
    const graph = makeScratchGraph({ prefix: "fence" });
    let a: WorkerProc | undefined;
    try {
      const id = graph.createIssue("contended work");

      // Worker A acquires with a short TTL...
      a = spawnWorker({
        mode: "hold",
        cwd: graph.dir,
        issueId: id,
        workerId: "fence-a",
        ttlMs: TTL,
      });
      const acquired = await a.waitForLine("ACQUIRED", 60_000);
      expect(acquired).toBe("ACQUIRED 1");

      // ...and freezes mid-work (not killed — it will wake and try to write).
      process.kill(a.pid, "SIGSTOP");

      // Worker B sweeps until the lease expires, then reclaims.
      setWorkerIdOverride("fence-b");
      let victim;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const expired = await findExpired(graph.dir, { ttlMs: TTL });
        victim = expired.find((i) => i.id === id);
        if (victim) break;
        await sleep(250);
      }
      expect(victim, "sweep never saw the lease expire").toBeDefined();
      // B's own lease gets a normal-length TTL so it cannot expire mid-test.
      const lease = await reclaim(graph.dir, victim!, { ttlMs: 300_000 });
      expect(lease).toMatchObject({ issueId: id, epoch: 2 });

      // Wake A and tell it to finish: its close must abort on the fence.
      process.kill(a.pid, "SIGCONT");
      a.send("finish");
      const exit = await a.exited;
      expect(exit.code, `stderr: ${exit.stderr.trim()}`).toBe(3);
      expect(exit.stdout).toContain("FENCED fence-b 2");

      // The issue remains B's, unclosed, at B's epoch.
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(shown.assignee).toBe("fence-b");
      expect(leaseHolderOf(shown)).toBe("fence-b");
      expect(leaseEpochOf(shown)).toBe(2);

      // The audit trail shows the reclaim, naming A as the previous holder.
      const comments: BeadsComment[] = await listComments(graph.dir, id);
      const reclaims = comments.filter((c) =>
        c.text.startsWith("workgraph-lease reclaim "),
      );
      expect(reclaims).toHaveLength(1);
      expect(reclaims[0]!.text).toContain('"from":"fence-a"');
    } finally {
      if (a && a.child.exitCode === null) {
        // Never leave a SIGSTOP'd child behind.
        try {
          process.kill(a.pid, "SIGCONT");
        } catch {
          /* already gone */
        }
        a.kill("SIGKILL");
        await a.exited;
      }
      graph.cleanup();
    }
  }, 120_000);
});

describe("run-scoped fencing (phase 1)", () => {
  it("a stale run-scoped holder cannot verify, renew, release, close, or heartbeat after a fenced takeover", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "fencrun" });
    try {
      const id = graph.createIssue("run-scoped work");
      // Run A's identity: the lease is HELD by a generated workflow-run id
      // whose lifetime is the run's; the initiator attributes the bd writes.
      const runA: LeaseActor = {
        holder: newWorkflowRunId(),
        bdActor: "fence-init-a",
      };
      const runB = newWorkflowRunId();

      const outcome = await acquireLease(graph.dir, {
        issueId: id,
        ttlMs: 300_000,
        actor: runA,
      });
      expect(outcome.kind).toBe("acquired");
      if (outcome.kind !== "acquired") return;
      const lease = outcome.lease;
      expect(leaseHolderOf(graph.showIssue(id))).toBe(runA.holder);
      await expect(verifyHolding(graph.dir, lease, runA.holder)).resolves.toBe(
        true,
      );

      // Run B's fenced takeover: epoch bump + holder overwrite — the exact
      // state a reclaim leaves behind.
      graph.bd([
        "update",
        id,
        "--set-metadata",
        `lease_epoch=${lease.epoch + 1}`,
        "--set-metadata",
        `lease_holder=${runB}`,
      ]);

      // Every mutating op by the stale run A must abort on the fence.
      await expect(verifyHolding(graph.dir, lease, runA.holder)).resolves.toBe(
        false,
      );
      await expect(
        renewLease(graph.dir, lease, { ttlMs: 300_000, actor: runA }),
      ).rejects.toThrow(FencingError);
      await expect(releaseLease(graph.dir, lease, runA)).rejects.toThrow(
        FencingError,
      );

      // The tool-level holder writes fence on the TRACKED actor. Each fenced
      // failure untracks, so re-track A's stale lease before each attempt.
      trackLease(graph.dir, lease, runA);
      await expect(runTool("workgraph_close", { id }, graph.dir)).rejects.toThrow(
        FencingError,
      );
      trackLease(graph.dir, lease, runA);
      await expect(
        runTool("workgraph_heartbeat", {}, graph.dir),
      ).rejects.toThrow(/reclaimed/i);

      // Run B's takeover is untouched by any of the stale attempts.
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(leaseHolderOf(shown)).toBe(runB);
      expect(leaseEpochOf(shown)).toBe(lease.epoch + 1);
    } finally {
      resetLeasesForTest();
      graph.cleanup();
    }
  }, 60_000);

  it("the same holder string with a stale epoch is fenced — the epoch is the token, not the name", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "fencep" });
    try {
      const id = graph.createIssue("same name, old epoch");
      const runA: LeaseActor = {
        holder: newWorkflowRunId(),
        bdActor: "fence-init-a",
      };
      const outcome = await acquireLease(graph.dir, {
        issueId: id,
        ttlMs: 300_000,
        actor: runA,
      });
      expect(outcome.kind).toBe("acquired");
      if (outcome.kind !== "acquired") return;
      const lease = outcome.lease;

      // The epoch moves on while the holder NAME stays identical (an
      // expire/re-acquire round-trip elsewhere ends with the same run name
      // at a higher epoch). The stale lease's epoch is what must fail.
      graph.bd([
        "update",
        id,
        "--set-metadata",
        `lease_epoch=${lease.epoch + 1}`,
      ]);

      await expect(verifyHolding(graph.dir, lease, runA.holder)).resolves.toBe(
        false,
      );
      await expect(
        renewLease(graph.dir, lease, { ttlMs: 300_000, actor: runA }),
      ).rejects.toThrow(FencingError);
      await expect(releaseLease(graph.dir, lease, runA)).rejects.toThrow(
        FencingError,
      );
      trackLease(graph.dir, lease, runA);
      await expect(runTool("workgraph_close", { id }, graph.dir)).rejects.toThrow(
        FencingError,
      );

      // Still claimed, at the bumped epoch, same holder name.
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(leaseHolderOf(shown)).toBe(runA.holder);
      expect(leaseEpochOf(shown)).toBe(lease.epoch + 1);
    } finally {
      resetLeasesForTest();
      graph.cleanup();
    }
  }, 60_000);
});
