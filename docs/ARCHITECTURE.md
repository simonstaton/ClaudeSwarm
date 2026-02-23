# AgentManager architecture and module map

Short reference for navigating the codebase and tracing flows. See also CLAUDE.md (project structure, conventions).

## Where to look

- **SSE / streaming** → `src/routes/agents.ts`, `src/utils/sse.ts`
- **Kill-switch** → `src/kill-switch.ts` (state, GCS poll); exempt paths and 503 in `server.ts`
- **Recovery / startup** → `server.ts` `start()`, `src/cleanup.ts`, `src/storage.ts`, `src/persistence.ts`
- **Message → agent prompt** → `src/message-delivery.ts`
- **Exempt paths (no auth, allowed when killed/recovering)** → `src/exempt-paths.ts`

## Entry and composition

- **`server.ts`** – Single entry. Builds Express app, creates services (AgentManager, MessageBus, TaskGraph, etc.), mounts routes, wires message delivery and keepalive, runs recovery then starts listening. No business logic; only wiring and process lifecycle.

## Routes (`src/routes/`)

| Router | Paths | Depends on |
|--------|--------|------------|
| **health** | `GET /api/health` | AgentManager, memory limit, isRecovering, dep-cache, guardrails (MAX_AGENTS) |
| **auth** | `POST /api/auth/token` | auth.exchangeKeyForToken |
| **agents** | `/api/agents/*` | AgentManager, MessageBus, keepalive, isMemoryPressure |
| **messages** | `/api/messages/*` | MessageBus |
| **config** | `GET/PUT /api/settings*`, `GET/PUT/POST/DELETE /api/claude-config*` | auth (requireHumanUser), guardrails, MCP OAuth storage, storage (syncClaudeHome), sanitize, config-paths |
| **context** | `/api/context/*` | Storage (shared-context) |
| **cost** | `/api/cost/*` | AgentManager, CostTracker, MessageBus |
| **tasks** | `/api/tasks/*` | TaskGraph, Orchestrator, GradeStore |
| **scheduler** | `/api/scheduler/*` | Scheduler |
| **workflows** | `/api/workflows/*` | AgentManager, MessageBus |
| **repositories** | `/api/repos/*` | AgentManager (workspace/repos) |
| **kill-switch** | `GET /api/kill-switch` (state), `POST /api/kill-switch` (activate/deactivate) | AgentManager |
| **mcp** | `/api/mcp/*` | MCP OAuth, config |
| **usage** | `/api/usage/*` | AgentManager |

All route modules export a `create*Router(...)` factory. Dependencies are injected so routes stay testable and the server remains the only place that knows concrete types.

## Core services (used by server and/or routes)

- **`src/agents.ts`** – `AgentManager`: create/destroy agents, spawn Claude CLI, workspace per agent, delivery lock (canDeliver/deliveryDone), interrupt.
- **`src/messages.ts`** – `MessageBus`: post/query messages, persist to disk, subscribe for real-time delivery.
- **`src/message-delivery.ts`** – Auto-delivery: subscribes to MessageBus and AgentManager.onIdle; formats prompts and calls AgentManager.message. Single place for “when does a message get pushed into an agent?”
- **`src/orchestrator.ts`** – Assigns tasks from TaskGraph to idle agents; uses AgentProvider and MessageSender (wired in server to AgentManager + MessageBus).
- **`src/task-graph.ts`** – `TaskGraph`: task CRUD, dependencies, assignment.
- **`src/scheduler.ts`** – `Scheduler`: cron-like jobs (health-check, agent-wake, webhooks); execution context (sendWebhook, wakeAgent, checkHealth) wired in server.
- **`src/cost-tracker.ts`** – Token/cost tracking.
- **`src/grading.ts`** – `GradeStore` + risk grading for tasks.

## Persistence and storage

- **`src/persistence.ts`** – Agent state (save/load/cleanup), tombstone, events dir.
- **`src/storage.ts`** – Shared context (GCS sync, ensureDefaultContextFiles, cleanupClaudeHome, debouncedSyncToGCS).
- **`src/kill-switch.ts`** – Kill state (in-memory + GCS poll), loadPersistedState, startGcsKillSwitchPoll.

## Startup and cleanup

- **`src/cleanup.ts`** – `cleanupOrphanedProcesses()`, `cleanupStaleWorkspaces(manager)`. Used during server recovery.
- **`src/worktrees.ts`** – `startWorktreeGC(getActiveWorkspaceDirs)` – periodic GC of worktrees for dead workspaces; started in `server.start()`.
- **`src/dep-cache.ts`** – `initDepCache()` during startup; health route reports `depCache.persistent` and `depCache.ready`.
- Recovery sequence (in `server.start()`): `syncFromGCS` → `ensureDefaultContextFiles` → `startPeriodicSync` → `loadPersistedState` (if wasKilled: skip restore) → `hasTombstone` (if set: skip restore) → `cleanupStaleState` → `cleanupOrphanedProcesses` → `initDepCache` → `agentManager.restoreAgents` → `cleanupStaleWorkspaces` → `cleanupClaudeHome` → `ensureTokenDir` (MCP OAuth) → token refresh interval, `startWorktreeGC`, `startGcsKillSwitchPoll` (can trigger emergency destroy + JWT rotation) → orchestrator.start(), scheduler.start(); then `recovering = false`.

## Shared / cross-cutting

- **`src/types.ts`** – Agent, AgentMessage, StreamEvent, CreateAgentRequest, AuthPayload, AuthenticatedRequest, errorMessage().
- **`src/logger.ts`** – Single logger used by server and all modules.
- **`src/auth.ts`** – JWT exchange, verify, authMiddleware, requireHumanUser.
- **`src/guardrails.ts`** – Model allowlist, bounds (max agents, prompt length, etc.).
- **`src/validation.ts`** – Request validators, rate limit middleware.
- **`src/utils/`** – sse, express helpers, files, config-paths, context (getContextDir), memory (getContainerMemoryUsage).

## Tracing common flows

1. **Request → agent**  
   Route (e.g. `routes/agents.ts`) → AgentManager (create/message/destroy). Auth: `authMiddleware` (`src/auth.ts`) attaches user to request; exempt paths in `src/exempt-paths.ts`.

2. **Message → agent prompt**  
   MessageBus.post (or UI/API) → `src/message-delivery.ts` (subscribe + onIdle) → formatDeliveryPrompt + deliverMessage → MessageBus.markRead + AgentManager.message.

3. **Task assignment**  
   Task created via `/api/tasks` → TaskGraph → Orchestrator (assignment loop) → MessageSender (MessageBus.post task) → message-delivery delivers to agent.

4. **Kill-switch**  
   POST `/api/kill-switch` or GCS poll (`startGcsKillSwitchPoll`) → in-memory state (+ optional emergency destroy + JWT rotation). Middleware in `server.ts` returns 503 for non-exempt `/api/*`; exempt: `/api/health`, `/api/auth/token`, `/api/kill-switch` (see `src/exempt-paths.ts`).

5. **Shutdown**  
   SIGTERM/SIGINT → stop GCS poll, orchestrator, agents, cost tracker, task graph, scheduler, `stopPeriodicSync`, `syncToGCS`, server.close.

6. **Startup**  
   `server.start()` → see “Startup and cleanup” above; `recovering` flips to false at end.

Keeping route handlers thin, dependencies injected at the composition root, and domain logic in dedicated modules (message-delivery, cleanup, persistence, storage) makes it easier for humans and LLMs to follow these paths.
