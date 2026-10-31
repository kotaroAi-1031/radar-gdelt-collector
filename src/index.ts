// GDELT collector for the primary information radar.
//
// Design (see README.md): one firing handles exactly one question and one
// time window, so a firing stays tiny on the Workers Free plan (10 ms CPU).
// The DOC API's 250-record cap is handled by splitting saturated windows in
// half and queuing the halves in the checkpoint state — the time window is
// the pagination. Rate limits are handled as state (`not_before`), never by
// sleeping or hammering: a failed firing simply defers that question.
//
// Collection and reporting are separate by construction: this Worker only
// writes to Turso (libSQL). The radar's daily update reads a locally synced
// replica (Turso embedded replica / sync), so reporting never depends on
// the GDELT API or on Cloudflare being reachable at report time.

import { createClient, type Client } from "@libsql/client/web";

interface Env {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
}

interface Question {
  id: string;
  query: string;
}

// v1 keyword queries for the radar's six watch questions. They are tuned by
// the observed `runs` counts (saturation vs. silence), not by guesswork.
const QUESTIONS: Question[] = [
  { id: "q1", query: '("Israel" OR "Gaza" OR "Iran" OR "Hormuz" OR "Hezbollah" OR "Hamas")' },
  { id: "q2", query: '("cartel" OR "fentanyl" OR "cocaine trafficking" OR "drug smuggling") ("Mexico" OR "Colombia" OR "Venezuela" OR "Ecuador" OR "Caribbean")' },
  { id: "q3", query: '"Japan" ("drug smuggling" OR "cocaine" OR "trafficking" OR "smuggling" OR "crime syndicate")' },
  { id: "q4", query: '("Sam Altman" OR "Peter Thiel" OR "Y Combinator" OR "effective altruism" OR "Elon Musk")' },
  { id: "q5", query: '("OpenAI" OR "Anthropic" OR "Google DeepMind")' },
  { id: "q6", query: '("ransomware" OR "data breach" OR "cyberattack" OR "zero-day" OR "vulnerability disclosure")' },
];

const DOC_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const USER_AGENT = "radar-gdelt-collector/0.1 (+https://github.com/kotaroAi-1031/radar-gdelt-collector)";
const MAX_RECORDS = 250;
const MIN_WINDOW_SEC = 1800; // never split below 30 minutes
const MAX_WINDOW_SEC = 6 * 3600; // a frontier window covers at most 6 hours
const FIRST_WINDOW_SEC = 2 * 3600; // first run for a question looks back 2 hours
const MAX_AGE_SEC = 89 * 86400; // the DOC index covers roughly the last 3 months
const BACKOFF_SEC = 15 * 60; // matches the ~15 min IP block seen in practice

interface Checkpoint {
  next_start: number | null;
  pending: [number, number][];
  not_before: number;
}

function docDatetime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

async function loadCheckpoint(db: Client, questionId: string): Promise<Checkpoint> {
  const rs = await db.execute({
    sql: "SELECT next_start, pending, not_before FROM checkpoints WHERE question_id = ?",
    args: [questionId],
  });
  const row = rs.rows[0];
  if (!row) return { next_start: null, pending: [], not_before: 0 };
  let pending: [number, number][] = [];
  try {
    const parsed = JSON.parse(String(row.pending));
    if (Array.isArray(parsed)) pending = parsed as [number, number][];
  } catch {
    pending = [];
  }
  return {
    next_start: row.next_start === null ? null : Number(row.next_start),
    pending,
    not_before: Number(row.not_before),
  };
}

async function saveCheckpoint(db: Client, questionId: string, cp: Checkpoint): Promise<void> {
  await db.execute({
    sql:
      "INSERT INTO checkpoints (question_id, next_start, pending, not_before, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(question_id) DO UPDATE SET next_start = excluded.next_start, pending = excluded.pending, not_before = excluded.not_before, updated_at = excluded.updated_at",
    args: [questionId, cp.next_start, JSON.stringify(cp.pending), cp.not_before, new Date().toISOString()],
  });
}

async function logRun(
  db: Client,
  questionId: string,
  windowStart: number | null,
  windowEnd: number | null,
  returned: number | null,
  inserted: number | null,
  status: string,
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO runs (at, question_id, window_start, window_end, returned, inserted, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [new Date().toISOString(), questionId, windowStart, windowEnd, returned, inserted, status],
  });
}

async function collect(db: Client): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Rotate across questions: one question per firing.
  const metaRs = await db.execute({ sql: "SELECT value FROM meta WHERE key = 'rotation'", args: [] });
  const rotation = metaRs.rows[0] ? Number.parseInt(String(metaRs.rows[0].value), 10) || 0 : 0;
  const question = QUESTIONS[rotation % QUESTIONS.length];
  await db.execute({
    sql: "INSERT INTO meta (key, value) VALUES ('rotation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [String(rotation + 1)],
  });

  const cp = await loadCheckpoint(db, question.id);

  if (now < cp.not_before) {
    await logRun(db, question.id, null, null, null, null, "backoff_skip");
    return;
  }

  // Choose the next window: queued split windows first, else the frontier.
  let start: number;
  let end: number;
  let fromPending = false;
  if (cp.pending.length > 0) {
    [start, end] = cp.pending[0];
    fromPending = true;
  } else {
    end = now;
    start = cp.next_start ?? end - FIRST_WINDOW_SEC;
    start = Math.max(start, now - MAX_AGE_SEC);
    if (end - start > MAX_WINDOW_SEC) end = start + MAX_WINDOW_SEC;
    if (start >= end) {
      await logRun(db, question.id, start, end, 0, 0, "idle");
      return;
    }
  }

  const url = new URL(DOC_ENDPOINT);
  url.searchParams.set("query", question.query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", String(MAX_RECORDS));
  url.searchParams.set("startdatetime", docDatetime(start));
  url.searchParams.set("enddatetime", docDatetime(end));

  let bodyText = "";
  let httpStatus = 0;
  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30000),
    });
    httpStatus = res.status;
    bodyText = await res.text();
  } catch {
    httpStatus = -1;
  }

  // GDELT sometimes answers errors as plain text under HTTP 200, and heavy
  // queries can be refused outright: anything that is not a JSON object is a
  // failed call. Defer this question instead of retrying inside the firing.
  if (httpStatus !== 200 || !bodyText.trimStart().startsWith("{")) {
    cp.not_before = now + BACKOFF_SEC;
    await saveCheckpoint(db, question.id, cp);
    await logRun(db, question.id, start, end, null, null, httpStatus === 429 ? "rate_limited" : "bad_response");
    return;
  }

  let articles: Record<string, unknown>[] = [];
  try {
    const data = JSON.parse(bodyText) as { articles?: Record<string, unknown>[] };
    if (Array.isArray(data.articles)) articles = data.articles;
  } catch {
    cp.not_before = now + BACKOFF_SEC;
    await saveCheckpoint(db, question.id, cp);
    await logRun(db, question.id, start, end, null, null, "bad_response");
    return;
  }

  // Saturated window: split it in half and queue the halves. The articles in
  // a truncated response are discarded on purpose — the halves re-fetch the
  // full set without truncation.
  if (articles.length >= MAX_RECORDS && end - start > MIN_WINDOW_SEC) {
    const mid = start + Math.floor((end - start) / 2);
    const rest = fromPending ? cp.pending.slice(1) : cp.pending;
    cp.pending = [[start, mid], [mid, end], ...rest];
    await saveCheckpoint(db, question.id, cp);
    await logRun(db, question.id, start, end, articles.length, 0, "split");
    return;
  }

  let inserted = 0;
  if (articles.length > 0) {
    const fetchedAt = new Date().toISOString();
    const statements = articles
      .filter((a) => typeof a.url === "string" && a.url.length > 0)
      .map((a) => {
        const toneNum = typeof a.tone === "number" ? a.tone : Number(a.tone);
        return {
          sql: "INSERT OR IGNORE INTO articles (question_id, url, seendate, title, domain, language, source_country, tone, social_image, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            question.id,
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
    if (statements.length > 0) {
      const results = await db.batch(statements, "write");
      inserted = results.reduce((sum, r) => sum + (r.rowsAffected ?? 0), 0);
    }
  }

  if (fromPending) {
    cp.pending = cp.pending.slice(1);
  } else {
    cp.next_start = end;
  }
  cp.not_before = 0;
  await saveCheckpoint(db, question.id, cp);
  await logRun(
    db,
    question.id,
    start,
    end,
    articles.length,
    inserted,
    articles.length >= MAX_RECORDS ? "ok_capped" : "ok",
  );
}

function clientFromEnv(env: Env): Client {
  return createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(collect(clientFromEnv(env)));
  },

  // Read-only health view: per-question counts and the latest runs.
  async fetch(_request: Request, env: Env): Promise<Response> {
    const db = clientFromEnv(env);
    const counts = await db.execute({
      sql: "SELECT question_id, COUNT(*) AS n FROM articles GROUP BY question_id ORDER BY question_id",
      args: [],
    });
    const runs = await db.execute({
      sql: "SELECT at, question_id, returned, inserted, status FROM runs ORDER BY id DESC LIMIT 10",
      args: [],
    });
    return Response.json({
      ok: true,
      articlesByQuestion: counts.rows.map((r) => ({ question_id: String(r.question_id), n: Number(r.n) })),
      recentRuns: runs.rows.map((r) => ({
        at: String(r.at),
        question_id: String(r.question_id),
        returned: r.returned === null ? null : Number(r.returned),
        inserted: r.inserted === null ? null : Number(r.inserted),
        status: String(r.status),
      })),
    });
  },
} satisfies ExportedHandler<Env>;
