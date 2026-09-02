# The git push guard

A worked example of the Lease Convention's ["merely detects" tier](../README.md#4-how-to-coexist):
turning *"heads up, I'm restacking — don't push until it's done"* from an
advisory broadcast into verified state that any harness's `git push`
respects.

## The problem it solves

An orchestrator rewriting a stack of branches broadcasts "pause pushes."
Children **mostly** listen — until one decides the restack is taking too
long, assumes it finished, and pushes over rewritten history. Broadcast
compliance is voluntary; the failure is an agent *guessing* the state of
the world instead of *reading* it.

## The design

One designated **sentinel issue** in the bd graph stands for the shared
ref space. Whoever rewrites history claims it; a `pre-push` hook in every
clone reads the lease and refuses pushes while it is live and held by
someone else. The hook is a pure Convention-Version 1 **detector**: it
reads `lease_holder` / `lease_epoch` / `lease_expires_at` and never
writes them.

| Sentinel state                              | `git push`                          |
| ------------------------------------------- | ----------------------------------- |
| no sentinel configured                      | allowed (hook inert)                |
| never leased, or released                   | allowed                             |
| live lease, holder is `$WORKGRAPH_WORKER_ID`| allowed (your own restack window)   |
| live lease, anyone else                     | **blocked**, with holder + expiry   |
| lease expired                               | allowed (expired = reclaimable)     |
| unparseable expiry / bd unreachable         | **blocked** (fail closed)           |

A crashed restacker never wedges the repo: the lease TTL (default 5 min,
renewed by heartbeat while the holder is alive) expires and pushes flow
again — the same reclaim semantics as any workgraph lease.

## Setup

Once per graph — create the sentinel (leave it **unapproved**: the
coordinator never dispatches legacy issues, so it will never be "worked"):

```bash
bd create "sentinel: git ref space (push guard)"
```

Once per clone (worktrees share it):

```bash
node scripts/git-push-guard.mjs install --issue <sentinel-id>
```

This copies the guard to the repo's hook path and sets
`git config workgraph.stackIssue <sentinel-id>`. In bd repos — where
`core.hooksPath` is `.beads/hooks` and bd manages its own `pre-push` —
the existing hook is preserved as `pre-push.pre-workgraph` and chained:
the guard runs first, and on allow executes the original with the same
arguments and stdin, exiting with its status. (A bd upgrade that
regenerates its hooks can overwrite the guard; re-run install.)

## The restack flow

```bash
# The restacker announces one stable identity to both its claims and its
# child processes (the hook compares it to lease_holder for self-pass):
WORKGRAPH_WORKER_ID=restacker@myhost pi
```

```text
> claim the sentinel issue          # workgraph_claim stamps the lease;
                                    # heartbeats renew it while you work
… restack, force-push (own pushes pass) …
> release the sentinel issue        # pushes flow again everywhere
```

Every other session's `git push` during that window fails with the
holder, the expiry, and instructions to wait — regardless of which
harness (or bare shell) runs it.

## Honest limits

- This guards against **guessing, not malice**. Any human can
  `git push --no-verify`; a hard guarantee belongs in server-side branch
  protection. The failure mode in the wild is agents inventing "it must
  have finished by now" — a hook that reads real state fixes exactly
  that.
- The guard blocks **all** pushes in the clone while the sentinel is
  leased, not just pushes to the restacked branches. Scoping to refs
  would complicate the guard for little gain: blocked pushes are
  TTL-bounded waits.
