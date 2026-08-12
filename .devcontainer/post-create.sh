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
install_deps /workspaces/discord-wsj27-bot "discord-wsj27-bot"

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
  dig       "$(dig -v 2>&1 | head -1 || echo MISSING)"

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
