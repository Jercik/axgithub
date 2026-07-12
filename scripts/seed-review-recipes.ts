/**
 * Idempotently seed the PR-review recipe sets (GitHub + Forgejo) onto an
 * axrecipe server.
 *
 * Recipes and their prompt resources otherwise live only in the server
 * database (edited via axconsole). This script makes both sets reproducible
 * from version control: the canonical runner shell script
 * (review-recipes/review-runner.sh) and the four prompts
 * (review-prompts/pr-review-*-prompt.md) are the source of truth.
 *
 * The runner is forge-agnostic; the entire forge coupling is in the prompt
 * resources — the GitHub prompts post via the GitHub Reviews API with gh,
 * the Forgejo prompts via the Forgejo Reviews API with curl. The workflow
 * supplies the forge token and PR coordinates (REVIEW_REPOSITORY,
 * REVIEW_PR_NUMBER, plus FORGEJO_TOKEN + REVIEW_API_BASE on Forgejo) in the
 * job env, which the spawned agent inherits.
 *
 *   AXRECIPE_API_KEY=<admin key> AXRECIPE_URL=https://recipe.axkit.dev \
 *     node scripts/seed-review-recipes.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = (process.env.AXRECIPE_URL ?? "https://recipe.axkit.dev").replace(/\/$/u, "");
const apiKey = process.env.AXRECIPE_API_KEY;
if (!apiKey) {
  console.error("AXRECIPE_API_KEY is required (admin/manage-scoped key).");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const runner = readFileSync(join(repoRoot, "review-recipes", "review-runner.sh"), "utf8");

function readPrompt(file: string): string {
  return readFileSync(join(repoRoot, "review-prompts", file), "utf8");
}

const GITHUB_CODE_PROMPT_RESOURCE = "pr-review-code-github-prompt";
const GITHUB_APPROACH_PROMPT_RESOURCE = "pr-review-approach-github-prompt";
const FORGEJO_CODE_PROMPT_RESOURCE = "pr-review-code-forgejo-prompt";
const FORGEJO_APPROACH_PROMPT_RESOURCE = "pr-review-approach-forgejo-prompt";

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
// secrets baked into env. Smart recipes carry no agent/model/credential:
// axrun resolves the lane per run through axcredrouter (profile mode needs
// both AXCREDROUTER to resolve and AXCREDS to fetch the resolved credential).
const AXCREDS = "{{vault:ci-axcreds-config}}";
const AXCREDROUTER = "{{vault:ci-axcredrouter-config}}";
const PERPLEXITY = "{{vault:ci-perplexity-api-key}}";
const ALLOW = "read,write,glob,grep,bash:*";

const SMART_ENV: Record<string, string> = {
  REVIEW_PROFILE: "smart-pr-review",
  AXCREDROUTER,
};

const githubCodeRecipes: Recipe[] = [
  {
    recipeId: "pr-review-code-smart",
    name: "PR code review (smart)",
    env: { ...SMART_ENV },
  },
];

const githubApproachRecipes: Recipe[] = [
  {
    recipeId: "pr-review-approach-smart",
    name: "PR approach review (smart)",
    env: { ...SMART_ENV },
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
];

const forgejoApproachRecipes: Recipe[] = [
  {
    recipeId: "pr-review-approach-forgejo-smart",
    name: "PR approach review (smart, Forgejo)",
    env: { ...SMART_ENV },
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

const GITHUB_RECIPE_DESCRIPTION =
  "GitHub PR review slot. Posts via the GitHub Reviews API. Seeded from axgithub/scripts/seed-review-recipes.ts.";
const FORGEJO_RECIPE_DESCRIPTION =
  "Forgejo PR review slot. Posts via the Forgejo Reviews API. Seeded from axgithub/scripts/seed-review-recipes.ts.";

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

const stale = await listStaleRecipes(staleRecipeIds);
if (stale.length > 0) {
  console.log(`stale, descope + prune manually: ${stale.join(", ")}`);
}

console.log("Done.");
