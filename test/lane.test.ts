import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceCursor,
  backfillWindow,
  backoffDelay,
  chooseLane,
  clampWindowSec,
  heavyRetry,
  horizonFloor,
  horizonProbe,
  isBackoffSkip,
  liveWindow,
  nextWindowSec,
  type CursorState,
  type Window,
} from "../src/lane.ts";
import {
  BACKFILL_MIN_INTERVAL_SEC,
  BACKOFF_MAX_SEC,
  DEFAULT_WINDOW_SEC,
  LIVE_MAX_AGE_SEC,
  LIVE_MAX_LAG_SEC,
  MAX_RECORDS,
  MAX_WINDOW_SEC,
  MIN_WINDOW_SEC,
  AIMD_GROW_BELOW,
} from "../src/config.ts";

const NOW = 1_800_000_000;

function cursor(overrides: Partial<CursorState> = {}): CursorState {
  return {
    next_start: null,
    live_start: NOW - LIVE_MAX_LAG_SEC - 1,
    not_before: 0,
    last_backfill_at: 0,
    window_sec: DEFAULT_WINDOW_SEC,
    backoff_level: 0,
    ...overrides,
  };
}

function window(start: number, end: number): Window {
  return { start, end, hole: null };
}

test("a backoff blocks every lane", () => {
  assert.equal(isBackoffSkip(cursor({ not_before: NOW + 1 }), NOW), true);
  assert.equal(chooseLane(cursor({ not_before: NOW + 1 }), NOW), "idle");
});

test("a fresh database starts on the live lane", () => {
  assert.equal(chooseLane(cursor({ live_start: null }), NOW), "live");
});

test("live takes priority once it is more than the lag threshold behind", () => {
  assert.equal(chooseLane(cursor({ live_start: NOW - LIVE_MAX_LAG_SEC + 1 }), NOW), "backfill");
  assert.equal(chooseLane(cursor({ live_start: NOW - LIVE_MAX_LAG_SEC - 1 }), NOW), "live");
});

test("backfill waits out its interval and is idle in between", () => {
  const fresh = cursor({ live_start: NOW - 60, last_backfill_at: NOW - 60 });
  assert.equal(chooseLane(fresh, NOW), "idle");
  const due = cursor({ live_start: NOW - 60, last_backfill_at: NOW - BACKFILL_MIN_INTERVAL_SEC });
  assert.equal(chooseLane(due, NOW), "backfill");
});

test("the live window never reaches back further than the live horizon", () => {
  const w = liveWindow(cursor({ live_start: NOW - 80 * 3600, window_sec: 24 * 3600 }), NOW);
  assert.ok(w);
  assert.equal(w.start, NOW - LIVE_MAX_AGE_SEC);
  assert.equal(w.end - w.start, 24 * 3600);
  assert.equal(w.hole, null);
});

test("the live window is bounded by the adaptive window length", () => {
  const w = liveWindow(cursor({ live_start: NOW - 80 * 3600, window_sec: 6 * 3600 }), NOW);
  assert.ok(w);
  assert.equal(w.start, NOW - LIVE_MAX_AGE_SEC);
  assert.equal(w.end, w.start + 6 * 3600);
});

test("the live lane does not own anything older than its horizon, so it records no hole", () => {
  const w = liveWindow(cursor({ live_start: NOW - 100 * 86400 }), NOW);
  assert.ok(w);
  assert.equal(w.start, NOW - LIVE_MAX_AGE_SEC);
  assert.equal(w.hole, null);
});

test("the live window is the gap since the last success", () => {
  const w = liveWindow(cursor({ live_start: NOW - 4 * 3600 }), NOW);
  assert.ok(w);
  assert.equal(w.end - w.start, 4 * 3600);
});

test("the live window is null when nothing is missing", () => {
  assert.equal(liveWindow(cursor({ live_start: NOW }), NOW), null);
});

test("backfill starts at the frontier and is capped by the window length", () => {
  const start = NOW - 40 * 86400;
  const w = backfillWindow(cursor({ next_start: start, window_sec: 6 * 3600 }), NOW);
  assert.ok(w);
  assert.equal(w.start, start);
  assert.equal(w.end, start + 6 * 3600);
});

test("backfill uses the adaptive window length", () => {
  const start = NOW - 40 * 86400;
  const w = backfillWindow(cursor({ next_start: start, window_sec: 24 * 3600 }), NOW);
  assert.ok(w);
  assert.equal(w.end - w.start, 24 * 3600);
});

test("backfill never reaches into the live lane's recent past", () => {
  const start = NOW - 3600;
  const w = backfillWindow(cursor({ next_start: start, window_sec: 24 * 3600 }), NOW);
  assert.ok(w);
  assert.ok(w.end <= NOW - 600);
});

test("backfill is null when the frontier has caught up", () => {
  assert.equal(backfillWindow(cursor({ next_start: NOW - 60 }), NOW), null);
});

test("backfill below the document horizon is clamped and recorded as a hole", () => {
  const stale = NOW - 100 * 86400;
  const w = backfillWindow(cursor({ next_start: stale }), NOW);
  assert.ok(w);
  assert.equal(w.start, horizonFloor(NOW));
  assert.equal(w.hole?.reason, "horizon");
});

test("a complete response advances the cursor to the window end", () => {
  const w = window(NOW - 6 * 3600, NOW);
  const advance = advanceCursor(w, 12, NOW - 3600);
  assert.deepEqual(advance, { cursor: NOW, capped: false, hole: null });
});

test("a capped response advances to the newest seendate it contained", () => {
  const w = window(NOW - 6 * 3600, NOW);
  const maxSeen = NOW - 2 * 3600;
  const advance = advanceCursor(w, MAX_RECORDS, maxSeen);
  assert.equal(advance.cursor, maxSeen);
  assert.equal(advance.capped, true);
  assert.equal(advance.hole, null);
});

test("a capped response with no forward progress steps past the second and records the loss", () => {
  const w = window(NOW - 6 * 3600, NOW);
  const advance = advanceCursor(w, MAX_RECORDS, w.start);
  assert.equal(advance.cursor, w.start + 1);
  assert.deepEqual(advance.hole, { start: w.start, end: w.start + 1, reason: "stall" });
});

test("a capped response without seendates also records a stall", () => {
  const w = window(NOW - 6 * 3600, NOW);
  const advance = advanceCursor(w, MAX_RECORDS, null);
  assert.equal(advance.hole?.reason, "stall");
});

test("window length doubles while the response is comfortably under the cap", () => {
  assert.equal(nextWindowSec(6 * 3600, AIMD_GROW_BELOW - 1), 12 * 3600);
  assert.equal(nextWindowSec(6 * 3600, AIMD_GROW_BELOW), 6 * 3600);
});

test("window length is capped at 24 hours", () => {
  assert.equal(nextWindowSec(20 * 3600, 1), MAX_WINDOW_SEC);
});

test("a saturated window halves down to the 45 minute floor", () => {
  assert.equal(nextWindowSec(6 * 3600, MAX_RECORDS), 3 * 3600);
  assert.equal(nextWindowSec(3600, MAX_RECORDS), MIN_WINDOW_SEC);
  assert.equal(nextWindowSec(MIN_WINDOW_SEC, MAX_RECORDS), MIN_WINDOW_SEC);
});

test("window lengths outside the legal range are clamped", () => {
  assert.equal(clampWindowSec(0), DEFAULT_WINDOW_SEC);
  assert.equal(clampWindowSec(1), MIN_WINDOW_SEC);
  assert.equal(clampWindowSec(999999), MAX_WINDOW_SEC);
});

test("backoff starts at 15 minutes, doubles and caps at 6 hours", () => {
  assert.equal(backoffDelay(0, 0), 15 * 60);
  assert.equal(backoffDelay(1, 0), 15 * 60);
  assert.equal(backoffDelay(2, 0), 30 * 60);
  assert.equal(backoffDelay(3, 0), 60 * 60);
  assert.equal(backoffDelay(20, 0), BACKOFF_MAX_SEC);
  assert.ok(backoffDelay(2, 5) >= 30 * 60 + 5);
});

test("a horizon refusal steps the cursor forward instead of retrying the same window", () => {
  const w = window(NOW - 6 * 3600, NOW);
  const advance = horizonProbe(w);
  assert.equal(advance.cursor, w.start + 3600);
  assert.equal(advance.hole?.reason, "horizon");
  assert.ok(advance.cursor > w.start);
});

test("a heavy refusal retries with half the window while there is room", () => {
  const w = window(NOW - 6 * 3600, NOW);
  const retry = heavyRetry(cursor({ window_sec: 6 * 3600 }), w);
  assert.equal(retry.windowSec, 3 * 3600);
  assert.equal(retry.advance, null);
});

test("a heavy refusal at the floor steps past the window and records the loss", () => {
  const w = window(NOW - MIN_WINDOW_SEC, NOW);
  const retry = heavyRetry(cursor({ window_sec: MIN_WINDOW_SEC }), w);
  assert.equal(retry.windowSec, MIN_WINDOW_SEC);
  assert.equal(retry.advance?.hole.reason, "heavy");
  assert.equal(retry.advance?.cursor, w.start + MIN_WINDOW_SEC);
});
