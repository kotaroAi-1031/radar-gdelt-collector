/**
 * GitHub repository baseline, managed declaratively with Alchemy v2.
 *
 * Desired state (deliberately NOT strict — this is a floor, not a cage):
 * - Repository: default branch is `main`; head branches are deleted
 *   automatically after a merge. Merge / squash / rebase strategies are
 *   left at GitHub defaults and are NOT managed here.
 * - Security (security_and_analysis): Dependabot alerts, Dependabot
 *   security updates (automated fix PRs) and private vulnerability
 *   reporting are all enabled. Grouping of security-update PRs is not
 *   a repository toggle; it follows the groups in .github/dependabot.yml.
 * - One branch ruleset named `baseline-protection` on the default branch:
 *     - blocks branch deletion            (rule type: `deletion`)
 *     - blocks force pushes               (rule type: `non_fast_forward`)
 *     - requires a pull request to merge  (rule type: `pull_request`,
 *       0 required approvals — see PULL_REQUEST_PARAMETERS below)
 *     - requires the ci-lint jobs to pass (rule type:
 *       `required_status_checks`, loose / not strict)
 *     - signed commits (rule type: `required_signatures`) are staged
 *       behind a toggle below, off until the signing key registration
 *       is verified on GitHub.
 *   No bypass actors on purpose: with an admin bypass, the working
 *   token could push straight to main and the rules would be theatre.
 *   The owner can always edit or disable the ruleset itself, so nobody
 *   is locked out in an emergency.
 *
 * How this is implemented (read before changing):
 * Alchemy v2 (alchemy@2.0.0-beta.84) ships providers for AWS, Cloudflare
 * and others, but has NO built-in GitHub repository / ruleset resource,
 * and its Resource/Provider API (Effect v4 beta) requires a full
 * provider layer per resource type. So instead of a fake Resource class,
 * this program declares an Alchemy Stack (local state store) whose body
 * runs an idempotent converge against the GitHub REST API:
 * read current state -> diff against the desired state below -> write
 * only what differs. The last-applied spec (with a SHA-256 hash of the
 * desired state and the ruleset id) is recorded under `.alchemy/` next
 * to this file, alongside Alchemy's own local state, so re-runs are
 * no-ops when GitHub already matches.
 *
 * The GitHub token is read from the GITHUB_TOKEN environment variable at
 * runtime (`gh auth token`). It is never written to any file or state.
 *
 * Usage: see README.md in this directory.
 */
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Desired state
// ---------------------------------------------------------------------------

const RULESET_NAME = "baseline-protection";

const desiredRepoSettings = {
  default_branch: "main",
  delete_branch_on_merge: true,
  // allow_merge_commit / allow_squash_merge / allow_rebase_merge are
  // intentionally absent: they stay at GitHub defaults, unmanaged.
} as const;

// Dependabot / vulnerability settings. Each feature's state is probed
// through its own endpoint (the repository object's
// security_and_analysis does not report dependabot_alerts or
// private_vulnerability_reporting for these repositories) and enabled
// through the matching idempotent PUT endpoint when missing.
const desiredSecuritySettings = {
  dependabot_alerts: "enabled", // PUT /vulnerability-alerts
  dependabot_security_updates: "enabled", // PUT /automated-security-fixes
  private_vulnerability_reporting: "enabled", // PUT /private-vulnerability-reporting
} as const;

const securityEndpoints: Record<keyof typeof desiredSecuritySettings, string> = {
  dependabot_alerts: "vulnerability-alerts",
  dependabot_security_updates: "automated-security-fixes",
  private_vulnerability_reporting: "private-vulnerability-reporting",
};

// Each ruleset rule is a toggle so the ruleset can be extended later by
// flipping a flag here (and re-running this program) once the owner has
// reviewed the full list of available rules and decided. Until then ONLY
// the two baseline rules are on: they prevent accidents (deleting the
// default branch, rewriting its history) without taxing daily work.
// Rules that need parameters (pull_request: required approvals etc.;
// required_status_checks: which checks) cannot be expressed by a flag
// alone — add their parameter objects to buildRulesetRules() when a
// decision enables them.
const RULESET_RULE_TOGGLES = {
  deletion: true, // block deleting the default branch
  non_fast_forward: true, // block force pushes to the default branch
  pull_request: true, // no direct pushes to main: changes land via PRs
  required_status_checks: true, // the ci-lint jobs must pass before merging
  // Enabled: the SSH signing key (~/.ssh/id_ed25519_signing.pub) is
  // registered on the GitHub account as a signing key, and pushed
  // commits verify (commit.verification.verified=true, reason "valid";
  // first confirmed on cc78ffb215c9cbd4bfacc7fd301306ec3cdaee5b).
  required_signatures: true, // require signed commits
  creation: false, // (branch rulesets) restrict branch creation
  update: false, // (branch rulesets) restrict branch updates
  required_linear_history: false, // require linear history (no merge commits)
  lock_branch: false, // make the branch read-only
} as const;

// pull_request parameters: 0 required approvals on purpose. The only
// human who could approve is the owner, and the working account cannot
// approve its own PRs, so requiring approvals would deadlock. The PR
// exists as the change record and as the CI gate.
const PULL_REQUEST_PARAMETERS = {
  dismiss_stale_reviews_on_push: false,
  require_code_owner_review: false,
  require_last_push_approval: false,
  required_approving_review_count: 0,
  required_review_thread_resolution: false,
} as const;

// required_status_checks parameters: loose, not strict — a PR does NOT
// have to be up to date with main before merging (strict would force a
// rebase + CI re-run for every stacked change and makes operation
// heavy). Flip REQUIRED_STATUS_CHECKS_STRICT to true to change that.
// Contexts are the ci-lint job display names; renaming a job in
// .github/workflows/ci-lint.yml means updating this list too.
const REQUIRED_STATUS_CHECKS_STRICT = false;
const REQUIRED_STATUS_CHECK_CONTEXTS = [
  "jactionlint (pedantic, all rules, with shellcheck and pyflakes)",
  "sisakulint (GitHub Actions SAST, non-duplicate rules)",
  "betterleaks (secret scan)",
] as const;

type RulesetRule =
  | { type: "deletion" | "non_fast_forward" | "required_signatures" | "creation" | "update" | "required_linear_history" | "lock_branch" }
  | { type: "pull_request"; parameters: typeof PULL_REQUEST_PARAMETERS }
  | {
      type: "required_status_checks";
      parameters: {
        strict_required_status_checks_policy: boolean;
        do_not_enforce_on_create: boolean;
        required_status_checks: Array<{ context: string }>;
      };
    };

const buildRulesetRules = (): RulesetRule[] => {
  const rules: RulesetRule[] = [];
  if (RULESET_RULE_TOGGLES.deletion) rules.push({ type: "deletion" });
  if (RULESET_RULE_TOGGLES.non_fast_forward) rules.push({ type: "non_fast_forward" });
  if (RULESET_RULE_TOGGLES.pull_request) {
    rules.push({ type: "pull_request", parameters: PULL_REQUEST_PARAMETERS });
  }
  if (RULESET_RULE_TOGGLES.required_status_checks) {
    rules.push({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: REQUIRED_STATUS_CHECKS_STRICT,
        do_not_enforce_on_create: false,
        required_status_checks: REQUIRED_STATUS_CHECK_CONTEXTS.map((context) => ({ context })),
      },
    });
  }
  if (RULESET_RULE_TOGGLES.required_signatures) rules.push({ type: "required_signatures" });
  if (RULESET_RULE_TOGGLES.creation) rules.push({ type: "creation" });
  if (RULESET_RULE_TOGGLES.update) rules.push({ type: "update" });
  if (RULESET_RULE_TOGGLES.required_linear_history) rules.push({ type: "required_linear_history" });
  if (RULESET_RULE_TOGGLES.lock_branch) rules.push({ type: "lock_branch" });
  return rules;
};

const desiredRuleset = {
  name: RULESET_NAME,
  target: "branch",
  enforcement: "active",
  conditions: {
    ref_name: {
      include: ["~DEFAULT_BRANCH"],
      exclude: [] as string[],
    },
  },
  rules: buildRulesetRules(),
  bypass_actors: [] as unknown[],
};

// ---------------------------------------------------------------------------
// GitHub REST client (token only from the environment, never persisted)
// ---------------------------------------------------------------------------

const token = () => {
  const t = process.env.GITHUB_TOKEN;
  if (!t) {
    throw new Error(
      "GITHUB_TOKEN is not set. Run: export GITHUB_TOKEN=\"$(gh auth token)\"",
    );
  }
  return t;
};

async function gh<T>(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "muse-repo-template-alchemy",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(
      `GitHub API ${method} ${apiPath} failed: ${res.status} ${await res.text()}`,
    );
  }
  // Enable-style endpoints (vulnerability alerts, security fixes,
  // private vulnerability reporting) answer 204 No Content.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Status-only probe for the enable-style endpoints: their GET answers
// 200/204 when the feature is on and 404 when it is off.
async function ghEnabled(apiPath: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "muse-repo-template-alchemy",
    },
  });
  return res.status === 200 || res.status === 204;
}

// ---------------------------------------------------------------------------
// Converge: make GitHub match the desired state, idempotently
// ---------------------------------------------------------------------------

interface ConvergeResult {
  repo: string;
  repoSettingsChanged: boolean;
  securityChanged: string[];
  rulesetAction: "created" | "updated" | "unchanged";
  rulesetId: number;
}

async function converge(owner: string, repo: string): Promise<ConvergeResult> {
  const base = `/repos/${owner}/${repo}`;

  // 1. Repository settings
  const current = await gh<Record<string, unknown>>("GET", base);
  const patch: Record<string, unknown> = {};
  for (const [key, want] of Object.entries(desiredRepoSettings)) {
    if (current[key] !== want) patch[key] = want;
  }
  let repoSettingsChanged = false;
  if (Object.keys(patch).length > 0) {
    await gh("PATCH", base, patch);
    repoSettingsChanged = true;
  }

  // 2. Dependabot / vulnerability settings (probed per endpoint; see
  //    the note on desiredSecuritySettings for why the repository
  //    object's security_and_analysis is not used for this)
  const securityChanged: string[] = [];
  for (const key of Object.keys(desiredSecuritySettings) as Array<
    keyof typeof desiredSecuritySettings
  >) {
    const endpoint = securityEndpoints[key];
    if (!(await ghEnabled(`${base}/${endpoint}`))) {
      await gh("PUT", `${base}/${endpoint}`);
      securityChanged.push(key);
    }
  }

  // 3. Baseline ruleset (find by name, create or update in place)
  const existing = await gh<Array<{ id: number; name: string }>>(
    "GET",
    `${base}/rulesets`,
  );
  const found = existing.find((r) => r.name === RULESET_NAME);
  let rulesetAction: ConvergeResult["rulesetAction"] = "unchanged";
  let rulesetId: number;
  if (!found) {
    const created = await gh<{ id: number }>("POST", `${base}/rulesets`, desiredRuleset);
    rulesetId = created.id;
    rulesetAction = "created";
  } else {
    rulesetId = found.id;
    const detail = await gh<{
      enforcement: string;
      conditions: unknown;
      rules: Array<{ type: string; parameters?: unknown }>;
    }>("GET", `${base}/rulesets/${found.id}`);
    const canonical = (v: unknown): string =>
      JSON.stringify(v, (_k, val) =>
        val && typeof val === "object" && !Array.isArray(val)
          ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
          : val,
      );
    const sortRules = (rules: unknown[]) =>
      [...rules].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    // GitHub echoes server-managed parameter defaults back (for
    // example allowed_merge_methods on the pull_request rule) that
    // this program does not send. Project the live rules onto the
    // parameter keys the program manages before comparing, so the
    // converge is a true no-op when the managed state already matches.
    const desiredByType = new Map<string, { parameters?: Record<string, unknown> }>(
      desiredRuleset.rules.map((r) => [
        r.type,
        r as { parameters?: Record<string, unknown> },
      ]),
    );
    const projectRule = (rule: { type: string; parameters?: unknown }) => {
      const desired = desiredByType.get(rule.type);
      if (!rule.parameters || !desired?.parameters) return rule;
      const keep = new Set(Object.keys(desired.parameters));
      return {
        ...rule,
        parameters: Object.fromEntries(
          Object.entries(rule.parameters as Record<string, unknown>).filter(
            ([k]) => keep.has(k),
          ),
        ),
      };
    };
    const sameRules =
      canonical(sortRules(detail.rules.map(projectRule))) ===
      canonical(sortRules([...desiredRuleset.rules]));
    const sameSet = (a: string[] = [], b: readonly string[] = []) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const detailConditions = detail.conditions as {
      ref_name?: { include?: string[]; exclude?: string[] };
    };
    const sameConditions =
      sameSet(detailConditions.ref_name?.include, desiredRuleset.conditions.ref_name.include) &&
      sameSet(detailConditions.ref_name?.exclude, desiredRuleset.conditions.ref_name.exclude);
    if (!sameRules || !sameConditions || detail.enforcement !== "active") {
      await gh("PUT", `${base}/rulesets/${found.id}`, desiredRuleset);
      rulesetAction = "updated";
    }
  }

  // 4. Record last-applied state under .alchemy/ (Alchemy's local state
  //    directory convention). Contains no credentials.
  const specHash = createHash("sha256")
    .update(JSON.stringify({ desiredRepoSettings, desiredSecuritySettings, desiredRuleset }))
    .digest("hex");
  const stateDir = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    ".alchemy",
    "github-baseline",
  );
  await mkdir(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, `${owner}__${repo}.json`);
  let previous: unknown = null;
  try {
    previous = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    previous = null;
  }
  await writeFile(
    stateFile,
    JSON.stringify(
      {
        repo: `${owner}/${repo}`,
        specHash,
        rulesetId,
        rulesetName: RULESET_NAME,
        repoSettingsChanged,
        securityChanged,
        rulesetAction,
        previous,
        appliedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );

  return { repo: `${owner}/${repo}`, repoSettingsChanged, securityChanged, rulesetAction, rulesetId };
}

// ---------------------------------------------------------------------------
// Alchemy stack + direct-run entry point
// ---------------------------------------------------------------------------

function targetRepo(): { owner: string; repo: string } {
  const arg = process.argv.find((a) => a.startsWith("--repo="));
  const value = arg?.slice("--repo=".length) ?? process.env.GITHUB_REPO;
  if (!value || !value.includes("/")) {
    throw new Error(
      "Target repo missing. Set GITHUB_REPO=owner/repo or pass --repo=owner/repo",
    );
  }
  const [owner, repo] = value.split("/");
  return { owner: owner!, repo: repo! };
}

const program = Effect.gen(function* () {
  const { owner, repo } = targetRepo();
  // A failed converge dies as a defect (Effect.orDie): Alchemy.Stack
  // requires the program's error channel to be ConfigError, and a
  // GitHub API failure is not a configuration problem. The run still
  // fails, with the original error as the defect cause.
  const result = yield* Effect.tryPromise(() => converge(owner, repo)).pipe(
    Effect.orDie,
  );
  console.log(
    `[github-baseline] ${result.repo}: repo settings ${
      result.repoSettingsChanged ? "updated" : "already matched"
    }, security ${
      result.securityChanged.length > 0
        ? `enabled: ${result.securityChanged.join(", ")}`
        : "already enabled"
    }, ruleset "${RULESET_NAME}" (id=${result.rulesetId}) ${result.rulesetAction}`,
  );
  return result;
});

// The Alchemy Stack declaration: local state store, no cloud providers
// (the converge above talks to the GitHub API directly, as documented).
export default Alchemy.Stack(
  "github-repo-baseline",
  {
    providers: Layer.empty,
    state: Alchemy.localState(),
  },
  program,
);

// Direct run without the Alchemy CLI: `bun run alchemy.run.ts`
// (import.meta.main is true only when this file is the entry point,
// not when the Alchemy CLI imports it as a stack).
if ((import.meta as { main?: boolean }).main) {
  await Effect.runPromise(program);
}
