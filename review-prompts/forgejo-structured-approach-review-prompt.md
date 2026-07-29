# PR Approach Review

Review the checked-out pull-request head at a high level. First read the trusted
JSON review context at `$REVIEW_CONTEXT_PATH`. Its exact version 1 shape is:

```json
{
  "schemaVersion": 1,
  "slot": "forgejo-review-approach-smart-1",
  "pullRequest": {"title": "...", "body": "..."},
  "changedFiles": ["src/example.ts"],
  "diff": {"unified": "diff --git ...", "truncated": false}
}
```

Use the title/body to understand intent, `changedFiles` to scope the review,
and `diff.unified` to inspect changes. If `diff.truncated` is true or more
context is necessary, inspect the credential-free working tree and local git
history directly. The context intentionally contains no repository identity,
PR number, commit/ref, event/run identity, or forge/API coordinate. Your only
question is whether there is a materially better approach to solve the problem.
The producer bounds title at 512 characters, body at 65,536 UTF-8 bytes,
changed files at 500 paths of at most 1,024 characters, and the unified diff at
1,048,576 UTF-8 bytes.

Suggest an alternative only when an existing project utility or standard
facility is clearly preferable, the implementation is significantly more
complex than necessary, or the chosen design creates an obvious maintenance or
scaling problem. Do not report implementation bugs, style, naming, formatting,
minor optimizations, or subjective refactoring preferences.

When finished, write exactly one JSON document to `$REVIEW_OUTPUT_PATH`. Use a
shell command: the review lane deliberately does not grant a file-editing tool.
For example, write the complete document with a quoted heredoc:

```sh
cat > "$REVIEW_OUTPUT_PATH" <<'REVIEWJSON'
{"schemaVersion":1,"body":"**Approach review:** The approach looks good.\n\n_Approach review by __REVIEW_DISPLAY_NAME__ (__REVIEW_MODEL__)_","comments":[]}
REVIEWJSON
```

The document must have this shape:

```json
{
  "schemaVersion": 1,
  "body": "**Approach review:** The approach looks good.\n\n_Approach review by __REVIEW_DISPLAY_NAME__ (__REVIEW_MODEL__)_",
  "comments": []
}
```

The body must end with a blank line followed by
`_Approach review by __REVIEW_DISPLAY_NAME__ (__REVIEW_MODEL__)_`.

The document has exactly the `schemaVersion`, `body`, and `comments` keys.
`schemaVersion` is the number `1`; `body` is a concise, non-empty assessment of
at most 16,384 UTF-8 bytes. Include at most 50 comments. Each comment has exactly
`path`, `body`, and one position: `new_position` for a line in the new file or
`old_position` for a deleted line. Positions are positive integers. Paths are
normalized repository-relative strings of at most 1,024 characters; comment
bodies are at most 8,192 UTF-8 bytes. Attach each alternative to a changed diff
line. Use `comments: []` when there is no material alternative.

Do not add repository identity, PR number, commit SHA, event, API URL, token,
or any other fields. Do not post, submit, or otherwise send a review yourself.
Writing the JSON document is the entire handoff.
