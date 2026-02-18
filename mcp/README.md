# MCP Server Configuration

MCP (Model Context Protocol) servers give Claude agents access to external tools like Notion, GitHub, Slack, Linear, Figma, etc.

## How it works

On startup, the entrypoint reads `mcp/settings-template.json`, processes each server entry, and merges the result into `~/.claude/settings.json`.

There are two types of MCP servers:

### Stdio servers (token-based)

These run as local processes (via `npx` or `gh`). They require environment variables containing API tokens. Only servers whose required env vars are ALL present get activated.

### Remote HTTP servers (OAuth or token)

These connect to hosted MCP endpoints (e.g. `https://mcp.linear.app/mcp`). They support two authentication modes:

1. **OAuth (browser-based)** — No token needed. The server is activated on startup and agents authenticate via browser when first using it. Run `/mcp` in a Claude Code session to trigger the OAuth flow.
2. **Token auth** — If an API key env var is provided, it's passed as a header, skipping the OAuth flow entirely.

Remote servers marked with `_alwaysActivate: true` are activated even without a token — agents can authenticate via OAuth later.

The `gh` CLI automatically uses the `GITHUB_TOKEN` env var for authentication — no `gh auth login` needed. On container startup, `gh auth setup-git` configures git to use `gh` as a credential helper, so `git push` and `git fetch` to GitHub repos also work automatically.

## Adding credentials

### Via Terraform (production)

Add your tokens to `terraform/terraform.tfvars`:

```hcl
github_token   = "ghp_xxxxx"   # or fine-grained: "github_pat_xxxxx"
notion_api_key = "ntn_xxxxx"
slack_token    = "xoxb-xxxxx"
figma_token    = "figd_xxxxx"  # optional — can use OAuth instead
linear_api_key = "lin_api_xxxxx"  # optional — can use OAuth instead
```

Then apply and redeploy:

```bash
cd terraform
terraform apply
gcloud run services update claude-swarm \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/claude-swarm/claude-swarm:latest \
  --region=$REGION --project=$PROJECT_ID
```

Terraform handles creating the secrets in Secret Manager and injecting them as env vars into Cloud Run. No manual `gcloud secrets` commands needed.

### For local development

Add tokens to your `.env` file (gitignored):

```
GITHUB_TOKEN=ghp_xxxxx
NOTION_API_KEY=ntn_xxxxx
SLACK_TOKEN=xoxb-xxxxx
FIGMA_TOKEN=figd_xxxxx
LINEAR_API_KEY=lin_api_xxxxx
```

Then `npm run dev` — the entrypoint auto-merges MCP settings when these env vars are present.

### OAuth authentication (no tokens needed)

For Figma and Linear, you can skip providing tokens entirely. These servers are always activated and agents can authenticate via OAuth:

1. Start a Claude Code session (or message an agent)
2. Run `/mcp` to see available MCP servers
3. Follow the browser link to authenticate with Figma/Linear
4. Authentication persists for the session

This is useful when you don't want to manage API tokens manually.

## Available integrations

| Server | Type | Env var (optional for OAuth) | Where to get it |
|--------|------|------------------------------|-----------------|
| GitHub | stdio | `GITHUB_TOKEN` | [GitHub Settings > Tokens](https://github.com/settings/tokens) — classic PAT with `repo` scope, or [fine-grained token](https://github.com/settings/personal-access-tokens/new) with Contents + Pull requests (read/write) |
| Notion | stdio | `NOTION_API_KEY` | [Notion Integrations](https://www.notion.so/my-integrations) |
| Google Calendar | stdio | `GOOGLE_CREDENTIALS` | Google Cloud Console → APIs & Services → Credentials |
| Slack | stdio | `SLACK_TOKEN` | [Slack API > Your Apps](https://api.slack.com/apps) → OAuth & Permissions |
| Figma | remote | `FIGMA_TOKEN` (or OAuth) | [Figma Settings > Personal Access Tokens](https://www.figma.com/settings) or authenticate via browser |
| Linear | remote | `LINEAR_API_KEY` (or OAuth) | [Linear Settings > API](https://linear.app/settings/api) or authenticate via browser |

## Usage Examples

### Linear Integration

Once connected (via token or OAuth), agents can:

```
# Find and update issues
"What are my assigned Linear issues?"

# Create issues
"Create a Linear issue for adding dark mode support, assign it to the Frontend team"

# Update issue status
"Move issue FE-123 to In Progress"

# Search and filter
"Show me all high-priority bugs in the Backend project"
```

### Figma Integration

Once connected (via token or OAuth), agents can:

```
# Analyze a design file
"Can you extract the color palette from
https://www.figma.com/file/ABC123/Design-System ?"

# Export assets
"Export all icons from the 'Icons' frame as SVG"

# Generate code from designs
"Create React components based on the button variants
in the Figma file"

# Document design systems
"Generate a markdown file documenting all typography
styles from our Figma library"
```
