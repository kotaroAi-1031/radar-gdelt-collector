// Response classification.
//
// GDELT reports most failures as HTTP 200 with a plain-text body, so the
// status code alone is not enough. The measured mix (2026-10-31..11-10) was
// 69..82% throttling, a handful of plain-text refusals, and almost no
// saturation, yet every one of them took the same "split the window" path.
// Splitting is only correct for one of those cases: a window GDELT refuses
// because it is too heavy. Throttling says nothing about the window, so it
// must never split it.
//
// The excerpt of the body is kept for the audit log, because after the fact
// `http_status` alone could not tell a horizon refusal from an HTML error
// page.

import { ERROR_EXCERPT_CHARS } from "./config.ts";

export type ResponseKind = "ok" | "rate_limited" | "heavy" | "horizon" | "transient";

export interface Classification {
  kind: ResponseKind;
  articles: Record<string, unknown>[];
  error: string | null;
}

export function excerpt(body: string, max: number = ERROR_EXCERPT_CHARS): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}

const RATE_LIMIT_TEXT = /please limit|limit requests|too many requests|rate limit/i;
const HEAVY_TEXT = /timespan is too short|too (large|complex|many|long|broad|heavy)|query is too/i;
const HORIZON_TEXT =
  /startdatetime|enddatetime|too old|out of range|not within|3 months|90 days|three months/i;

function failure(kind: ResponseKind, body: string): Classification {
  return { kind, articles: [], error: excerpt(body) };
}

export function classifyResponse(httpStatus: number, bodyText: string): Classification {
  const text = bodyText ?? "";

  // Throttling is a property of the caller's IP, not of the window. Checked
  // first so an HTML or plain-text 429 is still classified as throttling.
  if (httpStatus === 429) return failure("rate_limited", text);

  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const body = parsed as { articles?: unknown };
        if (Array.isArray(body.articles)) {
          return {
            kind: "ok",
            articles: body.articles.filter(
              (a): a is Record<string, unknown> => typeof a === "object" && a !== null,
            ),
            error: null,
          };
        }
        // GDELT returns `{}` when nothing matched; that is a successful,
        // empty window, not an error.
        if (Object.keys(body).length === 0) {
          return { kind: "ok", articles: [], error: null };
        }
      }
      // Unrecognised JSON shape. Do not advance the cursor on a response we
      // do not understand: treat it as transient and retry later.
      return failure("transient", text);
    } catch {
      return failure("transient", text);
    }
  }

  if (RATE_LIMIT_TEXT.test(text)) return failure("rate_limited", text);
  if (HEAVY_TEXT.test(text)) return failure("heavy", text);
  if (HORIZON_TEXT.test(text)) return failure("horizon", text);

  // 5xx, timeouts (-1), connection resets and HTML error pages are all
  // transient: retry later, never split.
  return failure("transient", text);
}
