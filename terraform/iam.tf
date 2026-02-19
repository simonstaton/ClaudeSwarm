resource "google_service_account" "swarm" {
  account_id   = "claude-swarm-sa"
  display_name = "Claude Swarm Service Account"
}

# Secret Manager access
resource "google_secret_manager_secret_iam_member" "anthropic_key" {
  secret_id = google_secret_manager_secret.openrouter_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.swarm.email}"
}

resource "google_secret_manager_secret_iam_member" "agent_key" {
  secret_id = google_secret_manager_secret.agent_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.swarm.email}"
}

resource "google_secret_manager_secret_iam_member" "jwt_secret" {
  secret_id = google_secret_manager_secret.jwt_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.swarm.email}"
}

# GCS bucket access — objectUser allows create, read, and overwrite (but not
# bucket-level admin or ACL changes), which is the minimum needed for syncToGCS.
resource "google_storage_bucket_iam_member" "swarm_storage" {
  bucket = google_storage_bucket.swarm_data.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.swarm.email}"
}

# Optional MCP secret access
resource "google_secret_manager_secret_iam_member" "notion" {
  count     = var.notion_api_key != "" ? 1 : 0
  secret_id = google_secret_manager_secret.notion_api_key[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.swarm.email}"
}

resource "google_secret_manager_secret_iam_member" "github" {
  count     = var.github_token != "" ? 1 : 0
  secret_id = google_secret_manager_secret.github_token[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.swarm.email}"
}

resource "google_secret_manager_secret_iam_member" "slack" {
  count     = var.slack_token != "" ? 1 : 0
  secret_id = google_secret_manager_secret.slack_token[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.swarm.email}"
}

resource "google_secret_manager_secret_iam_member" "google_credentials" {
  count     = var.google_credentials != "" ? 1 : 0
  secret_id = google_secret_manager_secret.google_credentials[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.swarm.email}"
}

# Cloud Run invoker access
resource "google_cloud_run_v2_service_iam_member" "invokers" {
  count    = length(var.cloud_run_invokers)
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.swarm.name
  role     = "roles/run.invoker"
  member   = var.cloud_run_invokers[count.index]
}

# ── GitHub Actions CI/CD (Workload Identity Federation) ───────────────────────
# Only created when github_repo is set

resource "google_iam_workload_identity_pool" "github" {
  count                     = var.github_repo != "" ? 1 : 0
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions Pool"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = var.github_repo != "" ? 1 : 0
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub Provider"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = "assertion.repository=='${var.github_repo}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Allow GitHub Actions to impersonate the Cloud Run service account
resource "google_service_account_iam_member" "wif_impersonate" {
  count              = var.github_repo != "" ? 1 : 0
  service_account_id = google_service_account.swarm.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.github_repo}"
}

# SA can deploy to Cloud Run
resource "google_project_iam_member" "sa_run_developer" {
  count   = var.github_repo != "" ? 1 : 0
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.swarm.email}"
}

# SA can push images to Artifact Registry
resource "google_project_iam_member" "sa_artifact_writer" {
  count   = var.github_repo != "" ? 1 : 0
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.swarm.email}"
}

# SA can act as itself when deploying Cloud Run revisions
resource "google_service_account_iam_member" "sa_self_user" {
  count              = var.github_repo != "" ? 1 : 0
  service_account_id = google_service_account.swarm.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.swarm.email}"
}
