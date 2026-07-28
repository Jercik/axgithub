import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildStructuredForgejoSettings,
  structuredForgejoRecipes,
} from "../scripts/seed-review-recipes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const COMMON_OUTER_KEYS = ["AXCREDS", "AXRUN_ALLOW", "PROMPT_TEXT"];
const PROFILE_OUTER_KEYS = ["AXCREDROUTER", "REVIEW_PROFILE"];
const DIRECT_OUTER_KEYS = [
  "REVIEW_AGENT",
  "REVIEW_DISPLAY_NAME",
  "REVIEW_MODEL",
  "REVIEW_VAULT_CREDENTIAL",
];
const EXPECTED_PROMPT_RESOURCES = [
  "forgejo-review-approach-v1-prompt",
  "forgejo-review-code-v1-prompt",
];

test("structured recipe settings contain only vetted outer-process fields", () => {
  for (const recipe of structuredForgejoRecipes) {
    const settings = buildStructuredForgejoSettings(recipe, recipe.promptResource);
    const expected = [
      ...COMMON_OUTER_KEYS,
      ...(recipe.env.REVIEW_PROFILE === undefined ? DIRECT_OUTER_KEYS : PROFILE_OUTER_KEYS),
    ].sort();
    assert.deepEqual(Object.keys(settings.env).sort(), expected, recipe.recipeId);
  }
});

test("five stable slots share two versioned prompt resources", () => {
  assert.deepEqual(
    [...new Set(structuredForgejoRecipes.map((recipe) => recipe.promptResource))].sort(),
    EXPECTED_PROMPT_RESOURCES,
  );
  assert.deepEqual(
    structuredForgejoRecipes.map((recipe) => recipe.recipeId),
    [
      "forgejo-review-approach-smart-1",
      "forgejo-review-approach-smart-2",
      "forgejo-review-approach-3",
      "forgejo-review-code-smart-1",
      "forgejo-review-code-smart-2",
    ],
  );
});

test("both prompts encode the exact context and result v1 contracts", () => {
  for (const name of [
    "forgejo-structured-approach-review-prompt.md",
    "forgejo-structured-code-review-prompt.md",
  ]) {
    const prompt = readFileSync(join(repoRoot, "review-prompts", name), "utf8");
    const blocks = [...prompt.matchAll(/```json\n(?<json>[\s\S]*?)\n```/gu)].map((match) =>
      JSON.parse(match.groups?.json ?? "null") as Record<string, unknown>,
    );
    assert.equal(blocks.length, 2, name);
    const [context, result] = blocks;
    assert.ok(context);
    assert.deepEqual(Object.keys(context), [
      "schemaVersion",
      "slot",
      "pullRequest",
      "changedFiles",
      "diff",
    ]);
    assert.equal(context.schemaVersion, 1);
    assert.deepEqual(Object.keys(context.pullRequest as Record<string, unknown>), ["title", "body"]);
    assert.deepEqual(Object.keys(context.diff as Record<string, unknown>), ["unified", "truncated"]);
    assert.ok(result);
    assert.deepEqual(Object.keys(result), ["schemaVersion", "body", "comments"]);
    assert.equal(result.schemaVersion, 1);
    assert.match(prompt, /16,384 UTF-8 bytes/u);
    assert.match(prompt, /at most 50 comments/u);
    assert.match(prompt, /1,024 characters/u);
    assert.match(prompt, /8,192 UTF-8 bytes/u);
    assert.match(prompt, /65,536 UTF-8 bytes/u);
    assert.match(prompt, /1,048,576 UTF-8 bytes/u);
  }
  assert.match(readFileSync(join(repoRoot, "README.md"), "utf8"), /each have a separate 4 MiB transport cap/u);
});

test("versioned structured runner is valid shell", () => {
  const result = spawnSync("sh", ["-n", join(here, "structured-forgejo-runner.sh")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("structured runner hands its descriptor directly to axrun", () => {
  const recipe = structuredForgejoRecipes[0];
  assert.ok(recipe);
  const command = buildStructuredForgejoSettings(recipe, recipe.promptResource).args[1];
  assert.match(command, /exec "\$AXRUN_BIN" --agent "\$REVIEW_AGENT"/u);
  assert.match(command, /--credential-handoff-fd "\$AXRUN_CREDENTIAL_HANDOFF_FD"/u);
  assert.doesNotMatch(command, /--provider "\$REVIEW_PROVIDER"/u);
});

test("composed reviewer child environment is a positive allowlist", () => {
  const directory = mkdtempSync(join(tmpdir(), "axgithub-structured-env-"));
  try {
    const bin = join(directory, "bin");
    const contextPath = join(directory, "context.json");
    const axrunPath = join(bin, "axrun");
    const axinstallPath = join(bin, "axinstall");
    mkdirSync(bin);
    writeFileSync(
      axrunPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "resolve") {
  console.log(JSON.stringify({ available: true, agentId: "test-agent", credentialName: "test-credential", displayName: "Test" }));
  process.exit(0);
}
if (process.argv[2] === "credential" && process.argv[3] === "export") {
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex === -1 || !process.argv[outputIndex + 1]) process.exit(2);
  fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  process.exit(0);
}
const handoffIndex = process.argv.indexOf("--credential-handoff-fd");
if (handoffIndex === -1 || !process.argv[handoffIndex + 1]) {
  console.error("structured runner must invoke axrun with a credential handoff descriptor");
  process.exit(2);
}
if (process.env.AXCREDS || process.env.AXCREDROUTER || process.env.REVIEW_PROVIDER) {
  console.error("credential authority crossed the structured runner boundary");
  process.exit(2);
}
fs.fstatSync(Number(process.argv[handoffIndex + 1]));
// Model axexec's real base-environment scrub after the checked-in runner's
// positive allowlist. Provider auth is deliberately outside this ambient-env test.
const servicePrefixes = ["AXCREDS", "AXCREDROUTER", "AXSESSION", "AXSANDBOX", "AXVAULT", "AXRECIPE"];
const child = {};
for (const [key, value] of Object.entries(process.env)) {
  const upper = key.toUpperCase();
  const npmLaunchState = key.startsWith("npm_") || upper === "NODE" || upper === "NPM_EXECPATH" || upper === "NPM_CONFIG_USER_AGENT" || upper.startsWith("NPM_CONFIG_");
  const axCredential = upper.startsWith("AX_") && upper.endsWith("_CREDENTIALS");
  const axService = servicePrefixes.some((prefix) => upper === prefix || upper.startsWith(prefix + "_"));
  if (!npmLaunchState && !axCredential && !axService) child[key] = value;
}
fs.writeFileSync(process.env.REVIEW_OUTPUT_PATH + ".child-environment.json", JSON.stringify(child));
fs.writeFileSync(process.env.REVIEW_OUTPUT_PATH, JSON.stringify({ schemaVersion: 1, body: "No issues found.", comments: [] }));
`,
      { mode: 0o700 },
    );
    writeFileSync(axinstallPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(axrunPath, 0o700);
    chmodSync(axinstallPath, 0o700);
    writeFileSync(contextPath, "{}\n", { mode: 0o600 });

    const canary = "ambient-authority-canary";
    const allowedKeys = new Set([
      "AXRUN_ALLOW",
      "AXRUN_BIN",
      "AXRUN_CREDENTIAL_HANDOFF_FD",
      "AXRUN_RESOLVED_PROFILE",
      "AXEXEC_OPENCODE_PATH",
      "CI",
      "GITHUB_ACTIONS",
      "GITHUB_WORKSPACE",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "PROMPT_TEXT",
      "PWD",
      "REVIEW_AGENT",
      "REVIEW_CONTEXT_PATH",
      "REVIEW_DISPLAY_NAME",
      "REVIEW_MODEL",
      "REVIEW_OUTPUT_PATH",
      "REVIEW_PROFILE",
      "REVIEW_REASONING_EFFORT",
      "SHLVL",
      "TERM",
      "TMPDIR",
      "_",
      // Injected by macOS when /bin/sh starts, even under env -i.
      "__CF_USER_TEXT_ENCODING",
    ]);
    for (const recipe of structuredForgejoRecipes) {
      const outputPath = join(directory, `${recipe.recipeId}.json`);
      const settings = buildStructuredForgejoSettings(recipe, recipe.promptResource);
      const result = runShell(settings.args[1], {
        ...process.env,
        ...settings.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        REVIEW_CONTEXT_PATH: contextPath,
        REVIEW_OUTPUT_PATH: outputPath,
        CI: "true",
        GITHUB_ACTIONS: "true",
        GITHUB_WORKSPACE: repoRoot,
        GITHUB_ENV: canary,
        GITHUB_PATH: canary,
        GITHUB_OUTPUT: canary,
        GITHUB_STATE: canary,
        GITHUB_STEP_SUMMARY: canary,
        FORGEJO_TOKEN: canary,
        GITEA_TOKEN: canary,
        GITHUB_TOKEN: canary,
        ACTIONS_RUNTIME_TOKEN: canary,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: canary,
        NPM_TOKEN: canary,
        npm_config__authToken: canary,
        AXRECIPE_API_KEY: canary,
        AX_OPENAI_CREDENTIALS: canary,
        AWS_SECRET_ACCESS_KEY: canary,
        GOOGLE_APPLICATION_CREDENTIALS: canary,
        KUBECONFIG: canary,
        DOCKER_CONFIG: canary,
        FUTURE_FORGE_CREDENTIAL_CHANNEL: canary,
      });
      assert.equal(result.status, 0, `${recipe.recipeId}: ${result.stderr}`);

      const child = JSON.parse(
        readFileSync(`${outputPath}.child-environment.json`, "utf8"),
      ) as Record<string, string>;
      assert.equal(Object.values(child).includes(canary), false, recipe.recipeId);
      assert.deepEqual(
        Object.keys(child).filter((key) => !allowedKeys.has(key)),
        [],
        `${recipe.recipeId}: ${JSON.stringify(child, null, 2)}`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("seeder main guard remains active through a symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "axgithub-seeder-entry-"));
  try {
    const link = join(directory, "seed-review-recipes.ts");
    symlinkSync(join(repoRoot, "scripts", "seed-review-recipes.ts"), link);
    const environment = { ...process.env };
    delete environment.AXRECIPE_API_KEY;
    const result = spawnSync(process.execPath, [link], { encoding: "utf8", env: environment });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AXRECIPE_API_KEY is required/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runShell(command: string, environment: NodeJS.ProcessEnv) {
  return spawnSync("sh", ["-c", command], {
    encoding: "utf8",
    env: environment,
  });
}
