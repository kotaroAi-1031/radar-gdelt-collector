# infra/ — GitHub settings managed with Alchemy v2

This directory holds the Alchemy v2 program (`alchemy.run.ts`) that
declaratively manages the baseline GitHub settings of a repository
created from this template.

## What it manages

- **Repository settings**: default branch `main`, and
  `delete_branch_on_merge` enabled (head branches are deleted after a
  merge). Merge / squash / rebase strategies are left at GitHub
  defaults on purpose.
- **Security settings** (`security_and_analysis`): Dependabot alerts,
  Dependabot security updates (automated fix PRs), and private
  vulnerability reporting, all enabled. Grouping of security-update
  PRs is not a repository setting; it follows the groups in
  `.github/dependabot.yml`.
- **One branch ruleset** named `baseline-protection` on the default
  branch, with these rules (each is a toggle in
  `RULESET_RULE_TOGGLES` at the top of `alchemy.run.ts`):
  - blocks branch deletion (`deletion`)
  - blocks force pushes (`non_fast_forward`)
  - requires a pull request to merge (`pull_request`, **0 required
    approvals**: the only possible approver is the owner and the
    working account cannot approve its own PRs, so approvals would
    deadlock; the PR is the change record and CI gate)
  - requires the ci-lint jobs to pass (`required_status_checks`,
    **loose**: `strict_required_status_checks_policy: false`, so a PR
    need not be rebased onto the latest main before merging; flip
    `REQUIRED_STATUS_CHECKS_STRICT` in the program to change that)
  - signed commits (`required_signatures`): **on**. The SSH signing
    key (`~/.ssh/id_ed25519_signing.pub`) is registered on the GitHub
    account as a signing key, git signs every commit locally, and
    pushed commits verify on GitHub
    (`commit.verification.verified=true`).

  There are deliberately **no bypass actors**: if the admin role could
  bypass, the working token could push straight to main and the rules
  would mean nothing. In an emergency the owner can edit or disable
  the ruleset itself, so this cannot lock anyone out.

## How it works

Alchemy v2 (`alchemy@2.0.0-beta.84`) has no built-in GitHub repository
or ruleset resource, so the program declares an Alchemy Stack with the
local state store and runs an idempotent converge against the GitHub
REST API inside the stack body: read current state, diff against the
desired state declared at the top of `alchemy.run.ts`, write only what
differs. The last-applied spec hash and ruleset id are recorded under
`.alchemy/github-baseline/` next to the program (git-ignored). Re-running
is a no-op when GitHub already matches.

## Run it

Requirements: Node.js 24+ with [pnpm](https://pnpm.io) (dependencies
are managed with pnpm: `package.json` + `pnpm-lock.yaml`; the
repository flake's devShell provides Node 26 and pnpm), and the
`gh` CLI signed in to an account that can administer the target
repository. The program itself is plain TypeScript run directly by
Node (`node alchemy.run.ts`).

```sh
cd infra
pnpm install

# Token comes from gh at runtime; it is never written to a file.
export GITHUB_TOKEN="$(gh auth token)"

# Target repo: env var or --repo= argument
export GITHUB_REPO="kotaroAi-1031/muse-repo-template"
pnpm run apply
# or: node alchemy.run.ts --repo=kotaroAi-1031/muse-tools
```

Verify afterwards:

```sh
gh api repos/<owner>/<repo>/rulesets
gh api repos/<owner>/<repo> --jq '{default_branch, delete_branch_on_merge}'
```

## Typecheck

```sh
cd infra
pnpm run typecheck
```

This runs **tsrs** (oxc-project/tsrs, the Rust port of the
TypeScript 7 compiler; a checker only — the program still runs on
Node) as `tsrs --noEmit --checkerAssignment go` against the
hand-written `tsconfig.json`. tsrs is experimental (beta), so the
CI typecheck job is not one of the ruleset's required status
checks. `--checkerAssignment go` is the README-recommended
workaround for the checker's diagnostic nondeterminism
(tsrs issue #725).
