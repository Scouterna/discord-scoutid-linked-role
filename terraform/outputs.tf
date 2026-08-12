output "resource_group_name" {
  description = "Name of the resource group"
  value       = azurerm_resource_group.main.name
}

output "storage_account_name" {
  description = "Name of the storage account backing ScoutID links and tokens"
  value       = azurerm_storage_account.main.name
}

output "discord_redirect_uri" {
  description = "Discord OAuth redirect URI (update this in Discord Developer Portal)"
  value       = "https://${trimsuffix(azurerm_dns_a_record.project_a.fqdn, ".")}/discord-oauth-callback"
}

output "discord_validation_url" {
  description = "Discord validation URL (update this in Discord Developer Portal)"
  value       = "https://${trimsuffix(azurerm_dns_a_record.project_a.fqdn, ".")}/linked-role"
}

output "scoutid_redirect_uri" {
  description = "ScoutID OAuth redirect URI (update this in ScoutID settings)"
  value       = "https://${trimsuffix(azurerm_dns_a_record.project_a.fqdn, ".")}/scoutid-oauth-callback"
}

output "discord_interactions_url" {
  description = "Discord interactions endpoint URL (set in Discord Developer Portal > General Information)"
  value       = "https://${trimsuffix(azurerm_dns_a_record.project_a.fqdn, ".")}/interactions"
}

# The container_registry_*, container_app_* and deployment_commands outputs are
# gone with the resources they described. Deployment is now GitHub Actions:
# build to ghcr.io/scouterna/discord-scoutid-linked-role and `kubectl apply -k
# k8s/` against the wsj27 namespace. See .github/workflows/deploy.yml.
