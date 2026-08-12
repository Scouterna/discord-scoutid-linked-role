variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "tenant_id" {
  description = "Azure tenant ID"
  type        = string
}

variable "project_name" {
  description = "Name of the project, used as prefix for all resources"
  type        = string
  default     = "discord-scoutid"
}

variable "environment" {
  description = "Deployment environment (e.g., prod, staging)"
  type        = string
  default     = "prod"
}

variable "location" {
  description = "Azure region for resources"
  type        = string
  default     = "swedencentral"
}

variable "location-abbr" {
  description = "Azure region abbreviation for resources"
  type        = string
  default     = "sec"
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default = {
    Environment = "production"
    ManagedBy   = "terraform"
  }
}

variable "aks_ingress_ip" {
  description = "Static public IP of the traefik load balancer on Scouterna's shared AKS cluster, where the bot runs"
  type        = string
  default     = "20.238.205.144"

  validation {
    condition     = can(regex("^([0-9]{1,3}[.]){3}[0-9]{1,3}$", var.aks_ingress_ip))
    error_message = "aks_ingress_ip must be a bare IPv4 address."
  }
}

# The application's own configuration and secrets are no longer Terraform's
# concern. They moved to Kubernetes when the bot left Container Apps:
# non-secret values to k8s/configmap.yaml, secrets to the `discord-scoutid-secrets`
# Secret created imperatively in the wsj27 namespace (see the migration plan, P4).
#
# Gone with them: min_replicas / max_replicas (now spec.replicas in
# k8s/deployment.yaml), docker_image_name, and docker_image_tag — the last
# existed only because Azure Container Apps would not create a new revision
# when the image string was unchanged. Kubernetes has no such quirk; CI sets
# the tag via `kustomize edit set image`.
