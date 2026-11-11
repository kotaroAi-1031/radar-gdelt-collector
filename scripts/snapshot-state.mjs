#!/usr/bin/env node
// Phase 0 of the collection v2 migration: snapshot each question database's
// collection state before the schema change, read-only.
//
// The snapshot is the rollback reference: after the switch, the old
// checkpoint values (next_start, pending, fail_*) must still be recoverable
// so a failing deploy can be reasoned about, not guessed at.
//
// Usage:
//   TURSO_DATABASES_JSON="…" node scripts/snapshot-state.mjs --out snapshots/2026-11-11
//   TURSO_DATABASES_JSON="…" node scripts/snapshot-state.mjs            # stdout only
//
// Credentials come from TURSO_DATABASES_JSON (the same JSON map the Worker
// secret holds). They are never printed and never written to the snapshot.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SNAPSHOT_QUERIES = {
  checkpoints:
    "SELECT question_id, next_start, pending, not_before, fail_start, fail_end, fail_count, updated_at " +
    "FROM checkpoints",
  recentRuns:
    "SELECT id, at, question_id, window_start, window_end, returned, inserted, status, http_status " +
    "FROM runs ORDER BY id DESC LIMIT 50",
  articles: "SELECT COUNT(*) AS n, MIN(seendate) AS oldest, MAX(seendate) AS newest FROM articles",
  runTotals: "SELECT status, COUNT(*) AS n FROM runs GROUP BY status ORDER BY n DESC",
};

// Only SELECTs are allowed. Checked twice (statement must start with SELECT
// and must not contain a write keyword) so a future edit that adds an UPDATE
// fails in the test suite rather than against the production databases.
const WRITE_KEYWORDS =
  /(?:^|;)\s*(?:insert|update|delete|drop|alter|create|replace|truncate|attach|detach|vacuum|reindex|pragma)\b/i;

export function assertReadOnly(sql) {
  if (!/^\s*select\b/i.test(sql)) {
    throw new Error(`refusing non-SELECT statement: ${sql}`);
  }
  if (WRITE_KEYWORDS.test(sql)) {
    throw new Error(`refusing statement containing a write keyword: ${sql}`);
  }
  return sql;
}

export function buildSnapshot(perQuestion, generatedAt = new Date().toISOString()) {
  return {
    generated_at: generatedAt,
    note: "phase 0 rollback reference: pre-migration checkpoints and recent runs (read-only)",
    questions: perQuestion,
  };
}

function parseArgs(argv) {
  const out = { out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--out") {
      out.out = argv[i + 1] ?? null;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

async function snapshotQuestion(db, questionId) {
  const result = { question_id: questionId };
  for (const [name, sql] of Object.entries(SNAPSHOT_QUERIES)) {
    const rs = await db.execute(assertReadOnly(sql));
    result[name] = rs.rows.map((row) => ({ ...row }));
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: TURSO_DATABASES_JSON='…' node scripts/snapshot-state.mjs [--out DIR]");
    return;
  }

  const raw = process.env.TURSO_DATABASES_JSON;
  if (!raw) {
    throw new Error("TURSO_DATABASES_JSON is not set (the same JSON map the Worker secret holds)");
  }
  const databases = JSON.parse(raw);

  const { createClient } = await import("@libsql/client");
  const perQuestion = [];
  for (const [questionId, cfg] of Object.entries(databases)) {
    const db = createClient({ url: cfg.url, authToken: cfg.authToken });
    perQuestion.push(await snapshotQuestion(db, questionId));
  }

  const snapshot = buildSnapshot(perQuestion);
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    const path = join(args.out, "collection-state.json");
    writeFileSync(path, json);
    console.log(`wrote ${path} (${perQuestion.length} questions)`);
  } else {
    // No --out: print only. A mistyped invocation must never overwrite a file.
    process.stdout.write(json);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
