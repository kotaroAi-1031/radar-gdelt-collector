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
