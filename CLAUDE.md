# ClaudeSwarm Platform

## What is this?
A platform for running Claude agent swarms via a web UI backed by Cloud Run. Agents run Claude CLI processes with `--dangerously-skip-permissions` in isolated workspaces.

## Project structure
- `server.ts` — Express server: API + static React SPA serving
- `src/` — Server modules: agents, auth, messages, persistence, storage, validation, guardrails, sanitize, cors, worktrees, types
- `src/routes/` — Express route handlers: agents, messages, config, context, health
- `src/utils/` — Utilities: SSE, Express helpers, file listing, config paths, context
- `src/templates/` — Workspace CLAUDE.md template generation
- `ui/` — React SPA (Vite, Tailwind v4, @fanvue/ui)
- `terraform/` — GCP infrastructure (Cloud Run, GCS, Secret Manager, IAM, Cloud Monitoring alerts)
- `mcp/` — MCP server configuration templates
- `commands/` — Slash command skills for agents
- `docs/` — Design documents, incident runbook
- `plans/` — Implementation plans (agent teams, kill switch)
- `home-claude.md` — Agent guidance file (copied to `~/.claude/CLAUDE.md` in container)
- `Dockerfile` — Multi-stage Docker build
- `entrypoint.sh` — Docker entrypoint (key injection, GitHub auth, MCP merge, server start)
- `vitest.config.ts` — Test configuration

## Local development
```bash
cp .env.example .env  # fill in your keys
npm install && cd ui && npm install && cd ..
npm run dev           # starts server + Vite dev server
```

## Quality checks — run before committing
```bash
npm run check         # runs lint + typecheck + tests (all three)
npm run lint          # biome lint (errors + warnings)
npm run lint:fix      # auto-fix lint issues
npm run format        # auto-format with biome
npm run typecheck     # tsc --noEmit for server + UI
npm run test          # vitest (unit tests)
npm run test:watch    # vitest in watch mode
```

## Coding standards
- **Linting/formatting**: Biome (configured in `biome.json`). No ESLint/Prettier.
- **Error handling**: Use `err: unknown` in catch blocks, never `err: any`. Use `errorMessage()` from `src/types.ts` to safely extract messages.
- **Types**: Avoid `any` — use proper types or `unknown` with type guards. Use `AuthenticatedRequest` for typed Express requests with user context.
- **Testing**: Vitest. Test files live alongside source as `*.test.ts`. Run `npm test` before pushing.
- **Imports**: Use `node:` prefix for Node.js built-ins (e.g. `import fs from "node:fs"`).
- **Formatting**: 2-space indentation, double quotes, semicolons, 120-char line width.

## Key conventions
- API routes are all under `/api/*`
- Auth: JWT tokens exchanged via POST `/api/auth/token`
- SSE streaming: events use `id:` fields and heartbeats for robustness
- Agents: each gets an isolated `/tmp/workspace-{uuid}` directory
- Shared context: `.md` files in `/shared-context/` (GCS-synced), symlinked into workspaces
- Terraform manages all GCP infrastructure — no manual resource creation
- Request body limits: 10 MB for `/api/agents` (file attachments), 1 MB for all other routes
- UI routes: `/` (home), `/agents/[id]` (agent view), `/graph`, `/costs`, `/messages`; Settings is a dialog opened from the header
- Docker base image is pinned to SHA256 digest for reproducible builds (see `Dockerfile` for update instructions)
- Container image vulnerability scanning via Trivy on every push, PR, and weekly schedule

## Shared context (persistent memory)
Agents have a `shared-context/` directory symlinked into their workspace. All `.md` files here persist across sessions and are shared between all agents.

**How to use:**
- Read files: `cat shared-context/standup-notes.md`
- Write files: `echo "..." > shared-context/my-notes.md` or use the Write tool on `shared-context/filename.md`
- These files are synced to GCS and survive container restarts
- Use this for: meeting notes, project context, decisions, task lists, anything you want to remember across sessions
- The human operator can also view and edit these files from the Settings dialog (gear icon in header)

**Conventions:**
- Use descriptive filenames: `standup-2026-02-15.md`, `project-decisions.md`, `todo.md`
- Keep files focused — one topic per file
- Use markdown formatting

## Deployment

### Build & deploy
```bash
# Set your GCP project and region
export PROJECT_ID=your-project-id
export REGION=your-region

# Build and push image (uses Cloud Build, no local Docker needed)
gcloud builds submit \
  --tag $REGION-docker.pkg.dev/$PROJECT_ID/claude-swarm/claude-swarm:latest \
  --project=$PROJECT_ID --region=$REGION

# Deploy infrastructure (first time or after config changes)
cd terraform
GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) terraform apply

# Deploy new image to existing service (after code changes)
gcloud run services update claude-swarm \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/claude-swarm/claude-swarm:latest \
  --region=$REGION --project=$PROJECT_ID
```

### Configuration
All secrets and config are in `terraform/terraform.tfvars` (gitignored). Required vars:
- `project_id`, `region`, `image` — GCP config
- `openrouter_api_key` — OpenRouter API key (used as `ANTHROPIC_AUTH_TOKEN`)
- `agent_api_key` — login key for the web UI

Optional MCP integrations (see `mcp/README.md`):
- `github_token` — enables `gh` CLI, `git push`, and GitHub MCP server for agents
- `notion_api_key`, `slack_token` — enables respective MCP servers
- `alert_notification_email` — enables Cloud Monitoring alert policies (error rate, latency, crashes, memory, CPU)

### Scale-to-zero
Cloud Run scales to 0 instances after ~15 min of inactivity. The URL is permanent — first request after idle has a ~5-10s cold start.

## Git worktrees (persistent repos)
Agents can use bare repos in `/persistent/repos/` with git worktrees for fast checkouts. Worktree lifecycle is managed automatically:

**How it works:**
- Clone once: `git clone --bare https://github.com/org/repo.git repos/repo.git`
- Create worktree: `git -C repos/repo.git worktree add ../repo-workdir main`
- The worktree lives in the agent's ephemeral `/tmp/workspace-{uuid}` dir (fast I/O)
- The bare repo lives in `/persistent/repos/` (survives restarts)

**Automatic cleanup:**
- On agent destroy: worktrees owned by that agent are removed from the bare repo
- On container startup: `git worktree prune` runs on all bare repos (catches orphans from crashes)
- Every 10 minutes: periodic GC prunes worktrees pointing to dead agent workspaces
- Agents do NOT need to manually clean up worktrees — the platform handles it

**Best practices:**
- Always create worktrees inside your workspace dir (this happens by default with `../repo-workdir`)
- Use unique worktree names if you need multiple checkouts: `../repo-feature-x`, `../repo-main`
- Fetch before creating worktrees to get latest refs: `git -C repos/repo.git fetch --all`

## Running the UI (self-serve for agents)
Agents can clone, build, and run the Claude Swarm UI locally for self-learning, validation, and test-driven prompting.

**Quick start (from agent workspace):**
```bash
# 1. Clone via worktree (if bare repo exists) or fresh clone
git -C repos/claude-swarm.git worktree add ../swarm-workdir main
# OR: git clone https://github.com/your-org/claude-swarm.git swarm-workdir

# 2. Install dependencies
cd swarm-workdir && npm install && cd ui && npm install && cd ..

# 3. Create minimal .env for local dev
cat > .env << 'ENVEOF'
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN}
ANTHROPIC_API_KEY=
API_KEY=dev-test-key
JWT_SECRET=dev-secret
SHARED_CONTEXT_DIR=./shared-context
ENVEOF

# 4. Build the UI
npm run build

# 5. Start the server (serves built UI on port 8080)
npm start &

# 6. The UI is now running at http://localhost:8080
```

**Notes:**
- The `ANTHROPIC_AUTH_TOKEN` env var is already available in the agent environment
- Use `API_KEY=dev-test-key` for local testing — exchange it for a JWT via `POST /api/auth/token`
- The dev server (`npm run dev`) runs Vite on port 5173 with HMR, proxying API calls to port 8080
- For headless UI testing, agents can use `curl` against the API endpoints directly

## Agent guardrails
- Allowed tools: Bash, Edit, Write, Read, Glob, Grep, LS, TodoRead, TodoWrite, Task, WebFetch, WebSearch, NotebookEdit
- No database access (no credentials injected, no IAM roles)
- Max 100 concurrent agents per container
- 4-hour session TTL
- 100k char prompt limit
