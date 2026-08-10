/**
 * Tool handler tests: registration surface, schema validation, output
 * shapes, and error paths — execute() called directly against a scratch
 * graph through the mock pi.
 */
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindExec, listComments } from "./bd.ts";
import { resetIdentityForTest, workerId } from "./identity.ts";
import {
  leaseEpochOf,
  leaseExpiresAtOf,
  leaseHolderOf,
  resetLeasesForTest,
} from "./lease.ts";
import { registerWorkgraphTools } from "./tools.ts";
import {
  ReadyParams,
  SplitParams,
  type BeadsIssue,
  type Lease,
} from "./types.ts";
import {
  asExtensionAPI,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "../test/helpers/mock-pi.ts";
import {
  makeScratchGraph,
  type ScratchGraph,
} from "../test/helpers/scratch.ts";

const TOOL_NAMES = [
  "workgraph_ready",
  "workgraph_claim",
  "workgraph_release",
  "workgraph_close",
  "workgraph_split",
  "workgraph_heartbeat",
  "workgraph_approve",
  "workgraph_override",
  "workgraph_status",
] as const;

let mock: MockPi;
let graph: ScratchGraph;

function tool(name: string) {
  const def = mock.tools.get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def;
}

function run(name: string, params: unknown, cwd: string) {
  return tool(name).execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    makeToolContext(cwd),
  );
}

function resultText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("\n");
}

beforeAll(() => {
  mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  registerWorkgraphTools(asExtensionAPI(mock));
  mock.setFlag("workgraph-worker-id", "test-worker-a");
  graph = makeScratchGraph({ seed: 2 });
}, 60_000);

afterAll(() => {
  graph?.cleanup();
  resetIdentityForTest();
});

describe("registration surface", () => {
  it("registers exactly the nine workgraph tools", () => {
    expect([...mock.tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("every tool is sequential and visible in the system prompt", () => {
    for (const name of TOOL_NAMES) {
      const def = tool(name);
      expect(def.executionMode).toBe("sequential");
      expect(def.promptSnippet).toBeTruthy();
      expect(def.promptGuidelines?.length).toBeGreaterThan(0);
    }
  });
});

describe("schema validation", () => {
  it("rejects workgraph_ready limit outside 1..50 before any handler runs", () => {
    expect(Value.Check(ReadyParams, { limit: 0 })).toBe(false);
    expect(Value.Check(ReadyParams, { limit: 51 })).toBe(false);
    expect(Value.Check(ReadyParams, { limit: 10 })).toBe(true);
    expect(Value.Check(ReadyParams, {})).toBe(true);
  });

  it("rejects workgraph_split with an empty children array", () => {
    expect(Value.Check(SplitParams, { id: "x", children: [] })).toBe(false);
    expect(
      Value.Check(SplitParams, { id: "x", children: [{ title: "a" }] }),
    ).toBe(true);
  });
});

describe("workgraph_ready", () => {
  it("lists seeded issues once approved (phase 3: the default pool is approved work)", async () => {
    for (const id of graph.seededIds) {
      graph.bd([
        "update",
        id,
        "--set-metadata",
        "workgraph_lifecycle_version=1",
        "--set-metadata",
        "workgraph_phase=ready",
      ]);
    }
    const result = await run("workgraph_ready", {}, graph.dir);
    const text = resultText(result);
    for (const id of graph.seededIds) expect(text).toContain(id);
    const issues = (result.details as { issues: BeadsIssue[] }).issues;
    expect(issues).toHaveLength(2);
  });

  it("throws a `bd init` hint outside a beads workspace", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const bare = mkdtempSync(join(tmpdir(), "pi-workgraph-tools-bare-"));
    try {
      await expect(run("workgraph_ready", {}, bare)).rejects.toThrow(
        /bd init/,
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("workgraph_claim", () => {
  it("claims the next ready issue as the configured worker id and attaches the lease", async () => {
    const local = makeScratchGraph({ prefix: "tclaim" });
    try {
      const id = local.createIssue("claim target", { priority: 0 });
      const result = await run("workgraph_claim", {}, local.dir);
      const details = result.details as { issue: BeadsIssue; lease: Lease };
      expect(details.issue.id).toBe(id);
      expect(details.issue.assignee).toBe("test-worker-a");
      expect(workerId()).toBe("test-worker-a");
      expect(resultText(result)).toContain("Claimed as test-worker-a");
      // Phase 2: claiming stamps the lease trio.
      expect(details.lease).toMatchObject({ issueId: id, epoch: 1 });
      const shown = local.showIssue(id);
      expect(leaseHolderOf(shown)).toBe("test-worker-a");
      expect(leaseEpochOf(shown)).toBe(1);
      expect(leaseExpiresAtOf(shown)).toBeTruthy();
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("returns 'nothing ready' on an empty pool instead of throwing", async () => {
    const local = makeScratchGraph({ prefix: "tempty" });
    try {
      const result = await run("workgraph_claim", {}, local.dir);
      expect(resultText(result)).toMatch(/nothing ready/i);
      expect((result.details as { issue: null }).issue).toBeNull();
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("claims a specific id and returns the shown issue", async () => {
    const local = makeScratchGraph({ prefix: "tbyid" });
    try {
      local.createIssue("decoy", { priority: 0 });
      const wanted = local.createIssue("wanted", { priority: 3 });
      const result = await run("workgraph_claim", { id: wanted }, local.dir);
      const issue = (result.details as { issue: BeadsIssue }).issue;
      expect(issue.id).toBe(wanted);
      expect(issue.status).toBe("in_progress");
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("throws the bd conflict (exit-1 stderr surfaced) when already claimed by another actor", async () => {
    const local = makeScratchGraph({ prefix: "tconf" });
    try {
      const id = local.createIssue("contested");
      local.bd(["update", id, "--claim", "--actor", "other-actor"]);
      await expect(run("workgraph_claim", { id }, local.dir)).rejects.toThrow(
        /already claimed/,
      );
    } finally {
      local.cleanup();
    }
  }, 30_000);
});

describe("workgraph_release", () => {
  it("clears the assignee and reopens the issue", async () => {
    const local = makeScratchGraph({ prefix: "trel" });
    try {
      const id = local.createIssue("borrowed");
      await run("workgraph_claim", { id }, local.dir);
      const result = await run("workgraph_release", { id }, local.dir);
      expect(resultText(result)).toContain(`Released ${id}`);
      const issue = local.showIssue(id);
      expect(issue.status).toBe("open");
      expect(issue.assignee ?? "").toBe("");
    } finally {
      local.cleanup();
    }
  }, 30_000);
});

/** Stamp an issue as having passed the judgment gate (phase accepted) —
 *  setup shorthand for close tests; the gate itself is exercised below and
 *  in test/judgment.test.ts. */
function stampAccepted(local: ScratchGraph, id: string): void {
  local.bd([
    "update",
    id,
    "--set-metadata",
    "workgraph_lifecycle_version=1",
    "--set-metadata",
    "workgraph_phase=accepted",
  ]);
}

describe("workgraph_close", () => {
  it("closes a claimed ACCEPTED issue with a reason", async () => {
    const local = makeScratchGraph({ prefix: "tcls" });
    try {
      const id = local.createIssue("wrap up");
      // Close is a holder write (phase 1): claim first so this session
      // holds the lease and passes the fencing check — and (phase 3) only
      // accepted work may close.
      await run("workgraph_claim", { id }, local.dir);
      stampAccepted(local, id);
      const result = await run(
        "workgraph_close",
        { id, reason: "shipped" },
        local.dir,
      );
      expect(resultText(result)).toContain(`Closed ${id}: shipped`);
      expect(local.showIssue(id).status).toBe("closed");
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("closes a claimed accepted issue without a reason", async () => {
    const local = makeScratchGraph({ prefix: "tcls2" });
    try {
      const id = local.createIssue("wrap up quietly");
      await run("workgraph_claim", { id }, local.dir);
      stampAccepted(local, id);
      await run("workgraph_close", { id }, local.dir);
      expect(local.showIssue(id).status).toBe("closed");
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("rejects closing work that has not passed judgment (phase judging)", async () => {
    resetLeasesForTest();
    const local = makeScratchGraph({ prefix: "tcls4" });
    try {
      const id = local.createIssue("still being judged");
      await run("workgraph_claim", { id }, local.dir);
      local.bd([
        "update",
        id,
        "--set-metadata",
        "workgraph_lifecycle_version=1",
        "--set-metadata",
        "workgraph_phase=judging",
      ]);
      await expect(run("workgraph_close", { id }, local.dir)).rejects.toThrow(
        /judg/i,
      );
      expect(local.showIssue(id).status).not.toBe("closed");
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("rejects close without a tracked lease (no unfenced fallback)", async () => {
    resetLeasesForTest();
    const local = makeScratchGraph({ prefix: "tcls3" });
    try {
      const id = local.createIssue("not ours to close");
      // Claimed by ANOTHER actor outside this process: no tracked lease
      // here, so the fenced close must refuse instead of closing their work.
      local.bd(["update", id, "--claim", "--actor", "other-actor"]);
      await expect(run("workgraph_close", { id }, local.dir)).rejects.toThrow(
        /fenc/i,
      );
      const shown = local.showIssue(id);
      expect(shown.status).toBe("in_progress");
      expect(shown.assignee).toBe("other-actor");
    } finally {
      local.cleanup();
    }
  }, 30_000);
});

describe("workgraph_approve", () => {
  it("approves a draft/legacy issue: acceptance persisted, v1 + risk tier stamped, phase ready, audited", async () => {
    const local = makeScratchGraph({ prefix: "tapv" });
    try {
      const id = local.createIssue("needs approval");
      const result = await run(
        "workgraph_approve",
        { id, acceptanceCriteria: "renders the widget", riskTier: "high" },
        local.dir,
      );
      expect(resultText(result)).toContain("risk tier high");
      const shown = local.showIssue(id);
      expect(shown.acceptance_criteria).toBe("renders the widget");
      const metadata = shown.metadata ?? {};
      expect(metadata.workgraph_phase).toBe("ready");
      expect(Number(metadata.workgraph_lifecycle_version)).toBe(1);
      expect(metadata.workgraph_risk_tier).toBe("high");
      const comments = await listComments(local.dir, id);
      expect(
        comments.filter((c) => c.text.startsWith("workgraph-lease approve ")),
      ).toHaveLength(1);
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("refuses to approve work already past draft", async () => {
    const local = makeScratchGraph({ prefix: "tapv2" });
    try {
      const id = local.createIssue("already moving");
      local.bd([
        "update",
        id,
        "--set-metadata",
        "workgraph_lifecycle_version=1",
        "--set-metadata",
        "workgraph_phase=judging",
      ]);
      await expect(
        run("workgraph_approve", { id }, local.dir),
      ).rejects.toThrow(/judging/);
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("re-approves an escalated issue: phase ready, reopened, risk tier restamped", async () => {
    const local = makeScratchGraph({ prefix: "tapv3" });
    try {
      const id = local.createIssue("escalated work");
      // What escalateRun leaves behind: phase escalated, status blocked.
      local.bd([
        "update",
        id,
        "--status",
        "blocked",
        "--set-metadata",
        "workgraph_lifecycle_version=1",
        "--set-metadata",
        "workgraph_phase=escalated",
      ]);
      const result = await run(
        "workgraph_approve",
        { id, riskTier: "low" },
        local.dir,
      );
      expect(resultText(result)).toContain("risk tier low");
      const shown = local.showIssue(id);
      // The documented recovery path: escalated → ready AND out of blocked,
      // so the issue re-enters the coordinator's approved ready pool.
      expect(shown.status).toBe("open");
      const metadata = shown.metadata ?? {};
      expect(metadata.workgraph_phase).toBe("ready");
      expect(metadata.workgraph_risk_tier).toBe("low");
    } finally {
      local.cleanup();
    }
  }, 30_000);
});

describe("workgraph_override", () => {
  it("override-closes a mid-judging issue with the actor and reason audited", async () => {
    const local = makeScratchGraph({ prefix: "tovr" });
    try {
      const id = local.createIssue("stuck in judging");
      // Claimed elsewhere and mid-lifecycle: every normal guard says no.
      local.bd(["update", id, "--claim", "--actor", "other-actor"]);
      local.bd([
        "update",
        id,
        "--set-metadata",
        "workgraph_lifecycle_version=1",
        "--set-metadata",
        "workgraph_phase=judging",
      ]);
      const result = await run(
        "workgraph_override",
        { id, action: "close", reason: "human decision: ship as-is" },
        local.dir,
      );
      expect(resultText(result)).toContain("Override-closed");
      expect(local.showIssue(id).status).toBe("closed");
      const comments = await listComments(local.dir, id);
      const overrides = comments.filter((c) =>
        c.text.startsWith("workgraph-lease override "),
      );
      expect(overrides).toHaveLength(1);
      expect(overrides[0]!.text).toContain("human decision: ship as-is");
      expect(overrides[0]!.text).toContain("test-worker-a"); // actor snapshot
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("override-releases someone else's claim back to the pool", async () => {
    const local = makeScratchGraph({ prefix: "tovr2" });
    try {
      const id = local.createIssue("abandoned claim");
      local.bd(["update", id, "--claim", "--actor", "gone-worker"]);
      await run(
        "workgraph_override",
        { id, action: "release", reason: "worker went away" },
        local.dir,
      );
      const shown = local.showIssue(id);
      expect(shown.status).toBe("open");
      expect(shown.assignee ?? "").toBe("");
      const comments = await listComments(local.dir, id);
      expect(
        comments.filter((c) => c.text.startsWith("workgraph-lease override ")),
      ).toHaveLength(1);
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("override-release resets a mid-judging phase to draft for re-approval", async () => {
    const local = makeScratchGraph({ prefix: "tovr3" });
    try {
      const id = local.createIssue("stranded mid-judging");
      local.bd(["update", id, "--claim", "--actor", "gone-worker"]);
      local.bd([
        "update",
        id,
        "--set-metadata",
        "workgraph_lifecycle_version=1",
        "--set-metadata",
        "workgraph_phase=judging",
      ]);
      const result = await run(
        "workgraph_override",
        { id, action: "release", reason: "stuck run" },
        local.dir,
      );
      expect(resultText(result)).toContain("draft");
      const shown = local.showIssue(id);
      expect(shown.status).toBe("open");
      // Without the reset the issue would be stranded: the coordinator only
      // claims phase ready, and approve refuses mid-flight phases.
      expect((shown.metadata ?? {}).workgraph_phase).toBe("draft");
      const overrides = (await listComments(local.dir, id)).filter((c) =>
        c.text.startsWith("workgraph-lease override "),
      );
      expect(overrides).toHaveLength(1);
      expect(overrides[0]!.text).toContain("judging -> draft"); // audited reset
      // The documented recovery path exists end to end: draft re-approves.
      await run("workgraph_approve", { id }, local.dir);
      expect((local.showIssue(id).metadata ?? {}).workgraph_phase).toBe(
        "ready",
      );
    } finally {
      local.cleanup();
    }
  }, 30_000);
});

describe("workgraph_status", () => {
  it("renders lifecycle, acceptance, run, verdict, and lease state", async () => {
    const local = makeScratchGraph({ prefix: "tsts" });
    try {
      const id = local.createIssue("inspect me");
      await run(
        "workgraph_approve",
        { id, acceptanceCriteria: "all tests green", riskTier: "low" },
        local.dir,
      );
      local.bd([
        "update",
        id,
        "--claim",
        "--actor",
        "run-holder",
        "--set-metadata",
        "workgraph_phase=judging",
        "--set-metadata",
        "workgraph_workflow_run_id=workgraph-run/abc",
        "--set-metadata",
        "workgraph_attempt=2",
        "--set-metadata",
        "workgraph_executor_id=fake-executor",
        "--set-metadata",
        "workgraph_last_verdict=reject blocking=1 advisory=0: perf",
        "--set-metadata",
        "lease_holder=workgraph-run/abc",
        "--set-metadata",
        "lease_epoch=3",
      ]);
      const result = await run("workgraph_status", { id }, local.dir);
      const text = resultText(result);
      expect(text).toContain("phase judging");
      expect(text).toContain("Acceptance: all tests green");
      expect(text).toContain("Risk tier: low");
      expect(text).toContain("Run: workgraph-run/abc (attempt 2) via fake-executor");
      expect(text).toContain("Last verdict: reject blocking=1");
      expect(text).toContain("held by workgraph-run/abc (epoch 3");
      const details = result.details as { phase: string | null };
      expect(details.phase).toBe("judging");
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("labels legacy issues as awaiting approval", async () => {
    const local = makeScratchGraph({ prefix: "tsts2" });
    try {
      const id = local.createIssue("legacy artifact");
      const result = await run("workgraph_status", { id }, local.dir);
      expect(resultText(result)).toContain("legacy (not yet approved");
    } finally {
      local.cleanup();
    }
  }, 30_000);
});

describe("workgraph_ready lifecycle filter", () => {
  it("defaults to approved ready issues; legacy: true lists the rest", async () => {
    const local = makeScratchGraph({ prefix: "tmix" });
    try {
      const legacyId = local.createIssue("legacy issue");
      const approvedId = local.createIssue("approved issue");
      await run("workgraph_approve", { id: approvedId }, local.dir);

      const approved = await run("workgraph_ready", {}, local.dir);
      const approvedText = resultText(approved);
      expect(approvedText).toContain(approvedId);
      expect(approvedText).not.toContain(legacyId);

      const legacy = await run("workgraph_ready", { legacy: true }, local.dir);
      const legacyText = resultText(legacy);
      expect(legacyText).toContain(legacyId);
      expect(legacyText).not.toContain(approvedId);
    } finally {
      local.cleanup();
    }
  }, 30_000);
});

describe("workgraph_split", () => {
  it("creates children and blocks the parent on each of them", async () => {
    const local = makeScratchGraph({ prefix: "tsplit" });
    try {
      const parent = local.createIssue("too big", { priority: 1 });
      const result = await run(
        "workgraph_split",
        {
          id: parent,
          children: [
            { title: "first half" },
            { title: "second half", priority: 2 },
          ],
        },
        local.dir,
      );
      const children = (result.details as { children: BeadsIssue[] }).children;
      expect(children).toHaveLength(2);
      // Unset child priority inherits the parent's.
      expect(children[0]!.priority).toBe(1);
      expect(children[1]!.priority).toBe(2);
      const shown = local.showIssue(parent);
      const depIds = shown.dependencies?.map((d) => d.id) ?? [];
      for (const child of children) expect(depIds).toContain(child.id);
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("fails before creating any children when the parent does not exist", async () => {
    const local = makeScratchGraph({ prefix: "tsplitx" });
    try {
      await expect(
        run(
          "workgraph_split",
          { id: `${local.prefix}-nope`, children: [{ title: "orphan" }] },
          local.dir,
        ),
      ).rejects.toThrow();
      const listed = JSON.parse(
        local.bd(["list", "--json"]),
      ) as BeadsIssue[];
      expect(listed.every((i) => i.title !== "orphan")).toBe(true);
    } finally {
      local.cleanup();
    }
  }, 30_000);
});

describe("workgraph_heartbeat", () => {
  it("reports no active lease when this process holds nothing", async () => {
    resetLeasesForTest(); // earlier claim tests tracked leases in now-deleted dirs
    const result = await run("workgraph_heartbeat", {}, graph.dir);
    expect(resultText(result)).toMatch(/no active lease/i);
    expect((result.details as { renewed: boolean }).renewed).toBe(false);
  });

  it("renews the lease acquired by workgraph_claim (same epoch, fresh expiry)", async () => {
    resetLeasesForTest();
    const local = makeScratchGraph({ prefix: "thb" });
    try {
      const id = local.createIssue("keep me alive", { priority: 0 });
      await run("workgraph_claim", {}, local.dir);
      const before = leaseExpiresAtOf(local.showIssue(id))!;

      // Second-precision expiry: step past the current second so the renewed
      // timestamp is observably newer.
      await new Promise((r) => setTimeout(r, 1_100));
      const result = await run("workgraph_heartbeat", {}, local.dir);
      expect(resultText(result)).toContain(`Renewed 1 lease(s)`);
      const details = result.details as { renewed: boolean; leases: Lease[] };
      expect(details.renewed).toBe(true);
      expect(details.leases).toHaveLength(1);
      expect(details.leases[0]!.epoch).toBe(1);

      const shown = local.showIssue(id);
      expect(leaseEpochOf(shown)).toBe(1);
      expect(Date.parse(leaseExpiresAtOf(shown)!)).toBeGreaterThan(
        Date.parse(before),
      );
    } finally {
      local.cleanup();
    }
  }, 30_000);

  it("surfaces a reclaimed lease as an error and does not keep renewing it", async () => {
    resetLeasesForTest();
    const local = makeScratchGraph({ prefix: "thb2" });
    try {
      const id = local.createIssue("stolen mid-work", { priority: 0 });
      await run("workgraph_claim", {}, local.dir);
      // Simulated reclaim by another worker: epoch bump + holder change.
      local.bd([
        "update",
        id,
        "--set-metadata",
        "lease_epoch=2",
        "--set-metadata",
        "lease_holder=w-thief",
      ]);
      await expect(run("workgraph_heartbeat", {}, local.dir)).rejects.toThrow(
        /reclaimed by w-thief/,
      );
      // The lost lease is untracked; the next heartbeat is a clean no-op.
      const result = await run("workgraph_heartbeat", {}, local.dir);
      expect(resultText(result)).toMatch(/no active lease/i);
    } finally {
      local.cleanup();
    }
  }, 30_000);
});
