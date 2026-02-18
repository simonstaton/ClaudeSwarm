# MCP Tools Implementation Summary

## Status: COMPLETE

MCP tools (Figma and Linear) are **working** and available to all agents in the ClaudeSwarm platform with **token auth pre-configured**.

## How It Works

### 1. Container Startup (`entrypoint.sh`)
```bash
# entrypoint.sh
node -e "
  # Read /app/mcp/settings-template.json
  # For each MCP server:
  #   - HTTP servers with token env vars → added with Authorization headers
  #   - Stdio servers → only if env vars present
  # Merge into ~/.claude/settings.json
"
```

**Result** (with tokens configured):
```json
{
  "mcpServers": {
    "figma": {
      "type": "http",
      "url": "https://mcp.figma.com/mcp",
      "headers": {
        "Authorization": "Bearer figd_xxxxx"
      }
    },
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": {
        "Authorization": "Bearer lin_api_xxxxx"
      }
    }
  }
}
```

### 2. Agent Spawning (`src/agents.ts`)
```typescript
const proc = spawn("claude", args, {
  env,  // Includes HOME, CLAUDE_HOME from process.env
  cwd: workspaceDir,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
```

### 3. Claude CLI Initialization
- Reads `~/.claude/settings.json` (standard Claude Code behavior)
- Loads mcpServers configuration
- Makes MCP tools available alongside built-in tools
- **No code changes needed** — this is automatic

## Authentication

### Token Auth (Standard)
- **Status**: Working, pre-configured
- **How**: `FIGMA_TOKEN` and `LINEAR_API_KEY` env vars → injected as Authorization headers → MCP tools work immediately
- **Benefit**: All agents share same authentication, no per-session setup
- **Use case**: All deployments

### Fallback: Slash Commands
If MCP tools don't load, agents can use:
- `/linear` — Direct GraphQL API access
- `/figma` — Direct REST API access

### OAuth (Legacy, operator-only)
OAuth support exists for human operators who want to authenticate via browser. It is **not usable by agents** and should not be attempted from agent sessions.

## Testing

To verify MCP tools work:

1. **Start an agent session or message an existing agent**
2. **Try a Linear query**: "What are my Linear issues?"
3. **Expected behavior**: Immediate response with issues (token auth is automatic)

## Documentation

### For Developers/Operators
- **`mcp/README.md`**: Setup and configuration guide
- **`docs/figma-integration.md`**: Figma-specific usage guide
- **`docs/mcp-oauth.md`**: OAuth reference (operator-only)

### For Agents
- **`home-claude.md`**: Primary agent guidance (MCP section)
- **`commands/mcp.md`**: `/mcp` slash command for status checking
- **`commands/linear.md`**: `/linear` API fallback
- **`commands/figma.md`**: `/figma` API fallback

## Code Changes Required

**None.** The implementation is already complete:
- MCP servers configured in settings.json (via entrypoint.sh)
- Agent spawning passes correct environment (src/agents.ts)
- Claude CLI automatically loads MCP tools
- Token auth headers injected at container startup

## Additional MCP Servers

The platform supports these integrations:
- GitHub (stdio) — requires `GITHUB_TOKEN`
- Notion (stdio) — requires `NOTION_API_KEY`
- Slack (stdio) — requires `SLACK_TOKEN`
- Google Calendar (stdio) — requires `GOOGLE_CREDENTIALS`

To activate: Set the required env vars in `terraform/terraform.tfvars` and redeploy.
