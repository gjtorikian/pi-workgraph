/**
 * Scratch bd graphs for tests: a real `bd init`-ed database in a temp dir,
 * never mocked output shapes — mocking bd's JSON is how the prior art's
 * bugs survived.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeadsIssue } from "../../src/types.ts";

export interface CreateIssueOptions {
  priority?: number;
  issueType?: string;
  description?: string;
  actor?: string;
}

export interface ScratchGraph {
  /** Absolute path of the temp dir holding `.beads/`. */
  dir: string;
  /** Issue-id prefix passed to `bd init`. */
  prefix: string;
  /** Ids of the issues seeded at creation, in creation order. */
  seededIds: string[];
  /** Run bd synchronously in the scratch dir (setup/assertions only). */
  bd(args: string[]): string;
  /** Create one issue and return its id. */
  createIssue(title: string, opts?: CreateIssueOptions): string;
  /** Fetch one issue via `bd show --json` (parsed from its array shape). */
  showIssue(id: string): BeadsIssue;
  /** Delete the temp dir. */
  cleanup(): void;
}

export interface MakeScratchGraphOptions {
  /** Number of issues to seed (default 0). */
  seed?: number;
  /** Issue-id prefix (default "scratch"). */
  prefix?: string;
}

export function makeScratchGraph(
  opts: MakeScratchGraphOptions = {},
): ScratchGraph {
  const prefix = opts.prefix ?? "scratch";
  const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-"));
  const bd = (args: string[]): string =>
    execFileSync("bd", args, { cwd: dir, encoding: "utf8" });

  bd(["init", "--prefix", prefix]);

  const createIssue = (title: string, o: CreateIssueOptions = {}): string => {
    const args = [
      "create",
      title,
      "--json",
      "-t",
      o.issueType ?? "task",
      "-p",
      String(o.priority ?? 2),
      "--actor",
      o.actor ?? "seed-actor",
    ];
    if (o.description) args.push("-d", o.description);
    const issue = JSON.parse(bd(args)) as BeadsIssue;
    return issue.id;
  };

  const showIssue = (id: string): BeadsIssue => {
    const issues = JSON.parse(bd(["show", id, "--json"])) as BeadsIssue[];
    const issue = issues[0];
    if (!issue) throw new Error(`scratch graph: issue not found: ${id}`);
    return issue;
  };

  const seededIds: string[] = [];
  for (let i = 1; i <= (opts.seed ?? 0); i++) {
    seededIds.push(createIssue(`seed issue ${i}`));
  }

  return {
    dir,
    prefix,
    seededIds,
    bd,
    createIssue,
    showIssue,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
