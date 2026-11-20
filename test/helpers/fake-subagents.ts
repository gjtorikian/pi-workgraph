/**
 * A fake pi-subagents runtime for the bridge's contract tests: speaks the
 * upstream event names and payloads re-verified against pi-subagents 0.34.8
 * — so the workgraph side of the exchange
 * (`src/adapters/pi-subagents.ts`) is the real adapter under test, exactly
 * as `test/helpers/fake-executor.ts` fakes the workgraph protocol side.
 *
 * Faithful upstream behaviors this fake reproduces:
 *  - `started` is emitted only after the cancel-pending check
 *    (slash-bridge.ts:98-114);
 *  - a cancel for an UNKNOWN requestId parks in `pendingCancels` and is
 *    NEVER acknowledged — only a later request with that id gets the
 *    "Cancelled before start" error response (slash-bridge.ts:62-72,
 *    98-112);
 *  - cancellation of an in-flight run surfaces as an error RESPONSE, not a
 *    distinct event (the AbortSignal path);
 *  - a request with no upstream extension context gets an error response
 *    WITHOUT a `started` (slash-bridge.ts:80-93) — the `"no-context"` mode.
 *
 * BACKGROUND LAUNCH, as read in pi-subagents 0.41.0 and 0.89.1 (the shapes
 * are recorded beside `UPSTREAM_EVENTS`):
 *  - a request that resolves to async answers `started` and then a launch
 *    RECEIPT on the response channel (`details.asyncId`, `details.runId`,
 *    no results). It never takes the foreground lock, so
 *    `singleForeground` does not apply to it. Each launch gets an id of its
 *    own: the first is `background-id`, later ones `background-id-2`, …;
 *  - the run ends when the test calls `completeBackground()`, which emits
 *    `subagent:async-complete` with `{ id, runId, success, state, results }`;
 *  - `{ action: "interrupt", id }` for a live background run is recorded in
 *    `interrupts` and, like upstream, is not itself the run's end.
 * A script entry is still consumed for a request that turns out to be
 * async, as it always was.
 *
 * The fake never imports pi-subagents either — the whole point of the
 * event-names-only bridge is that neither side needs the package installed.
 */
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { UPSTREAM_EVENTS } from "../../src/adapters/pi-subagents.ts";

/** One scripted upstream behavior; arrays consume in request order (the
 *  last entry repeats once exhausted — the fake-executor convention). */
export interface FakeSubagentsBehavior {
  /**
   * - `"respond"` (default): started → updates → response;
   * - `"stall"`: started, then wait for `respond()` / a cancel;
   * - `"silent"`: record the request, emit nothing (timeout paths);
   * - `"no-context"`: error response with NO started (upstream's
   *   missing-extension-context path).
   */
  mode?: "respond" | "stall" | "silent" | "no-context";
  /** Reported effective model (`results[0].model`) — what provenance echoes. */
  model?: string;
  /** Reviewer structured output (`results[0].structuredOutput`). */
  structuredOutput?: unknown;
  /** Self-acceptance ledger (`results[0].acceptance`) — never a verdict. */
  acceptance?: unknown;
  finalOutput?: string;
  isError?: boolean;
  errorText?: string;
  exitCode?: number;
  interrupted?: boolean;
  detached?: boolean;
  /** `subagent:slash:update` payloads emitted before the response. */
  updates?: Array<{
    currentTool?: string;
    toolCount?: number;
    progress?: Array<{ model?: string; recentOutput?: unknown[] }>;
  }>;
  /** Extra artifact paths reported on `results[0].artifactPaths`. */
  artifactPaths?: Record<string, string>;
}

/** A recorded upstream request. */
export interface RecordedSubagentRequest {
  requestId: string;
  params: Record<string, unknown>;
}

export interface FakeSubagentsHandle {
  /** Every well-formed `subagent:slash:request`, in order. */
  requests: RecordedSubagentRequest[];
  /** Every `subagent:slash:cancel` requestId, in order. */
  cancels: string[];
  /** RequestIds parked by cancels for unknown runs (never acked). */
  pendingCancels: Set<string>;
  /** Async ids of background runs launched and not yet completed, oldest first. */
  backgroundRuns: string[];
  /** Ids named by `action: "interrupt"` requests, in order. */
  interrupts: string[];
  /**
   * End a background run: emit `subagent:async-complete` for `asyncId`
   * (default: the oldest live one). `success` defaults to true and `state`
   * to `complete` (or `failed`).
   */
  completeBackground(
    asyncId?: string,
    result?: { success?: boolean; state?: string },
  ): void;
  /** Complete a stalled run (default: the most recent stalled request). */
  respond(overrides?: FakeSubagentsBehavior & { requestId?: string }): void;
  /** Emit a raw response payload verbatim (shape-drift tests). */
  emitRawResponse(payload: unknown): void;
  /** Unsubscribe from the bus. */
  uninstall(): void;
}

export interface FakeSubagentsOptions {
  /** The foreground executor's session-wide lock, checked AFTER started. */
  singleForeground?: boolean;
  /** Mirror modern Pi defaults and its optional forced-background policy. */
  asyncByDefault?: boolean;
  forceTopLevelAsync?: boolean;
  /** Behavior script, consumed per request (last repeats). */
  script?: FakeSubagentsBehavior | FakeSubagentsBehavior[];
}

function buildResult(behavior: FakeSubagentsBehavior): Record<string, unknown> {
  const single: Record<string, unknown> = {
    agent: "fake-agent",
    task: "fake-task",
    exitCode: behavior.exitCode ?? (behavior.isError ? 1 : 0),
    interrupted: behavior.interrupted,
    detached: behavior.detached,
    usage: {},
    ...(behavior.model !== undefined ? { model: behavior.model } : {}),
    ...(behavior.structuredOutput !== undefined
      ? { structuredOutput: behavior.structuredOutput }
      : {}),
    ...(behavior.acceptance !== undefined
      ? { acceptance: behavior.acceptance }
      : {}),
    ...(behavior.finalOutput !== undefined
      ? { finalOutput: behavior.finalOutput }
      : {}),
    ...(behavior.artifactPaths !== undefined
      ? { artifactPaths: behavior.artifactPaths }
      : {}),
  };
  return {
    content: [{ type: "text", text: behavior.finalOutput ?? "done" }],
    details: { mode: "single", results: [single] },
  };
}

export function installFakeSubagents(
  events: EventBus,
  opts: FakeSubagentsOptions = {},
): FakeSubagentsHandle {
  const requests: RecordedSubagentRequest[] = [];
  const cancels: string[] = [];
  const pendingCancels = new Set<string>();
  const inFlight = new Map<string, FakeSubagentsBehavior>();
  const backgroundRuns: string[] = [];
  const interrupts: string[] = [];
  let backgroundCounter = 0;
  let cursor = 0;
  const unsubs: (() => void)[] = [];

  function nextBehavior(): FakeSubagentsBehavior {
    const script = opts.script;
    if (script === undefined) return {};
    if (!Array.isArray(script)) return script;
    if (script.length === 0) return {};
    const behavior = script[Math.min(cursor, script.length - 1)]!;
    cursor += 1;
    return behavior;
  }

  function emitResponse(
    requestId: string,
    behavior: FakeSubagentsBehavior,
  ): void {
    events.emit(UPSTREAM_EVENTS.response, {
      requestId,
      result: buildResult(behavior),
      isError: behavior.isError === true,
      ...(behavior.errorText !== undefined
        ? { errorText: behavior.errorText }
        : {}),
    });
  }

  unsubs.push(
    events.on(UPSTREAM_EVENTS.request, (data) => {
      if (data === null || typeof data !== "object") return;
      const payload = data as { requestId?: unknown; params?: unknown };
      if (typeof payload.requestId !== "string") return;
      if (payload.params === null || typeof payload.params !== "object") return;
      const requestId = payload.requestId;
      const params = payload.params as Record<string, unknown>;
      requests.push({
        requestId,
        params: payload.params as Record<string, unknown>,
      });

      if (params.action === "interrupt" && typeof params.id === "string") {
        interrupts.push(params.id);
      }
      const behavior = nextBehavior();
      const async =
        opts.forceTopLevelAsync && params.foregroundOnly !== true
          ? true
          : (params.async ?? opts.asyncByDefault ?? true);
      if (async) {
        // A launch gets its own id; a management request (an interrupt)
        // launches nothing and keeps the constant receipt it always had.
        let asyncId = "background-id";
        if (params.action === undefined) {
          backgroundCounter += 1;
          if (backgroundCounter > 1) asyncId = `background-id-${backgroundCounter}`;
          backgroundRuns.push(asyncId);
        }
        events.emit(UPSTREAM_EVENTS.started, { requestId });
        events.emit(UPSTREAM_EVENTS.response, {
          requestId,
          isError: false,
          result: {
            content: [{ type: "text", text: "Background subagent started" }],
            details: {
              mode: "single",
              runId: asyncId,
              results: [],
              asyncId,
              asyncDir: `/tmp/${asyncId}`,
            },
          },
        });
        return;
      }
      const mode = behavior.mode ?? "respond";
      if (mode === "silent") return;
      if (mode === "no-context") {
        // Upstream's missing-context path: error response, NO started.
        events.emit(UPSTREAM_EVENTS.response, {
          requestId,
          result: {
            content: [
              {
                type: "text",
                text: "No active extension context for slash subagent execution.",
              },
            ],
            details: { mode: "single", results: [] },
          },
          isError: true,
          errorText: "No active extension context.",
        });
        return;
      }
      if (pendingCancels.delete(requestId)) {
        // Cancelled before start (slash-bridge.ts:98-112): error response,
        // NO started.
        events.emit(UPSTREAM_EVENTS.response, {
          requestId,
          result: {
            content: [{ type: "text", text: "Cancelled." }],
            details: { mode: "single", results: [] },
          },
          isError: true,
          errorText: "Cancelled before start.",
        });
        return;
      }

      events.emit(UPSTREAM_EVENTS.started, { requestId });
      if (opts.singleForeground && inFlight.size > 0) {
        events.emit(UPSTREAM_EVENTS.response, {
          requestId,
          isError: true,
          errorText:
            "Rejected: a subagent call is already in progress. Issue exactly ONE subagent call per turn.",
          result: { details: { mode: "single", results: [] } },
        });
        return;
      }
      for (const update of behavior.updates ?? []) {
        events.emit(UPSTREAM_EVENTS.update, { requestId, ...update });
      }
      if (mode === "stall") {
        inFlight.set(requestId, behavior);
        return;
      }
      emitResponse(requestId, behavior);
    }),
  );

  unsubs.push(
    events.on(UPSTREAM_EVENTS.cancel, (data) => {
      if (data === null || typeof data !== "object") return;
      const requestId = (data as { requestId?: unknown }).requestId;
      if (typeof requestId !== "string") return;
      cancels.push(requestId);
      const behavior = inFlight.get(requestId);
      if (behavior) {
        // Abort of an in-flight run: the response IS the acknowledgement.
        inFlight.delete(requestId);
        emitResponse(requestId, {
          ...behavior,
          isError: true,
          errorText: "Aborted.",
        });
        return;
      }
      // Unknown requestId: park it — upstream NEVER acks these.
      pendingCancels.add(requestId);
    }),
  );

  return {
    requests,
    cancels,
    pendingCancels,
    backgroundRuns,
    interrupts,
    completeBackground(asyncId, result = {}) {
      const id = asyncId ?? backgroundRuns[0];
      const index = id === undefined ? -1 : backgroundRuns.indexOf(id);
      if (id === undefined || index === -1) {
        throw new Error("fake subagents: no background run to complete");
      }
      backgroundRuns.splice(index, 1);
      const success = result.success ?? true;
      const state = result.state ?? (success ? "complete" : "failed");
      events.emit(UPSTREAM_EVENTS.asyncComplete, {
        id,
        runId: id,
        mode: "single",
        success,
        state,
        results: [{ agent: "fake-agent", success, status: state }],
      });
    },
    respond(overrides = {}) {
      const requestId =
        overrides.requestId ?? [...inFlight.keys()][inFlight.size - 1];
      if (requestId === undefined || !inFlight.has(requestId)) {
        throw new Error("fake subagents: no stalled run to respond to");
      }
      const behavior = inFlight.get(requestId)!;
      inFlight.delete(requestId);
      emitResponse(requestId, { ...behavior, ...overrides });
    },
    emitRawResponse(payload) {
      events.emit(UPSTREAM_EVENTS.response, payload);
    },
    uninstall() {
      for (const off of unsubs) off();
      unsubs.length = 0;
    },
  };
}
