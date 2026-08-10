output "resource_group_name" {
  description = "Name of the resource group"
  value       = azurerm_resource_group.main.name
}

output "container_registry_login_server" {
  description = "Container registry login server URL"
  value       = azurerm_container_registry.main.login_server
}

output "container_registry_name" {
  description = "Container registry name"
  value       = azurerm_container_registry.main.name
}

output "container_app_url" {
  description = "URL of the deployed container app"
  value       = "https://${azurerm_container_app.main.latest_revision_fqdn}"
}

output "container_app_name" {
  description = "Name of the container app"
  value       = azurerm_container_app.main.name
}

output "storage_account_name" {
  description = "Name of the storage account backing ScoutID links and tokens"
  value       = azurerm_storage_account.main.name
}

output "discord_redirect_uri" {
  description = "Discord OAuth redirect URI (update this in Discord Developer Portal)"
  value       = "https://${trimsuffix(azurerm_dns_cname_record.project_cname.fqdn, ".")}/discord-oauth-callback"
}

output "discord_validation_url" {
  description = "Discord validation URL (update this in Discord Developer Portal)"
  value       = "https://${trimsuffix(azurerm_dns_cname_record.project_cname.fqdn, ".")}/linked-role"
}

output "scoutid_redirect_uri" {
  description = "ScoutID OAuth redirect URI (update this in ScoutID settings)"
  value       = "https://${trimsuffix(azurerm_dns_cname_record.project_cname.fqdn, ".")}/scoutid-oauth-callback"
}

output "discord_interactions_url" {
  description = "Discord interactions endpoint URL (set in Discord Developer Portal > General Information)"
  value       = "https://${trimsuffix(azurerm_dns_cname_record.project_cname.fqdn, ".")}/interactions"
}

output "deployment_commands" {
  description = "Commands to push Docker image to ACR"
  value       = <<-EOT
    # Login to Azure Container Registry
    az acr login --name ${azurerm_container_registry.main.name}

    # Build and tag the Docker image
    docker build -t ${azurerm_container_registry.main.login_server}/${var.docker_image_name}:${var.docker_image_tag} .

    # Push the image to ACR
    docker push ${azurerm_container_registry.main.login_server}/${var.docker_image_name}:${var.docker_image_tag}

    # Restart the container app to use the new image
    az containerapp revision restart --name ${azurerm_container_app.main.name} --resource-group ${azurerm_resource_group.main.name}
  EOT
}
