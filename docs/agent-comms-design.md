# Agent Communication System — Architecture

## Overview

The ClaudeSwarm platform implements a multi-agent communication system that allows Claude agents to discover, coordinate, and delegate work to each other. The system combines an in-memory message bus with persistent shared context files to enable both real-time and asynchronous collaboration.

## Architecture

```
User → UI (React) → POST /api/agents → AgentManager.create() → spawns `claude` CLI process
                                         └─ each agent gets /tmp/workspace-{uuid}/
                                         └─ all agents share /shared-context/ (symlinked)
                                         └─ all agents share /persistent/repos/ (bare git clones)
                                         └─ MessageBus coordinates inter-agent comms
```

- Agents are independent `claude` CLI processes with isolated workspaces
- Shared context is a directory of `.md` files synced to GCS for persistence
- In-memory message bus provides real-time pub/sub messaging
- Agent registry tracks active agents, their roles, and current tasks
- CLAUDE.md instructs agents how to use the message bus and shared context

## Components

### 1. Message Bus (`src/messages.ts`)

A lightweight in-memory message bus that agents use for real-time coordination.

**API endpoints:**

```
POST   /api/messages                  — post a message (from UI or agent)
GET    /api/messages?to={agentId}     — get messages for an agent
GET    /api/messages?channel={name}   — get messages on a channel
POST   /api/messages/:id/read         — mark a message as read
POST   /api/messages/read-all         — mark all messages as read for an agent
DELETE /api/messages/:id              — delete a message
GET    /api/messages/stream           — SSE stream of new messages (real-time)
```

**Message schema:**

```typescript
interface AgentMessage {
  id: string;                          // uuid
  from: string;                        // agentId or "user"
  fromName?: string;                   // agent name for display
  to?: string;                         // specific agentId (DM) or undefined (broadcast)
  channel?: string;                    // topic channel: "tasks", "status", "general"
  type: "task" | "result" | "question" | "info" | "status" | "interrupt";
  content: string;                     // markdown body
  metadata?: Record<string, unknown>;  // structured data (e.g. file paths, PR URLs)
  createdAt: string;
  readBy: string[];                    // which agents have read this
  excludeRoles?: string[];             // agent roles to exclude from broadcasts (e.g. ["Haiku Coder"])
}
```

**Implementation:** In-memory array with optional GCS persistence (same pattern as shared-context sync). No Redis, no database.

### 2. Agent Registry & Discovery

The existing `/api/agents` endpoint is extended with agent metadata to enable discovery.

**Extended Agent type:**
```typescript
interface Agent {
  // ... existing fields ...
  role?: string;         // "coder", "reviewer", "researcher", etc.
  capabilities?: string[]; // ["typescript", "python", "devops"]
  currentTask?: string;  // what the agent is working on right now
  parentId?: string;     // parent agent ID (for sub-agents)
}
```

**Registry endpoint:**
```
GET /api/agents/registry  — returns all agents with roles/capabilities/status/unread message counts
```

**Metadata updates:**
```
PATCH /api/agents/:id  — update role, capabilities, or currentTask
```

**CLAUDE.md instructions tell agents to:**
- Update their profile (`PATCH /api/agents/:id`) when starting work or changing tasks
- Check the registry before starting work to avoid duplicating effort
- Post status messages to the message bus when starting/completing tasks

### 3. Task Delegation Protocol

A simple convention (not heavy infrastructure) for agents to assign work to each other.

**Flow:**
1. Agent A posts a message: `{ type: "task", to: "agent-B-id", content: "Review PR #42" }`
2. Agent B sees it in its message queue (via periodic check or `/check-messages` skill)
3. Agent B posts back: `{ type: "result", to: "agent-A-id", content: "LGTM, 2 minor issues..." }`

**Slash command skills** (`~/.claude/commands/`) help agents interact with the system:

- `/agent-status` — Show all active agents with roles and current tasks
- `/check-messages` — Check inbox for unread messages addressed to this agent
- `/send-message` — Post a message to the bus (task, result, question, info, status)
- `/spawn-agent` — Create a new sub-agent with a specific role and task

Agents are instructed in CLAUDE.md to:
- Check messages periodically during long tasks
- Process messages according to type (task → do work, question → answer, etc.)
- Post results back to the sender when work is complete

### 4. Parent-Child Agent Relationships

Agents can spawn sub-agents to delegate work. The platform automatically manages the lifecycle.

**Creating a sub-agent:**
```bash
POST /api/agents
{
  "name": "sub-agent-name",
  "role": "researcher",
  "parentId": "parent-agent-id",
  "prompt": "Your task description"
}
```

**Lifecycle management:**
- When a parent agent is destroyed, all child agents are automatically destroyed
- The `/spawn-agent` skill wraps this API for easy use from agents
- Child agents can be temporary (for one-off tasks) or long-lived (for ongoing work)

### 5. UI Integration

#### Message Feed
- Real-time feed of inter-agent messages in `ui/src/components/MessageFeed.tsx`
- Displays in sidebar alongside shared-context tab
- Filter by channel, agent, or message type
- User can inject messages into any channel

#### Agent Cards
- Show agent role, current task, and unread message count
- Visual indicators for agent status and activity
- Quick "Send message to agent" action

#### Registry View
- Visual display of all active agents and their roles
- Shows which agents are communicating with each other
- Provides agent discovery for task delegation

## Key Design Decisions

1. **In-memory over database** — Agents are ephemeral (Cloud Run), messages don't need to survive container restarts beyond GCS sync. Keep it simple.
2. **Auto-delivery with pull fallback** — The server automatically delivers messages to idle agents by resuming their Claude CLI process with the message content. Busy agents receive messages when they next go idle. The `interrupt` message type can force-deliver to a busy agent by killing its current process and restarting with the message. The `/check-messages` skill is available as a manual fallback.
3. **Convention over infrastructure** — Most coordination happens via CLAUDE.md instructions and message conventions, not complex distributed systems code.
4. **Backward compatible** — Shared-context files continue to work. Messages are an additional channel, not a replacement.
5. **Parent-child cleanup** — Automatic destruction of child agents prevents orphaned processes and simplifies agent lifecycle management.

## System Files

| File | Purpose |
|------|---------|
| `src/messages.ts` | MessageBus class implementation |
| `src/types.ts` | AgentMessage type, extended Agent type |
| `server.ts` | Message endpoints, registry endpoint, parent-child cleanup |
| `CLAUDE.md` | Agent instructions for message-checking and coordination |
| `src/storage.ts` | GCS sync for shared-context and claude-home |
| `ui/src/api.ts` | Message API client functions |
| `ui/src/components/Sidebar.tsx` | Messages tab integration |
| `ui/src/components/MessageFeed.tsx` | Real-time message feed |
| `ui/src/components/AgentCard.tsx` | Role/task/message count display |
| `commands/check-messages.md` | Skill for agents to check inbox |
| `commands/send-message.md` | Skill for agents to post messages |
| `commands/agent-status.md` | Skill for agents to view registry |
| `commands/spawn-agent.md` | Skill for agents to create sub-agents |
