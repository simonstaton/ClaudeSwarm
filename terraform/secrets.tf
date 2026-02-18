resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "google_secret_manager_secret" "openrouter_api_key" {
  secret_id = "openrouter-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "openrouter_api_key" {
  secret      = google_secret_manager_secret.openrouter_api_key.id
  secret_data = var.openrouter_api_key
}

resource "google_secret_manager_secret" "agent_api_key" {
  secret_id = "agent-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "agent_api_key" {
  secret      = google_secret_manager_secret.agent_api_key.id
  secret_data = var.agent_api_key
}

resource "google_secret_manager_secret" "jwt_secret" {
  secret_id = "jwt-secret"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "jwt_secret" {
  secret      = google_secret_manager_secret.jwt_secret.id
  secret_data = random_password.jwt_secret.result
}

# Optional MCP secrets — only created if values provided

resource "google_secret_manager_secret" "notion_api_key" {
  count     = var.notion_api_key != "" ? 1 : 0
  secret_id = "notion-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "notion_api_key" {
  count       = var.notion_api_key != "" ? 1 : 0
  secret      = google_secret_manager_secret.notion_api_key[0].id
  secret_data = var.notion_api_key
}

resource "google_secret_manager_secret" "github_token" {
  count     = var.github_token != "" ? 1 : 0
  secret_id = "github-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "github_token" {
  count       = var.github_token != "" ? 1 : 0
  secret      = google_secret_manager_secret.github_token[0].id
  secret_data = var.github_token
}

resource "google_secret_manager_secret" "slack_token" {
  count     = var.slack_token != "" ? 1 : 0
  secret_id = "slack-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "slack_token" {
  count       = var.slack_token != "" ? 1 : 0
  secret      = google_secret_manager_secret.slack_token[0].id
  secret_data = var.slack_token
}

resource "google_secret_manager_secret" "google_credentials" {
  count     = var.google_credentials != "" ? 1 : 0
  secret_id = "google-credentials"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "google_credentials" {
  count       = var.google_credentials != "" ? 1 : 0
  secret      = google_secret_manager_secret.google_credentials[0].id
  secret_data = var.google_credentials
}

resource "google_secret_manager_secret" "figma_token" {
  count     = var.figma_token != "" ? 1 : 0
  secret_id = "figma-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "figma_token" {
  count       = var.figma_token != "" ? 1 : 0
  secret      = google_secret_manager_secret.figma_token[0].id
  secret_data = var.figma_token
}

resource "google_secret_manager_secret" "linear_api_key" {
  count     = var.linear_api_key != "" ? 1 : 0
  secret_id = "linear-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "linear_api_key" {
  count       = var.linear_api_key != "" ? 1 : 0
  secret      = google_secret_manager_secret.linear_api_key[0].id
  secret_data = var.linear_api_key
}
