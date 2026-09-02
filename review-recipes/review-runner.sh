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
  echo "axrun is not on PATH: deploy a released @j4k/axrun build with Resolve v2 support" >&2
  exit 1
}
if ! command -v axrun >/dev/null 2>&1; then
  echo "axrun is not on PATH: deploy a released @j4k/axrun build with Resolve v2 support" >&2
  exit 1
fi
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
  : "${REVIEW_PORTFOLIO:?REVIEW_PORTFOLIO is required when REVIEW_PROFILE is set}"
  # Exit 1 = all lanes exhausted (the intended red check); set -e fails the job here.
  run_axrun resolve --profile "$REVIEW_PROFILE" --portfolio "$REVIEW_PORTFOLIO" --json > /tmp/axrun-resolve.json
  cat > /tmp/parse-resolve.cjs <<'PARSE_RESOLVE'
const fs = require("fs");
// Keep the last JSON object when a launcher adds diagnostic lines around the payload.
let resolved;
for (const line of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) continue;
  try {
    const value = JSON.parse(trimmed);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) resolved = value;
  } catch {}
}
const [expectedProfile, expectedPortfolio] = process.argv.slice(3);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const hasExactKeys = (value, required, optional = []) => {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key));
};
const isEnum = (value, values) => typeof value === "string" && values.includes(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isLaneId = (value) => nonEmpty(value) && value.length <= 64 &&
  /^[a-z][a-z0-9-]*$/.test(value) && !/^(?:y|yes|n|no|on|off|true|false|null)$/iu.test(value);
const isRouteRevision = (value) => typeof value === "string" && /^rr3_[A-Za-z0-9_-]{43}$/.test(value);
const isCredentialName = (value) => typeof value === "string" && /^(?!\.{1,2}$)[\w.-]{1,128}$/u.test(value);
const isOffsetDateTime = (value) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const isOverCeiling = (value) => {
  if (!hasExactKeys(value, ["limits"], ["semantics"]) ||
      (Object.prototype.hasOwnProperty.call(value, "semantics") && value.semantics !== "all-renewable-limits") ||
      !Array.isArray(value.limits)) return false;
  return value.limits.every((limit) =>
    hasExactKeys(limit, ["id", "displayName", "utilization"], ["resetsAt"]) &&
    nonEmpty(limit.id) && nonEmpty(limit.displayName) && Number.isFinite(limit.utilization) &&
    (!Object.prototype.hasOwnProperty.call(limit, "resetsAt") || isOffsetDateTime(limit.resetsAt))
  );
};
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const parseCapabilityPolicy = () => {
  let policy;
  try {
    policy = JSON.parse(process.env.REVIEW_CAPABILITY_POLICY_V2 ?? "");
  } catch {
    return undefined;
  }
  if (!hasExactKeys(policy, ["schemaVersion", "capabilities"]) || policy.schemaVersion !== 1 ||
      !Array.isArray(policy.capabilities) || policy.capabilities.length === 0) return undefined;
  const valid = policy.capabilities.every((capability) => {
    if (!hasExactKeys(capability, ["agentId", "serviceType", "providerId", "executionModes", "modelNamespace", "reasoning"]) ||
        (!isEnum(capability.agentId, ["claude", "codex", "grok", "opencode"]) ||
          !isEnum(capability.serviceType, ["claude", "codex", "grok"]) ||
          (capability.providerId !== null && !nonEmpty(capability.providerId)) ||
          !Array.isArray(capability.executionModes) || !capability.executionModes.every((mode) => typeof mode === "string") ||
          !isEnum(capability.modelNamespace?.kind, ["exact", "prefix"]) ||
          !isEnum(capability.reasoning?.kind, ["closed", "open", "byModel"]))) return false;
    if (capability.modelNamespace.kind === "exact" &&
        (!hasExactKeys(capability.modelNamespace, ["kind", "values"]) ||
          !Array.isArray(capability.modelNamespace.values) || !capability.modelNamespace.values.every(nonEmpty))) return false;
    if (capability.modelNamespace.kind === "prefix" &&
        (!hasExactKeys(capability.modelNamespace, ["kind", "value"]) || !nonEmpty(capability.modelNamespace.value))) return false;
    if (capability.reasoning.kind === "closed" &&
        (!hasExactKeys(capability.reasoning, ["kind", "values"]) ||
          !Array.isArray(capability.reasoning.values) || !capability.reasoning.values.every(nonEmpty))) return false;
    if (capability.reasoning.kind === "open" && !hasExactKeys(capability.reasoning, ["kind"])) return false;
    if (capability.reasoning.kind === "byModel" &&
        (!hasExactKeys(capability.reasoning, ["kind", "values"]) || !isRecord(capability.reasoning.values) ||
          !Object.values(capability.reasoning.values).every((values) => Array.isArray(values) && values.every(nonEmpty)))) return false;
    return true;
  });
  return valid ? policy : undefined;
};
const capabilityPolicy = parseCapabilityPolicy();
const validateCapabilityV2 = (value) => {
  if (!capabilityPolicy) return false;
  const providerId = hasOwn(value, "providerId") ? value.providerId.trim() : undefined;
  const model = value.model.trim();
  const reasoningEffort = hasOwn(value, "reasoningEffort") ? value.reasoningEffort.trim() : undefined;
  const capability = capabilityPolicy.capabilities.find((candidate) =>
    candidate.agentId === value.agentId && candidate.serviceType === value.serviceType &&
    (candidate.providerId === null ? providerId === undefined : candidate.providerId === providerId)
  );
  if (!capability || !capability.executionModes.includes("headless")) return false;
  const modelSupported = capability.modelNamespace.kind === "exact"
    ? capability.modelNamespace.values.includes(model)
    : model.startsWith(capability.modelNamespace.value);
  if (!modelSupported || reasoningEffort === undefined) return modelSupported;
  if (capability.reasoning.kind === "open") return nonEmpty(reasoningEffort);
  if (capability.reasoning.kind === "closed") return capability.reasoning.values.includes(reasoningEffort);
  return Array.isArray(capability.reasoning.values[model]) &&
    capability.reasoning.values[model].includes(reasoningEffort);
};
const validateAvailable = (value) => {
  if (!hasExactKeys(value,
    ["available", "laneId", "routeRevision", "executionTargetId", "agentId", "serviceType", "model", "mainPoolExempt", "credentialName", "reason", "warnings"],
    ["providerId", "reasoningEffort", "displayName", "capacityBasis", "overCeiling"])) return false;
  if (value.available !== true || !isLaneId(value.laneId) || !isRouteRevision(value.routeRevision) ||
      !nonEmpty(value.executionTargetId) || !isEnum(value.agentId, ["claude", "codex", "grok", "opencode"]) ||
      !isEnum(value.serviceType, ["claude", "codex", "grok"]) || !nonEmpty(value.model) ||
      typeof value.mainPoolExempt !== "boolean" || !isCredentialName(value.credentialName) ||
      !isEnum(value.reason, ["rank-spread", "rank-spread-salvage", "over-ceiling"]) ||
      !isStringArray(value.warnings)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "providerId") && !nonEmpty(value.providerId)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "reasoningEffort") && !nonEmpty(value.reasoningEffort)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "displayName") && !nonEmpty(value.displayName)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "capacityBasis") &&
      !isEnum(value.capacityBasis, ["provider-percentage", "model-equivalent-percentage"])) return false;
  if (Object.prototype.hasOwnProperty.call(value, "overCeiling") && !isOverCeiling(value.overCeiling)) return false;
  return value.reason !== "over-ceiling" && !Object.prototype.hasOwnProperty.call(value, "overCeiling") &&
    (value.agentId !== "opencode" || nonEmpty(value.providerId)) && validateCapabilityV2(value);
};
const validateUnavailable = (value) => {
  if (!hasExactKeys(value, ["available", "reason", "routes", "warnings", "overCeiling"])) return false;
  if (value.available !== false || value.reason !== "all-lanes-exhausted" || !Array.isArray(value.routes) ||
      !isStringArray(value.warnings) || !hasExactKeys(value.overCeiling, ["permitted", "viable"]) ||
      typeof value.overCeiling.permitted !== "boolean" || typeof value.overCeiling.viable !== "boolean") return false;
  return value.routes.every((route) =>
    hasExactKeys(route, ["laneId", "rank", "serviceType", "model", "reason"]) &&
    isLaneId(route.laneId) && Number.isInteger(route.rank) && route.rank > 0 && route.rank <= 2147483647 &&
    isEnum(route.serviceType, ["claude", "codex", "grok"]) && nonEmpty(route.model) &&
    isEnum(route.reason, ["no-candidate-supply", "candidate-supply-unavailable"])
  );
};
const context = resolved?.context;
const selection = context?.selectionRequirement;
const result = resolved?.result;
const validEnvelope = hasExactKeys(resolved, ["resolveVersion", "context", "result"]) &&
  resolved.resolveVersion === 2 &&
  hasExactKeys(context, ["profileId", "portfolioId", "executionMode", "selectionRequirement", "allowOverCeiling"]) &&
  nonEmpty(context.profileId) && context.profileId === expectedProfile &&
  nonEmpty(context.portfolioId) && context.portfolioId === expectedPortfolio &&
  context.executionMode === "headless" && context.allowOverCeiling === false &&
  hasExactKeys(selection, ["kind"]) && selection.kind === "any" &&
  ((isRecord(result) && result.available === true && validateAvailable(result)) ||
    (isRecord(result) && result.available === false && validateUnavailable(result)));
if (!validEnvelope) {
  console.error("axrun resolve output was not a matching Resolve v2 response");
  process.exit(1);
}
if (result.available !== true) {
  console.error("axrun resolve returned no eligible lane");
  process.exit(1);
}
const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
const assignments = {
  REVIEW_AGENT: result.agentId.trim(),
  REVIEW_MODEL: result.model.trim(),
  REVIEW_VAULT_CREDENTIAL: result.credentialName.trim(),
  REVIEW_DISPLAY_NAME: nonEmpty(result.displayName) ? result.displayName.trim() : result.agentId.trim(),
  REVIEW_REASONING_EFFORT: nonEmpty(result.reasoningEffort) ? result.reasoningEffort.trim() : "",
  REVIEW_PROVIDER: nonEmpty(result.providerId) ? result.providerId.trim() : "",
};
for (const [name, value] of Object.entries(assignments)) {
  process.stdout.write(name + "=" + shellQuote(value) + "\n");
}
PARSE_RESOLVE
  resolve_exports="$(node /tmp/parse-resolve.cjs /tmp/axrun-resolve.json "$REVIEW_PROFILE" "$REVIEW_PORTFOLIO")"
  eval "$resolve_exports"
  export REVIEW_AGENT REVIEW_MODEL REVIEW_VAULT_CREDENTIAL REVIEW_DISPLAY_NAME REVIEW_REASONING_EFFORT REVIEW_PROVIDER
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
set -- --agent "$REVIEW_AGENT"
if [ -n "${REVIEW_PROVIDER:-}" ]; then
  set -- "$@" --provider "$REVIEW_PROVIDER"
fi
set -- "$@" --model "$REVIEW_MODEL"
if [ -n "${REVIEW_REASONING_EFFORT:-}" ]; then
  set -- "$@" --reasoning-effort "$REVIEW_REASONING_EFFORT"
fi
set -- "$@" --vault-credential "$REVIEW_VAULT_CREDENTIAL"
set -- "$@" --allow "$AXRUN_ALLOW"
set -- "$@" --prompt "$(cat /tmp/prompt.md)"
run_axrun "$@"
