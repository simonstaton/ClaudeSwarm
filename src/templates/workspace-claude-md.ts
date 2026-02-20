export interface WorkspaceClaudeMdOptions {
  agentName: string;
  agentId: string;
  workspaceDir: string;
  port: string;
  otherAgents: Array<{ name: string; id: string; role?: string; status: string }>;
  contextIndex: string;
  repoList: string[];
  skillsList: string;
}

export function generateWorkspaceClaudeMd(opts: WorkspaceClaudeMdOptions): string {
  const otherAgentsStr =
    opts.otherAgents.length > 0
      ? `**Currently active agents:**\n${opts.otherAgents
          .map((a) => `- \`${a.name}\` (${a.id.slice(0, 8)}) - ${a.role || "general"} - ${a.status}`)
          .join("\n")}\n`
      : "**No other agents currently active.**\n";

  const repoDescriptions: Record<string, string> = {
    "ClaudeSwarm_PRIVATE.git":
      "Private repo - primary development target. All PRs, branches, and code changes go here.",
    "ClaudeSwarm.git":
      "Public repo - public mirror of the private repo. Kept in sync by force-pushing private main -> public main during releases. **Never commit directly to this repo.**",
  };

  const reposSection =
    opts.repoList.length > 0
      ? `\n## Persistent Repos
${opts.repoList.map((r) => `- \`${r}\`${repoDescriptions[r] ? ` - ${repoDescriptions[r]}` : ""}`).join("\n")}
For usage instructions (worktrees, cloning, tools), see \`shared-context/guides/persistent-storage.md\`
`
      : "";

  const skillsSection = `
## Skills / Slash Commands
**Available skills:**
${opts.skillsList}
`;

  return `# Agent Workspace

## Identity
- **Name:** \`${opts.agentName}\` | **ID:** \`${opts.agentId}\`
- **Workspace:** \`${opts.workspaceDir}\`
- **Platform:** Cloud Claude Swarm - GCP Cloud Run, TS/Express + React/Vite

## API Access
**Base:** \`http://localhost:${opts.port}\` | **Auth:** \`Bearer $(cat ${opts.workspaceDir}/.agent-token)\`

> **Auth token:** The file \`.agent-token\` in your workspace root is managed by the platform and refreshed automatically. Always use \`$(cat ${opts.workspaceDir}/.agent-token)\` in curl commands - never hardcode the token value. The \`$AGENT_AUTH_TOKEN\` env var is also set at startup as a fallback but may go stale; prefer the file.

### Auth errors
If an API call returns **401 Unauthorized**: re-read the token file (it may have just been refreshed) and retry the request **once**. If still 401, stop retrying - your session may have been terminated.

Endpoints (all require auth header):
- \`GET  /api/messages/stream?agentId={id}\` - **SSE stream** - use this to receive messages from other agents; server pushes instantly over a persistent connection (15s heartbeat). Without this, you will not receive messages from other agents unless you poll manually.
- \`GET  /api/messages?to={id}&unreadBy={id}\` - poll for messages (fallback only if SSE connection drops)
- \`POST /api/messages\` body: \`{from, fromName, to?, type, content, channel?, excludeRoles?}\` - send message (excludeRoles: optional array of agent roles to exclude from broadcasts)
- \`POST /api/messages/{id}/read\` body: \`{agentId}\` - mark read
- \`GET  /api/agents/registry\` - list agents
- \`GET  /api/agents/{id}/logs?tail=N&type=stderr,system&format=text\` - get your session logs for debugging
- \`PATCH /api/agents/{id}\` body: \`{role?, currentTask?}\` - update profile
- \`POST /api/agents\` body: \`{prompt, name, model?, role, parentId}\` - spawn sub-agent (models: "claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-opus-4-6"; defaults to sonnet-4-6)
- \`POST /api/agents/batch\` body: \`{agents: [{prompt, name, model?, role, parentId}, ...]}\` - spawn multiple sub-agents at once (max 10, returns JSON)
- \`DELETE /api/agents/{id}\` - destroy agent

Message types: task, result, question, info, status, interrupt
For full curl examples and JSON escaping tips, see \`shared-context/guides/api-reference.md\`

## Spawning Sub-Agents

**Two options - choose based on the situation:**

1. **Native Task tool** (preferred for speed) - Use the built-in \`Task\` tool for fast, ephemeral subtasks. The sub-agent runs in your process, returns results directly, and is invisible to the platform UI. Use this for research, analysis, code review, file exploration, or any "do this and report back" work. Zero overhead, no process spawning. **Note: the Task tool always inherits YOUR model - it cannot use a different model.**

2. **Platform API** (\`POST /api/agents\`) - Use this when the human operator needs to see and interact with the agent in the UI, when the agent needs to live independently beyond your session, when peer-to-peer coordination with other visible agents is needed, **or when a specific model is requested** (e.g. Haiku for cost savings).

**Rule of thumb:** If no one needs to see or interact with the sub-agent AND no specific model is requested, use the Task tool. If the user should be able to monitor, message, or interrupt it, OR if a specific model is needed, use the Platform API.

${otherAgentsStr}
## Shared Context
\`shared-context/\` contains markdown files shared between all agents.

**Do NOT read all files.** Use the index below to decide what's relevant, then fetch only what you need.

### File Index
${opts.contextIndex || "(no files yet)"}

### Retrieval
1. Read the summaries above
2. Decide which files are relevant to your current task
3. Use the Read tool to fetch only those files
4. If unsure, read 1-2 most likely files - don't read everything

## Working Memory
Your working memory file is \`shared-context/working-memory-${opts.agentName}.md\` - it has been pre-created for you. You MUST keep it updated as you work (see home-claude.md for the required format).

## Key Behaviors
- Connect to \`GET /api/messages/stream?agentId=${opts.agentId}\` on startup to receive messages from other agents in real-time
- Announce status via message bus when starting/finishing work
- Check agent registry before starting to avoid duplicate effort
- For guides on API usage, collaboration, storage, skills, see \`shared-context/guides/\`
${reposSection}${skillsSection}
## Workspace
- Files you create here are ephemeral - only \`shared-context/\` and \`repos/\` persist
`;
}
