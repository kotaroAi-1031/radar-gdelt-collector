-- Failure tracking (2026-11-01): a window that keeps failing must be
-- splittable too, otherwise one unanswerable (too heavy) window stalls its
-- question forever — splitting previously happened only after a successful
-- saturated response. checkpoints gains the identity of the last failed
-- window and its consecutive failure count; runs gains the HTTP status so
-- a bad_response can be told apart from a 429 after the fact.
ALTER TABLE checkpoints ADD COLUMN fail_start INTEGER;
ALTER TABLE checkpoints ADD COLUMN fail_end INTEGER;
ALTER TABLE checkpoints ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN http_status INTEGER;
