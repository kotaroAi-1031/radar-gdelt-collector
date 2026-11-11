import test from "node:test";
import assert from "node:assert/strict";
import { SNAPSHOT_QUERIES, assertReadOnly, buildSnapshot } from "../scripts/snapshot-state.mjs";

test("every snapshot query is read-only", () => {
  for (const [name, sql] of Object.entries(SNAPSHOT_QUERIES)) {
    assert.match(sql, /^\s*select\b/i, `${name} must be a SELECT`);
    assert.doesNotThrow(() => assertReadOnly(sql), `${name} must pass the read-only check`);
    assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|create|replace)\b/i);
  }
});

test("write statements are rejected", () => {
  assert.throws(() => assertReadOnly("UPDATE checkpoints SET not_before = 0"));
  assert.throws(() => assertReadOnly("INSERT INTO runs (at) VALUES ('x')"));
  assert.throws(() => assertReadOnly("DELETE FROM articles"));
  assert.throws(() => assertReadOnly("DROP TABLE runs"));
});

test("a SELECT with a smuggled write is rejected", () => {
  assert.throws(() => assertReadOnly("SELECT 1; DROP TABLE runs"));
});

test("an empty statement is rejected", () => {
  assert.throws(() => assertReadOnly(""));
  assert.throws(() => assertReadOnly("   "));
});

test("the snapshot carries the rollback reference and no credentials", () => {
  const snapshot = buildSnapshot(
    [{ question_id: "q1", checkpoints: [], recentRuns: [] }],
    "2026-11-11T00:00:00.000Z",
  );
  assert.equal(snapshot.generated_at, "2026-11-11T00:00:00.000Z");
  assert.match(snapshot.note, /read-only/);
  assert.equal(snapshot.questions.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /authToken|libsql:\/\//);
});
