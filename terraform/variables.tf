variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run"
  type        = string
  default     = "us-central1"
}

variable "openrouter_api_key" {
  description = "OpenRouter API key (used as ANTHROPIC_AUTH_TOKEN)"
  type        = string
  sensitive   = true
}

variable "agent_api_key" {
  description = "API key for authenticating to the Swarm service"
  type        = string
  sensitive   = true
}

variable "image" {
  description = "Docker image URL (e.g. gcr.io/project/claude-swarm:latest)"
  type        = string
}

# Optional MCP credentials
variable "notion_api_key" {
  description = "Notion API key for MCP"
  type        = string
  default     = ""
  sensitive   = true
}

variable "github_token" {
  description = "GitHub token for MCP"
  type        = string
  default     = ""
  sensitive   = true
}

variable "slack_token" {
  description = "Slack token for MCP"
  type        = string
  default     = ""
  sensitive   = true
}

variable "google_credentials" {
  description = "Google Calendar credentials for MCP"
  type        = string
  default     = ""
  sensitive   = true
}

# Cloud Run access control
variable "cloud_run_invokers" {
  description = "IAM members allowed to invoke the Cloud Run service (e.g. [\"user:you@example.com\"] or [\"allUsers\"] for public access)"
  type        = list(string)
  default     = []
  sensitive   = true
}

# GitHub Actions CI/CD — set github_repo to enable Workload Identity Federation
variable "github_repo" {
  description = "GitHub repo (org/name) for WIF CI/CD (e.g. \"myorg/myrepo\"). Leave empty to skip WIF setup."
  type        = string
  default     = ""
}

# Billing budget
variable "billing_account_id" {
  description = "GCP billing account ID for budget alerts (e.g. \"XXXXXX-XXXXXX-XXXXXX\")"
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "Monthly budget cap in USD. Alerts fire at 50%, 90%, and 100% of this amount."
  type        = number
  default     = 100
}

# Terraform remote state
variable "terraform_state_bucket" {
  description = "GCS bucket name for storing Terraform remote state"
  type        = string
  default     = ""
}

# Cloud Monitoring alerts
variable "alert_notification_email" {
  description = "Email address for Cloud Monitoring alert notifications. Leave empty to disable alert policies."
  type        = string
  default     = ""
}
