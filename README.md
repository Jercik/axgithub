# axgithub

GitHub-specific shared workflows for the [a╳kit](https://github.com/Jercik?tab=repositories&q=ax) ecosystem.

Nothing here is live. This repo existed to host the reusable PR-review workflow
and the axrecipe recipes behind it, and that pipeline has been retired.

## What was here

`.github/workflows/pr-review.yml` ran axrecipe recipes as a parallel matrix,
each posting its own review through the GitHub Reviews API. It was removed from
`main` in #18. Its recipes, prompts, runners, and the `seed-review-recipes.ts`
seeder followed.

The tags `v1`, `v1.0.0`, and `v1.0.1` still carry the workflow. They stay so the
one surviving pin keeps resolving — `Jercik/sync-rules`, which is itself
archived. No live default branch on either forge calls it.

## What replaced it

Managed PR review runs on the Forge now. `j4k-align` renders a `review.yml` for
each repo carrying a committed `.review-enrolled` marker, and that workflow
calls the pinned `j4k-oss/review-wrapper` action against the review service.
GitHub repos are not enrolled.
