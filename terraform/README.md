# Azure infrastructure

Terraform for deploying the bot to Azure Container Apps. Roughly $12–15/month:
Container Apps ~$5 (one warm replica), Container Registry Basic ~$5, Log
Analytics ~$2–5, Table Storage effectively free at this volume.

## Resources

| Resource                | Name                              | Purpose                                       |
| ----------------------- | --------------------------------- | --------------------------------------------- |
| Container App           | `app-discord-scoutid-prod-sec`    | Runs the bot; all secrets are app secrets      |
| Storage Account (Table) | `stdiscordscoutidprodsec`         | Durable links, OAuth tokens, OAuth state       |
| Container Registry      | `acrwsj27prodsec`                 | Docker images (shared resource group)          |
| Log Analytics           | `logs-discord-scoutid-prod-sec`   | Container logs, 30-day retention               |
| DNS CNAME + TXT         | `discord-scoutid.wsj27.scouterna.net` | Custom domain and its verification record  |

`shared.tf` holds resources shared with other WSJ27 projects — the registry and
the DNS zone — in `rg-wsj27-shared-sec`. Everything else lives in
`rg-discord-scoutid-prod-sec`.

`min_replicas` must stay at 1: Discord drops any interaction not acknowledged
within 3 seconds, which a scale-to-zero cold start cannot meet.

## Remote state

State lives in Azure Blob Storage ([backend.tf](backend.tf)) — locking comes from
blob leases, so nothing else is needed. **The state blob contains every secret in
the configuration in plaintext**, so treat access to it as access to the bot.

Bootstrap once — the account cannot be created by the Terraform whose state it
holds:

```bash
RG=rg-wsj27-shared-sec
SA=stwsj27tfstatesec   # globally unique; adjust here and in backend.tf if taken

az storage account create -n $SA -g $RG --sku Standard_LRS \
  --min-tls-version TLS1_2 --allow-blob-public-access false
az storage container create -n tfstate --account-name $SA --auth-mode login
az storage account blob-service-properties update -n $SA \
  --enable-versioning true --enable-delete-retention true --delete-retention-days 30
az lock create --name no-delete-tfstate --lock-type CanNotDelete \
  --resource-group $RG --resource $SA \
  --resource-type Microsoft.Storage/storageAccounts

cd terraform && terraform init -migrate-state
```

Versioning plus soft delete is the recovery path from a corrupted apply; the
lock stops anyone deleting the account by accident.

With no key configured, the backend fetches the account key through ARM, which
subscription Contributor may do — so this works with `az login` alone. Once the
pipeline identity **and** every human who runs Terraform hold
`Storage Blob Data Contributor` on the container, uncomment `use_azuread_auth`
in [backend.tf](backend.tf) and run
`az storage account update -n $SA -g $RG --allow-shared-key-access false`. That
removes the account key entirely. Doing it earlier locks you out of your own
state, since granting that role needs permissions Contributor does not have.

After migrating, delete the local `terraform.tfstate*` files and any stale
`.terraform.tfstate.lock.info`.

## First-time setup

Terraform authenticates through the Azure CLI, so point the CLI at this
project's tenant first. Use a dedicated config dir if your default `az` login
belongs to another tenant — otherwise logging in here retargets that session:

```bash
export AZURE_CONFIG_DIR="$PWD/../.azure-scouterna"   # gitignored
az login
az account set --subscription <subscription-id>

# One-time per subscription
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights
az provider register --namespace Microsoft.ContainerRegistry
az provider register --namespace Microsoft.Storage
```

Registration takes a few minutes; check with
`az provider show -n Microsoft.App --query registrationState -o tsv`.

Configuration is split in two. `terraform.tfvars` is committed and holds
non-sensitive settings — region, scaling, role mappings. Secrets go in
`secrets.tfvars`, which is gitignored:

```bash
cp secrets.tfvars.example secrets.tfvars   # then fill in real values
terraform init
```

## Deploying

Both var-files are required on every run:

```bash
terraform plan  -var-file=terraform.tfvars -var-file=secrets.tfvars
terraform apply -var-file=terraform.tfvars -var-file=secrets.tfvars
```

`docker_image_tag` must be a git SHA: Container Apps only creates a new revision
when the image string changes, so a mutable tag silently keeps the old container
running. The variable has no default and rejects `latest`, `main` and `master`
outright. CI passes the SHA it built; for a manual apply, the value in
`terraform.tfvars` must match what is actually deployed, or the apply rolls
production back to an older image.

After the first apply, `terraform output` prints the URLs to paste into the
Discord Developer Portal and ScoutID's client registration:

```bash
terraform output discord_validation_url    # Linked Roles Verification URL
terraform output discord_interactions_url  # Interactions Endpoint URL
terraform output discord_redirect_uri      # OAuth2 redirect
terraform output scoutid_redirect_uri      # ScoutID redirect
```

## CI/CD

[plan.yml](../.github/workflows/plan.yml) validates and plans on pull requests;
[deploy.yml](../.github/workflows/deploy.yml) runs on `main`, builds an image
tagged with the commit SHA, pushes it to ACR, and then lets **Terraform** perform
the deployment. Terraform owning the tag is what keeps state from drifting — the
`az containerapp update` path updates the app behind Terraform's back, so the
next apply would roll the image back.

Authentication is GitHub OIDC federation: no cloud credentials are stored.

### One-time setup

Creating the app registration works with ordinary member rights, so you can run
this yourself:

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

**The role assignments need a subscription Owner or User Access Administrator** —
subscription Contributor cannot write role assignments. Hand these over:

```bash
SUB=d4887907-2e73-4465-9fe3-44c82ed016d6
SP=$(az ad sp show --id <APP_ID> --query id -o tsv)

# Manage the app, its RG, and the shared RG (ACR, DNS)
az role assignment create --assignee-object-id $SP --assignee-principal-type ServicePrincipal \
  --role Contributor --scope /subscriptions/$SUB/resourceGroups/rg-discord-scoutid-prod-sec
az role assignment create --assignee-object-id $SP --assignee-principal-type ServicePrincipal \
  --role Contributor --scope /subscriptions/$SUB/resourceGroups/rg-wsj27-shared-sec

# Push images
az role assignment create --assignee-object-id $SP --assignee-principal-type ServicePrincipal \
  --role AcrPush --scope /subscriptions/$SUB/resourceGroups/rg-wsj27-shared-sec/providers/Microsoft.ContainerRegistry/registries/acrwsj27prodsec
```

Add `Storage Blob Data Contributor` on the state container at the same time if
you intend to switch the backend to Entra-only auth.

### GitHub configuration

Repository **variables** (not secrets — none of these are sensitive):
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.

Two **environments**: `prod` with required reviewers, so an apply pauses for
approval, and `prod-plan` with none — it exists only to scope secrets to the plan
job. Each needs the secrets that mirror `secrets.tfvars`: `DISCORD_TOKEN`,
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PUBLIC_KEY`,
`DISCORD_GUILD_ID`, `SCOUTID_CLIENT_ID`, `SCOUTID_CLIENT_SECRET`,
`COOKIE_SECRET`, `SCOUTNET_EVENT_ID`, `SCOUTNET_PARTICIPANTS_APIKEY`.

Because the repository is public: fork and Dependabot PRs receive no credentials,
so the plan job skips them by design, and `pull_request_target` must never be
used here. Consider pinning the third-party actions to commit SHAs.

## Rotating a secret

Terraform is the source of truth — edit `secrets.tfvars` and re-apply. To patch
a single secret without a full apply (it will be reverted on the next one):

```bash
az containerapp secret set \
  --name app-discord-scoutid-prod-sec \
  --resource-group rg-discord-scoutid-prod-sec \
  --secrets "discord-token=<new-value>"

az containerapp revision restart \
  --name app-discord-scoutid-prod-sec \
  --resource-group rg-discord-scoutid-prod-sec
```

## Troubleshooting

- **Container won't start** — `az containerapp logs show --name app-discord-scoutid-prod-sec --resource-group rg-discord-scoutid-prod-sec --tail 100`.
- **New image didn't take effect** — the tag was unchanged. Use a git-SHA tag, or
  add `--revision-suffix <unique>` to `az containerapp update`.
- **Storage errors** — check that `TABLE_CONNECTION_STRING` resolved; it is
  injected from the storage account's primary connection string.
- **OAuth redirect errors** — the portal URIs must match the outputs exactly.

## Teardown

```bash
terraform destroy -var-file=terraform.tfvars -var-file=secrets.tfvars
```

This also removes the shared registry and DNS zone in `shared.tf`, which other
WSJ27 projects may depend on.
