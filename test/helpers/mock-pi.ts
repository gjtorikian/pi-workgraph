/**
 * Minimal mock `pi` for tests: records every exec invocation, then delegates
 * to the real child_process.execFile with result semantics mirroring pi's
 * dist/core/exec.js — a signal-killed process resolves `code: 0,
 * killed: true`, and a spawn failure resolves `code: 1` with empty stderr.
 *
 * Phase 3 growth (all ADDITIVE — six suites import the Phase 1/2 surface):
 * an awaiting event emitter over the existing handlers map, a `sendMessage`
 * recorder, an `appendEntry` recorder, a `before_agent_start` emitter that
 * applies pi's systemPrompt chaining plus a prompt accumulator, a
 * forced-compaction simulator, and a richer event-context factory.
 */
import { execFile } from "node:child_process";
import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface RecordedExec {
  command: string;
  args: string[];
  options?: ExecOptions;
}

/** A `pi.sendMessage` invocation as recorded by the mock. */
export interface RecordedMessage {
  message: {
    customType: string;
    content: unknown;
    display: boolean;
    details?: unknown;
  };
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
}

/** A `pi.appendEntry` invocation as recorded by the mock. */
export interface RecordedEntry {
  customType: string;
  data?: unknown;
}

/** One `pi.events.emit` call as recorded by the mock bus. */
export interface RecordedBusEvent {
  channel: string;
  data: unknown;
}

/**
 * The mock's EventBus. The SIGNATURE mirrors the real
 * `dist/core/event-bus.d.ts` exactly — `emit(channel, data): void` (fire
 * and forget, handlers NOT awaited), `on` returns an unsubscribe function,
 * handlers receive ONLY `data` — so `asExtensionAPI` stays honest and no
 * flush semantics can leak into production code. The test-only awaiting
 * lives in `MockPi.flushEvents()`, which drains the promises async handlers
 * returned.
 */
export interface MockEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

// biome-ignore format: keep the loose tool type on one line
export type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface MockPi {
  // ---- the ExtensionAPI subset this phase exercises ----
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  registerTool(tool: AnyToolDefinition): void;
  registerFlag(
    name: string,
    options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
  ): void;
  getFlag(name: string): boolean | string | undefined;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  sendMessage(
    message: RecordedMessage["message"],
    options?: RecordedMessage["options"],
  ): void;
  appendEntry(customType: string, data?: unknown): void;
  /** The shared extension event bus (phase 2: the protocol transport). */
  events: MockEventBus;

  // ---- test introspection ----
  execCalls: RecordedExec[];
  tools: Map<string, AnyToolDefinition>;
  handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
  /** Set a flag value as if it were passed on the CLI. */
  setFlag(name: string, value: boolean | string | undefined): void;
  /** Peak number of concurrently in-flight exec calls (serialization guard). */
  maxInFlight: number;

  // ---- Phase 3: events + message recording ----
  /** Every `sendMessage` call, in order. */
  sendMessages: RecordedMessage[];
  /** Every `appendEntry` call, in order. */
  entries: RecordedEntry[];
  /** Every `events.emit` call, in order (phase 2: protocol assertions). */
  busEvents: RecordedBusEvent[];
  /**
   * Live bus-handler count — total across channels, or one channel's
   * (phase 5: the "unconfigured bridge leaves ZERO subscription side
   * effects" assertion needs handler introspection, not just emit logs).
   */
  busHandlerCount(channel?: string): number;
  /**
   * Await every promise returned by async bus handlers, draining until no
   * new work appears (handlers may emit further events). Real Pi's `emit`
   * never awaits — this is a TEST-ONLY determinism valve; production code
   * must never rely on it (correlation is always subscribe-first + IDs).
   */
  flushEvents(): Promise<void>;
  /** Final system prompt of every `emitBeforeAgentStart`, in order. */
  systemPrompts: string[];
  /**
   * Fire an event: awaits every registered handler in registration order
   * (pi's `ExtensionHandler` contract is `(event, ctx)`), collecting results.
   */
  emit(eventName: string, event: unknown, ctx: ExtensionContext): Promise<unknown[]>;
  /**
   * Fire `before_agent_start` with pi's chaining semantics: each handler
   * sees the current systemPrompt; a returned `{ systemPrompt }` replaces it
   * for the next handler. The final prompt is pushed onto `systemPrompts`
   * and returned.
   */
  emitBeforeAgentStart(
    ctx: ExtensionContext,
    input: { systemPrompt: string; prompt?: string },
  ): Promise<string>;
  /**
   * Simulate a forced compaction: fires `session_before_compact` with a
   * minimal synthetic preparation and reports whether any handler took the
   * compaction over. Criterion-5 tests follow this with an
   * `emitBeforeAgentStart` carrying a truncated system prompt.
   */
  simulateForcedCompaction(
    ctx: ExtensionContext,
    overrides?: Record<string, unknown>,
  ): Promise<{ takenOver: boolean; results: unknown[] }>;
}

/** Real execFile delegate with pi's exec.js result semantics. */
function realExec(
  command: string,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: options?.cwd, timeout: options?.timeout },
      (error, stdout, stderr) => {
        const out = String(stdout);
        const err = String(stderr);
        if (!error) {
          resolve({ stdout: out, stderr: err, code: 0, killed: false });
          return;
        }
        const anyErr = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: string | null;
          code?: number | string | null;
        };
        const killed =
          anyErr.killed === true ||
          (typeof anyErr.signal === "string" && anyErr.signal.length > 0);
        if (killed) {
          // pi resolves killed processes as code 0, killed true.
          resolve({ stdout: out, stderr: err, code: 0, killed: true });
          return;
        }
        // Numeric code = process exit code; anything else (e.g. ENOENT
        // string) mirrors pi's spawn-failure path: code 1, killed false.
        const code = typeof anyErr.code === "number" ? anyErr.code : 1;
        resolve({ stdout: out, stderr: err, code, killed: false });
      },
    );
  });
}

export function makeMockPi(): MockPi {
  const execCalls: RecordedExec[] = [];
  const tools = new Map<string, AnyToolDefinition>();
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const flagValues = new Map<string, boolean | string | undefined>();
  const flagDefaults = new Map<string, boolean | string | undefined>();
  const sendMessages: RecordedMessage[] = [];
  const entries: RecordedEntry[] = [];
  const systemPrompts: string[] = [];
  const busEvents: RecordedBusEvent[] = [];
  const busHandlers = new Map<string, Set<(data: unknown) => void>>();
  let busPending: Promise<unknown>[] = [];
  let inFlight = 0;

  const mock: MockPi = {
    async exec(command, args, options) {
      execCalls.push({ command, args, options });
      inFlight += 1;
      mock.maxInFlight = Math.max(mock.maxInFlight, inFlight);
      try {
        return await realExec(command, args, options);
      } finally {
        inFlight -= 1;
      }
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerFlag(name, options) {
      flagDefaults.set(name, options.default);
    },
    getFlag(name) {
      return flagValues.has(name) ? flagValues.get(name) : flagDefaults.get(name);
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(message, options) {
      sendMessages.push({ message, options });
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
    events: {
      emit(channel, data) {
        busEvents.push({ channel, data });
        // Snapshot: a handler subscribing mid-dispatch must not receive
        // this emission (matches the real bus's iteration semantics).
        const handlers = [...(busHandlers.get(channel) ?? [])];
        for (const handler of handlers) {
          try {
            const result = handler(data) as unknown;
            if (
              result !== null &&
              typeof result === "object" &&
              typeof (result as PromiseLike<unknown>).then === "function"
            ) {
              busPending.push(Promise.resolve(result));
            }
          } catch {
            // Real emit is fire-and-forget: a throwing handler never
            // breaks the dispatch loop.
          }
        }
      },
      on(channel, handler) {
        const set = busHandlers.get(channel) ?? new Set();
        set.add(handler);
        busHandlers.set(channel, set);
        return () => {
          set.delete(handler);
        };
      },
    },
    busEvents,
    busHandlerCount(channel) {
      if (channel !== undefined) return busHandlers.get(channel)?.size ?? 0;
      let total = 0;
      for (const set of busHandlers.values()) total += set.size;
      return total;
    },
    async flushEvents() {
      // Drain in waves: an awaited handler may emit further events whose
      // handlers return new promises.
      while (busPending.length > 0) {
        const wave = busPending;
        busPending = [];
        await Promise.allSettled(wave);
      }
    },
    execCalls,
    tools,
    handlers,
    setFlag(name, value) {
      if (value === undefined) flagValues.delete(name);
      else flagValues.set(name, value);
    },
    maxInFlight: 0,
    sendMessages,
    entries,
    systemPrompts,
    async emit(eventName, event, ctx) {
      const list = handlers.get(eventName) ?? [];
      const results: unknown[] = [];
      for (const handler of list) {
        results.push(await handler(event, ctx));
      }
      return results;
    },
    async emitBeforeAgentStart(ctx, input) {
      let systemPrompt = input.systemPrompt;
      const list = handlers.get("before_agent_start") ?? [];
      for (const handler of list) {
        const event = {
          type: "before_agent_start",
          prompt: input.prompt ?? "",
          systemPrompt,
          systemPromptOptions: {},
        };
        const result = (await handler(event, ctx)) as
          | { systemPrompt?: string }
          | undefined
          | null;
        if (result && typeof result.systemPrompt === "string") {
          systemPrompt = result.systemPrompt;
        }
      }
      systemPrompts.push(systemPrompt);
      return systemPrompt;
    },
    async simulateForcedCompaction(ctx, overrides = {}) {
      const event = {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-0",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 100_000,
          fileOps: { readFiles: [], modifiedFiles: [] },
          settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
        },
        branchEntries: [],
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
        ...overrides,
      };
      const results = await mock.emit("session_before_compact", event, ctx);
      const takenOver = results.some(
        (r) =>
          r !== undefined &&
          r !== null &&
          typeof r === "object" &&
          "compaction" in (r as Record<string, unknown>) &&
          (r as Record<string, unknown>).compaction !== undefined,
      );
      return { takenOver, results };
    },
  };
  return mock;
}

/** Cast the mock to ExtensionAPI for code that takes the real interface. */
export function asExtensionAPI(mock: MockPi): ExtensionAPI {
  return mock as unknown as ExtensionAPI;
}

/** Minimal ExtensionContext for direct execute() calls in tests. */
export function makeToolContext(
  cwd: string,
  sessionId = "mock-session-0123456789abcdef",
): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

/** One `ctx.ui.setStatus` call as recorded by the event context. */
export interface RecordedStatus {
  key: string;
  text: string | undefined;
}

export interface EventContextOptions {
  sessionId?: string;
  /** Initial `ctx.isIdle()` value (default true). */
  idle?: boolean;
  /** Initial `ctx.hasPendingMessages()` value (default false). */
  pendingMessages?: boolean;
  /** `ctx.hasUI` (default true, so status assertions work out of the box). */
  hasUI?: boolean;
  /** `ctx.mode` (default "tui"). */
  mode?: "tui" | "rpc" | "json" | "print";
  /** `ctx.model` (default undefined — compaction tests inject one). */
  model?: unknown;
  /** `ctx.modelRegistry.getApiKeyAndHeaders` result (default `{ ok: true }`). */
  auth?: { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } | { ok: false; error: string };
  /** `ctx.thinkingLevel` (default undefined). */
  thinkingLevel?: unknown;
}

/**
 * An event-handler ExtensionContext (richer than {@link makeToolContext}):
 * `isIdle()`/`hasPendingMessages()` are mutable knobs, `ui.setStatus` calls
 * are recorded, and the model/auth surface the compaction takeover reads is
 * injectable.
 */
export interface MockEventContext {
  ctx: ExtensionContext;
  /** Every `ui.setStatus` call, in order. */
  statusCalls: RecordedStatus[];
  setIdle(idle: boolean): void;
  setPendingMessages(pending: boolean): void;
}

export function makeEventContext(
  cwd: string,
  opts: EventContextOptions = {},
): MockEventContext {
  const statusCalls: RecordedStatus[] = [];
  let idle = opts.idle ?? true;
  let pending = opts.pendingMessages ?? false;
  const auth = opts.auth ?? { ok: true as const };

  const ctx = {
    cwd,
    sessionManager: {
      getSessionId: () => opts.sessionId ?? "mock-session-0123456789abcdef",
    },
    mode: opts.mode ?? "tui",
    hasUI: opts.hasUI ?? true,
    ui: {
      setStatus(key: string, text: string | undefined) {
        statusCalls.push({ key, text });
      },
      notify() {},
    },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => auth,
    },
    signal: undefined,
  } as unknown as ExtensionContext;

  return {
    ctx,
    statusCalls,
    setIdle(v: boolean) {
      idle = v;
    },
    setPendingMessages(v: boolean) {
      pending = v;
    },
  };
}
