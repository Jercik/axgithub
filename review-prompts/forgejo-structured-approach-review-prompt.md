# PR Approach Review

Review the checked-out pull-request head at a high level. Read the trusted
review context at `$REVIEW_CONTEXT_PATH` before reviewing, then explore the
working tree and its git diff. Your only question is whether there is a
materially better approach to solve the problem.

Suggest an alternative only when an existing project utility or standard
facility is clearly preferable, the implementation is significantly more
complex than necessary, or the chosen design creates an obvious maintenance or
scaling problem. Do not report implementation bugs, style, naming, formatting,
minor optimizations, or subjective refactoring preferences.

When finished, write exactly one JSON document to `$REVIEW_OUTPUT_PATH`:

```json
{
  "body": "**Approach review:** The approach looks good.",
  "comments": []
}
```

The document has exactly the `body` and `comments` keys. `body` is a concise,
non-empty assessment. Each comment has exactly `path`, `body`, and one position:
`new_position` for a line in the new file or `old_position` for a deleted line.
Positions are positive integers. Use only normalized repository-relative paths
and attach each alternative to a changed diff line. Use `comments: []` when
there is no material alternative.

Do not add repository identity, PR number, commit SHA, event, API URL, token,
or any other fields. Do not post, submit, or otherwise send a review yourself.
Writing the JSON document is the entire handoff.
