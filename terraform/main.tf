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

# Log Analytics Workspace for Container Apps
resource "azurerm_log_analytics_workspace" "main" {
  name                = "logs-${var.project_name}-${var.environment}-${var.location-abbr}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

# Container Apps Environment
resource "azurerm_container_app_environment" "main" {
  name                       = "appenv-${var.project_name}-${var.environment}-${var.location-abbr}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  tags                       = var.tags
}


# Container App
resource "azurerm_container_app" "main" {
  name                         = "app-${var.project_name}-${var.environment}-${var.location-abbr}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = var.tags
  max_inactive_revisions       = 2

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = "discord-scoutid-app"
      image  = "${azurerm_container_registry.main.login_server}/${var.docker_image_name}:${var.docker_image_tag}"
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "PORT"
        value = "3000"
      }

      env {
        name        = "TABLE_CONNECTION_STRING"
        secret_name = "table-connection-string"
      }

      env {
        name  = "TABLE_NAME"
        value = azurerm_storage_table.links.name
      }

      env {
        name        = "DISCORD_TOKEN"
        secret_name = "discord-token"
      }

      env {
        name        = "DISCORD_CLIENT_ID"
        secret_name = "discord-client-id"
      }

      env {
        name        = "DISCORD_CLIENT_SECRET"
        secret_name = "discord-client-secret"
      }

      env {
        name        = "DISCORD_PUBLIC_KEY"
        secret_name = "discord-public-key"
      }

      env {
        name  = "DISCORD_REDIRECT_URI"
        value = "https://${var.project_name}.wsj27.scouterna.net/discord-oauth-callback"
      }

      env {
        name  = "DISCORD_VALIDATION_URL"
        value = "https://${var.project_name}.wsj27.scouterna.net/linked-role"
      }

      env {
        name        = "DISCORD_GUILD_ID"
        secret_name = "discord-guild-id"
      }

      env {
        name        = "SCOUTID_CLIENT_ID"
        secret_name = "scoutid-client-id"
      }

      env {
        name        = "SCOUTID_CLIENT_SECRET"
        secret_name = "scoutid-client-secret"
      }

      env {
        name  = "SCOUTID_REDIRECT_URI"
        value = "https://${var.project_name}.wsj27.scouterna.net/scoutid-oauth-callback"
      }

      env {
        name        = "COOKIE_SECRET"
        secret_name = "cookie-secret"
      }

      env {
        name  = "SCOUTNET_EVENT_ID"
        value = var.scoutnet_event_id
      }

      env {
        name        = "SCOUTNET_PARTICIPANTS_APIKEY"
        secret_name = "scoutnet-participants-apikey"
      }

      env {
        name  = "SCOUTNET_SCOUT_ROLE"
        value = var.scoutnet_scout_role
      }

      env {
        name  = "SCOUTNET_EVENT_ROLE"
        value = var.scoutnet_event_role
      }

      env {
        name  = "SCOUTNET_FEE_ROLES"
        value = var.scoutnet_fee_roles
      }

      env {
        name  = "SCOUTNET_DIVISION_ROLES"
        value = var.scoutnet_division_roles
      }

      env {
        name  = "SCOUTNET_NICKNAME_SUFFIXES"
        value = var.scoutnet_nickname_suffixes
      }
    }
  }

  secret {
    name  = "table-connection-string"
    value = azurerm_storage_account.main.primary_connection_string
  }

  secret {
    name  = "discord-token"
    value = var.discord_token
  }

  secret {
    name  = "discord-client-id"
    value = var.discord_client_id
  }

  secret {
    name  = "discord-client-secret"
    value = var.discord_client_secret
  }

  secret {
    name  = "discord-guild-id"
    value = var.discord_guild_id
  }

  secret {
    name  = "scoutid-client-id"
    value = var.scoutid_client_id
  }

  secret {
    name  = "scoutid-client-secret"
    value = var.scoutid_client_secret
  }

  secret {
    name  = "cookie-secret"
    value = var.cookie_secret
  }

  secret {
    name  = "discord-public-key"
    value = var.discord_public_key
  }

  secret {
    name  = "scoutnet-participants-apikey"
    value = var.scoutnet_participants_apikey
  }

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  ingress {
    allow_insecure_connections = false
    external_enabled           = true
    target_port                = 3000
    transport                  = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

# DNS CNAME Record for Discord ScoutID Linker - points to Container App default domain
resource "azurerm_dns_cname_record" "project_cname" {
  name                = var.project_name
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = azurerm_resource_group.shared.name
  ttl                 = 3600
  record              = azurerm_container_app.main.latest_revision_fqdn
  tags                = var.tags
}

# DNS TXT Record for Container App Custom Domain Verification
resource "azurerm_dns_txt_record" "project_cname_verify" {
  name                = "asuid.${var.project_name}"
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = azurerm_resource_group.shared.name
  ttl                 = 3600

  record {
    value = "D518F2D5350C431D2056B3C713EF3768B3AB5A91926CD1CD81DFF4D84B9BEE85"
  }

  tags = var.tags
}
