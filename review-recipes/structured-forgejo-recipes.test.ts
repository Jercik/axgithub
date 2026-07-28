import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildStructuredForgejoSettings,
  structuredForgejoRecipes,
} from "../scripts/seed-review-recipes.ts";

const COMMON_OUTER_KEYS = ["AXCREDS", "AXRUN_ALLOW", "PROMPT_TEXT"];
const PROFILE_OUTER_KEYS = ["AXCREDROUTER", "REVIEW_PROFILE"];
const DIRECT_OUTER_KEYS = [
  "REVIEW_AGENT",
  "REVIEW_DISPLAY_NAME",
  "REVIEW_MODEL",
  "REVIEW_PROVIDER",
  "REVIEW_VAULT_CREDENTIAL",
];

test("structured recipe settings contain only vetted outer-process fields", () => {
  for (const recipe of structuredForgejoRecipes) {
    const settings = buildStructuredForgejoSettings(recipe, recipe.promptResource);
    const expected = [
      ...COMMON_OUTER_KEYS,
      ...(recipe.env.REVIEW_PROFILE === undefined ? DIRECT_OUTER_KEYS : PROFILE_OUTER_KEYS),
    ].sort();
    assert.deepEqual(Object.keys(settings.env).sort(), expected, recipe.recipeId);
    assert.equal("PERPLEXITY_API_KEY" in settings.env, false, recipe.recipeId);
    assert.equal("FORGEJO_TOKEN" in settings.env, false, recipe.recipeId);
    assert.equal("REVIEW_API_BASE" in settings.env, false, recipe.recipeId);
  }
});

test("composed structured runner and axexec boundary remove ambient credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "axgithub-structured-env-"));
  try {
    const bin = join(directory, "bin");
    const contextPath = join(directory, "context.json");
    const outputPath = join(directory, "output.json");
    const childEnvironmentPath = join(directory, "child-environment.json");
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
const servicePrefixes = ["AXCREDS", "AXCREDROUTER", "AXSESSION", "AXSANDBOX", "AXVAULT", "AXRECIPE"];
const child = {};
for (const [key, value] of Object.entries(process.env)) {
  const upper = key.toUpperCase();
  const npmLaunchState = key.startsWith("npm_") || upper === "NODE" || upper === "NPM_EXEC_PATH" || upper === "NPM_CONFIG_USER_AGENT" || upper.startsWith("NPM_CONFIG_");
  const axCredential = upper.startsWith("AX_") && upper.endsWith("_CREDENTIALS");
  const axService = servicePrefixes.some((prefix) => upper === prefix || upper.startsWith(prefix + "_"));
  if (!npmLaunchState && !axCredential && !axService) child[key] = value;
}
fs.writeFileSync(process.env.TEST_CHILD_ENV_PATH, JSON.stringify(child));
fs.writeFileSync(process.env.REVIEW_OUTPUT_PATH, JSON.stringify({ body: "No issues found.", comments: [] }));
`,
      { mode: 0o700 },
    );
    writeFileSync(axinstallPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(axrunPath, 0o700);
    chmodSync(axinstallPath, 0o700);
    writeFileSync(contextPath, "{}\n", { mode: 0o600 });

    const recipe = structuredForgejoRecipes[0];
    assert.ok(recipe);
    const settings = buildStructuredForgejoSettings(recipe, recipe.promptResource);
    const canary = "ambient-secret-canary";
    const result = runShell(settings.args[1], {
      ...process.env,
      ...settings.env,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      REVIEW_CONTEXT_PATH: contextPath,
      REVIEW_OUTPUT_PATH: outputPath,
      TEST_CHILD_ENV_PATH: childEnvironmentPath,
      FORGEJO_TOKEN: canary,
      REVIEW_API_BASE: canary,
      PERPLEXITY_API_KEY: canary,
      ACTIONS_ID_TOKEN_REQUEST_URL: canary,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: canary,
      ACTIONS_RUNTIME_TOKEN: canary,
      ACTIONS_RUNTIME_URL: canary,
      ACTIONS_CACHE_URL: canary,
      ACTIONS_RESULTS_URL: canary,
      NODE_AUTH_TOKEN: canary,
      NPM_TOKEN: canary,
      NPM_CONFIG_USERCONFIG: canary,
      COREPACK_NPM_TOKEN: canary,
      YARN_NPM_AUTH_TOKEN: canary,
      GITHUB_TOKEN: canary,
      GH_TOKEN: canary,
      COPILOT_GITHUB_TOKEN: canary,
      CI_JOB_TOKEN: canary,
      SSH_AUTH_SOCK: canary,
      AXRECIPE_API_KEY: canary,
      AX_OPENAI_CREDENTIALS: canary,
      npm_execpath: canary,
      npm_config_user_agent: canary,
      npm_config__authToken: canary,
    });
    assert.equal(result.status, 0, result.stderr);

    const child = JSON.parse(readFileSync(childEnvironmentPath, "utf8")) as Record<
      string,
      string
    >;
    assert.equal(Object.values(child).includes(canary), false);
    for (const key of Object.keys(child)) {
      assert.doesNotMatch(key, /^(?:FORGEJO_|PERPLEXITY_|AX(?:_|CREDS|CREDROUTER|SESSION|SANDBOX|VAULT|RECIPE)|ACTIONS_(?:ID_TOKEN|RUNTIME|CACHE|RESULTS)|NODE_AUTH_TOKEN|NPM_TOKEN|NPM_CONFIG_|COREPACK_NPM_TOKEN|YARN_NPM_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|COPILOT_GITHUB_TOKEN|CI_JOB_TOKEN|SSH_AUTH_SOCK)/iu);
    }
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
