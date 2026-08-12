# Azure infrastructure

The bot itself no longer runs in Azure. It runs on Kubernetes, in namespace
`wsj27` on Scouterna's shared AKS cluster — see [k8s/](../k8s/) and
[CLAUDE.md](../CLAUDE.md). What Terraform still manages here is the durable data
the bot talks to, and the DNS record that points at the cluster.

**Cost.** An earlier version of this file claimed "$12–15/month" for the bot.
That was never true of the bot alone: measured against the subscription budget
in August 2026, **~120 SEK/month (~$12) covered the entire subscription** — both
Discord bots, both Container Apps environments, both Log Analytics workspaces,
the registry, three storage accounts and the DNS zone. With the ScoutID bot's
compute gone, what remains under this configuration is a nearly-empty Standard
LRS storage account and a DNS zone: a few öre and roughly 5 SEK/month
respectively.

## Resources

| Resource                | Name                        | Purpose                                        |
| ----------------------- | --------------------------- | ---------------------------------------------- |
| Storage Account (Table) | `stdiscordscoutidprodsec`   | **Live database** — links, OAuth tokens, state  |
| DNS A record            | `discord-scoutid.wsj27.scouterna.net` | Points at the cluster's traefik LB    |
| DNS Zone                | `wsj27.scouterna.net`       | Shared with other WSJ27 projects                |
| Container Registry      | `acrwsj27prodsec`           | **Transitional** — see below                    |

`shared.tf` holds what is shared with other WSJ27 projects, in
`rg-wsj27-shared-sec`. Everything else lives in `rg-discord-scoutid-prod-sec`,
which now contains only the storage account.

**The registry is only still here because `discord-wsj27-bot` needs it.** That
bot is still on Container Apps, deployed from
`acrwsj27prodsec.azurecr.io/discord-wsj27-bot:latest`. Deleting the registry
before it moves would not break it immediately — the image is cached on the
node — but its next restart would fail to pull, at whatever moment the platform
happened to move it. Delete the registry only once that bot is on GHCR.

## Applying

**Nothing applies this automatically.** [plan.yml](../.github/workflows/plan.yml)
validates and plans on pull requests touching `terraform/**` and posts the plan
as a comment; [deploy.yml](../.github/workflows/deploy.yml) builds the container
image and applies `k8s/` to the cluster, and does not touch Terraform at all.
Applying is a deliberate manual act:

```bash
export AZURE_CONFIG_DIR="$PWD/../.azure-scouterna"   # gitignored; see CLAUDE.md
terraform plan  -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

Only one var-file now. `secrets.tfvars` is obsolete: the bot's secrets moved to
the `discord-scoutid-secrets` Secret in the `wsj27` namespace, so no variable in
this configuration is sensitive any more. The file is gitignored and can be kept
as a local record or deleted.

This configuration is destined for a separate `wsj-infra` repository that owns
all WSJ27 infrastructure and has its own apply pipeline. Infrastructure shared
across projects should not live inside one of them.

## Remote state

State lives in Azure Blob Storage ([backend.tf](backend.tf)) — locking comes from
blob leases, so nothing else is needed.

The state blob no longer contains application secrets, since those variables are
gone. It still describes the whole configuration, so treat it as sensitive.

Bootstrap once — the account cannot be created by the Terraform whose state it
holds:

```bash
RG=rg-wsj27-shared-sec
SA=stwsj27tfstatesec   # globally unique; adjust here and in backend.tf if taken

az storage account create -n $SA -g $RG --sku Standard_LRS \
  --min-tls-version TLS1_2 --allow-blob-public-access false
az storage container create -n tfstate --account-name $SA
az storage account blob-service-properties update -n $SA \
  --enable-versioning true --enable-delete-retention true --delete-retention-days 30

cd terraform && terraform init -migrate-state
```

Versioning plus soft delete is the recovery path from a corrupted apply.

> The `CanNotDelete` lock this file used to instruct you to create **does not
> exist**. Creating one needs `Microsoft.Authorization/*/Write`, which
> subscription Contributor does not have. Accepted, not fixed.

With no key configured, the backend fetches the account key through ARM, which
subscription Contributor may do — so this works with `az login` alone. Note that
`--auth-mode login` is deliberately absent from the container-create command
above for the same reason. Once the pipeline identity **and** every human who
runs Terraform hold `Storage Blob Data Contributor` on the container, uncomment
`use_azuread_auth` in [backend.tf](backend.tf) and run
`az storage account update -n $SA -g $RG --allow-shared-key-access false`. Doing
it earlier locks you out of your own state.

## First-time setup

Terraform authenticates through the Azure CLI, so point the CLI at this
project's tenant first — see [CLAUDE.md](../CLAUDE.md) for why the dedicated
config dir matters.

```bash
export AZURE_CONFIG_DIR="$PWD/../.azure-scouterna"   # gitignored
az login --tenant 317a47ba-fd32-41b8-8ebe-310a1adc9863
az account set --subscription d4887907-2e73-4465-9fe3-44c82ed016d6

az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.Network
terraform init
```

`terraform output` prints the URLs registered in the Discord Developer Portal and
ScoutID's client registration. They are unchanged by the migration — the
hostname stayed the same, which is why neither portal needed touching:

```bash
terraform output discord_validation_url    # Linked Roles Verification URL
terraform output discord_interactions_url  # Interactions Endpoint URL
terraform output discord_redirect_uri      # OAuth2 redirect
terraform output scoutid_redirect_uri      # ScoutID redirect
```

## CI/CD

Authentication is GitHub OIDC federation: no cloud credentials are stored. The
app registration and its federated credentials are described below for the
record — they are still in place, and the identity remains **more privileged
than it now needs to be** (Contributor on both resource groups, plus an
`AcrPush` assignment). Narrowing it needs a subscription Owner, which nobody on
this project has.

```bash
APP_ID=$(az ad app create --display-name gh-discord-scoutid --query appId -o tsv)
az ad sp create --id "$APP_ID"

for SUBJECT in \
  "repo:Scouterna/discord-scoutid-linked-role:ref:refs/heads/main" \
  "repo:Scouterna/discord-scoutid-linked-role:pull_request" \
  "repo:Scouterna/discord-scoutid-linked-role:environment:prod" \
  "repo:Scouterna/discord-scoutid-linked-role:environment:prod-plan"; do
  az ad app federated-credential create --id "$APP_ID" --parameters "{
    \"name\": \"$(echo $SUBJECT | tr ':/' '--')\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"$SUBJECT\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }"
done
```

### GitHub configuration

Repository **variables** (not secrets — none are sensitive):
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.

The `TF_VAR_*` secrets that used to be required are **no longer referenced by
any variable in this configuration**. They can be removed once you are sure
nothing else reads them.

Deploying to the cluster needs `KUBE_CONFIG` — a base64 kubeconfig for the
`github-deployer` service account in namespace `wsj27`. Keep it an
**environment** secret on `prod`, not a repository secret: the repo is public,
the token does not expire, and an environment secret is unreachable from any
workflow that does not declare `environment: prod`.

Because the repository is public: fork and Dependabot PRs receive no
credentials, so the plan job skips them by design, and `pull_request_target`
must never be used here.

## Rotating a secret

The bot's secrets are a Kubernetes Secret, not Terraform state and not Container
Apps secrets:

```bash
export KUBECONFIG=~/.kube/wsj27.yaml
kubectl create secret generic discord-scoutid-secrets \
  --from-env-file=.env.k8s --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deploy/discord-scoutid
```

## Troubleshooting

- **Pod won't start** — `kubectl logs -l app=discord-scoutid --tail=100 --prefix`.
  A CrashLoop immediately after start is almost always a bad
  `TABLE_CONNECTION_STRING`: [src/storage.js](../src/storage.js) builds the
  `TableClient` at module load, so a malformed value fails instantly rather than
  silently serving traffic.
- **`ImagePullBackOff` after a manual apply** — you applied `k8s/` without
  naming an image tag. The committed `newTag` is a placeholder; see
  [CLAUDE.md](../CLAUDE.md).
- **OAuth redirect errors** — the portal URIs must match the outputs exactly.
- **`terraform plan` wants to recreate DNS records** — state has drifted from
  reality. Reconcile with `terraform state rm` / `terraform import` rather than
  applying.
- **DNS checks disagree with reality** — some networks intercept port 53 and
  answer from a stale cache, so `dig`/`nslookup` can report an old record even
  with an explicit `-Server`. Verify over DoH instead:
  `curl -s -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=<host>&type=A'`.

## Teardown

**Do not run `terraform destroy`.** `shared.tf` owns the DNS zone that other
WSJ27 projects depend on, and `main.tf` owns the storage account holding every
ScoutID link. There is no backup of that table — Azure point-in-time restore
does not cover Tables, and LRS replication protects against hardware failure,
not against deletion.

To remove a single resource, delete it from the configuration and apply, so that
state and reality stay in step.
