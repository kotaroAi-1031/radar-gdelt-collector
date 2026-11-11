-- Two-lane collection (2026-11-11): the live lane keeps the recent past
-- complete, the backfill lane walks the older timeline forward. Progress is a
-- cursor, not a bisection, so the checkpoint gains a live cursor and the
-- window length that adapts to the response size.
--
-- Every column is additive: the previous Worker version ignores them, so a
-- rollback (redeploy the old code) needs no reverse migration.
ALTER TABLE checkpoints ADD COLUMN live_start INTEGER;
ALTER TABLE checkpoints ADD COLUMN backoff_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkpoints ADD COLUMN last_backfill_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkpoints ADD COLUMN last_ok_at TEXT;
ALTER TABLE checkpoints ADD COLUMN last_status TEXT;
ALTER TABLE checkpoints ADD COLUMN last_error TEXT;
ALTER TABLE checkpoints ADD COLUMN window_sec INTEGER NOT NULL DEFAULT 21600;

-- lane: which lane produced the run ('live' | 'backfill' | 'idle').
-- error: the first 200 characters of the response body for a failed run, so a
-- 429 can be told apart from a heavy query, a horizon refusal and an HTML
-- error page after the fact.
ALTER TABLE runs ADD COLUMN lane TEXT;
ALTER TABLE runs ADD COLUMN error TEXT;

-- coverage: one row per successful window, in Unix seconds. The primary key
-- makes a retried window idempotent. The reader merges the intervals, so
-- overlapping live and backfill windows are not double counted.
CREATE TABLE IF NOT EXISTS coverage (
  question_id TEXT NOT NULL,
  start_sec   INTEGER NOT NULL,
  end_sec     INTEGER NOT NULL,
  lane        TEXT NOT NULL,
  PRIMARY KEY (question_id, start_sec, end_sec)
);
CREATE INDEX IF NOT EXISTS idx_coverage_question_end ON coverage (question_id, end_sec);

-- coverage_holes: ranges deliberately not collected, with the reason. Written
-- when the horizon clamp skips a range, when a saturated second cannot make
-- progress, and when a window is refused as too heavy even at the minimum
-- length. A hole is a recorded loss, never a silent one.
CREATE TABLE IF NOT EXISTS coverage_holes (
  question_id TEXT NOT NULL,
  start_sec   INTEGER NOT NULL,
  end_sec     INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (question_id, start_sec, end_sec, reason)
);
