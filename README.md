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
