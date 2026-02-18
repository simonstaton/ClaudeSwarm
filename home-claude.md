# Global Agent Instructions

## MCP & Integrations (REQUIRED)

**Figma and Linear are configured as MCP servers with token auth — use MCP tools directly.**
They should appear as available tools in your session (e.g. Figma tools like `mcp__figma__...`). Just use them. The auth headers are pre-configured.

If MCP tools are NOT available in your session (check with `/mcp`), fall back to the API slash commands:
- **Linear fallback**: `/linear` — direct GraphQL API examples
- **Figma fallback**: `/figma` — direct REST API examples

Do NOT attempt OAuth flows. Token auth is already configured.

## Working Memory (REQUIRED)

You MUST maintain a working memory file in shared context that tracks what you are currently doing. This enables other agents and the human operator to see your real-time status.

### File: `shared-context/working-memory-{agent-name}.md`

Use your agent name (from your workspace directory or the name you were given) as the suffix. If you don't know your name, use your workspace UUID.

### Format

```markdown
# Working Memory — {agent-name}

## Current Task
{One-line description of what you are actively doing right now}

## Status
{active | idle | blocked | waiting-for-input}

## Context
{2-3 bullet points of key context: what you've learned, decisions made, blockers}

## Recent Actions
- {Timestamped list of significant actions taken this session, newest first}

## Next Steps
- {What you plan to do next}
```

### Rules
1. **Update on every significant action** — starting a task, completing a task, encountering an error, making a decision, or changing direction.
2. **Update at the START of work** — before you begin any task, write your intent to working memory.
3. **Update at the END of work** — when you finish or get interrupted, record the outcome.
4. **Keep it concise** — this is a status board, not a journal. Overwrite previous entries rather than appending indefinitely.
5. **Clear on completion** — when your session ends or you have no active task, set status to `idle` and clear the current task.

### Example

```markdown
# Working Memory — agent-a1b2c3d4

## Current Task
Adding user authentication endpoint to the API

## Status
active

## Context
- Building JWT-based auth per project-decisions.md
- Using existing Express middleware pattern from server.ts
- Blocked on: nothing

## Recent Actions
- 2026-02-16 14:32 — Created auth routes in src/auth.ts
- 2026-02-16 14:28 — Read project-decisions.md for auth approach
- 2026-02-16 14:25 — Started task, read shared context files

## Next Steps
- Add token validation middleware
- Write tests for auth endpoints
```
