"use strict";

const fs = require("node:fs");

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_BODY_LENGTH = 16 * 1024;
const MAX_COMMENTS = 50;
const MAX_COMMENT_BODY_LENGTH = 8 * 1024;
const MAX_PATH_LENGTH = 1024;

function fail(message) {
  throw new Error(`Invalid Forgejo structured review output: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    fail(`${label} has unexpected or missing keys`);
  }
}

function assertText(value, label, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    fail(`${label} exceeds ${maxLength} characters`);
  }
  if (/\u0000/u.test(value)) {
    fail(`${label} contains a NUL character`);
  }
}

function assertPath(path) {
  assertText(path, "comment.path", MAX_PATH_LENGTH);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    fail("comment.path must be a normalized repository-relative path");
  }
}

function assertPosition(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
}

function validateForgejoReviewOutput(value) {
  if (!isPlainObject(value)) {
    fail("document must be an object");
  }
  assertExactKeys(value, ["body", "comments"], "document");
  assertText(value.body, "body", MAX_BODY_LENGTH);
  if (!Array.isArray(value.comments) || value.comments.length > MAX_COMMENTS) {
    fail(`comments must be an array containing at most ${MAX_COMMENTS} entries`);
  }

  for (const [index, comment] of value.comments.entries()) {
    const label = `comments[${index}]`;
    if (!isPlainObject(comment)) {
      fail(`${label} must be an object`);
    }
    const positionKeys = ["new_position", "old_position"].filter((key) => key in comment);
    if (positionKeys.length !== 1) {
      fail(`${label} must contain exactly one of new_position or old_position`);
    }
    assertExactKeys(comment, ["path", "body", positionKeys[0]], label);
    assertPath(comment.path);
    assertPosition(comment[positionKeys[0]], `${label}.${positionKeys[0]}`);
    assertText(comment.body, `${label}.body`, MAX_COMMENT_BODY_LENGTH);
  }

  return value;
}

function readRegularFile(path) {
  let descriptor;
  try {
    // O_NOFOLLOW closes the time-of-check/time-of-use gap an untrusted agent
    // could otherwise exploit by swapping its output for a symlink.
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      fail("output path must be a regular, non-symlink file");
    }
    if (stat.size > MAX_OUTPUT_BYTES) {
      fail(`output exceeds ${MAX_OUTPUT_BYTES} bytes`);
    }
    return fs.readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ELOOP") {
      fail("output path must be a regular, non-symlink file");
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateForgejoReviewOutputFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readRegularFile(path));
  } catch (error) {
    fail(`must contain valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return validateForgejoReviewOutput(parsed);
}

if (require.main === module) {
  const [path] = process.argv.slice(2);
  if (path === undefined) {
    console.error("Usage: node validate-forgejo-review-output.js OUTPUT_PATH");
    process.exit(2);
  }
  try {
    validateForgejoReviewOutputFile(path);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  MAX_BODY_LENGTH,
  MAX_COMMENT_BODY_LENGTH,
  MAX_COMMENTS,
  MAX_OUTPUT_BYTES,
  validateForgejoReviewOutput,
  validateForgejoReviewOutputFile,
};
