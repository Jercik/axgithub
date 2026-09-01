#!/bin/sh
set -eu

# This wrapper is the local workflow boundary around the generic review runner.
# Start its child under an empty environment and add back only the values the
# reviewer needs. Unknown current or future workflow variables therefore fail
# closed instead of becoming ambient authority.
: "${PATH:?PATH is required}"
: "${REVIEW_CONTEXT_PATH:?REVIEW_CONTEXT_PATH is required}"
: "${REVIEW_OUTPUT_PATH:?REVIEW_OUTPUT_PATH is required}"
: "${PROMPT_TEXT:?PROMPT_TEXT is required}"
: "${AXRUN_ALLOW:?AXRUN_ALLOW is required}"
: "${AXCREDS:?AXCREDS is required by the trusted credential-export phase}"

case "$REVIEW_CONTEXT_PATH" in
  /*) ;;
  *) echo "REVIEW_CONTEXT_PATH must be absolute" >&2; exit 1 ;;
esac
case "$REVIEW_OUTPUT_PATH" in
  /*) ;;
  *) echo "REVIEW_OUTPUT_PATH must be absolute" >&2; exit 1 ;;
esac
if [ -L "$REVIEW_OUTPUT_PATH" ] || { [ -e "$REVIEW_OUTPUT_PATH" ] && [ ! -f "$REVIEW_OUTPUT_PATH" ]; }; then
  echo "REVIEW_OUTPUT_PATH must be absent or a regular, non-symlink file" >&2
  exit 1
fi

# Axrecipe v9 creates these paths, overwrites the recipe env with them, and is
# the trusted O_NOFOLLOW/bounded/schema-validation boundary. This early check
# only turns obvious caller mistakes into a useful error before the model runs.
if [ ! -f "$REVIEW_CONTEXT_PATH" ] || [ -L "$REVIEW_CONTEXT_PATH" ]; then
  echo "REVIEW_CONTEXT_PATH must be a regular, non-symlink file" >&2
  exit 1
fi
case "$REVIEW_OUTPUT_PATH" in
  "$REVIEW_CONTEXT_PATH")
    echo "REVIEW_OUTPUT_PATH must differ from REVIEW_CONTEXT_PATH" >&2
    exit 1
    ;;
esac

if [ -x /usr/bin/mktemp ]; then
  mktemp_bin=/usr/bin/mktemp
elif [ -x /bin/mktemp ]; then
  mktemp_bin=/bin/mktemp
else
  echo "mktemp is required" >&2
  exit 1
fi

trusted_dir="$(umask 077; "$mktemp_bin" -d "${TMPDIR:-/tmp}/axgithub-structured-trusted.XXXXXX")"
handoff_dir=""
handoff_path=""
inner_runner=""
review_home=""
cleanup() {
  if [ -n "$trusted_dir" ]; then /bin/rm -rf "$trusted_dir"; fi
  if [ -n "$handoff_path" ]; then /bin/rm -f "$handoff_path"; fi
  if [ -n "$inner_runner" ]; then /bin/rm -f "$inner_runner"; fi
  if [ -n "$handoff_dir" ]; then /bin/rmdir "$handoff_dir" 2>/dev/null || true; fi
  if [ -n "$review_home" ]; then /bin/rm -rf "$review_home"; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
resolve_output="$trusted_dir/resolve.json"
resolve_parser="$trusted_dir/parse-resolve.cjs"

trusted_axrun="$(command -v axrun || true)"
if [ -z "$trusted_axrun" ]; then
  echo "axrun is not on PATH: deploy a released @j4k/axrun build with Resolve v2 and handoff support" >&2
  exit 1
fi
trusted_node="$(command -v node || true)"
if [ -z "$trusted_node" ]; then
  echo "node is not on PATH" >&2
  exit 1
fi
credential_export_help="$("$trusted_axrun" credential export --help 2>&1)" || {
  echo "axrun must support credential export: deploy a released build with handoff support" >&2
  exit 1
}
case "$credential_export_help" in
  *"--output"*) ;;
  *)
    echo "axrun must support credential export: deploy a released build with handoff support" >&2
    exit 1
    ;;
esac
axrun_help="$("$trusted_axrun" --help 2>&1)" || {
  echo "axrun must support --credential-handoff-fd: deploy a released build with handoff support" >&2
  exit 1
}
case "$axrun_help" in
  *"--credential-handoff-fd"*) ;;
  *)
    echo "axrun must support --credential-handoff-fd: deploy a released build with handoff support" >&2
    exit 1
    ;;
esac

# Resolve a profile and export its selected credential before the clean
# boundary. The handoff file is opened and unlinked before the reviewer starts;
# only its inherited descriptor crosses into the credential-free process.
if [ -n "${REVIEW_PROFILE:-}" ]; then
  : "${REVIEW_PORTFOLIO:?REVIEW_PORTFOLIO is required when REVIEW_PROFILE is set}"
  "$trusted_axrun" resolve --profile "$REVIEW_PROFILE" --portfolio "$REVIEW_PORTFOLIO" --json > "$resolve_output"
  cat > "$resolve_parser" <<'PARSE_STRUCTURED_RESOLVE'
const fs = require("fs");
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
const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
for (const [name, value] of Object.entries({
  REVIEW_AGENT: result.agentId.trim(),
  REVIEW_MODEL: result.model.trim(),
  REVIEW_VAULT_CREDENTIAL: result.credentialName.trim(),
  REVIEW_DISPLAY_NAME: nonEmpty(result.displayName) ? result.displayName.trim() : result.agentId.trim(),
  REVIEW_REASONING_EFFORT: nonEmpty(result.reasoningEffort) ? result.reasoningEffort.trim() : "",
})) process.stdout.write(name + "=" + quote(value) + "\n");
PARSE_STRUCTURED_RESOLVE
  resolve_exports="$("$trusted_node" "$resolve_parser" "$resolve_output" "$REVIEW_PROFILE" "$REVIEW_PORTFOLIO")"
  eval "$resolve_exports"
  export REVIEW_AGENT REVIEW_MODEL REVIEW_VAULT_CREDENTIAL REVIEW_DISPLAY_NAME REVIEW_REASONING_EFFORT
fi
/bin/rm -f "$resolve_output" "$resolve_parser"
/bin/rmdir "$trusted_dir"
trusted_dir=""

: "${REVIEW_AGENT:?REVIEW_AGENT is required}"
: "${REVIEW_VAULT_CREDENTIAL:?REVIEW_VAULT_CREDENTIAL is required}"

# No package installation is permitted in this secret-bearing process tree:
# lifecycle scripts can daemonize and outlive their installer. The workflow
# must preinstall every selectable agent before it starts axrecipe; this check
# fails closed if profile routing selects one that the trusted PATH omitted.
case "$REVIEW_AGENT" in
  claude|codex|copilot|cursor|gemini|opencode) ;;
  *) echo "unsupported structured review agent: $REVIEW_AGENT" >&2; exit 1 ;;
esac
if [ "$REVIEW_AGENT" = "cursor" ]; then
  review_agent_command=agent
else
  review_agent_command="$REVIEW_AGENT"
fi
review_agent_bin="$(command -v "$review_agent_command" || true)"
if [ -z "$review_agent_bin" ]; then
  echo "$review_agent_command is not on PATH: the workflow must preinstall every selectable review agent before axrecipe starts" >&2
  exit 1
fi

review_home="$(umask 077; "$mktemp_bin" -d "${TMPDIR:-/tmp}/axgithub-review-home.XXXXXX")"
review_tmp="$review_home/tmp"
/bin/mkdir -m 700 "$review_tmp"

# Run every agent-configuration and prompt helper before the credential exists.
# The seeder changes the generic runner's fixed /tmp paths to this private
# TMPDIR and replaces its final axrun call with a state writer.
inner_runner="$review_home/prepare-runner.sh"
prepared_state="$review_home/prepared-state.json"
: "${REVIEW_MODEL:?REVIEW_MODEL is required when REVIEW_PROFILE is set}"
review_signature_model="$REVIEW_MODEL"
/bin/cat > "$inner_runner" <<'AXGITHUB_GENERIC_REVIEW_RUNNER'
__AXGITHUB_GENERIC_REVIEW_RUNNER__
AXGITHUB_GENERIC_REVIEW_RUNNER
/bin/chmod 500 "$inner_runner"
/usr/bin/env -i \
  "HOME=$review_home" \
  "PATH=$PATH" \
  "TMPDIR=$review_tmp" \
  "REVIEW_CONTEXT_PATH=$REVIEW_CONTEXT_PATH" \
  "REVIEW_OUTPUT_PATH=$REVIEW_OUTPUT_PATH" \
  "PROMPT_TEXT=$PROMPT_TEXT" \
  "AXRUN_PREPARED_STATE=$prepared_state" \
  "REVIEW_AGENT=$REVIEW_AGENT" \
  "REVIEW_MODEL=$review_signature_model" \
  "REVIEW_DISPLAY_NAME=${REVIEW_DISPLAY_NAME:-}" \
  "REVIEW_PROFILE=${REVIEW_PROFILE:-}" \
  "REVIEW_PORTFOLIO=${REVIEW_PORTFOLIO:-}" \
  "REVIEW_REASONING_EFFORT=${REVIEW_REASONING_EFFORT:-}" \
  /bin/sh "$inner_runner"
/bin/rm -f "$inner_runner"
inner_runner=""

prepared_parser="$review_home/parse-prepared-state.cjs"
/bin/cat > "$prepared_parser" <<'PARSE_PREPARED_STATE'
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
if (!state || typeof state !== "object" || typeof state.PATH !== "string" || !state.PATH || typeof state.PROMPT !== "string") {
  throw new Error("structured runner preparation returned invalid state");
}
for (const name of ["PATH", "PROMPT", "AXEXEC_CLAUDE_PATH", "AXEXEC_CODEX_PATH", "AXEXEC_CURSOR_PATH", "AXEXEC_OPENCODE_PATH"]) {
  const value = state[name] ?? "";
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`invalid prepared ${name}`);
  process.stdout.write(`PREPARED_${name}=${quote(value)}\n`);
}
PARSE_PREPARED_STATE
prepared_exports="$("$trusted_node" "$prepared_parser" "$prepared_state")"
eval "$prepared_exports"
/bin/rm -f "$prepared_parser" "$prepared_state"

# Export only after every helper has exited. The final clean launcher opens and
# unlinks the file, maps it to fd 4 in axrun only, closes its own copy
# immediately, and waits as a credential-free parent.
handoff_dir="$(umask 077; "$mktemp_bin" -d "${TMPDIR:-/tmp}/axgithub-credential-handoff.XXXXXX")"
handoff_path="$handoff_dir/credential.json"
launcher="$review_home/launch-review.cjs"
/bin/cat > "$launcher" <<'STRUCTURED_REVIEW_LAUNCHER'
const { closeSync, constants, fstatSync, openSync, rmdirSync, unlinkSync } = require("node:fs");
const { spawn } = require("node:child_process");
const [handoffDir, handoffPath, executable, ...args] = process.argv.slice(2);
let descriptor;
try {
  descriptor = openSync(handoffPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!fstatSync(descriptor).isFile()) throw new Error("credential handoff is not a regular file");
  unlinkSync(handoffPath);
  rmdirSync(handoffDir);
  const child = spawn(executable, args, {
    env: process.env,
    stdio: ["inherit", "inherit", "inherit", "ignore", descriptor],
  });
  closeSync(descriptor);
  descriptor = undefined;
  const forwardedSignals = ["SIGHUP", "SIGINT", "SIGTERM"];
  for (const signal of forwardedSignals) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  child.once("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.exitCode = 1;
      for (const forwarded of forwardedSignals) process.removeAllListeners(forwarded);
      process.kill(process.pid, signal);
    } else process.exitCode = code ?? 1;
  });
} catch (error) {
  if (descriptor !== undefined) closeSync(descriptor);
  try { unlinkSync(handoffPath); } catch (unlinkError) {
    if (unlinkError?.code !== "ENOENT") console.error(`failed to remove credential handoff: ${String(unlinkError)}`);
  }
  try { rmdirSync(handoffDir); } catch {}
  throw error;
}
STRUCTURED_REVIEW_LAUNCHER
/bin/chmod 500 "$launcher"
umask 077
"$trusted_axrun" credential export \
  --agent "$REVIEW_AGENT" \
  --vault-credential "$REVIEW_VAULT_CREDENTIAL" \
  --output "$handoff_path"
if [ ! -f "$handoff_path" ] || [ -L "$handoff_path" ]; then
  echo "axrun credential export did not create a regular handoff file" >&2
  exit 1
fi

set -- /usr/bin/env -i \
  "HOME=$review_home" \
  "TMPDIR=$review_tmp" \
  "PATH=$PREPARED_PATH" \
  "REVIEW_CONTEXT_PATH=$REVIEW_CONTEXT_PATH" \
  "REVIEW_OUTPUT_PATH=$REVIEW_OUTPUT_PATH"
if [ -n "$PREPARED_AXEXEC_CLAUDE_PATH" ]; then set -- "$@" "AXEXEC_CLAUDE_PATH=$PREPARED_AXEXEC_CLAUDE_PATH"; fi
if [ -n "$PREPARED_AXEXEC_CODEX_PATH" ]; then set -- "$@" "AXEXEC_CODEX_PATH=$PREPARED_AXEXEC_CODEX_PATH"; fi
if [ -n "$PREPARED_AXEXEC_CURSOR_PATH" ]; then set -- "$@" "AXEXEC_CURSOR_PATH=$PREPARED_AXEXEC_CURSOR_PATH"; fi
if [ -n "$PREPARED_AXEXEC_OPENCODE_PATH" ]; then set -- "$@" "AXEXEC_OPENCODE_PATH=$PREPARED_AXEXEC_OPENCODE_PATH"; fi
if [ -n "${LANG:-}" ]; then set -- "$@" "LANG=$LANG"; fi
if [ -n "${LC_ALL:-}" ]; then set -- "$@" "LC_ALL=$LC_ALL"; fi
if [ -n "${TERM:-}" ]; then set -- "$@" "TERM=$TERM"; fi
if [ -n "${CI:-}" ]; then set -- "$@" "CI=$CI"; fi
if [ -n "${GITHUB_ACTIONS:-}" ]; then set -- "$@" "GITHUB_ACTIONS=$GITHUB_ACTIONS"; fi
if [ -n "${GITHUB_WORKSPACE:-}" ]; then set -- "$@" "GITHUB_WORKSPACE=$GITHUB_WORKSPACE"; fi
set -- "$@" "$trusted_node" "$launcher" "$handoff_dir" "$handoff_path" \
  "$trusted_axrun" --agent "$REVIEW_AGENT"
if [ -n "${REVIEW_MODEL:-}" ]; then set -- "$@" --model "$REVIEW_MODEL"; fi
if [ -n "${REVIEW_REASONING_EFFORT:-}" ]; then set -- "$@" --reasoning-effort "$REVIEW_REASONING_EFFORT"; fi
set -- "$@" --credential-handoff-fd 4 --allow "$AXRUN_ALLOW" --prompt "$PREPARED_PROMPT"

# Replacing the credential-bearing shell is load-bearing. Hosted runners remove
# the scratch home with the job; persistent runners must prune this namespace.
exec "$@"
