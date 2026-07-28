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
: "${AXCREDS:?AXCREDS is required by the trusted axrun outer process}"

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

# The generic runner remains the single source for agent resolution/install.
# The seeder replaces this marker with its checked-in contents. Materialize it
# before untrusted execution; there is deliberately no trusted command after
# the reviewer returns. Validation and posting happen outside this generator.
inner_runner="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/axgithub-structured-runner.XXXXXX")"
/bin/cat > "$inner_runner" <<'AXGITHUB_GENERIC_REVIEW_RUNNER'
# Remove this trusted temporary script before the untrusted reviewer starts.
/bin/rm -f "$0"
__AXGITHUB_GENERIC_REVIEW_RUNNER__
AXGITHUB_GENERIC_REVIEW_RUNNER
/bin/chmod 500 "$inner_runner"

set -- /usr/bin/env -i \
  "HOME=$HOME" \
  "PATH=$PATH" \
  "REVIEW_CONTEXT_PATH=$REVIEW_CONTEXT_PATH" \
  "REVIEW_OUTPUT_PATH=$REVIEW_OUTPUT_PATH" \
  "PROMPT_TEXT=$PROMPT_TEXT" \
  "AXRUN_ALLOW=$AXRUN_ALLOW" \
  "AXCREDS=$AXCREDS"

# Trusted outer-process routing. Axexec consumes and removes AX service fields
# before the reviewer child, then provisions only the selected model's auth.
if [ -n "${AXCREDROUTER:-}" ]; then set -- "$@" "AXCREDROUTER=$AXCREDROUTER"; fi
if [ -n "${REVIEW_PROFILE:-}" ]; then set -- "$@" "REVIEW_PROFILE=$REVIEW_PROFILE"; fi
if [ -n "${REVIEW_AGENT:-}" ]; then set -- "$@" "REVIEW_AGENT=$REVIEW_AGENT"; fi
if [ -n "${REVIEW_MODEL:-}" ]; then set -- "$@" "REVIEW_MODEL=$REVIEW_MODEL"; fi
if [ -n "${REVIEW_DISPLAY_NAME:-}" ]; then
  set -- "$@" "REVIEW_DISPLAY_NAME=$REVIEW_DISPLAY_NAME"
fi
if [ -n "${REVIEW_VAULT_CREDENTIAL:-}" ]; then
  set -- "$@" "REVIEW_VAULT_CREDENTIAL=$REVIEW_VAULT_CREDENTIAL"
fi
if [ -n "${REVIEW_PROVIDER:-}" ]; then set -- "$@" "REVIEW_PROVIDER=$REVIEW_PROVIDER"; fi
if [ -n "${REVIEW_REASONING_EFFORT:-}" ]; then
  set -- "$@" "REVIEW_REASONING_EFFORT=$REVIEW_REASONING_EFFORT"
fi

# Minimal nonsecret process metadata. In particular, no Actions command-file,
# OIDC/runtime, forge API, Git, npm, SSH, cloud, Docker, or Kubernetes channel
# crosses this boundary. The consuming checkout must also use
# persist-credentials: false because environment isolation cannot clean .git.
if [ -n "${TMPDIR:-}" ]; then set -- "$@" "TMPDIR=$TMPDIR"; fi
if [ -n "${LANG:-}" ]; then set -- "$@" "LANG=$LANG"; fi
if [ -n "${LC_ALL:-}" ]; then set -- "$@" "LC_ALL=$LC_ALL"; fi
if [ -n "${TERM:-}" ]; then set -- "$@" "TERM=$TERM"; fi
if [ -n "${CI:-}" ]; then set -- "$@" "CI=$CI"; fi
if [ -n "${GITHUB_ACTIONS:-}" ]; then set -- "$@" "GITHUB_ACTIONS=$GITHUB_ACTIONS"; fi
if [ -n "${GITHUB_WORKSPACE:-}" ]; then
  set -- "$@" "GITHUB_WORKSPACE=$GITHUB_WORKSPACE"
fi

exec "$@" /bin/sh "$inner_runner"
