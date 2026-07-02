set -eu
if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
cat > /tmp/axkit.npmrc <<NPMRC
registry=https://npm.j4k.dev/
//npm.j4k.dev/:_authToken=${NODE_AUTH_TOKEN}
NPMRC
export NPM_CONFIG_USERCONFIG=/tmp/axkit.npmrc
export NPM_CONFIG_REGISTRY=https://npm.j4k.dev/
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
sed -i "s|__REVIEW_REPOSITORY__|$REVIEW_REPOSITORY|g" /tmp/prompt.md
sed -i "s|__REVIEW_PR_NUMBER__|$REVIEW_PR_NUMBER|g" /tmp/prompt.md
sed -i "s|__REVIEW_DISPLAY_NAME__|$REVIEW_DISPLAY_NAME|g" /tmp/prompt.md
sed -i "s|__REVIEW_MODEL__|$REVIEW_MODEL|g" /tmp/prompt.md
provider_args=""
if [ -n "${REVIEW_PROVIDER:-}" ]; then
  provider_args="--provider $REVIEW_PROVIDER"
fi
npm exec --yes --package=axrun@latest -- \
axrun --agent "$REVIEW_AGENT" \
$provider_args \
--model "$REVIEW_MODEL" \
--vault-credential "$REVIEW_VAULT_CREDENTIAL" \
--allow "$AXRUN_ALLOW" \
--prompt "$(cat /tmp/prompt.md)"