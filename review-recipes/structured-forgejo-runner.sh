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
resolve_output="$trusted_dir/resolve.json"
resolve_parser="$trusted_dir/parse-resolve.cjs"

trusted_axrun="$(command -v axrun || true)"
if [ -z "$trusted_axrun" ]; then
  echo "axrun is not on PATH: the workflow must pre-fetch @j4k/axrun@5.0.0" >&2
  exit 1
fi

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

: "${REVIEW_AGENT:?REVIEW_AGENT is required}"
: "${REVIEW_VAULT_CREDENTIAL:?REVIEW_VAULT_CREDENTIAL is required}"

handoff_dir="$(umask 077; "$mktemp_bin" -d "${TMPDIR:-/tmp}/axgithub-credential-handoff.XXXXXX")"
handoff_path="$handoff_dir/credential.json"
inner_runner=""
review_home=""
cleanup() {
  /bin/rm -f "$handoff_path" "${inner_runner:-}"
  /bin/rmdir "$handoff_dir" "${review_home:-}" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
umask 077
"$trusted_axrun" credential export \
  --agent "$REVIEW_AGENT" \
  --vault-credential "$REVIEW_VAULT_CREDENTIAL" \
  --output "$handoff_path"
if [ ! -f "$handoff_path" ] || [ -L "$handoff_path" ]; then
  echo "axrun credential export did not create a regular handoff file" >&2
  exit 1
fi
exec 4<"$handoff_path"
/bin/rm -f "$handoff_path"
/bin/rmdir "$handoff_dir"

# The generic runner remains the single source for agent install and execution.
# The seeder replaces this marker with its checked-in contents. Materialize it
# before untrusted execution; there is deliberately no trusted command after
# the reviewer returns. Validation and posting happen outside this generator.
inner_runner="$("$mktemp_bin" "${TMPDIR:-/tmp}/axgithub-structured-runner.XXXXXX")"
review_home="$(umask 077; "$mktemp_bin" -d "${TMPDIR:-/tmp}/axgithub-review-home.XXXXXX")"
trusted_npm_prefix="$(npm prefix -g)"
case "$trusted_npm_prefix" in
  /*) ;;
  *) echo "npm prefix -g must return an absolute path" >&2; exit 1 ;;
esac
/bin/cat > "$inner_runner" <<'AXGITHUB_GENERIC_REVIEW_RUNNER'
# Remove this trusted temporary script before the untrusted reviewer starts.
/bin/rm -f "$0"
__AXGITHUB_GENERIC_REVIEW_RUNNER__
AXGITHUB_GENERIC_REVIEW_RUNNER
/bin/chmod 500 "$inner_runner"

set -- /usr/bin/env -i \
  "HOME=$review_home" \
  "PATH=$PATH" \
  "NPM_CONFIG_PREFIX=$trusted_npm_prefix" \
  "REVIEW_CONTEXT_PATH=$REVIEW_CONTEXT_PATH" \
  "REVIEW_OUTPUT_PATH=$REVIEW_OUTPUT_PATH" \
  "PROMPT_TEXT=$PROMPT_TEXT" \
  "AXRUN_ALLOW=$AXRUN_ALLOW" \
  "AXRUN_BIN=$trusted_axrun" \
  "AXRUN_RESOLVED_PROFILE=${REVIEW_PROFILE:+1}" \
  "AXRUN_CREDENTIAL_HANDOFF_FD=4"

# Profile routing and credential export ran before the clean boundary. Axexec
# receives the selected agent and an unlinked credential descriptor only.
if [ -n "${REVIEW_AGENT:-}" ]; then set -- "$@" "REVIEW_AGENT=$REVIEW_AGENT"; fi
if [ -n "${REVIEW_PROFILE:-}" ]; then set -- "$@" "REVIEW_PROFILE=$REVIEW_PROFILE"; fi
set -- "$@" "REVIEW_MODEL=${REVIEW_MODEL:-}"
if [ -n "${REVIEW_DISPLAY_NAME:-}" ]; then
  set -- "$@" "REVIEW_DISPLAY_NAME=$REVIEW_DISPLAY_NAME"
fi
if [ -n "${REVIEW_REASONING_EFFORT:-}" ]; then
  set -- "$@" "REVIEW_REASONING_EFFORT=$REVIEW_REASONING_EFFORT"
fi

# Minimal nonsecret process metadata. The workflow must separately ensure that
# the generator is not co-resident with secrets under the same OS identity:
# environment filtering cannot hide ancestor `/proc` state or credential files.
# It must use `persist-credentials: false` and a scratch credential-free home.
if [ -n "${TMPDIR:-}" ]; then set -- "$@" "TMPDIR=$TMPDIR"; fi
if [ -n "${LANG:-}" ]; then set -- "$@" "LANG=$LANG"; fi
if [ -n "${LC_ALL:-}" ]; then set -- "$@" "LC_ALL=$LC_ALL"; fi
if [ -n "${TERM:-}" ]; then set -- "$@" "TERM=$TERM"; fi
if [ -n "${CI:-}" ]; then set -- "$@" "CI=$CI"; fi
if [ -n "${GITHUB_ACTIONS:-}" ]; then set -- "$@" "GITHUB_ACTIONS=$GITHUB_ACTIONS"; fi
if [ -n "${GITHUB_WORKSPACE:-}" ]; then
  set -- "$@" "GITHUB_WORKSPACE=$GITHUB_WORKSPACE"
fi

# Replacing this trusted shell is load-bearing: it removes the rendered vault
# service configuration from the model's process ancestry before it starts.
exec "$@" /bin/sh "$inner_runner"
