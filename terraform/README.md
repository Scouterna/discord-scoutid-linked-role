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

## First-time setup

```bash
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

Set `docker_image_tag` to the git SHA rather than `latest` — Container Apps only
creates a new revision when the image string changes, so redeploying `latest`
silently keeps the old container. See the [root README](../README.md#deploying).

After the first apply, `terraform output` prints the URLs to paste into the
Discord Developer Portal and ScoutID's client registration:

```bash
terraform output discord_validation_url    # Linked Roles Verification URL
terraform output discord_interactions_url  # Interactions Endpoint URL
terraform output discord_redirect_uri      # OAuth2 redirect
terraform output scoutid_redirect_uri      # ScoutID redirect
```

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
