# muse-repo-template

The template repository for every repository Muse creates for this
user. It bakes in the standing guardrails so a new repo starts safe
without being hard to operate:

- **Betterleaks via Lefthook** — commits and pushes are scanned for
  secrets locally, before anything reaches GitHub.
- **Dependabot** — daily checks for GitHub Actions and npm (`infra/`),
  with a 3-day cooldown (7 days for semver-major bumps) and each
  ecosystem grouped into a single PR (see `.github/dependabot.yml`).
- **Nix flake toolchain** (`flake.nix` + `flake.lock`) — the source of
  truth for runtime and CLI tool versions (Node 26, Python 3.15, Go,
  gh, pnpm, and the lint tools below). Enter it with `nix develop`;
  CI pulls the same tools via `nix shell`. Dependabot has no Nix
  ecosystem, so `flake.lock` itself is kept current by the scheduled
  `update-flake-lock` workflow (roughly every 3 days).
- **Hardened CI lint** (`.github/workflows/ci-lint.yml`) — read-only
  top-level permissions, every action pinned to a full commit SHA,
  tool versions and artifact hashes pinned by the flake, running:
  - **jactionlint** (the actionlint fork that also carries
    zizmor-style security rules) at its strictest profile
    (`pedantic`, `--strict-exit`, offline), with its shellcheck and
    pyflakes integrations — every rule on,
  - **sisakulint** (GitHub Actions SAST) with every rule enabled
    except the ones that duplicate a jactionlint rule (each exception
    is documented in the workflow, with the jactionlint rule that
    covers it); its taint-propagation rules stay on,
  - a **Betterleaks** scan of the git history.
- **GitHub settings as code** — repository settings (including
  Dependabot alerts, Dependabot security updates, and private
  vulnerability reporting) and one baseline
  branch ruleset are managed declaratively by the Alchemy v2 program
  in `infra/` (see `infra/README.md`). The ruleset is deliberately
  for the default branch: it blocks force pushes and branch
  deletion, requires changes to arrive via pull request (0 required
  approvals — the PR is the record and the CI gate), and requires
  the ci-lint jobs below to pass (loose, not strict). No bypass
  actors. See `infra/README.md` for the reasoning.

## Create a repository from this template

```sh
gh repo create kotaroAi-1031/<new-repo> --public --template kotaroAi-1031/muse-repo-template
# or in the GitHub UI: "Use this template" on this repository's page.
```

## First steps after cloning

```sh
lefthook install   # activate the Betterleaks pre-commit / pre-push hooks
```

Then apply the GitHub baseline settings to the new repository:

```sh
cd infra
pnpm install
export GITHUB_TOKEN="$(gh auth token)"
GITHUB_REPO="kotaroAi-1031/<new-repo>" pnpm run apply
```

## Standing rules

- **Never push directly to `main`.** Branch, open a pull request,
  merge when ci-lint is green. Commits are signed with the working
  account's SSH signing key.

- **Never commit secrets** — no tokens, keys, credential files, or
  `.env` files, in any repository, ever. Credentials come from the
  Secure Vault or a connector at runtime. Betterleaks guards commits
  and pushes; CI scans history again.
- Hooks and tooling live in `~/workspace/tools/bin/` on the VM
  (lefthook, betterleaks, jactionlint, sisakulint); this template is
  the source of truth for how they are wired into a repository.
- Keep the baseline loose. Extra rules (required reviews, status
  checks) are added per repository when they earn their keep — not
  here, where they would tax every repo created from this template.

---

# radar-gdelt-collector (this repository's project)

A GDELT collector for the primary information radar, built on the
template above. It runs on **Cloudflare Workers Free only**. Following
Turso's many-database model, there is no shared database: each of the
radar's six watch questions owns its own Turso database
(`radar-gdelt-q1` … `radar-gdelt-q6`), and this Worker writes only to
the database of the question it is collecting for. Integration across
questions is a read-side concern — the radar's daily update pulls each
database to the VM with Turso Sync and composes the unified view
locally, where the integrated store is derived data that can be
rebuilt from the per-question sources at any time. Storage lives
outside Cloudflare so that reporting keeps working even when an
upstream API or Cloudflare itself is unreachable.

How it collects, following measured practice for the GDELT DOC 2.0 API
(see `src/` for the implementation and `docs/RUNBOOK-PHASE0.md` for the
migration runbook):

- A cron firing handles **one watch question and one time window**, so a
  firing stays far inside the Free plan's 10 ms CPU budget. Which
  question a firing serves is derived statelessly from the scheduled
  time (1-minute slots rotating over the six questions), so no shared
  coordination state exists anywhere.
- Two lanes share each question's checkpoint row. **live** keeps the last
  ~26 hours complete and takes priority once it is more than 3 hours
  behind; a single success repairs the whole gap, so an outage longer
  than the window still recovers in a call or two. **backfill** walks the
  older timeline forward at most once per 15 minutes and never into the
  live lane's recent past. The lane is chosen from the checkpoint alone,
  so nothing is coordinated across firings.
- **The window is the cursor.** A response capped at 250 records advances
  the cursor to the newest `seendate` it contained, and the next call
  continues from there; a complete response advances it to the window
  end. Nothing is discarded and nothing is bisected. `sort=dateasc` is
  what makes this walk possible.
- Window length adapts (AIMD): a response comfortably under the cap
  doubles the next window (up to 24 hours), a saturated one halves it
  (down to GDELT's 45-minute minimum). Measured windows returned ~15
  articles each, so the 6-hour default was leaving most of the call
  budget on the table.
- **Rate limits never split a window.** Throttling is a property of the
  shared egress IP, not of the window, and the measured failure mix was
  98% throttling against three genuine saturations. Failures are
  classified from the HTTP status plus the body text (`rate_limited`,
  `heavy`, `horizon`, `transient`), and each class gets its own handling:
  exponential backoff with jitter for throttling and transient errors, a
  smaller window only for `heavy`, and a recorded one-hour step forward
  for `horizon`. Every failed run stores the first 200 characters of the
  body in `runs.error`, because `http_status` alone could not tell a
  horizon refusal from an HTML error page.
- The DOC index horizon (about 3 months) is applied with a one-day margin,
  and the clamped cursor is pinned rather than re-derived from the clock.
  Windows that are deliberately skipped — horizon clamps, unanswerable
  minimum-length windows, a saturated second that cannot advance — are
  written to `coverage_holes`, so a loss is recorded, never silent.
- Every successful window writes a `coverage` row, which is what the
  health view uses to report uncovered hours in the last 24 hours.
- Inserts are idempotent (`INSERT OR IGNORE` on `(question_id, url)`),
  and every firing leaves an audit row in `runs` (`lane`, `error`, and
  `http_status` included). The Worker also serves a read-only JSON health
  view: article count, newest `seendate`, live lag, uncovered hours,
  backoff level and the last runs.

Layout:

- `cloudflare.config.ts` — the `cf` CLI project config (Worker name,
  cron trigger `* * * * *`). There is no storage binding: the Worker
  connects to the per-question Turso databases with the single
  `TURSO_DATABASES_JSON` secret, a JSON map of question id to
  `{ url, authToken }` (each token scoped to its own database).
- `src/index.ts` — the Worker entry (`scheduled` and `fetch`).
- `src/config.ts` — tunables and the six watch questions.
- `src/lane.ts` — the pure state machine (lane choice, windows, cursor
  advance, AIMD, backoff).
- `src/classify.ts` — response classification and error excerpts.
- `src/doc.ts` — request building and `seendate` parsing.
- `src/db.ts` — checkpoint, runs, articles, coverage and health queries.
- `migrations/` — the database schema, applied to every question
  database (a fleet operation of six, scripted once).
- `scripts/snapshot-state.mjs` — read-only pre-migration snapshot.
- `test/` — `node --test` suite (no test-only dependencies).

Tests and typecheck: `pnpm test` (Node's built-in runner, TypeScript via
Node's type stripping) and `pnpm typecheck`. Neither needs a database.

Tooling: the `cf` CLI (Cloudflare's official agentic CLI, beta) is the
primary tool, pinned exactly in `package.json`; `cf auth login` performs
the browser OAuth sign-in. Deploy with `pnpm run deploy` after login.
