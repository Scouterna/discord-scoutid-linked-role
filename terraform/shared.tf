# Resource Group
resource "azurerm_resource_group" "shared" {
  name     = "rg-wsj27-shared-${var.location-abbr}"
  location = var.location
  tags     = var.tags
}

# Azure Container Registry (Basic tier - cheapest)
resource "azurerm_container_registry" "main" {
  name                = replace("acr-wsj27-${var.environment}-${var.location-abbr}", "-", "")
  resource_group_name = azurerm_resource_group.shared.name
  location            = azurerm_resource_group.shared.location
  sku                 = "Basic"
  admin_enabled       = true
  tags                = var.tags
}

# DNS Zone
resource "azurerm_dns_zone" "main" {
  name                = "wsj27.scouterna.net"
  resource_group_name = azurerm_resource_group.shared.name
  tags                = var.tags
}
