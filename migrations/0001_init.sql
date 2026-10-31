-- GDELT collector schema (D1 / SQLite).
-- articles: one row per (question, article URL). INSERT OR IGNORE keeps
-- re-collection idempotent; the primary key is the dedupe contract.
CREATE TABLE IF NOT EXISTS articles (
  question_id TEXT NOT NULL,
  url TEXT NOT NULL,
  seendate TEXT,
  title TEXT,
  domain TEXT,
  language TEXT,
  source_country TEXT,
  tone REAL,
  social_image TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (question_id, url)
);
CREATE INDEX IF NOT EXISTS idx_articles_fetched_at ON articles (fetched_at);
CREATE INDEX IF NOT EXISTS idx_articles_question_seen ON articles (question_id, seendate);

-- checkpoints: per-question collection state. `pending` is a JSON array of
-- [startUnix, endUnix] windows waiting to be processed (created when a
-- window saturates the DOC API record cap and is split in half).
-- `not_before` implements rate-limit backoff as state, not as sleeping.
CREATE TABLE IF NOT EXISTS checkpoints (
  question_id TEXT PRIMARY KEY,
  next_start INTEGER,
  pending TEXT NOT NULL DEFAULT '[]',
  not_before INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- meta: small key/value store (rotation pointer across the questions).
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- runs: audit log of every collection firing, including skips and splits.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  question_id TEXT,
  window_start INTEGER,
  window_end INTEGER,
  returned INTEGER,
  inserted INTEGER,
  status TEXT NOT NULL
);
