import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateServiceToken } from "./auth";
import { ALLOWED_MODELS, DEFAULT_MODEL, MAX_AGENTS, MAX_AGENT_DEPTH, MAX_CHILDREN_PER_AGENT, SESSION_TTL_MS } from "./guardrails";
import { EVENTS_DIR, loadAllAgentStates, removeAgentState, saveAgentState, writeTombstone } from "./persistence";
import { sanitizeEvent } from "./sanitize";
import { syncToGCS } from "./storage";
import { generateWorkspaceClaudeMd } from "./templates/workspace-claude-md";
import type { Agent, AgentProcess, CreateAgentRequest, PromptAttachment, StreamEvent } from "./types";
import { errorMessage } from "./types";
import { getContextDir } from "./utils/context";
import { scanCommands, walkMdFiles } from "./utils/files";
import { cleanupWorktreesForWorkspace } from "./worktrees";

const SHARED_CONTEXT_DIR = getContextDir();

/** Kill a process group (SIGTERM), escalating to SIGKILL after a timeout.
 *  Uses negative PID to signal the entire process group. */
function killProcessGroup(proc: ReturnType<typeof spawn>, timeoutMs = 5000): void {
  if (proc.killed || proc.pid == null) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    // Process group already gone
    return;
  }
  const escalation = setTimeout(() => {
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }, timeoutMs);
  // Don't let this timer keep the event loop alive
  escalation.unref();
}

/**
 * Layer 2: Kill ALL non-init, non-server processes.
 * Used by emergencyDestroyAll() to catch bash/node/curl/git spawned by agents
 * that aren't tracked in our process map.
 */
function cleanupAllProcesses(): void {
  try {
    const myPid = process.pid;
    const output = execFileSync("ps", ["-eo", "pid,ppid,comm"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    let killed = 0;
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const [, pidStr] = match;
      const pid = parseInt(pidStr, 10);
      if (pid === 1 || pid === myPid) continue;
      try {
        process.kill(pid, "SIGKILL");
        killed++;
      } catch {
        // Already dead or no permission — skip
      }
    }
    if (killed > 0) {
      console.log(`[kill-switch] cleanupAllProcesses: killed ${killed} process(es)`);
    }
  } catch {
    // ps not available — skip
  }
}

/** Build a shared-context index with summaries from file content. */
function buildSharedContextIndex(sharedContextDir: string): string {
  const files = walkMdFiles(sharedContextDir);
  const entries: string[] = [];

  for (const relPath of files) {
    const absPath = path.join(sharedContextDir, relPath);
    let content: string;
    let sizeKb: number;
    try {
      content = readFileSync(absPath, "utf-8");
      const stats = statSync(absPath);
      sizeKb = Math.ceil(stats.size / 1024);
    } catch {
      continue;
    }

    // Check for explicit <!-- summary: ... --> tag
    const summaryMatch = content.match(/<!--\s*summary:\s*(.+?)\s*-->/);
    let summary: string;

    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    } else {
      // Fallback: first heading + first content line
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const heading = lines.find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "") || "";
      const firstLine = lines.find((l) => !l.startsWith("#") && !l.startsWith("<!--")) || "";
      summary = heading && firstLine ? `${heading} — ${firstLine}`.substring(0, 120) : heading || relPath;
    }

    entries.push(`- **${relPath}** (${sizeKb}KB): ${summary}`);
  }

  // Sort: working-memory first, then guides/ last, then alphabetical
  entries.sort((a, b) => {
    const aWm = a.includes("working-memory");
    const bWm = b.includes("working-memory");
    const aGuide = a.includes("guides/");
    const bGuide = b.includes("guides/");
    if (aWm && !bWm) return -1;
    if (!aWm && bWm) return 1;
    if (aGuide && !bGuide) return 1;
    if (!aGuide && bGuide) return -1;
    return a.localeCompare(b);
  });

  return entries.join("\n");
}

const MAX_PERSISTED_EVENTS = 5_000;
const EVENT_FILE_TRUNCATE_THRESHOLD = 10_000;

export class AgentManager {
  private agents = new Map<string, AgentProcess>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private flushInterval: ReturnType<typeof setInterval>;
  private idleListeners = new Set<(agentId: string) => void>();
  private writeQueues = new Map<string, Promise<void>>();
  /** Per-agent lifecycle lock to prevent concurrent message/destroy operations.
   *  Each entry is a promise chain — operations queue behind the previous one. */
  private lifecycleLocks = new Map<string, Promise<void>>();
  /** Set of agent IDs currently being delivered to (prevents concurrent delivery). */
  private delivering = new Set<string>();
  /** Track recent agent creations to prevent duplicates from parallel requests.
   *  Key: "parentId:name" or "name", Value: timestamp of creation. */
  private recentCreations = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 10_000; // 10 seconds
  /** Layer 1: Set to true by kill switch — blocks create() and message() at the code level. */
  killed = false;

  constructor() {
    // Cleanup idle agents every 60s
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 60_000);
    // Periodic state flush every 30s (catches lastActivity updates without writing on every poll)
    this.flushInterval = setInterval(() => this.flushAllStates(), 30_000);
  }

  /** Register a callback that fires when any agent transitions to idle. */
  onIdle(listener: (agentId: string) => void): () => void {
    this.idleListeners.add(listener);
    return () => {
      this.idleListeners.delete(listener);
    };
  }

  /** Restore agents from persisted state files (call on startup). */
  restoreAgents(): void {
    const states = loadAllAgentStates();
    if (states.length === 0) return;

    console.log(`[restore] Found ${states.length} persisted agent state(s)`);
    for (const agent of states) {
      // Skip if already in memory (shouldn't happen on fresh start, but be safe)
      if (this.agents.has(agent.id)) continue;

      // Recreate workspace directory and symlinks if missing after container restart
      this.ensureWorkspace(agent.workspaceDir, agent.name);

      agent.status = "restored";
      const agentProc: AgentProcess = {
        agent,
        proc: null,
        lineBuffer: "",
        listeners: new Set(),
      };
      this.agents.set(agent.id, agentProc);
      console.log(`[restore] Restored agent ${agent.name} (${agent.id.slice(0, 8)})`);
    }
  }

  create(opts: CreateAgentRequest): {
    agent: Agent;
    subscribe: (listener: (event: StreamEvent) => void) => () => void;
  } {
    // Layer 1: Block spawning when kill switch is active
    if (this.killed) {
      throw new Error('Kill switch is active — agent spawning is disabled');
    }
    if (this.agents.size >= MAX_AGENTS) {
      throw new Error(`Maximum of ${MAX_AGENTS} agents reached`);
    }
    // Layer 4: Enforce immutable depth field and sibling limit
    const parentAgent = opts.parentId ? this.get(opts.parentId) : undefined;
    const depth = (parentAgent?.depth ?? 0) + 1;
    if (depth > MAX_AGENT_DEPTH) {
      throw new Error(`Maximum agent depth of ${MAX_AGENT_DEPTH} exceeded`);
    }
    if (opts.parentId) {
      const siblingCount = this.list().filter((a) => a.parentId === opts.parentId).length;
      if (siblingCount >= MAX_CHILDREN_PER_AGENT) {
        throw new Error(`Maximum of ${MAX_CHILDREN_PER_AGENT} children per agent exceeded`);
      }
    }

    const id = randomUUID();
    const name = opts.name || `agent-${id.slice(0, 8)}`;

    // Deduplication: reject if an agent with the same name was just created
    // by the same parent within the dedup window. This prevents duplicates
    // from parallel curl requests fired by Claude's parallel tool calls.
    const dedupKey = opts.parentId ? `${opts.parentId}:${name}` : name;
    const dedupNow = Date.now();
    const lastCreated = this.recentCreations.get(dedupKey);
    if (lastCreated && dedupNow - lastCreated < AgentManager.DEDUP_WINDOW_MS) {
      const existing = Array.from(this.agents.values()).find(
        (ap) => ap.agent.name === name && ap.agent.parentId === opts.parentId,
      );
      if (existing) {
        throw new Error(
          `Agent "${name}" was already created recently. Use the existing agent (${existing.agent.id.slice(0, 8)}).`,
        );
      }
    }
    this.recentCreations.set(dedupKey, dedupNow);
    // Prune old entries from the dedup map
    for (const [key, ts] of this.recentCreations) {
      if (dedupNow - ts > AgentManager.DEDUP_WINDOW_MS) this.recentCreations.delete(key);
    }

    const model = opts.model && ALLOWED_MODELS.includes(opts.model) ? opts.model : DEFAULT_MODEL;
    const workspaceDir = `/tmp/workspace-${id}`;
    this.ensureWorkspace(workspaceDir, name, id);

    const now = new Date().toISOString();
    const agent: Agent = {
      id,
      name,
      status: "starting",
      workspaceDir,
      createdAt: now,
      lastActivity: now,
      model,
      role: opts.role,
      capabilities: opts.capabilities,
      parentId: opts.parentId,
      depth, // Layer 4: immutable depth, set at creation time
    };

    let finalPrompt = opts.prompt;
    if (opts.attachments && opts.attachments.length > 0) {
      const suffix = this.saveAttachments(workspaceDir, opts.attachments);
      finalPrompt = opts.prompt + suffix;
    }

    const args = this.buildClaudeArgs({ ...opts, prompt: finalPrompt }, model);
    const env = this.buildEnv();

    const proc = spawn("claude", args, {
      env,
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const agentProc: AgentProcess = {
      agent,
      proc,
      lineBuffer: "",
      listeners: new Set(),
    };

    this.agents.set(id, agentProc);
    saveAgentState(agent);

    // Persist a user_prompt event so the initial prompt appears in the terminal
    // on reconnect (the UI injects one client-side, but it's lost on refresh)
    this.handleEvent(id, { type: "user_prompt", text: opts.prompt });

    this.attachProcessHandlers(id, agentProc, proc);

    // Update status to running once we get first output
    proc.stdout?.once("data", () => {
      const ap = this.agents.get(id);
      if (ap && ap.agent.status === "starting") {
        ap.agent.status = "running";
        saveAgentState(ap.agent);
      }
    });

    const userPromptEvent: StreamEvent = { type: "user_prompt", text: opts.prompt };
    const subscribe = (listener: (event: StreamEvent) => void) => {
      agentProc.listeners.add(listener);
      // Send the user_prompt as the first event so it appears in the terminal
      // immediately (the handleEvent call above persisted it but fired before
      // this listener was added)
      listener(userPromptEvent);
      // Replay persisted events (skip the first one since we just sent it)
      this.readPersistedEvents(id).then((events) => {
        if (!agentProc.listeners.has(listener)) return;
        for (let i = 1; i < events.length; i++) {
          listener(events[i]);
        }
      });
      return () => {
        agentProc.listeners.delete(listener);
      };
    };

    return { agent, subscribe };
  }

  /** Create multiple agents sequentially from a batch request.
   *  Returns an array of results — one per spec — with either the created agent or an error. */
  createBatch(specs: CreateAgentRequest[]): Array<{ agent: Agent } | { error: string }> {
    const results: Array<{ agent: Agent } | { error: string }> = [];
    for (const spec of specs) {
      try {
        const { agent } = this.create(spec);
        results.push({ agent });
      } catch (err: unknown) {
        results.push({ error: err instanceof Error ? err.message : "Failed to create agent" });
      }
    }
    return results;
  }

  message(
    id: string,
    prompt: string,
    maxTurns?: number,
    targetSessionId?: string,
  ): { agent: Agent; subscribe: (listener: (event: StreamEvent) => void) => () => void } {
    // Layer 1: Block messaging when kill switch is active
    if (this.killed) throw new Error("Kill switch is active — agent messaging is disabled");
    const agentProc = this.agents.get(id);
    if (!agentProc) throw new Error("Agent not found");
    if (!agentProc.agent.claudeSessionId) throw new Error("Agent has no session to resume");
    if (agentProc.agent.status === "killing")
      throw new Error("Agent is shutting down a previous process, try again shortly");

    // Use targetSessionId if provided, otherwise use the agent's main session
    const resumeId = targetSessionId || agentProc.agent.claudeSessionId;

    const model = agentProc.agent.model;
    const args = this.buildClaudeArgs({ prompt, maxTurns, model }, model, resumeId);
    const env = this.buildEnv();

    // Kill old process and await its exit before spawning new one.
    // This prevents event interleaving from the old process's close handler
    // firing after the new process has already started.
    const oldProc = agentProc.proc;
    const killOld: Promise<void> = oldProc ? this.killAndWait(oldProc, agentProc, id) : Promise.resolve();

    agentProc.lineBuffer = "";

    // Persist a user_prompt event so the user's message appears in the terminal
    // on reconnect (the UI injects one client-side, but it's lost on refresh)
    this.handleEvent(id, { type: "user_prompt", text: prompt });

    // Ensure workspace exists (may have been lost after container restart for restored agents)
    this.ensureWorkspace(agentProc.agent.workspaceDir, agentProc.agent.name, id);

    // Chain the spawn behind the old process exit via lifecycle lock
    const prevLock = this.lifecycleLocks.get(id) ?? Promise.resolve();
    const spawnAfterKill = prevLock
      .then(() => killOld)
      .then(() => {
        // Re-check agent still exists (may have been destroyed while waiting)
        const ap = this.agents.get(id);
        if (!ap) return;

        const proc = spawn("claude", args, {
          env,
          cwd: ap.agent.workspaceDir,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });

        ap.proc = proc;
        ap.agent.status = "running";
        ap.agent.lastActivity = new Date().toISOString();
        saveAgentState(ap.agent);

        this.attachProcessHandlers(id, ap, proc);
      });
    this.lifecycleLocks.set(
      id,
      spawnAfterKill.catch(() => {}),
    );

    // Update status immediately so canDeliver() returns false
    agentProc.agent.status = "running";
    agentProc.agent.lastActivity = new Date().toISOString();
    saveAgentState(agentProc.agent);

    const userPromptEvent: StreamEvent = { type: "user_prompt", text: prompt };
    const subscribe = (listener: (event: StreamEvent) => void) => {
      agentProc.listeners.add(listener);
      // Send the user_prompt as the first event so it appears in the terminal
      // immediately (the handleEvent call above persisted it but fired before
      // this listener was added)
      listener(userPromptEvent);
      return () => {
        agentProc.listeners.delete(listener);
      };
    };

    return { agent: agentProc.agent, subscribe };
  }

  /** Kill a process and wait for it to fully exit. Sets transitional 'killing' state. */
  private killAndWait(proc: ReturnType<typeof spawn>, agentProc: AgentProcess, _agentId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      // Detach old handlers so close doesn't trigger idle/state transitions
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners("close");

      if (proc.killed || proc.exitCode !== null) {
        resolve();
        return;
      }

      agentProc.agent.status = "killing";

      proc.once("close", () => {
        resolve();
      });

      // Use process group kill (SIGTERM → SIGKILL escalation) from killProcessGroup
      killProcessGroup(proc);

      // Safety timeout — resolve even if close never fires
      const safety = setTimeout(() => resolve(), 6_000);
      safety.unref();
    });
  }

  list(): Agent[] {
    return Array.from(this.agents.values()).map((ap) => ap.agent);
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id)?.agent;
  }

  /** Check if an agent can receive a delivered message (idle/restored with a session to resume).
   *  When returning true, atomically sets a delivery lock to prevent concurrent deliveries.
   *  Callers MUST call `deliveryDone(id)` after the message() call completes. */
  canDeliver(id: string): boolean {
    const agentProc = this.agents.get(id);
    if (!agentProc) return false;
    if (this.delivering.has(id)) return false;
    const { status } = agentProc.agent;
    // Only deliver to agents that aren't actively running and have a session to resume
    if ((status === "idle" || status === "restored") && !!agentProc.agent.claudeSessionId) {
      this.delivering.add(id);
      return true;
    }
    return false;
  }

  /** Release the delivery lock for an agent after message() has been called. */
  deliveryDone(id: string): void {
    this.delivering.delete(id);
  }

  /** Check if a running agent can be interrupted (busy with a session and a live process). */
  canInterrupt(id: string): boolean {
    const agentProc = this.agents.get(id);
    if (!agentProc) return false;
    return (
      (agentProc.agent.status === "running" || agentProc.agent.status === "starting") &&
      !!agentProc.agent.claudeSessionId &&
      !!agentProc.proc &&
      !agentProc.proc.killed
    );
  }

  touch(id: string): void {
    const agentProc = this.agents.get(id);
    if (agentProc) {
      agentProc.agent.lastActivity = new Date().toISOString();
    }
  }

  async getEvents(id: string): Promise<StreamEvent[]> {
    if (!this.agents.has(id)) return [];
    return this.readPersistedEvents(id);
  }

  /** Return session logs for an agent in a readable format.
   *  Supports filtering by event type and limiting to the last N entries. */
  async getLogs(id: string, opts?: { types?: string[]; tail?: number }): Promise<{ lines: string[]; total: number }> {
    const events = await this.readPersistedEvents(id);
    if (events.length === 0) return { lines: [], total: 0 };

    const typeFilter = opts?.types;
    let lines: string[] = [];

    for (const event of events) {
      if (typeFilter && !typeFilter.includes(event.type)) continue;

      const line = this.formatLogEvent(event);
      if (line) lines.push(line);
    }

    const total = lines.length;
    if (opts?.tail && opts.tail > 0) {
      lines = lines.slice(-opts.tail);
    }

    return { lines, total };
  }

  /** Format a single event into a readable log line. */
  private formatLogEvent(event: StreamEvent): string | null {
    switch (event.type) {
      case "user_prompt":
        return `[user] ${event.text}`;
      case "assistant":
        if (event.subtype === "text") return `[assistant] ${event.text}`;
        if (event.subtype === "tool_use") return `[tool_call] ${event.tool}: ${event.content || ""}`;
        if (event.subtype === "tool_result")
          return `[tool_result] ${event.tool}: ${(event.result || event.content || "").toString().slice(0, 500)}`;
        return `[assistant:${event.subtype || "unknown"}] ${event.text || event.content || ""}`;
      case "system":
        return `[system:${event.subtype || ""}] ${event.message || event.text || ""}`;
      case "raw":
        return `[raw] ${event.text}`;
      case "stderr":
        return `[stderr] ${event.text}`;
      case "done":
        return `[done] exit_code=${event.exitCode ?? "unknown"}`;
      case "result":
        return `[result] ${event.text || event.result || ""}`;
      default:
        return `[${event.type}${event.subtype ? `:${event.subtype}` : ""}] ${event.text || event.content || event.message || JSON.stringify(event)}`;
    }
  }

  subscribe(id: string, listener: (event: StreamEvent) => void, afterIndex?: number): (() => void) | null {
    const agentProc = this.agents.get(id);
    if (!agentProc) return null;
    agentProc.listeners.add(listener);
    // Replay persisted events (optionally skipping events the client already has)
    this.readPersistedEvents(id).then((events) => {
      if (!agentProc.listeners.has(listener)) return;
      const startIdx = afterIndex != null && afterIndex > 0 ? afterIndex : 0;
      for (let i = startIdx; i < events.length; i++) {
        listener(events[i]);
      }
    });
    return () => {
      agentProc.listeners.delete(listener);
    };
  }

  destroy(id: string): boolean {
    const agentProc = this.agents.get(id);
    if (!agentProc) return false;

    // Wait for any in-flight lifecycle operation (e.g. message() spawn) to finish
    // before tearing down. Chain onto the lifecycle lock so destroy doesn't race
    // with a concurrent message() call.
    const prevLock = this.lifecycleLocks.get(id) ?? Promise.resolve();
    const destroyOp = prevLock.then(() => this.doDestroy(id, agentProc));
    this.lifecycleLocks.set(
      id,
      destroyOp.catch(() => {}),
    );

    // Mark agent as destroying immediately so canDeliver/canInterrupt return false
    agentProc.agent.status = "destroying";

    // Remove from in-memory map immediately so no other code path
    // (flush interval, close handler) can re-save this agent's state.
    this.agents.delete(id);
    this.delivering.delete(id);

    return true;
  }

  /** Internal destroy implementation — runs after lifecycle lock is released. */
  private async doDestroy(id: string, agentProc: AgentProcess): Promise<void> {
    // Remove process handlers BEFORE killing to prevent the close handler from
    // re-saving agent state after we delete it (race condition that caused
    // destroyed agents to be restored on server restart).
    const proc = agentProc.proc;
    if (proc) {
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners("close");
      if (!proc.killed) {
        killProcessGroup(proc);
      }
    }

    for (const listener of agentProc.listeners) {
      try {
        listener({ type: "destroyed" });
      } catch (err: unknown) {
        console.warn("[agents] Listener error during destroy:", errorMessage(err));
      }
    }
    agentProc.listeners.clear();

    cleanupWorktreesForWorkspace(agentProc.agent.workspaceDir);

    const workingMemoryPath = path.join(SHARED_CONTEXT_DIR, `working-memory-${agentProc.agent.name}.md`);
    try {
      unlinkSync(workingMemoryPath);
    } catch (err: unknown) {
      // Silently ignore if file doesn't exist
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[agents] Failed to remove working memory for ${agentProc.agent.name}:`, errorMessage(err));
      }
    }

    rmSync(agentProc.agent.workspaceDir, { recursive: true, force: true });
    try {
      unlinkSync(path.join(EVENTS_DIR, `${id}.jsonl`));
    } catch (err) {
      console.warn(`[agents] Failed to remove event file for ${id.slice(0, 8)}:`, errorMessage(err));
    }
    removeAgentState(id);
    this.writeQueues.delete(id);
    this.lifecycleLocks.delete(id);
  }

  destroyAll(): void {
    for (const id of [...this.agents.keys()]) {
      this.destroy(id);
    }
  }

  /**
   * Layer 2: Nuclear emergency shutdown — called by the kill switch.
   * Unlike destroyAll(), this:
   *   1. Sets killed flag immediately (blocks create/message at code level)
   *   2. Clears all message bus listeners (prevents auto-delivery from re-triggering agents)
   *   3. SIGKILLs all tracked processes immediately (no graceful SIGTERM)
   *   4. Kills ALL non-init processes (not just claude — catches bash, node, curl, git, etc.)
   *   5. Deletes ALL state files so agents are not restored on restart
   *   6. Writes a tombstone file so loadAllAgentStates() skips restoration even if delete failed
   *   7. Schedules a second pass at +500ms to catch processes spawned mid-kill
   */
  emergencyDestroyAll(): void {
    this.killed = true;
    clearInterval(this.cleanupInterval);
    clearInterval(this.flushInterval);

    console.log("[kill-switch] emergencyDestroyAll — starting nuclear shutdown");

    // Clear all idle listeners to prevent auto-delivery from re-triggering agent runs
    this.idleListeners.clear();

    // SIGKILL all tracked processes immediately
    for (const [id, agentProc] of this.agents) {
      const proc = agentProc.proc;
      if (proc) {
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
        proc.removeAllListeners("close");
        if (!proc.killed && proc.pid != null) {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            try { process.kill(proc.pid, "SIGKILL"); } catch { /* already dead */ }
          }
        }
      }
      agentProc.listeners.clear();

      // Delete state and event files immediately
      try { removeAgentState(id); } catch { /* best-effort */ }
      try { unlinkSync(path.join(EVENTS_DIR, `${id}.jsonl`)); } catch { /* best-effort */ }
    }

    this.agents.clear();
    this.writeQueues.clear();
    this.lifecycleLocks.clear();
    this.delivering.clear();

    // Write tombstone so loadAllAgentStates() skips restoration on next startup
    writeTombstone();

    // Kill ALL non-init, non-server processes to catch bash/node/curl/git spawned by agents
    cleanupAllProcesses();

    // Second pass at +500ms to catch anything spawned mid-kill
    setTimeout(() => {
      cleanupAllProcesses();
      console.log("[kill-switch] Second cleanup pass complete");
    }, 500).unref();

    console.log("[kill-switch] emergencyDestroyAll complete");
  }

  /** Graceful shutdown: flush state and kill processes, but preserve state files for restore. */
  dispose(): void {
    clearInterval(this.cleanupInterval);
    clearInterval(this.flushInterval);
    this.flushAllStates();
    for (const agentProc of this.agents.values()) {
      if (agentProc.proc && !agentProc.proc.killed) {
        killProcessGroup(agentProc.proc);
      }
      agentProc.listeners.clear();
    }
    this.writeQueues.clear();
    this.agents.clear();
  }

  /** Returns the set of workspace directories for all active agents. */
  getActiveWorkspaceDirs(): Set<string> {
    const dirs = new Set<string>();
    for (const agentProc of this.agents.values()) {
      dirs.add(agentProc.agent.workspaceDir);
    }
    return dirs;
  }

  /** Attach stdout/stderr/close handlers to a spawned process. */
  private attachProcessHandlers(id: string, agentProc: AgentProcess, proc: ReturnType<typeof spawn>): void {
    proc.stdout?.on("data", (chunk: Buffer) => {
      agentProc.lineBuffer += chunk.toString();
      const lines = agentProc.lineBuffer.split("\n");
      agentProc.lineBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as StreamEvent;
          this.handleEvent(id, event);
        } catch {
          this.handleEvent(id, { type: "raw", text: line });
        }
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      this.handleEvent(id, { type: "stderr", text: d.toString() });
    });

    proc.on("close", (code) => {
      this.handleEvent(id, { type: "done", exitCode: code ?? undefined });
      const ap = this.agents.get(id);
      if (ap) {
        ap.agent.status = code === 0 ? "idle" : "error";
        ap.agent.lastActivity = new Date().toISOString();
        saveAgentState(ap.agent);
      }
      syncToGCS().catch(() => {});

      // Notify idle listeners so queued messages can be delivered
      if (code === 0) {
        for (const listener of this.idleListeners) {
          try {
            listener(id);
          } catch (err: unknown) {
            console.warn("[agents] Idle listener error:", errorMessage(err));
          }
        }
      }
    });
  }

  private handleEvent(id: string, event: StreamEvent): void {
    const agentProc = this.agents.get(id);
    if (!agentProc) return;

    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      agentProc.agent.claudeSessionId = event.session_id as string;
      saveAgentState(agentProc.agent);
    }

    agentProc.agent.lastActivity = new Date().toISOString();

    // Persist sanitized event to JSONL (strip secrets, async write queue to avoid interleaving)
    const sanitized = sanitizeEvent(event);
    const line = `${JSON.stringify(sanitized)}\n`;
    const filePath = path.join(EVENTS_DIR, `${id}.jsonl`);
    const prev = this.writeQueues.get(id) ?? Promise.resolve();
    const next = prev
      .then(() =>
        appendFile(filePath, line).catch((err: unknown) => {
          console.warn(`[agents] Failed to persist event for ${id}:`, errorMessage(err));
        }),
      )
      .then(() => {
        if (this.writeQueues.get(id) === next) {
          this.writeQueues.set(id, Promise.resolve());
        }
      });
    this.writeQueues.set(id, next);

    for (const listener of agentProc.listeners) {
      try {
        listener(event);
      } catch (err: unknown) {
        console.warn("[agents] Listener error:", errorMessage(err));
      }
    }
  }

  private async readPersistedEvents(id: string): Promise<StreamEvent[]> {
    const filePath = path.join(EVENTS_DIR, `${id}.jsonl`);
    try {
      const data = await readFile(filePath, "utf-8");
      const lines = data.split("\n");
      const events: StreamEvent[] = [];
      const startIdx = Math.max(0, lines.length - MAX_PERSISTED_EVENTS);
      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as StreamEvent);
        } catch {}
      }
      return events;
    } catch (err) {
      console.warn(`[agents] Failed to read persisted events for ${id.slice(0, 8)}:`, errorMessage(err));
      return [];
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, agentProc] of [...this.agents]) {
      const lastActivity = new Date(agentProc.agent.lastActivity).getTime();
      if (now - lastActivity > SESSION_TTL_MS) {
        console.log(`Cleaning up expired agent ${id}`);
        this.destroy(id);
      }
    }
  }

  /** Flush all agent states to disk. */
  private flushAllStates(): void {
    for (const agentProc of this.agents.values()) {
      saveAgentState(agentProc.agent);
    }
    this.truncateEventFiles();
  }

  /** Truncate oversized event files to prevent unbounded growth on GCS FUSE. */
  private truncateEventFiles(): void {
    for (const id of this.agents.keys()) {
      const filePath = path.join(EVENTS_DIR, `${id}.jsonl`);
      const prev = this.writeQueues.get(id) ?? Promise.resolve();
      const next = prev.then(async () => {
        try {
          const fileStat = await stat(filePath).catch(() => null);
          if (!fileStat) return;
          if (fileStat.size < EVENT_FILE_TRUNCATE_THRESHOLD * 200) return;
          const data = await readFile(filePath, "utf-8");
          const lines = data.split("\n").filter((l) => l.trim());
          if (lines.length <= EVENT_FILE_TRUNCATE_THRESHOLD) return;
          const trimmed = lines.slice(-MAX_PERSISTED_EVENTS);
          const tmpPath = `${filePath}.tmp.${Date.now()}`;
          await writeFile(tmpPath, `${trimmed.join("\n")}\n`);
          await rename(tmpPath, filePath);
          console.log(
            `[agents] Truncated event file for ${id.slice(0, 8)}: ${lines.length} → ${trimmed.length} events`,
          );
        } catch (err: unknown) {
          console.warn(`[agents] Failed to truncate events for ${id}:`, errorMessage(err));
        }
      });
      this.writeQueues.set(id, next);
    }
  }

  /** Ensure workspace directory exists with symlinks and CLAUDE.md. */
  private ensureWorkspace(workspaceDir: string, agentName: string, agentId?: string): void {
    mkdirSync(workspaceDir, { recursive: true });

    // Symlink shared context into workspace
    mkdirSync(SHARED_CONTEXT_DIR, { recursive: true });
    const contextTarget = path.join(workspaceDir, "shared-context");
    if (!existsSync(contextTarget)) {
      symlinkSync(path.resolve(SHARED_CONTEXT_DIR), contextTarget);
    }

    // Symlink persistent repos into workspace (if available)
    const persistentRepos = "/persistent/repos";
    if (existsSync(persistentRepos)) {
      const reposTarget = path.join(workspaceDir, "repos");
      if (!existsSync(reposTarget)) {
        symlinkSync(persistentRepos, reposTarget);
      }
    }

    // Seed initial working memory file so the agent (and other agents) can
    // see it immediately — agents are instructed to keep it updated.
    const wmPath = path.join(SHARED_CONTEXT_DIR, `working-memory-${agentName}.md`);
    if (!existsSync(wmPath)) {
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      writeFileSync(
        wmPath,
        `<!-- summary: Working memory for ${agentName} -->\n# Working Memory — ${agentName}\n\n## Current Task\nStarting up — reading instructions\n\n## Status\nactive\n\n## Context\n- Agent just spawned\n\n## Recent Actions\n- ${timestamp} — Agent created, workspace initialized\n\n## Next Steps\n- Read CLAUDE.md and shared context\n- Begin assigned task\n`,
      );
    }

    // Write workspace CLAUDE.md so agents know about shared context and working memory
    this.writeWorkspaceClaudeMd(workspaceDir, agentName, agentId);
  }

  private buildClaudeArgs(opts: CreateAgentRequest, model: string, resumeSessionId?: string): string[] {
    const args = [
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      String(opts.maxTurns ?? 200),
      "--model",
      model,
    ];
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    args.push("--print", "--", opts.prompt);
    return args;
  }

  private writeWorkspaceClaudeMd(workspaceDir: string, agentName: string, agentId?: string): void {
    // Build shared-context index with summaries
    const sharedContextPath = path.join(workspaceDir, "shared-context");
    const contextIndex = buildSharedContextIndex(sharedContextPath);

    // Build repo list if persistent storage is available
    const persistentRepos = "/persistent/repos";
    let repoList: string[] = [];
    if (existsSync(persistentRepos)) {
      try {
        repoList = readdirSync(persistentRepos).filter((f) => f.endsWith(".git"));
      } catch (err) {
        console.warn("[agents] Failed to list persistent repos:", errorMessage(err));
      }
    }

    // List existing skills/commands
    const commandsDir = path.join(
      process.env.CLAUDE_HOME || path.join(process.env.HOME || "/home/agent", ".claude"),
      "commands",
    );
    let skillFiles: string[] = [];
    if (existsSync(commandsDir)) {
      try {
        skillFiles = scanCommands(commandsDir);
      } catch (err) {
        console.warn("[agents] Failed to scan skills/commands:", errorMessage(err));
      }
    }

    const skillsList = skillFiles.length > 0 ? skillFiles.map((f) => `- \`${f}\``).join("\n") : "(none yet)";

    // Gather agent list (no currentTask — CRIT-1 fix; token passed via AGENT_AUTH_TOKEN env var)
    const PORT = process.env.PORT ?? "8080";
    const otherAgents = this.list()
      .filter((a) => a.id !== agentId)
      .map((a) => ({
        name: a.name,
        id: a.id,
        role: a.role,
        status: a.status,
      }));

    const claudeMd = generateWorkspaceClaudeMd({
      agentName,
      agentId: agentId || "unknown",
      workspaceDir,
      port: PORT,
      otherAgents,
      contextIndex,
      repoList,
      skillsList,
    });

    writeFileSync(path.join(workspaceDir, "CLAUDE.md"), claudeMd);
  }

  /** Save attachments to the agent workspace and return a prompt suffix referencing them. */
  saveAttachments(workspaceDir: string, attachments: PromptAttachment[]): string {
    if (attachments.length === 0) return "";

    const attachDir = path.join(workspaceDir, ".attachments");
    mkdirSync(attachDir, { recursive: true });

    const refs: string[] = [];
    const timestamp = Date.now();

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${timestamp}-${i}-${safeName}`;
      const filePath = path.join(attachDir, filename);

      if (att.type === "image" && att.data.startsWith("data:")) {
        // Strip data URL prefix and decode base64
        const base64 = att.data.replace(/^data:[^;]+;base64,/, "");
        writeFileSync(filePath, Buffer.from(base64, "base64"));
        refs.push(`[Attached image: ${att.name}] — saved to ${filePath} (use the Read tool to view it)`);
      } else if (att.type === "file") {
        writeFileSync(filePath, att.data, "utf-8");
        refs.push(`[Attached file: ${att.name}] — saved to ${filePath} (use the Read tool to view it)`);
      }
    }

    return refs.length > 0 ? `\n\n${refs.join("\n")}` : "";
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SHELL: "/bin/sh",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      AGENT_AUTH_TOKEN: generateServiceToken(),
    };
    // Remove nested session detection so spawned agents don't refuse to start
    delete env.CLAUDECODE;
    // Layer 0: Remove server-only secrets agents must never have.
    // Agents keep ANTHROPIC_API_KEY and GITHUB_TOKEN (needed for their work)
    // but lose the ability to forge tokens or authenticate as the server.
    delete env.JWT_SECRET;
    delete env.API_KEY;
    return env;
  }
}
