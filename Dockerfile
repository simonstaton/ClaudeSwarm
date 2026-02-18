# syntax=docker/dockerfile:1

# ── Stage 1: Build React UI ─────────────────────────────────────────────────
FROM node:22-alpine AS ui-build
WORKDIR /app/ui
COPY ui/package*.json ui/.npmrc ./
RUN npm ci
COPY ui/ .
RUN npm run build

# ── Stage 2: Server dependencies ────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 3: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# Install system deps: git, gh CLI
ARG TARGETARCH
RUN apk add --no-cache git bash curl \
  && case "${TARGETARCH}" in \
       amd64) GH_ARCH="linux_amd64" ;; \
       arm64) GH_ARCH="linux_arm64" ;; \
       *)     GH_ARCH="linux_amd64" ;; \
     esac \
  && curl -fsSL --retry 3 -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v2.67.0/gh_2.67.0_${GH_ARCH}.tar.gz" \
  && tar xzf /tmp/gh.tar.gz -C /tmp \
  && mv "/tmp/gh_2.67.0_${GH_ARCH}/bin/gh" /usr/local/bin/ \
  && rm -rf /tmp/gh*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code@2.1.44

# Create non-root user
RUN addgroup -S agent && adduser -S agent -G agent

# Set up directories
RUN mkdir -p /home/agent/.claude /shared-context /persistent/repos /persistent/tools /persistent/shared-context \
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
