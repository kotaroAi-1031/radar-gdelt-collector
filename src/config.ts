// Tunables and the watch-question definitions for the collector.
//
// Everything the collector's behaviour depends on lives here, so the state
// machine in lane.ts stays pure and testable. Values marked "measured" come
// from the 2026-10-31..11-10 run analysis (see README.md); values marked
// "tunable" are the ones the improvement design leaves to measurement
// (IMPROVEMENT-DESIGN.md in the radar workspace, §9 未決 3) and should be
// adjusted from the observed `runs` / `coverage` data, not guessed again.

export interface Question {
  id: string;
  query: string;
}

// v1 keyword queries for the radar's six watch questions. They are tuned by
// the observed `runs` counts (saturation vs. silence), not by guesswork.
export const QUESTIONS: Question[] = [
  { id: "q1", query: '("Israel" OR "Gaza" OR "Iran" OR "Hormuz" OR "Hezbollah" OR "Hamas")' },
  { id: "q2", query: '("cartel" OR "fentanyl" OR "cocaine trafficking" OR "drug smuggling") ("Mexico" OR "Colombia" OR "Venezuela" OR "Ecuador" OR "Caribbean")' },
  { id: "q3", query: '"Japan" ("drug smuggling" OR "cocaine" OR "trafficking" OR "smuggling" OR "crime syndicate")' },
  { id: "q4", query: '("Sam Altman" OR "Peter Thiel" OR "Y Combinator" OR "effective altruism" OR "Elon Musk")' },
  { id: "q5", query: '("OpenAI" OR "Anthropic" OR "Google DeepMind")' },
  { id: "q6", query: '("ransomware" OR "data breach" OR "cyberattack" OR "zero-day" OR "vulnerability disclosure")' },
];

export const DOC_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
export const USER_AGENT =
  "radar-gdelt-collector/0.2 (+https://github.com/kotaroAi-1031/radar-gdelt-collector)";
export const FETCH_TIMEOUT_MS = 30_000;

// DOC API shape: at most 250 articles per call, no pagination.
export const MAX_RECORDS = 250;

// GDELT rejects short timespans outright ("Timespan is too short.", HTTP 200
// text). 45 minutes is the smallest window observed to succeed.
export const MIN_WINDOW_SEC = 2700;

// AIMD bounds for the backfill window. 24 h is a tunable: long windows are
// more efficient but more likely to be refused as "too heavy" (they are
// halved again on refusal, so the downside is bounded).
export const MAX_WINDOW_SEC = 24 * 3600;
export const DEFAULT_WINDOW_SEC = 6 * 3600;

// The live lane only looks this far back. Beyond it the backfill lane owns
// the timeline. A single success repairs the whole gap, which is why an
// outage longer than this still recovers in one or two calls.
export const LIVE_MAX_AGE_SEC = 26 * 3600;

// The live lane takes priority once it is this far behind. It is deliberately
// larger than a single DOC request: GDELT refuses windows shorter than
// MIN_WINDOW_SEC, and firing live every few minutes would spend the whole
// call budget on 45-minute windows (the failure mode measured in November).
// 3 h keeps freshness inside the 6 h SLO with ~8 successful calls a day.
export const LIVE_MAX_LAG_SEC = 3 * 3600;

// Backfill is the low-priority lane: at most one attempt per question per
// 15 minutes, so a live catch-up always wins the slot.
export const BACKFILL_MIN_INTERVAL_SEC = 15 * 60;

// Keep backfill out of the live lane's recent past.
export const BACKFILL_END_MARGIN_SEC = 10 * 60;

// The DOC index covers roughly the last 3 months. Stay one day inside that
// edge: windows at the exact edge are refused (this is what pinned q1 at
// zero for eleven days).
export const MAX_AGE_SEC = 89 * 86400;
export const HORIZON_MARGIN_SEC = 86400;

// Rate limits are state, never retried inside a firing. Level 1 = 15 min,
// doubling to a 6 h cap.
export const BACKOFF_BASE_SEC = 15 * 60;
export const BACKOFF_MAX_SEC = 6 * 3600;
export const BACKOFF_MAX_LEVEL = 8;

// When GDELT refuses a window at the horizon edge, step the cursor forward by
// this much instead of retrying the same sliding window forever.
export const HORIZON_PROBE_STEP_SEC = 3600;

// A failure excerpt is stored in `runs.error` and `checkpoints.last_error` so
// a 429 can be told apart from a heavy query, a horizon refusal and an HTML
// error page after the fact.
export const ERROR_EXCERPT_CHARS = 200;

// Window sizing: grow while a window returns comfortably under the cap,
// halve it when the cap is hit.
export const AIMD_GROW_BELOW = 200;
