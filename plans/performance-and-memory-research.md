# Performance & Memory Research: Message Bus, Bootstrap, Working Memory, Shared Context

Research report synthesizing findings from five subagent investigations across the AgentManager codebase. Covers message bus performance, agent bootstrap (RAG vs direct context), working memory removal, shared context format for LLMs, and end-to-end latency.

---

## 1. Message Bus and Agent Communication

### Why It Feels "Incredibly Slow"

**Current path:** Agent A → `POST /api/messages` → `MessageBus.post()` (in-memory + debounced full-file persist) → `messageBus.subscribe()` → if `canDeliver(to)` then `deliverMessage()` → `manager.message(agentId, prompt)` → **kill old Claude process** → **spawn new process** with prompt in args. If the target agent is busy, delivery waits until it goes idle, then **250 ms settle** (`DELIVERY_SETTLE_MS`), then **one** pending message is delivered; the rest are delivered one-by-one on each subsequent idle.

### Main Bottlenecks

| Bottleneck | Impact | Location |
|------------|--------|----------|
| **Kill + spawn per delivery** | Every delivery kills the current Claude process (up to ~6 s) and spawns a new one. No long-lived process that receives multiple prompts. | `src/agents.ts` (e.g. `message()`, `killAndWait`) |
| **One message per idle** | N queued messages → N process restarts and N × 250 ms delays. No batching. | `server.ts` ~304–326 (onIdle: single `deliverMessage`) |
| **250 ms idle settle** | Fixed delay before delivering the next message to a just-idle agent. | `server.ts` 284–285, 335 |
| **Orchestrator poll 5 s** | Task assignment runs every 5 s; tasks can wait up to 5 s before being posted to the bus. | `src/orchestrator.ts` 18, 86 |
| **Full-file message persistence** | Each debounced flush rewrites the **entire** message array (up to 500 messages) to disk; no append. | `src/messages.ts` 206–231 |

### Recommended Improvements (Priority Order)

1. **Batch delivery** – When delivering on idle (or from subscribe), pass **multiple** pending messages (e.g. up to K) in one prompt or one `message()` call so one process handles a small queue instead of one message per restart. **Impact: high.** **Effort: medium.**
2. **Tune delays** – Lower `DELIVERY_SETTLE_MS` (e.g. 50–100 ms) and/or make it configurable; lower orchestrator `pollIntervalMs` or trigger an assignment cycle immediately when new tasks appear. **Impact: high.** **Effort: low.**
3. **Append-only persistence** – Persist new messages with append (e.g. one JSONL line per message) instead of rewriting the full array. **Impact: medium (I/O under load).** **Effort: medium.**
4. **Sender-side** – Reuse HTTP connections and use `POST /api/messages/batch` (max 20) when agents send multiple messages. **Impact: medium.** **Effort: low (docs/guidance).**
5. **Long-lived process (larger change)** – Keep one Claude process per agent and feed prompts via stdin or a side-channel instead of kill+spawn per message. **Impact: very high.** **Effort: high.**

---

## 2. Agent Bootstrap and RAG vs Direct Context

### Bootstrap Order

- **Container:** MCP bootstrap, shared-context dir.
- **Server:** GCS sync (`~/CLAUDE.md`, shared-context), default context files, periodic sync.
- **On agent create/restore/message:** `ensureWorkspace` → symlinks + **workspace `CLAUDE.md`** (with **shared-context index**) + `.agent-token`.

The platform does **not** inject full shared-context file bodies into the prompt; it only builds an **index** (one line per file: path, size, short summary) in workspace `CLAUDE.md`. Full content is **on-demand** via `GET /api/context/file?name=...`.

### RAG vs Direct

- **RAG (vector search over shared-context):** Pros: smaller context, faster first token, scales when shared-context is large. Cons: embedding latency, retrieval errors, pipeline complexity, invalidation on edit.
- **Current “direct”:** Index + “fetch only what you need” is already lightweight; full shared-context is not sent at bootstrap.

### Recommendation

- **Short term (Option A):** Keep direct context; **streamline**: cap or truncate the shared-context index (e.g. max N files or chars + “… and 12 more; use GET /api/context to list”), optionally trim “other agents” / repo list / skills in workspace CLAUDE.md, and consider regenerating workspace CLAUDE.md on first message instead of at create.
- **Later (Option B/C):** Add **optional** RAG when shared-context is “large” (e.g. size or file count above a threshold), with a feature flag so small deployments stay direct. Use RAG to inject a small “Relevant context” block in addition to the index so the model can still fetch more via API.

### Code References

| Topic | File(s) |
|------|---------|
| Bootstrap order | `entrypoint.sh`, `server.ts`, `src/storage.ts` |
| Workspace setup & CLAUDE.md | `src/workspace-manager.ts`, `src/templates/workspace-claude-md.ts` |
| Agent spawn & prompt | `src/agents.ts` (create(), message(), buildClaudeArgs) |
| Context API | `src/routes/context.ts` |
| Shared-context dir | `src/utils/context.ts` (getContextDir) |

---

## 3. Working Memory: Safe to Remove

### What Exists Today

- **Implemented:** Only a **cleanup** in `server.ts` (inside `cleanupStaleWorkspaces()`): deletes files in shared-context matching `working-memory-*.md`. Comment in code says “feature removed.”
- **Planned (docs only):** `plans/agent-memory-architecture.md` and `plans/V3-PLAN.md` describe a future “Working Memory” (in-memory `Map`, `working-memory.ts`); **not implemented**.

### Removal Plan

- **Code:** Remove the block in `server.ts` that lists `working-memory-*.md` in `getContextDir()`, unlinks them, and logs “Removed N stale working-memory file(s).” Keep the rest of `cleanupStaleWorkspaces()` and all shared-context behavior.
- **Docs:** In `plans/agent-memory-architecture.md`, drop or deprecate the “Working Memory” section; in `plans/V3-PLAN.md`, update Phase 4.2 to “three-layer” (e.g. knowledge, episodic, artifacts) and remove “working memory.”

### Risks

None identified. No API, DB, or UI depends on working memory; agents are not instructed to use `working-memory-*.md`. Shared context remains the single “DB-like” store.

---

## 4. Shared Context Format: Is Markdown Optimal for the LLM?

### Current Behavior

- Stored as `.md` only; optional `<!-- summary: ... -->`; index built from path + size + that summary (or first heading + first line, ~120 chars).
- Agent sees **index in CLAUDE.md** and is told to use `GET /api/context/file?name=...` for full content. So the LLM gets **file-level index + on-demand full text**, not a giant blob of markdown at bootstrap.

### Pros and Cons

**Pros:** Readable, single format for humans and agents, good tooling, already integrated with “fetch only what you need.”

**Cons:** No schema, hard to query “all decisions” or “updated after X”; retrieval is file-level (no semantic chunk retrieval); large files are token-heavy when loaded whole.

### Recommendation

- **Keep markdown** as the stored and edited format.
- **Add light structure:** Optional **YAML frontmatter** (e.g. `title`, `summary`, `tags`, `updated`) so the index can show richer metadata; encourage `<!-- summary: ... -->` and consistent headings (e.g. one H1 per file).
- **Later:** If you need semantic or fact-level retrieval, add a **hybrid** layer (e.g. embeddings/chunks for retrieval; markdown remains source of truth and what humans edit in Settings).

So: markdown is a good default for “LLM read and digest” in this design; the main improvement is a **richer index** and optional **structured retrieval** later, not replacing markdown.

### Code References

| Topic | File(s) |
|------|---------|
| Index build | `src/workspace-manager.ts` (buildSharedContextIndex, walkMdFiles) |
| Context routes | `src/routes/context.ts` |
| Default context files | `src/storage.ts` (ensureDefaultContextFiles) |
| Settings UI | `ui/src/views/Settings/context.tsx`, `ui/src/app/settings/context/page.tsx` |

---

## 5. End-to-End Flow and Latency Budget

### User → Agent (Direct)

`POST /api/agents/:id/message` → auth → validate → `agentManager.message()` → kill old process → ensureWorkspace → spawn with prompt in args → SSE for output. No message bus on this path.

### Agent → Agent (Via Bus)

`POST /api/messages` → `messageBus.post()` → in-memory + debounced disk → subscribe → if `canDeliver` then `deliverMessage` → same `manager.message()` (kill + spawn). If agent busy: wait for idle + 250 ms → deliver **one** message; repeat.

### Agent Output → User

CLI stdout (NDJSON) → `processLineBuffer` (batches of 50) → `handleEvent` → 16 ms batched persist + listeners → SSE → UI.

### Top Latency Contributors and Mitigations

| # | Contributor | Mitigation |
|---|--------------|------------|
| 1 | **Model API (OpenRouter)** | Faster model/region; streaming UX so user doesn’t wait for full reply. |
| 2 | **Kill old process (up to ~6 s)** | Queue prompt and inject when safe, or shorten timeout where acceptable; long term: long-lived process + stdin/side-channel. |
| 3 | **250 ms delivery settle** | Lower or make configurable (e.g. 50–100 ms); document tradeoff. |
| 4 | **Process spawn + CLI startup** | Keep agents warm when expecting more messages; or long-lived process. |
| 5 | **Cold reconnect (read from disk)** | Prefer ring buffer for reconnects; trim/partition event files for very long-lived agents. |
| 6 | **16 ms event batch** | Keep unless profiling shows need for a “low latency” mode. |
| 7 | **Message bus full-file write** | Move to append-only; already off the delivery path. |

### File Reference Summary

- **server.ts** – App wiring, messageBus subscribe, onIdle, deliverMessage, DELIVERY_SETTLE_MS.
- **src/routes/agents.ts** – POST message handler, setupSSE, requireAgent, saveAttachments.
- **src/routes/messages.ts** – POST/GET messages, messageBus.post, SSE stream.
- **src/agents.ts** – message(), create(), killAndWait, spawn, attachProcessHandlers, processLineBuffer, handleEvent, flushEventBatch, subscribe(), readPersistedEvents, buildClaudeArgs.
- **src/messages.ts** – MessageBus post, saveToDisk (500 ms debounce), subscribe.
- **src/utils/sse.ts** – setupSSE, 15 s heartbeat, closeOnDone.
- **src/persistence.ts** – saveAgentState, writeAgentState, EVENTS_DIR.
- **src/storage.ts** – debouncedSyncToGCS, startPeriodicSync, syncFromGCS.
- **ui/src/hooks/useAgentStream.ts**, **ui/src/api.ts** – parseSSEStream, messageAgentStream, reconnectStream.

---

## 6. Cross-Cutting Summary and Suggested Order of Work

- **Message bus slowness** is largely from: **one message per process life** (kill+spawn every time), **250 ms settle**, and **one message per idle**. Batching delivery and tuning settle/poll will help a lot without changing the process model.
- **Bootstrap** is already “direct + index + on-demand”; the low-hanging fruit is **smaller index** and optional **lazy CLAUDE.md**; RAG is optional later for large shared-context.
- **Working memory** can be removed by deleting the cleanup block in `server.ts` and updating the two plan docs; no migration.
- **Shared context** should stay markdown; add optional frontmatter and better index; consider hybrid retrieval only if you need semantic search.

### Suggested Order of Work

1. **Quick wins:** Remove working-memory cleanup; tune `DELIVERY_SETTLE_MS` and orchestrator poll (or trigger assignment when tasks appear); recommend batch API and connection reuse for agents.
2. **Message bus:** Batch delivery (multiple pending messages per `message()` or per idle run); optionally append-only message persistence.
3. **Bootstrap:** Cap/trim shared-context index and optionally other list sections in workspace CLAUDE.md.
4. **Shared context:** Optional YAML frontmatter and index improvements.
5. **Larger bets:** Long-lived process + prompt streaming; optional RAG for large shared-context; hybrid retrieval.
