/**
 * Idempotently seed the PR-review recipe sets (GitHub + Forgejo) onto an
 * axrecipe server.
 *
 * Recipes and their prompt resources otherwise live only in the server
 * database (edited via axconsole). This script makes both sets reproducible
 * from version control: the canonical runner sources in review-recipes/ and
 * the prompts in review-prompts/ are the source of truth.
 *
 * Legacy recipes keep their direct-post prompts for the GitHub and Forgejo
 * workflows that still use them. The new Forgejo structured recipes are
 * deliberately separate: an untrusted LLM can only read a trusted, nonsecret
 * context file and write a strictly bounded JSON handoff. A trusted poster
 * later binds that handoff to its authenticated PR/head/slot and posts it.
 *
 *   AXRECIPE_API_KEY=<admin key> AXRECIPE_URL=https://recipe.axkit.dev \
 *     node scripts/seed-review-recipes.ts
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = (process.env.AXRECIPE_URL ?? "https://recipe.axkit.dev").replace(/\/$/u, "");
const apiKey = process.env.AXRECIPE_API_KEY;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const runner = readFileSync(join(repoRoot, "review-recipes", "review-runner.sh"), "utf8");
const structuredRunnerTemplate = readFileSync(
  join(repoRoot, "review-recipes", "structured-forgejo-runner.sh"),
  "utf8",
);

function readPrompt(file: string): string {
  return readFileSync(join(repoRoot, "review-prompts", file), "utf8");
}

const GITHUB_CODE_PROMPT_RESOURCE = "pr-review-code-github-prompt";
const GITHUB_APPROACH_PROMPT_RESOURCE = "pr-review-approach-github-prompt";
const FORGEJO_CODE_PROMPT_RESOURCE = "pr-review-code-forgejo-prompt";
const FORGEJO_APPROACH_PROMPT_RESOURCE = "pr-review-approach-forgejo-prompt";
const STRUCTURED_FORGEJO_APPROACH_PROMPT_RESOURCE = "forgejo-review-approach-v1-prompt";
const STRUCTURED_FORGEJO_CODE_PROMPT_RESOURCE = "forgejo-review-code-v1-prompt";

interface Resource {
  resourceId: string;
  name: string;
  description: string;
  content: string;
}

const resources: Resource[] = [
  {
    resourceId: GITHUB_CODE_PROMPT_RESOURCE,
    name: "PR code review prompt (GitHub)",
    description: "GitHub-shaped code review prompt; posts via the GitHub Reviews API with gh.",
    content: readPrompt("pr-review-code-prompt.md"),
  },
  {
    resourceId: GITHUB_APPROACH_PROMPT_RESOURCE,
    name: "PR approach review prompt (GitHub)",
    description:
      "GitHub-shaped approach review prompt; posts via the GitHub Reviews API with gh.",
    content: readPrompt("pr-review-approach-prompt.md"),
  },
  {
    resourceId: STRUCTURED_FORGEJO_APPROACH_PROMPT_RESOURCE,
    name: "Structured Forgejo approach review prompt v1",
    description: "Version 1 credential-free structured handoff prompt for Forgejo approach slots.",
    content: readPrompt("forgejo-structured-approach-review-prompt.md"),
  },
  {
    resourceId: STRUCTURED_FORGEJO_CODE_PROMPT_RESOURCE,
    name: "Structured Forgejo code review prompt v1",
    description: "Version 1 credential-free structured handoff prompt for Forgejo code slots.",
    content: readPrompt("forgejo-structured-code-review-prompt.md"),
  },
];

// Rollout-only compatibility set. Once every Forgejo workflow uses the OIDC
// structured slots, delete this array and seedLegacyForgejoDirectPostRecipes,
// then remove these recipe IDs from the cluster-managed execute-key scope.
// Keeping the legacy set physically separate makes the hard cutover a deletion,
// not a permanent flag or fallback.
const legacyForgejoDirectPostResources: Resource[] = [
  {
    resourceId: FORGEJO_CODE_PROMPT_RESOURCE,
    name: "PR code review prompt (Forgejo)",
    description: "Forgejo-shaped code review prompt; posts via the Forgejo Reviews API with curl.",
    content: readPrompt("pr-review-code-forgejo-prompt.md"),
  },
  {
    resourceId: FORGEJO_APPROACH_PROMPT_RESOURCE,
    name: "PR approach review prompt (Forgejo)",
    description:
      "Forgejo-shaped approach review prompt; posts via the Forgejo Reviews API with curl.",
    content: readPrompt("pr-review-approach-forgejo-prompt.md"),
  },
];

interface Recipe {
  recipeId: string;
  name: string;
  env: Record<string, string>;
}

// The clean token forms ({{vault:...}} / {{resource:...}}) — never plaintext
// secrets baked into env. Profile recipes (smart, fable) carry no
// agent/model/credential: axrun resolves the lane per run through axcredrouter
// (profile mode needs both AXCREDROUTER to resolve and AXCREDS to fetch the
// resolved credential).
const AXCREDS = "{{vault:ci-axcreds-config}}";
const AXCREDROUTER = "{{vault:ci-axcredrouter-config}}";
const PERPLEXITY = "{{vault:ci-perplexity-api-key}}";
const ALLOW = "read,glob,grep,bash:*";

const SMART_ENV: Record<string, string> = {
  REVIEW_PROFILE: "smart-pr-review",
  AXCREDROUTER,
};

const FABLE_ENV: Record<string, string> = {
  REVIEW_PROFILE: "claude-fable-review",
  AXCREDROUTER,
};

const githubCodeRecipes: Recipe[] = [
  {
    recipeId: "pr-review-code-smart",
    name: "PR code review (smart)",
    env: { ...SMART_ENV },
  },
  {
    recipeId: "pr-review-code-fable",
    name: "PR code review (fable)",
    env: { ...FABLE_ENV },
  },
];

const githubApproachRecipes: Recipe[] = [
  {
    recipeId: "pr-review-approach-smart",
    name: "PR approach review (smart)",
    env: { ...SMART_ENV },
  },
  {
    recipeId: "pr-review-approach-fable",
    name: "PR approach review (fable)",
    env: { ...FABLE_ENV },
  },
  {
    recipeId: "pr-review-approach-2",
    name: "PR approach review 2",
    env: {
      REVIEW_AGENT: "gemini",
      REVIEW_MODEL: "gemini-3.1-pro-preview",
      REVIEW_DISPLAY_NAME: "Approach Review 2",
      REVIEW_VAULT_CREDENTIAL: "ci-gemini-api-key",
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    },
  },
  {
    recipeId: "pr-review-approach-3",
    name: "PR approach review 3",
    env: {
      REVIEW_AGENT: "opencode",
      REVIEW_MODEL: "GLM-5.2",
      REVIEW_DISPLAY_NAME: "Approach Review 3 (OpenCode Wafer)",
      REVIEW_VAULT_CREDENTIAL: "ci-opencode-wafer-credentials",
      REVIEW_PROVIDER: "wafer.ai",
    },
  },
];

const forgejoCodeRecipes: Recipe[] = [
  {
    recipeId: "pr-review-code-forgejo-smart",
    name: "PR code review (smart, Forgejo)",
    env: { ...SMART_ENV },
  },
  {
    recipeId: "pr-review-code-forgejo-fable",
    name: "PR code review (fable, Forgejo)",
    env: { ...FABLE_ENV },
  },
];

const forgejoApproachRecipes: Recipe[] = [
  {
    recipeId: "pr-review-approach-forgejo-smart",
    name: "PR approach review (smart, Forgejo)",
    env: { ...SMART_ENV },
  },
  {
    recipeId: "pr-review-approach-forgejo-fable",
    name: "PR approach review (fable, Forgejo)",
    env: { ...FABLE_ENV },
  },
  {
    recipeId: "pr-review-approach-forgejo-2",
    name: "PR approach review 2 (Forgejo)",
    env: {
      REVIEW_AGENT: "gemini",
      REVIEW_MODEL: "gemini-3.1-pro-preview",
      REVIEW_DISPLAY_NAME: "Approach Review 2",
      REVIEW_VAULT_CREDENTIAL: "ci-gemini-api-key",
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    },
  },
  {
    recipeId: "pr-review-approach-forgejo-3",
    name: "PR approach review 3 (Forgejo)",
    env: {
      REVIEW_AGENT: "opencode",
      REVIEW_MODEL: "GLM-5.2",
      REVIEW_DISPLAY_NAME: "Approach Review 3 (OpenCode Wafer)",
      REVIEW_VAULT_CREDENTIAL: "ci-opencode-wafer-credentials",
      REVIEW_PROVIDER: "wafer.ai",
    },
  },
];

// Stable slot IDs are the shared vocabulary for the axkit OIDC binding,
// cluster policy, and j4k-align matrix. Never repurpose a slot for another
// reviewer: a run binding must always describe one deterministic review slot.
const structuredForgejoRecipes: Array<Recipe & { promptResource: string }> = [
  {
    recipeId: "forgejo-review-approach-smart-1",
    name: "Structured Forgejo approach review (smart draw 1)",
    env: { ...SMART_ENV },
    promptResource: STRUCTURED_FORGEJO_APPROACH_PROMPT_RESOURCE,
  },
  {
    recipeId: "forgejo-review-approach-smart-2",
    name: "Structured Forgejo approach review (smart draw 2)",
    env: { ...SMART_ENV },
    promptResource: STRUCTURED_FORGEJO_APPROACH_PROMPT_RESOURCE,
  },
  {
    recipeId: "forgejo-review-approach-3",
    name: "Structured Forgejo approach review (approach 3)",
    env: {
      REVIEW_AGENT: "opencode",
      REVIEW_MODEL: "GLM-5.2",
      REVIEW_DISPLAY_NAME: "Approach Review 3 (OpenCode Wafer)",
      REVIEW_VAULT_CREDENTIAL: "ci-opencode-wafer-credentials",
    },
    promptResource: STRUCTURED_FORGEJO_APPROACH_PROMPT_RESOURCE,
  },
  {
    recipeId: "forgejo-review-code-smart-1",
    name: "Structured Forgejo code review (smart draw 1)",
    env: { ...SMART_ENV },
    promptResource: STRUCTURED_FORGEJO_CODE_PROMPT_RESOURCE,
  },
  {
    recipeId: "forgejo-review-code-smart-2",
    name: "Structured Forgejo code review (smart draw 2)",
    env: { ...SMART_ENV },
    promptResource: STRUCTURED_FORGEJO_CODE_PROMPT_RESOURCE,
  },
];

// Replaced by the smart set. DELETE /recipes/:id responds 409 when runs
// exist, so the seeder never deletes — it reports which of these are still
// live so an operator can descope the execute keys and prune manually.
const staleRecipeIds = [
  "pr-review-code-1",
  "pr-review-code-2",
  "pr-review-approach-1",
  "pr-review-approach-4",
  "pr-review-code-forgejo-1",
  "pr-review-code-forgejo-2",
  "pr-review-approach-forgejo-1",
  "pr-review-approach-forgejo-4",
];

function buildSettings(recipe: Recipe, promptResource: string, withPerplexity: boolean) {
  const env: Record<string, string> = {
    AXRUN_ALLOW: ALLOW,
    ...recipe.env,
    PROMPT_TEXT: `{{resource:${promptResource}}}`,
    AXCREDS,
    ...(withPerplexity ? { PERPLEXITY_API_KEY: PERPLEXITY } : {}),
  };
  // Non-login shell: Debian /etc/profile resets PATH in `sh -l`, hiding the workflow's pre-fetched bins.
  return { command: "sh", args: ["-c", runner], env };
}

function buildStructuredForgejoRunner(): string {
  const replaceExactlyOnce = (source: string, expected: string, replacement: string): string => {
    if (source.split(expected).length !== 2) {
      throw new Error(`structured review runner expected exactly one ${JSON.stringify(expected)}`);
    }
    return source.replace(expected, () => replacement);
  };
  const profileResolve =
    'if [ -n "${REVIEW_PROFILE:-}" ]; then\n' +
    "  # Exit 1 = all lanes exhausted (the intended red check); set -e fails the job here.";
  const legacyAxrun = `run_axrun() {
  if command -v axrun >/dev/null 2>&1; then
    axrun "$@"
    return
  fi
  if [ -n "\${GITHUB_ACTIONS:-}" ]; then
    require_prefetched axrun @j4k/axrun@2.12.0
  fi
  npm exec --yes --package=@j4k/axrun@2.12.0 -- axrun "$@"
}`;
  const legacyAxinstall = `run_axinstall() {
  if command -v axinstall >/dev/null 2>&1; then
    axinstall "$@"
    return
  fi
  if [ -n "\${GITHUB_ACTIONS:-}" ]; then
    require_prefetched axinstall @j4k/axinstall@3.0.7
  fi
  npm exec --yes --package=@j4k/axinstall@3.0.7 -- axinstall "$@"
}`;
  const structuredAxinstall = `run_axinstall() { :; }`;
  const legacyProvider = `provider_args=""
if [ -n "\${REVIEW_PROVIDER:-}" ]; then
  provider_args="--provider $REVIEW_PROVIDER"
fi`;
  const legacyInvocation = `run_axrun --agent "$REVIEW_AGENT" \\
$provider_args \\
$model_args \\
$effort_args \\
--vault-credential "$REVIEW_VAULT_CREDENTIAL" \\
--allow "$AXRUN_ALLOW" \\
--prompt "$(cat /tmp/prompt.md)"`;
  // Axrun v5 binds the provider to the exported agent credential descriptor.
  // Structured recipes must not forward the legacy REVIEW_PROVIDER variable.
  const preparationInvocation = `node - "$AXRUN_PREPARED_STATE" "$TMPDIR/prompt.md" <<'WRITE_STRUCTURED_REVIEW_STATE'
const fs = require("node:fs");
const [output, promptPath] = process.argv.slice(2);
const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\\\''") + "'";
for (const [environmentName, marker, realName] of [
  ["AXEXEC_CLAUDE_PATH", "__AXGITHUB_CLAUDE_REAL__", "claude-real"],
  ["AXEXEC_CODEX_PATH", "__AXGITHUB_CODEX_REAL__", "codex-real"],
]) {
  const wrapper = process.env[environmentName];
  if (!wrapper) continue;
  const source = fs.readFileSync(wrapper, "utf8");
  const target = shellQuote(String(process.env.TMPDIR) + "/axreview-bin/" + realName);
  if (source.split(marker).length !== 2) throw new Error("expected exactly one " + marker);
  fs.writeFileSync(wrapper, source.replace(marker, () => target), "utf8");
}
const state = { PATH: process.env.PATH, PROMPT: fs.readFileSync(promptPath, "utf8") };
for (const name of ["AXEXEC_CLAUDE_PATH", "AXEXEC_CODEX_PATH", "AXEXEC_CURSOR_PATH", "AXEXEC_OPENCODE_PATH"]) {
  if (process.env[name]) state[name] = process.env[name];
}
fs.writeFileSync(output, JSON.stringify(state), { encoding: "utf8", flag: "wx", mode: 0o600 });
WRITE_STRUCTURED_REVIEW_STATE`;
  const withoutLegacyTools = replaceExactlyOnce(
    replaceExactlyOnce(runner, legacyAxrun, ""),
    legacyAxinstall,
    structuredAxinstall,
  );
  const withoutLegacyRouting = replaceExactlyOnce(
    replaceExactlyOnce(
      withoutLegacyTools,
      profileResolve,
      "if false; then\n  # Profile resolution completed before the clean boundary.",
    ),
    legacyProvider,
    "# Provider routing is bound into the axrun v5 credential handoff.",
  );
  const preparedGenericRunner = replaceExactlyOnce(
    withoutLegacyRouting,
    legacyInvocation,
    preparationInvocation,
  );
  const withWrapperMarkers = replaceExactlyOnce(
    replaceExactlyOnce(
      preparedGenericRunner,
      "exec /tmp/axreview-bin/claude-real",
      "exec __AXGITHUB_CLAUDE_REAL__",
    ),
    "exec /tmp/axreview-bin/codex-real",
    "exec __AXGITHUB_CODEX_REAL__",
  );
  const expectedTemporaryPathCount = 10;
  const temporaryPathCount = withWrapperMarkers.match(/\/tmp\//gu)?.length ?? 0;
  if (temporaryPathCount !== expectedTemporaryPathCount) {
    throw new Error(
      `structured review runner expected ${expectedTemporaryPathCount} temporary paths, found ${temporaryPathCount}`,
    );
  }
  const tempScopedRunner = withWrapperMarkers.replace(/\/tmp\//gu, () => "$TMPDIR/");
  const structuredGenericRunner = replaceExactlyOnce(
    replaceExactlyOnce(
      replaceExactlyOnce(
        tempScopedRunner,
        '> $TMPDIR/prompt.md',
        '> "$TMPDIR/prompt.md"',
      ),
      "cat > $TMPDIR/substitute-prompt.cjs",
      'cat > "$TMPDIR/substitute-prompt.cjs"',
    ),
    "node $TMPDIR/substitute-prompt.cjs $TMPDIR/prompt.md",
    'node "$TMPDIR/substitute-prompt.cjs" "$TMPDIR/prompt.md"',
  );
  const marker = "__AXGITHUB_GENERIC_REVIEW_RUNNER__";
  if (structuredRunnerTemplate.split(marker).length !== 2) {
    throw new Error(`structured-forgejo-runner.sh must contain exactly one ${marker} marker`);
  }
  const delimiter = "AXGITHUB_GENERIC_REVIEW_RUNNER";
  if (new RegExp(`^${delimiter}$`, "mu").test(structuredGenericRunner)) {
    throw new Error(`structured generic runner must not contain the ${delimiter} delimiter`);
  }
  return structuredRunnerTemplate.replace(marker, () => structuredGenericRunner);
}

const structuredForgejoRunner = buildStructuredForgejoRunner();

function buildStructuredForgejoSettings(
  recipe: Recipe,
  promptResource: string,
) {
  const env: Record<string, string> = {
    AXRUN_ALLOW: ALLOW,
    ...recipe.env,
    PROMPT_TEXT: `{{resource:${promptResource}}}`,
    AXCREDS,
  };
  return { command: "sh", args: ["-c", structuredForgejoRunner], env };
}

const GITHUB_RECIPE_DESCRIPTION =
  "GitHub PR review slot. Posts via the GitHub Reviews API. Seeded from axgithub/scripts/seed-review-recipes.ts.";
const FORGEJO_RECIPE_DESCRIPTION =
  "Forgejo PR review slot. Posts via the Forgejo Reviews API. Seeded from axgithub/scripts/seed-review-recipes.ts.";
const STRUCTURED_FORGEJO_RECIPE_DESCRIPTION =
  "Isolated Forgejo review generator. Produces a versioned JSON handoff for axrecipe v9 validation; a separate trusted job posts it. Seeded from axgithub/scripts/seed-review-recipes.ts.";

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function upsertResource(r: Resource): Promise<void> {
  const get = await api("GET", `/api/v1/resources/${encodeURIComponent(r.resourceId)}`);
  if (get.status === 404) {
    const res = await api("POST", "/api/v1/resources", {
      resourceId: r.resourceId,
      name: r.name,
      description: r.description,
      content: r.content,
    });
    if (!res.ok) throw new Error(`create resource ${r.resourceId}: ${res.status} ${await res.text()}`);
    console.log(`resource ${r.resourceId}: created`);
    return;
  }
  if (!get.ok) throw new Error(`get resource ${r.resourceId}: ${get.status} ${await get.text()}`);
  const current = (await get.json()) as { currentRevision: { content: string } };
  if (current.currentRevision.content === r.content) {
    console.log(`resource ${r.resourceId}: unchanged`);
    return;
  }
  const res = await api("PUT", `/api/v1/resources/${encodeURIComponent(r.resourceId)}`, {
    name: r.name,
    description: r.description,
    content: r.content,
    changeNote: "Sync review prompt from axgithub source.",
  });
  if (!res.ok) throw new Error(`update resource ${r.resourceId}: ${res.status} ${await res.text()}`);
  console.log(`resource ${r.resourceId}: updated`);
}

interface RecipeSettings {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function sameSettings(a: RecipeSettings, b: RecipeSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function upsertRecipe(
  recipeId: string,
  name: string,
  description: string,
  settings: RecipeSettings,
): Promise<void> {
  const get = await api("GET", `/api/v1/recipes/${encodeURIComponent(recipeId)}?raw=true`);
  if (get.status === 404) {
    const res = await api("POST", "/api/v1/recipes", {
      recipeId,
      name,
      description,
      settings,
    });
    if (!res.ok) throw new Error(`create recipe ${recipeId}: ${res.status} ${await res.text()}`);
    console.log(`recipe ${recipeId}: created`);
    return;
  }
  if (!get.ok) throw new Error(`get recipe ${recipeId}: ${get.status} ${await get.text()}`);
  const current = (await get.json()) as { currentRevision: { settings: RecipeSettings } };
  if (sameSettings(current.currentRevision.settings, settings)) {
    console.log(`recipe ${recipeId}: unchanged`);
    return;
  }
  const res = await api("PUT", `/api/v1/recipes/${encodeURIComponent(recipeId)}`, {
    name,
    description,
    settings,
    changeNote: "Sync review recipe from axgithub source.",
  });
  if (!res.ok) throw new Error(`update recipe ${recipeId}: ${res.status} ${await res.text()}`);
  console.log(`recipe ${recipeId}: updated`);
}

async function listStaleRecipes(ids: string[]): Promise<string[]> {
  const stale: string[] = [];
  for (const id of ids) {
    const get = await api("GET", `/api/v1/recipes/${encodeURIComponent(id)}`);
    if (get.status === 404) continue;
    if (!get.ok) throw new Error(`get recipe ${id}: ${get.status} ${await get.text()}`);
    stale.push(id);
  }
  return stale;
}

async function seedLegacyForgejoDirectPostRecipes(): Promise<void> {
  for (const resource of legacyForgejoDirectPostResources) {
    await upsertResource(resource);
  }
  for (const recipe of forgejoCodeRecipes) {
    await upsertRecipe(
      recipe.recipeId,
      recipe.name,
      FORGEJO_RECIPE_DESCRIPTION,
      buildSettings(recipe, FORGEJO_CODE_PROMPT_RESOURCE, true),
    );
  }
  for (const recipe of forgejoApproachRecipes) {
    await upsertRecipe(
      recipe.recipeId,
      recipe.name,
      FORGEJO_RECIPE_DESCRIPTION,
      buildSettings(recipe, FORGEJO_APPROACH_PROMPT_RESOURCE, false),
    );
  }
}

async function main(): Promise<void> {
  if (!apiKey) {
    console.error("AXRECIPE_API_KEY is required (admin/manage-scoped key).");
    process.exitCode = 1;
    return;
  }
  for (const r of resources) {
    await upsertResource(r);
  }
  for (const recipe of githubCodeRecipes) {
    await upsertRecipe(
      recipe.recipeId,
      recipe.name,
      GITHUB_RECIPE_DESCRIPTION,
      buildSettings(recipe, GITHUB_CODE_PROMPT_RESOURCE, true),
    );
  }
  for (const recipe of githubApproachRecipes) {
    await upsertRecipe(
      recipe.recipeId,
      recipe.name,
      GITHUB_RECIPE_DESCRIPTION,
      buildSettings(recipe, GITHUB_APPROACH_PROMPT_RESOURCE, false),
    );
  }
  // Temporary rollout bridge. Delete this call with its helper/data at the
  // OIDC cutover; the structured slots below are the only durable Forgejo set.
  await seedLegacyForgejoDirectPostRecipes();
  for (const recipe of structuredForgejoRecipes) {
    await upsertRecipe(
      recipe.recipeId,
      recipe.name,
      STRUCTURED_FORGEJO_RECIPE_DESCRIPTION,
      buildStructuredForgejoSettings(recipe, recipe.promptResource),
    );
  }

  const stale = await listStaleRecipes(staleRecipeIds);
  if (stale.length > 0) {
    console.log(`stale, descope + prune manually: ${stale.join(", ")}`);
  }

  console.log("Done.");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  await main();
}

export { buildStructuredForgejoSettings, structuredForgejoRecipes };
