"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const {
  MAX_COMMENTS,
  validateForgejoReviewOutput,
  validateForgejoReviewOutputFile,
} = require("./validate-forgejo-review-output.js");

const validOutput = {
  body: "**Summary:** Found no issues.",
  comments: [{ path: "src/index.ts", new_position: 12, body: "Looks correct." }],
};

test("accepts an exact bounded Forgejo review shape", () => {
  assert.deepEqual(validateForgejoReviewOutput(validOutput), validOutput);
});

test("allows a deleted-line comment but not both position shapes", () => {
  assert.doesNotThrow(() =>
    validateForgejoReviewOutput({
      body: "Deleted line review.",
      comments: [{ path: "src/deleted.ts", old_position: 4, body: "This removal drops validation." }],
    }),
  );
  assert.throws(
    () =>
      validateForgejoReviewOutput({
        body: "Invalid positions.",
        comments: [
          { path: "src/index.ts", new_position: 1, old_position: 1, body: "Invalid." },
        ],
      }),
    /exactly one/u,
  );
});

test("rejects metadata, unsafe paths, non-positive positions, and oversized comment lists", () => {
  assert.throws(
    () => validateForgejoReviewOutput({ ...validOutput, commit_id: "attacker-controlled" }),
    /unexpected or missing keys/u,
  );
  assert.throws(
    () =>
      validateForgejoReviewOutput({
        body: "Unsafe path.",
        comments: [{ path: "../secrets", new_position: 1, body: "No." }],
      }),
    /repository-relative/u,
  );
  assert.throws(
    () =>
      validateForgejoReviewOutput({
        body: "Bad position.",
        comments: [{ path: "src/index.ts", new_position: 0, body: "No." }],
      }),
    /positive safe integer/u,
  );
  assert.throws(
    () =>
      validateForgejoReviewOutput({
        body: "Too many.",
        comments: Array.from({ length: MAX_COMMENTS + 1 }, () => ({
          path: "src/index.ts",
          new_position: 1,
          body: "No.",
        })),
      }),
    /at most/u,
  );
});

test("rejects a symlinked output file", () => {
  const directory = mkdtempSync(join(tmpdir(), "axgithub-review-output-"));
  try {
    const actual = join(directory, "actual.json");
    const output = join(directory, "output.json");
    writeFileSync(actual, JSON.stringify(validOutput));
    symlinkSync(actual, output);
    assert.throws(() => validateForgejoReviewOutputFile(output), /non-symlink/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
