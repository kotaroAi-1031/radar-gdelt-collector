import test from "node:test";
import assert from "node:assert/strict";
import { classifyResponse, excerpt } from "../src/classify.ts";

test("HTTP 429 is throttling even when the body is HTML", () => {
  const result = classifyResponse(429, "<html><body>Too many requests</body></html>");
  assert.equal(result.kind, "rate_limited");
  assert.deepEqual(result.articles, []);
  assert.ok(result.error && result.error.length > 0);
});

test("the documented plain-text limit message under HTTP 200 is throttling", () => {
  const body =
    "Please limit requests to one every 5 seconds or contact kalev.leetaru5@gmail.com for larger queries.";
  assert.equal(classifyResponse(200, body).kind, "rate_limited");
});

test("a timespan refusal is the only 'heavy' case", () => {
  assert.equal(classifyResponse(200, "Timespan is too short.").kind, "heavy");
  assert.equal(classifyResponse(200, "Your query is too complex.").kind, "heavy");
});

test("a period refusal is classified as horizon, not heavy", () => {
  assert.equal(
    classifyResponse(200, "startdatetime is out of range for the DOC index.").kind,
    "horizon",
  );
  assert.equal(classifyResponse(200, "The requested range is too old.").kind, "horizon");
});

test("a JSON article list is a success", () => {
  const body = JSON.stringify({ articles: [{ url: "https://example.com/a", seendate: "20260821T070000Z" }] });
  const result = classifyResponse(200, body);
  assert.equal(result.kind, "ok");
  assert.equal(result.articles.length, 1);
  assert.equal(result.error, null);
});

test("an empty JSON object is a successful empty window, not an error", () => {
  const result = classifyResponse(200, "{}");
  assert.equal(result.kind, "ok");
  assert.deepEqual(result.articles, []);
});

test("a non-empty JSON object without articles is transient, so the cursor does not advance", () => {
  const result = classifyResponse(200, '{"status":"ok"}');
  assert.equal(result.kind, "transient");
});

test("a JSON array or scalar is transient", () => {
  assert.equal(classifyResponse(200, "[]").kind, "transient");
  assert.equal(classifyResponse(200, "42").kind, "transient");
});

test("malformed JSON is transient", () => {
  assert.equal(classifyResponse(200, '{"articles":[').kind, "transient");
});

test("HTML error pages, 5xx and network failures are transient", () => {
  assert.equal(classifyResponse(200, "<html>Service unavailable</html>").kind, "transient");
  assert.equal(classifyResponse(503, "").kind, "transient");
  assert.equal(classifyResponse(-1, "").kind, "transient");
});

test("an empty 200 body is transient rather than a silent empty window", () => {
  assert.equal(classifyResponse(200, "   ").kind, "transient");
});

test("the stored excerpt is whitespace-collapsed and capped", () => {
  const excerpted = excerpt(`line one\n\nline   two\t${"x".repeat(500)}`);
  assert.ok(excerpted.startsWith("line one line two"));
  assert.equal(excerpted.length, 200);
  assert.ok(!excerpted.includes("\n"));
});

test("the excerpt keeps short bodies intact", () => {
  assert.equal(excerpt("  hi  there "), "hi there");
});
