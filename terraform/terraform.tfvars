# Azure Configuration
project_name    = "discord-scoutid"
location        = "swedencentral" # Sweden Central region
subscription_id = "d4887907-2e73-4465-9fe3-44c82ed016d6"
tenant_id       = "317a47ba-fd32-41b8-8ebe-310a1adc9863"

# Everything else that used to live here — scaling, image name and tag, and the
# role/fee/nickname configuration — moved to Kubernetes with the bot. Role
# config is now k8s/configmap.yaml; secrets are the `discord-scoutid-secrets`
# Secret in the wsj27 namespace. Terraform's remaining job in this repo is the
# storage account holding the ScoutID links, and the DNS record.
