#!/bin/sh
set -e

# ── 1. Inject API key suffix for trust dialog ─────────────────────────────────
# With OpenRouter, the auth token is in ANTHROPIC_AUTH_TOKEN (ANTHROPIC_API_KEY is empty).
AUTH_KEY="${ANTHROPIC_AUTH_TOKEN:-$ANTHROPIC_API_KEY}"
if [ -n "$AUTH_KEY" ]; then
  KEY_SUFFIX="${AUTH_KEY: -20}" node -e "
    const fs = require('fs');
    const suffix = process.env.KEY_SUFFIX || '';
    const cfg = JSON.parse(fs.readFileSync('/home/agent/.claude.json', 'utf8'));
    cfg.customApiKeyResponses = { approved: [suffix], rejected: [] };
    fs.writeFileSync('/home/agent/.claude.json', JSON.stringify(cfg, null, 2));
  "
fi

# ── 2. Configure GitHub CLI + git credentials if token is present ────────────
if [ -n "$GITHUB_TOKEN" ]; then
  gh auth setup-git 2>/dev/null && echo "GitHub CLI configured for git operations" || true
fi

# ── 3. Merge MCP settings if env vars are present ─────────────────────────────
node -e "
  const fs = require('fs');
  const path = require('path');

  const templatePath = '/app/mcp/settings-template.json';
  const settingsPath = '/home/agent/.claude/settings.json';
  const tokenDir = process.env.MCP_TOKEN_DIR || '/persistent/mcp-tokens';

  if (!fs.existsSync(templatePath)) process.exit(0);

  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  // ── Helper: Load stored OAuth token for a server ──
  function loadStoredToken(serverName) {
    const tokenPath = path.join(tokenDir, serverName + '.json');
    if (!fs.existsSync(tokenPath)) return null;
    try {
      const data = fs.readFileSync(tokenPath, 'utf8');
      const token = JSON.parse(data);

      // Check if token is expired
      if (token.expiresAt) {
        const expiresAt = new Date(token.expiresAt);
        const now = new Date();
        if (now >= expiresAt) {
          console.log('MCP: stored token for ' + serverName + ' is expired');
          return null;
        }
      }

      return token;
    } catch (err) {
      console.error('MCP: failed to load token for ' + serverName + ':', err.message);
      return null;
    }
  }

  const activeMcp = {};
  for (const [name, config] of Object.entries(template.mcpServers || {})) {

    // ── Remote HTTP servers (OAuth + optional token auth) ──
    if (config.type === 'http' && config.url) {
      const alwaysActivate = config._alwaysActivate === true;
      const tokenEnv = config._tokenEnv;
      const tokenVal = tokenEnv ? process.env[tokenEnv] : null;

      // Check for stored OAuth token
      const storedToken = loadStoredToken(name);

      if (!alwaysActivate && !tokenVal && !storedToken) continue;

      const resolved = { type: 'http', url: config.url };

      // Priority: 1. Stored OAuth token, 2. Env var token
      if (storedToken && config._tokenHeader) {
        const prefix = config._tokenPrefix || '';
        resolved.headers = { [config._tokenHeader]: prefix + storedToken.accessToken };
        console.log('MCP: activated ' + name + ' (OAuth token from storage)');
      } else if (tokenVal && config._tokenHeader) {
        const prefix = config._tokenPrefix || '';
        resolved.headers = { [config._tokenHeader]: prefix + tokenVal };
        console.log('MCP: activated ' + name + ' (token auth from env)');
      } else {
        // No token — Claude Code will use OAuth via browser on first use
        console.log('MCP: activated ' + name + ' (OAuth — authenticate via /api/mcp/auth/' + name + ')');
      }

      activeMcp[name] = resolved;
      continue;
    }

    // ── Stdio servers (existing env-var-based activation) ──
    const envVars = Object.values(config.env || {});
    // Only activate if all required env vars are present
    const allPresent = envVars.every(v => {
      const varName = v.replace(/^\\\${/, '').replace(/}$/, '');
      return process.env[varName];
    });

    if (allPresent) {
      // Substitute env vars
      const resolved = JSON.parse(JSON.stringify(config));
      for (const [key, val] of Object.entries(resolved.env || {})) {
        const varName = val.replace(/^\\\${/, '').replace(/}$/, '');
        resolved.env[key] = process.env[varName] || '';
      }
      activeMcp[name] = resolved;
      console.log('MCP: activated ' + name);
    }
  }

  if (Object.keys(activeMcp).length > 0) {
    settings.mcpServers = { ...(settings.mcpServers || {}), ...activeMcp };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }
"

# ── 4. Sync from GCS (handled by server startup, but ensure dirs exist) ──────
mkdir -p /shared-context

# ── 5. Init persistent storage if GCS FUSE is mounted ───────────────────────
if [ -d /persistent ] && mountpoint -q /persistent 2>/dev/null; then
  mkdir -p /persistent/repos /persistent/tools /persistent/shared-context \
    /persistent/npm-cache /persistent/pnpm-store
  export SHARED_CONTEXT_DIR=/persistent/shared-context
  echo "Persistent storage (GCS FUSE) active"

  # Configure pnpm to use the persistent shared content-addressable store.
  # This means all agents share the same package store, so identical packages
  # are downloaded once and hard-linked into each project's node_modules.
  pnpm config set store-dir /persistent/pnpm-store --global 2>/dev/null \
    && echo "pnpm store configured at /persistent/pnpm-store" || true

  # NOTE: /persistent/tools/ auto-shimming has been removed (Layer 7 security hardening).
  # Agents could write malicious scripts to /persistent/tools/ that would be auto-executed
  # as shims on the next container start, creating a persistence backdoor. If persistent
  # tools are needed in the future, add them manually with a verified integrity manifest.

  # ── 6. Prune stale git worktrees from previous container runs ─────────────
  # When containers restart, /tmp workspace dirs are gone but worktree metadata
  # in /persistent/repos/*.git still references them. Clean up before server starts.
  for bare_repo in /persistent/repos/*.git; do
    [ -d "$bare_repo" ] || continue
    git -C "$bare_repo" worktree prune 2>/dev/null && \
      echo "Pruned stale worktrees in $(basename "$bare_repo")" || true
  done
fi

# ── 7. Generate JWT_SECRET if not set ─────────────────────────────────────────
if [ -z "$JWT_SECRET" ]; then
  export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  echo "Generated ephemeral JWT_SECRET"
fi

# ── 8. Start server ──────────────────────────────────────────────────────────
exec node --import tsx server.ts
