# Devcontainer

Covers all three repos of the WSJ27 workspace: this one, `wsj27-infra`
and `wsj27-discord-bot`.

## Opening it

The two sibling repos are bind-mounted from `../`, so they must be cloned next
to this one. **Each directory has to be named exactly like its GitHub
repository** — the bind mounts resolve by name, and a mismatch silently gives
you an empty directory instead of the repo:

```
code/
  discord-scoutid-linked-role/   ← open this one
  wsj27-infra/                   ← Scouterna/wsj27-infra
  wsj27-discord-bot/             ← Scouterna/wsj27-discord-bot
```

Note the bot's repository is `wsj27-discord-bot`, not `discord-wsj27-bot`; the
Kubernetes Deployment it ships *is* called `discord-wsj27-bot`, and those two
names are unrelated.

Open this folder and **Reopen in Container**. For the multi-root view, then open
`/workspaces/discord-scoutid-linked-role/.devcontainer/wsj27.code-workspace`
from inside the container — the host `.code-workspace` uses paths relative to
`~/code`, which does not exist in here.

If a sibling repo is missing, Docker creates an empty directory for it and
`post-create.sh` skips it. Nothing else breaks.

## Tooling

`node` 20 · `npm` · `az` · `kubectl` · `kustomize` · `terraform` · `gh` ·
`docker` · `dig` · `jq`

`docker` is the **host's** daemon (docker-outside-of-docker), so `docker build`
and the repo's `docker-compose.yml` (app + Azurite + ngrok) work from inside.
Because it is the host daemon, bind-mount paths in compose files resolve on the
host, not in the container.

## Credentials

| | |
| --- | --- |
| `KUBECONFIG` | `~/.kube/wsj27.yaml`, bind-mounted from the host. The host's `~/.kube/config` points at rancher-desktop, which does not exist here — hence the explicit default. |
| `AZURE_CONFIG_DIR` | `~/.azure-scouterna`, a **named volume**, not the workspace's `.azure-scouterna`. |

The Azure directory is deliberately not shared with Windows: the MSAL token
cache is encrypted with DPAPI on Windows and libsecret on Linux, so one platform
cannot read the other's tokens and sharing the directory has them clobbering
each other. Sign in once inside the container (it persists across rebuilds):

```bash
az login --tenant 317a47ba-fd32-41b8-8ebe-310a1adc9863
az account set --subscription d4887907-2e73-4465-9fe3-44c82ed016d6
```

## If `npm ci` is skipped

A gitignored `.npmrc` may point npm at an internal mirror behind a
TLS-intercepting proxy. Windows trusts that proxy's root CA from its own
certificate store; this container does not, so `npm ping` fails and
`post-create.sh` leaves `node_modules` alone rather than emptying it.

Either drop the proxy's root CA into `.devcontainer/certs/` (gitignored, `.crt`,
PEM-encoded) and rerun the script, or delete `.npmrc` to use
`registry.npmjs.org`.

## DNS

`dig` is installed because DNS is verified during the AKS migration. Note that
`dig`/`nslookup` inherit the host network, where some resolvers transparently
intercept port 53 and answer from a stale cache — ignoring an explicit
`@server`. To read a record's true state, bypass port 53:

```bash
curl -s -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=discord-scoutid.wsj27.scouterna.net&type=A' | jq
```
