set -eu
if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
cat > /tmp/axkit.npmrc <<NPMRC
registry=https://npm.j4k.dev/
//npm.j4k.dev/:_authToken=${NODE_AUTH_TOKEN}
NPMRC
export NPM_CONFIG_USERCONFIG=/tmp/axkit.npmrc
export NPM_CONFIG_REGISTRY=https://npm.j4k.dev/
fi
if [ -n "${REVIEW_PROFILE:-}" ]; then
  # Exit 1 = all lanes exhausted (the intended red check); set -e fails the job here.
  npm exec --yes --package=axrun@latest -- \
    axrun resolve --profile "$REVIEW_PROFILE" --json > /tmp/axrun-resolve.json
  cat > /tmp/parse-resolve.cjs <<'PARSE_RESOLVE'
const fs = require("fs");
// npm exec can print banners around the payload; keep the last line that parses as a JSON object.
let resolved;
for (const line of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) continue;
  try {
    const value = JSON.parse(trimmed);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) resolved = value;
  } catch {}
}
if (!resolved || resolved.available !== true) {
  console.error("axrun resolve output contained no usable resolve response");
  process.exit(1);
}
const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
const assignments = {
  REVIEW_AGENT: resolved.agentId,
  REVIEW_MODEL: resolved.model || "",
  REVIEW_VAULT_CREDENTIAL: resolved.credentialName,
  REVIEW_DISPLAY_NAME: resolved.displayName || resolved.agentId,
  REVIEW_REASONING_EFFORT: resolved.reasoningEffort || "",
};
for (const [name, value] of Object.entries(assignments)) {
  process.stdout.write(name + "=" + shellQuote(value) + "\n");
}
PARSE_RESOLVE
  resolve_exports="$(node /tmp/parse-resolve.cjs /tmp/axrun-resolve.json)"
  eval "$resolve_exports"
  export REVIEW_AGENT REVIEW_MODEL REVIEW_VAULT_CREDENTIAL REVIEW_DISPLAY_NAME REVIEW_REASONING_EFFORT
fi
if [ "$REVIEW_AGENT" = "cursor" ]; then
  npm exec --yes --package=axinstall@latest -- axinstall "$REVIEW_AGENT"
else
  npm exec --yes --package=axinstall@latest -- axinstall "$REVIEW_AGENT" --with npm
fi
if [ "$REVIEW_AGENT" = "cursor" ]; then
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
  esac
  case ":$PATH:" in
    *":$HOME/.cursor/bin:"*) ;;
    *) export PATH="$HOME/.cursor/bin:$PATH" ;;
  esac
  cursor_agent_path="$(command -v agent || true)"
  if [ -n "$cursor_agent_path" ]; then
    export AXEXEC_CURSOR_PATH="$cursor_agent_path"
  fi
fi
if [ "$REVIEW_AGENT" = "opencode" ]; then
  opencode_path="$(command -v opencode || true)"
  npm_global_bin="$(npm prefix -g)/bin"
  if [ -z "$opencode_path" ] && [ -x "$npm_global_bin/opencode" ]; then
    export PATH="$npm_global_bin:$PATH"
    opencode_path="$npm_global_bin/opencode"
  fi
  if [ -n "$opencode_path" ]; then
    export AXEXEC_OPENCODE_PATH="$opencode_path"
  fi
fi
npm_global_bin="$(npm prefix -g)/bin"
case ":$PATH:" in
  *":$npm_global_bin:"*) ;;
  *) export PATH="$npm_global_bin:$PATH" ;;
esac
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
printf '%s
' "$PROMPT_TEXT" > /tmp/prompt.md
cat > /tmp/substitute-prompt.cjs <<'SUBSTITUTE'
const fs = require("fs");
const file = process.argv[2];
// split/join replaces every occurrence; sed breaks on | & \ and newlines, awk gsub on & and \.
let text = fs.readFileSync(file, "utf8");
for (const name of ["REVIEW_REPOSITORY", "REVIEW_PR_NUMBER", "REVIEW_DISPLAY_NAME", "REVIEW_MODEL"]) {
  text = text.split("__" + name + "__").join(process.env[name] || "");
}
fs.writeFileSync(file, text);
SUBSTITUTE
node /tmp/substitute-prompt.cjs /tmp/prompt.md
provider_args=""
if [ -n "${REVIEW_PROVIDER:-}" ]; then
  provider_args="--provider $REVIEW_PROVIDER"
fi
model_args=""
if [ -n "${REVIEW_PROFILE:-}" ]; then
  # A profile lane may omit the model; only pass the flag when resolved.
  if [ -n "$REVIEW_MODEL" ]; then
    model_args="--model $REVIEW_MODEL"
  fi
else
  model_args="--model $REVIEW_MODEL"
fi
effort_args=""
if [ -n "${REVIEW_REASONING_EFFORT:-}" ]; then
  effort_args="--reasoning-effort $REVIEW_REASONING_EFFORT"
fi
npm exec --yes --package=axrun@latest -- \
axrun --agent "$REVIEW_AGENT" \
$provider_args \
$model_args \
$effort_args \
--vault-credential "$REVIEW_VAULT_CREDENTIAL" \
--allow "$AXRUN_ALLOW" \
--prompt "$(cat /tmp/prompt.md)"
