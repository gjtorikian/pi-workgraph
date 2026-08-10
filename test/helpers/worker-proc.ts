/**
 * Real child-process workers for the cross-process race/fencing/reclaim
 * suites. The in-extension exec queue serializes bd calls per process, which
 * is orthogonal to cross-process races — so the contract suites spawn REAL
 * processes with distinct identities (`WORKGRAPH_WORKER_ID` env → workerId
 * override → bd `--actor`), the verified probe topology.
 *
 * This file is both the spawn helper (imported by tests) and the child
 * entrypoint (executed directly with `node worker-proc.ts <mode> <cwd>
 * <issueId>` — Node ≥ 23.6 strips types natively). Child protocol, one
 * status line per transition on stdout:
 *
 *   mode "claim" — attempt `bd update <id> --claim`:
 *     CLAIMED <workerId>   exit 0   (won the race)
 *     CONFLICT             exit 1   (bd's expected exit-1 conflict path)
 *
 *   mode "hold" — acquire a lease (TTL from WORKGRAPH_LEASE_TTL_MS), then
 *   wait for a stdin command:
 *     ACQUIRED <epoch>                 lease held; waiting
 *     "finish\n" on stdin → the holder's final write, THROUGH the fencing
 *     gate:
 *       CLOSED                exit 0   (still holding; issue closed)
 *       FENCED <holder> <epoch> exit 3 (lease was reclaimed; write aborted)
 *
 *   any unexpected error: exit 2 with the error on stderr.
 */
import {
  execFile,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { BdError, bindExec, claim, close, show } from "../../src/bd.ts";
import { setWorkerIdOverride, workerId } from "../../src/identity.ts";
import {
  acquireLease,
  leaseEpochOf,
  leaseHolderOf,
  verifyHolding,
} from "../../src/lease.ts";

const THIS_FILE = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Spawn helper (test-process side)
// ---------------------------------------------------------------------------

export interface SpawnWorkerOptions {
  mode: "claim" | "hold";
  /** Scratch workspace the worker operates in. */
  cwd: string;
  issueId: string;
  /** Distinct identity for this worker (env WORKGRAPH_WORKER_ID + BEADS_ACTOR). */
  workerId: string;
  /** Lease TTL for "hold" mode, in ms (env WORKGRAPH_LEASE_TTL_MS). */
  ttlMs?: number;
}

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface WorkerProc {
  child: ChildProcess;
  pid: number;
  /** Resolves when the child exits (never rejects). */
  exited: Promise<WorkerExit>;
  /** Resolve with the first stdout line starting with `prefix` (past or future). */
  waitForLine(prefix: string, timeoutMs?: number): Promise<string>;
  /** Write one command line to the child's stdin. */
  send(line: string): void;
  kill(signal?: NodeJS.Signals): void;
}

export function spawnWorker(opts: SpawnWorkerOptions): WorkerProc {
  const child = spawn(
    process.execPath,
    [THIS_FILE, opts.mode, opts.cwd, opts.issueId],
    {
      env: {
        ...process.env,
        WORKGRAPH_WORKER_ID: opts.workerId,
        BEADS_ACTOR: opts.workerId,
        ...(opts.ttlMs !== undefined
          ? { WORKGRAPH_LEASE_TTL_MS: String(opts.ttlMs) }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  const lines: string[] = [];
  const waiters: {
    prefix: string;
    resolve: (line: string) => void;
    reject: (e: Error) => void;
  }[] = [];
  let lineBuf = "";
  let closed = false;

  const pushLine = (line: string): void => {
    lines.push(line);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (line.startsWith(waiters[i]!.prefix)) {
        const [w] = waiters.splice(i, 1);
        w!.resolve(line);
      }
    }
  };

  child.stdout!.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    lineBuf += text;
    let nl: number;
    while ((nl = lineBuf.indexOf("\n")) !== -1) {
      pushLine(lineBuf.slice(0, nl).trimEnd());
      lineBuf = lineBuf.slice(nl + 1);
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited: Promise<WorkerExit> = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      closed = true;
      if (lineBuf.length > 0) pushLine(lineBuf.trimEnd());
      for (const w of waiters.splice(0)) {
        w.reject(
          new Error(
            `worker exited (code ${code}, signal ${signal}) before "${w.prefix}"; stderr: ${stderr.trim()}`,
          ),
        );
      }
      resolve({ code, signal, stdout, stderr });
    });
  });

  return {
    child,
    pid: child.pid!,
    exited,
    waitForLine(prefix, timeoutMs = 30_000) {
      const existing = lines.find((l) => l.startsWith(prefix));
      if (existing) return Promise.resolve(existing);
      if (closed) {
        return Promise.reject(
          new Error(`worker already exited before "${prefix}"; stderr: ${stderr.trim()}`),
        );
      }
      return new Promise<string>((resolve, reject) => {
        const waiter = { prefix, resolve, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for "${prefix}"`));
        }, timeoutMs);
        timer.unref();
        const settle = <T>(fn: (v: T) => void) => (v: T) => {
          clearTimeout(timer);
          fn(v);
        };
        waiter.resolve = settle(resolve);
        waiter.reject = settle(reject);
      });
    },
    send(line) {
      child.stdin!.write(`${line}\n`);
    },
    kill(signal = "SIGTERM") {
      child.kill(signal);
    },
  };
}

// ---------------------------------------------------------------------------
// Child entrypoint
// ---------------------------------------------------------------------------

/**
 * Direct execFile-backed ExecFn with pi's exec.js result semantics (killed →
 * code 0, spawn failure → code 1) — mock-pi's `realExec` is the semantic
 * reference; child processes have no pi to delegate to.
 */
function childExec(
  command: string,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: options?.cwd, timeout: options?.timeout },
      (error, out, err) => {
        const stdoutText = String(out);
        const stderrText = String(err);
        if (!error) {
          resolve({ stdout: stdoutText, stderr: stderrText, code: 0, killed: false });
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
          resolve({ stdout: stdoutText, stderr: stderrText, code: 0, killed: true });
          return;
        }
        const code = typeof anyErr.code === "number" ? anyErr.code : 1;
        resolve({ stdout: stdoutText, stderr: stderrText, code, killed: false });
      },
    );
  });
}

async function childMain(): Promise<void> {
  const [, , mode, cwd, issueId] = process.argv;
  if (!mode || !cwd || !issueId) {
    process.stderr.write("usage: worker-proc.ts <claim|hold> <cwd> <issueId>\n");
    process.exit(2);
  }

  bindExec(childExec);
  setWorkerIdOverride(process.env.WORKGRAPH_WORKER_ID);
  const me = workerId();
  const ttlMs = Number(process.env.WORKGRAPH_LEASE_TTL_MS ?? "300000");

  try {
    if (mode === "claim") {
      await claim(cwd, issueId, me);
      process.stdout.write(`CLAIMED ${me}\n`);
      process.exit(0);
    }

    if (mode === "hold") {
      // The child's explicit lease identity: holder AND bd actor are its
      // env-derived worker id (LeaseActor threading, phase 1).
      const outcome = await acquireLease(cwd, {
        issueId,
        ttlMs,
        actor: { holder: me, bdActor: me },
      });
      if (outcome.kind !== "acquired") {
        process.stdout.write(`NOT_ACQUIRED ${outcome.kind}\n`);
        process.exit(4);
      }
      process.stdout.write(`ACQUIRED ${outcome.lease.epoch}\n`);

      const rl = createInterface({ input: process.stdin });
      for await (const line of rl) {
        if (line.trim() !== "finish") continue;
        // The holder's final write goes through the fencing gate: a stale
        // holder that wakes up after a reclaim must abort, not write.
        const stillMine = await verifyHolding(cwd, outcome.lease, me);
        if (!stillMine) {
          const cur = await show(cwd, issueId);
          process.stdout.write(
            `FENCED ${leaseHolderOf(cur) ?? "unknown"} ${leaseEpochOf(cur)}\n`,
          );
          process.exit(3);
        }
        await close(cwd, issueId, "closed by worker-proc hold", me);
        process.stdout.write("CLOSED\n");
        process.exit(0);
      }
      process.exit(0); // stdin closed without a command
    }

    process.stderr.write(`unknown mode: ${mode}\n`);
    process.exit(2);
  } catch (e) {
    if (e instanceof BdError && /already claimed/i.test(e.message)) {
      process.stdout.write("CONFLICT\n");
      process.exit(1);
    }
    process.stderr.write(
      `${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exit(2);
  }
}

const isChildInvocation =
  process.argv[1] !== undefined && resolve(process.argv[1]) === THIS_FILE;

if (isChildInvocation) {
  void childMain();
}
