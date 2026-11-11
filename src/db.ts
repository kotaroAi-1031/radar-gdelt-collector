// Database access for the collector. Writes go to exactly one question
// database per firing; nothing here reads across questions.

import type { Client } from "@libsql/client/web";
import { DEFAULT_WINDOW_SEC } from "./config.ts";
import type { CursorState, Hole, Lane } from "./lane.ts";

export interface Checkpoint extends CursorState {
  fail_start: number | null;
  fail_end: number | null;
  fail_count: number;
  last_ok_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

export interface RunLog {
  questionId: string;
  windowStart: number | null;
  windowEnd: number | null;
  returned: number | null;
  inserted: number | null;
  status: string;
  httpStatus: number | null;
  lane: Lane;
  error: string | null;
}

function toNumberOrNull(value: unknown): number | null {
  return value == null ? null : Number(value);
}

export async function loadCheckpoint(db: Client, questionId: string): Promise<Checkpoint> {
  const rs = await db.execute({
    sql:
      "SELECT next_start, live_start, not_before, last_backfill_at, window_sec, backoff_level, " +
      "fail_start, fail_end, fail_count, last_ok_at, last_status, last_error " +
      "FROM checkpoints WHERE question_id = ?",
    args: [questionId],
  });
  const row = rs.rows[0];
  if (!row) {
    return {
      next_start: null,
      live_start: null,
      not_before: 0,
      last_backfill_at: 0,
      window_sec: DEFAULT_WINDOW_SEC,
      backoff_level: 0,
      fail_start: null,
      fail_end: null,
      fail_count: 0,
      last_ok_at: null,
      last_status: null,
      last_error: null,
    };
  }
  const windowSec = Number(row.window_sec);
  return {
    next_start: toNumberOrNull(row.next_start),
    live_start: toNumberOrNull(row.live_start),
    not_before: Number(row.not_before ?? 0),
    last_backfill_at: Number(row.last_backfill_at ?? 0),
    window_sec: Number.isFinite(windowSec) && windowSec > 0 ? windowSec : DEFAULT_WINDOW_SEC,
    backoff_level: Number(row.backoff_level ?? 0),
    fail_start: toNumberOrNull(row.fail_start),
    fail_end: toNumberOrNull(row.fail_end),
    fail_count: Number(row.fail_count ?? 0),
    last_ok_at: row.last_ok_at == null ? null : String(row.last_ok_at),
    last_status: row.last_status == null ? null : String(row.last_status),
    last_error: row.last_error == null ? null : String(row.last_error),
  };
}

export async function saveCheckpoint(
  db: Client,
  questionId: string,
  cp: Checkpoint,
): Promise<void> {
  await db.execute({
    sql:
      "INSERT INTO checkpoints (question_id, next_start, live_start, not_before, last_backfill_at, " +
      "window_sec, backoff_level, fail_start, fail_end, fail_count, last_ok_at, last_status, last_error, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(question_id) DO UPDATE SET next_start = excluded.next_start, " +
      "live_start = excluded.live_start, not_before = excluded.not_before, " +
      "last_backfill_at = excluded.last_backfill_at, window_sec = excluded.window_sec, " +
      "backoff_level = excluded.backoff_level, fail_start = excluded.fail_start, " +
      "fail_end = excluded.fail_end, fail_count = excluded.fail_count, " +
      "last_ok_at = excluded.last_ok_at, last_status = excluded.last_status, " +
      "last_error = excluded.last_error, updated_at = excluded.updated_at",
    args: [
      questionId,
      cp.next_start,
      cp.live_start,
      cp.not_before,
      cp.last_backfill_at,
      cp.window_sec,
      cp.backoff_level,
      cp.fail_start,
      cp.fail_end,
      cp.fail_count,
      cp.last_ok_at,
      cp.last_status,
      cp.last_error,
      new Date().toISOString(),
    ],
  });
}

export async function logRun(db: Client, run: RunLog): Promise<void> {
  await db.execute({
    sql:
      "INSERT INTO runs (at, question_id, window_start, window_end, returned, inserted, status, http_status, lane, error) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      new Date().toISOString(),
      run.questionId,
      run.windowStart,
      run.windowEnd,
      run.returned,
      run.inserted,
      run.status,
      run.httpStatus,
      run.lane,
      run.error,
    ],
  });
}

export async function insertArticles(
  db: Client,
  questionId: string,
  articles: ReadonlyArray<Record<string, unknown>>,
): Promise<number> {
  const fetchedAt = new Date().toISOString();
  const statements = articles
    .filter((a) => typeof a.url === "string" && a.url.length > 0)
    .map((a) => {
      const toneNum = typeof a.tone === "number" ? a.tone : Number(a.tone);
      return {
        sql:
          "INSERT OR IGNORE INTO articles (question_id, url, seendate, title, domain, language, source_country, tone, social_image, fetched_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          questionId,
          a.url as string,
          typeof a.seendate === "string" ? a.seendate : null,
          typeof a.title === "string" ? a.title : null,
          typeof a.domain === "string" ? a.domain : null,
          typeof a.language === "string" ? a.language : null,
          typeof a.sourcecountry === "string" ? a.sourcecountry : null,
          Number.isFinite(toneNum) ? toneNum : null,
          typeof a.socialimage === "string" ? a.socialimage : null,
          fetchedAt,
        ],
      };
    });
  if (statements.length === 0) return 0;
  const results = await db.batch(statements, "write");
  return results.reduce((sum, r) => sum + (r.rowsAffected ?? 0), 0);
}

export async function recordCoverage(
  db: Client,
  questionId: string,
  start: number,
  end: number,
  lane: Lane,
): Promise<void> {
  if (end <= start) return;
  await db.execute({
    sql:
      "INSERT OR IGNORE INTO coverage (question_id, start_sec, end_sec, lane) VALUES (?, ?, ?, ?)",
    args: [questionId, start, end, lane],
  });
}

export async function recordHole(
  db: Client,
  questionId: string,
  hole: Hole,
): Promise<void> {
  if (hole.end <= hole.start) return;
  await db.execute({
    sql:
      "INSERT OR IGNORE INTO coverage_holes (question_id, start_sec, end_sec, reason, detected_at) VALUES (?, ?, ?, ?, ?)",
    args: [questionId, hole.start, hole.end, hole.reason, new Date().toISOString()],
  });
}

export interface HealthRow {
  articles: number;
  lastSeen: string | null;
  liveStart: number | null;
  nextStart: number | null;
  lastOkAt: string | null;
  lastStatus: string | null;
  backoffLevel: number;
  uncoveredHours24h: number;
  recentRuns: Array<{
    at: string;
    lane: string | null;
    returned: number | null;
    inserted: number | null;
    status: string;
  }>;
}

// Union of the coverage intervals that overlap [from, to]. Live and backfill
// windows can overlap, so the sum is taken over the merged union rather than
// over the rows.
export function coveredSeconds(
  intervals: ReadonlyArray<{ start: number; end: number }>,
  from: number,
  to: number,
): number {
  const clipped = intervals
    .map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end, to) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -Infinity;
  for (const interval of clipped) {
    if (interval.start > cursor) {
      total += interval.end - interval.start;
      cursor = interval.end;
    } else if (interval.end > cursor) {
      total += interval.end - cursor;
      cursor = interval.end;
    }
  }
  return total;
}

export async function loadHealth(db: Client, questionId: string, now: number): Promise<HealthRow> {
  const counts = await db.execute({
    sql: "SELECT COUNT(*) AS n, MAX(seendate) AS last_seen FROM articles WHERE question_id = ?",
    args: [questionId],
  });
  const cp = await db.execute({
    sql:
      "SELECT live_start, next_start, last_ok_at, last_status, backoff_level " +
      "FROM checkpoints WHERE question_id = ?",
    args: [questionId],
  });
  const coverage = await db.execute({
    sql:
      "SELECT start_sec, end_sec FROM coverage WHERE question_id = ? AND end_sec > ? AND start_sec < ?",
    args: [questionId, now - 86400, now],
  });
  const runs = await db.execute({
    sql: "SELECT at, lane, returned, inserted, status FROM runs WHERE question_id = ? ORDER BY id DESC LIMIT 3",
    args: [questionId],
  });
  const cpRow = cp.rows[0];
  const covered = coveredSeconds(
    coverage.rows.map((r) => ({ start: Number(r.start_sec), end: Number(r.end_sec) })),
    now - 86400,
    now,
  );
  return {
    articles: Number(counts.rows[0]?.n ?? 0),
    lastSeen: counts.rows[0]?.last_seen == null ? null : String(counts.rows[0].last_seen),
    liveStart: cpRow?.live_start == null ? null : Number(cpRow.live_start),
    nextStart: cpRow?.next_start == null ? null : Number(cpRow.next_start),
    lastOkAt: cpRow?.last_ok_at == null ? null : String(cpRow.last_ok_at),
    lastStatus: cpRow?.last_status == null ? null : String(cpRow.last_status),
    backoffLevel: Number(cpRow?.backoff_level ?? 0),
    uncoveredHours24h: Math.max(0, 86400 - covered) / 3600,
    recentRuns: runs.rows.map((r) => ({
      at: String(r.at),
      lane: r.lane == null ? null : String(r.lane),
      returned: r.returned == null ? null : Number(r.returned),
      inserted: r.inserted == null ? null : Number(r.inserted),
      status: String(r.status),
    })),
  };
}
