# Cloud Monitoring Alert Policies — Claude Swarm
#
# Thresholds (tune to environment):
#   High error rate  : 5xx request rate > 5 requests/min (5-min window)
#   High latency     : p99 request latency > 5,000 ms     (5-min window)
#   Crashes          : crashed container count > 0         (2-min window)
#   Memory           : container memory utilization > 80%  (5-min window)
#   CPU              : container CPU utilization > 80%     (5-min window)
#
# Notification channel: email — set alert_notification_email in terraform.tfvars
# All policies are skipped (count = 0) when that variable is empty.

locals {
  swarm_service_name = "claude-swarm"
  alert_channels     = var.alert_notification_email != "" ? [google_monitoring_notification_channel.email_alerts[0].name] : []
  enable_alerts      = var.alert_notification_email != "" ? 1 : 0
}

# ---------------------------------------------------------------------------
# Notification Channel — Email
# ---------------------------------------------------------------------------

resource "google_monitoring_notification_channel" "email_alerts" {
  count        = local.enable_alerts
  display_name = "Claude Swarm — Email Alerts"
  type         = "email"

  labels = {
    email_address = var.alert_notification_email
  }
}

# ---------------------------------------------------------------------------
# Alert: High Error Rate
#
# Fires when the Cloud Run service returns more than 5 HTTP 5xx errors
# per minute, sustained over a 5-minute window.  Adjust threshold_value
# or the alignment_period to suit traffic levels.
# ---------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "high_error_rate" {
  count        = local.enable_alerts
  display_name = "Claude Swarm — High Error Rate"
  combiner     = "OR"

  conditions {
    display_name = "5xx response rate > 5/min"

    condition_threshold {
      # Filter to 5xx responses on the claude-swarm Cloud Run service
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${local.swarm_service_name}\"",
        "metric.type = \"run.googleapis.com/request_count\"",
        "metric.labels.response_code_class = \"5xx\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 5 # total 5xx count per 60s alignment window
      duration        = "300s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.labels.service_name"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = local.alert_channels

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = <<-EOT
      **Alert:** High 5xx error rate on Claude Swarm Cloud Run service.

      **Threshold:** > 5 HTTP 5xx responses per minute (5-minute window)

      **Runbook:**
      1. Check Cloud Run logs: `gcloud logging read 'resource.type=cloud_run_revision AND httpRequest.status>=500'`
      2. Review recent deployments for regressions.
      3. Check downstream service health (Secret Manager, GCS).
    EOT
    mime_type = "text/markdown"
  }
}

# ---------------------------------------------------------------------------
# Alert: High Latency
#
# Fires when the p99 request latency exceeds 5,000 ms over a 5-minute window.
# Cloud Run reports latencies as a distribution; ALIGN_PERCENTILE_99 extracts
# the 99th-percentile value per series.
# ---------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "high_latency" {
  count        = local.enable_alerts
  display_name = "Claude Swarm — High Latency"
  combiner     = "OR"

  conditions {
    display_name = "p99 request latency > 5,000 ms"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${local.swarm_service_name}\"",
        "metric.type = \"run.googleapis.com/request_latencies\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 5000 # milliseconds
      duration        = "300s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MEAN"
        group_by_fields      = ["resource.labels.service_name"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = local.alert_channels

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = <<-EOT
      **Alert:** p99 request latency exceeds 5,000 ms on Claude Swarm.

      **Threshold:** p99 latency > 5,000 ms (5-minute window)

      **Runbook:**
      1. Check Cloud Run instance metrics for CPU/memory saturation.
      2. Inspect slow API routes via Cloud Trace.
      3. Review GCS / Secret Manager latency for upstream bottlenecks.
      4. Consider scaling limits — service is capped at 1 instance.
    EOT
    mime_type = "text/markdown"
  }
}

# ---------------------------------------------------------------------------
# Alert: Container Crashes
#
# Fires when any Cloud Run container enters the "crashed" state.
# instance_count with state="crashed" is a gauge; alerting on > 0 means
# at least one crash occurred in the 2-minute window.
# ---------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "container_crashes" {
  count        = local.enable_alerts
  display_name = "Claude Swarm — Container Crashes"
  combiner     = "OR"

  conditions {
    display_name = "Crashed container instance count > 0"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${local.swarm_service_name}\"",
        "metric.type = \"run.googleapis.com/container/instance_count\"",
        "metric.labels.state = \"crashed\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 0 # any crashed instance triggers the alert
      duration        = "120s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["resource.labels.service_name"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = local.alert_channels

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = <<-EOT
      **Alert:** A Claude Swarm container has crashed.

      **Threshold:** crashed instance count > 0 (2-minute window)

      **Runbook:**
      1. Check Cloud Run logs for OOM or panic errors.
      2. Inspect recent deploys — a bad image may cause boot crashes.
      3. Check memory limits; OOM kills appear as crashes.
      4. Review startup probe configuration if the service fails to start.
    EOT
    mime_type = "text/markdown"
  }
}

# ---------------------------------------------------------------------------
# Alert: High Memory Utilization
#
# Fires when the p99 container memory utilization exceeds 80% over
# a 5-minute window.  Value range is 0–1 (0% – 100%).
# ---------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "high_memory" {
  count        = local.enable_alerts
  display_name = "Claude Swarm — High Memory Utilization"
  combiner     = "OR"

  conditions {
    display_name = "Container memory utilization > 80%"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${local.swarm_service_name}\"",
        "metric.type = \"run.googleapis.com/container/memory/utilizations\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 0.80 # 80% — range is 0.0–1.0
      duration        = "300s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MEAN"
        group_by_fields      = ["resource.labels.service_name"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = local.alert_channels

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = <<-EOT
      **Alert:** Container memory utilization exceeds 80% on Claude Swarm.

      **Threshold:** p99 memory utilization > 80% (5-minute window)
      **Current limit:** 32 GiB (see cloud-run.tf)

      **Runbook:**
      1. Check agent count — each spawned agent consumes memory.
      2. Look for memory leaks in agent process lifecycle (src/agents.ts).
      3. Consider increasing the Cloud Run memory limit if usage is expected.
      4. At ~95% utilization the service risks OOM crashes.
    EOT
    mime_type = "text/markdown"
  }
}

# ---------------------------------------------------------------------------
# Alert: High CPU Utilization
#
# Fires when the p99 container CPU utilization exceeds 80% over
# a 5-minute window.  Value range is 0–1 (0% – 100%).
# ---------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "high_cpu" {
  count        = local.enable_alerts
  display_name = "Claude Swarm — High CPU Utilization"
  combiner     = "OR"

  conditions {
    display_name = "Container CPU utilization > 80%"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "resource.labels.service_name = \"${local.swarm_service_name}\"",
        "metric.type = \"run.googleapis.com/container/cpu/utilizations\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 0.80 # 80% — range is 0.0–1.0
      duration        = "300s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MEAN"
        group_by_fields      = ["resource.labels.service_name"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = local.alert_channels

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = <<-EOT
      **Alert:** Container CPU utilization exceeds 80% on Claude Swarm.

      **Threshold:** p99 CPU utilization > 80% (5-minute window)
      **Current limit:** 8 vCPUs (see cloud-run.tf)

      **Runbook:**
      1. Check active agent count and concurrent spawning.
      2. Review Node.js CPU profiling for hot loops.
      3. Inspect SSE streaming load — many open connections increase CPU.
      4. Consider whether the 8 vCPU limit needs to be raised.
    EOT
    mime_type = "text/markdown"
  }
}
