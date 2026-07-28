#!/bin/sh
set -eu

# This wrapper is the local workflow boundary around the generic review runner.
# Start its child under an empty environment and add back only the values the
# reviewer needs. Unknown current or future workflow variables therefore fail
# closed instead of becoming ambient authority.
: "${HOME:?HOME is required}"
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
trap cleanup EXIT HUP INT TERM
resolve_output="$trusted_dir/resolve.json"
resolve_parser="$trusted_dir/parse-resolve.cjs"

trusted_axrun="$(command -v axrun || true)"
if [ -z "$trusted_axrun" ]; then
  echo "axrun is not on PATH: the workflow must pre-fetch @j4k/axrun@5.0.0" >&2
  exit 1
fi
trusted_axinstall="$(command -v axinstall || true)"
if [ -z "$trusted_axinstall" ]; then
  echo "axinstall is not on PATH: the workflow must pre-fetch @j4k/axinstall" >&2
  exit 1
fi
trusted_node="$(command -v node || true)"
if [ -z "$trusted_node" ]; then
  echo "node is not on PATH" >&2
  exit 1
fi
credential_export_help="$("$trusted_axrun" credential export --help 2>&1)" || {
  echo "axrun must support credential export: pre-fetch @j4k/axrun@5" >&2
  exit 1
}
case "$credential_export_help" in
  *"--output"*) ;;
  *)
    echo "axrun must support credential export: pre-fetch @j4k/axrun@5" >&2
    exit 1
    ;;
esac
axrun_help="$("$trusted_axrun" --help 2>&1)" || {
  echo "axrun must support --credential-handoff-fd: pre-fetch @j4k/axrun@5" >&2
  exit 1
}
case "$axrun_help" in
  *"--credential-handoff-fd"*) ;;
  *)
    echo "axrun must support --credential-handoff-fd: pre-fetch @j4k/axrun@5" >&2
    exit 1
    ;;
esac

# Resolve a profile and export its selected credential before the clean
# boundary. The handoff file is opened and unlinked before the reviewer starts;
# only its inherited descriptor crosses into the credential-free process.
if [ -n "${REVIEW_PROFILE:-}" ]; then
  "$trusted_axrun" resolve --profile "$REVIEW_PROFILE" --json > "$resolve_output"
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
if (!resolved || resolved.available !== true) {
  console.error("axrun resolve output contained no usable resolve response");
  process.exit(1);
}
const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
for (const [name, value] of Object.entries({
  REVIEW_AGENT: resolved.agentId,
  REVIEW_MODEL: resolved.model || "",
  REVIEW_VAULT_CREDENTIAL: resolved.credentialName,
  REVIEW_DISPLAY_NAME: resolved.displayName || resolved.agentId,
  REVIEW_REASONING_EFFORT: resolved.reasoningEffort || "",
})) process.stdout.write(name + "=" + quote(value) + "\n");
PARSE_STRUCTURED_RESOLVE
  resolve_exports="$(node "$resolve_parser" "$resolve_output")"
  eval "$resolve_exports"
  export REVIEW_AGENT REVIEW_MODEL REVIEW_VAULT_CREDENTIAL REVIEW_DISPLAY_NAME REVIEW_REASONING_EFFORT
fi
/bin/rm -f "$resolve_output" "$resolve_parser"
/bin/rmdir "$trusted_dir"
trusted_dir=""

: "${REVIEW_AGENT:?REVIEW_AGENT is required}"
: "${REVIEW_VAULT_CREDENTIAL:?REVIEW_VAULT_CREDENTIAL is required}"

# Install the selected agent before creating the credential handoff. The
# installer gets a scratch home/prefix and no credential authority or open
# handoff descriptor, so package lifecycle processes cannot inherit either.
review_home="$(umask 077; "$mktemp_bin" -d "${TMPDIR:-/tmp}/axgithub-review-home.XXXXXX")"
review_npm_prefix="$review_home/npm-global"
review_tmp="$review_home/tmp"
/bin/mkdir -m 700 "$review_npm_prefix"
/bin/mkdir -m 700 "$review_tmp"
if [ "$REVIEW_AGENT" = "cursor" ]; then
  /usr/bin/env -i \
    "HOME=$review_home" \
    "PATH=$PATH" \
    "NPM_CONFIG_PREFIX=$review_npm_prefix" \
    "$trusted_axinstall" "$REVIEW_AGENT"
else
  /usr/bin/env -i \
    "HOME=$review_home" \
    "PATH=$PATH" \
    "NPM_CONFIG_PREFIX=$review_npm_prefix" \
    "$trusted_axinstall" "$REVIEW_AGENT" --with npm
fi

# Run every agent-configuration and prompt helper before the credential exists.
# The seeder changes the generic runner's fixed /tmp paths to this private
# TMPDIR and replaces its final axrun call with a state writer.
inner_runner="$review_home/prepare-runner.sh"
prepared_state="$review_home/prepared-state.json"
/bin/cat > "$inner_runner" <<'AXGITHUB_GENERIC_REVIEW_RUNNER'
__AXGITHUB_GENERIC_REVIEW_RUNNER__
AXGITHUB_GENERIC_REVIEW_RUNNER
/bin/chmod 500 "$inner_runner"
/usr/bin/env -i \
  "HOME=$review_home" \
  "PATH=$review_npm_prefix/bin:$PATH" \
  "NPM_CONFIG_PREFIX=$review_npm_prefix" \
  "TMPDIR=$review_tmp" \
  "REVIEW_CONTEXT_PATH=$REVIEW_CONTEXT_PATH" \
  "REVIEW_OUTPUT_PATH=$REVIEW_OUTPUT_PATH" \
  "PROMPT_TEXT=$PROMPT_TEXT" \
  "AXRUN_PREPARED_STATE=$prepared_state" \
  "REVIEW_AGENT=$REVIEW_AGENT" \
  "REVIEW_MODEL=${REVIEW_MODEL:-}" \
  "REVIEW_DISPLAY_NAME=${REVIEW_DISPLAY_NAME:-}" \
  "REVIEW_PROFILE=${REVIEW_PROFILE:-}" \
  "REVIEW_REASONING_EFFORT=${REVIEW_REASONING_EFFORT:-}" \
  /bin/sh "$inner_runner"
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
  child.once("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} catch (error) {
  if (descriptor !== undefined) closeSync(descriptor);
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
