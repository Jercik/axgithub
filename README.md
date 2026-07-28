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
shell script each review recipe executes on the runner. It has two modes,
selected by whether `REVIEW_PROFILE` is set in the recipe env.

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

These replace the existing Forgejo direct-post recipes at the OIDC cutover.
During rollout the seeder keeps that legacy set in the explicitly isolated
`seedLegacyForgejoDirectPostRecipes` path so current workflows continue to run;
there is no runtime fallback between the two sets. The structured slots are the
OIDC migration contract shared with `axrecipe`, `j4k/cluster`, and `j4k/align`.
An agent receives only the nonsecret `REVIEW_CONTEXT_PATH` and
`REVIEW_OUTPUT_PATH` Forgejo inputs. It must write one exact JSON document:

```json
{
  "body": "A concise non-empty summary",
  "comments": [
    {"path": "src/file.ts", "new_position": 12, "body": "A finding"}
  ]
}
```

Each comment has `path`, `body`, and exactly one positive position:
`new_position` or `old_position`. The generated structured runner rejects
unknown keys, unsafe paths, missing/oversized text, invalid positions, more
than 50 comments, invalid JSON, and symlinked/oversized output. The trusted
outer process may use the existing `AXCREDS`/`AXCREDROUTER` path to launch the
selected model, but axexec scrubs that configuration before spawning the
reviewer. Perplexity and ambient Forgejo, Actions OIDC/runtime, npm, GitHub, CI,
and SSH credentials are absent from the child environment. The agent receives
no Forgejo token, API base, repository/PR identity, commit SHA, or review-posting
instruction. A trusted poster must bind the accepted handoff to the
OIDC-authenticated repository/PR/head/slot, re-fetch the current diff, and
validate each path and position before it posts the review.

After every managed Forgejo workflow has moved to the structured slots, finish
the hard cutover in one change: delete
`seedLegacyForgejoDirectPostRecipes` and its isolated resources/recipe arrays,
remove the old Forgejo recipe IDs from the cluster-managed execute-key scope,
and reseed. Historical recipes with recorded runs may remain in the database,
but no seeder or key will authorize them. Do not add a compatibility flag or
fall back to the old IDs.

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
