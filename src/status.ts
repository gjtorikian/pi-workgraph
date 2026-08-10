/**
 * Status-bar surface (Full tier): current claim + lease countdown in the
 * footer via `ctx.ui.setStatus`. Every entry point guards on `ctx.hasUI` —
 * headless dispatch (`pi -p`) must never touch the UI, and must never crash
 * for lack of one. Dispatch is the only caller (acquire/heartbeat/release
 * edges); there is no timer here.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Lease } from "./types.ts";

/** The `setStatus` key this extension owns. */
export const STATUS_KEY = "workgraph";

/** `m:ss` countdown, floored at `0:00` (never negative). */
export function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Optional lifecycle context rendered alongside the countdown (phase 3). */
export interface LeaseStatusDetail {
  /** The lifecycle phase (implementing/judging/revising/verifying). */
  phase?: string;
  /** The selected executor adapter id. */
  executorId?: string;
}

/** Render the status-bar text for a held lease. Exported for tests. */
export function renderLeaseStatus(
  lease: Lease,
  nowMs: number,
  detail?: LeaseStatusDetail,
): string {
  const remaining = Date.parse(lease.expiresAt) - nowMs;
  let text = `⛏ ${lease.issueId} · ${formatCountdown(remaining)}`;
  if (detail?.phase) text += ` · ${detail.phase}`;
  if (detail?.executorId) text += ` · ${detail.executorId}`;
  return text;
}

/** Show (or refresh) the claim + countdown. No-op without a UI. */
export function showLeaseStatus(
  ctx: ExtensionContext,
  lease: Lease,
  now: () => number = Date.now,
  detail?: LeaseStatusDetail,
): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, renderLeaseStatus(lease, now(), detail));
}

/**
 * Clear the workgraph status line. Called on release, close, fencing loss,
 * and teardown — clearing (setStatus with undefined), never just
 * overwriting, so a finished claim leaves no stale countdown behind.
 */
export function clearLeaseStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
}
