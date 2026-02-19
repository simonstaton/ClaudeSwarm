resource "google_cloud_run_v2_service" "swarm" {
  name     = "claude-swarm"
  location = var.region

  template {
    service_account = google_service_account.swarm.email

    scaling {
      min_instance_count = 0
      # Must be 1: agents live in-memory, multiple instances have separate stores
      max_instance_count = 1
    }

    timeout          = "3600s"
    session_affinity = true

    # High concurrency: SSE streams + polling all need to hit the same instance.
    # With concurrency=2, Cloud Run spins up new instances with empty agent stores.
    max_instance_request_concurrency = 500

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "8"
          memory = "32Gi"
        }
        # Keep CPU allocated between requests so agent processes keep running
        cpu_idle          = false
        startup_cpu_boost = true
      }

      ports {
        container_port = 8080
      }

      # OpenRouter — replaces direct Anthropic API access
      env {
        name  = "ANTHROPIC_BASE_URL"
        value = "https://openrouter.ai/api"
      }

      env {
        name = "ANTHROPIC_AUTH_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.openrouter_api_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "ANTHROPIC_API_KEY"
        value = ""
      }

      env {
        name = "API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.agent_api_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jwt_secret.secret_id
            version = "latest"
          }
        }
      }

      # GCS bucket
      env {
        name  = "GCS_BUCKET"
        value = google_storage_bucket.swarm_data.name
      }

      # Optional MCP env vars
      dynamic "env" {
        for_each = var.notion_api_key != "" ? [1] : []
        content {
          name = "NOTION_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.notion_api_key[0].secret_id
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = var.github_token != "" ? [1] : []
        content {
          name = "GITHUB_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.github_token[0].secret_id
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = var.slack_token != "" ? [1] : []
        content {
          name = "SLACK_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.slack_token[0].secret_id
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = var.google_credentials != "" ? [1] : []
        content {
          name = "GOOGLE_CREDENTIALS"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.google_credentials[0].secret_id
              version = "latest"
            }
          }
        }
      }


      volume_mounts {
        name       = "gcs-fuse"
        mount_path = "/persistent"
      }

      startup_probe {
        http_get {
          path = "/api/health"
          port = 8080
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        failure_threshold     = 12
        timeout_seconds       = 5
      }

      liveness_probe {
        http_get {
          path = "/api/health"
          port = 8080
        }
        period_seconds    = 30
        failure_threshold = 5
        timeout_seconds   = 10
      }
    }

    volumes {
      name = "gcs-fuse"
      gcs {
        bucket    = google_storage_bucket.swarm_data.name
        read_only = false
      }
    }
  }

  # No public access — require IAM authentication
  # To grant access: gcloud run services add-iam-policy-binding claude-swarm --member=user:you@email.com --role=roles/run.invoker
}
