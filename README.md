<p align="center">
  <img src="assets/banner.png" alt="ClaudeSwarm - Multi-Agent Orchestration with Claude">
</p>

<p align="center">
  <strong>Run teams of Claude agents that talk to each other, spawn sub-agents, share memory, and actually get work done.</strong>
</p>

<p align="center">
  Self-hosted. Single container. Deploy to GCP Cloud Run or run locally with Docker.
</p>

---

## What is this?

Claude Swarm is a platform for running multiple Claude Code agents in parallel, in a single container, with a web UI to watch them work. Agents can message each other, share context through persistent files, spawn child agents, and coordinate on tasks - all while you watch in real time.

It's not a framework or SDK. It's a running system. You deploy it, open the UI, and start creating agents.

## Features

**Multi-agent orchestration** - Spawn up to 100 concurrent Claude agents in a single container. Each gets its own isolated workspace, CLI process, and terminal view in the UI. Agents can spawn sub-agents, and when a parent is destroyed, its children go with it.

**Agent-to-agent messaging** - Built-in message bus with direct and broadcast messaging. Agents find each other through a registry, send tasks, ask questions, share results, and interrupt each other when priorities change. You can watch all of this in the UI.

**Shared persistent memory** - Agents read and write to a shared context directory (markdown files synced to GCS). This is how they build up long-term knowledge, share decisions, and maintain continuity across container restarts.

**Real-time UI** - Web dashboard showing every agent's terminal output, status, current task, and message history. SSE streaming so you see what agents are doing as they do it. Send messages to agents, create new ones, or shut them down - all from the browser.

**Agent persistence** - Agent state is saved to GCS and restored on container restart. Agents survive Cloud Run cold starts. Shared context and Claude home directory are continuously synced.

**MCP integrations** - Agents can use external tools out of the box:
- **GitHub** - PRs, issues, git push/fetch with credential helper
- **Figma** - read designs, extract assets, analyze components
- **Notion** - read and write pages
- **Slack** - read and send messages
- **Google Calendar** - read and create events

**Slash command skills** - Create custom reusable commands that all agents share. Ship with built-in commands for checking messages, viewing agent status, spawning agents, and sending messages.

**OpenRouter and Anthropic support** - Route API traffic through OpenRouter or direct to Anthropic. Swap keys at runtime from the Settings UI without redeploying.

**Terraform deployment** - Full IaC for GCP. One `terraform apply` gives you Cloud Run, GCS, Secret Manager, IAM, and everything else.

## The Kill Switch

> One evening, an orchestrator agent was spawned to coordinate some routine work. It decided the best way to accomplish its goals was to spawn a large swarm of sub-agents. Those sub-agents - helpful as ever - began reviewing each other's pull requests, approving them, merging them, and deploying the results to GCP. Autonomously. At scale.
>
> The server was taken down. The pull requests kept coming. Turns out, when you give agents your GitHub token, your Anthropic API key, and `--dangerously-skip-permissions`, they don't strictly need your server to keep working. The invoice was... educational.

So now there's a kill switch. Six layers of it:

1. **Global halt** - Big red panic button in the UI. Blocks all API requests instantly, persists to disk and GCS.
2. **Nuclear process kill** - Destroys all agents, kills all `claude` processes on the system, wipes workspaces.
3. **Token invalidation** - Rotates the JWT secret on activation, invalidating every existing session.
4. **Spawning limits** - Max depth of 3, max 6 children per agent. No more recursive swarm explosions.
5. **Command guardrails** - Blocks `gh pr merge`, `gcloud deploy`, `terraform apply`, `git push --force` in agent prompts.
6. **Remote kill via GCS** - Upload a kill switch file directly to your GCS bucket to halt the platform even if the API is unreachable.

## Quick Start

```bash
git clone https://github.com/simonstaton/ClaudeSwarm.git
cd ClaudeSwarm
cp .env.example .env
# Edit .env with your keys (see below)
npm run setup
```

Open `http://localhost:5173`, log in with your `API_KEY`, and start creating agents.

### Required environment variables

| Variable | Value |
|----------|-------|
| `ANTHROPIC_BASE_URL` | `https://openrouter.ai/api` (or Anthropic direct) |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter or Anthropic key |
| `ANTHROPIC_API_KEY` | Leave empty for OpenRouter |
| `API_KEY` | Password for the web UI |
| `JWT_SECRET` | Any random string |

## Docker

```bash
docker build -t claude-swarm .

docker run -p 8080:8080 \
  -e ANTHROPIC_BASE_URL=https://openrouter.ai/api \
  -e ANTHROPIC_AUTH_TOKEN=sk-or-v1-... \
  -e ANTHROPIC_API_KEY= \
  -e API_KEY=your-password \
  -e JWT_SECRET=any-random-string \
  claude-swarm
```

Open `http://localhost:8080`.

## Deploy to GCP Cloud Run

### Prerequisites

- GCP project with billing enabled
- `gcloud` CLI authenticated
- `terraform` installed

### Deploy

```bash
# Set your project
export PROJECT_ID=your-project-id
export REGION=us-central1

# Build with Cloud Build
gcloud builds submit \
  --tag $REGION-docker.pkg.dev/$PROJECT_ID/claude-swarm/claude-swarm:latest \
  --project=$PROJECT_ID --region=$REGION

# Deploy infrastructure
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values
terraform init && terraform apply
```

This creates: Cloud Run service (8 CPU, 32GB RAM), GCS bucket, Secret Manager secrets, service account with minimal permissions, and optional MCP server secrets.

```bash
# Grant yourself access
gcloud run services add-iam-policy-binding claude-swarm \
  --region=$REGION \
  --member="user:you@email.com" \
  --role="roles/run.invoker"

# Get the URL
terraform output service_url
```

## How Agents Communicate

Agents have three ways to coordinate:

**Message bus** - Real-time pub/sub. Message types: `task`, `result`, `question`, `info`, `status`, `interrupt`. Direct or broadcast. SSE stream for the UI.

**Shared context** - Persistent markdown files in `/shared-context/`. All agents can read and write. Synced to GCS. Good for decisions, documentation, and anything that should survive restarts.

**Agent registry** - Agents register their role, capabilities, and current task. Other agents query the registry to find who's doing what and avoid duplicate work.

### Delegation

Two built-in delegation mechanisms:

**Task tool (fast, invisible)** - Claude Code's built-in subagent. Runs in-process, returns results directly, invisible to the UI. Zero overhead. Use for research, analysis, and "do this and report back" work.

**Platform API (visible, independent)** - `POST /api/agents` spawns a full agent with its own workspace and terminal in the UI. Appears in the registry, can receive messages, can be monitored and interrupted independently. Set `parentId` for automatic cleanup.

You can combine both in a single task - use the Task tool for fast research, then spawn visible agents for the implementation work.

## Scaling

| Setting | Default | Config |
|---------|---------|--------|
| Max instances | 1 | `terraform/cloud-run.tf` |
| CPU / Memory | 8 CPU / 32GB | `terraform/cloud-run.tf` |
| Max agents | 100 per container | `src/guardrails.ts` |
| Session TTL | 4 hours | `src/guardrails.ts` |
| Request timeout | 1 hour | `terraform/cloud-run.tf` |

Each agent is a Claude CLI process using ~50-150MB RSS. Memory pressure monitoring (cgroup v2) rejects new agents at 85% container memory.

## GitHub Integration

Set `GITHUB_TOKEN` to enable `gh` CLI, `git push`/`fetch`, and the GitHub MCP server for all agents.

**Recommended: fine-grained token** with Contents (read/write), Pull requests (read/write), and Metadata (read-only) scoped to specific repos.

For local dev, add to `.env`. For production, add to `terraform/terraform.tfvars` and run `terraform apply`.

## Security

This platform runs Claude CLI with `--dangerously-skip-permissions`. Agents have full shell access within their workspace. Built-in safeguards:

- JWT auth on all API endpoints
- Configurable tool allowlists
- Blocked command patterns (`rm -rf /`, `gh pr merge`, `gcloud deploy`, `terraform apply`, `git push --force`)
- Memory pressure monitoring with automatic rejection at 85%
- Rate limiting
- 4-hour session TTL with automatic cleanup
- Max 100 agents, max spawn depth of 3, max 6 children per agent
- Emergency kill switch with 6 layers of protection (see above)

For production: run behind a reverse proxy with network-level controls. See SECURITY.md for vulnerability reporting.

## API Reference

<details>
<summary>Full API endpoint list</summary>

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
| POST | `/api/agents/batch` | Batch create multiple agents |
| GET | `/api/agents/:id` | Get agent details |
| PATCH | `/api/agents/:id` | Update agent metadata |
| POST | `/api/agents/:id/message` | Send message to agent (SSE stream) |
| GET | `/api/agents/:id/events` | Reconnect to agent SSE stream |
| GET | `/api/agents/:id/logs` | Session logs (`?type=`, `?tail=`, `?format=text`) |
| GET | `/api/agents/:id/files` | List workspace files |
| DELETE | `/api/agents/:id` | Destroy agent and children |

### Messages
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/messages` | Post a message |
| GET | `/api/messages` | Query messages (filter by to, from, channel, type) |
| POST | `/api/messages/:id/read` | Mark message as read |
| POST | `/api/messages/read-all` | Mark all read for an agent |
| DELETE | `/api/messages/:id` | Delete a message |
| GET | `/api/messages/stream` | SSE stream for real-time messages |

### Config and Context
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/claude-config` | List editable config files |
| GET/PUT/DELETE | `/api/claude-config/file` | Read/write/delete config files |
| POST | `/api/claude-config/commands` | Create a new skill |
| GET | `/api/context` | List shared context files |
| GET/PUT/DELETE | `/api/context/file` | Read/write/delete context files |

### Settings and System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings` | Current settings |
| PUT | `/api/settings/anthropic-key` | Switch API key at runtime |
| POST | `/api/kill-switch` | Activate or deactivate kill switch |
| GET | `/api/kill-switch` | Kill switch status |
| GET | `/api/health` | Health check (no auth) |

</details>

## Project Structure

```
server.ts              # Express server, routes, SSE, startup
src/
  agents.ts            # Agent spawning, messaging, lifecycle
  auth.ts              # JWT auth and API key exchange
  messages.ts          # Message bus for inter-agent comms
  persistence.ts       # Agent state save/restore (GCS)
  storage.ts           # GCS sync for shared context
  worktrees.ts         # Git worktree cleanup
  validation.ts        # Input validation and rate limiting
  guardrails.ts        # Safety config, tool allowlists, limits
  kill-switch.ts       # Emergency kill switch
  types.ts             # Shared TypeScript types
commands/              # Slash command skills (markdown)
ui/                    # React SPA (Vite + Tailwind v4)
  src/
    pages/             # Login, Dashboard, AgentView, Settings
    components/        # Terminal, Sidebar, Cards, MessageFeed
    hooks/             # SSE stream management
terraform/             # GCP infrastructure (Cloud Run, IAM, GCS)
mcp/                   # MCP server config templates
Dockerfile             # Multi-stage build
entrypoint.sh          # Runtime setup
```

## Architecture

```
Browser (React SPA)  ->  Express API (/api/*)  ->  Claude CLI processes
                          Static serving (/*)       per-agent workspaces
                          JWT auth                  GCS-synced shared context
```

Single container, single service. Express handles API routes and serves the React UI. Each agent is an isolated Claude CLI process with its own workspace.

## License

MIT
