/**
 * Contract criterion 3: a SIGKILL'd worker's issue is auto-released
 * (reclaimed) within TTL + poll + tolerance, with an audit record.
 *
 * Worker A (real child process) acquires, then dies without cleanup. Worker
 * B's sweep loop (poll 500 ms) detects the expired lease and reclaims it;
 * the reclaim latency is the contract's bound.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindExec, listComments, type BeadsComment } from "../src/bd.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import piWorkgraph from "../src/index.ts";
import {
  acquireLease,
  heldLeases,
  leaseEpochOf,
  leaseHolderOf,
  resetLeasesForTest,
} from "../src/lease.ts";
import { findExpired, reclaim, registerSweep } from "../src/sweep.ts";
import type { Lease } from "../src/types.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph } from "./helpers/scratch.ts";
import { spawnWorker } from "./helpers/worker-proc.ts";

const TTL = 2_000;
const POLL = 500;
const TOLERANCE = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  const mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
});

afterAll(() => {
  resetIdentityForTest();
});

describe("reclaim after worker death (contract criterion 3)", () => {
  it("SIGKILL'd worker's lease is reclaimed within TTL + poll + tolerance, with audit", async () => {
    const graph = makeScratchGraph({ prefix: "rcl" });
    try {
      const id = graph.createIssue("orphaned work");

      const a = spawnWorker({
        mode: "hold",
        cwd: graph.dir,
        issueId: id,
        workerId: "rcl-a",
        ttlMs: TTL,
      });
      await a.waitForLine("ACQUIRED", 60_000);

      // Worker A dies without any cleanup.
      const tKill = Date.now();
      a.kill("SIGKILL");
      await a.exited;

      // Worker B's sweep loop, poll 500 ms.
      setWorkerIdOverride("rcl-b");
      let lease: Lease | null = null;
      let tReclaim = 0;
      const guard = tKill + TTL + POLL + 30_000; // loop guard, NOT the assertion bound
      while (Date.now() < guard) {
        const tickStart = Date.now();
        const expired = await findExpired(graph.dir, { ttlMs: TTL });
        const victim = expired.find((i) => i.id === id);
        if (victim) {
          lease = await reclaim(graph.dir, victim, { ttlMs: 300_000 });
          tReclaim = Date.now();
          break;
        }
        // Interval-aligned: the NEXT check starts POLL after this one did,
        // so bd's list latency doesn't stretch the effective poll period.
        await sleep(Math.max(0, POLL - (Date.now() - tickStart)));
      }

      expect(lease, "sweep never reclaimed the dead worker's issue").not.toBeNull();
      expect(lease).toMatchObject({ issueId: id, epoch: 2 });

      // The contract's latency bound.
      expect(tReclaim - tKill).toBeLessThanOrEqual(TTL + POLL + TOLERANCE);

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(shown.assignee).toBe("rcl-b");
      expect(leaseHolderOf(shown)).toBe("rcl-b");
      expect(leaseEpochOf(shown)).toBe(2);

      // Audit record exists and names the dead holder.
      const comments: BeadsComment[] = await listComments(graph.dir, id);
      const reclaims = comments.filter((c) =>
        c.text.startsWith("workgraph-lease reclaim "),
      );
      expect(reclaims).toHaveLength(1);
      expect(reclaims[0]!.text).toContain('"from":"rcl-a"');
    } finally {
      graph.cleanup();
    }
  }, 120_000);
});

describe("production sweep wiring (phase 1)", () => {
  it("registering the extension starts the sweep: an expired lease is reclaimed, audited, and left ready", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rclw" });
    const mock = makeMockPi();
    const ectx = makeEventContext(graph.dir);
    try {
      // Register through the REAL entry point — the wiring itself is under
      // test (a registration-order bug in index.ts must fail here), not
      // registerSweep in isolation.
      piWorkgraph(asExtensionAPI(mock));
      // Sweep-only session: the dispatch loop would otherwise claim ready
      // issues in this scratch graph (workgraph-dispatch is the kill switch).
      mock.setFlag("workgraph-dispatch", false);
      mock.setFlag("workgraph-worker-id", "rclw-sweeper");
      mock.setFlag("workgraph-lease-ttl-ms", String(TTL));
      // index.ts floors the interval to MIN_POLL_MS (5 s) — the wait below
      // budgets for that floor, proving the floor path too.
      mock.setFlag("workgraph-sweep-interval-ms", "1");

      const id = graph.createIssue("orphaned by a dead run");
      const outcome = await acquireLease(graph.dir, {
        issueId: id,
        ttlMs: TTL,
        actor: { holder: "rclw-a", bdActor: "rclw-a" },
      });
      expect(outcome.kind).toBe("acquired");
      // The dead worker is gone; so is its in-process registry entry.
      resetLeasesForTest();

      await mock.emit("session_start", { type: "session_start" }, ectx.ctx);
      try {
        // Expiry (2 s) + floored interval (5 s) + bd latency headroom. The
        // sweep cycle is reclaim → release → release AUDIT, each a separate
        // serialized bd exec whose continuations land asynchronously — so
        // the poll waits for the LAST observable effect of the cycle (the
        // release audit comment), not just the status flip: sampling
        // between the release exec and its audit/untrack continuations
        // would race them (the status probe is a synchronous execFileSync
        // that blocks the event loop).
        const deadline = Date.now() + 45_000;
        let shown = graph.showIssue(id);
        let comments: BeadsComment[] = [];
        let releases: BeadsComment[] = [];
        while (Date.now() < deadline) {
          shown = graph.showIssue(id);
          if (shown.status === "open") {
            comments = await listComments(graph.dir, id);
            releases = comments.filter((c) =>
              c.text.startsWith("workgraph-lease release "),
            );
            if (releases.length > 0) break;
          }
          await sleep(250);
        }

        // Reclaimed AND left ready: reopened, unassigned, holder cleared —
        // the sweep never redispatches or keeps the lease for itself.
        expect(shown.status).toBe("open");
        expect(shown.assignee ?? "").toBe("");
        expect(leaseHolderOf(shown)).toBeUndefined();
        // The reclaim bumped the fencing token; the release preserved it.
        expect(leaseEpochOf(shown)).toBe(2);
        // The sweeper's held-lease registry stays clean — a sweep-reclaimed
        // issue is not this session's work.
        expect(heldLeases(graph.dir)).toHaveLength(0);
        const reclaims = comments.filter((c) =>
          c.text.startsWith("workgraph-lease reclaim "),
        );
        expect(reclaims).toHaveLength(1);
        expect(reclaims[0]!.text).toContain('"from":"rclw-a"');
        expect(releases).toHaveLength(1);
      } finally {
        await mock.emit(
          "session_shutdown",
          { type: "session_shutdown" },
          ectx.ctx,
        );
      }
    } finally {
      resetLeasesForTest();
      graph.cleanup();
    }
  }, 120_000);

  it("two sweepers racing one expired lease reclaim it exactly once, with one audit record", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcl2" });
    try {
      const id = graph.createIssue("contended reclaim");
      await acquireLease(graph.dir, {
        issueId: id,
        ttlMs: TTL,
        actor: { holder: "rcl2-a", bdActor: "rcl2-a" },
      });
      resetLeasesForTest();

      // Freeze-shift past expiry (the src/lease.test.ts sweep pattern).
      const opts = { ttlMs: TTL, now: () => Date.now() + TTL + 2_000 };
      const [victim] = await findExpired(graph.dir, opts);
      expect(victim?.id).toBe(id);

      // Two sweepers, one victim snapshot. reclaim() captures workerId()
      // SYNCHRONOUSLY at entry, so flipping the override between the two
      // calls gives each concurrent racer its own identity.
      setWorkerIdOverride("rcl2-s1");
      const p1 = reclaim(graph.dir, victim!, opts);
      setWorkerIdOverride("rcl2-s2");
      const p2 = reclaim(graph.dir, victim!, opts);
      const [r1, r2] = await Promise.all([p1, p2]);

      // Post-write verification elects exactly one winner; the loser
      // returns null and never writes an audit record (the de-dup).
      const winners = [r1, r2].filter((l): l is Lease => l !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({ issueId: id, epoch: 2 });

      const shown = graph.showIssue(id);
      expect(["rcl2-s1", "rcl2-s2"]).toContain(leaseHolderOf(shown));
      expect(leaseEpochOf(shown)).toBe(2);

      // Read through the exec queue: reclaim's audit is fire-and-forget,
      // and queue ordering guarantees it landed before this read.
      const comments: BeadsComment[] = await listComments(graph.dir, id);
      const reclaims = comments.filter((c) =>
        c.text.startsWith("workgraph-lease reclaim "),
      );
      expect(reclaims).toHaveLength(1);
    } finally {
      resetLeasesForTest();
      graph.cleanup();
    }
  }, 120_000);

  it("a tick during an in-flight tick is suppressed (not queued); idle ticks write nothing; session events drive the timer", async () => {
    resetLeasesForTest();
    const graph = makeScratchGraph({ prefix: "rcl3" });
    const mock = makeMockPi();
    bindExec((command, args, options) => mock.exec(command, args, options));
    const ectx = makeEventContext(graph.dir);
    try {
      const controller = registerSweep(asExtensionAPI(mock), {
        // Huge interval: the timer never fires mid-test; ticks are driven
        // through the controller (the test/dispatch.test.ts pattern).
        getConfig: () => ({
          leaseTtlMs: TTL,
          heartbeatMs: 600_000,
          pollMs: 600_000,
          sweepIntervalMs: 600_000,
          discoveryTimeoutMs: 40, // unused by the sweep — config-shape only
          acceptTimeoutMs: 150,
          compatInSessionExecutor: false,
        }),
      });

      // Warm-up tick (one-time workspace probes), then measure a solo tick.
      await controller.tick(ectx.ctx);
      const beforeSolo = mock.execCalls.length;
      await controller.tick(ectx.ctx);
      const soloCalls = mock.execCalls.length - beforeSolo;
      expect(soloCalls).toBeGreaterThan(0);

      // Nothing expired → the tick is read-only: zero bd writes.
      const idleCalls = mock.execCalls.slice(beforeSolo);
      expect(
        idleCalls.filter(
          (c) => c.args.includes("update") || c.args.includes("comment"),
        ),
      ).toHaveLength(0);

      // Reentrancy: the guard is set synchronously before any await, so a
      // tick fired while one is in flight adds ZERO bd calls — suppressed,
      // not queued behind it.
      const beforePair = mock.execCalls.length;
      const inFlight = controller.tick(ectx.ctx);
      const suppressed = controller.tick(ectx.ctx);
      await Promise.all([inFlight, suppressed]);
      expect(mock.execCalls.length - beforePair).toBe(soloCalls);

      // Timer lifecycle mirrors dispatch: session_start starts (idempotent
      // restart), session_shutdown tears down.
      expect(controller.timerActive()).toBe(false);
      await mock.emit("session_start", { type: "session_start" }, ectx.ctx);
      expect(controller.timerActive()).toBe(true);
      await mock.emit("session_start", { type: "session_start" }, ectx.ctx);
      expect(controller.timerActive()).toBe(true);
      await mock.emit(
        "session_shutdown",
        { type: "session_shutdown" },
        ectx.ctx,
      );
      expect(controller.timerActive()).toBe(false);
    } finally {
      resetLeasesForTest();
      graph.cleanup();
    }
  }, 60_000);
});
