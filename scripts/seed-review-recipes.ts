/**
 * Idempotently seed the PR-review recipe sets (GitHub + Forgejo) onto an
 * axrecipe server.
 *
 * Recipes and their prompt resources otherwise live only in the server
 * database (edited via axconsole). This script makes both sets reproducible
 * from version control: the canonical runner/validator sources in
 * review-recipes/ and the prompts in review-prompts/ are the source of truth.
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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = (process.env.AXRECIPE_URL ?? "https://recipe.axkit.dev").replace(/\/$/u, "");
const apiKey = process.env.AXRECIPE_API_KEY;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const runner = readFileSync(join(repoRoot, "review-recipes", "review-runner.sh"), "utf8");
const structuredOutputValidator = readFileSync(
  join(repoRoot, "review-recipes", "validate-forgejo-review-output.js"),
  "utf8",
);

function readPrompt(file: string): string {
  return readFileSync(join(repoRoot, "review-prompts", file), "utf8");
}

const GITHUB_CODE_PROMPT_RESOURCE = "pr-review-code-github-prompt";
const GITHUB_APPROACH_PROMPT_RESOURCE = "pr-review-approach-github-prompt";
const FORGEJO_CODE_PROMPT_RESOURCE = "pr-review-code-forgejo-prompt";
const FORGEJO_APPROACH_PROMPT_RESOURCE = "pr-review-approach-forgejo-prompt";
const STRUCTURED_FORGEJO_APPROACH_SMART_1_PROMPT_RESOURCE =
  "forgejo-review-approach-smart-1-prompt";
const STRUCTURED_FORGEJO_APPROACH_SMART_2_PROMPT_RESOURCE =
  "forgejo-review-approach-smart-2-prompt";
const STRUCTURED_FORGEJO_APPROACH_3_PROMPT_RESOURCE = "forgejo-review-approach-3-prompt";
const STRUCTURED_FORGEJO_CODE_SMART_1_PROMPT_RESOURCE = "forgejo-review-code-smart-1-prompt";
const STRUCTURED_FORGEJO_CODE_SMART_2_PROMPT_RESOURCE = "forgejo-review-code-smart-2-prompt";

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
    resourceId: STRUCTURED_FORGEJO_APPROACH_SMART_1_PROMPT_RESOURCE,
    name: "Structured Forgejo approach review prompt (smart draw 1)",
    description: "Credential-free structured handoff prompt for Forgejo approach smart draw 1.",
    content: readPrompt("forgejo-structured-approach-review-prompt.md"),
  },
  {
    resourceId: STRUCTURED_FORGEJO_APPROACH_SMART_2_PROMPT_RESOURCE,
    name: "Structured Forgejo approach review prompt (smart draw 2)",
    description: "Credential-free structured handoff prompt for Forgejo approach smart draw 2.",
    content: readPrompt("forgejo-structured-approach-review-prompt.md"),
  },
  {
    resourceId: STRUCTURED_FORGEJO_APPROACH_3_PROMPT_RESOURCE,
    name: "Structured Forgejo approach review prompt (approach 3)",
    description: "Credential-free structured handoff prompt for Forgejo approach 3.",
    content: readPrompt("forgejo-structured-approach-review-prompt.md"),
  },
  {
    resourceId: STRUCTURED_FORGEJO_CODE_SMART_1_PROMPT_RESOURCE,
    name: "Structured Forgejo code review prompt (smart draw 1)",
    description: "Credential-free structured handoff prompt for Forgejo code smart draw 1.",
    content: readPrompt("forgejo-structured-code-review-prompt.md"),
  },
  {
    resourceId: STRUCTURED_FORGEJO_CODE_SMART_2_PROMPT_RESOURCE,
    name: "Structured Forgejo code review prompt (smart draw 2)",
    description: "Credential-free structured handoff prompt for Forgejo code smart draw 2.",
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
    promptResource: STRUCTURED_FORGEJO_APPROACH_SMART_1_PROMPT_RESOURCE,
  },
  {
    recipeId: "forgejo-review-approach-smart-2",
    name: "Structured Forgejo approach review (smart draw 2)",
    env: { ...SMART_ENV },
    promptResource: STRUCTURED_FORGEJO_APPROACH_SMART_2_PROMPT_RESOURCE,
  },
  {
    recipeId: "forgejo-review-approach-3",
    name: "Structured Forgejo approach review (approach 3)",
    env: {
      REVIEW_AGENT: "opencode",
      REVIEW_MODEL: "GLM-5.2",
      REVIEW_DISPLAY_NAME: "Approach Review 3 (OpenCode Wafer)",
      REVIEW_VAULT_CREDENTIAL: "ci-opencode-wafer-credentials",
      REVIEW_PROVIDER: "wafer.ai",
    },
    promptResource: STRUCTURED_FORGEJO_APPROACH_3_PROMPT_RESOURCE,
  },
  {
    recipeId: "forgejo-review-code-smart-1",
    name: "Structured Forgejo code review (smart draw 1)",
    env: { ...SMART_ENV },
    promptResource: STRUCTURED_FORGEJO_CODE_SMART_1_PROMPT_RESOURCE,
  },
  {
    recipeId: "forgejo-review-code-smart-2",
    name: "Structured Forgejo code review (smart draw 2)",
    env: { ...SMART_ENV },
    promptResource: STRUCTURED_FORGEJO_CODE_SMART_2_PROMPT_RESOURCE,
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
  const ambientCredentialNames = [
    "FORGEJO_TOKEN",
    "REVIEW_API_BASE",
    "PERPLEXITY_API_KEY",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_RUNTIME_URL",
    "ACTIONS_CACHE_URL",
    "ACTIONS_RESULTS_URL",
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "NPM_CONFIG_USERCONFIG",
    "COREPACK_NPM_TOKEN",
    "YARN_NPM_AUTH_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "CI_JOB_TOKEN",
    "SSH_AUTH_SOCK",
  ] as const;
  const prelude = [
    "set -eu",
    "# The OIDC-authenticated axrecipe server creates both paths. They are the only",
    "# Forgejo-specific context exposed to the untrusted review agent; repository,",
    "# PR, head SHA, event, API endpoint, and posting credentials are deliberately absent.",
    "# Remove ambient workflow credentials before axrun. The trusted outer process keeps",
    "# only AXCREDS/AXCREDROUTER routing; axexec removes those AX* fields and npm-exec",
    "# state before it spawns the reviewer child.",
    `unset ${ambientCredentialNames.join(" ")}`,
    ': "${REVIEW_CONTEXT_PATH:?REVIEW_CONTEXT_PATH is required}"',
    ': "${REVIEW_OUTPUT_PATH:?REVIEW_OUTPUT_PATH is required}"',
    'case "$REVIEW_CONTEXT_PATH" in /*) ;; *) echo "REVIEW_CONTEXT_PATH must be absolute" >&2; exit 1 ;; esac',
    'case "$REVIEW_OUTPUT_PATH" in /*) ;; *) echo "REVIEW_OUTPUT_PATH must be absolute" >&2; exit 1 ;; esac',
    '[ -f "$REVIEW_CONTEXT_PATH" ] && [ ! -L "$REVIEW_CONTEXT_PATH" ] || {',
    '  echo "REVIEW_CONTEXT_PATH must be a regular, non-symlink file" >&2',
    "  exit 1",
    "}",
    'if [ ! -e "$REVIEW_OUTPUT_PATH" ]; then',
    "  :",
    'elif [ -f "$REVIEW_OUTPUT_PATH" ] && [ ! -L "$REVIEW_OUTPUT_PATH" ]; then',
    "  :",
    "else",
    '  echo "REVIEW_OUTPUT_PATH must be absent or a regular, non-symlink file" >&2',
    "  exit 1",
    "fi",
    "umask 077",
    ': > "$REVIEW_OUTPUT_PATH"',
  ].join("\n");
  return `${prelude}\n\n${runner}\n\nnode - "$REVIEW_OUTPUT_PATH" <<'FORGEJO_STRUCTURED_REVIEW_VALIDATOR'\n${structuredOutputValidator}\ntry {\n  validateForgejoReviewOutputFile(process.argv[2]);\n} catch (error) {\n  console.error(error instanceof Error ? error.message : String(error));\n  process.exit(1);\n}\nFORGEJO_STRUCTURED_REVIEW_VALIDATOR\n`;
}

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
  return { command: "sh", args: ["-c", buildStructuredForgejoRunner()], env };
}

const GITHUB_RECIPE_DESCRIPTION =
  "GitHub PR review slot. Posts via the GitHub Reviews API. Seeded from axgithub/scripts/seed-review-recipes.ts.";
const FORGEJO_RECIPE_DESCRIPTION =
  "Forgejo PR review slot. Posts via the Forgejo Reviews API. Seeded from axgithub/scripts/seed-review-recipes.ts.";
const STRUCTURED_FORGEJO_RECIPE_DESCRIPTION =
  "Credential-free Forgejo review slot. Produces a bounded JSON handoff; a trusted OIDC-bound poster validates current diff positions and posts it. Seeded from axgithub/scripts/seed-review-recipes.ts.";

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

export { buildStructuredForgejoSettings, structuredForgejoRecipes };
