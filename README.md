# axgithub

GitHub-specific shared workflows for the [a╳kit](https://github.com/Jercik?tab=repositories&q=ax) ecosystem.

This repo hosts artifacts that only make sense inside GitHub Actions — reusable
workflows, composite actions, repo templates. Runtime packages live in their
own `ax*` repos.

## Reusable workflows

### `pr-review.yml`

Runs [axrecipe](https://recipe.axkit.dev) recipes as a parallel matrix to review
a pull request. Each recipe posts its own review via the GitHub Reviews API.

Recipe definitions, recipe names, and how to mint an `AXRECIPE_API_KEY` are
documented in the [axrecipe README](https://github.com/Jercik/axrecipe#readme).

**Inputs**

| Input       | Type   | Description                                                    |
| ----------- | ------ | -------------------------------------------------------------- |
| `label`     | string | Job display label, e.g. `approach`, `code`.                    |
| `recipes`   | string | JSON-encoded array of matrix entries — see below.              |
| `pr_number` | string | PR number to review. Pass as string — see [Gotchas](#gotchas). |

Each `recipes` entry is either an axrecipe recipe name string (e.g.
`"pr-review-approach-2"`) or a `{recipe, name}` object. Use objects to run the
same recipe more than once under distinct job names — bare duplicate matrix
values are deduplicated by GitHub.

**Secrets**

| Secret             | Purpose                                                          |
| ------------------ | --------------------------------------------------------------- |
| `NPM_TOKEN`        | Read auth for the `@j4k` registry on `code.j4k.dev`. Callers pass their `FORGEJO_NPM_TOKEN` read PAT as this input's value; the name is kept for caller compatibility. |
| `AXRECIPE_API_KEY` | Auth for the axrecipe server.                                   |

**Caller example**

```yaml
name: PR Code Review

on:
  pull_request_target:
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      pr_number:
        description: "PR number to review"
        required: true
        type: number

jobs:
  review:
    permissions:
      contents: read
      pull-requests: write
      actions: read
    uses: Jercik/axgithub/.github/workflows/pr-review.yml@v1
    with:
      label: code
      recipes: >-
        [{"recipe":"pr-review-code-smart","name":"code smart 1"},
         {"recipe":"pr-review-code-smart","name":"code smart 2"}]
      pr_number: ${{ github.event.pull_request.number || inputs.pr_number }}
    secrets:
      NPM_TOKEN: ${{ secrets.FORGEJO_NPM_TOKEN }}
      AXRECIPE_API_KEY: ${{ secrets.AXRECIPE_API_KEY }}
```

## Review runner

[`review-recipes/review-runner.sh`](review-recipes/review-runner.sh) is the
shell script each legacy direct-post recipe executes on the runner. The
structured Forgejo slots embed a transformed copy under the isolated wrapper
described below. The generic runner has two modes, selected by whether
`REVIEW_PROFILE` is set in the recipe env.

**Profile mode (resolve → install → run).** When `REVIEW_PROFILE` names an
[axcredrouter](https://credrouter.axkit.dev) profile (e.g. `smart-pr-review`),
the runner first calls `axrun resolve --profile "$REVIEW_PROFILE" --json`
(configured via the `AXCREDROUTER` env JSON, which recipes inject as
`{{vault:ci-axcredrouter-config}}`). The resolve response picks the lane —
agent, model, credential, reasoning effort — against live usage; the runner
parses it with node and exports `REVIEW_AGENT`, `REVIEW_MODEL`,
`REVIEW_VAULT_CREDENTIAL`, `REVIEW_DISPLAY_NAME` (`displayName`, falling back
to the agent id), and `REVIEW_REASONING_EFFORT`. Only then does `axinstall`
install the resolved agent, and the final `axrun` invocation passes `--model`
and `--reasoning-effort` only when the lane supplied them. When every lane is
exhausted, `axrun resolve` exits 1 and the job fails — an exhausted pool is a
deliberate red check, not a silent skip.

**Legacy direct mode.** When `REVIEW_PROFILE` is unset, the recipe env drives
the run directly via `REVIEW_AGENT`, `REVIEW_MODEL`, `REVIEW_VAULT_CREDENTIAL`,
`REVIEW_DISPLAY_NAME`, and optionally `REVIEW_PROVIDER`. This block remains for
the gemini and opencode recipes, which don't route through axcredrouter.

In both modes the runner substitutes `__REVIEW_REPOSITORY__`,
`__REVIEW_PR_NUMBER__`, `__REVIEW_DISPLAY_NAME__`, and `__REVIEW_MODEL__` into
the prompt with a node split/join pass (safe for `| & \` and newlines, unlike
sed). The resolved credential name is only ever passed to
`--vault-credential` — it never appears in the prompt or the posted review;
public attribution uses the display name.

### Forgejo structured-review recipes

`scripts/seed-review-recipes.ts` also creates a separate, versioned Forgejo
recipe for each enabled review slot:

- `forgejo-review-approach-smart-1`
- `forgejo-review-approach-smart-2`
- `forgejo-review-approach-3`
- `forgejo-review-code-smart-1`
- `forgejo-review-code-smart-2`

These replace the existing six-recipe Forgejo direct-post roster at the OIDC
cutover; the new roster deliberately has five slots and is not a one-for-one
rename. The fable and Gemini slots are retired, while each smart lane gets two
independent draws. During rollout the seeder keeps the legacy roster in the
explicitly isolated `seedLegacyForgejoDirectPostRecipes` path so current
workflows continue to run; there is no runtime fallback between the two sets.
The structured slots are the OIDC migration contract shared with `axrecipe`,
`j4k/cluster`, and `j4k/align`.
The five slots share two versioned resources:

- `forgejo-review-approach-v1-prompt`
- `forgejo-review-code-v1-prompt`

Axrecipe v9 supplies two nonsecret paths to the generator:
`REVIEW_CONTEXT_PATH` and `REVIEW_OUTPUT_PATH`. The context is a bounded JSON
document with this exact shape:

```json
{
  "schemaVersion": 1,
  "slot": "forgejo-review-code-smart-1",
  "pullRequest": {"title": "...", "body": "..."},
  "changedFiles": ["src/file.ts"],
  "diff": {"unified": "diff --git ...", "truncated": false}
}
```

Title is limited to 512 characters; body to 64 KiB UTF-8; changed files to 500
normalized repository-relative paths of at most 1,024 characters; and the
unified diff to 1 MiB UTF-8. `diff.truncated` records whether the producer had
to cut it. The context never contains a repository slug/ID, PR number, commit
or ref, event/run identity, or forge/API coordinate. Repository identity may
still be discoverable from the credential-free checkout itself; it is not an
authorization secret.

The generator must write one exact version 1 result document:

```json
{
  "schemaVersion": 1,
  "body": "A concise non-empty summary",
  "comments": [
    {"path": "src/file.ts", "new_position": 12, "body": "A finding"}
  ]
}
```

The body is at most 16,384 UTF-8 bytes. There are at most 50 comments; each has
`path`, `body`, and exactly one positive `new_position` or `old_position`.
Paths are at most 1,024 characters and comment bodies at most 8,192 UTF-8 bytes.
Raw context and result JSON files each have a separate 4 MiB transport cap;
decoded semantic limits remain authoritative. Axrecipe v9—not the untrusted
generator shell—owns the O_NOFOLLOW bounded read, strict schema validation, run
binding, and exact-byte result submission.

The checked-in structured runner first resolves a profile (when configured)
and prepares the selected agent and prompt under `env -i`. That preparation
environment contains a fresh temporary `HOME`/`TMPDIR`, a per-review
`NPM_CONFIG_PREFIX`, inherited `PATH`, the two axrecipe paths, prompt text, and
model routing. This credential-free preparation also substitutes the resolved
display name and model into the required review-body signature, so the exact
three-key result schema retains lane attribution without exposing routing
variables in the final model environment. It contains neither
`AXCREDS`/`AXCREDROUTER`, a vault credential name, nor `REVIEW_PROVIDER`, and
every helper process exits before a credential handoff exists.

Only then does the wrapper ask `@j4k/axrun@5` to export the selected credential
into an exclusive `0600` file and `exec` a clean Node launcher. The launcher
opens and unlinks that file, maps it to fd 4 only in axrun, closes its own copy
immediately, and remains a credential-free parent. The final environment
contains the scratch `HOME` and `TMPDIR`, prepared `PATH` and optional
`AXEXEC_*_PATH`, the two axrecipe paths, basic locale/process state, and
nonsecret `CI`, `GITHUB_ACTIONS`, and `GITHUB_WORKSPACE` metadata. Axrun
validates, reads, and closes fd 4 before it spawns the selected model. In this
v5 direct-handoff flow the provider comes from the agent-bound credential
descriptor;
`REVIEW_PROVIDER` is solely a legacy direct-mode input and must not be
reintroduced here.

The runner invokes the pre-fetched `axinstall` under a separate clean
environment and temporary npm prefix before it creates the credential handoff.
The composed generator therefore has no install fallback, and package lifecycle
processes cannot inherit the credential descriptor. The inherited `PATH` is an
execution-only dependency: the workflow must make every shared directory on it
read-only to the untrusted generator identity (or expose it via a read-only
mount). A writable tool prefix would be ambient write authority, not an
acceptable prefetch cache.

The wrapper targets the hosted Linux/macOS runner layout explicitly: core
utilities and `sh` under `/bin`, `env` under `/usr/bin`, and `mktemp` under
either `/usr/bin` or `/bin`. A custom runner image must provide those paths.

This is a process-environment boundary, not a same-UID sandbox. The consuming
workflow must isolate both package lifecycle processes and the untrusted
generator so neither can inspect the wrapper or workflow ancestors through
`/proc`, and it must not leave a trusted poster step in that identity. It must
also use
`persist-credentials: false` and a credential-free home: environment isolation
cannot remove credentials stored in `.git/config`, `~/.npmrc`, SSH/Git/GitHub
configuration, or another process's environment.

Generation and posting run in separate jobs. The generator has no review-posting
instruction or API authority, and no trusted poster step follows it in the same
job. The poster independently binds the accepted result to the
OIDC-authenticated repository/PR/head/slot, re-fetches the current diff,
validates each path and position, and posts exactly once.

After every managed Forgejo workflow has moved to the structured slots, finish
the hard cutover in one change: delete
`seedLegacyForgejoDirectPostRecipes` and its isolated resources/recipe arrays,
move every retired Forgejo recipe ID into `staleRecipeIds`, remove those IDs
from the cluster-managed execute-key scope, and reseed. Historical recipes with
recorded runs may remain in the database, but the seeder must report them until
an operator can prune them, and no key may authorize them. Do not add a
compatibility flag or fall back to the old IDs.

## Gotchas

- **`pr_number` is a string, not a number.** Expression interpolation
  (`${{ … }}`) yields strings at the reusable-workflow boundary; a `type: number`
  input silently rejects them and the run ends with `conclusion: failure` and
  zero jobs.
- **Caller must declare `permissions:` on the `uses:` job.** The reusable
  workflow needs `pull-requests: write` to post reviews, and most repos default
  to a read-only `GITHUB_TOKEN`.
- **Fork PRs are skipped inside the reusable workflow** (`pull_request_target`
  runs with full secrets, so untrusted fork code must not execute). The `if:`
  guard is load-bearing — do not remove it.

## Access

This is a private repo. For other repos to call its workflows,
**Settings → Actions → General → Access** must allow "repositories owned by the
user 'Jercik'".
