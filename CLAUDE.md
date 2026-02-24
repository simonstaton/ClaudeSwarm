# AgentManager Platform

## What is this?
A platform for conducting autonomous agents via a web UI backed by Cloud Run. Agents run Claude CLI processes with `--dangerously-skip-permissions` in isolated workspaces.

## Project structure
- `server.ts` - Express server: API + static React SPA serving
- `src/` - Server modules: agents, auth, messages, persistence, storage, validation, guardrails, sanitize, cors, worktrees, types
- `src/routes/` - Express route handlers: auth, agents, messages, config, context, health, cost, tasks, scheduler, workflows, repositories, kill-switch, mcp, usage
- `src/utils/` - Utilities: SSE, Express helpers, file listing, config paths, context
- `src/templates/` - Workspace CLAUDE.md template generation
- `ui/` - React SPA (Next.js App Router, Tailwind v4, Radix/shadcn)
- `terraform/` - GCP infrastructure (Cloud Run, GCS, Secret Manager, IAM, Cloud Monitoring alerts)
- `mcp/` - MCP server configuration templates
- `commands/` - Slash command skills for agents
- `docs/` - Design documents, incident runbook
- `plans/` - Implementation plans (agent teams, V3 plan)
- `home-claude.md` - Agent guidance file (copied to `~/.claude/CLAUDE.md` in container)
- `Dockerfile` - Multi-stage Docker build
- `entrypoint.sh` - Docker entrypoint (key injection, GitHub auth, MCP merge, server start)
- `vitest.config.ts` - Test configuration

For the **full module map, route table (paths + dependencies), and flow traceability**, see `docs/ARCHITECTURE.md`; keep that doc in sync when adding or changing routes.

## Running the app (Docker only)

**The only supported way to run AgentManager is Docker.** Do not run the server or UI with `npm run dev` or `npm start` outside Docker.

One-command run with full persistence (repos, shared-context, state, logs):
```bash
cp .env.example .env   # set API_KEY and ANTHROPIC_AUTH_TOKEN; do not set GCS_BUCKET
npm run docker:local   # builds image and starts at http://localhost:8080
```
Data lives in Docker volume `agent-manager-data` (mount point `/persistent`). See `plans/local-docker-and-npx.md` for design and npx roadmap.

## Quality checks - run before committing
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
- **Types**: Avoid `any` - use proper types or `unknown` with type guards. Use `AuthenticatedRequest` for typed Express requests with user context.
- **Testing**: Vitest. Test files live alongside source as `*.test.ts`. Run `npm test` before pushing.
- **Imports**: Use `node:` prefix for Node.js built-ins (e.g. `import fs from "node:fs"`).
- **Formatting**: 2-space indentation, double quotes, semicolons, 120-char line width.

## Key conventions
- API routes are all under `/api/*`
- Auth: JWT tokens exchanged via POST `/api/auth/token`
- SSE streaming: events use `id:` fields and heartbeats for robustness
- Agents: each gets an isolated `/tmp/workspace-{uuid}` directory
- Shared context: `.md` files in `/shared-context/` (GCS-synced), symlinked into workspaces
- Terraform manages all GCP infrastructure - no manual resource creation
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
- Keep files focused - one topic per file
- Use markdown formatting

## Deployment

### Build & deploy
```bash
# Set your GCP project and region
export PROJECT_ID=your-project-id
export REGION=your-region

# Build and push image (uses Cloud Build, no local Docker needed)
gcloud builds submit \
  --tag $REGION-docker.pkg.dev/$PROJECT_ID/agent-manager/agent-manager:latest \
  --project=$PROJECT_ID --region=$REGION

# Deploy infrastructure (first time or after config changes)
cd terraform
GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) terraform apply

# Deploy new image to existing service (after code changes)
gcloud run services update agent-manager \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/agent-manager/agent-manager:latest \
  --region=$REGION --project=$PROJECT_ID
```

### Configuration
All secrets and config are in `terraform/terraform.tfvars` (gitignored). Required vars:
- `project_id`, `region`, `image` - GCP config
- `openrouter_api_key` - OpenRouter API key (used as `ANTHROPIC_AUTH_TOKEN`)
- `agent_api_key` - login key for the web UI

Optional MCP integrations (see `mcp/README.md`):
- `github_token` - enables `gh` CLI, `git push`, and GitHub MCP server for agents
- `notion_api_key`, `slack_token` - enables respective MCP servers
- `alert_notification_email` - enables Cloud Monitoring alert policies (error rate, latency, crashes, memory, CPU)

### Scale-to-zero
Cloud Run scales to 0 instances after ~15 min of inactivity. The URL is permanent - first request after idle has a ~5-10s cold start.

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
- Agents do NOT need to manually clean up worktrees - the platform handles it

**Best practices:**
- Always create worktrees inside your workspace dir (this happens by default with `../repo-workdir`)
- Use unique worktree names if you need multiple checkouts: `../repo-feature-x`, `../repo-main`
- Fetch before creating worktrees to get latest refs: `git -C repos/repo.git fetch --all`

## Running the UI (Docker only)
The only supported way to run AgentManager is via Docker. Do not run the server or UI with `npm start` or `npm run dev` outside Docker.

To run the platform from a clone: from the repo root, copy `.env.example` to `.env`, set `API_KEY` and `ANTHROPIC_AUTH_TOKEN` (and do not set `GCS_BUCKET`), then run `npm run docker:local`. The UI will be at http://localhost:8080.

For headless API testing, use `curl` against the API endpoints (the platform must be running in Docker).

## Agent guardrails
- Allowed tools: Bash, Edit, Write, Read, Glob, Grep, LS, TodoRead, TodoWrite, Task, WebFetch, WebSearch, NotebookEdit
- No database access (no credentials injected, no IAM roles)
- Max 100 concurrent agents per container
- 4-hour session TTL
- 100k char prompt limit
