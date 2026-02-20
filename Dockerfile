# syntax=docker/dockerfile:1

# Base image is pinned to a specific SHA256 digest for reproducible builds.
# Floating tags (e.g. node:22-alpine) can silently change, breaking builds or
# introducing unexpected changes. Pinning ensures every build uses the exact
# same image layers regardless of when it runs.
#
# To update: run the following and replace all three digests below:
#   docker pull node:22-alpine
#   docker inspect --format='{{index .RepoDigests 0}}' node:22-alpine
# Or via the registry API (no Docker required):
#   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
#   curl -sI -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json" \
#     "https://registry-1.docker.io/v2/library/node/manifests/22-alpine" | grep docker-content-digest
# Last updated: 2026-02-19 — node:22-alpine (Node.js 22 on Alpine 3.23)
ARG NODE_IMAGE=node:22-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34

# ── Stage 1: Build React UI ─────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS ui-build
WORKDIR /app/ui
COPY ui/package*.json ui/.npmrc ./
RUN npm ci
COPY ui/ .
RUN npm run build

# ── Stage 2: Server dependencies ────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# better-sqlite3 needs build tools if prebuilt binaries are unavailable
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 3: Runtime ────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
WORKDIR /app

# Install system deps: git, gh CLI
ARG TARGETARCH
RUN apk add --no-cache git bash curl \
  && case "${TARGETARCH}" in \
       amd64) GH_ARCH="linux_amd64" ;; \
       arm64) GH_ARCH="linux_arm64" ;; \
       *)     GH_ARCH="linux_amd64" ;; \
     esac \
  && curl -fsSL --retry 3 -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v2.87.0/gh_2.87.0_${GH_ARCH}.tar.gz" \
  && tar xzf /tmp/gh.tar.gz -C /tmp \
  && mv "/tmp/gh_2.87.0_${GH_ARCH}/bin/gh" /usr/local/bin/ \
  && rm -rf /tmp/gh*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code@2.1.47
RUN npm install -g pnpm

# Create non-root user
RUN addgroup -S agent && adduser -S agent -G agent

# Set up directories (includes dep cache dirs for npm/pnpm)
RUN mkdir -p /home/agent/.claude /shared-context \
  /persistent/repos /persistent/tools /persistent/shared-context \
  /persistent/npm-cache /persistent/pnpm-store \
  && chown -R agent:agent /home/agent /shared-context /persistent

USER agent

# Global identity config (~/.claude.json)
RUN printf '{\n\
  "hasCompletedOnboarding": true,\n\
  "shiftEnterKeyBindingInstalled": true,\n\
  "theme": "dark"\n\
}\n' > /home/agent/.claude.json

# Tool/project settings (~/.claude/settings.json)
# Note: apiKeyHelper is NOT set because we use OpenRouter auth via ANTHROPIC_AUTH_TOKEN,
# not direct Anthropic API key auth. Setting apiKeyHelper with OpenRouter token causes errors.
RUN printf '{\n\
  "hasTrustDialogAccepted": true,\n\
  "hasCompletedProjectOnboarding": true,\n\
  "parallelTasksCount": 3,\n\
  "allowedTools": ["Bash","Edit","Write","Read","Glob","Grep","LS","TodoRead","TodoWrite","Task","WebFetch","WebSearch","NotebookEdit"]\n\
}\n' > /home/agent/.claude/settings.json

# User-level CLAUDE.md — global instructions for all agent sessions
COPY --chown=agent:agent home-claude.md /home/agent/CLAUDE.md

# Copy default skill commands (slash commands shared across agents)
COPY --chown=agent:agent commands/ /home/agent/.claude/commands/

# Copy built UI
COPY --chown=agent:agent --from=ui-build /app/ui/dist ./ui/dist

# Copy server deps
COPY --chown=agent:agent --from=deps /app/node_modules ./node_modules

# Copy server source
COPY --chown=agent:agent package.json tsconfig.json server.ts ./
COPY --chown=agent:agent src/ ./src/
COPY --chown=agent:agent mcp/ ./mcp/

# Copy entrypoint
COPY --chown=agent:agent entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV SHARED_CONTEXT_DIR=/shared-context
EXPOSE 8080
ENTRYPOINT ["./entrypoint.sh"]
