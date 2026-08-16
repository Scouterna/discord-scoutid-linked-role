#!/usr/bin/env bash
# Runs once, after the container is created. Nothing here is fatal: a missing
# npm mirror or an unreachable sibling repo should leave you with a usable
# shell, not a container that refuses to come up.
set -uo pipefail

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }

# --- Corporate TLS interception -------------------------------------------
# A gitignored .npmrc may point npm at an internal mirror reached through a
# TLS-intercepting proxy. Windows trusts that proxy's root CA from its own
# store; this Debian container does not, so npm would fail to verify the
# certificate. Drop the CA (PEM, .crt) into .devcontainer/certs/ to fix it.
CERT_DIR="$(dirname "$0")/certs"
if compgen -G "$CERT_DIR/*.crt" >/dev/null 2>&1; then
  log "Installing extra CA certificates"
  sudo cp "$CERT_DIR"/*.crt /usr/local/share/ca-certificates/
  sudo update-ca-certificates >/dev/null
  # Node keeps its own bundle and ignores the system store.
  echo 'export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt' >> ~/.bashrc
  ok "$(ls -1 "$CERT_DIR"/*.crt | wc -l) certificate(s) installed"
fi

# --- Dependencies ----------------------------------------------------------
# `npm ci` removes node_modules before it installs, so an unreachable registry
# would leave the tree emptier than it started. Probe first, and skip cleanly.
install_deps() {
  local dir="$1" name="$2"
  [ -d "$dir" ] || { warn "$name not mounted, skipping"; return; }
  [ -f "$dir/package.json" ] || { warn "$name has no package.json, skipping"; return; }

  log "$name: dependencies"
  local registry
  registry="$(cd "$dir" && npm config get registry)"

  if ! (cd "$dir" && npm ping >/dev/null 2>&1); then
    warn "registry $registry unreachable — leaving node_modules untouched."
    warn "if it is an internal mirror, add its CA to .devcontainer/certs/ and rerun,"
    warn "or remove $dir/.npmrc to fall back to registry.npmjs.org."
    return
  fi

  # npm ci wipes node_modules, which fails if a previous run (or the runtime
  # Dockerfile) created it as root. Fix ownership before npm touches it.
  if [ -d "$dir/node_modules" ] && [ "$(stat -c %u "$dir/node_modules")" != "$(id -u)" ]; then
    sudo chown -R "$(id -u):$(id -g)" "$dir/node_modules"
  fi

  (cd "$dir" && npm ci --no-audit --no-fund) || { warn "$name: npm ci failed"; return; }

  # npm 10 can die mid-install and still exit 0 (see the runtime Dockerfile),
  # so confirm every declared dependency actually landed.
  (cd "$dir" && node -e '
    const fs = require("fs"), { dependencies = {} } = require("./package.json");
    const missing = Object.keys(dependencies).filter(m => !fs.existsSync("node_modules/" + m + "/package.json"));
    if (missing.length) { console.error("  ! missing after install: " + missing.join(", ")); process.exit(1); }
  ') && ok "$name: all dependencies present ($registry)"
}

install_deps /workspaces/discord-scoutid-linked-role "discord-scoutid-linked-role"
install_deps /workspaces/wsj27-discord-bot "wsj27-discord-bot"

# --- Claude Code -----------------------------------------------------------
# Not ghcr.io/anthropics/devcontainer-features/claude-code. That feature runs
# `npm install -g @anthropic-ai/claude-code` at *build* time, hardcoded to
# registry.npmjs.org (its devcontainer-feature.json declares no options), under
# `set -eu`. On a network that TLS-intercepts npmjs that is a fatal
# ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE and the container never builds at all.
# Here the workspace is mounted, so the mirror in its gitignored .npmrc can be
# reached — and a failure costs the CLI, not the container.
log "Claude Code"
if command -v claude >/dev/null 2>&1; then
  ok "already installed ($(claude --version 2>/dev/null | awk '{print $1}'))"
else
  # `npm install -g` ignores the *project* .npmrc, so cd-ing into the workspace
  # is not enough: read the registry there and pass it through explicitly.
  # The image puts the global prefix (/usr/local/share/npm-global) on PATH and
  # lets `node` write it, so this needs no sudo.
  npm_cwd=/workspaces/discord-scoutid-linked-role
  [ -d "$npm_cwd" ] || npm_cwd="$HOME"
  claude_registry="$(cd "$npm_cwd" && npm config get registry)"

  if npm install -g --no-audit --no-fund --registry="$claude_registry" @anthropic-ai/claude-code >/dev/null 2>&1; then
    ok "$(claude --version 2>/dev/null | awk '{print $1}') ($claude_registry)"
  else
    warn "install failed against $claude_registry — the CLI is missing but the"
    warn "container is usable. Retry with:"
    printf '\n    npm install -g --registry=%s @anthropic-ai/claude-code\n' "$claude_registry"
  fi
fi

# --- Claude Code project memory --------------------------------------------
# Claude keys its per-project state on the *path* of the workspace, so the same
# repository is a different project inside the container than on the host:
#
#   host:      c--Users-pe-sad-code-discord-scoutid-linked-role
#   container: -workspaces-discord-scoutid-linked-role
#
# ~/.claude is bind-mounted, but without this the container would start with an
# empty memory directory and none of the accumulated project context. Link the
# container's key at the host's, so both read and write one set of files.
link_claude_memory() {
  local root="$HOME/.claude/projects"
  [ -d "$root" ] || { warn "~/.claude not mounted — Claude has no memory or credentials here"; return; }

  local here="${1:-$PWD}"
  local ckey="${here//\//-}"                      # /workspaces/x -> -workspaces-x
  [ -e "$root/$ckey" ] && { ok "memory already linked ($ckey)"; return; }

  # Newest host key ending in the same repository name.
  local hkey
  hkey="$(ls -1t "$root" 2>/dev/null | grep -iE -- "-$(basename "$here")\$" | grep -v "^$ckey\$" | head -1)"
  if [ -z "$hkey" ]; then
    warn "no host project key found for $(basename "$here") — starting with empty memory"
    return
  fi

  ln -s "$root/$hkey" "$root/$ckey" 2>/dev/null \
    && ok "memory linked: $ckey -> $hkey ($(ls -1 "$root/$hkey/memory" 2>/dev/null | wc -l) files)" \
    || warn "could not link $ckey -> $hkey"
}

log "Claude Code project memory"
link_claude_memory /workspaces/discord-scoutid-linked-role

# --- Report ----------------------------------------------------------------
log "Toolchain"
printf '  %-12s %s\n' \
  node      "$(node --version 2>/dev/null || echo MISSING)" \
  npm       "$(npm --version 2>/dev/null || echo MISSING)" \
  az        "$(az version --query '\"azure-cli\"' -o tsv 2>/dev/null || echo MISSING)" \
  kubectl   "$(kubectl version --client -o json 2>/dev/null | jq -r .clientVersion.gitVersion || echo MISSING)" \
  kustomize "$(kustomize version 2>/dev/null || echo MISSING)" \
  terraform "$(terraform version -json 2>/dev/null | jq -r .terraform_version || echo MISSING)" \
  gh        "$(gh --version 2>/dev/null | head -1 | awk '{print $3}' || echo MISSING)" \
  docker    "$(docker --version 2>/dev/null | awk '{print $3}' | tr -d , || echo MISSING)" \
  dig       "$(dig -v 2>&1 | head -1 || echo MISSING)" \
  claude    "$(claude --version 2>/dev/null | awk '{print $1}' || echo MISSING)"

log "Kubernetes"
if kubectl config current-context >/dev/null 2>&1; then
  ok "KUBECONFIG=$KUBECONFIG (context: $(kubectl config current-context))"
else
  warn "no context — is ~/.kube/wsj27.yaml present on the host?"
fi

log "Azure"
if az account show >/dev/null 2>&1; then
  ok "signed in: $(az account show --query name -o tsv) ($(az account show --query user.name -o tsv))"
else
  warn "not signed in. AZURE_CONFIG_DIR is a container-only volume, so the"
  warn "Windows session does not carry over. Sign in with:"
  printf '\n    az login --tenant 317a47ba-fd32-41b8-8ebe-310a1adc9863\n'
  printf '    az account set --subscription d4887907-2e73-4465-9fe3-44c82ed016d6\n'
fi

printf '\n'
