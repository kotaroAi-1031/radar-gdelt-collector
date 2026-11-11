# Runbook: Phase 0 (record before the collection v2 switch)

Phase 0 is the "record and keep a way back" step from the improvement
design. It runs **before** `migrations/0003_lanes.sql` is applied to the six
question databases and before the new Worker version is deployed. Nothing
here writes to a database.

The snapshot is the rollback reference: if the new cursor/lane logic behaves
badly, the old checkpoint values (`next_start`, `pending`, `fail_*`) must
still be recoverable, so a rollback can be reasoned about instead of guessed.

All commands run from the repository root.

## 0. Preconditions

- `cf` is authenticated (`cf auth login`). The token expires after about an
  hour; re-run it if a deploy step is next.
- The Turso credential map is available as `TURSO_DATABASES_JSON`. It is the
  same JSON the Worker secret holds. **Do not echo it, do not write it to a
  file in the repository.** For example, export it from the user's secure
  store into the shell environment for the duration of these commands.
- Network access to Turso (`libsql://…`). The read side is otherwise
  unaffected.

## 1. Snapshot the six databases (read-only)

```sh
node scripts/snapshot-state.mjs --out ~/workspace/radar/gdelt/snapshots/2026-11-11
```

It writes `collection-state.json` with each question's `checkpoints` row, the
last 50 `runs`, the article count and the `seendate` range. Without `--out`
it only prints to stdout; it never overwrites anything by accident.

The script refuses any statement that is not a `SELECT`, so it cannot change
state even if edited carelessly. That property is covered by
`test/snapshot.test.ts` (`pnpm test`).

## 2. Record the baselines hash (outside this repository)

The radar's baselines are the "current view" that must never be rewritten by
the pipeline. Record their hashes outside the collector repository:

```sh
cd ~/workspace/radar
shasum -a 256 baselines/*.md > automation/baselines.sha256
cat automation/baselines.sha256
```

Keep the file with the radar workspace (it is not committed here). The daily
update checks it before and after writing (Phase 2 of the design).

## 3. Record the acceptance baseline

Before the switch, capture the numbers the Phase 1 acceptance criteria will
be compared against:

```sh
# frontier, backlog and backoff per question (read-only)
sqlite3 -readonly "file:$HOME/workspace/radar/gdelt/reader/sync/q2.db?immutable=1" \
  "SELECT question_id, datetime(next_start,'unixepoch'), pending FROM checkpoints;"
```

(Use the reader's synced copies, or `scripts/snapshot-state.mjs` above, which
does not depend on the local WAL files. Reading a synced copy with
`immutable=1` ignores its `-wal` file and shows stale values — copy the
`*.db` and `*.db-wal` files first if you need to inspect them with `sqlite3`.)

Record, per question:

- `max(seendate)` and the frontier (`next_start`) at the time of the switch
- the number of `ok` runs in the last 24 hours
- the failure mix in the last 24 hours (`rate_limited`, `bad_response`,
  `failed_split`, `backoff_skip`)

The expected pre-switch values are in the improvement design (§2.4): every
question 81–85 days behind, q1 at zero articles with 0 successful runs.

## 4. Capture the health view

```sh
curl -sS https://radar-gdelt-collector.tanoshimi494.workers.dev/ \
  | tee ~/workspace/radar/gdelt/snapshots/2026-11-11/health-before.json
```

The new `/health` shape (after the deploy) adds `last_seen`,
`last_seen_age_hours`, `live_lag_hours`, `uncovered_hours_24h`,
`live_start`, `last_ok_at`, `last_status` and `backoff_level` per question.

## 5. Apply the migration (only when the deploy is approved)

This is **not** part of the code PR. When the switch is approved, apply
`migrations/0003_lanes.sql` to each of the six databases. Every statement is
additive (`ALTER TABLE … ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`), so the
previous Worker version keeps working against the migrated schema. That is
what makes the rollback below a redeploy, not a data restore.

After applying it, take a second snapshot:

```sh
node scripts/snapshot-state.mjs --out ~/workspace/radar/gdelt/snapshots/2026-11-11-post
```

Two state details change meaning on the first firing after the deploy. Neither
needs a manual step:

- **q1's frontier** (`next_start` at 2026-08-04, beyond the index horizon) is
  re-clamped to one day inside the horizon on its first backfill attempt. The
  range it skips is written to `coverage_holes` with `reason='horizon'`, so the
  gap is recorded rather than silently gliding with the clock.
- **The old `pending` queue** (45-minute split windows) is left in place and
  ignored by the new code. It is deliberately not cleared: it is the rollback
  reference for the old version.

## 6. Rollback

1. Redeploy the previous Worker version (`cf deploy` from the previous
   commit). It ignores the new columns and tables.
2. The old `pending` queue is still intact (the new code never read or wrote
   it), so the previous version can resume from exactly where it left off.
   Ranges the new version recorded as uncollectable are in `coverage_holes`.
3. No data is deleted by any step here. `articles` is untouched.

## What Phase 0 does not do

- It does not deploy, migrate or change any Cloudflare setting.
- It does not write to Turso.
- It does not touch `~/workspace/radar/baselines/`.
