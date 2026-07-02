/**
 * Idempotently seed the Forgejo PR-review recipe set onto an axrecipe server.
 *
 * Recipes and their prompt resources otherwise live only in the server
 * database (edited via axconsole). This script makes the Forgejo set
 * reproducible from version control: the canonical runner shell script
 * (review-recipes/review-runner.sh) and the two Forgejo prompts
 * (review-prompts/pr-review-*-forgejo-prompt.md) are the source of truth.
 *
 * The runner is forge-agnostic; the entire Forgejo coupling is in the prompt
 * resources, which post via the Forgejo Reviews API with curl. The workflow
 * supplies FORGEJO_TOKEN + REVIEW_API_BASE + REVIEW_REPOSITORY + REVIEW_PR_NUMBER
 * in the job env, which the spawned agent inherits.
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
const codePrompt = readFileSync(
  join(repoRoot, "review-prompts", "pr-review-code-forgejo-prompt.md"),
  "utf8",
);
const approachPrompt = readFileSync(
  join(repoRoot, "review-prompts", "pr-review-approach-forgejo-prompt.md"),
  "utf8",
);

const CODE_PROMPT_RESOURCE = "pr-review-code-forgejo-prompt";
const APPROACH_PROMPT_RESOURCE = "pr-review-approach-forgejo-prompt";

interface Resource {
  resourceId: string;
  name: string;
  description: string;
  content: string;
}

const resources: Resource[] = [
  {
    resourceId: CODE_PROMPT_RESOURCE,
    name: "PR code review prompt (Forgejo)",
    description: "Forgejo-shaped code review prompt; posts via the Forgejo Reviews API with curl.",
    content: codePrompt,
  },
  {
    resourceId: APPROACH_PROMPT_RESOURCE,
    name: "PR approach review prompt (Forgejo)",
    description:
      "Forgejo-shaped approach review prompt; posts via the Forgejo Reviews API with curl.",
    content: approachPrompt,
  },
];

interface Recipe {
  recipeId: string;
  name: string;
  env: Record<string, string>;
}

// The clean token forms ({{vault:...}} / {{resource:...}}) — never plaintext
// secrets baked into env. The agent/model/credential matrix mirrors the GitHub
// recipe set so the Forgejo reviews are equivalent.
const AXCREDS = "{{vault:ci-axcreds-config}}";
const PERPLEXITY = "{{vault:ci-perplexity-api-key}}";
const ALLOW = "read,write,glob,grep,bash:*";

const codeRecipes: Recipe[] = [
  {
    recipeId: "pr-review-code-forgejo-1",
    name: "PR code review 1 (Forgejo)",
    env: {
      REVIEW_AGENT: "codex",
      REVIEW_MODEL: "gpt-5.5",
      REVIEW_DISPLAY_NAME: "Code Review 1",
      REVIEW_VAULT_CREDENTIAL: "ci-codex-oauth-credentials",
    },
  },
  {
    recipeId: "pr-review-code-forgejo-2",
    name: "PR code review 2 (Forgejo)",
    env: {
      REVIEW_AGENT: "claude",
      REVIEW_MODEL: "opus",
      REVIEW_DISPLAY_NAME: "Code Review 2 (Claude Code Opus)",
      REVIEW_VAULT_CREDENTIAL: "ci-claude-claude3-oauth-credentials",
    },
  },
];

const approachRecipes: Recipe[] = [
  {
    recipeId: "pr-review-approach-forgejo-1",
    name: "PR approach review 1 (Forgejo)",
    env: {
      REVIEW_AGENT: "claude",
      REVIEW_MODEL: "opus",
      REVIEW_DISPLAY_NAME: "Approach Review 1 (Claude Code Opus)",
      REVIEW_VAULT_CREDENTIAL: "ci-claude-claude3-oauth-credentials",
    },
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
  {
    recipeId: "pr-review-approach-forgejo-4",
    name: "PR approach review 4 (Forgejo)",
    env: {
      REVIEW_AGENT: "codex",
      REVIEW_MODEL: "gpt-5.5",
      REVIEW_DISPLAY_NAME: "Approach Review 4",
      REVIEW_VAULT_CREDENTIAL: "ci-codex-oauth-credentials",
    },
  },
];

function buildSettings(recipe: Recipe, promptResource: string, withPerplexity: boolean) {
  const env: Record<string, string> = {
    AXRUN_ALLOW: ALLOW,
    ...recipe.env,
    PROMPT_TEXT: `{{resource:${promptResource}}}`,
    AXCREDS,
    ...(withPerplexity ? { PERPLEXITY_API_KEY: PERPLEXITY } : {}),
  };
  return { command: "sh", args: ["-lc", runner], env };
}

const RECIPE_DESCRIPTION =
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
    changeNote: "Sync Forgejo review prompt from axgithub source.",
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
  settings: RecipeSettings,
): Promise<void> {
  const get = await api("GET", `/api/v1/recipes/${encodeURIComponent(recipeId)}?raw=true`);
  if (get.status === 404) {
    const res = await api("POST", "/api/v1/recipes", {
      recipeId,
      name,
      description: RECIPE_DESCRIPTION,
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
    description: RECIPE_DESCRIPTION,
    settings,
    changeNote: "Sync Forgejo review recipe from axgithub source.",
  });
  if (!res.ok) throw new Error(`update recipe ${recipeId}: ${res.status} ${await res.text()}`);
  console.log(`recipe ${recipeId}: updated`);
}

for (const r of resources) {
  await upsertResource(r);
}
for (const recipe of codeRecipes) {
  await upsertRecipe(recipe.recipeId, recipe.name, buildSettings(recipe, CODE_PROMPT_RESOURCE, true));
}
for (const recipe of approachRecipes) {
  await upsertRecipe(
    recipe.recipeId,
    recipe.name,
    buildSettings(recipe, APPROACH_PROMPT_RESOURCE, false),
  );
}

console.log("Done.");
