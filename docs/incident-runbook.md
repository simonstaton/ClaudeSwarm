# Incident Response Runbook - AgentManager

**Platform:** GCP Cloud Run · TypeScript/Express · React/Next.js · Google Cloud Storage
**Last Updated:** 2026-02-19
**Severity Levels:** P0 (critical, immediate) · P1 (high, < 1h) · P2 (medium, < 4h) · P3 (low, next business day)

For deploy commands that use `--image=...`, set `REGION` and `PROJECT_ID` (e.g. `export REGION=us-central1 PROJECT_ID=your-project-id`). The image uses Artifact Registry: `$REGION-docker.pkg.dev/$PROJECT_ID/agent-manager/agent-manager:latest`.

---

## Table of Contents

1. [Crash Recovery](#1-crash-recovery)
2. [Stuck Agents](#2-stuck-agents)
3. [High Memory / CPU](#3-high-memory--cpu)
4. [API Unresponsive](#4-api-unresponsive)
5. [GCS Failures](#5-gcs-failures)
6. [Auth Failures](#6-auth-failures)
7. [Escalation Contacts](#7-escalation-contacts)
8. [Quick Reference Commands](#8-quick-reference-commands)

---

## 1. Crash Recovery

**Severity:** P0

### Symptoms

- Cloud Run service returns 5xx errors or shows `0/0` instances in GCP Console
- `gcloud run services describe` shows `FAILED` or no ready condition
- Health check endpoint `/api/health` returns connection refused or 503
- Agents stop receiving/sending messages; UI shows blank or error state
- Logs show unhandled exception, OOM kill (`signal 9`), or process exit

### Diagnosis

```bash
# 1. Check service status and recent revisions
gcloud run services describe agent-manager \
  --region=us-central1 \
  --format="yaml(status,spec.template.metadata)"

# 2. Tail recent stderr for crash cause
gcloud logging read \
  'resource.type="cloud_run_revision" severity>=ERROR' \
  --limit=50 \
  --format="table(timestamp,textPayload)" \
  --freshness=10m

# 3. Check if a specific revision is failing
gcloud run revisions list \
  --service=agent-manager \
  --region=us-central1 \
  --format="table(name,status.conditions[0].type,status.conditions[0].status)"

# 4. Check instance count (0 = crashed, not scaling)
gcloud run services describe agent-manager \
  --region=us-central1 \
  --format="value(status.observedGeneration,status.traffic[0].percent)"

# 5. Test health endpoint
curl -sf https://<SERVICE_URL>/api/health || echo "HEALTH CHECK FAILED"
```

### Remediation

**Step 1 - Confirm crash scope**
```bash
# Check if Cloud Run auto-restarted successfully
gcloud run revisions list --service=agent-manager --region=us-central1
```

**Step 2 - Rollback to last known-good revision**
```bash
# List recent revisions and their traffic allocation
gcloud run revisions list --service=agent-manager --region=us-central1

# Roll back to previous revision
gcloud run services update-traffic agent-manager \
  --region=us-central1 \
  --to-revisions=<PREVIOUS_REVISION>=100
```

**Step 3 - Force new deployment if rollback not viable**
```bash
# Re-deploy from container registry (Cloud Build or manual)
gcloud run deploy agent-manager \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/agent-manager/agent-manager:latest \
  --region=us-central1 \
  --min-instances=1 \
  --max-instances=10
```

**Step 4 - Verify recovery**
```bash
# Confirm healthy response
curl -sf https://<SERVICE_URL>/api/health && echo "OK"

# Check agents can authenticate and communicate
curl -H "Authorization: Bearer <TOKEN>" \
  https://<SERVICE_URL>/api/agents/registry
```

**Step 5 - Check GCS state integrity post-crash**
```bash
# Confirm shared-context files are intact
gsutil ls gs://<BUCKET>/shared-context/

# Check for partial writes (objects < 100 bytes may be corrupt)
gsutil ls -l gs://<BUCKET>/shared-context/ | awk '$1 < 100 {print $3, "SUSPECT"}'
```

### Escalation

- If crash recurs within 30 minutes -> P0 escalation to on-call engineer
- If OOM is the cause -> escalate to review memory limits in Cloud Run config
- If data corruption detected in GCS -> escalate to data integrity review

---

## 2. Stuck Agents

**Severity:** P1

### Symptoms

- Agent shows `running` status but produces no output for > 15 minutes
- Agent's `currentTask` field unchanged for an extended period
- Agent does not respond to messages sent via `/api/messages`
- UI shows agent as active but no log activity
- Message queue grows without consumption

### Diagnosis

```bash
# 1. Check agent registry for stuck agents
curl -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  http://localhost:8080/api/agents/registry \
  | jq '.[] | select(.status=="running") | {id, name, currentTask, updatedAt}'

# 2. Check agent logs for last activity
curl -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  "http://localhost:8080/api/agents/<AGENT_ID>/logs?tail=50&type=stderr,system&format=text"

# 3. Check unread messages piling up for a specific agent
curl -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  "http://localhost:8080/api/messages?to=<AGENT_ID>&unreadBy=<AGENT_ID>" \
  | jq 'length'

# 4. Check Cloud Run logs for subprocess hang
gcloud logging read \
  'resource.type="cloud_run_revision" jsonPayload.agentId="<AGENT_ID>"' \
  --limit=30 \
  --format="table(timestamp,jsonPayload.message)"

# 5. Check if agent process is consuming CPU (stuck loop vs. blocked I/O)
gcloud monitoring read \
  'metric.type="run.googleapis.com/container/cpu/utilizations"' \
  --interval="PT5M"
```

### Remediation

**Step 1 - Send interrupt message**
```bash
# Send an interrupt to attempt graceful recovery
curl -X POST \
  -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  -H "Content-Type: application/json" \
  -d '{"from":"<YOUR_AGENT_ID>","fromName":"ops","to":"<STUCK_AGENT_ID>","type":"interrupt","content":"Health check: please report status or restart task"}' \
  http://localhost:8080/api/messages
```

**Step 2 - Force-destroy the stuck agent**
```bash
# Destroy the agent via API (platform will clean up its process)
curl -X DELETE \
  -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  http://localhost:8080/api/agents/<STUCK_AGENT_ID>
```

**Step 3 - Re-spawn the agent with original task**
```bash
# Spawn a replacement agent
curl -X POST \
  -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "<ORIGINAL_TASK_PROMPT>",
    "name": "<AGENT_NAME>",
    "model": "claude-sonnet-4-6",
    "role": "<ROLE>",
    "parentId": "<PARENT_AGENT_ID>"
  }' \
  http://localhost:8080/api/agents
```

**Step 4 - Clear stale messages**
```bash
# If message queue is polluted, clear messages for the agent
# (use the clear-messages API if available)
curl -X POST \
  -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"<STUCK_AGENT_ID>"}' \
  http://localhost:8080/api/messages/<MSG_ID>/read
```

### Escalation

- If multiple agents stuck simultaneously -> suspect platform-level issue -> P0 escalation
- If agent repeatedly gets stuck on same task -> P1 escalation to review task complexity / prompt
- If destroy API fails -> escalate to check Cloud Run subprocess management

---

## 3. High Memory / CPU

**Severity:** P1 (memory pressure causing evictions) · P2 (sustained high utilization without evictions)

### Symptoms

- Cloud Run container hitting memory limit -> OOM kills -> automatic restarts
- Increased response latency (> 2s for simple API calls)
- `gcloud monitoring` shows CPU utilization consistently > 80%
- Memory utilization consistently > 85% of configured limit
- Agents being evicted mid-task due to container restarts
- Log entries: `Container killed due to memory limit exceeded`

### Diagnosis

```bash
# 1. Check current CPU and memory metrics
gcloud monitoring metrics list \
  --filter="metric.type:run.googleapis.com/container"

# 2. Query memory utilization (last 10 minutes)
gcloud logging read \
  'resource.type="cloud_run_revision" textPayload:"memory"' \
  --limit=20 \
  --freshness=10m

# 3. Check active agent count (more agents = more memory)
curl -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  http://localhost:8080/api/agents/registry \
  | jq '[.[] | select(.status!="terminated")] | length'

# 4. Check OOM events in logs
gcloud logging read \
  'resource.type="cloud_run_revision" textPayload:"signal 9" OR textPayload:"OOM"' \
  --limit=10 \
  --freshness=30m

# 5. Identify agents with large GCS payloads (potential memory pressure)
gsutil ls -l gs://<BUCKET>/shared-context/ | sort -n | tail -20
```

### Remediation

**Immediate - Reduce active agent count**
```bash
# List all running agents
curl -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  http://localhost:8080/api/agents/registry \
  | jq '.[] | select(.status=="running") | {id, name, role}'

# Destroy idle/low-priority agents
curl -X DELETE \
  -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  http://localhost:8080/api/agents/<LOW_PRIORITY_AGENT_ID>
```

**Scale Cloud Run memory/CPU limits**
```bash
# Increase memory limit for the service
gcloud run services update agent-manager \
  --region=us-central1 \
  --memory=4Gi \
  --cpu=2
```

**Scale out instances to distribute load**
```bash
# Increase max instances to spread concurrent requests
gcloud run services update agent-manager \
  --region=us-central1 \
  --min-instances=2 \
  --max-instances=20 \
  --concurrency=50
```

**Clear GCS shared-context files accumulation**
```bash
# List large objects that may be loaded into memory
gsutil ls -l gs://<BUCKET>/shared-context/ | sort -rn | head -10
```

**Verify recovery**
```bash
# Confirm memory stabilized
gcloud logging read \
  'resource.type="cloud_run_revision" severity=ERROR' \
  --freshness=5m \
  --limit=5

curl -sf https://<SERVICE_URL>/api/health && echo "OK"
```

### Escalation

- If OOM kills persist after scaling -> P0 escalation to review memory leak in agent processes
- If CPU stays at 100% with no load increase -> suspect runaway agent loop -> P1
- If scaling is blocked by quota -> escalate to GCP quota increase request

---

## 4. API Unresponsive

**Severity:** P0 (complete outage) · P1 (partial/slow responses)

### Symptoms

- HTTP requests to `/api/*` time out or return 503/502
- Cloud Run shows requests queuing (concurrency limit hit)
- Frontend shows "Failed to fetch" or spinner with no response
- Agent messages not being delivered (message bus silent)
- Health check endpoint unresponsive: `curl https://<URL>/api/health` hangs

### Diagnosis

```bash
# 1. Basic connectivity test
curl -v --max-time 10 https://<SERVICE_URL>/api/health

# 2. Check Cloud Run service status
gcloud run services describe agent-manager \
  --region=us-central1 \
  --format="yaml(status.conditions)"

# 3. Check if instances are serving
gcloud run revisions describe <REVISION_NAME> \
  --region=us-central1 \
  --format="value(status.observedGeneration)"

# 4. Check for request queue buildup / concurrency errors
gcloud logging read \
  'resource.type="cloud_run_revision" textPayload:"ECONNREFUSED" OR textPayload:"ETIMEDOUT"' \
  --limit=20 \
  --freshness=10m

# 5. Check if the issue is auth middleware hanging
curl -v --max-time 10 \
  -H "Authorization: Bearer invalid-token" \
  https://<SERVICE_URL>/api/health

# 6. Check for port binding issues (server not listening)
gcloud logging read \
  'resource.type="cloud_run_revision" textPayload:"listening" OR textPayload:"EADDRINUSE"' \
  --limit=10 \
  --freshness=15m

# 7. Check if GCS I/O is blocking startup
gcloud logging read \
  'resource.type="cloud_run_revision" textPayload:"GCS" OR textPayload:"storage"' \
  --limit=20 \
  --freshness=15m
```

### Remediation

**Step 1 - Force new instance deployment**
```bash
# Force a new revision to deploy (clears any instance-level hangs)
gcloud run deploy agent-manager \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/agent-manager/agent-manager:latest \
  --region=us-central1 \
  --no-traffic  # deploy dark first

# Test the new revision
gcloud run revisions describe <NEW_REVISION> --region=us-central1

# Then shift traffic
gcloud run services update-traffic agent-manager \
  --region=us-central1 \
  --to-latest
```

**Step 2 - Check and clear concurrency limits**
```bash
# Increase concurrency if requests are queuing
gcloud run services update agent-manager \
  --region=us-central1 \
  --concurrency=200 \
  --max-instances=20
```

**Step 3 - Bypass auth middleware to isolate issue**
```bash
# If auth middleware is suspect, check internal health
gcloud run services proxy agent-manager --region=us-central1 &
curl http://localhost:8080/api/health
```

**Step 4 - Restart with minimum instances to force cold start**
```bash
# Scale to 0 then back to 1 (forces clean restart)
gcloud run services update agent-manager \
  --region=us-central1 \
  --min-instances=0

sleep 30

gcloud run services update agent-manager \
  --region=us-central1 \
  --min-instances=1
```

**Step 5 - Verify full recovery**
```bash
# Check API endpoints are responsive
curl -sf https://<SERVICE_URL>/api/health && echo "HEALTH: OK"

curl -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  https://<SERVICE_URL>/api/agents/registry | jq 'length'
```

### Escalation

- If API is unresponsive after 2 deployment attempts -> P0 escalation
- If GCS is blocking startup (logs show GCS timeout before bind) -> see [GCS Failures](#5-gcs-failures)
- If auth service dependency is down -> see [Auth Failures](#6-auth-failures)
- Check GCP Service Health Dashboard for regional outages

---

## 5. GCS Failures

**Severity:** P1 (degraded persistence) · P0 (complete loss of shared state)

### Symptoms

- Agents cannot read/write `shared-context/` files
- `persistence.ts` logs show GCS errors: `Error: 403 Forbidden`, `Error: 404 Not Found`, `Error: 500 Internal`
- Agent spawning fails because template files cannot be read from GCS
- Messages or agent state not persisting across restarts
- Logs show: `GCS sync failed`, `storage error`, `ECONNRESET` to storage.googleapis.com

### Diagnosis

```bash
# 1. Test GCS bucket accessibility
gsutil ls gs://<BUCKET>/

# 2. Test read/write operations
echo "test" | gsutil cp - gs://<BUCKET>/incident-test.txt
gsutil cat gs://<BUCKET>/incident-test.txt
gsutil rm gs://<BUCKET>/incident-test.txt

# 3. Check IAM permissions for Cloud Run service account
gcloud projects get-iam-policy <PROJECT_ID> \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:*@*-compute.iam.gserviceaccount.com"

# 4. Check GCS bucket permissions
gsutil iam get gs://<BUCKET>/

# 5. Check for GCS quota exhaustion
gcloud logging read \
  'resource.type="gcs_bucket" severity=ERROR' \
  --limit=20 \
  --freshness=30m

# 6. Test from within Cloud Run context (proxy)
gcloud run services proxy agent-manager --region=us-central1 &
curl -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  http://localhost:8080/api/agents/registry

# 7. Verify bucket exists and is in correct region
gsutil ls -L -b gs://<BUCKET>/ | grep -E "Location|Storage class"

# 8. Check for object versioning or retention locks blocking writes
gsutil versioning get gs://<BUCKET>/
gsutil retention get gs://<BUCKET>/
```

### Remediation

**Step 1 - Fix IAM permissions (most common cause)**
```bash
# Grant storage admin to the Cloud Run service account
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:<SA_EMAIL>" \
  --role="roles/storage.objectAdmin"

# Or more granular: grant on bucket specifically
gsutil iam ch \
  serviceAccount:<SA_EMAIL>:objectAdmin \
  gs://<BUCKET>/
```

**Step 2 - Check for bucket-level issues**
```bash
# If bucket is missing, recreate it
gsutil mb -l US-CENTRAL1 gs://<BUCKET>/

# Restore bucket CORS/lifecycle if misconfigured
gsutil cors get gs://<BUCKET>/
# Then re-apply correct CORS config from terraform/storage.tf
```

**Step 3 - Recover from partial write corruption**
```bash
# List potentially corrupt objects (very small files)
gsutil ls -l gs://<BUCKET>/shared-context/ | awk '$1 < 50 {print $3}'

# Restore from versioned backup (if versioning enabled)
gsutil cp gs://<BUCKET>/<OBJECT>#<VERSION_ID> gs://<BUCKET>/<OBJECT>
```

**Step 4 - Force agent re-sync**
```bash
# Restart the service to trigger GCS re-sync on startup
gcloud run deploy agent-manager \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/agent-manager/agent-manager:latest \
  --region=us-central1
```

**Step 5 - Verify GCS health**
```bash
# Confirm operations work end-to-end
gsutil cp /dev/stdin gs://<BUCKET>/shared-context/health-check.txt <<< "ok"
gsutil cat gs://<BUCKET>/shared-context/health-check.txt
gsutil rm gs://<BUCKET>/shared-context/health-check.txt
echo "GCS: OK"
```

### Escalation

- If IAM fix does not resolve within 5 minutes -> P1 escalation (Terraform state may be drifted)
- If bucket is missing -> P0 escalation (data loss risk)
- If GCP Storage service is degraded -> check https://status.cloud.google.com and open GCP support ticket
- If versioned backups are unavailable -> escalate for potential data recovery review

---

## 6. Auth Failures

**Severity:** P0 (all agents locked out) · P1 (specific agents failing)

### Symptoms

- API returns `401 Unauthorized` on all endpoints
- Agents log: `401 error, session may have been terminated`
- `.agent-token` file is empty, stale, or missing
- `POST /api/auth/token` returns 401 or 403
- Agents cannot communicate with each other via message bus
- UI shows authentication error or redirect to login

### Diagnosis

```bash
# 1. Check current token validity
TOKEN=$(cat /tmp/workspace-*/.agent-token)
curl -v -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/agents/registry 2>&1 | grep "HTTP/"

# 2. Verify token file exists and is non-empty
ls -la /tmp/workspace-*/.agent-token
wc -c /tmp/workspace-*/.agent-token

# 3. Test token generation endpoint
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"<API_KEY>"}' \
  http://localhost:8080/api/auth/token

# 4. Check auth middleware logs for rejection reason
gcloud logging read \
  'resource.type="cloud_run_revision" textPayload:"401" OR textPayload:"Unauthorized" OR textPayload:"jwt"' \
  --limit=30 \
  --freshness=15m

# 5. Check if API_KEY secret is accessible
gcloud secrets versions access latest --secret="agent-manager-api-key"

# 6. Check JWT signing secret
gcloud secrets versions access latest --secret="agent-manager-jwt-secret"

# 7. Verify Secret Manager permissions
gcloud secrets get-iam-policy agent-manager-api-key

# 8. Check if token refresh mechanism is functioning
# Token file should be < 1 hour old
stat /tmp/workspace-*/.agent-token | grep Modify
```

### Remediation

**Step 1 - Re-read token file (most common fix)**
```bash
# Always read fresh from file, not env var
TOKEN=$(cat /tmp/workspace-*/.agent-token)
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/agents/registry
```

**Step 2 - Force token refresh via API**
```bash
# Re-authenticate to get a fresh token
NEW_TOKEN=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"<API_KEY>"}' \
  http://localhost:8080/api/auth/token | jq -r '.token')

# Update token file
echo "$NEW_TOKEN" > /tmp/workspace-*/.agent-token

# Verify
curl -H "Authorization: Bearer $NEW_TOKEN" \
  http://localhost:8080/api/agents/registry | jq 'length'
```

**Step 3 - Fix Secret Manager access (if secrets are inaccessible)**
```bash
# Grant Secret Manager access to Cloud Run service account
gcloud secrets add-iam-policy-binding agent-manager-api-key \
  --member="serviceAccount:<SA_EMAIL>" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding agent-manager-jwt-secret \
  --member="serviceAccount:<SA_EMAIL>" \
  --role="roles/secretmanager.secretAccessor"
```

**Step 4 - Rotate API key if compromised**
```bash
# Generate new API key
NEW_KEY=$(openssl rand -base64 32)

# Update Secret Manager
echo -n "$NEW_KEY" | gcloud secrets versions add agent-manager-api-key --data-file=-

# Force redeploy so service picks up new secret
gcloud run deploy agent-manager \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/agent-manager/agent-manager:latest \
  --region=us-central1

# Distribute new key to all active agents via secure channel
```

**Step 5 - Rotate JWT signing secret if tokens are being rejected unexpectedly**
```bash
# Generate new JWT secret
NEW_JWT_SECRET=$(openssl rand -base64 64)

# Update Secret Manager
echo -n "$NEW_JWT_SECRET" | gcloud secrets versions add agent-manager-jwt-secret --data-file=-

# Redeploy (invalidates all existing tokens - agents must re-authenticate)
gcloud run deploy agent-manager \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/agent-manager/agent-manager:latest \
  --region=us-central1
```

**Step 6 - Verify recovery**
```bash
TOKEN=$(cat /tmp/workspace-*/.agent-token)
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/agents/registry | jq '[.[] | .name] | length' \
  && echo "AUTH: OK"
```

### Escalation

- If all tokens are invalid after rotation -> P0 escalation (service cannot operate without auth)
- If Secret Manager is returning 403 -> escalate to GCP IAM review
- If JWT secret rotation invalidated long-running agent sessions -> notify all active agents to re-authenticate
- If API key was externally leaked -> security incident: rotate immediately, audit logs, notify stakeholders

---

## 7. Escalation Contacts

| Level | Trigger | Action |
|-------|---------|--------|
| P0 | Complete service outage, data loss risk, security breach | Page on-call engineer immediately; open GCP Critical Support ticket |
| P1 | Partial outage, multiple agents stuck, auth degraded | Notify tech-lead agent and human operator |
| P2 | Single agent failure, elevated error rate, performance degraded | Message tech-lead agent; monitor for escalation |
| P3 | Minor issues, non-blocking, workaround available | File GitHub issue; handle in next sprint |

**Agent Contacts:**
- Tech Lead: replace with your designated tech-lead agent ID for agent-level coordination
- Human Operator: message via platform UI or direct communication channel

**External Resources:**
- GCP Status: https://status.cloud.google.com
- Cloud Run Quotas: `gcloud compute project-info describe --project=<PROJECT_ID>`
- GitHub Issues: https://github.com/simonstaton/AgentManager/issues

---

## 8. Quick Reference Commands

**Getting a JWT:** Commands below use `TOKEN` for API auth. If you have an agent workspace, use `TOKEN=$(cat /tmp/workspace-*/.agent-token)`. Otherwise get a token: `TOKEN=$(curl -s -X POST -H "Content-Type: application/json" -d '{"apiKey":"<API_KEY>"}' $SERVICE_URL/api/auth/token | jq -r '.token')`.

### Platform Health

```bash
# Full health check suite
SERVICE_URL="https://<SERVICE_URL>"
TOKEN=$(cat /tmp/workspace-*/.agent-token)

echo "=== Health Check ==="
curl -sf "$SERVICE_URL/api/health" && echo "API: OK" || echo "API: FAILED"

echo "=== Agent Count ==="
curl -s -H "Authorization: Bearer $TOKEN" \
  "$SERVICE_URL/api/agents/registry" | jq 'length'

echo "=== GCS Check ==="
gsutil ls gs://<BUCKET>/shared-context/ | wc -l && echo "GCS: OK"

echo "=== Auth Check ==="
curl -s -H "Authorization: Bearer $TOKEN" \
  "$SERVICE_URL/api/agents/registry" | jq 'type' | grep -q array \
  && echo "AUTH: OK" || echo "AUTH: FAILED"
```

### Log Tailing

```bash
# Stream live logs from Cloud Run
gcloud logging tail \
  'resource.type="cloud_run_revision"' \
  --format="value(timestamp,textPayload)"

# Error-only stream
gcloud logging tail \
  'resource.type="cloud_run_revision" severity>=ERROR' \
  --format="value(timestamp,textPayload)"
```

### Agent Management

```bash
# List all agents with status
curl -s -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  http://localhost:8080/api/agents/registry \
  | jq '.[] | {id: .id, name: .name, status: .status, task: .currentTask}'

# Destroy a specific agent
curl -X DELETE \
  -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  http://localhost:8080/api/agents/<AGENT_ID>

# Broadcast status message to all agents
curl -X POST \
  -H "Authorization: Bearer $(cat /tmp/workspace-*/.agent-token)" \
  -H "Content-Type: application/json" \
  -d '{"from":"ops","fromName":"Ops","type":"status","content":"Incident in progress - standby for instructions"}' \
  http://localhost:8080/api/messages
```

### GCS Operations

```bash
# List all shared-context files with sizes
gsutil ls -l gs://<BUCKET>/shared-context/

# Backup shared-context before risky operations
gsutil -m cp -r gs://<BUCKET>/shared-context/ ./backup-$(date +%Y%m%d-%H%M%S)/

# Sync local files to GCS
gsutil -m rsync -r shared-context/ gs://<BUCKET>/shared-context/
```

### Cloud Run Operations

```bash
# Check service config
gcloud run services describe agent-manager --region=us-central1

# View all revisions and traffic split
gcloud run revisions list --service=agent-manager --region=us-central1

# Update concurrency and scaling
gcloud run services update agent-manager \
  --region=us-central1 \
  --concurrency=100 \
  --min-instances=1 \
  --max-instances=10 \
  --memory=2Gi \
  --cpu=1

# Roll back to specific revision
gcloud run services update-traffic agent-manager \
  --region=us-central1 \
  --to-revisions=<REVISION_NAME>=100
```

### Secret Management

```bash
# View current secret (use carefully)
gcloud secrets versions access latest --secret="agent-manager-api-key"

# Add new secret version
echo -n "<NEW_VALUE>" | gcloud secrets versions add <SECRET_NAME> --data-file=-

# List secret versions
gcloud secrets versions list <SECRET_NAME>
```

---

*This runbook covers GCP Cloud Run · TypeScript/Express backend · Google Cloud Storage persistence · JWT authentication. Update after each major incident with lessons learned.*
