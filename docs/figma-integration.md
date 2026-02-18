# Figma Integration Guide

ClaudeSwarm supports Figma MCP (Model Context Protocol) integration, allowing Claude agents to interact with Figma files, components, and design systems directly.

## Features

With Figma MCP enabled, agents can:

- **Read Figma files**: Access file structure, frames, and component hierarchies
- **Inspect designs**: Extract design tokens, colors, typography, and spacing
- **Export assets**: Retrieve images and SVGs from Figma frames
- **Analyze components**: Review component properties and variants
- **Design system documentation**: Auto-generate documentation from Figma libraries

## Setup

ClaudeSwarm connects to Figma's official remote MCP server at `https://mcp.figma.com/mcp`. You can authenticate in two ways:

### Option 1: OAuth (browser-based — no token needed)

Figma MCP is always activated on startup. Agents authenticate via browser on first use:

1. Start a Claude Code session (or message an agent)
2. Run `/mcp` to see available MCP servers
3. Click the Figma authentication link to sign in via browser
4. Authentication persists for the session

This is the simplest approach — no tokens to manage.

### Option 2: Personal Access Token

If you prefer token-based auth (e.g. for headless/automated use):

1. Go to [Figma Settings](https://www.figma.com/settings)
2. Scroll to **Personal Access Tokens**
3. Click **Create new token**
4. Give it a descriptive name (e.g., "ClaudeSwarm Agent Access")
5. Copy the token (it starts with `figd_`)

#### For local development

Add to `.env`:

```bash
FIGMA_TOKEN=figd_your_token_here
```

#### For production (Terraform)

Add to `terraform/terraform.tfvars`:

```hcl
figma_token = "figd_your_token_here"
```

Then apply and redeploy:

```bash
cd terraform
terraform apply
gcloud run services update claude-swarm \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/claude-swarm/claude-swarm:latest \
  --region=$REGION --project=$PROJECT_ID
```

When a token is provided, it's passed as a Bearer header to the remote server, skipping the OAuth flow.

## Usage Examples

### Inspecting a Figma File

```
Agent: Can you analyze the design system in this Figma file?
https://www.figma.com/file/ABC123/Design-System

Agent will:
- Read the file structure
- Extract color palette
- Document typography scale
- List component variants
```

### Exporting Assets

```
Agent: Export all icons from the "Icons" frame as SVG
```

### Design-to-Code

```
Agent: Generate React components based on the button variants
in frame "Button Components"
```

### Documentation Generation

```
Agent: Create a markdown document of our design tokens
from the Figma library
```

## Permissions & Security

- OAuth tokens are scoped to the authenticating user's Figma access
- Personal access tokens grant access to all files the token owner can view
- In production, tokens are managed via GCP Secret Manager
- Never commit tokens to version control

## Troubleshooting

### OAuth Flow Not Working

Check that:
1. The agent session supports browser-based authentication
2. The Figma remote MCP server is reachable (`https://mcp.figma.com/mcp`)
3. Run `/mcp` in the agent session to retry authentication

### MCP Server Not Loading (Token Auth)

Check that:
1. `FIGMA_TOKEN` is set in your environment
2. The token is valid and not expired
3. Agent container has been restarted after adding the token

### Permission Denied Errors

Ensure:
- The authenticated user or token has access to the requested file
- The file URL is correct and shared with the token owner

## Additional Resources

- [Figma API Documentation](https://www.figma.com/developers/api)
- [Figma MCP Server Guide](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)
- [MCP Protocol Specification](https://modelcontextprotocol.io)
