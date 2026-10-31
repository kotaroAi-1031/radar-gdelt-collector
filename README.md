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
(see `src/index.ts` for the implementation):

- A cron firing handles **one watch question and one time window**, so a
  firing stays far inside the Free plan's 10 ms CPU budget. Which
  question a firing serves is derived statelessly from the scheduled
  time (10-minute slots rotating over the six questions), so no shared
  coordination state exists anywhere.
- The DOC API returns at most 250 articles per query with no pagination.
  When a window comes back saturated, it is **split in half and the
  halves are queued** in the checkpoint state — the time window is the
  pagination. Windows never split below 30 minutes; a window still
  saturated at that floor is stored and logged as `ok_capped`.
- Rate limits (measured: roughly one request per 5 s per IP, with IP
  blocks lasting ~15 minutes after bursts) are handled as **state, not
  retries**: a failed or refused call defers that question for 15
  minutes via `not_before` in `migrations/0001_init.sql`'s checkpoints
  table. Errors returned as plain text under HTTP 200 are treated as
  failures, as is any non-JSON body.
- Inserts are idempotent (`INSERT OR IGNORE` on `(question_id, url)`),
  and every firing leaves an audit row in the `runs` table. The Worker
  also serves a read-only JSON health view of counts and recent runs.

Layout:

- `cloudflare.config.ts` — the `cf` CLI project config (Worker name,
  cron trigger `*/10 * * * *`). There is no storage binding: the Worker
  connects to the per-question Turso databases with the single
  `TURSO_DATABASES_JSON` secret, a JSON map of question id to
  `{ url, authToken }` (each token scoped to its own database).
- `src/index.ts` — the collector (question queries are v1 keyword sets,
  tuned by the observed run counts).
- `migrations/` — the database schema, applied to every question
  database (a fleet operation of six, scripted once).

Tooling: the `cf` CLI (Cloudflare's official agentic CLI, beta) is the
primary tool, pinned exactly in `package.json`; `cf auth login` performs
the browser OAuth sign-in. Deploy with `pnpm run deploy` after login.
