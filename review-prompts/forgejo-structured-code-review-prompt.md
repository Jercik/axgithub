# PR Code Review

Review the checked-out pull-request head for concrete correctness, security,
error-handling, integration, and documentation problems. Read the trusted
review context at `$REVIEW_CONTEXT_PATH` before reviewing; it describes the
review slot and the changed files. Explore the working tree and its git diff
for the necessary context.

Focus on actionable defects. Do not suggest stylistic changes, speculative
performance work, or tests merely for coverage. Verify runtime claims before
stating them as facts.

When finished, write exactly one JSON document to `$REVIEW_OUTPUT_PATH`:

```json
{
  "body": "**Summary:** Found 1 medium issue.",
  "comments": [
    {
      "path": "src/example.ts",
      "new_position": 42,
      "body": "🟡 **Medium:** Explain the concrete defect and a safe fix."
    }
  ]
}
```

The document has exactly the `body` and `comments` keys. `body` is a concise,
non-empty summary. Each comment has exactly `path`, `body`, and one position:
`new_position` for a line in the new file or `old_position` for a deleted line.
Positions are positive integers. Use only normalized repository-relative paths
and attach each comment to a changed diff line. Use `comments: []` when there
are no findings.

Do not add repository identity, PR number, commit SHA, event, API URL, token,
or any other fields. Do not post, submit, or otherwise send a review yourself.
Writing the JSON document is the entire handoff.
