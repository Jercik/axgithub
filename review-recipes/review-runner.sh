set -eu
# No registry auth exists when this recipe runs, by design: both forges'
# pr-review workflows fetch @j4k tooling into a trusted prefix, then strip the
# credential (rm -f ~/.npmrc; the Forge also blanks its OIDC request vars)
# before axrecipe touches attacker-controlled PR content, since any credential
# reachable from this process tree is exfiltratable by prompt injection. The
# private tools therefore must arrive pre-fetched on PATH; in CI a missing bin
# is a workflow bug, and falling through to npm exec there would resolve the
# @j4k scope against the public default registry (a squat target). The npm
# exec fallback serves local runs where the operator's npm config maps @j4k.
require_prefetched() {
  echo "$1 not on PATH: the workflow must pre-fetch $2 into the trusted review-tools prefix (no registry auth exists after the credential strip)" >&2
  exit 1
}
run_axrun() {
  if command -v axrun >/dev/null 2>&1; then
    axrun "$@"
    return
  fi
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    require_prefetched axrun @j4k/axrun@2.12.0
  fi
  npm exec --yes --package=@j4k/axrun@2.12.0 -- axrun "$@"
}
run_axinstall() {
  if command -v axinstall >/dev/null 2>&1; then
    axinstall "$@"
    return
  fi
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    require_prefetched axinstall @j4k/axinstall@3.0.7
  fi
  npm exec --yes --package=@j4k/axinstall@3.0.7 -- axinstall "$@"
}
configure_claude_review() {
  claude_path="$(command -v claude || true)"
  if [ -z "$claude_path" ]; then
    require_prefetched claude @anthropic-ai/claude-code
  fi
  review_bin_dir=/tmp/axreview-bin
  rm -rf "$review_bin_dir"
  mkdir -p "$review_bin_dir"
  ln -s "$claude_path" "$review_bin_dir/claude-real"
  cat > "$review_bin_dir/claude" <<'CLAUDE_WRAPPER'
#!/bin/sh
set -eu
node <<'CONFIGURE_CLAUDE'
const fs = require("fs");
const path = require("path");

const configDirectory = process.env.CLAUDE_CONFIG_DIR;
if (!configDirectory) throw new Error("CLAUDE_CONFIG_DIR is required for the review agent");

const settingsPath = path.join(configDirectory, "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const permissions =
  settings.permissions && typeof settings.permissions === "object" && !Array.isArray(settings.permissions)
    ? settings.permissions
    : {};
const existingDeny = Array.isArray(permissions.deny) ? permissions.deny : [];
const reviewDeny = [
  "Agent",
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "ListMcpResourcesTool",
  "LSP",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "ReportFindings",
  "ScheduleWakeup",
  "SendMessage",
  "SendUserFile",
  "ShareOnboardingGuide",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
];

Object.assign(settings, {
  disableAgentView: true,
  disableArtifact: true,
  disableBundledSkills: true,
  disableClaudeAiConnectors: true,
  disableRemoteControl: true,
  disableWorkflows: true,
  includeGitInstructions: false,
  permissions: {
    ...permissions,
    deny: [...new Set([...existingDeny, ...reviewDeny])],
  },
});
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
CONFIGURE_CLAUDE
exec /tmp/axreview-bin/claude-real --disable-slash-commands --strict-mcp-config "$@"
CLAUDE_WRAPPER
  chmod +x "$review_bin_dir/claude"
  export AXEXEC_CLAUDE_PATH="$review_bin_dir/claude"
}
configure_codex_review() {
  codex_path="$(command -v codex || true)"
  if [ -z "$codex_path" ]; then
    require_prefetched codex @openai/codex
  fi
  review_bin_dir=/tmp/axreview-bin
  rm -rf "$review_bin_dir"
  mkdir -p "$review_bin_dir"
  ln -s "$codex_path" "$review_bin_dir/codex-real"
  cat > "$review_bin_dir/codex" <<'CODEX_WRAPPER'
#!/bin/sh
set -eu
exec /tmp/axreview-bin/codex-real \
  -c 'features.apps=false' \
  -c 'features.plugins=false' \
  -c 'features.goals=false' \
  -c 'features.tool_suggest=false' \
  -c 'features.multi_agent=false' \
  -c 'features.multi_agent_v2=false' \
  -c 'features.js_repl=false' \
  -c 'web_search="disabled"' \
  -c 'include_apps_instructions=false' \
  -c 'include_collaboration_mode_instructions=false' \
  -c 'include_environment_context=false' \
  -c 'include_permissions_instructions=false' \
  -c 'skills.include_instructions=false' \
  -c 'skills.bundled.enabled=false' \
  -c 'tools.request_user_input=false' \
  -c 'personality="none"' \
  "$@"
CODEX_WRAPPER
  chmod +x "$review_bin_dir/codex"
  export AXEXEC_CODEX_PATH="$review_bin_dir/codex"
}
if [ -n "${REVIEW_PROFILE:-}" ]; then
  # Exit 1 = all lanes exhausted (the intended red check); set -e fails the job here.
  run_axrun resolve --profile "$REVIEW_PROFILE" --json > /tmp/axrun-resolve.json
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
  run_axinstall "$REVIEW_AGENT"
else
  run_axinstall "$REVIEW_AGENT" --with npm
fi
if [ "$REVIEW_AGENT" = "claude" ]; then
  configure_claude_review
fi
if [ "$REVIEW_AGENT" = "codex" ]; then
  configure_codex_review
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
run_axrun --agent "$REVIEW_AGENT" \
$provider_args \
$model_args \
$effort_args \
--vault-credential "$REVIEW_VAULT_CREDENTIAL" \
--allow "$AXRUN_ALLOW" \
--prompt "$(cat /tmp/prompt.md)"
