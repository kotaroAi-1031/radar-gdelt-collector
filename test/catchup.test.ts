import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceCursor,
  backfillWindow,
  liveWindow,
  nextWindowSec,
  type CursorState,
} from "../src/lane.ts";
import { BACKFILL_END_MARGIN_SEC, LIVE_MAX_AGE_SEC } from "../src/config.ts";

const NOW = 1_800_000_000;

function base(overrides: Partial<CursorState> = {}): CursorState {
  return {
    next_start: null,
    live_start: NOW,
    not_before: 0,
    last_backfill_at: NOW,
    window_sec: 24 * 3600,
    backoff_level: 0,
    ...overrides,
  };
}

test("live repairs a full 26-hour gap in two complete responses", () => {
  let cp = base({ live_start: NOW - LIVE_MAX_AGE_SEC, window_sec: 24 * 3600 });
  let calls = 0;
  while (calls < 5) {
    const w = liveWindow(cp, NOW);
    if (!w) break;
    const advance = advanceCursor(w, 20, null);
    cp = { ...cp, live_start: Math.max(advance.cursor, cp.live_start ?? advance.cursor) };
    calls += 1;
    if (cp.live_start >= NOW) break;
  }
  assert.equal(cp.live_start, NOW);
  assert.equal(calls, 2); // 24h + the remaining 2h
});

test("live walks a capped 26-hour gap forward without losing the remainder", () => {
  let cp = base({ live_start: NOW - LIVE_MAX_AGE_SEC });
  let calls = 0;
  while (calls < 10) {
    const w = liveWindow(cp, NOW);
    if (!w) break;
    // Every response is capped and covers the first six hours of the window.
    const maxSeen = w.start + 6 * 3600;
    const advance = advanceCursor(w, 250, maxSeen);
    cp = { ...cp, live_start: Math.max(advance.cursor, cp.live_start ?? advance.cursor) };
    calls += 1;
    if (cp.live_start >= NOW) break;
  }
  assert.equal(cp.live_start, NOW);
  assert.equal(calls, 5); // 26h at 6h per capped call, rounded up
});

test("backfill closes eighty days at one day per successful call", () => {
  let cp = base({ next_start: NOW - 80 * 86400, window_sec: 24 * 3600, last_backfill_at: 0 });
  let calls = 0;
  while (calls < 200) {
    const w = backfillWindow(cp, NOW);
    if (!w) break;
    const advance = advanceCursor(w, 40, NOW);
    cp = { ...cp, next_start: advance.cursor, window_sec: nextWindowSec(cp.window_sec, 40) };
    calls += 1;
  }
  assert.equal(calls, 80);
  assert.ok(cp.next_start !== null);
  assert.ok(cp.next_start >= NOW - BACKFILL_END_MARGIN_SEC - 86400);
});

test("a capped backfill call advances by what it returned, not by the window", () => {
  const cp = base({ next_start: NOW - 40 * 86400 });
  const w = backfillWindow(cp, NOW);
  assert.ok(w);
  const advance = advanceCursor(w, 250, w.start + 3600);
  assert.equal(advance.cursor, w.start + 3600);
  assert.equal(advance.capped, true);
});
