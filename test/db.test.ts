import test from "node:test";
import assert from "node:assert/strict";
import { coveredSeconds } from "../src/db.ts";

const H = 3600;

test("disjoint coverage is summed", () => {
  const covered = coveredSeconds(
    [
      { start: 0, end: 1 * H },
      { start: 2 * H, end: 4 * H },
    ],
    0,
    4 * H,
  );
  assert.equal(covered, 3 * H);
});

test("overlapping live and backfill windows are counted once", () => {
  const covered = coveredSeconds(
    [
      { start: 0, end: 3 * H },
      { start: 1 * H, end: 5 * H },
    ],
    0,
    5 * H,
  );
  assert.equal(covered, 5 * H);
});

test("coverage is clipped to the requested window", () => {
  const covered = coveredSeconds([{ start: -10 * H, end: 100 * H }], 0, 24 * H);
  assert.equal(covered, 24 * H);
});

test("intervals outside the window are ignored", () => {
  assert.equal(coveredSeconds([{ start: 10 * H, end: 11 * H }], 20 * H, 24 * H), 0);
});

test("no coverage means no covered seconds", () => {
  assert.equal(coveredSeconds([], 0, 24 * H), 0);
});
