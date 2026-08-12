# pi-workgraph

A [Pi](https://github.com/earendil-works/pi) extension that turns the
[beads](https://github.com/gastownhall/beads) (`bd`) work graph into a
durable, harness-neutral work **control plane**: typed tools for agents,
expiring leases with fencing, an approval-gated lifecycle with an
independent judgment gate, and a coordinator that delegates execution to
pluggable executor adapters over versioned protocol envelopes.

bd gives agents a dependency-aware work graph with race-safe atomic claims,
but a claim never expires: a session that crashes or gets SIGKILL'd mid-task
leaves its issue assigned forever, invisible to every other worker.
pi-workgraph adds a TTL + fencing lease layer on top of bd's primitives, a
durable lifecycle (approve → implement → judge → accept) stored in
namespaced issue metadata, a coordinator that discovers executors and
supervises runs end to end, and per-turn context injection so the graph
survives conversation compaction.

## The three roles

pi-workgraph owns only the state and invariants that must survive agents,
sessions, harnesses, and machines. Everything else is delegated:

```text
┌───────────────────────────┐    workgraph:v1:* envelopes    ┌───────────────────────────┐
│ WORK AUTHORITY            │ ─────────────────────────────► │ EXECUTION                 │
│ pi-workgraph + beads      │   discover / offer / request   │ executor adapters:        │
│ issues & dependencies,    │ ◄───────────────────────────── │ · in-session (compat,     │
│ atomic claims, expiring   │    accept / complete / status  │   default)                │
│ leases + fencing, the     │                                │ · tiered: one model per   │
│ approval → judgment       │                                │   role (opt-in)           │
│ lifecycle, audit trail    │                                │ · pi-subagents (opt-in)   │
│                           │                                │ · your adapter            │
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

- **Work authority** — this package plus bd: what the work is, who may
  touch it, and what state it is in. The core never executes model work
  itself.
- **Execution** — adapters that answer discovery and run planning,
  implementation, review, revision, and verification requests. The
  in-session adapter (the
  v0.1 "wake this agent" behavior as an explicit adapter) ships enabled;
  the [pi-subagents bridge](#7-optional-executor-the-pi-subagents-bridge)
  ships disabled.
- **Communication** — observers of the audit trail and
  `workgraph:v1:activity` events, and remote transports via the
  [Agent IRC transport adapter contract](docs/agent-irc-transport.md)
  (documented, deliberately not implemented here).

## Requirements

- [Pi](https://github.com/earendil-works/pi) ≥ 0.83
- [beads](https://github.com/gastownhall/beads) (`bd`) ≥ 1.1.2 on your `PATH`
- Node ≥ 22 (Pi loads the TypeScript source directly; no build step)

## Install

```bash
pi install npm:pi-workgraph
```

## Quickstart

```bash
# 1. Initialize a work graph in your project
bd init

# 2. Seed one issue
bd create "implement retry backoff"

# 3. Start Pi
pi
```

A freshly created issue is **not yet approved** — the coordinator only
dispatches approved work. Approve it (ask the agent, or do it yourself in a
Pi session):

```text
> approve bdx-001 with acceptance criteria "retries back off exponentially,
  covered by tests"
```

The agent calls `workgraph_approve`, which records the acceptance criteria,
stamps a risk tier, and moves the issue to phase `ready`. On the next idle
tick the coordinator discovers an executor (the in-session compatibility
executor, unless you disabled it), claims the issue under a workflow-run
lease, and delegates the run. When the implementation completes, the
judgment gate takes over: an independent reviewer run checks the acceptance
criteria, bounded revision rounds fix findings, and only policy-approved
judgment closes the issue.

Prefer tools without autonomy? Disable the coordinator and keep everything
else:

```bash
pi --workgraph-dispatch=false
```

## Usage modes

### Fresh install

The Quickstart above: `bd init`, create work, approve it, let the
coordinator dispatch. New issues enter the lifecycle at approval time; you
never think about migration.

### Upgrading from v0.1

Install 0.2.0 over an existing v0.1 workspace. Nothing is rewritten:
issues created before the lifecycle shipped (no `workgraph_lifecycle_version`
metadata) are **legacy issues** — still readable, listable
(`workgraph_ready` with `legacy: true`), and closable by hand, but skipped
by the coordinator until approved. The first `workgraph_approve` on a
legacy issue migrates it — lazily, per issue, preserving every existing
metadata key. Read [Migrating from v0.1](#migrating-from-v01) for the
behavior changes.

### Legacy compatibility mode

Want v0.1-like behavior while you transition? Two opt-in settings:

```bash
pi --workgraph-compat-legacy-issues=true   # coordinator may dispatch legacy issues
# --workgraph-compat-in-session-executor defaults to true already
```

With `workgraph-compat-legacy-issues` enabled, the coordinator
auto-dispatches legacy issues; each claim lazily migrates the issue
(stamps lifecycle v1, enters phase `implementing`). A warning is logged
once per session naming the setting and this migration effect — the mode
is transitional, not a place to live. A legacy issue still carrying a
live v0.1 lease is respected and never claimed, under either setting.
This mode is exercised by `test/migration.test.ts`.

### Protocol-only usage

External executor adapters and observers can depend on the protocol
without loading the Pi extension:

```ts
import { CH, RunCompleted, parseMessage } from "pi-workgraph/protocol";
```

`pi-workgraph/protocol` is session-free: importing it registers nothing
and pulls in no session-bound module. It does import `@earendil-works/pi-ai`
and `typebox` at runtime (both peer dependencies), so protocol-only
consumers need those installed. The two adapters are also exported for
custom wiring — `pi-workgraph/adapters/in-session`,
`pi-workgraph/adapters/tiered`, and `pi-workgraph/adapters/pi-subagents`
(these ARE session-bound; they exist to be registered against a Pi
session). This is a documented consumption pattern with an import smoke
test, not a separately tested install mode.

## Migrating from v0.1

Pre-1.0, behavior-changing release. What changed in 0.2.0:

- **Close is gated.** Successful implementation never closes an issue
  directly anymore: lifecycle-v1 work closes through the judgment gate
  (independent review → bounded revisions → verification → accepted), or
  through an explicit, audited `workgraph_override`. Legacy issues close
  as before.
- **Dispatch is now the coordinator + executor protocol.** The v0.1
  in-session dispatch loop ("wake this agent with the issue") became an
  explicit executor adapter. The coordinator discovers executors first —
  no executor, no claim — then claims and delegates. The in-session
  adapter is registered by default (`workgraph-compat-in-session-executor`,
  default `true`); set it to `false` with no other executor for a
  correctly idle coordinator.
- **Approval is required for dispatch.** New and legacy issues are not
  auto-dispatched until `workgraph_approve` moves them to `ready`.
  v0.1-like auto-dispatch of legacy issues is the explicit
  `workgraph-compat-legacy-issues` opt-in (see
  [Legacy compatibility mode](#legacy-compatibility-mode)).
- **Leases are now run-scoped.** Claims made by the coordinator hold their
  lease under a generated `workgraph-run/<id>` identity whose lifetime is
  the workflow run's, not the initiating session's. This is a
  values-semantics note only — the three lease metadata keys are unchanged
  and **Convention-Version stays 1**: a mid-graph downgrade to 0.1.x is
  safe (the new `workgraph_*` keys are inert to 0.1.x).
- **Migration is lazy and non-destructive.** There is no bulk migration
  pass anywhere. An issue migrates when touched — approved or
  compat-claimed — in one metadata write that preserves every pre-existing
  key.

> The phase-6 spec refers to the legacy-dispatch setting as
> `compatLegacyDispatch`; it shipped (in 0.2.0-pre phases) as
> `compatLegacyIssues` / `--workgraph-compat-legacy-issues`, and that
> shipped name is the one that works.

## Tools

Nine typed tools, all schema-validated and race-safe. Agents are instructed
to use these instead of composing `bd` calls from bash — bare `--assignee`
writes are how leases get corrupted.

| Tool                  | What it does                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `workgraph_ready`     | List approved claimable issues (dependency-unblocked, unassigned); `legacy: true` lists unapproved |
| `workgraph_claim`     | Atomically claim an issue by id, or the next ready one; stamps a lease                             |
| `workgraph_release`   | Voluntarily hand a claimed issue back to the pool (fenced; clears assignee, reopens)               |
| `workgraph_close`     | Close an issue (fenced; lifecycle-v1 work must be phase `accepted` — the judgment gate's output)   |
| `workgraph_split`     | Split an issue into child issues; the parent is blocked until every child closes                   |
| `workgraph_heartbeat` | Renew the leases this worker holds (verifies the fencing epoch, pushes `lease_expires_at` forward) |
| `workgraph_approve`   | Approve a draft/legacy/escalated issue for dispatch: acceptance criteria, risk tier, phase `ready` |
| `workgraph_override`  | Explicit human override: force-close or force-release, bypassing guards — always audited           |
| `workgraph_status`    | One issue's full control-plane state: phase, lease, attempt, verdict, acceptance criteria          |

## Configuration

Resolution order per value: CLI flag > environment variable > default.

| Flag                                     | Environment variable                   | Default                         | Purpose                                                              |
| ---------------------------------------- | --------------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `--workgraph-lease-ttl-ms`               | `WORKGRAPH_LEASE_TTL_MS`               | `300000` (5 min)                | Lease time-to-live; expired leases are reclaimable                   |
| `--workgraph-heartbeat-ms`               | `WORKGRAPH_HEARTBEAT_MS`               | `60000` (60 s)                  | How often held leases are renewed                                    |
| `--workgraph-poll-ms`                    | `WORKGRAPH_POLL_MS`                    | `30000` (30 s)                  | Coordinator poll interval (floored at 5 s in production wiring)      |
| `--workgraph-sweep-interval-ms`          | `WORKGRAPH_SWEEP_INTERVAL_MS`          | the poll interval               | Expiry-sweep cadence (reclaims expired leases back to ready)         |
| `--workgraph-discovery-timeout-ms`       | `WORKGRAPH_DISCOVERY_TIMEOUT_MS`       | `2000` (2 s)                    | Executor-discovery collection window                                 |
| `--workgraph-accept-timeout-ms`          | `WORKGRAPH_ACCEPT_TIMEOUT_MS`          | `10000` (10 s)                  | Run-request accept/reject deadline                                   |
| `--workgraph-compat-in-session-executor` | `WORKGRAPH_COMPAT_IN_SESSION_EXECUTOR` | `true`                          | Register the in-session compatibility executor (the v0.1 wake path)  |
| `--workgraph-executor-id`                | `WORKGRAPH_EXECUTOR_ID`                | —                               | Pin executor selection to one executorId (errors when it's absent)   |
| `--workgraph-compat-legacy-issues`       | `WORKGRAPH_COMPAT_LEGACY_ISSUES`       | `false`                         | Opt-in: auto-dispatch legacy issues (lazy migration; warned once)    |
| `--workgraph-policy`                     | `WORKGRAPH_POLICY`                     | low advisory, med/high blocking | Per-risk-tier judgment-gate policy overrides (JSON)                  |
| `--workgraph-subagents-executor`         | `WORKGRAPH_SUBAGENTS_EXECUTOR`         | disabled                        | Opt-in: the experimental pi-subagents bridge                         |
| `--workgraph-worker-id`                  | `WORKGRAPH_WORKER_ID`                  | `{user}@{host}/{short-session}` | Worker identity used for claims, audit records, and fencing checks   |
| `--workgraph-dispatch`                   | —                                       | `true`                          | Kill switch: `false` keeps tools + context injection, no autonomy (the flag name predates the coordinator; it disables the coordinator) |

## How it works

- **Coordinator** — the successor to the v0.1 dispatch loop, on the same
  scheduling shell (poll timer plus Pi's `agent_settled` idle edge, one
  reentrancy-guarded tick). Each tick: fetch the ready pool (readiness is
  judged by array length, never exit codes), filter to approved lifecycle
  work, **discover executors first** (no executor → no claim), claim by id
  under a fresh `workgraph-run/` lease, persist intent, and delegate over
  the protocol. Completions are fenced (issue id + workflow-run id + lease
  epoch) and drive the judgment gate: independent review, policy
  application, bounded revisions, fingerprint-based escalation, and a
  policy-approved close. On restart, persisted runs are reconciled —
  re-adopted, completed, or abandoned to the reclaim path.
- **Context injection** — every turn, `before_agent_start` appends a fenced
  `<workgraph>` section to the system prompt: current claim with lease
  countdown, ready count (top 5 rendered, the rest folded into the count,
  ≤ 30 lines total), and the collision-free claiming rules. Per-turn
  re-injection is the compaction-survival workhorse: even when a summary
  drops graph state, the next turn re-adds it fresh. Graph state is cached
  for 10 s per workspace.
- **Compaction takeover** — when Pi compacts the conversation with work in
  flight, pi-workgraph runs the compaction itself so the summary preserves
  the in-flight issue id and title. With nothing claimed — and on every
  failure path — it falls back to Pi's default compaction.
- **Status bar** — current claim, lifecycle phase, executor, and lease
  countdown in the footer, TUI only; headless sessions never touch the UI.
- **Audit trail** — every lease transition is recorded as an issue comment
  (bd's own interaction log records nothing for `--claim` or metadata
  writes), and every verdict as a `workgraph-verdict` comment. See
  [Audit events](#5-audit-events) below.

All bd invocations are serialized through one internal queue and every tool
declares sequential execution — bd's embedded Dolt panics on concurrent
in-process access. Cross-process concurrency is bd's own locking, and is
exactly what the race suites exercise.

## The Lease Convention

**Convention-Version: 1**

This section is the interop contract. It is versioned independently of the
package: protocol changes bump the `Convention-Version` line above, not just
the npm semver. A third-party tool (any harness, not just Pi) can respect or
detect pi-workgraph leases by implementing what follows. Every stated
invariant is tied to a test in this repository via an HTML comment in this
document's source.

### 1. Metadata fields

Lease state lives in three issue-metadata keys. These key names are
**frozen**: renaming one is a breaking protocol change.

| Key                | Type    | Meaning                                                              |
| ------------------ | ------- | -------------------------------------------------------------------- |
| `lease_holder`     | string  | Worker identity of the current holder                                |
| `lease_epoch`      | integer | Fencing token — monotonic per issue, **never resets**                |
| `lease_expires_at` | string  | Lease expiry, RFC3339 UTC at **second** precision (bd's granularity) |

`lease_holder` values are **opaque strings** — compare them for equality,
never parse meaning out of them. Two shapes appear today: the initiating
session's worker identity (`{user}@{host}/{short-session-id}`) for direct
tool claims, and `workgraph-run/{id}` (a generated workflow-run identity
whose lifetime is the run's, not the initiating session's) for coordinator
claims. This is a semantics note about the *values*, not a key change —
the keys above stay frozen.

A leased issue as returned by `bd show <id> --json` (real output, abridged;
note that `bd show --json` returns an array):

```json
[
  {
    "id": "bdx-0qz",
    "title": "implement retry backoff",
    "status": "in_progress",
    "priority": 2,
    "issue_type": "task",
    "assignee": "garen@sandbox/1f3a9c2e",
    "updated_at": "2026-08-06T13:16:02Z",
    "metadata": {
      "lease_epoch": 3,
      "lease_holder": "garen@sandbox/1f3a9c2e",
      "lease_expires_at": "2026-08-06T13:21:01Z"
    }
  }
]
```

Readers must normalize: bd stores numeric-looking metadata values as JSON
numbers, but writers stamp them as strings — treat `lease_epoch` as an
integer however it round-trips, and treat a missing/garbled epoch as `0`
(a never-leased issue).

### 2. Invariants

bd has **no compare-and-swap**, so the fencing token is what makes the
protocol safe. These invariants are load-bearing:

<!-- Tested: test/race.test.ts — "8 concurrent claims -> exactly 1 winner, final assignee matches" -->

1. **bd's atomic `--claim` is the mutex.** Acquisition piggybacks on
`bd update <id> --claim` (or `bd ready --claim` for claim-next), which bd
serializes across processes: N concurrent claims produce exactly one
winner.
<!-- Tested: src/lease.test.ts — "stamps the lease trio on first acquire: epoch 1, holder, RFC3339 expiry" -->
2. **Acquisition is claim, then stamp, then verify.** After the atomic
claim, the holder writes all three lease keys in one metadata update
(epoch = current epoch + 1), then re-reads the issue and verifies its
holder and epoch landed. Same-key metadata races are last-writer-wins, so
post-write verification — not pretended atomicity — closes the window.
A holder that fails verification walks away (`lost-acquisition-race`).
<!-- Tested: src/lease.test.ts — "re-acquire by the same worker is a renewal — the epoch does NOT double-increment" -->
3. **Same-holder re-acquire is a renewal.** bd's claim is idempotent per
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
every metadata write bumps bd's `updated_at`, a live worker's issue
always looks fresh to the staleness sweep.
<!-- Tested: test/reclaim.test.ts — "SIGKILL'd worker's lease is reclaimed within TTL + poll + tolerance, with audit" -->
6. **Reclaim = epoch + 1, assignee overwrite, verify.** Takeover of an
expired lease writes the epoch bump and the assignee overwrite in ONE
`bd update`, so there is no window where the assignee moved but the epoch
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

```bash
# Stage 1 — server-side staleness filter (bd's clock):
bd list --status in_progress --updated-before <now - TTL> --json -n 0
```

then, client-side for each result:

```
Stage 2 — Date.parse(metadata.lease_expires_at) < now  (the holder's clock)
```

Why both: a heartbeating worker bumps `updated_at` on every renewal, so live
workers never appear in stage 1; and stage 2 confirms against the expiry the
holder actually wrote. A skewed clock must beat BOTH conditions before work
is stolen mid-flight. Because bd compares timestamps at second precision,
round the stage-1 cutoff UP to the next second so flooring doesn't hide a
just-expired lease.

<!-- Tested: src/lease.test.ts — "legacy no-lease claims are flagged expire-detected once, never reclaimed" -->

Stale `in_progress` issues with **no** lease metadata (claimed by a human's
manual `bd update --claim`, or by a tool that predates leases) are flagged
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

### 5. Audit events

bd records nothing in its own interaction log for `--claim` or
`--set-metadata` writes, so every lease transition self-emits an audit
record as an issue comment:

```
workgraph-lease <kind> <JSON details>
```

Read the trail back with `bd comments <id> --json` and grep for the
`workgraph-lease` prefix. The seven kinds:

| Kind                    | Emitted when                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `claim`                 | A lease was acquired (first stamp at a new epoch)                                  |
| `renew`                 | A heartbeat pushed the expiry (sampled 1-per-10 per issue to keep trails readable) |
| `release`               | A holder voluntarily released the issue                                            |
| `expire-detected`       | The sweep found a stale claim with no lease metadata (flagged, never reclaimed)    |
| `reclaim`               | An expired lease was taken over (records old holder, old/new epoch)                |
| `lost-acquisition-race` | A claim's lease stamp was overwritten before verification                          |
| `fencing-loss`          | A holder's heartbeat discovered its lease was reclaimed                            |

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

Beads' native statuses stay simple (`open`, `in_progress`, `blocked`,
`closed`); lifecycle phase is workgraph semantics, stored in namespaced
issue metadata:

| Key | Meaning |
|---|---|
| `workgraph_lifecycle_version` | Lifecycle schema version, initially `1` |
| `workgraph_phase` | `draft`, `ready`, `planning`, `implementing`, `judging`, `revising`, `verifying`, `accepted`, or `escalated` |
| `workgraph_workflow_run_id` | Stable ID covering planning, implementation, and all judgment/revision attempts for one claim |
| `workgraph_executor_id` | Selected executor adapter |
| `workgraph_attempt` | Current implementation/revision attempt number |
| `workgraph_risk_tier` | Policy input such as `low`, `medium`, or `high` |
| `workgraph_active_execution_id` | Executor-specific active run ID, when accepted |
| `workgraph_author_provenance` | Compact JSON describing effective harness, profile, provider, and model |
| `workgraph_last_verdict` | Compact verdict summary and durable audit-event reference |
| `workgraph_failure_fingerprint` | Hash used to detect a repeated failed attempt |
| `workgraph_plan_summary` | Compact plan summary; the full plan lives in the `workgraph-plan` comment trail |
| `workgraph_planner_provenance` | Compact JSON describing the planner's effective harness, provider, and model |

### 2. State transitions

```text
draft --approve--> ready --claim (planner offered)--> planning
draft --approve--> ready --claim (no planner)--> implementing
planning --plan accepted--> implementing
planning --failed/invalid plan--> escalated
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

Successful implementation transitions to judgment — it never closes the
issue directly. Only policy-approved judgment, a final verifier, or an
explicit audited human override may close.

<!-- Tested: test/invariants.test.ts — "release without a tracked lease is rejected, not silently performed" (pinned in phase 0, flipped in phase 1) -->

Every state-changing result is fenced: a completion, verdict, cancellation,
or promotion is ignored unless its issue ID, workflow run ID, and lease
epoch still match Beads. The v0.1 unfenced fallback release (releasing an
issue this process holds no tracked lease on) was removed in phase 1.

### 3. Protocol channels

Versioned execution envelopes (`protocolVersion: 1`; every message includes
`messageId`, `occurredAt`, and the relevant correlation identifiers) travel
over these Pi event-bus channels in the first transport:

| Channel | Direction | Purpose |
|---|---|---|
| `workgraph:v1:executor:discover` | core → adapters | Request capability offers |
| `workgraph:v1:executor:offer` | adapter → core | Advertise identity, roles, isolation, capacity, and supported profile semantics |
| `workgraph:v1:run:request` | core → adapter | Request an implementation, review, revision, or verification run |
| `workgraph:v1:run:accepted` | adapter → core | Bind the workflow request to an executor run |
| `workgraph:v1:run:rejected` | adapter → core | Reject before starting, with a stable reason code |
| `workgraph:v1:run:progress` | adapter → core | Advisory progress; never a durable transition by itself |
| `workgraph:v1:run:completed` | adapter → core | Return structured result, artifacts, evidence, and provenance |
| `workgraph:v1:run:cancel` | core → adapter | Interrupt a run after release, fencing loss, shutdown, or policy decision |
| `workgraph:v1:run:cancelled` | adapter → core | Acknowledge cancellation |
| `workgraph:v1:run:status-request` | core → adapter | Reconcile a persisted active run after restart |
| `workgraph:v1:run:status` | adapter → core | Report active, terminal, missing, or unreachable |
| `workgraph:v1:activity` | core → observers | Publish canonical lifecycle changes for UI/presence adapters |

<!-- Tested: test/invariants.test.ts — "with no executor available, a dispatch tick claims nothing" (pinned in phase 0, flipped in phase 2) -->

Dispatch must discover an eligible executor **before** claiming work: no
executor means no claim, and a missing or incompatible executor leaves the
issue ready.

Consume the schemas without the extension via the `pi-workgraph/protocol`
subpath export — see [Protocol-only usage](#protocol-only-usage).

### 4. Legacy compatibility

Issues without `workgraph_lifecycle_version` are legacy issues. They remain
readable, and migration is lazy and non-destructive: the first
`workgraph_approve` (or compat-mode claim) initializes them as lifecycle
version 1 in one metadata write that preserves every pre-existing key.
Automatic dispatch of legacy issues requires the **explicit opt-in
compatibility setting** `workgraph-compat-legacy-issues` — it is never an
implicit default — and logs a once-per-session warning naming the setting
and its migration effect. A legacy issue carrying a live v0.1 lease is
respected and never claimed, under either setting. See
[Migrating from v0.1](#migrating-from-v01).

### 5. The planner tier

An executor may offer the `planner` role. When one does, an approved issue
is claimed into `planning` and a planning run is dispatched before any
implementation; the accepted plan is then attached to the implementation
run (and to every revision of it) as the optional `plan` field on
`run:request`.

**Planning is a tier, not a stage.** When no executor offers `planner`, the
coordinator claims straight into `implementing` exactly as it did before the
role existed — same phase, same request, same audit. The in-session
compatibility executor offers only `implementer`, so this is the default.

Four rules the code enforces, each with a reason:

- **Never plan what cannot be built.** The tick only enters `planning` if
  the same discovery round also produced an implementer. Otherwise a
  planner-only offer set would plan, find nobody to implement, hand the
  issue back, and re-plan forever.
- **Failure escalates; it never degrades.** A planner that reports
  `failure`/`blocked` or returns an unparseable plan escalates the issue to
  `blocked` — it does *not* fall through to an unplanned implementation.
  Silently implementing without the plan would look identical to success
  while being the exact thing the operator wanted to prevent. Recover via
  re-approve, as with any escalation.
- **A plan is evidence, not authority.** The core never interprets steps or
  enforces `targets`, and a planner's refined `acceptanceCriteria` is
  recorded in the plan trail rather than overwriting the approved criteria
  on the issue — a planner that could rewrite its own bar would defeat the
  judgment gate.
- **Legacy issues never plan.** Their only migration entry is
  `implementing`, so compat-mode dispatch is unchanged.

One workflow run spans the whole chain: planner, implementer, and every
judgment sub-run share a lease, a `workgraph_workflow_run_id`, and a fencing
triple. A crashed planner is not re-adopted on restart — there is no partial
work to protect — it is abandoned, and the TTL sweep resets `planning` →
`ready` for a clean re-plan.

Model tiering (a heavier model plans, a capable one implements, a third
reviews) is a property of the **executor adapter**, not of this package:
the coordinator selects by role and validates reported provenance, and
deliberately does no model routing (see `src/policy.ts`). The bundled
[tiered executor](#6-optional-executor-the-tiered-executor) is that adapter.

### 6. Optional executor: the tiered executor

One model per role, each run a fresh `pi` process. This is the adapter the
planner tier exists for. It ships **disabled**; enable it by mapping roles
to models:

```bash
--workgraph-tiered-executor='{"enabled":true,"models":{
  "planner":"anthropic/claude-fable-5",
  "implementer":"anthropic/claude-opus-5",
  "reviewer":"openai-codex/gpt-5.6-sol"
}}'
# or the WORKGRAPH_TIERED_EXECUTOR env var
```

Ids take the `provider/id` form pi's own `--model` flag accepts. `pi update
--models` refreshes the catalogs they resolve against, and custom providers
live in `$PI_CODING_AGENT_DIR/models-store.json`. An id that does not
resolve fails at spawn and is reported as a failed run the judgment gate
then has to interpret — whereas omitting a role's key is handled cleanly
(the role is simply not offered), so a wrong id is worse than no id.

**On picking the reviewer.** `requireAuthorIndependence` passes when the
reviewer differs from the author on *at least one* required axis, so
`anthropic/claude-sonnet-5` reviewing `anthropic/claude-opus-5` is already
independent — the models differ even though the provider does not. A
cross-provider reviewer like the example above differs on both, which is
strictly stronger and survives a provider-side model substitution that
happens to land on the author's model. Point two roles at the *same* id and
the review is discarded and the issue escalates; that is intended.

Each run is spawned as `pi --mode json -p --no-session --model <id>`, and
the model the run **reports** using — never the one requested — becomes
`provenance.model`. A provider-side substitution therefore surfaces as a
failed independence check rather than as fake tiering.

Three properties worth knowing:

- **A role with no configured model is NOT offered.** Falling back to the
  ambient default would produce untiered work that still reports success —
  indistinguishable from the tiering you asked for. Map `reviewer` and the
  judgment gate gets an independent reviewer; leave it unmapped and the
  coordinator looks elsewhere.
- **Isolation is `none`, honestly.** Runs execute in the session's cwd; this
  adapter creates no worktrees. Advertising `worktree` without making one
  would be a lie the coordinator relies on when filtering offers. That is
  also why `maxConcurrency` defaults to 2 — concurrent mutating runs share
  one tree. Worktree isolation is a follow-up.
- **Structured output rides the prompt.** pi's CLI exposes no output-schema
  flag, so a request carrying `outputSchema` gets the schema inlined with an
  instruction to end on bare JSON; the final message is parsed into `plan`
  or `verdict`. Unparseable output is reported *without* the field, and the
  core's existing invalid-payload path audits and escalates it — the adapter
  never invents one.

Options: `models` (required), `piArgs`, `runTimeoutMs` (default 30 min),
`maxConcurrency` (default 2).

### 7. Optional executor: the pi-subagents bridge

> **Experimental and version-gated.** The bridge talks to
> [pi-subagents](https://github.com/fitchmultz/pi-subagents) **by event
> names only** — it imports zero pi-subagents code and this package
> declares no pi-subagents dependency in any block (CI enforces it).
> Because those event names are not a declared public API, the adapter
> validates the *installed* upstream package version (a package.json read,
> never an import; upstream advertises no version on its bus) and registers
> nothing on a mismatch. Expect breakage across upstream minor versions
> until upstream adopts the generic protocol.

The bridge ships **disabled**. Opt in explicitly:

```bash
# flag (or env WORKGRAPH_SUBAGENTS_EXECUTOR)
--workgraph-subagents-executor=true
# or with an explicit accepted upstream major.minor range:
--workgraph-subagents-executor='{"enabled":true,"versionRange":"0.32"}'
```

When configured and version-gated, it answers discovery as
`executorId: "pi-subagents"` offering `implementer`, `reviewer`, and
`revision` roles with `isolation: "worktree"` and a priority above the
in-session adapter — an operator who opted in prefers isolated background
workers. Unconfigured, the bridge is **never registered**: an unconfigured
extension answers discovery with no subagents offer and holds zero bus
subscriptions (a double gate — index.ts never calls the register function,
and the register function re-checks config itself).

Two semantics worth knowing:

- **Self-acceptance is never judgment.** A pi-subagents run can finalize
  with a parent-controlled self-review (`acceptance` ledger). The bridge
  maps that to implementation-completion evidence at most; a reviewer
  verdict is emitted only from a **separately launched** reviewer run's
  structured output.
- **Reported provenance.** Completions carry the model upstream *reported
  using*, never the one requested; the provider is split off only when the
  `provider/id` format is unambiguous.

**Activity events**: the coordinator publishes `workgraph:v1:activity` on
every canonical lifecycle change it commits (claim, phase transition,
verdict, escalation, close) — strictly after the corresponding write, for
UI/presence/kanban observers only (nothing in-core subscribes). Coverage
gap by design: the expiry sweep's reclaims and restart recovery's
re-adopt/abandon paths emit no activity — observers needing those must
read the audit comment trail.

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
source itself). `bd` must be on your `PATH`. Timers are compressed (2 s
TTLs), so the whole suite runs in a couple of minutes.

## Credits

- pi-beads — the human TUI for browsing and editing a beads graph; keep it
  installed alongside.
- pi-beads-extension — prior art for bd context injection in Pi; its
  patterns (and bugs) shaped this package's exec and injection rules.
- [@mancioshell/pi-board-agent](https://www.npmjs.com/package/@mancioshell/pi-board-agent)
  — the lockfile-before-claim idea that inspired the lease design.
- [beads](https://github.com/gastownhall/beads) — the work graph itself.

## License

[MIT](./LICENSE)
