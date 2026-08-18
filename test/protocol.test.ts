/**
 * Protocol v1 envelope validation (spec-phase-2): per-schema accept/reject,
 * version gating, extra-field tolerance, and the handler-level idempotency
 * primitive (duplicate / late / reordered deliveries against the bounded
 * seen-set). Pure in-memory — no bd, no scratch graphs.
 *
 * Run via `npm run test:protocol`.
 */
import { describe, expect, it } from "vitest";
import {
  CH,
  Discover,
  ExecutorOffer,
  newEnvelope,
  parseMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  RunAccepted,
  RunCancel,
  RunCompleted,
  RunRejected,
  RunRequest,
  RunStatus,
  RunStatusRequest,
  SeenMessages,
  type ExecutorOfferT,
  type RunCompletedT,
  type RunRequestT,
  type RunStatusT,
} from "../src/protocol.ts";

function validOffer(): ExecutorOfferT {
  return {
    ...newEnvelope(),
    inReplyTo: "disc-1",
    executorId: "exec-a",
    adapterVersion: "1.0.0",
    roles: ["implementer"],
    harness: "pi",
    isolation: "none",
    supportsCancellation: true,
    supportsReconciliation: false,
  };
}

function validRequest(): RunRequestT {
  return {
    ...newEnvelope(),
    executorId: "exec-a",
    issue: {
      id: "wg-1",
      title: "do the thing",
      workflowClass: "reviewed",
      riskTier: "medium",
    },
    workflowRunId: "workgraph-run/abc",
    leaseEpoch: 3,
    role: "implementer",
    attempt: 1,
    workspace: { baseRevision: "", requiresIsolation: false },
  };
}

function validCompleted(): RunCompletedT {
  return {
    ...newEnvelope(),
    workflowRunId: "workgraph-run/abc",
    executionId: "exec-run-1",
    issueId: "wg-1",
    leaseEpoch: 3,
    outcome: "success",
    artifacts: ["src/thing.ts"],
    evidence: ["tests green"],
    provenance: { harness: "pi", profile: "initiating" },
  };
}

describe("channel constants", () => {
  it("declares exactly the twelve workgraph:v1 channels from the README table", () => {
    const channels = Object.values(CH);
    expect(channels).toHaveLength(12);
    for (const channel of channels) {
      expect(channel).toMatch(/^workgraph:v1:/);
    }
    expect(new Set(channels).size).toBe(12);
    // The names the phase-0 README locked, verbatim.
    expect(channels.sort()).toEqual(
      [
        "workgraph:v1:executor:discover",
        "workgraph:v1:executor:offer",
        "workgraph:v1:run:request",
        "workgraph:v1:run:accepted",
        "workgraph:v1:run:rejected",
        "workgraph:v1:run:progress",
        "workgraph:v1:run:completed",
        "workgraph:v1:run:cancel",
        "workgraph:v1:run:cancelled",
        "workgraph:v1:run:status-request",
        "workgraph:v1:run:status",
        "workgraph:v1:activity",
      ].sort(),
    );
  });
});

describe("envelope", () => {
  it("newEnvelope mints version-1 envelopes with unique ids and RFC3339 timestamps", () => {
    const a = newEnvelope();
    const b = newEnvelope();
    expect(a.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(a.messageId).not.toBe(b.messageId);
    expect(Number.isNaN(Date.parse(a.occurredAt))).toBe(false);
  });

  it("rejects protocolVersion 2 on every run-scoped schema", () => {
    for (const [channel, schema, message] of [
      [CH.offer, ExecutorOffer, validOffer()],
      [CH.runRequest, RunRequest, validRequest()],
      [CH.runCompleted, RunCompleted, validCompleted()],
    ] as const) {
      const v2 = { ...message, protocolVersion: 2 };
      expect(() => parseMessage(channel, schema, v2)).toThrow(ProtocolError);
    }
  });
});

describe("schema validation", () => {
  it("a valid offer parses; missing required fields reject", () => {
    const offer = validOffer();
    expect(parseMessage(CH.offer, ExecutorOffer, offer)).toEqual(offer);
    for (const field of [
      "messageId",
      "inReplyTo",
      "executorId",
      "roles",
      "isolation",
      "supportsCancellation",
    ]) {
      const broken: Record<string, unknown> = { ...offer };
      delete broken[field];
      expect(
        () => parseMessage(CH.offer, ExecutorOffer, broken),
        `offer without ${field} must reject`,
      ).toThrow(ProtocolError);
    }
  });

  it("a valid run request parses; the fencing fields are required", () => {
    const request = validRequest();
    expect(parseMessage(CH.runRequest, RunRequest, request)).toEqual(request);
    for (const field of ["workflowRunId", "leaseEpoch", "issue", "executorId"]) {
      const broken: Record<string, unknown> = { ...request };
      delete broken[field];
      expect(() => parseMessage(CH.runRequest, RunRequest, broken)).toThrow(
        ProtocolError,
      );
    }
  });

  it("validates optional workflow topology and risk independently", () => {
    const request = validRequest();
    expect(parseMessage(CH.runRequest, RunRequest, request)).toEqual(request);
    expect(() =>
      parseMessage(CH.runRequest, RunRequest, {
        ...request,
        issue: { ...request.issue, workflowClass: "mystery" },
      }),
    ).toThrow(ProtocolError);
    expect(() =>
      parseMessage(CH.runRequest, RunRequest, {
        ...request,
        issue: { ...request.issue, riskTier: "extreme" },
      }),
    ).toThrow(ProtocolError);
  });

  it("a valid completion parses; a bad outcome enum rejects", () => {
    const completed = validCompleted();
    expect(parseMessage(CH.runCompleted, RunCompleted, completed)).toEqual(
      completed,
    );
    expect(() =>
      parseMessage(CH.runCompleted, RunCompleted, {
        ...completed,
        outcome: "sort-of-done",
      }),
    ).toThrow(ProtocolError);
    for (const field of ["workflowRunId", "issueId", "leaseEpoch", "provenance"]) {
      const broken: Record<string, unknown> = { ...completed };
      delete broken[field];
      expect(() => parseMessage(CH.runCompleted, RunCompleted, broken)).toThrow(
        ProtocolError,
      );
    }
  });

  it("extra fields are tolerated (non-strict by design)", () => {
    const offer = { ...validOffer(), futureField: { nested: true } };
    expect(() => parseMessage(CH.offer, ExecutorOffer, offer)).not.toThrow();
    const completed = { ...validCompleted(), tracing: "abc123" };
    expect(() =>
      parseMessage(CH.runCompleted, RunCompleted, completed),
    ).not.toThrow();
    const discover = { ...newEnvelope(), scope: "everything" };
    expect(() => parseMessage(CH.discover, Discover, discover)).not.toThrow();
  });

  it("correlation replies validate inReplyTo as required", () => {
    const accepted = {
      ...newEnvelope(),
      inReplyTo: "req-1",
      workflowRunId: "workgraph-run/abc",
      executionId: "e-1",
      issueId: "wg-1",
      leaseEpoch: 1,
      executorId: "exec-a",
    };
    expect(parseMessage(CH.runAccepted, RunAccepted, accepted)).toEqual(accepted);
    const { inReplyTo: _dropped, ...withoutReply } = accepted;
    expect(() =>
      parseMessage(CH.runAccepted, RunAccepted, withoutReply),
    ).toThrow(ProtocolError);
    expect(() =>
      parseMessage(CH.runRejected, RunRejected, {
        ...accepted,
        reason: undefined,
      }),
    ).toThrow(ProtocolError);
  });

  it("status-request/status round-trip with the optional phase-4 addressing fields", () => {
    // The bare phase-2 shapes stay valid (the additions are optional)…
    const bareRequest = {
      ...newEnvelope(),
      workflowRunId: "workgraph-run/abc",
      issueId: "wg-1",
    };
    expect(() =>
      parseMessage(CH.runStatusRequest, RunStatusRequest, bareRequest),
    ).not.toThrow();
    const bareStatus = { ...bareRequest, status: "missing" };
    expect(() => parseMessage(CH.runStatus, RunStatus, bareStatus)).not.toThrow();
    // …and the addressed/correlated forms parse too, embedded terminal
    // completion included (the terminal-during-downtime transport).
    const addressed = {
      ...bareRequest,
      executorId: "exec-a",
      executionId: "exec-run-9",
    };
    expect(() =>
      parseMessage(CH.runStatusRequest, RunStatusRequest, addressed),
    ).not.toThrow();
    const terminal: RunStatusT = {
      ...newEnvelope(),
      inReplyTo: bareRequest.messageId,
      workflowRunId: "workgraph-run/abc",
      issueId: "wg-1",
      status: "terminal",
      executionId: "exec-run-9",
      completion: validCompleted(),
    };
    expect(parseMessage(CH.runStatus, RunStatus, terminal)).toEqual(terminal);
    // The embedded completion is schema-checked, not just carried.
    expect(() =>
      parseMessage(CH.runStatus, RunStatus, {
        ...terminal,
        completion: { nonsense: true },
      }),
    ).toThrow(ProtocolError);
    // A bogus status enum still rejects.
    expect(() =>
      parseMessage(CH.runStatus, RunStatus, { ...bareStatus, status: "alive" }),
    ).toThrow(ProtocolError);
  });

  it("run:cancel tolerates and carries the optional executionId", () => {
    const bare = {
      ...newEnvelope(),
      workflowRunId: "workgraph-run/abc",
      issueId: "wg-1",
    };
    expect(() => parseMessage(CH.runCancel, RunCancel, bare)).not.toThrow();
    const targeted = { ...bare, executionId: "exec-run-9", reason: "shutdown" };
    expect(parseMessage(CH.runCancel, RunCancel, targeted)).toEqual(targeted);
  });
});

describe("parseMessage errors", () => {
  it("throws a ProtocolError naming the channel with validation detail", () => {
    try {
      parseMessage(CH.runCompleted, RunCompleted, { nonsense: true });
      expect.unreachable("parseMessage must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolError);
      const err = e as ProtocolError;
      expect(err.channel).toBe(CH.runCompleted);
      expect(err.message).toContain(CH.runCompleted);
      expect(err.detail.length).toBeGreaterThan(0);
    }
  });

  it("rejects non-object payloads outright", () => {
    for (const raw of [null, undefined, 42, "completed", []]) {
      expect(() => parseMessage(CH.runCompleted, RunCompleted, raw)).toThrow(
        ProtocolError,
      );
    }
  });
});

describe("handler idempotency (SeenMessages)", () => {
  it("a duplicate messageId is recognized regardless of delivery order", () => {
    const seen = new SeenMessages();
    // First deliveries — all fresh.
    expect(seen.seen("m-1")).toBe(false);
    expect(seen.seen("m-2")).toBe(false);
    expect(seen.seen("m-3")).toBe(false);
    // Duplicate: immediate re-delivery.
    expect(seen.seen("m-3")).toBe(true);
    // Late duplicate: an old message re-delivered after newer ones.
    expect(seen.seen("m-1")).toBe(true);
    // Reordered fresh deliveries are NOT conflated with duplicates.
    expect(seen.seen("m-5")).toBe(false);
    expect(seen.seen("m-4")).toBe(false);
    expect(seen.seen("m-5")).toBe(true);
  });

  it("is bounded: old ids are evicted FIFO past capacity", () => {
    const seen = new SeenMessages(3);
    seen.seen("a");
    seen.seen("b");
    seen.seen("c");
    seen.seen("d"); // evicts "a"
    expect(seen.seen("a")).toBe(false); // forgotten — treated as fresh again
    expect(seen.seen("d")).toBe(true); // recent ids still deduped
  });
});
