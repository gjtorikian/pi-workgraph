/**
 * Contract criterion 1: N concurrent claims on one issue produce exactly one
 * winner. Real cross-process contention — 8 spawned worker processes with
 * distinct identities all target `bd update <id> --claim`; bd serializes
 * cross-process writes via its own lock and exactly one claim lands.
 */
import { describe, expect, it } from "vitest";
import { spawnWorker } from "./helpers/worker-proc.ts";
import { makeScratchGraph } from "./helpers/scratch.ts";

const WORKERS = 8;

describe("claim race (contract criterion 1)", () => {
  it(`${WORKERS} concurrent claims -> exactly 1 winner, final assignee matches`, async () => {
    const graph = makeScratchGraph({ prefix: "race" });
    try {
      const id = graph.createIssue("the prize");

      const workers = Array.from({ length: WORKERS }, (_, i) =>
        spawnWorker({
          mode: "claim",
          cwd: graph.dir,
          issueId: id,
          workerId: `race-w${i + 1}`,
        }),
      );
      const exits = await Promise.all(workers.map((w) => w.exited));

      const winners = exits.filter((e) => e.code === 0);
      const losers = exits.filter((e) => e.code === 1);
      expect(
        winners,
        `expected exactly one exit-0 winner; exits: ${exits
          .map((e) => `${e.code}${e.stderr ? ` (${e.stderr.trim()})` : ""}`)
          .join(", ")}`,
      ).toHaveLength(1);
      // Every loser takes bd's expected conflict path (clean exit 1) —
      // never a crash, never a timeout.
      expect(losers).toHaveLength(WORKERS - 1);

      const winnerIndex = exits.findIndex((e) => e.code === 0);
      const winnerId = `race-w${winnerIndex + 1}`;
      expect(exits[winnerIndex]!.stdout).toContain(`CLAIMED ${winnerId}`);
      for (const loser of losers) expect(loser.stdout).toContain("CONFLICT");

      const shown = graph.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(shown.assignee).toBe(winnerId);
    } finally {
      graph.cleanup();
    }
  }, 120_000);
});
