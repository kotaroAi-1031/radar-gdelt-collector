// The collection state machine, as pure functions.
//
// Two lanes share one checkpoint row:
// - live:     keeps the last ~26 hours complete. Takes priority whenever it
//             is more than LIVE_MAX_LAG_SEC behind, and repairs the whole gap
//             with a single success.
// - backfill: walks the older timeline forward, at most once per
//             BACKFILL_MIN_INTERVAL_SEC, and never into the live lane's
//             recent past.
//
// The window is the cursor: a capped response advances the cursor to the
// newest `seendate` it contained (the next call continues from there), and a
// complete response advances it to the window end. Nothing is thrown away and
// nothing is bisected except a window GDELT refuses as too heavy.

import {
  BACKFILL_END_MARGIN_SEC,
  BACKFILL_MIN_INTERVAL_SEC,
  BACKOFF_BASE_SEC,
  BACKOFF_MAX_LEVEL,
  BACKOFF_MAX_SEC,
  DEFAULT_WINDOW_SEC,
  HORIZON_MARGIN_SEC,
  HORIZON_PROBE_STEP_SEC,
  LIVE_MAX_AGE_SEC,
  LIVE_MAX_LAG_SEC,
  MAX_AGE_SEC,
  MAX_RECORDS,
  MAX_WINDOW_SEC,
  MIN_WINDOW_SEC,
  AIMD_GROW_BELOW,
} from "./config.ts";

export type Lane = "live" | "backfill" | "idle";

export type HoleReason = "horizon" | "stall" | "heavy" | "capped";

export interface Hole {
  start: number;
  end: number;
  reason: HoleReason;
}

export interface CursorState {
  next_start: number | null;
  live_start: number | null;
  not_before: number;
  last_backfill_at: number;
  window_sec: number;
  backoff_level: number;
}

export interface Window {
  start: number;
  end: number;
  hole: Hole | null;
}

export interface Advance {
  cursor: number;
  capped: boolean;
  hole: Hole | null;
}

export function horizonFloor(now: number): number {
  return now - MAX_AGE_SEC + HORIZON_MARGIN_SEC;
}

export function clampWindowSec(sec: number | null | undefined): number {
  const n = Number(sec);
  const base = Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_WINDOW_SEC;
  return Math.min(Math.max(base, MIN_WINDOW_SEC), MAX_WINDOW_SEC);
}

export function chooseLane(cp: CursorState, now: number): Lane {
  // A backoff is fleet-visible state: no lane may ignore it.
  if (now < cp.not_before) return "idle";
  if (cp.live_start === null) return "live";
  if (now - cp.live_start > LIVE_MAX_LAG_SEC) return "live";
  if (now - cp.last_backfill_at >= BACKFILL_MIN_INTERVAL_SEC) return "backfill";
  return "idle";
}

// Whether this firing is a plain backoff skip (kept as a distinct audit
// status so "the fleet was throttled" stays visible in `runs`).
export function isBackoffSkip(cp: CursorState, now: number): boolean {
  return now < cp.not_before;
}

export function liveWindow(cp: CursorState, now: number): Window | null {
  // The live lane never owns anything older than LIVE_MAX_AGE_SEC: below that
  // the backfill lane is responsible, so clamping here loses nothing and
  // records no hole. The horizon floor is applied as a hard guard in case the
  // two constants are ever changed into conflict.
  const earliest = Math.max(now - LIVE_MAX_AGE_SEC, horizonFloor(now));
  const start = Math.max(cp.live_start ?? earliest, earliest);
  // The adaptive window also bounds the live lane, so a window GDELT refuses
  // as too heavy can actually be retried smaller. At steady state the gap is
  // smaller than the window and this is simply `end = now`.
  const end = Math.min(now, start + clampWindowSec(cp.window_sec));
  if (end <= start) return null;
  return { start, end, hole: null };
}

export function backfillWindow(cp: CursorState, now: number): Window | null {
  const floor = horizonFloor(now);
  let start = cp.next_start ?? now - MAX_AGE_SEC;
  let hole: Hole | null = null;
  if (start < floor) {
    hole = { start, end: floor, reason: "horizon" };
    start = floor;
  }
  const limit = now - BACKFILL_END_MARGIN_SEC;
  if (start >= limit) return null;
  const end = Math.min(limit, start + clampWindowSec(cp.window_sec));
  if (end <= start) return null;
  return { start, end, hole };
}

// Where the cursor moves after a successful call.
//
// A complete response covers the whole window, so the cursor moves to `end`.
// A capped response covers only up to its newest `seendate`; the next call
// re-reads from there (inclusive) and relies on the (question_id, url) primary
// key to drop the overlap. If the cap produced no forward progress at all
// (more than MAX_RECORDS in one second), step past it and record the loss.
export function advanceCursor(window: Window, returned: number, maxSeen: number | null): Advance {
  if (returned < MAX_RECORDS) {
    return { cursor: window.end, capped: false, hole: null };
  }
  if (maxSeen === null || maxSeen <= window.start) {
    return {
      cursor: window.start + 1,
      capped: true,
      hole: { start: window.start, end: window.start + 1, reason: "stall" },
    };
  }
  return { cursor: Math.min(maxSeen, window.end), capped: true, hole: null };
}

// Additive increase / multiplicative decrease. Measured windows returned
// ~15 articles against a 250 cap, i.e. they were far too short; growing to
// 12-24 h is what turns each successful call into days of coverage.
export function nextWindowSec(current: number, returned: number): number {
  const cur = clampWindowSec(current);
  if (returned >= MAX_RECORDS) return clampWindowSec(Math.floor(cur / 2));
  if (returned < AIMD_GROW_BELOW) return clampWindowSec(cur * 2);
  return cur;
}

// Exponential backoff with a caller-supplied jitter (tests pass 0).
export function backoffDelay(level: number, jitterSec: number = 0): number {
  const capped = Math.min(Math.max(level, 1), BACKOFF_MAX_LEVEL);
  const base = Math.min(BACKOFF_BASE_SEC * 2 ** (capped - 1), BACKOFF_MAX_SEC);
  return base + Math.max(0, Math.floor(jitterSec));
}

export function backoffJitter(level: number, random: () => number = Math.random): number {
  const span = Math.min(60 * Math.max(level, 1), 300);
  return Math.floor(random() * span);
}

// A horizon refusal must never be retried against the same sliding window:
// step forward by one hour and record the skipped range. This is the q1
// deadlock fix.
export function horizonProbe(window: Window): Advance {
  const cursor = Math.min(window.end, window.start + HORIZON_PROBE_STEP_SEC);
  return {
    cursor,
    capped: false,
    hole: { start: window.start, end: cursor, reason: "horizon" },
  };
}

// A window GDELT refuses as too heavy is halved. At the floor there is no
// smaller legal window, so step past it and record the loss instead of
// retrying forever.
export function heavyRetry(
  cp: CursorState,
  window: Window,
): { windowSec: number; advance: Advance | null } {
  const shrunk = clampWindowSec(Math.floor(clampWindowSec(cp.window_sec) / 2));
  const windowLength = window.end - window.start;
  if (windowLength > shrunk) {
    return { windowSec: shrunk, advance: null };
  }
  return {
    windowSec: shrunk,
    advance: {
      cursor: Math.min(window.end, window.start + shrunk),
      capped: false,
      hole: { start: window.start, end: Math.min(window.end, window.start + shrunk), reason: "heavy" },
    },
  };
}
