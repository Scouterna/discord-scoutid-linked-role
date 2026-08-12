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

variable "min_replicas" {
  description = "Minimum number of container replicas"
  type        = number
  default     = 1 # Must be >= 1: Discord interaction ACKs need <3s; a cold start can't meet that
}

variable "max_replicas" {
  description = "Maximum number of container replicas"
  type        = number
  default     = 2
}

variable "docker_image_name" {
  description = "Docker image name"
  type        = string
  default     = "discord-scoutid-linked-role"
}

variable "docker_image_tag" {
  description = "Docker image tag — always an immutable git SHA, set by CI"
  type        = string

  # Container Apps only creates a new revision when the image *string* changes,
  # so a mutable tag silently keeps the old container running. No default: the
  # tag must be stated explicitly by whoever deploys.
  validation {
    condition     = !contains(["latest", "main", "master"], var.docker_image_tag)
    error_message = "Use an immutable git-SHA tag. A mutable tag leaves Container Apps running the previous image, because the image string never changes."
  }
}

# Discord Configuration
variable "discord_token" {
  description = "Discord bot token"
  type        = string
  sensitive   = true
}

variable "discord_client_id" {
  description = "Discord client ID"
  type        = string
  sensitive   = true
}

variable "discord_client_secret" {
  description = "Discord client secret"
  type        = string
  sensitive   = true
}

variable "discord_public_key" {
  description = "Discord application public key (for interaction verification)"
  type        = string
  sensitive   = true
}

variable "discord_guild_id" {
  description = "Discord guild ID"
  type        = string
  sensitive   = true
}

# ScoutID Configuration
variable "scoutid_client_id" {
  description = "ScoutID client ID"
  type        = string
  sensitive   = true
}

variable "scoutid_client_secret" {
  description = "ScoutID client secret"
  type        = string
  sensitive   = true
}

# Application Configuration
variable "cookie_secret" {
  description = "Secret for cookie encryption"
  type        = string
  sensitive   = true
}

# ScoutNet Configuration
variable "scoutnet_event_id" {
  description = "ScoutNet event ID"
  type        = string
  default     = ""
}

variable "scoutnet_participants_apikey" {
  description = "ScoutNet participants API key"
  type        = string
  sensitive   = true
  default     = ""
}

# Role Configuration
variable "scoutnet_scout_role" {
  description = "Discord role name for verified scouts"
  type        = string
  default     = "scout"
}

variable "scoutnet_event_role" {
  description = "Discord role name for event participants"
  type        = string
  default     = "participant"
}

variable "scoutnet_fee_roles" {
  description = "Fee-to-role mapping (format: fee_id:role_name,fee_id:role_name)"
  type        = string
  default     = ""
}

variable "scoutnet_division_roles" {
  description = "Division role patterns per category (format: category:questionId:withDiv:withoutDiv,...)"
  type        = string
  default     = ""
}

variable "scoutnet_nickname_suffixes" {
  description = "Nickname suffix per category (format: category:withDiv:withoutDiv,...)"
  type        = string
  default     = ""
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
