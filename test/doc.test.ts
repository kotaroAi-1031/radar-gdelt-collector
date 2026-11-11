import test from "node:test";
import assert from "node:assert/strict";
import { buildDocUrl, docDatetime, maxSeenEpoch, parseSeendate } from "../src/doc.ts";
import { MAX_RECORDS } from "../src/config.ts";

test("DOC datetimes are UTC and compact", () => {
  assert.equal(docDatetime(Date.UTC(2026, 7, 21, 7, 0, 0) / 1000), "20260821070000");
});

test("the request walks the window forward with sort=dateasc", () => {
  const url = new URL(buildDocUrl("test query", 1_800_000_000, 1_800_003_600));
  assert.equal(url.searchParams.get("mode"), "artlist");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("maxrecords"), String(MAX_RECORDS));
  assert.equal(url.searchParams.get("sort"), "dateasc");
  assert.equal(url.searchParams.get("query"), "test query");
  assert.equal(url.searchParams.get("startdatetime"), docDatetime(1_800_000_000));
  assert.equal(url.searchParams.get("enddatetime"), docDatetime(1_800_003_600));
});

test("seendate parses as UTC", () => {
  assert.equal(parseSeendate("20260821T070000Z"), Date.UTC(2026, 7, 21, 7, 0, 0) / 1000);
});

test("non-seendate values parse to null", () => {
  assert.equal(parseSeendate(null), null);
  assert.equal(parseSeendate(20260821), null);
  assert.equal(parseSeendate("2026-08-21T07:00:00Z"), null);
  assert.equal(parseSeendate("not a date"), null);
});

test("the batch maximum ignores articles without a seendate", () => {
  const max = maxSeenEpoch([
    { seendate: "20260821T070000Z" },
    { seendate: null },
    { seendate: "20260821T064500Z" },
    { title: "no seendate" },
  ]);
  assert.equal(max, Date.UTC(2026, 7, 21, 7, 0, 0) / 1000);
});

test("an empty batch has no maximum", () => {
  assert.equal(maxSeenEpoch([]), null);
});
