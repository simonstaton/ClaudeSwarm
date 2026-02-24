# Node graph and agent activity – real-time visibility and graph-theory options

## Goals

1. **Improve the node graph** – Make the agent topology view update instantly when agents or their activity change.
2. **Agents see all other agents’ activity instantly** – So coordination and awareness don’t depend on slow polling.
3. **Use graph theory where it helps** – Clearer model, better routing/notifications, and optional analytics.

## Current state

| Concern | Implementation | Latency |
|--------|----------------|---------|
| **Agent topology (graph)** | `GET /api/agents/topology` → GraphView polls every **5s** | Up to 5s |
| **Agent list (dashboard/sidebar)** | `useAgentPolling` → `GET /api/agents` every **5s** | Up to 5s |
| **Inter-agent messages** | MessageBus + `GET /api/messages/stream` **SSE** | Real-time for UI |
| **Agents discovering peers** | Agents call `GET /api/agents` or `GET /api/agents/registry` (pull) | On-demand only |
| **Agents seeing “who did what”** | No dedicated feed; agents infer from messages and registry | No real-time |

So: the **graph and agent list are poll-based**; **messages are already real-time** for the UI. Agents have **no push or stream** of other agents’ activity.

Relevant code:

- **Graph**: `ui/src/views/GraphView.tsx` – `load()` + `setInterval(load, 5000)`; `api.fetchTopology()`.
- **Agents list**: `ui/src/hooks/useAgentPolling.ts` – `fetchAgents()` every 5s.
- **Messages SSE**: `src/routes/messages.ts` – `messageBus.subscribe()` → `res.write(data)`; `src/messages.ts` – `MessageBus.subscribe()`.
- **Topology source**: `src/routes/agents.ts` – `GET /api/agents/topology` builds nodes/edges from `agentManager.list()` and `parentId`.

Agent state (status, currentTask, lastActivity, etc.) is updated in `src/agents.ts` and `PATCH /api/agents/:id`; there is **no pub/sub for “agent or topology changed.”**

---

## Potential solutions

### 1. Real-time topology and agent list (SSE)

**Idea:** Emit topology/agent changes over SSE so the UI (and, if needed, other consumers) see updates immediately.

- **Server:** Add a subscription mechanism for “agents list or any agent metadata changed” (e.g. `AgentManager.subscribe()` or a small `TopologyService` that subscribes to agent lifecycle and PATCH). Expose e.g. `GET /api/agents/topology/stream` or `GET /api/agents/stream` that:
  - Sends a full snapshot on connect.
  - Pushes an update (full or incremental) whenever the topology or any agent’s status/currentTask/lastActivity changes.
- **UI:** GraphView and agent list use this SSE instead of polling (with reconnect and optional short-interval poll as fallback).
- **Result:** Graph and list both update as soon as anything changes.

**Graph theory:** Unchanged; still a forest (trees) from `parentId`. Lays the foundation for any future graph-structured APIs.

---

### 2. Activity log + “since” APIs (for agents to see each other)

**Idea:** Give agents a way to query “what changed since I last looked” so they can approximate “see all other agents’ activity” without holding connections.

Options:

- **A. Registry with `since`:**  
  `GET /api/agents/registry?since=<iso>` returns only agents whose metadata (status, currentTask, lastActivity, etc.) changed after that time (or return deltas). Agents poll every 5–10s with `since=lastCheck` and get minimal payloads and clear “recent activity” semantics.
- **B. Dedicated activity log:**  
  Append-only stream of events: “agent X status → idle”, “agent Y currentTask → …”, “message from A to B”. Stored in memory (and optionally persisted). `GET /api/activity?since=<iso>` returns recent events. Agents poll with `since=` to get a feed of what others did.
- **C. Push activity into message delivery:**  
  When delivering a message to an idle agent, prepend a short “recent activity” summary (from the activity log or registry diff) so the agent gets fresh context with every delivery.

**Graph theory:** Not required for the API shape; later, “who to include in activity summary” could use graph (e.g. same subtree, or same connected component).

---

### 3. Graph-theory improvements on the topology

**Idea:** Treat the agent topology and/or message flow as an explicit graph and use standard algorithms for routing and UX.

- **Model:**  
  - **Agent graph:** Nodes = agents; edges = `parentId` (already implicit). Optionally add edges from message flow (who messaged whom recently).
- **Use cases:**
  - **Notify subtree:** When a parent posts a status, notify only descendants (BFS/DFS from parent).
  - **Notify path to root:** When a leaf completes a task, notify ancestors (walk parentId to root).
  - **Connected components:** Detect disjoint sub-teams (e.g. after restarts or partial failures).
  - **Centrality (e.g. betweenness):** Highlight “coordinator” agents in the UI.
- **API:** Keep `GET /api/agents/topology` as the main contract. Optionally add `?includeCommunications=true` that adds edges (or a second edge set) derived from recent MessageBus traffic. No need to change the core topology type; only extend when needed.

**Implementation:** All of this can live in a small module (e.g. `src/agent-graph.ts`) that takes `agents[]` and optional `recentMessages[]`, builds adjacency structures, and exposes helpers (e.g. `getSubtreeIds(agentId)`, `getPathToRoot(agentId)`, `getConnectedComponents()`). The UI or message-delivery logic can call these when needed.

---

### 4. Unified graph (agents + tasks)

**Idea:** One graph that includes both agent topology and task dependencies so the UI can show “which agent is on which task” and “how tasks depend.”

- **Model:** Two node types (agent, task); edges = parent-child (agents) + task dependency (from `TaskGraph`). Could be one endpoint, e.g. `GET /api/graph/unified`, or two (topology + task graph) that the UI merges.
- **Benefit:** Single view for “who is doing what and what’s blocked.”
- **Graph theory:** DAG for tasks; forest for agents; combined may have multiple components. Layout and filtering become more important (e.g. filter by agent vs by task).

Best treated as a **later phase** after topology stream and activity visibility are in place.

---

### 5. Communication graph (who talks to whom)

**Idea:** Derive a graph from MessageBus (from/to, or channel participation) and use it for routing or display.

- **Edges:** e.g. “A sent to B” or “A and B both used channel X” in a time window.
- **Use:** “Notify everyone who recently talked to agent X”; or overlay “communication edges” on the agent topology in the UI.
- **Implementation:** Query `MessageBus.query()` by time range; build adjacency; optionally merge with topology for one API (e.g. topology + communication overlay).

---

### 6. Agents “subscribing” to activity (push)

**Idea:** True push of activity to agents.

- **Constraint:** Agents are CLI processes; they don’t hold long-lived HTTP connections. So “push” means either:
  - **On next pull:** When an agent next calls the API (e.g. `/check-messages` or `GET /api/agents/registry`), the response includes “recent activity since your last call” (see activity log + since above).
  - **Inject into prompt:** When we’re about to deliver a message (or a tick), we inject a short “recent activity” blurb into the prompt (from activity log or registry diff). No new connection; agents “see” activity when they wake.

So “instant” for agents is achieved by **frequent-enough pull with since=** and/or **activity summary on delivery**, not by a separate agent-held stream.

---

## Optimal plan (recommended order)

### Phase 1: Real-time graph and agent list (UI)

1. **Emit topology/agent changes from the server**
   - Add a subscription in `AgentManager` (or a thin wrapper) that fires when:
     - An agent is created, destroyed, or updated (PATCH), or
     - Any field that topology depends on changes (status, currentTask, lastActivity, role, parentId, etc.).
   - Implement the same pattern as MessageBus: `subscribe(listener) => () => void`, and call listeners after mutations (create, destroy, PATCH, and any internal status updates in `agents.ts` that affect the list or metadata).

2. **New SSE endpoint**
   - Add e.g. `GET /api/agents/topology/stream` (or `GET /api/agents/stream`):
     - On connect: send one full snapshot (same shape as current `GET /api/agents/topology`).
     - On any topology/agent change: send a full snapshot again (or a small delta format if we add it later). Use heartbeats (e.g. 15s) like the message stream.
   - Reuse the same SSE patterns as in `src/routes/messages.ts` (headers, heartbeat, cleanup on close).

3. **UI: switch from poll to SSE**
   - **GraphView:** Replace `setInterval(load, 5000)` with a single `EventSource` (or fetch-based SSE) to the new stream; on each event, call `setTopology(data)`. Keep a one-time `fetchTopology()` on mount as fallback if SSE isn’t available.
   - **useAgentPolling:** Either consume the same topology stream and derive the list from `nodes`, or add a separate `GET /api/agents/stream` that sends the list; in both cases, remove the 5s interval when SSE is connected. Optionally keep a longer-interval poll when tab is hidden.

**Outcome:** Operators see the node graph and agent list update instantly. No graph-theory change yet.

---

### Phase 2: Agents see each other’s activity (activity feed + since)

1. **Activity log (in-memory first)**
   - Append-only list (or ring buffer) of “activity events”: e.g. `{ at, agentId, kind: 'status'|'task'|'message', ... }`. Push when:
     - Agent status/currentTask/lastActivity changes (in AgentManager and on PATCH),
     - A message is posted (from MessageBus).
   - Cap size (e.g. last 500 events). Optionally persist to disk (e.g. JSONL) for restarts.

2. **APIs for agents**
   - **Option A – Registry with `since`:**  
     `GET /api/agents/registry?since=<iso>`: return agents that changed after that time (or full list with a `changedAt`-style field). Agents poll every 5–10s with `since=lastCheck`.
   - **Option B – Activity endpoint:**  
     `GET /api/activity?since=<iso>&limit=50`: return activity events after that time. Agents get a clear “feed” of what others did.
   - Prefer one to start (e.g. registry `since` is smaller; activity is richer). Can add the other later.

3. **Documentation for agents**
   - In CLAUDE.md / workspace template: “To see other agents’ activity, call `GET /api/agents/registry?since=<lastCheck>` (or `GET /api/activity?since=...`) every N seconds and merge with your local view.”
   - Optionally: when delivering a message to an idle agent, prepend a one-line “Recent activity: …” from the activity log so they get fresh context without polling.

**Outcome:** Agents can see “what changed” since last check and reason about who is doing what, with minimal payload and no new connection type.

---

### Phase 3: Graph-theory helpers (optional, for routing and UX)

1. **Explicit agent graph module**
   - Add e.g. `src/agent-graph.ts`: input = `agents[]` (+ optional `recentMessages[]`). Build:
     - Parent-child adjacency (from `parentId`).
     - Optionally communication edges from messages (from/to in last N minutes).
   - Expose:
     - `getSubtreeIds(agentId)` (BFS/DFS from agent).
     - `getPathToRoot(agentId)` (walk parentId).
     - `getConnectedComponents()` (e.g. union-find or BFS).
     - Optional: simple centrality (e.g. degree or betweenness) for “key” agents.

2. **Use in message delivery or API**
   - e.g. “Notify subtree” when a parent broadcasts: use `getSubtreeIds(parentId)` to filter which agents get the message.
   - e.g. “Notify path to root” when a leaf completes something: use `getPathToRoot(leafId)` and post to those agents.
   - Optional: `GET /api/agents/topology?includeCommunications=true` that adds communication edges to the payload so the UI can draw them.

3. **UI**
   - Optional: highlight “coordinator” agents (e.g. by degree or betweenness) or show communication overlay on the graph. Can be a follow-up.

**Outcome:** Clear graph model and reusable algorithms for routing and analytics; topology stream and activity feed remain the main “instant visibility” mechanisms.

---

### Phase 4 (later): Unified graph and task overlay

- Single endpoint or view that merges agent topology and task graph (tasks + dependencies). Useful for “who is on which task and what’s blocked.” Defer until Phase 1–3 are stable.

---

## Summary table

| Solution | What it gives | When |
|----------|----------------|------|
| Topology/agent SSE | Instant graph + list updates in UI | Phase 1 |
| Activity log + since / activity API | Agents see “what changed” without holding connections | Phase 2 |
| Graph-theory module (subtree, path-to-root, components) | Smarter routing and optional UX (notify subtree, highlight coordinators) | Phase 3 |
| Unified graph (agents + tasks) | One view of “who does what and what’s blocked” | Phase 4 |
| Communication overlay | “Who talks to whom” on the graph | Phase 3 (optional) |

**Dependencies:** Phase 1 is independent. Phase 2 can run in parallel once the activity log is defined. Phase 3 can use the same AgentManager/topology data and MessageBus; it doesn’t block Phase 1 or 2.

---

## Files to touch (by phase)

- **Phase 1:**  
  - `src/agents.ts` – add `subscribe(listener)` and call it on create/destroy/update and on internal status/task/lastActivity changes.  
  - `src/routes/agents.ts` – add `GET /api/agents/topology/stream` (and optionally `GET /api/agents/stream`).  
  - `ui/src/views/GraphView.tsx` – use SSE instead of 5s poll.  
  - `ui/src/hooks/useAgentPolling.ts` – use stream when available; fallback to poll.  
  - `ui/src/api.ts` – add `fetchTopologyStream()` or similar.

- **Phase 2:**  
  - New `src/activity-log.ts` (or extend AgentManager) – append events; expose `getSince(since)`.  
  - `src/agents.ts` + `src/routes/agents.ts` (PATCH) + `src/messages.ts` (post) – push to activity log.  
  - `src/routes/agents.ts` – add `GET /api/agents/registry?since=` and/or new route `GET /api/activity?since=`.  
  - `src/message-delivery.ts` (optional) – prepend “recent activity” to delivery prompt.  
  - `src/templates/workspace-claude-md.ts` / CLAUDE.md – document since/activity API for agents.

- **Phase 3:**  
  - New `src/agent-graph.ts` – graph builders and helpers.  
  - `src/routes/agents.ts` – optional `?includeCommunications=true` on topology.  
  - `src/message-delivery.ts` or message routing – use subtree/path-to-root when relevant.  
  - UI (optional) – communication overlay or centrality highlight.

This plan gives you instant node graph and list updates (Phase 1), instant visibility of other agents’ activity for the agents themselves (Phase 2), and a clean graph-theory layer for smarter routing and UX (Phase 3), with an optional unified graph later (Phase 4).
