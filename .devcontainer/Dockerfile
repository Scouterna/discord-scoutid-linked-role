# Node 20 matches package.json engines (>=20) and the runtime Dockerfile's
# node:20-alpine. Debian rather than Alpine so the devcontainer features
# (azure-cli, terraform, gh) install cleanly.
FROM mcr.microsoft.com/devcontainers/javascript-node:20-bookworm

# dnsutils: dig, for DNS verification during the AKS migration.
# jq: reading `az`/`kubectl -o json` output.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends dnsutils jq \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# kustomize. `kubectl apply -k` embeds its own copy, but the deploy workflow
# calls `kustomize edit set image`, which only the standalone binary provides.
ARG KUSTOMIZE_VERSION=5.4.3
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${KUSTOMIZE_VERSION}/kustomize_v${KUSTOMIZE_VERSION}_linux_${arch}.tar.gz" \
    | tar -xz -C /usr/local/bin kustomize \
    && chmod 0755 /usr/local/bin/kustomize \
    && kustomize version
