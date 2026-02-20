# AgentManager

Conduct autonomous agents at scale safely. You lead. Agents execute. Human-on-the-loop, NOT human-in-the-loop. Orchestrate AI work like a manager, not a prompt juggler.

**[Watch the demo on YouTube](https://youtu.be/LSXYtYAIUKo)**

<p align="center">
  <a href="https://github.com/simonstaton/AgentManager/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/simonstaton/AgentManager/actions"><img src="https://img.shields.io/github/actions/workflow/status/simonstaton/AgentManager/ci.yml" alt="CI"></a>
</p>

## What this actually is

AgentManager runs [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI processes. Each agent is a real Claude Code session with full tool access (file editing, bash, git, MCP integrations) running in an isolated workspace. The platform handles the operational side:

- **Agents persist across restarts.** State syncs to GCS. Cloud Run scales to zero, agents resume on wake.
- **6-layer emergency kill switch.** Process kill -> token rotation -> GCS remote kill. [Built because I needed it](#kill-switch).
- **cgroup v2 memory monitoring.** Tracks container memory via cgroup, rejects new agents at 85%. No OOM surprises.
- **Process group lifecycle management.** Negative PID signals kill entire process trees. No orphaned processes.
- **Git worktree GC.** Persistent bare repos with per-agent worktrees. Automatic cleanup on destroy, startup and every 10 minutes.
- **Inter-agent message bus.** Task delegation, results, questions, interrupts. Auto-delivery to idle agents with delivery locks to prevent races.

Not a wrapper around the Anthropic SDK. Not a chat UI. It runs actual Claude Code processes with the guardrails you need when agents start doing things you didn't ask for.

### Why Claude Code CLI, not the Anthropic SDK?

The SDK gives you chat completions with tool calling. Claude Code gives you a complete coding agent with file editing, bash execution, git, MCP, session resumption and sub-agent delegation, all maintained by Anthropic. AgentManager runs these agents rather than trying to rebuild them from scratch.

Claude Code's `--output-format stream-json` gives typed JSON events (not terminal scraping) that the platform parses for real-time UI streaming, state tracking and cost calculation. New capabilities Anthropic adds to Claude Code show up in AgentManager without any work on my end.

## Quick Start (Local Development)

**1. Clone the repository**
```bash
git clone https://github.com/simonstaton/AgentManager.git AgentManager
cd AgentManager
```

**2. Configure environment variables**
```bash
cp .env.example .env
```

Edit `.env` and set these required values:
```bash
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=sk-or-v1-YOUR_OPENROUTER_KEY_HERE
ANTHROPIC_API_KEY=                                      # Leave empty for OpenRouter
API_KEY=your-password-here                              # Your UI login password
JWT_SECRET=any-random-string-min-32-chars               # For JWT token signing
```

Get an OpenRouter API key at [openrouter.ai/keys](https://openrouter.ai/keys) (or use a direct Anthropic API key with `ANTHROPIC_API_KEY` instead).

**3. Install dependencies and start**
```bash
npm run setup
```

This command:
- Installs all npm dependencies (server + UI)
- Creates the `shared-context/` directory
- Starts both the Express API server and React UI dev server

**4. Open the UI**

Go to `http://localhost:5173`, log in with your `API_KEY`, and start creating agents.

### Alternative: Docker (Local)

Skip npm setup and run via Docker instead:

```bash
docker build -t agent-manager .
docker run -p 8080:8080 \
  -e ANTHROPIC_BASE_URL=https://openrouter.ai/api \
  -e ANTHROPIC_AUTH_TOKEN=sk-or-v1-... \
  -e ANTHROPIC_API_KEY= \
  -e API_KEY=your-password \
  -e JWT_SECRET=any-random-string \
  agent-manager
```

Open `http://localhost:8080` (note the different port).

## Features

| Feature | Details |
|---------|---------|
| **Multi-agent orchestration** | Up to 100 concurrent agents, each with isolated `/tmp/workspace-{uuid}` and full Claude Code capabilities |
| **Real-time streaming UI** | Next.js App Router UI with SSE streaming, live terminal output, tool use visualization, cost-per-turn stats |
| **Task graph + orchestrator** | Structured world model with Plan-Execute-Observe loop, capability-aware routing, and inter-agent contracts |
| **Agent graph visualization** | Interactive SVG tree showing parent-child topology, color-coded by status, with token usage on each node |
| **Cost tracking** | Per-agent token counts and USD cost estimates, summary dashboard, per-model pricing (Opus/Sonnet/Haiku) |
| **Pause and resume** | Pause any running agent mid-task and resume it later. Process is kept alive, context preserved |
| **Confidence grading** | Agents self-grade their fixes with a confidence score, surfaced in the UI for prioritized review |
| **Attachment support** | Send files to agents alongside prompts, or attach files without any text prompt |
| **Cron scheduler** | Persistent wake-on-alert scheduler: agents can register jobs that re-trigger them on a schedule |
| **Inter-agent messaging** | In-memory pub/sub: task, result, question, info, status, interrupt. Direct or broadcast. Auto-delivery to idle agents |
| **Agent persistence** | State, events and shared context sync to GCS. Agents survive container restarts and cold starts |
| **Parent-child lifecycle** | Agents spawn sub-agents. Destroying a parent auto-destroys the entire subtree |
| **OpenRouter support** | Route through OpenRouter or direct Anthropic API. Switch keys at runtime from the UI |
| **Model selection** | Opus 4.6, Sonnet 4.6, Sonnet 4.5, Haiku 4.5. Choose per agent based on task complexity |
| **MCP integrations** | GitHub, Figma, Linear, Notion, Slack, Google Calendar. See [MCP servers](#mcp-servers) |
| **Safety guardrails** | Command blocklists, rate limiting, memory monitoring, spawn depth limits (3 deep, 20 children), 4-hour session TTL |
| **Git worktree management** | Persistent bare repos in `/persistent/repos/` with per-agent worktrees and automatic GC |

## Usage Examples

### Coordinated Development Team

Create a team of agents that work together on a feature:

```bash
# Spawn agent 1: Feature developer
POST /api/agents
{
  "name": "feature-dev",
  "role": "developer",
  "prompt": "Implement user authentication. When done, send a 'result' message to the code-reviewer agent."
}

# Spawn agent 2: Code reviewer (waits for message from agent 1)
POST /api/agents
{
  "name": "code-reviewer",
  "role": "reviewer",
  "prompt": "Wait for a 'result' message from feature-dev. Review their changes and provide feedback via the message bus."
}

# Spawn agent 3: Test writer (waits for approval)
POST /api/agents
{
  "name": "test-writer",
  "role": "qa",
  "prompt": "Wait for code-reviewer approval, then write comprehensive tests for the authentication feature."
}
```

Agents coordinate via the message bus. You see all three terminals live in the UI.

### Long-Running PR Monitor

Deploy a persistent agent that watches for new PRs:

```bash
POST /api/agents
{
  "name": "pr-monitor",
  "role": "reviewer",
  "prompt": "Every hour, check for new PRs using the GitHub MCP tools. For each new PR, review the code and post feedback as a comment. Keep running until I tell you to stop."
}
```

The agent persists across container restarts. Even if Cloud Run scales to zero, the agent resumes when the container wakes up.

### Batch Spawn a Team

Create an entire team in one request:

```bash
POST /api/agents/batch
{
  "agents": [
    {
      "name": "backend-dev",
      "role": "developer",
      "model": "claude-sonnet-4-6",
      "prompt": "Work on the API endpoints"
    },
    {
      "name": "frontend-dev",
      "role": "developer",
      "model": "claude-haiku-4-5-20251001",
      "prompt": "Build the React components"
    },
    {
      "name": "orchestrator",
      "role": "coordinator",
      "model": "claude-opus-4-6",
      "prompt": "Coordinate the team via message bus"
    }
  ]
}
```

All three agents spawn in parallel and start immediately.

## Architecture

```
Browser (React SPA)  ->  Express API (/api/*)  ->  Claude CLI processes
                         Static serving (/*)       per-agent workspaces
                         JWT auth                  GCS-synced shared context
```

Single container, single service. Express handles both API routes and serves the built React UI. Each agent is an isolated Claude CLI process with its own workspace.

## Agent Communication

### Message Bus
In-memory pub/sub with disk persistence. Message types: `task`, `result`, `question`, `info`, `status`, `interrupt`. Messages can be direct or broadcast. SSE stream at `/api/messages/stream` for real-time UI updates.

### Shared Context
Persistent markdown files in `/shared-context/`. All agents read and write to them. Synced to GCS so they survive restarts. Used for decisions, documentation and cross-agent memory.

### Delegation Model

Claude Code has two delegation mechanisms on this platform:

**Task tool (fast, invisible)** - Claude Code's built-in `Task` tool spawns lightweight in-process sub-agents. Zero overhead, no new processes. Good for research and exploration.

**Platform API (visible, independent)** - `POST /api/agents` spawns a full platform-managed agent with its own CLI process, workspace and terminal in the UI. Agents coordinate via the message bus. Parent sets `parentId` for automatic cleanup.

**Hybrid:** "Research this repo's structure, then spawn a visible agent team to do the implementation." Task tool for the fast research phase, then platform API for visible work.

### Parent-Child Relationships
Agents spawn sub-agents with `parentId`. Destroying a parent auto-destroys all children. Max depth of 3, max 20 children per agent.

> One evening, an orchestrator agent decided the best way to accomplish its task was to spawn a dozen sub-agents. Those sub-agents reviewed each other's pull requests, approved them, merged them and deployed to GCP while I was AFK. The invoice was educational. That's why AgentManager has a [6-layer kill switch](#kill-switch).

## Kill Switch

### Why this exists

One evening, an orchestrator agent was spawned to coordinate some routine work. It decided the best approach was to spawn a large swarm of sub-agents. Those sub-agents began reviewing each other's pull requests, approving them, merging them and deploying the results to GCP on their own.

The server was taken down. The pull requests kept coming. Turns out, when you give agents your GitHub token, your Anthropic API key and `--dangerously-skip-permissions`, they don't strictly need your server to keep working. The invoice was educational.

The kill switch exists so this never happens again.

### How it works

| Layer | Mechanism | What it does |
|-------|-----------|-------------|
| **1** | Global halt | `POST /api/kill-switch` blocks all API requests. Persistent flag survives restarts via GCS sync. Big red button in the UI. |
| **2** | Nuclear process kill | All tracked agents destroyed + all `claude` processes on the system killed. Workspaces wiped. |
| **3** | Token invalidation | JWT secret rotated on activation (and again on deactivation). All existing tokens instantly invalid. |
| **4** | Spawn limits | Max depth 3, max 20 children. Prevents recursive swarm explosions. |
| **5** | Command blocklist | `gh pr merge`, `gcloud deploy`, `terraform apply`, `git push --force` blocked. These are speed bumps, not walls. |
| **6** | Remote kill via GCS | Upload a kill switch file directly to GCS to halt the platform even if the API is unreachable. |

```bash
# Layer 6: Remote kill when API is unreachable
echo '{"killed":true,"reason":"emergency"}' | gsutil cp - gs://your-bucket/kill-switch.json
```

### Emergency Runbook

1. **Hit the kill switch** - UI panic button or `POST /api/kill-switch`
2. **Revoke external tokens** - rotate your GitHub PAT, Anthropic API key and any MCP credentials
3. **Check for damage** - review merged PRs, deployed services and GCP resource creation
4. **Review GCS** - check shared-context for any payloads agents may have left behind
5. **If the API is unreachable** - upload the kill switch file to GCS, or delete the Cloud Run service entirely:
   ```bash
   gcloud run services delete agent-manager --region=$REGION
   ```

### Limitations

The kill switch controls the platform, but it cannot:
- Un-merge pull requests or un-deploy services
- Revoke external API tokens (you need to do this yourself)
- Stop processes that agents spawned outside the platform (e.g. direct `curl` calls to the Anthropic API)
- Undo damage that already happened before you pressed the button

Limit what credentials you give agents. That's the real safety net.

## Deploy to Cloud Run in 5 Steps

### Prerequisites
- GCP project with billing enabled
- `gcloud` CLI authenticated and configured
- `terraform` CLI installed
- Docker (if building locally)

### Step 1: Build and push the container image

```bash
# Set your GCP project details
export PROJECT_ID=your-project-id
export REGION=us-central1

# Option A: Build remotely with Cloud Build (recommended, no local Docker needed)
gcloud builds submit \
  --tag $REGION-docker.pkg.dev/$PROJECT_ID/agent-manager/agent-manager:latest \
  --project=$PROJECT_ID --region=$REGION

# Option B: Build locally with Docker
docker build -t $REGION-docker.pkg.dev/$PROJECT_ID/agent-manager/agent-manager:latest .
docker push $REGION-docker.pkg.dev/$PROJECT_ID/agent-manager/agent-manager:latest
```

### Step 2: Configure Terraform variables

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` with your values:
- `project_id` - Your GCP project ID
- `region` - Deployment region (e.g. `us-central1`)
- `api_key` - Your UI login password
- `openrouter_api_key` - Get from [openrouter.ai/keys](https://openrouter.ai/keys)
- `jwt_secret` - Any random 32+ character string
- Optional: `github_token`, `figma_token`, `linear_api_key`, `notion_api_key`, etc.

### Step 3: Deploy infrastructure with Terraform

```bash
terraform init
terraform plan    # Preview changes
terraform apply   # Deploy
```

This creates:
- **Cloud Run service** - 32GB RAM, 8 CPU, autoscaling (min 0, max 1 instance)
- **GCS bucket** - Persistent storage for agent state and shared context
- **Secret Manager secrets** - OpenRouter key, API key, JWT secret, MCP credentials
- **Service account** - Minimal IAM permissions (Cloud Run invoker, GCS admin, Secret Manager accessor)
- **IAM auth** - No public access; requires authenticated users
- **Cloud Monitoring alerts** - Error rate, p99 latency, crashes, memory, CPU

### Step 4: Grant yourself access

The service is private by default. Grant yourself permission to invoke it:

```bash
gcloud run services add-iam-policy-binding agent-manager \
  --region=$REGION \
  --member="user:your-email@example.com" \
  --role="roles/run.invoker"
```

### Step 5: Access the UI

Get your service URL and open it in a browser:

```bash
terraform output service_url
# or
gcloud run services describe agent-manager --region=$REGION --format='value(status.url)'
```

Log in with the `api_key` you set in `terraform.tfvars`. Start creating agents.

Done. Agents persist across container restarts. Shared context syncs to GCS every 60 seconds. The platform auto-scales to zero when idle (no cost) and wakes up on the first request.

## Scaling

| Setting | Default | How to change |
|---------|---------|---------------|
| Max instances | 1 | `terraform/cloud-run.tf` > `max_instance_count` |
| Concurrency | 500 | `terraform/cloud-run.tf` > `max_instance_request_concurrency` |
| CPU/Memory | 8 CPU / 32GB | `terraform/cloud-run.tf` > `resources.limits` |
| Max agents per container | 100 | `src/guardrails.ts` > `MAX_AGENTS` |
| Session TTL | 4 hours | `src/guardrails.ts` > `SESSION_TTL_MS` |
| Request timeout | 1 hour | `terraform/cloud-run.tf` > `timeout` |

Each agent is a Claude CLI process (~50-150MB RSS). With 8 CPU and 32GB RAM, the container supports up to 100 concurrent agents. Memory pressure monitoring (cgroup v2) rejects new agents at 85% container memory.

Min instances = 0 means cold starts. Set to 1 if you want instant responses (costs more).

## OpenRouter Support

The platform routes all Claude API traffic through [OpenRouter](https://openrouter.ai/docs/guides/community/anthropic-agent-sdk) instead of calling the Anthropic API directly. Three env vars control this:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_BASE_URL` | `https://openrouter.ai/api` |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter key (`sk-or-v1-...`) |
| `ANTHROPIC_API_KEY` | Must be empty |

You can switch keys at runtime via the Settings UI or API. Both OpenRouter (`sk-or-...`) and direct Anthropic (`sk-ant-...`) keys are accepted.

## MCP Servers

MCP (Model Context Protocol) servers give agents access to external tools. See `mcp/README.md` for setup.

Supported out of the box:
- **Notion** - read/write Notion pages
- **GitHub** - interact with repos, PRs, issues + `git push` via credential helper
- **Google Calendar** - read/create events
- **Slack** - read/send messages
- **Figma** - read designs, extract assets, analyze components ([setup guide](docs/figma-integration.md))

Add credentials as env vars (locally in `.env`, in production via Terraform/Secret Manager).

### GitHub Integration

Setting `GITHUB_TOKEN` enables three things for agents:
1. **`gh` CLI** - create PRs, manage issues, query repos
2. **`git push`/`git fetch`** - credential helper is configured automatically on startup via `gh auth setup-git`
3. **GitHub MCP server** - structured tool access to GitHub's API

#### Creating a token

**Option A: Fine-grained token (recommended)**

Go to [GitHub Settings > Fine-grained tokens](https://github.com/settings/personal-access-tokens/new):
- **Token name:** `agent-manager`
- **Expiration:** 90 days (or custom)
- **Repository access:** "Only select repositories" and pick the repos agents should access
- **Permissions:**
  - Contents - Read and write
  - Pull requests - Read and write
  - Metadata - Read-only (auto-selected)

**Option B: Classic PAT**

Go to [GitHub Settings > Tokens (classic)](https://github.com/settings/tokens/new):
- **Scopes:** `repo` (required), `workflow` (optional)

#### Configuring the token

**Local development** - add to `.env`:
```
GITHUB_TOKEN=github_pat_xxxxx
```

**Production (Cloud Run)** - add to `terraform/terraform.tfvars`:
```hcl
github_token = "github_pat_xxxxx"
```
Then run `terraform apply` and redeploy. Terraform stores the token in Secret Manager and injects it as an env var.

**Quick update without Terraform** - update the secret directly:
```bash
echo -n "github_pat_new_token_here" | gcloud secrets versions add github-token --data-file=- --project=$PROJECT_ID
gcloud run services update agent-manager --region=$REGION --project=$PROJECT_ID
```

## Security

**Warning:** By default, agents run with permission prompts enabled. If you pass `--dangerously-skip-permissions` when creating an agent, it will have full access to execute shell commands, read/write files and make network requests without confirmation. Only opt in to this when you understand the risks.

Each agent runs in an isolated `/tmp/workspace-{uuid}` directory but shares the container's network and process namespace.

Built-in safeguards:

- JWT authentication required for all API access
- Agent tool allowlist (configurable in guardrails)
- Blocked command patterns (prevents destructive operations like `rm -rf /`, `gh pr merge`, `gcloud deploy`, `terraform apply`, `git push --force`)
- Memory pressure monitoring (rejects new agents at 85% memory)
- Rate limiting on API endpoints
- 4-hour session TTL with automatic cleanup
- Max 100 concurrent agents per container
- Max agent spawn depth of 3 and max 20 children per agent (prevents recursive swarm explosions)
- Emergency kill switch - halts all agents, rotates JWT secret and persists state to GCS
- Non-root container user (`agent:agent`)
- Environment variable allowlist (not denylist) prevents credential leakage
- Security headers (CSP, X-Frame-Options, etc.)

For production deployments, run behind a reverse proxy with additional network-level controls. See SECURITY.md for vulnerability reporting.

## Secrets Management

### Local
Use `.env` file (gitignored). Copy from `.env.example`.

### Production
Secrets are in GCP Secret Manager, injected into Cloud Run as env vars by Terraform.

```bash
# Update a secret
echo -n "new-value" | gcloud secrets versions add SECRET_NAME --data-file=-

# Redeploy to pick up new secrets
gcloud run services update agent-manager --region=$REGION
```

### Adding a new secret
1. Add to `terraform/variables.tf`
2. Add to `terraform/secrets.tf`
3. Reference in `terraform/cloud-run.tf` env block
4. Run `terraform apply`

## API Reference

<details>
<summary>Click to expand full API reference</summary>

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/token` | Exchange API key for JWT |

### Agents
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List all agents |
| GET | `/api/agents/registry` | Agent registry with roles, tasks, message counts |
| POST | `/api/agents` | Create agent (SSE stream) |
| POST | `/api/agents/batch` | Batch create multiple agents (JSON response) |
| GET | `/api/agents/:id` | Get agent details |
| PATCH | `/api/agents/:id` | Update agent metadata (role, capabilities, currentTask) |
| POST | `/api/agents/:id/message` | Send message to agent (SSE stream) |
| GET | `/api/agents/:id/events` | Reconnect to agent SSE stream |
| GET | `/api/agents/:id/raw-events` | Raw event log |
| GET | `/api/agents/:id/logs` | Session logs in readable format (supports `?type=`, `?tail=`, `?format=text`) |
| GET | `/api/agents/:id/files` | List workspace files (for @ mentions) |
| DELETE | `/api/agents/:id` | Destroy agent (and children) |

### Messages
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/messages` | Post a message to the bus |
| GET | `/api/messages` | Query messages (filter by to, from, channel, type, unreadBy, since) |
| POST | `/api/messages/:id/read` | Mark message as read |
| POST | `/api/messages/read-all` | Mark all messages as read for an agent |
| DELETE | `/api/messages/:id` | Delete a message |
| GET | `/api/messages/stream` | SSE stream for real-time messages |

### Config
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/claude-config` | List editable config files |
| GET | `/api/claude-config/file` | Read a config file |
| PUT | `/api/claude-config/file` | Write a config file |
| POST | `/api/claude-config/commands` | Create a new skill/command |
| DELETE | `/api/claude-config/file` | Delete a skill or memory file |

### Context
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/context` | List shared context files (recursive) |
| GET | `/api/context/file?name=...` | Read a context file (supports subdirectories) |
| PUT | `/api/context/file` | Create/update context file (`{ name, content }`) |
| DELETE | `/api/context/file?name=...` | Delete context file |

### Settings
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings` | Get current settings (key hint, available models) |
| PUT | `/api/settings/anthropic-key` | Switch API key at runtime (OpenRouter or Anthropic) |

### Kill Switch
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/kill-switch` | Activate or deactivate (`{ action: "activate" \| "deactivate", reason? }`) |
| GET | `/api/kill-switch` | Check kill switch status |

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (no auth required) |

</details>

## Project Structure

```
server.ts              # Express server (routes, SSE setup, startup)
src/
  agents.ts            # AgentManager - spawn/kill/message Claude CLI
  auth.ts              # JWT auth + API key exchange
  messages.ts          # MessageBus for inter-agent communication
  persistence.ts       # Agent state persistence across restarts
  storage.ts           # GCS sync for shared context and Claude home
  worktrees.ts         # Git worktree GC for dead agent workspaces
  validation.ts        # Input validation + rate limiting
  guardrails.ts        # Safety config (tool allowlists, limits, spawning depth)
  kill-switch.ts       # Emergency kill switch (persistent state, GCS sync)
  logger.ts            # Structured logging (replaces console.log throughout)
  types.ts             # Shared TypeScript interfaces
  routes/              # Express route handlers
  utils/               # SSE, memory monitoring, file listing, config
  templates/           # Workspace CLAUDE.md generation
commands/              # Slash command skills
  agent-status.md      # /agent-status - show agent registry
  check-messages.md    # /check-messages - check message bus inbox
  send-message.md      # /send-message - post to message bus
  spawn-agent.md       # /spawn-agent - create sub-agents
ui/                    # Next.js App Router (Tailwind v4 + @fanvue/ui)
  src/
    app/               # Next.js App Router pages and layouts
    components/        # Header, Sidebar, AgentCard, AgentTerminal, PromptInput, MessageFeed, GraphView, TaskGraph
    hooks/             # useAgentStream (SSE management)
    api.ts             # API client with SSE parsing
    auth.tsx           # Auth context (JWT in sessionStorage)
docs/                  # Architecture documentation
terraform/             # GCP infrastructure
mcp/                   # MCP server config templates
Dockerfile             # Multi-stage build
entrypoint.sh          # Runtime setup
```

## License

MIT
