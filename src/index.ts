// GDELT collector for the primary information radar.
//
// Topology (Turso's many-database model): there is no shared database.
// Each watch question owns its own Turso database (radar-gdelt-q1 … q6),
// and this Worker writes only to the database of the question it is
// collecting for. Integration across questions is a read-side concern:
// the radar's daily update pulls each database to the VM and composes
// the unified view locally, where the integrated store is derived data
// that can be rebuilt from the per-question sources at any time.
//
// Design (README.md): one firing handles exactly one question and one time
// window, so a firing stays tiny on the Workers Free plan (10 ms CPU).
// Which question a firing serves is derived statelessly from the scheduled
// time (1-minute slots rotating over the questions), so no shared
// coordination state exists anywhere.
//
// Two lanes share each question's single checkpoint row:
//
//   live      keeps the last ~26 hours complete and takes priority whenever
//             it is more than LIVE_MAX_LAG_SEC behind. One success repairs the
//             whole gap, so an outage longer than the window still recovers in
//             a call or two.
//   backfill  walks the older timeline forward at most once per 15 minutes and
//             never into the live lane's recent past.
//
// Progress is a cursor, not a bisection: the time window is the pagination.
// A response capped at 250 records advances the cursor to the newest
// `seendate` it contained, and the next call continues from there. A window
// GDELT refuses as too heavy is the only thing that gets split.
//
// Rate limits are handled as state, never by sleeping or hammering, and they
// never split a window: throttling is a property of the shared egress IP, not
// of the window. Every failure keeps an excerpt of the response body, so a
// 429 can be told apart from a heavy query, a horizon refusal and an HTML
// error page after the fact.

import { createClient, type Client } from "@libsql/client/web";
import {
  BACKOFF_MAX_LEVEL,
  FETCH_TIMEOUT_MS,
  QUESTIONS,
  USER_AGENT,
  type Question,
} from "./config.ts";
import { buildDocUrl, maxSeenEpoch, parseSeendate } from "./doc.ts";
import { classifyResponse } from "./classify.ts";
import {
  advanceCursor,
  backfillWindow,
  backoffDelay,
  backoffJitter,
  chooseLane,
  heavyRetry,
  horizonProbe,
  isBackoffSkip,
  liveWindow,
  nextWindowSec,
} from "./lane.ts";
import {
  insertArticles,
  loadCheckpoint,
  loadHealth,
  logRun,
  recordCoverage,
  recordHole,
  saveCheckpoint,
} from "./db.ts";

interface Env {
  // One secret holding every question database's credentials:
  // { "q1": { "url": "libsql://…", "authToken": "…" }, … }
  // Each token is scoped to its own database; the JSON wrapper only keeps
  // deployment to a single secret.
  TURSO_DATABASES_JSON: string;
}

type DatabaseConfig = Record<string, { url: string; authToken: string }>;
let cachedConfig: DatabaseConfig | null = null;

function clientFor(env: Env, questionId: string): Client {
  if (!cachedConfig) {
    cachedConfig = JSON.parse(env.TURSO_DATABASES_JSON) as DatabaseConfig;
  }
  const cfg = cachedConfig[questionId];
  if (!cfg) throw new Error(`no database configured for ${questionId}`);
  return createClient({ url: cfg.url, authToken: cfg.authToken });
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function collect(db: Client, question: Question): Promise<void> {
  const now = nowSec();
  const cp = await loadCheckpoint(db, question.id);

  if (isBackoffSkip(cp, now)) {
    await logRun(db, {
      questionId: question.id,
      windowStart: null,
      windowEnd: null,
      returned: null,
      inserted: null,
      status: "backoff_skip",
      httpStatus: null,
      lane: "idle",
      error: cp.last_error,
    });
    return;
  }

  const lane = chooseLane(cp, now);
  if (lane === "idle") {
    await logRun(db, {
      questionId: question.id,
      windowStart: null,
      windowEnd: null,
      returned: null,
      inserted: null,
      status: "idle",
      httpStatus: null,
      lane: "idle",
      error: null,
    });
    return;
  }

  const window = lane === "live" ? liveWindow(cp, now) : backfillWindow(cp, now);
  if (!window) {
    await logRun(db, {
      questionId: question.id,
      windowStart: null,
      windowEnd: null,
      returned: null,
      inserted: null,
      status: "idle",
      httpStatus: null,
      lane,
      error: null,
    });
    return;
  }

  // Pin the cursor on the first attempt so a failing window is retried
  // identically instead of sliding forward with the clock (the q1 deadlock).
  if (lane === "live" && cp.live_start === null) cp.live_start = window.start;
  if (lane === "backfill" && cp.next_start === null) cp.next_start = window.start;
  if (lane === "backfill") cp.last_backfill_at = now;

  if (window.hole) await recordHole(db, question.id, window.hole);

  const url = buildDocUrl(question.query, window.start, window.end);
  let bodyText = "";
  let httpStatus = 0;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    httpStatus = res.status;
    bodyText = await res.text();
  } catch {
    httpStatus = -1;
  }

  const classified = classifyResponse(httpStatus, bodyText);

  if (classified.kind === "ok") {
    const articles = classified.articles;
    const inserted = await insertArticles(db, question.id, articles);
    const advance = advanceCursor(window, articles.length, maxSeenEpoch(articles));
    if (advance.hole) await recordHole(db, question.id, advance.hole);
    if (lane === "live") {
      cp.live_start = Math.max(advance.cursor, cp.live_start ?? advance.cursor);
    } else {
      cp.next_start = advance.cursor;
    }
    cp.window_sec = nextWindowSec(cp.window_sec, articles.length);
    cp.backoff_level = 0;
    cp.not_before = 0;
    cp.fail_start = null;
    cp.fail_end = null;
    cp.fail_count = 0;
    cp.last_ok_at = new Date().toISOString();
    cp.last_status = advance.capped ? "ok_capped" : "ok";
    cp.last_error = null;
    await saveCheckpoint(db, question.id, cp);
    await recordCoverage(db, question.id, window.start, window.end, lane);
    await logRun(db, {
      questionId: question.id,
      windowStart: window.start,
      windowEnd: window.end,
      returned: articles.length,
      inserted,
      status: advance.capped ? "ok_capped" : "ok",
      httpStatus,
      lane,
      error: null,
    });
    return;
  }

  let status: string;
  if (classified.kind === "rate_limited") {
    // Throttling is never window-specific: back off, never split.
    cp.backoff_level = Math.min(cp.backoff_level + 1, BACKOFF_MAX_LEVEL);
    cp.not_before = now + backoffDelay(cp.backoff_level, backoffJitter(cp.backoff_level));
    status = "rate_limited";
  } else if (classified.kind === "heavy") {
    // The one case where the window itself is the problem: retry smaller, and
    // at the floor step past it so it cannot stall the lane forever.
    const retry = heavyRetry(cp, window);
    cp.window_sec = retry.windowSec;
    if (retry.advance) {
      if (retry.advance.hole) await recordHole(db, question.id, retry.advance.hole);
      if (lane === "live") cp.live_start = retry.advance.cursor;
      else cp.next_start = retry.advance.cursor;
    }
    cp.not_before = now + backoffDelay(1);
    status = "heavy";
  } else if (classified.kind === "horizon") {
    // Beyond the DOC index: step forward and record the skipped range instead
    // of retrying a window that slides with the clock.
    const advance = horizonProbe(window);
    if (advance.hole) await recordHole(db, question.id, advance.hole);
    if (lane === "live") cp.live_start = advance.cursor;
    else cp.next_start = advance.cursor;
    cp.not_before = now + backoffDelay(1);
    status = "horizon";
  } else {
    cp.backoff_level = Math.min(cp.backoff_level + 1, BACKOFF_MAX_LEVEL);
    cp.not_before = now + backoffDelay(cp.backoff_level, backoffJitter(cp.backoff_level));
    status = "transient";
  }

  cp.last_status = status;
  cp.last_error = classified.error;
  await saveCheckpoint(db, question.id, cp);
  await logRun(db, {
    questionId: question.id,
    windowStart: window.start,
    windowEnd: window.end,
    returned: null,
    inserted: null,
    status,
    httpStatus: httpStatus > 0 ? httpStatus : null,
    lane,
    error: classified.error,
  });
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Stateless rotation: the 1-minute slot number picks the question, so
    // every question is served once per 6 minutes with no shared state.
    // One call per firing keeps a firing far inside the Workers Free 10 ms
    // CPU budget, while the cadence still drains split queues and backfill
    // much faster than real time.
    const slot = Math.floor(controller.scheduledTime / (60 * 1000));
    const question = QUESTIONS[slot % QUESTIONS.length];
    ctx.waitUntil(
      collect(clientFor(env, question.id), question).catch((error: unknown) => {
        console.error(
          `collect failed for ${question.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }),
    );
  },

  // Read-only health view across all question databases.
  async fetch(_request: Request, env: Env): Promise<Response> {
    const now = nowSec();
    const perQuestion = await Promise.all(
      QUESTIONS.map(async (q) => {
        try {
          const db = clientFor(env, q.id);
          const health = await loadHealth(db, q.id, now);
          const lastSeenEpoch = parseSeendate(health.lastSeen);
          return {
            question_id: q.id,
            articles: health.articles,
            last_seen: health.lastSeen,
            last_seen_age_hours:
              lastSeenEpoch === null ? null : Math.max(0, (now - lastSeenEpoch) / 3600),
            live_lag_hours:
              health.liveStart === null ? null : Math.max(0, (now - health.liveStart) / 3600),
            uncovered_hours_24h: health.uncoveredHours24h,
            live_start: health.liveStart,
            next_start: health.nextStart,
            last_ok_at: health.lastOkAt,
            last_status: health.lastStatus,
            backoff_level: health.backoffLevel,
            recentRuns: health.recentRuns,
          };
        } catch (e) {
          return { question_id: q.id, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    return Response.json({ ok: true, generated_at: new Date().toISOString(), perQuestion });
  },
} satisfies ExportedHandler<Env>;
