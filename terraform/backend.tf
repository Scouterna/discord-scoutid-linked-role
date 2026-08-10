terraform {
  # Remote state in Azure Blob Storage. Blob leases provide state locking, so no
  # extra lock table is needed. Bootstrap and migration: see terraform/README.md.
  #
  # Authentication: with no explicit key, the backend looks the account key up
  # through ARM (`listKeys`), which subscription Contributor is allowed to do —
  # so this works with nothing but `az login`.
  #
  # Once the pipeline identity and the humans who run Terraform hold
  # "Storage Blob Data Contributor" on the container, uncomment use_azuread_auth
  # and set `--allow-shared-key-access false` on the account. That removes the
  # account key — worth doing, because this blob holds every secret in the
  # configuration in plaintext.
  backend "azurerm" {
    resource_group_name  = "rg-wsj27-shared-sec"
    storage_account_name = "stwsj27tfstatesec"
    container_name       = "tfstate"
    key                  = "discord-scoutid.tfstate"
    # use_azuread_auth   = true
  }
}
