/**
 * The git push guard (`scripts/git-push-guard.mjs`) as a black box: a real
 * scratch bd graph, the real script in a child process, assertions on exit
 * status — the Lease Convention "merely detects" contract (§4). The guard
 * must never write lease metadata; every case below reads state stamped by
 * bd itself.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeScratchGraph, type ScratchGraph } from "./helpers/scratch.ts";

const SCRIPT = fileURLToPath(
  new URL("../scripts/git-push-guard.mjs", import.meta.url),
);

/** RFC3339 at second precision, matching what lease writers stamp. */
function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stampLease(
  graph: ScratchGraph,
  id: string,
  holder: string,
  expiresAt: string,
): void {
  graph.bd([
    "update",
    id,
    "--set-metadata",
    `lease_holder=${holder}`,
    "--set-metadata",
    "lease_epoch=1",
    "--set-metadata",
    `lease_expires_at=${expiresAt}`,
    "--actor",
    "guard-test",
  ]);
}

interface GuardResult {
  status: number;
  output: string;
}

function runGuard(
  file: string,
  cwd: string,
  env: Record<string, string> = {},
): GuardResult {
  try {
    const out = execFileSync(process.execPath, [file], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Isolate from the developer's real global/system git config.
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...env,
      },
    });
    return { status: 0, output: out };
  } catch (error) {
    const e = error as { status?: number; stderr?: string; stdout?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("git push guard", () => {
  it("walks the decision table against one real graph", () => {
    const graph = makeScratchGraph({ prefix: "guard" });
    try {
      const id = graph.createIssue("sentinel: the stack");
      const configured = { WORKGRAPH_STACK_ISSUE: id };

      // Unconfigured -> inert, even with a graph present.
      expect(runGuard(SCRIPT, graph.dir).status).toBe(0);

      // Configured, never leased -> allow.
      expect(runGuard(SCRIPT, graph.dir, configured).status).toBe(0);

      // Live lease held by someone else -> block, naming holder and issue.
      stampLease(graph, id, "restacker@ci/abc123", rfc3339(Date.now() + 3_600_000));
      const blocked = runGuard(SCRIPT, graph.dir, configured);
      expect(blocked.status).toBe(1);
      expect(blocked.output).toContain("restacker@ci/abc123");
      expect(blocked.output).toContain(id);

      // Same live lease, but the pusher IS the holder -> allow.
      expect(
        runGuard(SCRIPT, graph.dir, {
          ...configured,
          WORKGRAPH_WORKER_ID: "restacker@ci/abc123",
        }).status,
      ).toBe(0);

      // Unparseable expiry -> treated as leased (fail closed).
      stampLease(graph, id, "restacker@ci/abc123", "not-a-timestamp");
      expect(runGuard(SCRIPT, graph.dir, configured).status).toBe(1);

      // Expired lease -> reclaimable, allow.
      stampLease(graph, id, "restacker@ci/abc123", rfc3339(Date.now() - 60_000));
      expect(runGuard(SCRIPT, graph.dir, configured).status).toBe(0);

      // Sentinel that does not exist -> fail closed.
      expect(
        runGuard(SCRIPT, graph.dir, { WORKGRAPH_STACK_ISSUE: "guard-zzz" }).status,
      ).toBe(1);

      // Read-only contract: the guard never wrote lease metadata.
      const meta = graph.showIssue(id).metadata ?? {};
      expect(meta.lease_holder).toBe("restacker@ci/abc123");
      expect(Number(meta.lease_epoch)).toBe(1);
    } finally {
      graph.cleanup();
    }
  }, 60_000);

  it("install chains the pre-existing hook (bd's managed pre-push) and configures the sentinel", () => {
    const graph = makeScratchGraph({ prefix: "guardins" });
    try {
      const id = graph.createIssue("sentinel: the stack");

      // bd init created the git repo, set core.hooksPath=.beads/hooks, and
      // installed its own managed pre-push there. Substitute an observable
      // stand-in for bd's hook so chaining is assertable.
      const hooksDir = execFileSync(
        "git",
        ["rev-parse", "--git-path", "hooks"],
        { cwd: graph.dir, encoding: "utf8" },
      ).trim();
      const hook = join(hooksDir, "pre-push");
      const fake = "#!/bin/sh\necho chained-ran >&2\nexit 7\n";
      writeFileSync(hook, fake);
      chmodSync(hook, 0o755);

      execFileSync(process.execPath, [SCRIPT, "install", "--issue", id], {
        cwd: graph.dir,
        encoding: "utf8",
      });

      // Guard at pre-push, original preserved next to it, config stamped.
      expect(readFileSync(hook, "utf8")).toContain("PI_WORKGRAPH_PUSH_GUARD");
      expect(statSync(hook).mode & 0o111).not.toBe(0);
      expect(readFileSync(`${hook}.pre-workgraph`, "utf8")).toBe(fake);
      expect(
        execFileSync("git", ["config", "--get", "workgraph.stackIssue"], {
          cwd: graph.dir,
          encoding: "utf8",
        }).trim(),
      ).toBe(id);

      // No lease -> guard allows -> the chained hook runs (its status wins).
      const allowed = runGuard(hook, graph.dir);
      expect(allowed.status).toBe(7);
      expect(allowed.output).toContain("chained-ran");

      // Live lease -> block BEFORE the chained hook runs.
      stampLease(graph, id, "restacker@ci/abc123", rfc3339(Date.now() + 3_600_000));
      const blocked = runGuard(hook, graph.dir);
      expect(blocked.status).toBe(1);
      expect(blocked.output).not.toContain("chained-ran");

      // Re-install is idempotent: guard stays, chained original untouched.
      execFileSync(process.execPath, [SCRIPT, "install", "--issue", id], {
        cwd: graph.dir,
        encoding: "utf8",
      });
      expect(readFileSync(hook, "utf8")).toContain("PI_WORKGRAPH_PUSH_GUARD");
      expect(readFileSync(`${hook}.pre-workgraph`, "utf8")).toBe(fake);
    } finally {
      graph.cleanup();
    }
  }, 60_000);
});
