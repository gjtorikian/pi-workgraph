/**
 * Control-plane invariant pins — phase 0 of the control-plane refactor
 * (docs/ideation/pi-workgraph-control-plane/spec-phase-0.md).
 *
 * Each pin asserted the TARGET behavior against the then-current modules,
 * so the assertion failed at first. They landed as vitest expected-failure
 * pins: the suite stayed green while the defect existed, and each pin
 * failed LOUDLY the moment the behavior shipped — forcing the delivering
 * phase to flip it to a plain `it()`. Each pin's comment names its
 * delivering phase; phase 6 audited that zero pins remain. ALL THREE pins
 * are now flipped: pin 1
 * (phase 1), pin 2 (phase 2 — also RETARGETED from registerDispatch to the
 * coordinator that replaced it in production wiring), and pin 3 (phase 3 —
 * the judgment gate).
 *
 * Per the spec's failure-modes table, every pin was first run as a plain
 * `it()` to confirm the failure landed on the target assertion (release succeeding,
 * the tick claiming, close succeeding) — never on setup.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindExec, getExecLog, resetExecLog } from "../src/bd.ts";
import type { WorkgraphConfig } from "../src/config.ts";
import {
  registerCoordinator,
  type CoordinatorController,
} from "../src/coordinator.ts";
import { resetIdentityForTest, setWorkerIdOverride } from "../src/identity.ts";
import { heldLeases, resetLeasesForTest } from "../src/lease.ts";
import { registerWorkgraphTools } from "../src/tools.ts";
import {
  asExtensionAPI,
  makeEventContext,
  makeMockPi,
  makeToolContext,
  type MockPi,
} from "./helpers/mock-pi.ts";
import { makeScratchGraph } from "./helpers/scratch.ts";

const WORKER = "invariant-worker";

// Huge scheduling intervals: ticks and beats fire only from the events a
// test emits, never from timers (the test/dispatch.test.ts pattern). The
// protocol timeouts are tiny and REAL — pin 2's tick must wait out the
// discovery window before deciding not to claim.
const TEST_CONFIG: WorkgraphConfig = {
  leaseTtlMs: 300_000,
  heartbeatMs: 600_000,
  pollMs: 600_000,
  sweepIntervalMs: 600_000, // the sweep never fires mid-test either
  discoveryTimeoutMs: 40,
  acceptTimeoutMs: 150,
  compatInSessionExecutor: false, // pin 2 requires an executorless bus
  // Pin 2 seeds a LEGACY issue: without the compat opt-in the phase-3
  // approved-only filter would skip it BEFORE discovery, and the pin would
  // pass for the wrong reason (no eligible issue rather than no executor).
  compatLegacyIssues: true,
  workerIdOverride: WORKER,
};

let mock: MockPi;
let controller: CoordinatorController;

function run(name: string, params: unknown, cwd: string) {
  const def = mock.tools.get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def.execute(
    `pin-${name}`,
    params,
    undefined,
    undefined,
    makeToolContext(cwd),
  );
}

beforeAll(() => {
  mock = makeMockPi();
  bindExec((command, args, options) => mock.exec(command, args, options));
  registerWorkgraphTools(asExtensionAPI(mock));
  // Pin 2 targets the COORDINATOR (phase 2 replaced registerDispatch in the
  // production wiring): no executor is installed on this mock's bus, so
  // discovery must come back empty and the claim must never happen.
  controller = registerCoordinator(asExtensionAPI(mock), {
    getConfig: () => TEST_CONFIG,
  });
  // Both surfaces agree on identity: the flag feeds the tools' prepare();
  // the direct override covers coordinator ticks before any tool call.
  mock.setFlag("workgraph-worker-id", WORKER);
  setWorkerIdOverride(WORKER);
}, 60_000);

afterAll(async () => {
  await controller?.teardown();
  resetLeasesForTest();
  resetIdentityForTest();
});

describe("control-plane invariants (phase-0 pins, all flipped — see spec-phase-0)", () => {
  // FLIPPED IN PHASE 1 (run-scoped leases): phase 1 removed the unfenced
  // fallback release. workgraph_release with no tracked lease now throws a
  // fencing error instead of performing a bare `bd update --assignee ""
  // --status open`; the matcher is tightened to the fencing rejection
  // specifically (phase 0 review finding).
  it(
    "release without a tracked lease is rejected, not silently performed",
    async () => {
      resetLeasesForTest();
      const graph = makeScratchGraph({ prefix: "pinrel" });
      try {
        const id = graph.createIssue("claimed elsewhere");
        // Claim via bd directly so THIS process tracks no lease on the
        // issue (same setup as the src/tools.test.ts conflict test).
        graph.bd(["update", id, "--claim", "--actor", "other-actor"]);
        // Target behavior: an untracked release is refused with a
        // fencing error instead of being performed.
        await expect(
          run("workgraph_release", { id }, graph.dir),
        ).rejects.toThrow(/fenc/i);
        // And the foreign claim survives untouched.
        const shown = graph.showIssue(id);
        expect(shown.status).toBe("in_progress");
        expect(shown.assignee).toBe("other-actor");
      } finally {
        graph.cleanup();
      }
    },
    30_000,
  );

  // FLIPPED IN PHASE 2 (coordinator / executor protocol): the coordinator
  // discovers an eligible executor BEFORE claiming — discovery precedes
  // `ready --claim`, so zero offers leave the ready pool untouched. The
  // "no claim" assertion is made on the bd exec log (no `--claim` entry
  // anywhere in the tick), not just on in-process state.
  it(
    "with no executor available, a dispatch tick claims nothing",
    async () => {
      resetLeasesForTest();
      resetExecLog();
      const graph = makeScratchGraph({ prefix: "pindsp", seed: 1 });
      const ectx = makeEventContext(graph.dir); // isIdle() defaults true
      try {
        const id = graph.seededIds[0]!;
        // One tick via Pi's TRUE idle signal (agent_settled). No executor
        // is on the bus: nothing answers the coordinator's discovery.
        await mock.emit("agent_settled", { type: "agent_settled" }, ectx.ctx);
        // Target behavior: the tick reaches the claim decision and leaves
        // the issue in the pool.
        expect(controller.current()).toBeNull();
        expect(heldLeases(graph.dir)).toHaveLength(0);
        const shown = graph.showIssue(id);
        expect(shown.status).toBe("open");
        expect(shown.assignee ?? "").toBe("");
        // The tick probed the pool but bd's claim path NEVER ran.
        const log = getExecLog();
        expect(log.some((entry) => entry.args.includes("--claim"))).toBe(false);
        expect(log.some((entry) => entry.args[0] === "ready")).toBe(true);
      } finally {
        // Tear down while the scratch dir still exists so nothing leaks
        // into the remaining pins (teardown is idempotent — afterAll
        // re-runs it).
        await controller.teardown(ectx.ctx);
        graph.cleanup();
      }
    },
    30_000,
  );

  // FLIPPED IN PHASE 3 (lifecycle + judgment gate): workgraph_close now
  // permits only phase-`accepted` work. The holder still passes the fencing
  // check (epoch + holder match) — it is the JUDGMENT guard that rejects:
  // this issue was self-claimed with no lifecycle phase, so it has not
  // passed judgment and may not be closed by its implementer. Closure
  // arrives only through the coordinator's policy-approved tail or an
  // audited workgraph_override.
  it(
    "successful implementation cannot close the issue directly",
    async () => {
      resetLeasesForTest();
      const graph = makeScratchGraph({ prefix: "pincls" });
      try {
        const id = graph.createIssue("implemented, awaiting judgment", {
          priority: 0,
        });
        // Claim through the tool so THIS process IS the lease holder —
        // the fencing check passes and only a judgment gate could refuse.
        await run("workgraph_claim", { id }, graph.dir);
        // Target behavior: the implementer's close is rejected pending
        // judgment.
        await expect(
          run(
            "workgraph_close",
            { id, reason: "implementation finished" },
            graph.dir,
          ),
        ).rejects.toThrow(/judg/i);
        expect(graph.showIssue(id).status).not.toBe("closed");
      } finally {
        graph.cleanup();
      }
    },
    30_000,
  );
});
