// DOC API request building and response field parsing.
//
// Two details matter for correctness:
// - `sort=dateasc` turns the time window into a cursor: a capped response
//   (250 records) can be walked forward from the newest `seendate` it
//   contains, instead of discarding it and bisecting the window.
// - `seendate` is GDELT's observation time ("20260821T070000Z"), not the
//   article's publication time. It is the only clock that can be trusted for
//   freshness, so the collector compares cursors against it, never against
//   `fetched_at`.

import { DOC_ENDPOINT, MAX_RECORDS } from "./config.ts";

export function docDatetime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function buildDocUrl(query: string, start: number, end: number): string {
  const url = new URL(DOC_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", String(MAX_RECORDS));
  url.searchParams.set("startdatetime", docDatetime(start));
  url.searchParams.set("enddatetime", docDatetime(end));
  // Newest-last ordering is what makes the window a cursor.
  url.searchParams.set("sort", "dateasc");
  return url.toString();
}

export function parseSeendate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// Highest `seendate` in a batch, or null when the batch carries none. Used to
// advance the cursor on a capped response.
export function maxSeenEpoch(articles: ReadonlyArray<Record<string, unknown>>): number | null {
  let max: number | null = null;
  for (const article of articles) {
    const t = parseSeendate(article.seendate);
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max;
}
