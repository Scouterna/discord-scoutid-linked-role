# Resource Group
resource "azurerm_resource_group" "shared" {
  name     = "rg-wsj27-shared-${var.location-abbr}"
  location = var.location
  tags     = var.tags
}

# The Azure Container Registry lived here until both WSJ27 Discord bots moved
# to the shared AKS cluster. Images are built and pulled from GHCR now —
# ghcr.io/scouterna/discord-scoutid-linked-role and
# ghcr.io/scouterna/wsj27-discord-bot — so nothing in this subscription serves
# containers any more. It was kept alive through Phase 8 purely because the
# wsj27-bot was still pulling from it.
#
# The DNS zone below is shared with other WSJ27 projects — never
# `terraform destroy` this configuration.

# DNS Zone
resource "azurerm_dns_zone" "main" {
  name                = "wsj27.scouterna.net"
  resource_group_name = azurerm_resource_group.shared.name
  tags                = var.tags
}
