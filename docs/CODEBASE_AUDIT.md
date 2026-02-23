# Codebase Audit Report

**Date:** 2026-02-23  
**Scope:** Dead code, obsolete code, unconventional patterns, footprint, comments, AI artifacts, performance, readability, DRY, KISS.

---

## 1. Dead code & unused exports

### Unused exports (safe to un-export or remove)

| Symbol | Location | Note |
|--------|----------|------|
| `getCallbackUrl` | `src/mcp-oauth-manager.ts:88` | Only used in same file; no external imports |
| `listStoredTokens` | `src/mcp-oauth-storage.ts:100` | Only used by `getAllTokens()` in same file |
| `SidebarItemSkeleton` | `ui/src/components/Skeleton.tsx:56` | Exported but never imported |
| `TreeNode` | `ui/src/views/Settings/tree.tsx:3` | Type only; `buildTree`, `TreeList`, `allFolderPaths` are used |
| `LinearWorkflow` (server) | `src/routes/workflows.ts:10` | Exported interface only used in that file; UI has its own in `LinearWorkflowDialog.tsx` |

### Optional API surface reduction

- **`ui/src/components/AgentTerminal.tsx`**: `MemoizedBlock`, `parseEvents`, `deduplicateResultBlocks`, `TerminalBlock` — used only inside the component; consider un-exporting if not needed for tests or external typing.

### Orphan files

**None.** All source files are either entry points or imported.

---

## 2. Obsolete code

### TODOs

| Location | Content |
|----------|--------|
| `src/webhook-url.ts:4–5` | IPv6 handling (`[::ffff:127.0.0.1]`, `[::1]`) and DNS rebinding (host validated at parse vs fetch time) |
| `src/webhook-url.ts:59` | Inline comment referring to “file TODO” for full IPv6 coverage |

### Commented-out code / deprecated APIs

- No substantial commented-out blocks.
- No deprecated Node/Express/React API usage found.

---

## 3. Comments & AI artifacts

### Redundant / low-value comments

**Route comments that only restate the handler** (consider removing):

- `src/routes/messages.ts`: "Post a message", "Post multiple messages...", "Query messages", "Mark message as read", "Mark all as read", "Clear all messages", "Delete a message"
- `src/routes/config.ts`: "Get current settings", "List editable Claude config files", "Read a config file", "Write a config file", "Create a new skill/command", "Delete a config file"
- `src/routes/agents.ts`: "List all agents", "Get agent details", "List workspace files", "Clear agent context"
- `src/routes/repositories.ts`: "List all persistent repositories", "Clone a new repository...", "Delete a repository"
- `src/routes/context.ts`: "List context files (recursive)"

**Single-line “what the next line does” comments:**

- `ui/src/components/AgentTerminal.tsx:529` — "Remove the duplicate text blocks"
- `ui/src/components/ConfirmDialog.tsx:39` — "Focus the cancel button when dialog opens"
- `ui/src/components/PromptInput.tsx:172` — "Focus the textarea..."
- `ui/src/components/PromptInput.tsx:367`, `379` — "Find the @ trigger position", "Set cursor after insertion"
- `src/routes/agents.ts:144` — "Update lastActivity when agent details are retrieved"

**Obvious JSDoc:**

- `src/utils/context.ts:1–8` — Full JSDoc for `getContextDir()` (one-liner returning `process.env.SHARED_CONTEXT_DIR || "/shared-context"`)

### AI-style phrasing

- `ui/src/components/AgentTerminal.tsx:508` — "This function removes the white text blocks..."
- `server.ts:288` — "This handles messages that arrived"
- `src/agents.ts:918`, `949`, `975` — Repeated "Return X for [single agent | all agents]" JSDoc; method names already convey this

**Recommendation:** Remove or shorten route-level comments that only repeat the HTTP verb/path. Replace "This function…" / "This handles…" with a short, direct description. Trim one-line JSDoc that only restates the return type.

---

## 4. DRY (Don’t Repeat Yourself)

### Error message handling

**Many places use** `err instanceof Error ? err.message : String(err)` **instead of** `errorMessage(err)` from `src/types.ts`:

- `src/routes/repositories.ts` (118–120, 284–287)
- `src/routes/workflows.ts` (145–155, 215)
- `src/routes/mcp.ts` (91–93, 132–134, etc.)
- `server.ts` (187–188, 256–257, 274–275, 329–330, 616, 622–623)
- `src/mcp-oauth-manager.ts` (219–222, 290–293)
- `src/mcp-oauth-storage.ts` (62–65, 105–107)
- `src/worktrees.ts` (129–130, 141–142)
- `src/storage.ts` (298–301, 309–312, 316–319, 372–375)
- `src/routes/agents.ts` (132–134)
- `src/routes/tasks.ts` (229, 391)
- `src/routes/scheduler.ts` (69–71)

**Action:** Unify on `errorMessage(err)` everywhere (and use `catch (err: unknown)`).

### Path validation

- **`src/routes/context.ts`**: "Invalid filename" in three places, "File not found" in two; same validation block repeated for GET, PUT, DELETE. Consider a helper that validates name/path and returns `{ filepath } | { status, error }`.
- **`src/routes/context.ts`** and **`src/routes/repositories.ts`**: Path-traversal check duplicated; could share a util like `isPathUnder(baseDir, candidatePath)`.

### Response helpers

- **404 pattern:** `res.status(404).json({ error: "Job not found" })` in `src/routes/scheduler.ts` (4 places); "Task not found" in `src/routes/tasks.ts` (6 places). Consider `sendNotFound(res, "Job not found")`.
- **UI `api.ts`:** Repeated `const data = await res.json().catch(() => ({})); throw new Error((data as { error?: string }).error || "Failed to ...");` in many methods. Consider `parseJsonError(res, defaultMessage)`.

### Validation logic

- **`src/routes/messages.ts`**: Single-message and batch validations repeat the same rules; factor `validateMessagePayload(obj): { ok, error? }` and reuse.
- **`src/routes/tasks.ts`** (122–210): Long sequence of field validations with repeated `res.status(400).json({ error: "..." }); return;` — consider `validateTaskCreate(body)` or small helpers for "required string" / "max length" / "one of".

---

## 5. KISS (Keep It Simple)

- **`src/routes/tasks.ts`** (106–231): Single handler with long linear validations; extract `validateCreateTaskBody(body)` returning `{ error?: string }`.
- **`src/routes/mcp.ts`** (143–245): OAuth callback has multiple branches and nested conditionals; split into `handleOAuthError`, `handleOAuthSuccess`, etc.
- **`src/agents.ts`** `create()` (~356–510): Dense preflight checks; optional refactor: `validateCreate(opts)` that throws, then `create()` does allocation and spawn.
- **`src/routes/repositories.ts`** (125–238): POST clone inlines SSE, spawn, stdout/stderr, cleanup; consider `runCloneWithEvents(url, targetDir, sendEvent)`.

---

## 6. Unconventional patterns (vs CLAUDE.md)

### Catch typing and error extraction

**Use `catch (err: unknown)` and `errorMessage(err)`:**

- `src/routes/workflows.ts` (145, 153, 215)
- `src/routes/mcp.ts` (91, 132, 227, 275, 302)
- `src/routes/repositories.ts` (118, 283)
- `src/workspace-manager.ts` (123, 137; line 192 already uses `err: unknown`)
- `src/mcp-oauth-manager.ts` (219, 290)
- `src/mcp-oauth-storage.ts` (62, 105)
- `src/worktrees.ts` (129, 141)
- `src/storage.ts` (298–319, 372–375)
- `server.ts` (187, 616, 622)
- `src/routes/agents.ts` (132–134)
- `src/routes/scheduler.ts` (69–71)
- `ui/src/hooks/useAgentPolling.ts` (22)
- `ui/src/hooks/useKillSwitch.ts` (26)

### Use of `any`

- `src/storage.ts:27–28` — `let storage: any = null` (biome-ignore for dynamic GCS import)
- `src/kill-switch.ts:37–38` — `let gcsStorage: any = null`
- `src/validation.test.ts:229` — `sanitizeAgentName(null as any)` (test-only; keep minimal)

---

## 7. Performance

### Sync I/O in request handlers

| File | Areas |
|------|--------|
| `src/routes/context.ts` | GET list (mkdirSync, readdirSync, statSync), GET file (existsSync, readFileSync), PUT (mkdirSync, writeFileSync), DELETE (existsSync, unlinkSync) |
| `src/routes/config.ts` | GET list (existsSync, readdirSync, statSync in nested loops), GET file, PUT/POST/DELETE (mkdirSync, writeFileSync, unlinkSync) |
| `src/routes/mcp.ts` | readFileSync(SETTINGS_PATH) in request path |
| `src/workspace-manager.ts` | buildSharedContextIndex (readFileSync, statSync per .md), writeWorkspaceClaudeMd (readdirSync, scanCommands, writeFileSync) |
| `src/persistence.ts` | loadAllAgentStates (readdirSync, readFileSync per file), cleanupStaleState (readdirSync, unlinkSync) |
| `src/messages.ts` | loadFromDisk (readFileSync, split, JSON.parse per line); saveToDisk builds full JSONL string |
| `src/agents.ts` | ensureWorkspace, writeWorkspaceClaudeMd, writeAgentTokenFile, saveAttachments (writeFileSync in create/message path) |

### Blocking exec

- `server.ts:392–395` — `cleanupOrphanedProcesses()` uses `execFileSync("ps", ...)` (5s timeout)
- `src/agents.ts:120–124` — `cleanupAllProcesses()` uses `execFileSync("ps", ...)`
- `src/dep-cache.ts:73–76` — `initDepCache()` uses `execFileSync("pnpm", ...)` (10s timeout)

### Startup

- `server.ts:533–582`: After GCS sync, runs ensureDefaultContextFiles, loadPersistedState, cleanupStaleState, cleanupOrphanedProcesses, initDepCache, restoreAgents, cleanupStaleWorkspaces, cleanupClaudeHome, ensureTokenDir before "Recovery complete". Consider deferring or lazy-loading initDepCache and/or restoreAgents.
- `src/storage.ts:570–578` — ensureDefaultContextFiles: sync mkdirSync + writeFileSync for every default file.

### N+1 / large in-memory

- `src/routes/config.ts:181–186`: Nested readdirSync/statSync over memory dir (no indexing).
- `src/messages.ts`: Full messages file loaded and parsed; flushToDisk builds single string from all messages (peak memory scales with total size).
- `src/agents.ts:1573–1577`: readPersistedEvents cold path builds events array with no hard cap for very large files.

### Missing DB indexes

- **`src/scheduler.ts`**: Table `scheduled_jobs` — no index for `ORDER BY created_at DESC` (list).
- **`src/cost-tracker.ts`**: Table `cost_records` — no index on `created_at`; getAll(limit) does full table scan.

---

## 8. Unnecessary footprint

- **Root vs `ui/package.json`**: Duplicate dev/type deps: `typescript`, `@types/node` (different versions). Consider aligning versions.
- **Optional features:** All route modules and orchestrator/scheduler load at startup; no feature flags if you ever want to disable tasks/workflows/scheduler.
- **Large modules (candidates for splitting):** `ui/src/components/PromptInput.tsx` (886), `ui/src/api.ts` (875) — consider code-splitting if chunks are heavy.

---

## 9. Readability

### Very long files (>300 lines)

| File | Lines |
|------|-------|
| `src/agents.ts` | 1822 |
| `src/task-graph.ts` | 917 |
| `ui/src/components/PromptInput.tsx` | 886 |
| `ui/src/api.ts` | 875 |
| `ui/src/views/TasksView.tsx` | 840 |
| `src/storage.ts` | 643 |
| `server.ts` | 625 |
| `src/routes/tasks.ts` | 588 |
| `ui/src/components/AgentTerminal.tsx` | 576 |
| `src/orchestrator.ts` | 508 |
| `ui/src/views/AgentView.tsx` | 477 |
| … (see sub-agent report for full list) |

### Long functions (>50 lines)

- `src/agents.ts`: `create()` ~154 lines, `message()` ~108 lines, `handleEvent()` ~173 lines, `attachProcessHandlers()` ~64 lines
- `server.ts`: `start()` ~160 lines
- `src/routes/config.ts`: GET /api/claude-config/list handler block ~118 lines

### Deep callback nesting

- `src/agents.ts`: attachProcessHandlers, processLineBuffer (setImmediate + nested callbacks); handleEvent with deep branching
- `server.ts`: start() wires shutdown, recovery, intervals in one place

---

## 10. Summary & priorities

| Priority | Category | Action |
|----------|----------|--------|
| **High** | Conventions | Use `catch (err: unknown)` and `errorMessage(err)` everywhere on server (and optionally in UI hooks). |
| **High** | DRY | Unify error message handling; add optional `sendNotFound` / `parseJsonError` and path/validation helpers. |
| **Medium** | Dead code | Un-export or remove: getCallbackUrl, listStoredTokens, SidebarItemSkeleton, TreeNode, LinearWorkflow (workflows.ts). |
| **Medium** | Comments | Remove redundant route/single-line comments; fix AI-style JSDoc. |
| **Medium** | Performance | Consider async I/O for context/config routes; add DB indexes for scheduler and cost-tracker; defer/lazy startup where safe. |
| **Low** | KISS | Extract validation and OAuth/path helpers to shorten handlers. |
| **Low** | Readability | Split very long files/functions (agents.ts, server.ts, PromptInput, api.ts) where it improves maintainability. |

---

*Generated from parallel sub-agent audits (dead code, comments/artifacts, DRY/KISS/patterns, performance/footprint/readability).*
