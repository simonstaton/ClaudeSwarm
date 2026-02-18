# MCP Tools for Agents

## Overview

MCP (Model Context Protocol) tools are **automatically available** to all agents spawned in the ClaudeSwarm platform. The Claude CLI loads these tools from `~/.claude/settings.json`, which is configured at container startup.

**Token auth is pre-configured for Figma and Linear — just use the MCP tools directly.** Do NOT attempt OAuth flows.

## Currently Available MCP Tools

### Figma
- **Server**: `https://mcp.figma.com/mcp`
- **Authentication**: Personal Access Token (pre-configured)
- **Capabilities**:
  - Read Figma files and design systems
  - Extract design tokens (colors, typography, spacing)
  - Export assets as SVG or PNG
  - Analyze component structures and variants
  - Generate documentation from Figma libraries

### Linear
- **Server**: `https://mcp.linear.app/mcp`
- **Authentication**: API Key (pre-configured)
- **Capabilities**:
  - Create, read, update, and search issues
  - Manage projects, teams, and workflows
  - Assign issues and update status
  - Query issue relationships and dependencies
  - Bulk operations on issues

## How MCP Tools Work

### Automatic Loading
1. Container starts → `entrypoint.sh` runs
2. Script reads `mcp/settings-template.json`
3. For each MCP server:
   - **HTTP servers with tokens** → Added with Authorization headers
   - **Stdio servers** → Only added if required env vars are present
4. Merged config written to `~/.claude/settings.json`
5. All agent `claude` CLI processes automatically load from this file

### Tool Discovery
MCP tools appear alongside built-in Claude Code tools (Bash, Read, Write, etc.). You can use them just like any other tool - the Claude model will automatically invoke them when appropriate.

Example:
```
User: "What are my assigned Linear issues?"
→ Claude automatically calls Linear MCP tools to query issues
→ Returns formatted results
```

## Authentication

### Token Authentication (Pre-configured)

**This is the standard and only supported method for agents.**

- `FIGMA_TOKEN` and `LINEAR_API_KEY` are set as environment variables at container startup
- Tokens are injected as `Authorization: Bearer <token>` headers to MCP HTTP requests
- All agents share the same authentication automatically
- No setup required by agents — it just works

**If MCP tools don't appear in your session**, use the fallback slash commands:
- `/linear` — Direct GraphQL API access
- `/figma` — Direct REST API access

**Do NOT attempt OAuth or browser-based authentication** — agents run in headless environments without browser access.

### Operator Setup (for admins, not agents)

Add tokens to `terraform/terraform.tfvars`:
```hcl
figma_token    = "figd_xxxxx"
linear_api_key = "lin_api_xxxxx"
```

Then deploy:
```bash
cd terraform
terraform apply
gcloud run services update claude-swarm \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/claude-swarm/claude-swarm:latest \
  --region=$REGION --project=$PROJECT_ID
```

## Usage Examples

### Linear Integration

**Query issues:**
```
"What are my assigned Linear issues?"
"Show me all high-priority bugs in the Backend project"
"Find issues related to authentication"
```

**Create issues:**
```
"Create a Linear issue for adding dark mode support"
"Create a bug report for the login flow timeout"
```

**Update issues:**
```
"Move issue FE-123 to In Progress"
"Assign issue BACK-456 to the DevOps team"
"Update issue FE-123 description to include reproduction steps"
```

### Figma Integration

**Analyze designs:**
```
"Extract the color palette from https://www.figma.com/file/ABC123/Design-System"
"Document all typography styles from our Figma library"
"What spacing tokens are defined in the design system?"
```

**Export assets:**
```
"Export all icons from the 'Icons' frame as SVG"
"Get the logo from the Figma file as PNG"
```

**Generate code:**
```
"Create React components based on the button variants in Figma"
"Generate CSS variables from the Figma color tokens"
```

## Troubleshooting

### "Tool not found" errors
**Cause**: MCP server not activated in settings.json
**Fix**:
1. Check `cat ~/.claude/settings.json` to verify mcpServers section exists
2. If missing, check container startup logs for MCP activation messages
3. Fall back to `/linear` or `/figma` slash commands for direct API access

### "Permission denied" errors
**Cause**: API key doesn't have access to requested resource
**Fix**:
1. Verify the token owner has access to the Figma file or Linear project
2. Check that API keys have appropriate scopes
3. Contact your admin to update the token

### Tools not loading
**Cause**: Token may not be configured or settings.json wasn't generated correctly
**Fix**:
1. Run `/mcp` to check MCP server status
2. If status shows "Token auth", tools should work — try again
3. If no token configured, use `/linear` or `/figma` slash commands as fallback

## Implementation Details

### Settings Structure
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

### Agent Spawning Flow
1. `AgentManager.create()` called with prompt
2. `buildClaudeArgs()` constructs CLI arguments
3. `spawn("claude", args, { env, cwd })` starts agent process
4. Claude CLI reads `~/.claude/settings.json`
5. MCP servers loaded and tools become available
6. Agent can immediately use MCP tools

### Additional MCP Servers
The platform can be extended with more MCP servers by:
1. Adding to `mcp/settings-template.json`
2. Setting required environment variables
3. Restarting the container
4. Tools automatically available to all agents

Supported integrations:
- GitHub (already supported via stdio)
- Notion (already supported via stdio)
- Slack (already supported via stdio)
- Google Calendar (already supported via stdio)
