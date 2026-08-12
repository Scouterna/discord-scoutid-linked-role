terraform {
  required_version = ">= 1.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id
}

# Resource Group
resource "azurerm_resource_group" "main" {
  name     = "rg-${var.project_name}-${var.environment}-${var.location-abbr}"
  location = var.location
  tags     = var.tags
}

# Durable key-value storage for ScoutID links and OAuth tokens.
resource "azurerm_storage_account" "main" {
  name                     = replace("st${var.project_name}${var.environment}${var.location-abbr}", "-", "")
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
  tags                     = var.tags
}

resource "azurerm_storage_table" "links" {
  name                 = "scoutidlinks"
  storage_account_name = azurerm_storage_account.main.name
}

# DNS A Record for Discord ScoutID Linker — points at the traefik load balancer
# on Scouterna's shared AKS cluster, where the bot now runs.
#
# This replaced a CNAME to the Container App ingress FQDN, plus an
# `asuid.discord-scoutid` TXT record that existed only for Container Apps
# custom-domain verification. Both are gone: a CNAME cannot coexist with an A
# record at the same name, and nothing verifies the domain any more.
#
# The TTL stays low while the migration beds in, so that recreating the old
# CNAME is a fast rollback. Raise it once the cluster has proven itself.
resource "azurerm_dns_a_record" "project_a" {
  name                = var.project_name
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = azurerm_resource_group.shared.name
  ttl                 = 60
  records             = [var.aks_ingress_ip]
  tags                = var.tags
}
