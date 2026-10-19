# pi-workgraph

A [Pi](https://github.com/earendil-works/pi) extension that gives agents a
durable, harness-neutral work **control plane**: a dependency-aware work
graph in a per-repository SQLite database (Node's built-in `node:sqlite` —
nothing to install, nothing to check in), typed tools for agents, expiring
leases with fencing, an approval-gated lifecycle with a **human plan gate**
and an independent judgment gate, **model tiers** that route each role to
the right model, and a coordinator that delegates execution to pluggable
executor adapters over versioned protocol envelopes.

The shape of a run: **a strong model plans, you approve the plan, a fast
model builds, an independent model reviews** — which model plays which
role is a table you declare once in your Pi settings.
Which executor performs each step — the chat session itself, a
pi-subagents worker in its own worktree, or your own adapter — is swappable
without touching the control plane.

## The three roles

pi-workgraph owns only the state and invariants that must survive agents,
sessions, harnesses, and machines. Everything else is delegated:

```text
┌───────────────────────────┐    workgraph:v1:* envelopes    ┌───────────────────────────┐
│ WORK AUTHORITY            │ ─────────────────────────────► │ EXECUTION                 │
│ pi-workgraph + its store  │   discover / offer / request   │ executor adapters:        │
│ issues & dependencies,    │ ◄───────────────────────────── │ · in-session (plans and   │
│ atomic claims, expiring   │    accept / complete / status  │   implements in the chat) │
│ leases + fencing, the     │                                │ · pi-subagents bridge     │
│ plan gate, the approval → │                                │   (opt-in, worktrees)     │
│ judgment lifecycle, audit │                                │ · your adapter            │
└───────────┬───────────────┘                                └───────────────────────────┘
            │ post-commit activity events + audit comments
            ▼
┌───────────────────────────┐
│ COMMUNICATION             │
│ UI / presence / kanban    │
│ observers; remote         │
│ transports (Agent IRC     │
│ adapter contract)         │
└───────────────────────────┘
```

- **Work authority** — this package and its store: what the work is, who
  may touch it, and what state it is in. The core never executes model
  work itself and never routes models; it selects executors by role.
- **Execution** — adapters that answer discovery and run planning,
  implementation, review, revision, and verification requests. The
  in-session adapter (the local "wake this agent" behavior exposed through
  the executor protocol) ships enabled and offers the planner and
  implementer roles; the
  [pi-subagents bridge](#6-optional-executor-the-pi-subagents-bridge)
  ships disabled.
- **Communication** — observers of the audit trail and
  `workgraph:v1:activity` events, and remote transports via the
  [Agent IRC transport adapter contract](docs/agent-irc-transport.md)
  (documented, deliberately not implemented here).

## Requirements

- [Pi](https://github.com/earendil-works/pi) ≥ 0.83
- Node ≥ 22.13 (the store is `node:sqlite`; Pi loads the TypeScript source
  directly — no build step, no native dependency)

## Install

```bash
pi install npm:pi-workgraph
```

## Quickstart

```bash
pi
```

```text
> set up workgraph for this feature: retry backoff on the API client, with
  exponential backoff covered by tests
```

No flags, no model names in the prompt: the roster comes from your Pi
settings (see [Model tiers](#model-tiers)). The agent calls `workgraph_init`
(creates `.workgraph/workgraph.db` with its own `.gitignore`) and `workgraph_create`
with `approve: true` and `workflowClass: "planned"`, which stamps lifecycle
metadata, a risk tier, and the workflow class, and puts the issue in phase
`ready`. On the next
idle tick the coordinator discovers an executor that offers the planner
role, claims the issue under a workflow-run lease, and asks for a plan.

```text
> show the plan for bdx-001          → workgraph_status renders the steps
> approve the plan                   → workgraph_approve_plan
> reject it: add jitter and tests    → workgraph_approve_plan (reject)
```

A recorded plan parks the issue in phase **`plan_review`** with its lease
released; every turn's context lists "Plans awaiting your review". Approve
it and the next tick claims the issue for an **implementer** with the plan
attached (a different executor if one offers the role — that is where
subagents come in). Reject it with feedback and the next tick plans again,
feedback attached. After implementation an independent reviewer checks the
acceptance criteria, bounded revision rounds fix findings, and only
policy-approved judgment closes the issue.

Choose workflow depth at creation (or approval) time:

```text
> create "..." as oneshot, risk low, with acceptance criteria "..."
> create "..." as reviewed, risk medium, with acceptance criteria "..."
> create "..." as planned, risk high, with acceptance criteria "..."
```

`workflowClass` and `riskTier` are separate axes. Workflow class selects
the execution topology; risk controls judgment strictness. Because a
one-shot skips independent judgment, a medium/high-risk one-shot request is
promoted to `reviewed`. A failed/blocked low-risk one-shot is also promoted
to `reviewed` and returned to the ready pool automatically. Reviewed work
that exhausts its revision bound or repeats the same blocking verdict is
promoted once to `planned`; failure to converge after planning escalates to
blocked as before.

Prefer tools without autonomy? Disable the coordinator and keep everything
else:

```bash
pi --workgraph-dispatch=false
```

## Plan, approve, build

`planned` work runs through the human gate by default
(`--workgraph-plan-approval required`):

```text
ready ──claim (planner)──► planning ──plan recorded──► plan_review
                                                          │ lease released
          workgraph_approve_plan approve ◄────────────────┤
          ready (plan approved) ──claim (implementer, plan attached)──► implementing → judging → …
          workgraph_approve_plan reject + feedback ◄──────┘
          ready ──claim (planner, feedback attached)──► planning → plan_review …
```

- The planner is whichever executor offers the role. In-session, the
  planning turn reads the repository and submits its plan through the
  `workgraph_submit_plan` tool (a turn that ends without one is a failure
  and escalates — never a silent unplanned implementation). The
  pi-subagents bridge plans in a child with structured output.
- The plan is **evidence, not authority**: the full plan lives in the
  `workgraph-plan` comment trail, the compact summary in
  `workgraph_plan_summary`, and the implementer receives the rendered
  steps. A planner's refined acceptance criteria never overwrite the
  approved ones.
- Approval is a metadata flag (`workgraph_plan_approved`) the claim path
  honors; re-approving an escalated issue clears it, so escalated planned
  work plans afresh. Rejection stores `workgraph_plan_feedback`, which the
  next planner request carries and the next recorded plan consumes.
- `--workgraph-plan-approval auto` restores the straight-through planner →
  implementer flow.

## Model tiers

One table routes roles to models, for every executor at once. Declare it
once in Pi's settings and it applies to every session, no flags and no
prompting:

```jsonc
// ~/.pi/agent/settings.json (every repository) or .pi/settings.json (one repository)
{
  "workgraph": {
    "tiers": {
      "planner":     { "model": "anthropic/claude-opus-*",   "thinking": "high" },
      "implementer": { "model": "anthropic/claude-sonnet-*", "thinking": "medium" },
      "reviewer":    { "model": "anthropic/claude-opus-*",   "thinking": "high" },
      "revision":    { "model": "anthropic/claude-sonnet-*", "thinking": "medium" },
      "scout":       { "model": "anthropic/claude-haiku-*",  "thinking": "low" }
    },
    "planApproval": "required"
  }
}
```

There are no built-in presets: the table is yours. A bare `"provider/id"`
string is allowed, but an unset `thinking` is not "off" — it **inherits**:
in session, the current thinking level (your global default, if you set
one); in pi-subagents, the launched profile's default. Set it explicitly
for any role you care about.
Roles: `planner`, `implementer`, `reviewer`, `revision`, `verifier`,
`finalizer`, and `scout` (reserved for the read-only research helper; it
can be named now and is dispatched once that role lands).

From inside a session, `workgraph_tiers` sets or shows the table for the
current repository (stored in its workspace), and `/workgraph tiers
[json|off]` is the slash form. Precedence, most explicit first:

1. `--workgraph-tiers` flag or `WORKGRAPH_TIERS` env (headless/CI overrides)
2. `.pi/settings.json` in the repository
3. what `workgraph_tiers` stored in the repository's workspace
4. `~/.pi/agent/settings.json`

`planApproval` follows the same files (flag/env > project > global).

## Where the store lives

By default each repository keeps its graph in `.workgraph/workgraph.db`
inside the checkout — found by walking up from the session's cwd like git
finds `.git`, and gitignored by its own `.gitignore`. If you would rather
have nothing in the checkout at all:

```jsonc
{ "workgraph": { "store": "central" } }      // ~/.pi/agent/workgraph/<repo-key>/workgraph.db
{ "workgraph": { "store": "~/work-graphs" } } // the same layout under a directory you choose
```

`<repo-key>` is the checkout's basename plus a short hash of its absolute
path (a `repo` file beside the database names it). The key is the **main**
checkout: a git worktree resolves through its `.git` file, so pi-subagents
workers see the graph of the session that dispatched them. An existing
in-repo `.workgraph/` always wins, so switching the setting never strands a
graph; it decides where new workspaces are created and where to look when
the repository has none. `--workgraph-store` / `WORKGRAPH_STORE` is the
headless override.

## Who runs what

Roles go to executors the same way: declare it once, next to the tiers.
Without pins, every role goes to the highest-priority executor that offers
it — and the pi-subagents bridge offers the planner role, so with the
bridge enabled planning would leave your session. Pin it:

```jsonc
{
  "workgraph": {
    "executors": {
      "planner": "in-session",          // plan in the chat, with you watching
      "implementer": "pi-subagents",    // build in a worktree
      "reviewer": "pi-subagents",       // independent review in a fresh child
      "revision": "pi-subagents"
    },
    "subagentsExecutor": true          // enable the bridge here too — no flag needed
  }
}
```

A pinned executor that does not offer the role means **no claim** (same
fail-closed rule as `--workgraph-executor-id`, which these override role by
role). Executor ids: `in-session` and `pi-subagents`; your own adapter's
`executorId` works the same way. `--workgraph-executors` /
`WORKGRAPH_EXECUTORS` is the headless override (JSON).

Note the in-session executor offers `planner` and `implementer` only: with
nothing else online, `reviewed` and `planned` work reaches judgment and
escalates for lack of an independent reviewer. Enable the bridge (the
`subagentsExecutor` setting above, or `--workgraph-subagents-executor=true`)
for the full chain.

The flag form:

```bash
pi --workgraph-tiers '{"planner":{"model":"anthropic/claude-opus-*","thinking":"high"},
                      "implementer":"anthropic/claude-sonnet-*",
                      "reviewer":"anthropic/claude-opus-*"}'   # env WORKGRAPH_TIERS
```

Specs are `provider/id` strings with `*` globs, resolved against the session's model
registry at `session_start`; among several matches the newest wins (highest
version numbers in the id, shorter id on a tie). A spec that matches no
available model is reported once and that role runs untiered.

Adapters consume the table:

- **in-session** switches the session model (and thinking level) for the
  duration of a tiered run and restores the previous settings afterwards —
  the plan-with-Opus, build-with-Sonnet flip inside one session. Completion
  provenance reports the model the turn actually ran on.
- **pi-subagents** passes the tier as the per-role launch model; an
  explicit per-role `options` entry still wins.

The core still does no routing: the judgment gate's
`requireAuthorIndependence` checks the *reported* provenance — keep the
reviewer on a different model than the implementer for medium/high-risk
work, or judgment cannot pass.

## Tools

Thirteen typed tools, all schema-validated and race-safe. Agents are
instructed to use these instead of touching the store from bash — bare
assignee writes are how leases get corrupted.

| Tool                     | What it does                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `workgraph_init`         | Create the workspace (`.workgraph/workgraph.db`, gitignored); idempotent                                     |
| `workgraph_create`       | Create an issue — optionally approved, with acceptance criteria, risk tier, workflow class, and dependencies |
| `workgraph_ready`        | List approved claimable issues (dependency-unblocked, unassigned); `legacy: true` lists unapproved           |
| `workgraph_claim`        | Atomically claim an issue by id, or the next ready one; stamps a lease                                       |
| `workgraph_release`      | Voluntarily hand a claimed issue back to the pool (fenced; clears assignee, reopens)                         |
| `workgraph_close`        | Close an issue (fenced; lifecycle-v1 work must be phase `accepted` — the judgment gate's output)             |
| `workgraph_split`        | Split an issue into child issues; the parent is blocked until every child closes                             |
| `workgraph_heartbeat`    | Renew the leases this worker holds (verifies the fencing epoch, pushes `lease_expires_at` forward)           |
| `workgraph_approve`      | Approve a draft/legacy/escalated issue: acceptance criteria, workflow class, risk tier, phase `ready`        |
| `workgraph_approve_plan` | Approve a recorded plan (implement it next) or reject it with feedback (plan again)                          |
| `workgraph_tiers`        | Set or show per-role model tiers for this repository (a role → model table, or clear)                        |
| `workgraph_override`     | Explicit human override: force-close or force-release, bypassing guards — always audited                     |
| `workgraph_status`       | One issue's full control-plane state: phase, plan, lease, attempt, verdict, acceptance criteria              |

The in-session executor adds `workgraph_submit_plan`, valid only during a
planning turn. `/workgraph init [prefix]` and `/workgraph tiers` are the
slash-command forms of the two operator actions.

## Configuration

Resolution order per value: CLI flag > environment variable > default.

| Flag                                     | Environment variable                   | Default                         | Purpose                                                                                                                                 |
| ---------------------------------------- | -------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--workgraph-plan-approval`              | `WORKGRAPH_PLAN_APPROVAL`              | `required`                      | Plan gate for `planned` work: `required` (a human approves each plan) or `auto`                                                         |
| `--workgraph-tiers`                      | `WORKGRAPH_TIERS`                      | what `workgraph_tiers` stored   | Headless override of the settings-file role → model table, as JSON (see [Model tiers](#model-tiers))                                 |
| `--workgraph-executors`                  | `WORKGRAPH_EXECUTORS`                  | settings `executors`            | Per-role executor pins as JSON (see [Who runs what](#who-runs-what))                                                                     |
| `--workgraph-store`                      | `WORKGRAPH_STORE`                      | settings `store`, else `repo`   | Where databases live: `repo`, `central`, or an absolute directory (see [Where the store lives](#where-the-store-lives))               |
| `--workgraph-lease-ttl-ms`               | `WORKGRAPH_LEASE_TTL_MS`               | `300000` (5 min)                | Lease time-to-live; expired leases are reclaimable                                                                                      |
| `--workgraph-heartbeat-ms`               | `WORKGRAPH_HEARTBEAT_MS`               | `60000` (60 s)                  | How often held leases are renewed                                                                                                       |
| `--workgraph-poll-ms`                    | `WORKGRAPH_POLL_MS`                    | `30000` (30 s)                  | Coordinator poll interval (floored at 5 s in production wiring)                                                                         |
| `--workgraph-sweep-interval-ms`          | `WORKGRAPH_SWEEP_INTERVAL_MS`          | the poll interval               | Expiry-sweep cadence (reclaims expired leases back to ready)                                                                            |
| `--workgraph-discovery-timeout-ms`       | `WORKGRAPH_DISCOVERY_TIMEOUT_MS`       | `2000` (2 s)                    | Executor-discovery collection window                                                                                                    |
| `--workgraph-accept-timeout-ms`          | `WORKGRAPH_ACCEPT_TIMEOUT_MS`          | `10000` (10 s)                  | Run-request accept/reject deadline                                                                                                      |
| `--workgraph-compat-in-session-executor` | `WORKGRAPH_COMPAT_IN_SESSION_EXECUTOR` | `true`                          | Register the in-session executor (planner + implementer in the chat session)                                                            |
| `--workgraph-executor-id`                | `WORKGRAPH_EXECUTOR_ID`                | —                               | Pin executor selection to one executorId (errors when it's absent)                                                                      |
| `--workgraph-compat-legacy-issues`       | `WORKGRAPH_COMPAT_LEGACY_ISSUES`       | `false`                         | Opt-in: auto-dispatch issues without lifecycle metadata (warned once)                                                                   |
| `--workgraph-policy`                     | `WORKGRAPH_POLICY`                     | low advisory, med/high blocking | Per-risk-tier judgment-gate policy overrides (JSON)                                                                                     |
| `--workgraph-subagents-executor`         | `WORKGRAPH_SUBAGENTS_EXECUTOR`         | settings `subagentsExecutor`    | Opt-in: the experimental pi-subagents bridge (`true` or its JSON block)                                                                 |
| `--workgraph-finalization`               | `WORKGRAPH_FINALIZATION`               | —                               | Optional post-verification task (JSON with `instructions`, `timeoutMs`)                                                                 |
| `--workgraph-worker-id`                  | `WORKGRAPH_WORKER_ID`                  | `{user}@{host}/{short-session}` | Worker identity used for claims, audit records, and fencing checks                                                                      |
| `--workgraph-dispatch`                   | —                                      | `true`                          | Kill switch: `false` keeps tools + context injection, no autonomy (the flag name predates the coordinator; it disables the coordinator) |

## How it works

- **The store** — `src/store.ts`: one SQLite file per repository (WAL
  mode, busy timeout), at `.workgraph/workgraph.db` in the checkout or under
  a central directory (see [Where the store lives](#where-the-store-lives)),
  found by walking up from the session's cwd so worktrees share their
  repository's graph.
  Issues, dependencies, and comments are tables; lifecycle and lease state
  is a per-key-merged JSON metadata column. Cross-process safety is
  SQLite's own locking: a claim is one conditional `UPDATE`, claim-next runs
  under `BEGIN IMMEDIATE`. Nothing in `.workgraph/` is meant to be
  committed — the directory ships its own `.gitignore`. There is no
  background process and no CLI to install.
- **Coordinator** — the protocol-based dispatch loop, using a scheduling
  shell built from a poll timer plus Pi's `agent_settled` idle edge and one
  reentrancy-guarded tick. Each tick: fetch the ready pool (readiness is
  judged by array length, never exit codes), filter to approved lifecycle
  work (plans parked in `plan_review` are never claimable), **discover
  executors first** (no executor → no claim), claim by id under a fresh
  `workgraph-run/` lease, persist intent, and delegate over the protocol.
  Completions are fenced (issue id + workflow-run id + lease epoch) and
  drive the plan gate and the judgment gate: independent review, policy
  application, bounded revisions, fingerprint-based escalation, and a
  policy-approved close. On restart, persisted runs are reconciled —
  re-adopted, completed, or abandoned to the reclaim path.
- **Context injection** — every turn, `before_agent_start` appends a fenced
  `<workgraph>` section to the system prompt: current claim with lease
  countdown, ready count (top 5 rendered, the rest folded into the count),
  plans awaiting review, and the collision-free claiming rules. Per-turn
  re-injection is the compaction-survival workhorse: even when a summary
  drops graph state, the next turn re-adds it fresh. Graph state is cached
  for 10 s per workspace.
- **Compaction takeover** — when Pi compacts the conversation with work in
  flight, pi-workgraph runs the compaction itself so the summary preserves
  the in-flight issue id and title. With nothing claimed — and on every
  failure path — it falls back to Pi's default compaction.
- **Status bar** — current claim, lifecycle phase, executor, and lease
  countdown in the footer, TUI only; headless sessions never touch the UI.
- **Audit trail** — every lease transition is recorded as an issue comment,
  every plan as a `workgraph-plan` comment, and every verdict as a
  `workgraph-verdict` comment. See [Audit events](#5-audit-events) below.

Every tool declares sequential execution so lease reads and writes from one
session never interleave; cross-process concurrency is the store's locking,
and is exactly what the race suites exercise.

## The Lease Convention

**Convention-Version: 2**

This section is the interop contract. It is versioned independently of the
package: protocol changes bump the `Convention-Version` line above, not just
the npm semver. Version 2 moved the home of the state from the beads (`bd`)
database to this package's own SQLite store; the key names, value shapes,
and invariants are unchanged. A third-party tool (any harness, not just
Pi) can respect or detect pi-workgraph leases by reading
`.workgraph/workgraph.db` (read-only; `scripts/git-push-guard.mjs` is a
worked example) and implementing what follows. Every stated
invariant is tied to a test in this repository via an HTML comment in this
document's source.

### 1. Metadata fields

Lease state lives in three issue-metadata keys. These key names are
**frozen**: renaming one is a breaking protocol change.

| Key                | Type    | Meaning                                                              |
| ------------------ | ------- | -------------------------------------------------------------------- |
| `lease_holder`     | string  | Worker identity of the current holder                                |
| `lease_epoch`      | integer | Fencing token — monotonic per issue, **never resets**                |
| `lease_expires_at` | string  | Lease expiry, RFC3339 UTC at **second** precision                    |

`lease_holder` values are **opaque strings** — compare them for equality,
never parse meaning out of them. Two shapes appear today: the initiating
session's worker identity (`{user}@{host}/{short-session-id}`) for direct
tool claims, and `workgraph-run/{id}` (a generated workflow-run identity
whose lifetime is the run's, not the initiating session's) for coordinator
claims. This is a semantics note about the _values_, not a key change —
the keys above stay frozen.

A leased issue as returned by the store's `show` (abridged; the `metadata`
column is the JSON object shown):

```json
{
  "id": "wg-0qz",
  "title": "implement retry backoff",
  "status": "in_progress",
  "priority": 2,
  "issue_type": "task",
  "assignee": "garen@sandbox/1f3a9c2e",
  "updated_at": "2026-08-06T13:16:02.418Z",
  "metadata": {
    "lease_epoch": "3",
    "lease_holder": "garen@sandbox/1f3a9c2e",
    "lease_expires_at": "2026-08-06T13:21:01Z"
  }
}
```

Readers must normalize: metadata values round-trip exactly as written, and
writers stamp the epoch as a string — treat `lease_epoch` as an integer
however it round-trips (`Number(...)`), and treat a missing/garbled epoch
as `0` (a never-leased issue).

### 2. Invariants

Metadata merges are **last-writer-wins per key**, so the fencing token is
what makes the protocol safe. These invariants are load-bearing:

<!-- Tested: test/race.test.ts — "8 concurrent claims -> exactly 1 winner, final assignee matches" -->

1. **The store's atomic claim is the mutex.** Acquisition is one
conditional `UPDATE` (`claim`, or `claimNext` under `BEGIN IMMEDIATE`),
which SQLite serializes across processes: N concurrent claims produce
exactly one winner.
<!-- Tested: src/lease.test.ts — "stamps the lease trio on first acquire: epoch 1, holder, RFC3339 expiry" -->
2. **Acquisition is claim, then stamp, then verify.** After the atomic
claim, the holder writes all three lease keys in one metadata update
(epoch = current epoch + 1), then re-reads the issue and verifies its
holder and epoch landed. Same-key metadata races are last-writer-wins, so
post-write verification — not pretended atomicity — closes the window.
A holder that fails verification walks away (`lost-acquisition-race`).
<!-- Tested: src/lease.test.ts — "re-acquire by the same worker is a renewal — the epoch does NOT double-increment" -->
3. **Same-holder re-acquire is a renewal.** The claim is idempotent per
actor; re-acquiring an issue you already hold must not double-increment
the epoch.
<!-- Tested: test/fencing.test.ts — "a SIGSTOP'd holder that wakes after reclaim aborts its write; the issue stays with the reclaimer" -->
4. **Every holder write is fenced.** Before any write to a lease-held issue
(renew, release, close), the holder re-reads the issue and verifies that
`lease_epoch` equals its held epoch and `lease_holder` is still itself.
A stale holder that wakes up after a reclaim finds a higher epoch and
must abort — do not continue the issue, do not "release" it out from
under the new holder.
<!-- Tested: src/lease.test.ts — "extends the expiry at the same epoch" -->
5. **Heartbeat = fenced expiry push.** Renewal verifies the epoch, then
rewrites `lease_expires_at` to `now + TTL` at the same epoch. Because
every metadata write bumps `updated_at`, a live worker's issue
always looks fresh to the staleness sweep.
<!-- Tested: test/reclaim.test.ts — "SIGKILL'd worker's lease is reclaimed within TTL + poll + tolerance, with audit" -->
6. **Reclaim = epoch + 1, assignee overwrite, verify.** Takeover of an
expired lease writes the epoch bump and the assignee overwrite in ONE
statement, so there is no window where the assignee moved but the epoch
did not. Reclaimers race on last-writer-wins metadata; post-write
verification elects exactly one winner — the loser walks away.
<!-- Tested: src/lease.test.ts — "clears assignee + holder/expiry, reopens, audits — and the epoch survives" -->
7. **Release keeps the epoch.** Voluntary release clears the assignee,
reopens the issue, and unsets `lease_holder`/`lease_expires_at` — but
`lease_epoch` stays on the issue. The fencing token is monotonic per
issue and never resets across release/re-acquire cycles.
<!-- Tested: src/lease.test.ts — "epoch stays monotonic across repeated reclaim cycles (3 reclaims = 3 increments)" -->
8. **Epoch gaps are legal.** The epoch is read fresh from the issue at every
   acquire (never cached), so retries cannot double-increment — but nothing
   requires density. Monotonicity is the invariant, not density.

### 3. Detection query

Expiry detection is dual-condition **by design** (the clock-skew guard):

```text
Stage 1 — store-side staleness filter (the store's clock):
  listInProgressUpdatedBefore(cwd, <now - TTL>)   — status in_progress AND updated_at < cutoff
```

then, client-side for each result:

```
Stage 2 — Date.parse(metadata.lease_expires_at) < now  (the holder's clock)
```

Why both: a heartbeating worker bumps `updated_at` on every renewal, so live
workers never appear in stage 1; and stage 2 confirms against the expiry the
holder actually wrote. A skewed clock must beat BOTH conditions before work
is stolen mid-flight. The cutoff is rounded UP to the next second (lease expiries are stamped at
second precision) so flooring doesn't hide a just-expired lease.

<!-- Tested: src/lease.test.ts — "legacy no-lease claims are flagged expire-detected once, never reclaimed" -->

Stale `in_progress` issues with **no** lease metadata (claimed by a human or by a
tool that predates leases) are flagged
with an `expire-detected` audit record but **never auto-reclaimed** —
stealing a human's claim is worse than a stalled issue.

### 4. How to coexist

- **A tool that respects leases** (writes to issues that may be leased)
  checks the fencing epoch before every write: re-read the issue, compare
  `lease_epoch` to the epoch it holds, abort on mismatch. Follow the
  invariants above and two implementations can safely share one graph.
- **A tool that merely detects leases** treats the three metadata keys as
  reserved: never write `lease_holder`, `lease_epoch`, or
  `lease_expires_at` yourself, and treat an issue whose
  `lease_expires_at` is in the future as actively held even if your own
  bookkeeping says otherwise.
- **Claims without lease metadata are never auto-reclaimed** — extend the
  same courtesy in your implementation.
- **A worked detector ships in this repo**: `scripts/git-push-guard.mjs`,
  a chaining `pre-push` hook that blocks `git push` while a designated
  sentinel issue holds a live lease — "don't push during the restack"
  turned into verified state. See [docs/git-push-guard.md](docs/git-push-guard.md).

### 5. Audit events

The store keeps no interaction log of its own, so every lease transition
self-emits an audit record as an issue comment:

```
workgraph-lease <kind> <JSON details>
```

Read the trail back with `listComments` (or `workgraph_status`) and grep
for the `workgraph-lease` prefix. The seven lease kinds:

| Kind                    | Emitted when                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `claim`                 | A lease was acquired (first stamp at a new epoch)                                  |
| `renew`                 | A heartbeat pushed the expiry (sampled 1-per-10 per issue to keep trails readable) |
| `release`               | A holder voluntarily released the issue                                            |
| `expire-detected`       | The sweep found a stale claim with no lease metadata (flagged, never reclaimed)    |
| `reclaim`               | An expired lease was taken over (records old holder, old/new epoch)                |
| `lost-acquisition-race` | A claim's lease stamp was overwritten before verification                          |
| `fencing-loss`          | A holder's heartbeat discovered its lease was reclaimed                            |

The coordinator and tools add lifecycle kinds under the same prefix —
among them `approve`, `plan-review` (a plan was parked for a human),
`plan-approved`, `plan-rejected`, `revision-requested`, `escalated`, and
`judgment-closed`.
Audit writes never block lease operations: the protocol stays correct
without the trail, and a broken audit surface must not take claiming down
with it.

## Experimental: Control-Plane Protocol v1

> **Experimental — may change without semver ceremony until 1.0.** Unlike
> the Lease Convention above (frozen at Convention-Version 1 and safe to
> implement against today), everything in this section ships and is tested
> as of 0.2.0 — `src/protocol.ts` implements these tables name-for-name —
> but until 1.0 it may still change in any release.

pi-workgraph is a durable, harness-neutral work **control plane**: it owns
only the state and invariants that must survive agents, sessions,
harnesses, and machines — work, dependencies, atomic claims, expiring
leases, fencing, the lifecycle from approved work through implementation,
judgment, revision, and acceptance, and the audit trail. Execution is
delegated through versioned protocol envelopes; the core never executes
model work itself and requires no specific executor runtime. Three
invariant pins in `test/invariants.test.ts` hold this contract in place
(landed as expected-failure pins in phase 0; all three flipped to plain
tests as their delivering phases shipped).

### 1. Durable lifecycle metadata

The store's native statuses stay simple (`open`, `in_progress`, `blocked`,
`closed`); lifecycle phase is workgraph semantics, stored in namespaced
issue metadata:

| Key                             | Meaning                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `workgraph_lifecycle_version`   | Lifecycle schema version, initially `1`                                                                      |
| `workgraph_phase`               | `draft`, `ready`, `planning`, `plan_review`, `implementing`, `judging`, `revising`, `verifying`, `accepted`, or `escalated` |
| `workgraph_workflow_run_id`     | Stable ID covering planning, implementation, and all judgment/revision attempts for one claim                |
| `workgraph_executor_id`         | Selected executor adapter                                                                                    |
| `workgraph_attempt`             | Current implementation/revision attempt number                                                               |
| `workgraph_risk_tier`           | Policy input such as `low`, `medium`, or `high`                                                              |
| `workgraph_workflow_class`      | Execution topology: `oneshot`, `reviewed` (default), or `planned`                                            |
| `workgraph_active_execution_id` | Executor-specific active run ID, when accepted                                                               |
| `workgraph_author_provenance`   | Compact JSON describing effective harness, profile, provider, and model                                      |
| `workgraph_last_verdict`        | Compact verdict summary and durable audit-event reference                                                    |
| `workgraph_failure_fingerprint` | Hash used to detect a repeated failed attempt                                                                |
| `workgraph_plan_summary`        | Compact plan summary; the full plan lives in the `workgraph-plan` comment trail                              |
| `workgraph_planner_provenance`  | Compact JSON describing the planner's effective harness, provider, and model                                 |
| `workgraph_plan_approved`       | `true` once a human approved the recorded plan; the next claim implements it (cleared on re-approve)        |
| `workgraph_plan_feedback`       | Feedback from a rejected plan, carried on the next planner request and consumed by the next recorded plan   |

### 2. State transitions

```text
draft --approve--> ready --claim (planned)--> planning
draft --approve--> ready --claim (reviewed/oneshot)--> implementing
planning --plan recorded (plan approval required, the default)--> plan_review (lease released)
plan_review --workgraph_approve_plan approve--> ready --claim--> implementing (plan attached)
plan_review --workgraph_approve_plan reject--> ready --claim--> planning (feedback attached)
planning --plan accepted (plan approval auto)--> implementing
planning --failed/invalid plan--> escalated
implementing --oneshot success--> verifying --> accepted --> closed
implementing --oneshot failure/blocked--> ready (promoted to reviewed)
implementing --implementation completed--> judging
implementing --failed/blocked--> revising | escalated
judging --hard-gate reject--> revising
judging --advisory verdict--> verifying
judging --hard-gate accept--> verifying
revising --new execution accepted--> revising
revising --implementation completed--> judging
verifying --pass--> accepted --close--> closed
verifying --fail--> revising | escalated
any active phase --lease lost--> stale result rejection + reclaim path
any active phase --human override--> closed, with actor and reason audited
```

<!-- Tested: test/invariants.test.ts — "successful implementation cannot close the issue directly" (pinned in phase 0, flipped in phase 3) -->

Successful reviewed/planned implementation transitions to judgment. A
successful low-risk one-shot follows the explicit verification/acceptance
tail and closes without independent review. Policy-approved judgment, that
one-shot tail, a final verifier, or an explicit audited human override may
close.

<!-- Tested: test/invariants.test.ts — "release without a tracked lease is rejected, not silently performed" (pinned in phase 0, flipped in phase 1) -->

Every state-changing result is fenced: a completion, verdict, cancellation,
or promotion is ignored unless its issue ID, workflow run ID, and lease
epoch still match the store. The coordinator never releases an issue unless
this process holds its tracked lease.

### 3. Protocol channels

Versioned execution envelopes (`protocolVersion: 1`; every message includes
`messageId`, `occurredAt`, and the relevant correlation identifiers) travel
over these Pi event-bus channels in the first transport:

| Channel                           | Direction        | Purpose                                                                         |
| --------------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `workgraph:v1:executor:discover`  | core → adapters  | Request capability offers                                                       |
| `workgraph:v1:executor:offer`     | adapter → core   | Advertise identity, roles, isolation, capacity, and supported profile semantics |
| `workgraph:v1:run:request`        | core → adapter   | Request an implementation, review, revision, or verification run                |
| `workgraph:v1:run:accepted`       | adapter → core   | Bind the workflow request to an executor run                                    |
| `workgraph:v1:run:rejected`       | adapter → core   | Reject before starting, with a stable reason code                               |
| `workgraph:v1:run:progress`       | adapter → core   | Advisory progress; never a durable transition by itself                         |
| `workgraph:v1:run:completed`      | adapter → core   | Return structured result, artifacts, evidence, and provenance                   |
| `workgraph:v1:run:cancel`         | core → adapter   | Interrupt a run after release, fencing loss, shutdown, or policy decision       |
| `workgraph:v1:run:cancelled`      | adapter → core   | Acknowledge cancellation                                                        |
| `workgraph:v1:run:status-request` | core → adapter   | Reconcile a persisted active run after restart                                  |
| `workgraph:v1:run:status`         | adapter → core   | Report active, terminal, missing, or unreachable                                |
| `workgraph:v1:activity`           | core → observers | Publish canonical lifecycle changes for UI/presence adapters                    |

<!-- Tested: test/invariants.test.ts — "with no executor available, a dispatch tick claims nothing" (pinned in phase 0, flipped in phase 2) -->

Dispatch must discover an eligible executor **before** claiming work: no
executor means no claim, and a missing or incompatible executor leaves the
issue ready.

Consume the schemas without the extension via the `pi-workgraph/protocol`
subpath export — see [Protocol-only usage](#protocol-only-usage).

### 4. Legacy compatibility

Issues without `workgraph_lifecycle_version` are legacy issues. They remain
readable. The first `workgraph_approve` (or compat-mode claim) initializes
lifecycle metadata in one non-destructive write that preserves every
pre-existing key.
Automatic dispatch of legacy issues requires the **explicit opt-in
compatibility setting** `workgraph-compat-legacy-issues` — it is never an
implicit default — and logs a once-per-session warning naming the setting
and its effect. A legacy issue carrying a live lease is respected and never
claimed, under either setting.

### 5. The planner tier

An issue approved with workflow class `planned` is claimed into `planning`
when eligible planner and implementer executors are both available. By
default the recorded plan then parks in `plan_review` for a human (see
[Plan, approve, build](#plan-approve-build)); once approved, the next claim
goes to an implementer with the plan attached as the optional `plan` field
on `run:request` (and on every revision of it). A rejected plan's feedback
rides the next planner request as the optional `feedback` field.

Planning is selected per issue, not globally from executor availability.
`reviewed` and `oneshot` work go straight to implementation even when a
planner is online. `planned` work never silently degrades: without both a
planner and implementer it remains unclaimed in `ready`.

Four rules the code enforces, each with a reason:

- **Never plan what cannot be built.** The tick only enters `planning` if
  the same discovery round also produced an implementer. Otherwise a
  planner-only offer set would plan, find nobody to implement, hand the
  issue back, and re-plan forever.
- **Failure escalates; it never degrades.** A planner that reports
  `failure`/`blocked` or returns an unparseable plan escalates the issue to
  `blocked` — it does _not_ fall through to an unplanned implementation.
  Silently implementing without the plan would look identical to success
  while being the exact thing the operator wanted to prevent. Recover via
  re-approve, as with any escalation.
- **A plan is evidence, not authority.** The core never interprets steps or
  enforces `targets`, and a planner's refined `acceptanceCriteria` is
  recorded in the plan trail rather than overwriting the approved criteria
  on the issue — a planner that could rewrite its own bar would defeat the
  judgment gate.
- **Legacy issues never plan.** Their compatibility entry is
  `implementing`, so compat-mode dispatch stays predictable.

One workflow run spans the whole chain: planner, implementer, and every
judgment sub-run share a lease, a `workgraph_workflow_run_id`, and a fencing
triple. A crashed planner is not re-adopted on restart — there is no partial
work to protect — it is abandoned, and the TTL sweep resets `planning` →
`ready` for a clean re-plan.

Model tiering (a judgment-heavy model plans, a fast one implements, and an
independent model reviews) is configured once with
[`--workgraph-tiers`](#model-tiers) and consumed by the **executor
adapters**, never by the core: the coordinator selects by role and
validates reported provenance, and deliberately does no model routing (see
`src/policy.ts`). An adapter that maps role → model gets tiering; the judgment gate's
`requireAuthorIndependence` then enforces that the reviewer differs from the
author on every required provenance axis (model by default for
medium/high risk).

### 6. Optional executor: the pi-subagents bridge

> **Experimental and version-gated.** The bridge talks to
> [pi-subagents](https://github.com/fitchmultz/pi-subagents) **by event
> names only** — it imports zero pi-subagents code and this package
> declares no pi-subagents dependency in any block (CI enforces it).
> Because those event names are not a declared public API, the adapter
> validates the _installed_ upstream package version (a package.json read,
> never an import; upstream advertises no version on its bus). By default
> any installed version bridges; set `versionRange` to gate strictly.
> Expect breakage across upstream minor versions until upstream adopts the
> generic protocol.

The bridge ships **disabled**. Opt in explicitly:

```bash
# flag (or env WORKGRAPH_SUBAGENTS_EXECUTOR)
--workgraph-subagents-executor=true
# or pin an accepted upstream major.minor range (optional strict gate):
--workgraph-subagents-executor='{"enabled":true,"versionRange":"0.34"}'
```

When configured and version-gated, it answers discovery as
`executorId: "pi-subagents"` offering `planner`, `implementer`, `reviewer`,
and `revision` roles with `isolation: "worktree"` and a priority above the
in-session adapter — an operator who opted in prefers isolated background
workers. Unconfigured, the bridge is **never registered**: an unconfigured
extension answers discovery with no subagents offer and holds zero bus
subscriptions (a double gate — index.ts never calls the register function,
and the register function re-checks config itself).

Bridge semantics:

- **Supervisor decisions pause the workflow.** A detached child produces an
  explicit blocked decision request, not a failed implementation to judge.
  The coordinator saves the question, parks the issue in Escalated, and keeps
  the revision limit unchanged. The dashboard displays the question and accepts
  an answer before resuming the original task in its retained checkout.
  Detached children are interrupted by run ID; an interrupt receipt alone is
  not confirmation that the child stopped. Without a confirmed exit, resuming
  remains blocked. This lifecycle uses the pi-subagents foreground completion
  event verified against 0.41; older or incompatible runtimes may require a
  manual worker stop before recovery.

- **Self-acceptance is never judgment.** A pi-subagents run can finalize
  with a parent-controlled self-review (`acceptance` ledger). The bridge
  maps that to implementation-completion evidence at most; a reviewer
  verdict is emitted only from a **separately launched** reviewer run's
  structured output.
- **Reported provenance.** Completions carry the model upstream _reported
  using_, never the one requested; the provider is split off only when the
  `provider/id` format is unambiguous.

The adapter accepts up to four runs and queues their foreground calls, launching
one at a time because pi-subagents permits only one foreground call per session.
Queued executions remain cancellable. Executor launch failures are escalated
with their original error; a failed review or finalizer does not become a
generic structured-output parsing error.

Every worker task includes Node.js guidance for ad hoc file processing and test
report summaries. Reporting helpers run separately from builds/tests and request
a 60-second shell timeout; repository build/test commands keep their own finite
timeouts. This guidance is included in the child task itself, including planner,
reviewer, and finalizer tasks, so it does not depend on inherited coordinator
prompts. Changes apply to newly launched coordinator sessions.

The bridge uses named upstream profiles and can route them by workflow class
and role without hard-coding model IDs into the control plane:

```bash
--workgraph-subagents-executor='{
  "enabled": true,
  "routes": {
    "oneshot": { "implementer": "economy-worker" },
    "reviewed": {
      "implementer": "worker",
      "reviewer": "reviewer",
      "revision": "fixer"
    },
    "planned": {
      "planner": "planner",
      "implementer": "worker",
      "reviewer": "reviewer",
      "revision": "fixer"
    }
  }
}'
```

Configure the named profiles' model, thinking level, and fallbacks in Pi or
pi-subagents settings. The bridge was contract-tested against pi-subagents
0.34.8; other major.minor lines remain fail-closed until re-verified.

**Activity events**: the coordinator publishes `workgraph:v1:activity` on
every canonical lifecycle change it commits (claim, phase transition,
verdict, escalation, close) — strictly after the corresponding write, for
UI/presence/kanban observers only (nothing in-core subscribes). Coverage
gap by design: the expiry sweep's reclaims and restart recovery's
re-adopt/abandon paths emit no activity — observers needing those must
read the audit comment trail.

Executors may also publish `workgraph:v1:run:progress` for display-only
updates. The Pi adapter includes the role, reported model, current tool note,
and a bounded snapshot of visible worker output when upstream provides it.
Acceptance does not imply that a worker has started. The serial Pi subagents
adapter reports optional `executionState` (`queued` or `starting`) and
`queuePosition` on acceptance. Progress events report `queued`, `starting`, or
`working`; queued positions update as jobs leave the queue. These fields are
display-only and do not change coordinator scheduling or lifecycle state. Older
adapters may omit them, so observers must treat missing state as unknown.

These updates are advisory; they are never acceptance evidence or lifecycle
transitions. Observers own their transport, filtering, and presentation.

**Remote transports**: the protocol can cross machines through a conforming
transport adapter — see the
[Agent IRC transport adapter contract](docs/agent-irc-transport.md)
(documented, deliberately not implemented here).

## Development

```bash
npm ci
npm run typecheck
npm test            # full suite, serial (vitest run --no-file-parallelism)
```

The cross-process suites (`test/race.test.ts`, `test/fencing.test.ts`,
`test/reclaim.test.ts`) spawn real worker child processes on the TypeScript
entrypoint via Node's native type stripping — running the test suite needs
**Node ≥ 22.18** (consumers of the package don't: Pi's loader transpiles the
source itself). Timers are compressed (2 s TTLs), so the whole suite runs
in about half a minute.

## Credits

- [beads](https://github.com/gastownhall/beads) — the work graph this
  package was first built on (through 0.3.x); its atomic claim and
  dependency-aware ready query shaped the store's contract.
- pi-beads-extension — prior art for work-graph context injection in Pi;
  its patterns (and bugs) shaped this package's injection rules.
- [@mancioshell/pi-board-agent](https://www.npmjs.com/package/@mancioshell/pi-board-agent)
  — the lockfile-before-claim idea that inspired the lease design.
- The "opusplan" Claude Code tip — the plan-approve-build shape.

## License

[MIT](./LICENSE)


### Caller-defined finalization

Set `WORKGRAPH_FINALIZATION` to JSON containing `instructions` and an optional
`timeoutMs` (default 3600000). After verification, the coordinator dispatches a
`finalizer` role with those instructions and a structured result schema. It closes
the issue only when both the execution and the result report success. A missing
executor, malformed result, or blocked/failed result escalates the issue.

The core defines no skill names, hosting service, or publication task. Results
contain `outcome` (success/blocked/failure), `summary`, optional `artifacts`, and
opaque `data`. The result is stored in `workgraph_finalization_result`;
`workgraph_finalization_status` reports progress. UIs may supply their own presets.

The Pi subagents adapter accepts per-role `options` alongside `routes` in
`WORKGRAPH_SUBAGENTS_EXECUTOR`: opaque `model`, optional `thinking` (requires
an explicit model), and `skills` names. Thinking is encoded using Pi's model
suffix. Explicit skills are passed via Pi's native skill selection. With
finalization enabled, the adapter creates one retained Git worktree per workflow
and shares it across implementation, review, revision, and finalization. New
worktrees start from the source checkout's current commit; staged, unstaged, and
untracked changes stay in the source checkout. The adapter never removes the
workflow branch or worktree.
Accepted plans are included in every downstream task. Pi executor children retain
workgraph tools but do not start additional coordinators or recovery sweeps.

Finalization is opt-in. Existing runs without it keep their previous behavior.
Interrupted verification/finalization is parked for operator recovery; it is
never automatically repeated, since its external effects may already have happened.
After an unacknowledged cancellation the lease is left to expire. Inspect the
retained worktree and any external result before overriding or reapproving work.

Dashboard issue controls can emit `workgraph:ui:issue-halted` after persisting
a fresh lease epoch and `workgraph_halted=true`. The coordinator detaches only
that issue and ignores it during dispatch; the subagent adapter rejects delayed
requests from its old epoch. The dashboard then uses the normal cancellation
protocol and waits for acknowledgement. Resuming clears the halt flag and
claims a new workflow run. Optional `workspace.sourceWorkflowRunId`, derived
from `workgraph_workspace_run_id`, reuses the retained checkout from an earlier
run while keeping the new run identity and lease epoch for result fencing.
