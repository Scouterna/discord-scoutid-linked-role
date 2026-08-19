# Node 20 matches package.json engines (>=20) and the runtime Dockerfile's
# node:20-alpine. Debian rather than Alpine so the devcontainer features
# (azure-cli, terraform, gh) install cleanly.
FROM mcr.microsoft.com/devcontainers/javascript-node:20-bookworm

# dnsutils: dig, for DNS verification during the AKS migration.
# jq: reading `az`/`kubectl -o json` output.
# shellcheck: actionlint runs it on every `run:` block in a workflow when it is
#   present, which is where the interesting workflow bugs actually live.
# python3-yaml: a YAML parser for ad-hoc checks. The image ships no pip, so apt
#   is the only way to get one.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends dnsutils jq shellcheck python3-yaml \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# kustomize. `kubectl apply -k` embeds its own copy, but the deploy workflow
# calls `kustomize edit set image`, which only the standalone binary provides.
ARG KUSTOMIZE_VERSION=5.4.3
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${KUSTOMIZE_VERSION}/kustomize_v${KUSTOMIZE_VERSION}_linux_${arch}.tar.gz" \
    | tar -xz -C /usr/local/bin kustomize \
    && chmod 0755 /usr/local/bin/kustomize \
    && kustomize version

# actionlint: static analysis for .github/workflows. Catches what a plain YAML
# parse cannot — undefined `needs` references, misspelled `${{ secrets.* }}`,
# invalid `runs-on` labels — and shells out to shellcheck for `run:` blocks.
# Added after a workflow change had to be validated by pushing it to a branch
# and watching what happened, which is a slow way to find a typo.
ARG ACTIONLINT_VERSION=1.7.12
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_${arch}.tar.gz" \
    | tar -xz -C /usr/local/bin actionlint \
    && chmod 0755 /usr/local/bin/actionlint \
    && actionlint --version

# yq: YAML from the command line, for the k8s manifests and kustomize output.
# Reading them with grep and sed works until it quietly does not.
ARG YQ_VERSION=4.53.4
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL -o /usr/local/bin/yq \
      "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${arch}" \
    && chmod 0755 /usr/local/bin/yq \
    && yq --version
