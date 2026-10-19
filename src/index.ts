/**
 * pi-workgraph — Pi extension exposing the work graph as six
 * typed tools for coordinated agent workers, plus (Phase 3) an in-session
 * dispatch loop, per-turn context injection, a compaction takeover, and a
 * status-bar surface.
 *
 * Loads with no build step: Pi's jiti loader consumes this TypeScript
 * directly via the `"pi": { "extensions": ["./src/index.ts"] }` manifest.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInSessionExecutor } from "./adapters/in-session.ts";
import { isPiSubagentProcess, registerPiSubagentsExecutor } from "./adapters/pi-subagents.ts";
import { registerCompactionTakeover } from "./compaction.ts";
import { registerConfigFlags, resolveConfig } from "./config.ts";
import { registerContextInjection } from "./context.ts";
import { registerCoordinator } from "./coordinator.ts";
// registerDispatch is DEPRECATED (phase 2) and no longer wired here — the
// coordinator owns scheduling; MIN_POLL_MS remains the wiring-layer floor.
import { MIN_POLL_MS } from "./dispatch.ts";
import { noteSessionId, setWorkerIdOverride } from "./identity.ts";
import { heldLeases } from "./lease.ts";
import { configureStore, initWorkspace } from "./store.ts";
import { registerSweep } from "./sweep.ts";
import { effectiveTiers, noteSessionCwd } from "./settings.ts";
import {
  describeTiers,
  parseTiersValue,
  resolveTiers,
  setResolvedTiers,
  storeTiers,
} from "./tiers.ts";
import { registerWorkgraphTools } from "./tools.ts";

export default function piWorkgraph(pi: ExtensionAPI): void {
  registerConfigFlags(pi);
  registerWorkgraphTools(pi);
  registerWorkgraphCommand(pi);
  // Executor children retain tools, while scheduling and recovery belong to
  // the parent coordinator. Pi runtime detection stays in the Pi adapter.
  if (isPiSubagentProcess()) return;

  // Model tiers resolve against the registry FIRST on session_start — this
  // handler is registered before every adapter and the coordinator, so the
  // first dispatch already sees the routing table.
  pi.on("session_start", async (_event, ctx) => {
    noteSessionCwd(ctx.cwd);
    configureStore(resolveConfig(pi).store);
    // Flag/env, else project .pi/settings.json, else what a `workgraph_tiers`
    // call stored in this workspace, else ~/.pi/agent/settings.json.
    const effective = await effectiveTiers(resolveConfig(pi).tiers, ctx.cwd);
    if (!effective) {
      setResolvedTiers(undefined);
      return;
    }
    const { resolved, unresolved } = resolveTiers(ctx.modelRegistry, effective.tiers);
    setResolvedTiers(resolved);
    for (const miss of unresolved) {
      console.error(
        `[pi-workgraph] tier ${miss.role}: no available model matches "${miss.pattern}" — that role runs untiered`,
      );
    }
  });

  // The in-session compatibility executor MUST register before the
  // coordinator: both listen for `agent_settled`, and registration order
  // guarantees the adapter observes the run state from the PREVIOUS tick —
  // a run the coordinator requests during this settle completes on the
  // next one, never instantly (see the adapter's header). It gates itself
  // on `compatInSessionExecutor` (default true) at every event, so a
  // disabled adapter never offers.
  registerInSessionExecutor(pi, { getConfig: () => resolveConfig(pi) });

  // The OPTIONAL pi-subagents bridge (phase 5) — DOUBLE-gated: this outer
  // gate never calls the register function unless `subagentsExecutor` is
  // enabled, and the register function re-checks config + the upstream
  // version gate before subscribing to anything. Registration is deferred
  // to session_start because flags are not readable at load; this handler
  // is registered BEFORE the coordinator's, so a configured bridge's bus
  // subscriptions exist before the first reconciliation/discovery pass.
  let subagentsRegistered = false;
  pi.on("session_start", () => {
    if (subagentsRegistered) return;
    if (resolveConfig(pi).subagentsExecutor?.enabled !== true) return;
    subagentsRegistered = true;
    registerPiSubagentsExecutor(pi, { getConfig: () => resolveConfig(pi) });
  });

  // The coordinator resolves config lazily; the 5 s poll floor lives HERE
  // (the wiring layer), never inside coordinator.ts, so tests inject tiny
  // timers. It registers its own session_start handler, which runs startup
  // RECONCILIATION (src/recovery.ts — re-adopt/complete/abandon/reclaim
  // persisted runs) before the first coordination pass (ticks no-op behind
  // the reconciling latch), then the poll timer; plus an agent_settled tick
  // and an idempotent session_shutdown graceful teardown (in-session runs
  // release immediately; isolated executions get cancel-first semantics).
  const coordinator = registerCoordinator(pi, {
    getConfig: () => {
      const config = resolveConfig(pi);
      return { ...config, pollMs: Math.max(config.pollMs, MIN_POLL_MS) };
    },
  });

  // The production expiry sweep: every session runs one. Each tick calls
  // findExpired() and reclaims each expired lease (fenced — concurrent
  // sweepers elect exactly one winner), then releases it so the issue lands
  // back in the ready pool. The same MIN_POLL_MS floor as dispatch is
  // applied HERE (the wiring layer), never inside sweep.ts, so tests inject
  // tiny intervals.
  registerSweep(pi, {
    getConfig: () => {
      const config = resolveConfig(pi);
      return {
        ...config,
        sweepIntervalMs: Math.max(config.sweepIntervalMs, MIN_POLL_MS),
      };
    },
  });

  registerContextInjection(pi);
  registerCompactionTakeover(pi, {
    getCurrent: (cwd) => {
      // The coordinator knows the in-flight run (active run first, else the
      // latest run parked in judging) — the summary must retain its run id,
      // phase, attempt, and evidence refs, not just the issue title; fall
      // back to the held-lease registry for work the model claimed itself
      // via workgraph_claim.
      const run = coordinator.current();
      if (run) {
        return {
          issueId: run.issue.id,
          title: run.issue.title,
          workflowRunId: run.workflowRunId,
          phase: run.phase,
          attempt: run.attempt,
          ...(run.evidence !== undefined ? { evidence: run.evidence } : {}),
        };
      }
      const lease = heldLeases(cwd)[0];
      return lease ? { issueId: lease.issueId } : null;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // Probe the store availability up front (the tools throw a one-line install
    // hint when it's missing — the extension itself stays loaded), wire the
    // identity override, and resolve the session-id component of workerId()
    // now that a ctx exists.
    setWorkerIdOverride(resolveConfig(pi).workerIdOverride);
    noteSessionId(ctx.sessionManager.getSessionId());
  });
}

/**
 * `/workgraph <init [prefix] | tiers | help>` — the few operator actions
 * that are awkward to route through a model turn.
 */
function registerWorkgraphCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workgraph", {
    description: "workgraph: init [prefix] (create the workspace here), tiers (show model routing)",
    async handler(args, ctx) {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const say = (message: string, type: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(message, type);
        else console.log(`[pi-workgraph] ${message}`);
      };
      switch (sub) {
        case "init": {
          const result = await initWorkspace(ctx.cwd, { prefix: rest[0] });
          say(
            `${result.created ? "Initialized" : "Found"} workgraph workspace for ${result.root} — ${result.databasePath} (ids "${result.prefix}-…")`,
          );
          return;
        }
        case "tiers": {
          if (rest[0]) {
            // `/workgraph tiers <json>` (or off) stores the choice here.
            await storeTiers(ctx.cwd, parseTiersValue(rest.join(" ")));
          }
          const effective = await effectiveTiers(resolveConfig(pi).tiers, ctx.cwd);
          if (!effective) {
            say(
              'No model tiers configured. Declare "workgraph": { "tiers": { "planner": "provider/id", ... } } in ~/.pi/agent/settings.json or .pi/settings.json.',
            );
            return;
          }
          const { resolved, unresolved } = resolveTiers(ctx.modelRegistry, effective.tiers);
          setResolvedTiers(resolved);
          const lines = [`(from ${effective.origin})`, ...describeTiers(resolved)];
          for (const miss of unresolved) lines.push(`${miss.role}: no match for "${miss.pattern}"`);
          say(lines.length > 0 ? lines.join("\n") : "No tiers resolved");
          return;
        }
        default:
          say("usage: /workgraph init [prefix] | tiers [json|off]", "warning");
      }
    },
  });
}
