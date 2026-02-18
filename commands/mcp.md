# MCP Server Authentication

Check the authentication status of available MCP servers and get OAuth URLs for browser authentication.

**Available MCP Servers:**
- **Figma** — Design and prototyping tool (OAuth or token-based)
- **Linear** — Project management and issue tracking (OAuth or token-based)
- **GitHub** — Version control and collaboration (token-based via GITHUB_TOKEN)
- **Notion** — Workspace and documentation (token-based via NOTION_API_KEY)
- **Slack** — Team communication (token-based via SLACK_TOKEN)
- **Google Calendar** — Calendar integration (token-based via GOOGLE_CREDENTIALS)

## How Authentication Works

**Remote HTTP servers (Figma, Linear):**
- Support two authentication modes:
  1. **OAuth (browser-based)** — No token needed, authenticate via browser when first using the tool
  2. **Token auth** — If an API key env var is set, it's used automatically (skips OAuth)

**Stdio servers (GitHub, Notion, Slack, Google Calendar):**
- Require API tokens provided via environment variables
- Only activated when their required env vars are present

## Checking Authentication Status

Run the following script to see which MCP servers are configured and their authentication status:

```bash
# Read MCP settings
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "=== MCP SERVER STATUS ==="
echo ""

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "No MCP settings found at $SETTINGS_FILE"
  exit 0
fi

# Parse and display MCP servers
node -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf8'));
const mcpServers = settings.mcpServers || {};

if (Object.keys(mcpServers).length === 0) {
  console.log('No MCP servers are currently configured.');
  console.log('');
  console.log('To enable MCP servers, set the required environment variables:');
  console.log('  GITHUB_TOKEN, NOTION_API_KEY, SLACK_TOKEN, FIGMA_TOKEN, LINEAR_API_KEY');
  console.log('');
  console.log('Or use OAuth for Figma and Linear (no tokens needed).');
  process.exit(0);
}

console.log('Configured MCP servers:\\n');

for (const [name, config] of Object.entries(mcpServers)) {
  const type = config.type || 'stdio';

  if (type === 'http') {
    // Remote HTTP server
    const hasToken = config.headers && config.headers.Authorization;
    const authMode = hasToken ? 'Token auth' : 'OAuth (requires browser authentication)';
    console.log(\`✓ \${name} (\${type})\`);
    console.log(\`  URL: \${config.url}\`);
    console.log(\`  Auth: \${authMode}\`);

    if (!hasToken) {
      console.log(\`  → Use /linear or /figma slash commands for direct API access\`);
      console.log(\`  → Alternative: Set \${name.toUpperCase()}_TOKEN env var to enable token auth\`);
    }
  } else {
    // Stdio server (always has token if activated)
    console.log(\`✓ \${name} (\${type})\`);
    console.log(\`  Command: \${config.command} \${(config.args || []).join(' ')}\`);
    console.log(\`  Auth: Token configured\`);
  }
  console.log('');
}
" || echo "Failed to parse MCP settings"
```

## Using Figma and Linear

**Figma and Linear MCP servers are configured with token auth.** Their tools should be available natively in your Claude Code session. Just use them directly — no extra setup needed.

To verify, run the status script above. If it shows `Auth: Token auth` for figma/linear, the MCP tools are ready.

### If MCP tools are not available

If the MCP tools don't appear in your session, use the fallback slash commands which call the APIs directly:
- **Linear**: `/linear` — GraphQL API examples (get issues, search, comment, update status)
- **Figma**: `/figma` — REST API examples (get files, export images, read comments)

**Do NOT try OAuth authentication** — it requires browser access and doesn't work from agent sessions.

## Getting API Tokens

Tokens are set as environment variables via Terraform/deployment config:

- **Linear**: `LINEAR_API_KEY` — [Linear Settings > API](https://linear.app/settings/api)
- **Figma**: `FIGMA_TOKEN` — [Figma Settings > Personal Access Tokens](https://www.figma.com/settings)
- **GitHub**: `GITHUB_TOKEN` — [GitHub Settings > Tokens](https://github.com/settings/tokens)
- **Notion**: `NOTION_API_KEY` — [Notion Integrations](https://www.notion.so/my-integrations)
- **Slack**: `SLACK_TOKEN` — [Slack API > Your Apps](https://api.slack.com/apps)

## Summary

After running the status script above, you'll see:
- Which MCP servers are currently active
- Their authentication method (token-based or OAuth)

**Prefer MCP tools** when available. Fall back to `/linear` or `/figma` slash commands only if MCP tools aren't loading.

$ARGUMENTS
