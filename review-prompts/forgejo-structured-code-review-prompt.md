# PR Code Review

Review the checked-out pull-request head for concrete correctness, security,
error-handling, integration, and documentation problems. First read the trusted
JSON review context at `$REVIEW_CONTEXT_PATH`. Its exact version 1 shape is:

```json
{
  "schemaVersion": 1,
  "slot": "forgejo-review-code-smart-1",
  "pullRequest": {"title": "...", "body": "..."},
  "changedFiles": ["src/example.ts"],
  "diff": {"unified": "diff --git ...", "truncated": false}
}
```

Use the title/body to understand intent, `changedFiles` to scope the review,
and `diff.unified` to inspect changes. If `diff.truncated` is true or more
context is necessary, inspect the credential-free working tree and local git
history directly. The context intentionally contains no repository identity,
PR number, commit/ref, event/run identity, or forge/API coordinate.
The producer bounds title at 512 characters, body at 65,536 UTF-8 bytes,
changed files at 500 paths of at most 1,024 characters, and the unified diff at
1,048,576 UTF-8 bytes.

Focus on actionable defects. Do not suggest stylistic changes, speculative
performance work, or tests merely for coverage. Verify runtime claims before
stating them as facts.

When finished, write exactly one JSON document to `$REVIEW_OUTPUT_PATH`:

```json
{
  "schemaVersion": 1,
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

The document has exactly the `schemaVersion`, `body`, and `comments` keys.
`schemaVersion` is the number `1`; `body` is a concise, non-empty summary of at
most 16,384 UTF-8 bytes. Include at most 50 comments. Each comment has exactly
`path`, `body`, and one position: `new_position` for a line in the new file or
`old_position` for a deleted line. Positions are positive integers. Paths are
normalized repository-relative strings of at most 1,024 characters; comment
bodies are at most 8,192 UTF-8 bytes. Attach each comment to a changed diff
line. Use `comments: []` when there are no findings.

Do not add repository identity, PR number, commit SHA, event, API URL, token,
or any other fields. Do not post, submit, or otherwise send a review yourself.
Writing the JSON document is the entire handoff.
