/**
 * Scratch work graphs for tests: a real SQLite workspace in a temp dir,
 * never mocked row shapes — mocking the store's output is how prior art's
 * bugs survived.
 *
 * `op(argv)` is a tiny argv interpreter over the store's synchronous
 * surface. Fixtures use it to simulate what ANOTHER tool or human would do
 * to the graph — a foreign claim, a hand-stamped lease, a comment — in one
 * line, independent of the extension's own code paths. Supported verbs:
 *
 *   init    --prefix <p>
 *   create  <title> [--json] [-t type] [-p n] [-d desc] [--acceptance t]
 *           [--metadata <json>] [--actor a]
 *   show    <id> --json                         → JSON array of one issue
 *   list    [--status s] [-n N] --json          → JSON array
 *   ready   [-u] [-n N] --json                  → JSON array
 *   update  <id> [--claim] [--assignee a] [--status s] [--priority n]
 *           [--title t] [-d desc] [--acceptance t] [--notes t]
 *           [--set-metadata k=v]* [--unset-metadata k]* [--actor a]
 *   close   <id> [--reason r] [--actor a]
 *   comment <id> <text> [--actor a]
 *   comments <id> --json                        → JSON array
 *   dep add <id> --depends-on <id2>
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeWorkspace,
  initWorkspaceSync,
  sync,
  type MetadataValue,
  type UpdateFields,
} from "../../src/store.ts";
import type { WorkIssue } from "../../src/types.ts";

export interface CreateIssueOptions {
  priority?: number;
  issueType?: string;
  description?: string;
  actor?: string;
}

export interface ScratchGraph {
  /** Absolute path of the temp dir holding `.workgraph/`. */
  dir: string;
  /** Issue-id prefix the workspace was initialized with. */
  prefix: string;
  /** Ids of the issues seeded at creation, in creation order. */
  seededIds: string[];
  /** Run one store operation synchronously (setup/assertions only). */
  op(args: string[]): string;
  /** Create one issue and return its id. */
  createIssue(title: string, opts?: CreateIssueOptions): string;
  /** Fetch one issue. */
  showIssue(id: string): WorkIssue;
  /** Close the store handle and delete the temp dir. */
  cleanup(): void;
}

export interface MakeScratchGraphOptions {
  /** Number of issues to seed (default 0). */
  seed?: number;
  /** Issue-id prefix (default "scratch"). */
  prefix?: string;
}

/** Parse `--flag value` / `--flag` / repeated flags out of an argv tail. */
function parseFlags(
  args: string[],
  valued: readonly string[],
  repeated: readonly string[] = [],
): { flags: Map<string, string>; repeats: Map<string, string[]>; positional: string[] } {
  const flags = new Map<string, string>();
  const repeats = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (repeated.includes(arg)) {
      const list = repeats.get(arg) ?? [];
      list.push(args[++i] ?? "");
      repeats.set(arg, list);
    } else if (valued.includes(arg)) {
      flags.set(arg, args[++i] ?? "");
    } else if (arg.startsWith("-")) {
      flags.set(arg, "");
    } else {
      positional.push(arg);
    }
  }
  return { flags, repeats, positional };
}

function kvPairs(entries: string[] | undefined): Record<string, MetadataValue> {
  const out: Record<string, MetadataValue> = {};
  for (const entry of entries ?? []) {
    const eq = entry.indexOf("=");
    if (eq === -1) throw new Error(`scratch op: bad metadata pair "${entry}"`);
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

export function runOp(dir: string, args: string[]): string {
  const [verb, ...rest] = args;
  switch (verb) {
    case "init": {
      const { flags } = parseFlags(rest, ["--prefix"]);
      initWorkspaceSync(dir, { prefix: flags.get("--prefix") });
      return "";
    }
    case "create": {
      const { flags, positional } = parseFlags(rest, [
        "-t",
        "-p",
        "-d",
        "--acceptance",
        "--metadata",
        "--actor",
      ]);
      const title = positional[0];
      if (!title) throw new Error("scratch op: create needs a title");
      const issue = sync.createIssue(
        dir,
        {
          title,
          issueType: flags.get("-t"),
          priority: flags.has("-p") ? Number(flags.get("-p")) : undefined,
          description: flags.get("-d"),
          acceptanceCriteria: flags.get("--acceptance"),
          metadata: flags.has("--metadata")
            ? (JSON.parse(flags.get("--metadata")!) as Record<string, MetadataValue>)
            : undefined,
        },
        flags.get("--actor"),
      );
      return JSON.stringify(issue);
    }
    case "show": {
      const id = rest[0];
      if (!id) throw new Error("scratch op: show needs an id");
      return JSON.stringify([sync.show(dir, id)]);
    }
    case "list": {
      const { flags } = parseFlags(rest, ["--status", "-n"]);
      return JSON.stringify(
        sync.listIssues(dir, {
          status: flags.get("--status"),
          limit: flags.has("-n") ? Number(flags.get("-n")) : 0,
        }),
      );
    }
    case "ready": {
      const { flags } = parseFlags(rest, ["-n"]);
      return JSON.stringify(sync.ready(dir, flags.has("-n") ? Number(flags.get("-n")) : 0));
    }
    case "update": {
      const id = rest[0];
      if (!id) throw new Error("scratch op: update needs an id");
      const { flags, repeats } = parseFlags(
        rest.slice(1),
        ["--assignee", "--status", "--priority", "--title", "-d", "--acceptance", "--notes", "--actor"],
        ["--set-metadata", "--unset-metadata"],
      );
      const actor = flags.get("--actor");
      const metadata = kvPairs(repeats.get("--set-metadata"));
      if (flags.has("--claim")) {
        if (!actor) throw new Error("scratch op: --claim needs --actor");
        sync.claim(dir, id, actor);
      }
      if (flags.has("--assignee")) {
        // A foreign tool writing the assignee directly: the one raw path.
        sync.overwriteAssigneeForReclaim(dir, id, flags.get("--assignee")!, metadata, actor);
      } else if (Object.keys(metadata).length > 0) {
        sync.setMetadata(dir, id, metadata, actor);
      }
      const unset = repeats.get("--unset-metadata");
      if (unset && unset.length > 0) sync.unsetMetadata(dir, id, unset, actor);
      const fields: UpdateFields = {};
      if (flags.has("--status")) fields.status = flags.get("--status");
      if (flags.has("--priority")) fields.priority = Number(flags.get("--priority"));
      if (flags.has("--title")) fields.title = flags.get("--title");
      if (flags.has("-d")) fields.description = flags.get("-d");
      if (flags.has("--acceptance")) fields.acceptance = flags.get("--acceptance");
      if (flags.has("--notes")) fields.notes = flags.get("--notes");
      sync.update(dir, id, fields, actor);
      return "";
    }
    case "close": {
      const id = rest[0];
      if (!id) throw new Error("scratch op: close needs an id");
      const { flags } = parseFlags(rest.slice(1), ["--reason", "--actor"]);
      sync.close(dir, id, flags.get("--reason"), flags.get("--actor"));
      return "";
    }
    case "comment": {
      const [id, ...tail] = rest;
      if (!id) throw new Error("scratch op: comment needs an id");
      const { flags, positional } = parseFlags(tail, ["--actor"]);
      sync.addComment(dir, id, positional.join(" "), flags.get("--actor"));
      return "";
    }
    case "comments": {
      const id = rest[0];
      if (!id) throw new Error("scratch op: comments needs an id");
      return JSON.stringify(sync.listComments(dir, id));
    }
    case "dep": {
      const [sub, id, ...tail] = rest;
      if (sub !== "add" || !id) throw new Error("scratch op: dep add <id> --depends-on <id2>");
      const { flags } = parseFlags(tail, ["--depends-on", "--actor"]);
      const target = flags.get("--depends-on");
      if (!target) throw new Error("scratch op: dep add needs --depends-on");
      sync.addDependency(dir, id, target, flags.get("--actor"));
      return "";
    }
    default:
      throw new Error(`scratch op: unsupported verb "${verb}"`);
  }
}

export function makeScratchGraph(
  opts: MakeScratchGraphOptions = {},
): ScratchGraph {
  const prefix = opts.prefix ?? "scratch";
  const dir = mkdtempSync(join(tmpdir(), "pi-workgraph-"));
  runOp(dir, ["init", "--prefix", prefix]);

  const op = (args: string[]): string => runOp(dir, args);

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
    const issue = JSON.parse(op(args)) as WorkIssue;
    return issue.id;
  };

  const showIssue = (id: string): WorkIssue => sync.show(dir, id);

  const seededIds: string[] = [];
  for (let i = 1; i <= (opts.seed ?? 0); i++) {
    seededIds.push(createIssue(`seed issue ${i}`));
  }

  return {
    dir,
    prefix,
    seededIds,
    op,
    createIssue,
    showIssue,
    cleanup: () => {
      closeWorkspace(dir);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
