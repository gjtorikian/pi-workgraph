#!/usr/bin/env node
/**
 * PI_WORKGRAPH_PUSH_GUARD — a git pre-push hook that turns "heads up, I'm
 * restacking — don't push" from an advisory broadcast into verified state,
 * using the pi-workgraph Lease Convention (Convention-Version 1) as a pure
 * DETECTOR: it reads the three lease metadata keys and never writes them.
 *
 * How it works: one designated "sentinel" bd issue stands for the shared
 * git ref space (the stack). Whoever performs a history rewrite claims the
 * sentinel (`workgraph_claim` stamps holder/epoch/expiry and heartbeats);
 * this hook blocks every `git push` in any clone while that lease is live
 * and held by someone else. A crashed restacker never wedges the repo —
 * the lease TTL expires and pushes flow again.
 *
 * Decision table (convention §3/§4 semantics, fail-closed):
 *   no sentinel configured            -> allow (hook is inert)
 *   bd unreachable / issue missing    -> BLOCK (configured guard must not guess)
 *   no lease_expires_at on the issue  -> allow (never leased, or released)
 *   unparseable lease_expires_at      -> BLOCK (treated as leased, like the
 *                                        extension's own sweep)
 *   expiry in the past                -> allow (expired = reclaimable)
 *   live lease, holder == $WORKGRAPH_WORKER_ID -> allow (your own restack)
 *   live lease, anyone else           -> BLOCK with holder + expiry
 *
 * This is a guardrail against agents GUESSING that a pause ended — not
 * against malice. A deliberate human can always `git push --no-verify`;
 * hard guarantees belong in server-side branch protection.
 *
 * Install (per clone; worktrees share it):
 *   node scripts/git-push-guard.mjs install --issue <sentinel-issue-id>
 *
 * CHAINING: bd repos set `core.hooksPath = .beads/hooks` and manage their
 * own pre-push there. Install preserves any existing hook as
 * `pre-push.pre-workgraph`; the guard runs first (a block never reaches
 * bd's hook) and on allow executes the preserved hook with the same
 * arguments and stdin, exiting with its status. A bd upgrade that
 * regenerates its hooks can overwrite the guard — re-run install.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "PI_WORKGRAPH_PUSH_GUARD";

/** Run a command, returning stdout or undefined on any failure. */
function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return undefined;
  }
}

function fail(lines) {
  process.stderr.write(`[workgraph push guard] ${lines.join("\n  ")}\n`);
  process.exit(1);
}

function install(argv) {
  const at = argv.indexOf("--issue");
  const issue = at !== -1 ? argv[at + 1] : undefined;
  if (!issue) fail(["usage: git-push-guard.mjs install --issue <sentinel-issue-id>"]);

  const hooksDir = tryRun("git", ["rev-parse", "--git-path", "hooks"])?.trim();
  if (!hooksDir) fail(["not inside a git repository"]);
  const target = join(hooksDir, "pre-push");
  const chained = `${target}.pre-workgraph`;

  let chainedNote = "";
  const foreign =
    existsSync(target) && !readFileSync(target, "utf8").includes(MARKER);
  if (foreign) {
    if (existsSync(chained)) {
      fail([
        `both ${target} and ${chained} exist and the former is not this guard.`,
        "A hook manager (bd?) likely regenerated pre-push after a previous",
        "install. Resolve manually: keep ONE original at pre-push, delete the",
        "stale pre-push.pre-workgraph, then re-run install.",
      ]);
    }
    renameSync(target, chained);
    chainedNote = ` (existing hook preserved and chained: ${chained})`;
  }
  copyFileSync(fileURLToPath(import.meta.url), target);
  chmodSync(target, 0o755);
  execFileSync("git", ["config", "workgraph.stackIssue", issue]);
  process.stdout.write(
    `[workgraph push guard] installed ${target}; sentinel issue: ${issue}${chainedNote}\n`,
  );
}

/**
 * After the guard allows, hand control to the preserved pre-existing hook
 * (bd's managed pre-push in bd repos) with the same argv and inherited
 * stdio — the guard never consumed stdin, so the ref-update lines git
 * feeds pre-push arrive intact.
 */
function runChained(argv) {
  const chained = `${fileURLToPath(import.meta.url)}.pre-workgraph`;
  if (!existsSync(chained)) return;
  const result = spawnSync(chained, argv, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

function guard() {
  const issueId =
    process.env.WORKGRAPH_STACK_ISSUE?.trim() ||
    tryRun("git", ["config", "--get", "workgraph.stackIssue"])?.trim();
  if (!issueId) return; // unconfigured -> inert

  const shown = tryRun("bd", ["show", issueId, "--json"]);
  const issue = shown === undefined ? undefined : JSON.parse(shown)[0];
  if (!issue || issue.error) {
    fail([
      `cannot verify sentinel issue ${issueId} (bd unreachable or issue missing).`,
      "A configured guard does not guess: fix the sentinel or unset",
      "`git config workgraph.stackIssue` to disable. (Humans: git push --no-verify)",
    ]);
  }

  const meta = issue.metadata ?? {};
  const expiresRaw = meta.lease_expires_at;
  if (expiresRaw === undefined || expiresRaw === "") return; // never leased / released

  const expires = Date.parse(String(expiresRaw));
  if (Number.isNaN(expires)) {
    fail([
      `sentinel ${issueId} carries an unparseable lease_expires_at (${expiresRaw});`,
      "treating it as leased (fail closed). Inspect it: bd show " + issueId,
    ]);
  }
  if (expires <= Date.now()) return; // expired = reclaimable, do not block

  const holder = String(meta.lease_holder ?? "unknown");
  const me = process.env.WORKGRAPH_WORKER_ID?.trim();
  if (me && holder === me) return; // your own restack window

  const seconds = Math.ceil((expires - Date.now()) / 1000);
  fail([
    `push blocked: the ref space is leased for a history rewrite.`,
    `sentinel: ${issueId}  holder: ${holder}`,
    `lease expires: ${new Date(expires).toISOString()} (~${seconds}s; renewed while the holder heartbeats)`,
    "Wait and retry — do NOT assume the rewrite finished. Check: bd show " + issueId,
    "(Humans overriding deliberately: git push --no-verify)",
  ]);
}

const argv = process.argv.slice(2);
if (argv[0] === "install") {
  install(argv);
} else {
  guard(); // exits non-zero on block
  runChained(argv);
}
