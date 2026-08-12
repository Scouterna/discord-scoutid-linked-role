# Resource Group
resource "azurerm_resource_group" "shared" {
  name     = "rg-wsj27-shared-${var.location-abbr}"
  location = var.location
  tags     = var.tags
}

# Azure Container Registry (Basic tier - cheapest)
#
# The ScoutID bot no longer uses this — it builds to and pulls from
# ghcr.io/scouterna/discord-scoutid-linked-role. But `discord-wsj27-bot` is
# STILL deployed from `acrwsj27prodsec.azurecr.io/discord-wsj27-bot:latest` on
# Container Apps, so deleting this registry would leave that bot unable to pull
# on its next restart — a failure that would surface long after the change, at
# whatever moment the platform happened to move it.
#
# Delete this only once the wsj27-bot has moved to the cluster and GHCR
# (migration plan, P9), not with the rest of the ScoutID teardown in P8.
resource "azurerm_container_registry" "main" {
  name                = replace("acr-wsj27-${var.environment}-${var.location-abbr}", "-", "")
  resource_group_name = azurerm_resource_group.shared.name
  location            = azurerm_resource_group.shared.location
  sku                 = "Basic"
  admin_enabled       = true
  tags                = var.tags
}

# The DNS zone below is shared with other WSJ27 projects — never
# `terraform destroy` this configuration.

# DNS Zone
resource "azurerm_dns_zone" "main" {
  name                = "wsj27.scouterna.net"
  resource_group_name = azurerm_resource_group.shared.name
  tags                = var.tags
}
