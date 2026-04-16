# axgithub

GitHub-specific shared workflows for the [a╳kit](https://github.com/Jercik?tab=repositories&q=ax) ecosystem.

This repo hosts artifacts that only make sense inside GitHub Actions — reusable
workflows, composite actions, repo templates. Runtime packages live in their
own `ax*` repos.

## Reusable workflows

### `pr-review.yml`

Runs [axrecipe](https://recipe.axkit.dev) recipes as a parallel matrix to review
a pull request. Each recipe posts its own review via the GitHub Reviews API.

**Inputs**

| Input       | Type   | Description                                                         |
| ----------- | ------ | ------------------------------------------------------------------- |
| `label`     | string | Job display label, e.g. `approach`, `code`.                         |
| `recipes`   | string | JSON-encoded array of recipe names, e.g. `'["code-1","code-2"]'`.   |
| `pr_number` | string | PR number to review. Pass as string — see [Gotchas](#gotchas).      |

**Secrets**

| Secret             | Purpose                             |
| ------------------ | ----------------------------------- |
| `NPM_TOKEN`        | Auth for the private npm registry.  |
| `AXRECIPE_API_KEY` | Auth for the axrecipe server.       |

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
      recipes: '["pr-review-code-1","pr-review-code-2"]'
      pr_number: ${{ github.event.pull_request.number || inputs.pr_number }}
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
      AXRECIPE_API_KEY: ${{ secrets.AXRECIPE_API_KEY }}
```

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
