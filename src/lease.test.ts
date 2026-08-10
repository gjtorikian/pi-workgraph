/**
 * Lease-layer unit tests: epoch protocol, renewal idempotence, verification,
 * release, and sweep filtering — against a real scratch bd database with an
 * injected clock (never a mocked bd, never a lying fake timer).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAuditForTest } from "./audit.ts";
import { bindExec, listComments } from "./bd.ts";
import {
  defaultLeaseActor,
  resetIdentityForTest,
  setWorkerIdOverride,
} from "./identity.ts";
import {
  acquireLease,
  FencingError,
  getHeldLease,
  leaseEpochOf,
  leaseExpiresAtOf,
  leaseHolderOf,
  releaseLease,
  renewLease,
  resetLeasesForTest,
  verifyHolding,
} from "./lease.ts";
import { findExpired, reclaim, resetSweepForTest } from "./sweep.ts";
import type { BeadsComment } from "./bd.ts";
import { makeMockPi, type MockPi } from "../test/helpers/mock-pi.ts";
import {
  makeScratchGraph,
  type ScratchGraph,
} from "../test/helpers/scratch.ts";

const TTL = 2_000; // compressed test TTL — lease expiry in seconds, not minutes

let mock: MockPi;

/** A clock shifted `deltaMs` from real time. */
const shifted = (deltaMs: number) => () => Date.now() + deltaMs;

/**
 * Audit comments of one kind on an issue. Reads through the exec QUEUE
 * (listComments), not scratch's execFileSync — reclaim's audit write is
 * fire-and-forget, and queue ordering is what guarantees it landed before
 * this read.
 */
async function auditRecords(
  graph: ScratchGraph,
  id: string,
  kind: string,
): Promise<BeadsComment[]> {
  const all = await listComments(graph.dir, id);
  return all.filter((c) => c.text.startsWith(`workgraph-lease ${kind} `));
}

beforeAll(() => {
  mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
}, 60_000);

beforeEach(() => {
  resetLeasesForTest();
  resetAuditForTest();
  resetSweepForTest();
  setWorkerIdOverride("w-alpha");
});

afterAll(() => {
  resetIdentityForTest();
});

describe("acquireLease", () => {
  it("stamps the lease trio on first acquire: epoch 1, holder, RFC3339 expiry", async () => {
    const graph = makeScratchGraph({ prefix: "lac" });
    try {
      const id = graph.createIssue("lease me");
      const outcome = await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      expect(outcome.kind).toBe("acquired");
      if (outcome.kind !== "acquired") return;
      expect(outcome.renewal).toBe(false);
      expect(outcome.lease).toMatchObject({ issueId: id, epoch: 1 });

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(shown.assignee).toBe("w-alpha");
      expect(leaseHolderOf(shown)).toBe("w-alpha");
      expect(leaseEpochOf(shown)).toBe(1);
      const expires = leaseExpiresAtOf(shown);
      expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(Date.parse(expires!)).toBeGreaterThan(Date.now() - 1_000);

      expect(getHeldLease(graph.dir, id)).toMatchObject({ issueId: id, epoch: 1 });
      expect(await auditRecords(graph, id, "claim")).toHaveLength(1);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("claim-next path: acquires the ready issue, or reports an empty pool", async () => {
    const graph = makeScratchGraph({ prefix: "lnx" });
    try {
      await expect(acquireLease(graph.dir, { ttlMs: TTL, actor: defaultLeaseActor() })).resolves.toEqual({
        kind: "empty",
      });
      const id = graph.createIssue("next up");
      const outcome = await acquireLease(graph.dir, { ttlMs: TTL, actor: defaultLeaseActor() });
      expect(outcome.kind).toBe("acquired");
      if (outcome.kind === "acquired") {
        expect(outcome.issue.id).toBe(id);
        expect(outcome.lease.epoch).toBe(1);
      }
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("re-acquire by the same worker is a renewal — the epoch does NOT double-increment", async () => {
    const graph = makeScratchGraph({ prefix: "lre" });
    try {
      const id = graph.createIssue("mine already");
      await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      const again = await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      expect(again.kind).toBe("acquired");
      if (again.kind === "acquired") {
        expect(again.renewal).toBe(true);
        expect(again.lease.epoch).toBe(1);
      }
      expect(leaseEpochOf(graph.showIssue(id))).toBe(1);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("surfaces bd's conflict verbatim when another actor holds the claim", async () => {
    const graph = makeScratchGraph({ prefix: "lcf" });
    try {
      const id = graph.createIssue("contested");
      graph.bd(["update", id, "--claim", "--actor", "someone-else"]);
      await expect(
        acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() }),
      ).rejects.toThrow(/already claimed/);
    } finally {
      graph.cleanup();
    }
  }, 30_000);
});

describe("verifyHolding", () => {
  it("is true while the epoch and holder are current, false after a simulated reclaim", async () => {
    const graph = makeScratchGraph({ prefix: "lvh" });
    try {
      const id = graph.createIssue("verify me");
      const outcome = await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      if (outcome.kind !== "acquired") throw new Error("acquire failed");
      await expect(verifyHolding(graph.dir, outcome.lease, "w-alpha")).resolves.toBe(true);

      // Simulated reclaim: a manual epoch bump — the exact signal a stale
      // holder must abort on.
      graph.bd(["update", id, "--set-metadata", "lease_epoch=99"]);
      await expect(verifyHolding(graph.dir, outcome.lease, "w-alpha")).resolves.toBe(false);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("is false when the holder changed even at the same epoch", async () => {
    const graph = makeScratchGraph({ prefix: "lvh2" });
    try {
      const id = graph.createIssue("stolen holder");
      const outcome = await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      if (outcome.kind !== "acquired") throw new Error("acquire failed");
      graph.bd(["update", id, "--set-metadata", "lease_holder=w-other"]);
      await expect(verifyHolding(graph.dir, outcome.lease, "w-alpha")).resolves.toBe(false);
    } finally {
      graph.cleanup();
    }
  }, 30_000);
});

describe("renewLease", () => {
  it("extends the expiry at the same epoch", async () => {
    const graph = makeScratchGraph({ prefix: "lrn" });
    try {
      const id = graph.createIssue("keep alive");
      const outcome = await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      if (outcome.kind !== "acquired") throw new Error("acquire failed");
      const before = outcome.lease.expiresAt;

      const renewed = await renewLease(graph.dir, outcome.lease, {
        ttlMs: TTL,
        now: shifted(5_000),
        actor: defaultLeaseActor(),
      });
      expect(renewed.epoch).toBe(outcome.lease.epoch);
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(before));
      expect(leaseExpiresAtOf(graph.showIssue(id))).toBe(renewed.expiresAt);
      expect(getHeldLease(graph.dir, id)?.expiresAt).toBe(renewed.expiresAt);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("throws FencingError (and untracks) once the lease was reclaimed", async () => {
    const graph = makeScratchGraph({ prefix: "lrn2" });
    try {
      const id = graph.createIssue("reclaimed under me");
      const outcome = await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      if (outcome.kind !== "acquired") throw new Error("acquire failed");
      graph.bd([
        "update",
        id,
        "--set-metadata",
        "lease_epoch=2",
        "--set-metadata",
        "lease_holder=w-thief",
      ]);
      await expect(
        renewLease(graph.dir, outcome.lease, { ttlMs: TTL, actor: defaultLeaseActor() }),
      ).rejects.toThrow(FencingError);
      expect(getHeldLease(graph.dir, id)).toBeUndefined();
    } finally {
      graph.cleanup();
    }
  }, 30_000);
});

describe("releaseLease", () => {
  it("clears assignee + holder/expiry, reopens, audits — and the epoch survives", async () => {
    const graph = makeScratchGraph({ prefix: "lrl" });
    try {
      const id = graph.createIssue("hand back");
      const outcome = await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      if (outcome.kind !== "acquired") throw new Error("acquire failed");

      await releaseLease(graph.dir, outcome.lease, defaultLeaseActor());
      const shown = graph.showIssue(id);
      expect(shown.status).toBe("open");
      expect(shown.assignee ?? "").toBe("");
      expect(leaseHolderOf(shown)).toBeUndefined();
      expect(leaseExpiresAtOf(shown)).toBeUndefined();
      // The fencing token is monotonic per issue — release must NOT reset it.
      expect(leaseEpochOf(shown)).toBe(1);
      expect(getHeldLease(graph.dir, id)).toBeUndefined();
      expect(await auditRecords(graph, id, "release")).toHaveLength(1);

      // Epoch never resets across release/re-acquire cycles.
      const again = await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      expect(again.kind).toBe("acquired");
      if (again.kind === "acquired") expect(again.lease.epoch).toBe(2);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("throws FencingError instead of releasing a reclaimed lease", async () => {
    const graph = makeScratchGraph({ prefix: "lrl2" });
    try {
      const id = graph.createIssue("not yours anymore");
      const outcome = await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      if (outcome.kind !== "acquired") throw new Error("acquire failed");
      graph.bd(["update", id, "--set-metadata", "lease_epoch=5"]);
      await expect(releaseLease(graph.dir, outcome.lease, defaultLeaseActor())).rejects.toThrow(
        FencingError,
      );
      // The new holder's claim is untouched.
      expect(graph.showIssue(id).status).toBe("in_progress");
    } finally {
      graph.cleanup();
    }
  }, 30_000);
});

describe("sweep", () => {
  it("findExpired skips freshly-claimed issues (recent updated_at)", async () => {
    const graph = makeScratchGraph({ prefix: "lsw" });
    try {
      const id = graph.createIssue("fresh");
      await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      await expect(findExpired(graph.dir, { ttlMs: TTL })).resolves.toEqual([]);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("findExpired returns issues that are stale AND lease-expired", async () => {
    const graph = makeScratchGraph({ prefix: "lsw2" });
    try {
      const id = graph.createIssue("gone quiet");
      await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      // Freeze-shift: the injected clock jumps past TTL so both conditions
      // (updated_at < now-TTL, lease_expires_at < now) hold without sleeping.
      const expired = await findExpired(graph.dir, {
        ttlMs: TTL,
        now: shifted(TTL + 2_000),
      });
      expect(expired.map((i) => i.id)).toEqual([id]);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("clock-skew guard: expired-by-metadata but recent updated_at is NOT swept", async () => {
    const graph = makeScratchGraph({ prefix: "lsw3" });
    try {
      const id = graph.createIssue("skewed worker");
      // A worker whose clock is behind writes an already-past expiry — but
      // its write just bumped updated_at, so the server-side filter holds.
      await acquireLease(graph.dir, {
        issueId: id,
        ttlMs: TTL,
        now: shifted(-60_000),
        actor: defaultLeaseActor(),
      });
      await expect(findExpired(graph.dir, { ttlMs: TTL })).resolves.toEqual([]);
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("legacy no-lease claims are flagged expire-detected once, never reclaimed", async () => {
    const graph = makeScratchGraph({ prefix: "lsw4" });
    try {
      const id = graph.createIssue("manual human claim");
      graph.bd(["update", id, "--claim", "--actor", "a-human"]);

      const opts = { ttlMs: TTL, now: shifted(TTL + 2_000) };
      await expect(findExpired(graph.dir, opts)).resolves.toEqual([]);
      expect(await auditRecords(graph, id, "expire-detected")).toHaveLength(1);
      // Re-sweeping does not spam the trail.
      await expect(findExpired(graph.dir, opts)).resolves.toEqual([]);
      expect(await auditRecords(graph, id, "expire-detected")).toHaveLength(1);
      // Still the human's claim.
      expect(graph.showIssue(id).assignee).toBe("a-human");
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("reclaim bumps the epoch, takes the assignee, and audits who it took from", async () => {
    const graph = makeScratchGraph({ prefix: "lsw5" });
    try {
      const id = graph.createIssue("abandoned");
      await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });

      // The sweeper is a different worker.
      setWorkerIdOverride("w-sweeper");
      const opts = { ttlMs: TTL, now: shifted(TTL + 2_000) };
      const [victim] = await findExpired(graph.dir, opts);
      expect(victim?.id).toBe(id);

      const lease = await reclaim(graph.dir, victim!, opts);
      expect(lease).toMatchObject({ issueId: id, epoch: 2 });

      const shown = graph.showIssue(id);
      expect(shown.assignee).toBe("w-sweeper");
      expect(leaseHolderOf(shown)).toBe("w-sweeper");
      expect(leaseEpochOf(shown)).toBe(2);
      expect(getHeldLease(graph.dir, id)?.epoch).toBe(2);

      const records = await auditRecords(graph, id, "reclaim");
      expect(records).toHaveLength(1);
      expect(records[0]!.text).toContain('"from":"w-alpha"');
      expect(records[0]!.text).toContain('"oldEpoch":1');
    } finally {
      graph.cleanup();
    }
  }, 30_000);

  it("epoch stays monotonic across repeated reclaim cycles (3 reclaims = 3 increments)", async () => {
    const graph = makeScratchGraph({ prefix: "lsw6" });
    try {
      const id = graph.createIssue("hot potato");
      await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });

      for (let i = 1; i <= 3; i++) {
        setWorkerIdOverride(`w-reclaimer-${i}`);
        const opts = { ttlMs: TTL, now: shifted(i * (TTL + 2_000)) };
        const [victim] = await findExpired(graph.dir, opts);
        expect(victim?.id).toBe(id);
        const lease = await reclaim(graph.dir, victim!, opts);
        expect(lease?.epoch).toBe(1 + i);
      }
      expect(leaseEpochOf(graph.showIssue(id))).toBe(4);
    } finally {
      graph.cleanup();
    }
  }, 30_000);
});

describe("audit renew sampling", () => {
  it("records 1-per-N renewals to keep the trail readable", async () => {
    const graph = makeScratchGraph({ prefix: "laud" });
    try {
      const id = graph.createIssue("chatty heartbeat");
      const outcome = await acquireLease(graph.dir, { issueId: id, ttlMs: TTL, actor: defaultLeaseActor() });
      if (outcome.kind !== "acquired") throw new Error("acquire failed");

      let lease = outcome.lease;
      for (let i = 0; i < 3; i++) {
        lease = await renewLease(graph.dir, lease, { ttlMs: TTL, actor: defaultLeaseActor() });
      }
      // 3 renews, sample rate 10 → exactly the first one is recorded.
      expect(await auditRecords(graph, id, "renew")).toHaveLength(1);
      expect(await auditRecords(graph, id, "claim")).toHaveLength(1);
    } finally {
      graph.cleanup();
    }
  }, 30_000);
});
