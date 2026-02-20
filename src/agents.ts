import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import type { CostTracker } from "./cost-tracker";
import {
  ALLOWED_MODELS,
  DEFAULT_MODEL,
  MAX_AGENT_DEPTH,
  MAX_AGENTS,
  MAX_CHILDREN_PER_AGENT,
  SESSION_TTL_MS,
} from "./guardrails";
import { logger } from "./logger";
import { EVENTS_DIR, loadAllAgentStates, removeAgentState, saveAgentState, writeTombstone } from "./persistence";
import { sanitizeEvent } from "./sanitize";
import { cleanupAgentClaudeData, debouncedSyncToGCS } from "./storage";
import type {
  Agent,
  AgentMetadata,
  AgentProcess,
  AgentUsage,
  CreateAgentRequest,
  PromptAttachment,
  StreamEvent,
} from "./types";
import { errorMessage } from "./types";
import { getContextDir } from "./utils/context";
import { WorkspaceManager } from "./workspace-manager";
import { cleanupWorktreesForWorkspace } from "./worktrees";

const SHARED_CONTEXT_DIR = getContextDir();

const execFileAsync = promisify(execFile);

async function gitCmd(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8", timeout: 3_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function getGitInfo(
  workspaceDir: string,
): Promise<{ repo: string | null; branch: string | null; worktreePath: string | null }> {
  const result = { repo: null as string | null, branch: null as string | null, worktreePath: null as string | null };

  const topLevel = await gitCmd(workspaceDir, ["rev-parse", "--show-toplevel"]);
  if (topLevel) {
    result.branch = await gitCmd(topLevel, ["rev-parse", "--abbrev-ref", "HEAD"]);
    result.repo = await gitCmd(topLevel, ["remote", "get-url", "origin"]);
    const commonDir = await gitCmd(topLevel, ["rev-parse", "--git-common-dir"]);
    const gitDir = await gitCmd(topLevel, ["rev-parse", "--git-dir"]);
    if (commonDir && gitDir && path.resolve(topLevel, commonDir) !== path.resolve(topLevel, gitDir)) {
      result.worktreePath = topLevel;
    }
    return result;
  }

  try {
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const subdir = path.join(workspaceDir, entry.name);
      const branch = await gitCmd(subdir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branch) {
        result.branch = branch;
        result.repo = await gitCmd(subdir, ["remote", "get-url", "origin"]);
        result.worktreePath = subdir;
        return result;
      }
    }
  } catch {
    // readdir may fail if workspace doesn't exist
  }

  return result;
}

/** Harmless stderr noise from Claude CLI startup that should not surface as errors. */
const STDERR_NOISE_RE = /apiKeyHelper did not return a valid value|Error getting API key from apiKeyHelper/;

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
      const pid = Number.parseInt(pidStr, 10);
      if (pid === 1 || pid === myPid) continue;
      try {
        process.kill(pid, "SIGKILL");
        killed++;
      } catch {
        // Already dead or no permission - skip
      }
    }
    if (killed > 0) {
      logger.info(`[kill-switch] cleanupAllProcesses: killed ${killed} process(es)`);
    }
  } catch {
    // ps not available - skip
  }
}

const MAX_PERSISTED_EVENTS = 5_000;
const EVENT_FILE_TRUNCATE_THRESHOLD = 10_000;
const EVENT_RING_BUFFER_SIZE = 1_000;

export class AgentManager {
  private agents = new Map<string, AgentProcess>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private flushInterval: ReturnType<typeof setInterval>;
  private watchdogInterval: ReturnType<typeof setInterval>;
  private idleListeners = new Set<(agentId: string) => void>();
  private writeQueues = new Map<string, Promise<void>>();
  /** Per-agent lifecycle lock to prevent concurrent message/destroy operations.
   *  Each entry is a promise chain - operations queue behind the previous one. */
  private lifecycleLocks = new Map<string, Promise<void>>();
  /** Set of agent IDs currently being delivered to (prevents concurrent delivery). */
  private delivering = new Set<string>();
  /** Track recent agent creations to prevent duplicates from parallel requests.
   *  Key: "parentId:name" or "name", Value: timestamp of creation. */
  private recentCreations = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 10_000; // 10 seconds
  /** Layer 1: Set to true by kill switch - blocks create() and message() at the code level. */
  killed = false;
  /** Optional persistent cost tracker (SQLite-backed). */
  private costTracker: CostTracker | null = null;
  /** Workspace management (directories, symlinks, tokens, env). */
  private workspace = new WorkspaceManager();

  constructor(opts?: { costTracker?: CostTracker }) {
    this.costTracker = opts?.costTracker ?? null;
    this.workspace.setAgentListProvider(this);
    // Cleanup idle agents every 60s
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 60_000);
    // Periodic state flush every 30s (catches lastActivity updates without writing on every poll)
    this.flushInterval = setInterval(() => this.flushAllStates(), 30_000);
    // WI-4: Watchdog checks every 30s for dead/stalled/stuck-starting agents
    this.watchdogInterval = setInterval(() => this.watchdogCheck(), 30_000);
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

    logger.info(`[restore] Found ${states.length} persisted agent state(s)`);
    for (const agent of states) {
      // Skip if already in memory (shouldn't happen on fresh start, but be safe)
      if (this.agents.has(agent.id)) continue;

      // Recreate workspace directory, symlinks, and token file after container restart
      this.workspace.ensureWorkspace(agent.workspaceDir, agent.name, agent.id);

      // Zombie detection: any agent that had an active or pending process is now
      // disconnected because the process is gone after a container restart.
      // Only the terminal error state is preserved as-is.
      if (agent.status !== "error") {
        agent.status = "disconnected";
        saveAgentState(agent);
      }

      const agentProc: AgentProcess = {
        agent,
        proc: null,
        lineBuffer: "",
        listeners: new Set(),
        seenMessageIds: new Set(),
        processingScheduled: false,
        persistBatch: "",
        persistTimer: null,
        listenerBatch: [],
        stallCount: 0,
        eventBuffer: [],
        eventBufferTotal: 0,
      };
      this.agents.set(agent.id, agentProc);

      // Rehydrate all-time billing on startup for agents with existing usage.
      if (
        (agent.usage?.tokensIn ?? 0) > 0 ||
        (agent.usage?.tokensOut ?? 0) > 0 ||
        (agent.usage?.estimatedCost ?? 0) > 0
      ) {
        this.upsertCostTracker(agentProc);
      }

      logger.info(`[restore] Restored agent ${agent.name} — status: ${agent.status}`, { agentId: agent.id });
    }
  }

  create(opts: CreateAgentRequest): {
    agent: Agent;
    subscribe: (listener: (event: StreamEvent) => void) => () => void;
  } {
    // Layer 1: Block spawning when kill switch is active
    if (this.killed) {
      throw new Error("Kill switch is active - agent spawning is disabled");
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
    this.workspace.ensureWorkspace(workspaceDir, name, id);

    const now = new Date().toISOString();
    const agent: Agent = {
      id,
      name,
      status: "starting",
      workspaceDir,
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions === true,
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
      const suffix = this.workspace.saveAttachments(workspaceDir, opts.attachments);
      finalPrompt = opts.prompt + suffix;
    }

    const args = this.buildClaudeArgs({ ...opts, prompt: finalPrompt }, model);
    const env = this.workspace.buildEnv(id);

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
      seenMessageIds: new Set(),
      processingScheduled: false,
      persistBatch: "",
      persistTimer: null,
      listenerBatch: [],
      stallCount: 0,
      eventBuffer: [],
      eventBufferTotal: 0,
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
   *  Returns an array of results - one per spec - with either the created agent or an error. */
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
    if (this.killed) throw new Error("Kill switch is active - agent messaging is disabled");
    const agentProc = this.agents.get(id);
    if (!agentProc) throw new Error("Agent not found");
    if (!agentProc.agent.claudeSessionId) throw new Error("Agent has no session to resume");
    if (agentProc.agent.status === "killing")
      throw new Error("Agent is shutting down a previous process, try again shortly");

    // Use targetSessionId if provided, otherwise use the agent's main session
    const resumeId = targetSessionId || agentProc.agent.claudeSessionId;

    const model = agentProc.agent.model;
    const args = this.buildClaudeArgs(
      {
        prompt,
        maxTurns,
        model,
        dangerouslySkipPermissions: agentProc.agent.dangerouslySkipPermissions === true,
      },
      model,
      resumeId,
    );
    const env = this.workspace.buildEnv(id);

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
    this.workspace.ensureWorkspace(agentProc.agent.workspaceDir, agentProc.agent.name, id);

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
    const lockPromise = spawnAfterKill.catch((err) => {
      logger.error("[agents] Error spawning agent", { agentId: id, error: errorMessage(err) });
    });
    this.lifecycleLocks.set(id, lockPromise);
    // Clean up the lock entry once the spawn completes so the watchdog can monitor this agent
    lockPromise.then(() => {
      if (this.lifecycleLocks.get(id) === lockPromise) {
        this.lifecycleLocks.delete(id);
      }
    });

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

      // Use process group kill (SIGTERM then SIGKILL escalation) from killProcessGroup
      killProcessGroup(proc);

      // Safety timeout - resolve even if close never fires
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
    // Only deliver to agents that aren't actively running and have a session to resume.
    // Stalled agents also receive deliveries to attempt recovery.
    // Disconnected agents are not auto-delivered to - they must be manually destroyed.
    if ((status === "idle" || status === "restored" || status === "stalled") && !!agentProc.agent.claudeSessionId) {
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

  /** WI-5: Pause an agent by sending SIGSTOP to its process group.
   *  Agents spawn with `detached: true`, giving them their own process group. */
  pause(id: string): boolean {
    const agentProc = this.agents.get(id);
    if (!agentProc) return false;
    const { agent, proc } = agentProc;
    if (agent.status !== "running" && agent.status !== "stalled") return false;
    if (!proc || proc.exitCode !== null || proc.pid == null) return false;

    try {
      process.kill(-proc.pid, "SIGSTOP");
    } catch {
      return false;
    }

    agent.status = "paused";
    agent.lastActivity = new Date().toISOString();
    saveAgentState(agent);
    this.handleEvent(id, {
      type: "system",
      subtype: "paused",
      message: "Agent paused via SIGSTOP. Send /resume to continue.",
    });
    return true;
  }

  /** WI-5: Resume a paused agent by sending SIGCONT to its process group.
   *  If SIGCONT fails (e.g. stale connections after long pause), falls back to
   *  killing the process - the next message delivery will respawn via --resume. */
  resume(id: string): boolean {
    const agentProc = this.agents.get(id);
    if (!agentProc) return false;
    const { agent, proc } = agentProc;
    if (agent.status !== "paused") return false;
    if (!proc || proc.pid == null) return false;

    try {
      process.kill(-proc.pid, "SIGCONT");
    } catch {
      // Process group gone - mark as idle so message delivery can respawn
      agent.status = "idle";
      agent.lastActivity = new Date().toISOString();
      saveAgentState(agent);
      this.handleEvent(id, {
        type: "system",
        subtype: "resumed",
        message: "Resume failed (process gone). Agent marked idle for respawn.",
      });
      return true;
    }

    // Verify the process is actually alive after SIGCONT - it may have exited
    // while paused (zombie state) and process.kill() won't throw for zombies.
    if (proc.exitCode !== null) {
      agent.status = "idle";
      agent.lastActivity = new Date().toISOString();
      saveAgentState(agent);
      this.handleEvent(id, {
        type: "system",
        subtype: "resumed",
        message: "Process exited while paused. Agent marked idle for respawn.",
      });
      return true;
    }

    agent.status = "running";
    agent.lastActivity = new Date().toISOString();
    saveAgentState(agent);
    this.handleEvent(id, {
      type: "system",
      subtype: "resumed",
      message: "Agent resumed via SIGCONT.",
    });
    return true;
  }

  async getEvents(id: string): Promise<StreamEvent[]> {
    if (!this.agents.has(id)) return [];
    return this.readPersistedEvents(id);
  }

  /** Context window limit per model (approximate values). */
  private static readonly TOKEN_LIMITS: Record<string, number> = {
    "claude-opus-4-6": 200_000,
    "claude-sonnet-4-6": 200_000,
    "claude-sonnet-4-5-20250929": 200_000,
    "claude-haiku-4-5-20251001": 200_000,
  };

  /** Per-million-token pricing by model (USD). */
  private static readonly MODEL_PRICING: Record<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number }
  > = {
    "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 },
    "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-4-5-20250929": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  };

  /** Estimate cost in USD from token usage and model pricing. */
  private static estimateCost(
    model: string,
    usage: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    },
  ): number {
    const pricing = AgentManager.MODEL_PRICING[model];
    if (!pricing) return 0;
    const perM = 1_000_000;
    return (
      ((usage.input_tokens ?? 0) / perM) * pricing.input +
      ((usage.output_tokens ?? 0) / perM) * pricing.output +
      ((usage.cache_read_input_tokens ?? 0) / perM) * pricing.cacheRead +
      ((usage.cache_creation_input_tokens ?? 0) / perM) * pricing.cacheWrite
    );
  }

  /** Return token usage and estimated cost for a single agent. */
  getUsage(id: string): AgentUsage | null {
    const agentProc = this.agents.get(id);
    if (!agentProc) return null;
    const { agent } = agentProc;
    const tokensIn = agent.usage?.tokensIn ?? 0;
    const tokensOut = agent.usage?.tokensOut ?? 0;
    const tokensTotal = tokensIn + tokensOut;
    const tokenLimit = AgentManager.TOKEN_LIMITS[agent.model] ?? 200_000;
    return {
      tokensIn,
      tokensOut,
      tokensTotal,
      tokenLimit,
      tokensRemaining: Math.max(0, tokenLimit - tokensTotal),
      estimatedCost: Math.round((agent.usage?.estimatedCost ?? 0) * 1e6) / 1e6,
      model: agent.model,
      sessionStart: agent.createdAt,
    };
  }

  /** Return runtime metadata for a single agent (PID, git info, uptime, etc.). */
  async getMetadata(id: string): Promise<AgentMetadata | null> {
    const agentProc = this.agents.get(id);
    if (!agentProc) return null;
    const { agent, proc } = agentProc;
    const uptimeMs = Date.now() - new Date(agent.createdAt).getTime();
    const gitInfo = await getGitInfo(agent.workspaceDir);
    return {
      pid: proc?.pid ?? null,
      uptime: uptimeMs,
      workingDir: agent.workspaceDir,
      repo: gitInfo.repo,
      branch: gitInfo.branch,
      worktreePath: gitInfo.worktreePath,
      tokensIn: agent.usage?.tokensIn ?? 0,
      tokensOut: agent.usage?.tokensOut ?? 0,
      estimatedCost: Math.round((agent.usage?.estimatedCost ?? 0) * 1e6) / 1e6,
      model: agent.model,
      sessionId: agent.claudeSessionId ?? null,
    };
  }

  /** Return token usage for all agents, keyed by agent ID. */
  getAllUsage(): { agents: Array<{ id: string; name: string; usage: AgentUsage }> } {
    const result: Array<{ id: string; name: string; usage: AgentUsage }> = [];
    for (const agentProc of this.agents.values()) {
      const usage = this.getUsage(agentProc.agent.id);
      if (usage) {
        result.push({ id: agentProc.agent.id, name: agentProc.agent.name, usage });
      }
    }
    return { agents: result };
  }

  /** Reset in-memory usage counters for all tracked agents.
   *  Only clears in-memory state and persists to /persistent/ — callers are
   *  responsible for clearing SQLite via costTracker.reset() if needed. */
  resetAllUsage(): void {
    for (const agentProc of this.agents.values()) {
      agentProc.agent.usage = { tokensIn: 0, tokensOut: 0, estimatedCost: 0 };
      saveAgentState(agentProc.agent);
    }
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
      destroyOp.catch((err) => {
        logger.error("[agents] Error destroying agent", { agentId: id, error: errorMessage(err) });
      }),
    );

    // Mark agent as destroying immediately so canDeliver/canInterrupt return false
    agentProc.agent.status = "destroying";

    // Remove from in-memory map immediately so no other code path
    // (flush interval, close handler) can re-save this agent's state.
    this.agents.delete(id);
    this.delivering.delete(id);

    return true;
  }

  /** Internal destroy implementation - runs after lifecycle lock is released. */
  private async doDestroy(id: string, agentProc: AgentProcess): Promise<void> {
    // Finalize cost record in SQLite before cleanup - the data was already
    // upserted independently of the agent map, so this just sets closedAt.
    if (this.costTracker) {
      this.costTracker.finalize(id);
    }

    // Flush any pending event batches before destroy so no events are lost
    this.flushEventBatch(id, agentProc);

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
        logger.warn("[agents] Listener error during destroy", { error: errorMessage(err) });
      }
    }
    agentProc.listeners.clear();

    await cleanupWorktreesForWorkspace(agentProc.agent.workspaceDir);

    const workingMemoryPath = path.join(SHARED_CONTEXT_DIR, `working-memory-${agentProc.agent.name}.md`);
    try {
      await unlink(workingMemoryPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`[agents] Failed to remove working memory for ${agentProc.agent.name}`, {
          error: errorMessage(err),
          agentId: agentProc.agent.id,
        });
      }
    }

    try {
      await rm(agentProc.agent.workspaceDir, { recursive: true, force: true });
    } catch (err: unknown) {
      logger.warn("[agents] Failed to remove workspace", { error: errorMessage(err), agentId: id });
    }
    await cleanupAgentClaudeData(agentProc.agent.workspaceDir);
    try {
      await unlink(path.join(EVENTS_DIR, `${id}.jsonl`));
    } catch (err: unknown) {
      logger.warn("[agents] Failed to remove event file", { error: errorMessage(err), agentId: id });
    }
    await removeAgentState(id);
    this.writeQueues.delete(id);
    this.lifecycleLocks.delete(id);
  }

  destroyAll(): void {
    for (const id of [...this.agents.keys()]) {
      this.destroy(id);
    }
  }

  /**
   * Layer 2: Nuclear emergency shutdown - called by the kill switch.
   * Unlike destroyAll(), this:
   *   1. Sets killed flag immediately (blocks create/message at code level)
   *   2. Clears all message bus listeners (prevents auto-delivery from re-triggering agents)
   *   3. SIGKILLs all tracked processes immediately (no graceful SIGTERM)
   *   4. Kills ALL non-init processes (not just claude - catches bash, node, curl, git, etc.)
   *   5. Deletes ALL state files so agents are not restored on restart
   *   6. Writes a tombstone file so loadAllAgentStates() skips restoration even if delete failed
   *   7. Schedules a second pass at +500ms to catch processes spawned mid-kill
   */
  emergencyDestroyAll(): void {
    this.killed = true;
    clearInterval(this.cleanupInterval);
    clearInterval(this.flushInterval);
    clearInterval(this.watchdogInterval);

    logger.info("[kill-switch] emergencyDestroyAll - starting nuclear shutdown");

    // Clear all idle listeners to prevent auto-delivery from re-triggering agent runs
    this.idleListeners.clear();

    // SIGKILL all tracked processes immediately
    for (const [id, agentProc] of this.agents) {
      // Clear WI-1 batch timers and ring buffer
      if (agentProc.persistTimer) clearTimeout(agentProc.persistTimer);
      agentProc.persistTimer = null;
      agentProc.persistBatch = "";
      agentProc.listenerBatch = [];
      agentProc.eventBuffer = [];
      agentProc.eventBufferTotal = 0;

      const proc = agentProc.proc;
      if (proc) {
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
        proc.removeAllListeners("close");
        if (!proc.killed && proc.pid != null) {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            try {
              process.kill(proc.pid, "SIGKILL");
            } catch {
              /* already dead */
            }
          }
        }
      }
      agentProc.listeners.clear();

      // Fire-and-forget cleanup - emergencyDestroyAll is synchronous by design
      // (nuclear kill path) so we don't await, but must use .catch() since
      // removeAgentState is async and try/catch won't catch promise rejections.
      removeAgentState(id).catch((err) => {
        logger.error("[agents] Failed to remove state for agent", { agentId: id, error: errorMessage(err) });
      });
      unlink(path.join(EVENTS_DIR, `${id}.jsonl`)).catch((err) => {
        logger.error("[agents] Failed to remove events file for agent", { agentId: id, error: errorMessage(err) });
      });
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
      logger.info("[kill-switch] Second cleanup pass complete");
    }, 500).unref();

    logger.info("[kill-switch] emergencyDestroyAll complete");
  }

  /** Graceful shutdown: flush state and kill processes, but preserve state files for restore. */
  dispose(): void {
    clearInterval(this.cleanupInterval);
    clearInterval(this.flushInterval);
    clearInterval(this.watchdogInterval);
    this.flushAllStates();
    for (const [id, agentProc] of this.agents) {
      // Flush any pending event batches before shutdown
      this.flushEventBatch(id, agentProc);
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

  /** Attach stdout/stderr/close handlers to a spawned process.
   *  Uses batched line processing (WI-1) to prevent event loop saturation
   *  when many agents produce output simultaneously. */
  private attachProcessHandlers(id: string, agentProc: AgentProcess, proc: ReturnType<typeof spawn>): void {
    proc.stdout?.on("data", (chunk: Buffer) => {
      agentProc.lineBuffer += chunk.toString();

      // Backpressure: pause stdout if lineBuffer exceeds 1 MB to prevent
      // unbounded memory growth when agents produce output faster than we parse
      if (agentProc.lineBuffer.length > 1_048_576 && proc.stdout) {
        proc.stdout.pause();
      }

      // Schedule batch processing on next tick instead of processing synchronously
      // in the data handler. This yields the event loop between data chunks so
      // SSE heartbeats and API responses can be served.
      if (!agentProc.processingScheduled) {
        agentProc.processingScheduled = true;
        setImmediate(() => this.processLineBuffer(id, agentProc, proc));
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      if (STDERR_NOISE_RE.test(text)) return;
      this.handleEvent(id, { type: "stderr", text });
    });

    proc.on("close", (code) => {
      // Flush any remaining data in the line buffer (e.g. final result event
      // from the CLI that may not have a trailing newline)
      if (agentProc.lineBuffer.trim()) {
        try {
          const event = JSON.parse(agentProc.lineBuffer) as StreamEvent;
          this.handleEvent(id, event);
        } catch {
          this.handleEvent(id, { type: "raw", text: agentProc.lineBuffer });
        }
        agentProc.lineBuffer = "";
      }

      this.handleEvent(id, { type: "done", exitCode: code ?? undefined });

      // Flush any pending batches immediately on close - listeners need
      // to see events (especially "done") before state transitions happen
      this.flushEventBatch(id, agentProc);

      const ap = this.agents.get(id);
      if (ap) {
        ap.agent.status = code === 0 ? "idle" : "error";
        ap.agent.lastActivity = new Date().toISOString();
        saveAgentState(ap.agent);
      }
      debouncedSyncToGCS().catch((err) => {
        logger.error("[agents] Failed to sync GCS after agent exit", { agentId: id, error: errorMessage(err) });
      });

      // Notify idle listeners so queued messages can be delivered
      if (code === 0) {
        this.notifyIdleListeners(id);
      }
    });
  }

  /** Process buffered stdout lines in batches of 50, yielding to the event
   *  loop between batches via setImmediate. This prevents a burst of output
   *  from one agent from starving SSE heartbeats and API requests. */
  private processLineBuffer(id: string, agentProc: AgentProcess, proc: ReturnType<typeof spawn>): void {
    agentProc.processingScheduled = false;

    // Agent may have been destroyed while processing was queued via setImmediate
    if (!this.agents.has(id)) return;

    const lines = agentProc.lineBuffer.split("\n");
    agentProc.lineBuffer = lines.pop() || "";

    const BATCH_SIZE = 50;
    let offset = 0;

    const processBatch = () => {
      // Agent may have been destroyed while processing was queued
      if (!this.agents.has(id)) return;

      const end = Math.min(offset + BATCH_SIZE, lines.length);
      for (let i = offset; i < end; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as StreamEvent;
          this.handleEvent(id, event);
        } catch {
          this.handleEvent(id, { type: "raw", text: line });
        }
      }

      offset = end;

      if (offset < lines.length) {
        // More lines to process - yield to event loop then continue
        setImmediate(processBatch);
      } else {
        // Done processing - resume stdout if paused due to backpressure
        if (proc.stdout?.isPaused?.()) {
          proc.stdout.resume();
        }
      }
    };

    processBatch();
  }

  /** Handle a single event: extract metadata immediately, batch persistence
   *  and listener notification. Metadata (session_id, usage) is processed
   *  synchronously since it affects agent state. Disk writes and listener
   *  notifications are coalesced into 16 ms batches to reduce I/O calls and
   *  SSE write pressure. */
  private handleEvent(id: string, event: StreamEvent): void {
    const agentProc = this.agents.get(id);
    if (!agentProc) return;

    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      agentProc.agent.claudeSessionId = event.session_id as string;
      saveAgentState(agentProc.agent);
    }

    // Parse token usage from assistant events emitted by claude CLI stream-json.
    // The CLI emits multiple "assistant" events per API message (one per content block),
    // each carrying the same usage snapshot. We deduplicate by message ID so each
    // API call's tokens are counted exactly once.
    if (event.type === "assistant") {
      // Fix H1: Reset stallCount when real output arrives from a stalled agent
      if (agentProc.agent.status === "stalled" && (event.subtype === "text" || event.subtype === "tool_use")) {
        agentProc.stallCount = 0;
        agentProc.agent.status = "running";
        saveAgentState(agentProc.agent);
      }

      const msg = event.message as Record<string, unknown> | undefined;
      const msgId = msg?.id as string | undefined;
      const usage = msg?.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          }
        | undefined;

      if (msgId && usage && !agentProc.seenMessageIds.has(msgId)) {
        agentProc.seenMessageIds.add(msgId);

        // Cap seenMessageIds to prevent unbounded growth (Performance H2)
        if (agentProc.seenMessageIds.size > 1000) {
          const arr = Array.from(agentProc.seenMessageIds);
          agentProc.seenMessageIds = new Set(arr.slice(-500));
        }

        const tokensIn =
          (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        const tokensOut = usage.output_tokens ?? 0;
        const cost = AgentManager.estimateCost(agentProc.agent.model, usage);

        if (tokensIn > 0 || tokensOut > 0) {
          const prev = agentProc.agent.usage ?? { tokensIn: 0, tokensOut: 0, estimatedCost: 0 };
          agentProc.agent.usage = {
            tokensIn: prev.tokensIn + tokensIn,
            tokensOut: prev.tokensOut + tokensOut,
            estimatedCost: prev.estimatedCost + cost,
          };
          saveAgentState(agentProc.agent);
          this.upsertCostTracker(agentProc);
        }
      }
    }

    // Legacy: also handle "result" events in case a future CLI version emits them
    if (event.type === "result") {
      const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const totalCost = typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0;
      const tokensIn = usage?.input_tokens ?? 0;
      const tokensOut = usage?.output_tokens ?? 0;
      if (tokensIn > 0 || tokensOut > 0 || totalCost > 0) {
        const prev = agentProc.agent.usage ?? { tokensIn: 0, tokensOut: 0, estimatedCost: 0 };
        agentProc.agent.usage = {
          // tokensIn is NOT accumulated: each result event's input_tokens already contains
          // the full conversation context, so summing across turns massively overcounts.
          // Instead we store the latest value, which reflects current context window usage.
          tokensIn: tokensIn > 0 ? tokensIn : prev.tokensIn,
          tokensOut: prev.tokensOut + tokensOut,
          estimatedCost: prev.estimatedCost + totalCost,
        };
        saveAgentState(agentProc.agent);
        this.upsertCostTracker(agentProc);
      }
    }

    agentProc.agent.lastActivity = new Date().toISOString();

    // Batch persist: accumulate sanitized JSONL lines and flush with 16ms timer.
    // This turns N appendFile calls into 1, reducing I/O syscalls dramatically.
    const sanitized = sanitizeEvent(event);
    agentProc.persistBatch += `${JSON.stringify(sanitized)}\n`;

    // Append to in-memory ring buffer for fast reconnect replay.
    // Uses modular overwrite once the buffer reaches EVENT_RING_BUFFER_SIZE.
    if (agentProc.eventBuffer.length < EVENT_RING_BUFFER_SIZE) {
      agentProc.eventBuffer.push(sanitized);
    } else {
      agentProc.eventBuffer[agentProc.eventBufferTotal % EVENT_RING_BUFFER_SIZE] = sanitized;
    }
    agentProc.eventBufferTotal++;

    // Batch listener notification: buffer events for 16ms (one frame) before
    // notifying SSE listeners, reducing the number of res.write() calls.
    agentProc.listenerBatch.push(event);

    if (!agentProc.persistTimer) {
      agentProc.persistTimer = setTimeout(() => this.flushEventBatch(id, agentProc), 16);
    }
  }

  /** Persist usage snapshot to SQLite cost tracker. Only called when usage actually changes. */
  private upsertCostTracker(agentProc: AgentProcess): void {
    if (!this.costTracker || !agentProc.agent.usage) return;
    this.costTracker.upsert({
      agentId: agentProc.agent.id,
      agentName: agentProc.agent.name,
      model: agentProc.agent.model,
      tokensIn: agentProc.agent.usage.tokensIn,
      tokensOut: agentProc.agent.usage.tokensOut,
      estimatedCost: agentProc.agent.usage.estimatedCost,
      createdAt: agentProc.agent.createdAt,
    });
  }

  /** Flush batched event persistence and listener notifications for an agent.
   *  Called by the 16ms coalesce timer or synchronously on process close. */
  private flushEventBatch(id: string, agentProc: AgentProcess): void {
    // Clear timer
    if (agentProc.persistTimer) {
      clearTimeout(agentProc.persistTimer);
      agentProc.persistTimer = null;
    }

    // Flush persistence batch - single appendFile for all accumulated events
    const batch = agentProc.persistBatch;
    agentProc.persistBatch = "";
    if (batch) {
      const filePath = path.join(EVENTS_DIR, `${id}.jsonl`);
      const prev = this.writeQueues.get(id) ?? Promise.resolve();
      const next = prev
        .then(() =>
          appendFile(filePath, batch).catch((err: unknown) => {
            logger.warn("[agents] Failed to persist events", { agentId: id, error: errorMessage(err) });
          }),
        )
        .then(() => {
          if (this.writeQueues.get(id) === next) {
            this.writeQueues.set(id, Promise.resolve());
          }
        });
      this.writeQueues.set(id, next);
    }

    // Flush listener batch - notify all listeners with buffered events
    const events = agentProc.listenerBatch;
    agentProc.listenerBatch = [];
    if (events.length > 0) {
      for (const event of events) {
        for (const listener of agentProc.listeners) {
          try {
            listener(event);
          } catch (err: unknown) {
            logger.warn("[agents] Listener error", { error: errorMessage(err) });
          }
        }
      }
    }
  }

  /** Read the in-memory ring buffer in insertion order. */
  private readEventBuffer(agentProc: AgentProcess): StreamEvent[] {
    const { eventBuffer, eventBufferTotal } = agentProc;
    const len = eventBuffer.length;
    if (len === 0) return [];
    // Buffer hasn't wrapped yet - return as-is
    if (eventBufferTotal <= EVENT_RING_BUFFER_SIZE) return eventBuffer.slice();
    // Buffer has wrapped - oldest entry is at (eventBufferTotal % len), read in order
    const start = eventBufferTotal % len;
    return [...eventBuffer.slice(start), ...eventBuffer.slice(0, start)];
  }

  /** Hybrid event reader: serves from in-memory ring buffer for hot reconnects,
   *  falls back to streaming readline from disk for cold-start (restored) agents. */
  private async readPersistedEvents(id: string): Promise<StreamEvent[]> {
    // Hot path: if the agent has events in its ring buffer, serve from memory
    const agentProc = this.agents.get(id);
    if (agentProc && agentProc.eventBufferTotal > 0) {
      return this.readEventBuffer(agentProc);
    }

    // Cold path: stream from disk using readline (bounded memory)
    const filePath = path.join(EVENTS_DIR, `${id}.jsonl`);
    try {
      await stat(filePath);
    } catch {
      return [];
    }

    try {
      const events: StreamEvent[] = [];
      const rl = readline.createInterface({
        input: createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as StreamEvent);
        } catch {
          // Skip malformed lines
        }
      }

      // Trim to last MAX_PERSISTED_EVENTS in one pass (avoids O(n*k) per-line splice)
      if (events.length > MAX_PERSISTED_EVENTS) {
        events.splice(0, events.length - MAX_PERSISTED_EVENTS);
      }

      // Populate the ring buffer so subsequent reconnects are served from memory
      if (agentProc) {
        const bufferEvents = events.slice(-EVENT_RING_BUFFER_SIZE);
        agentProc.eventBuffer = bufferEvents;
        agentProc.eventBufferTotal = bufferEvents.length;
      }

      return events;
    } catch (err: unknown) {
      logger.warn("[agents] Failed to read persisted events", { agentId: id, error: errorMessage(err) });
      return [];
    }
  }

  private static readonly PAUSED_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, agentProc] of [...this.agents]) {
      const lastActivity = new Date(agentProc.agent.lastActivity).getTime();
      // Paused agents get an extended 24-hour TTL instead of indefinite exemption
      if (agentProc.agent.status === "paused") {
        if (now - lastActivity > AgentManager.PAUSED_TTL_MS) {
          logger.info("Cleaning up paused agent (exceeded 24h TTL)", { agentId: id });
          this.destroy(id);
        }
        continue;
      }
      if (now - lastActivity > SESSION_TTL_MS) {
        logger.info("Cleaning up expired agent", { agentId: id });
        this.destroy(id);
      }
    }
  }

  /** WI-4: Watchdog - detects dead processes, stalled agents, and start timeouts.
   *  Runs every 30s. Skips agents with active lifecycle locks to avoid races. */
  private static readonly START_TIMEOUT_MS = 2 * 60_000; // 2 minutes
  private static readonly STALL_TIMEOUT_MS = 10 * 60_000; // 10 minutes
  private static readonly MAX_STALL_COUNT = 3;

  /** Notify all idle listeners for an agent. Encapsulates the for-loop + try/catch pattern. */
  private notifyIdleListeners(id: string): void {
    for (const listener of this.idleListeners) {
      try {
        listener(id);
      } catch (err: unknown) {
        logger.warn("[agents] Idle listener error", { error: errorMessage(err) });
      }
    }
  }

  private watchdogCheck(): void {
    const now = Date.now();
    for (const [id, agentProc] of this.agents) {
      const { agent, proc } = agentProc;

      // Skip agents with active lifecycle locks - they're in the middle of
      // a message() or destroy() operation. Also skip paused and disconnected agents.
      if (this.lifecycleLocks.has(id)) continue;
      if (
        agent.status === "destroying" ||
        agent.status === "killing" ||
        agent.status === "paused" ||
        agent.status === "disconnected"
      )
        continue;

      // 1. Dead process detection: exitCode is set when the process has exited.
      //    proc.killed is unreliable (only set if WE killed it).
      if (proc && proc.exitCode !== null && agent.status === "running") {
        const exitCode = proc.exitCode;
        logger.warn("[watchdog] Dead process detected", { agentId: id, agentName: agent.name, exitCode });
        agent.status = exitCode === 0 ? "idle" : "error";
        agent.lastActivity = new Date().toISOString();
        saveAgentState(agent);
        this.handleEvent(id, {
          type: "system",
          subtype: "watchdog",
          message: `Process exited unexpectedly (code ${exitCode}). Status changed to ${agent.status}.`,
        });
        // Notify idle listeners if exit was clean
        if (exitCode === 0) {
          this.notifyIdleListeners(id);
        }
        continue;
      }

      // 2. Start timeout: agent stuck in "starting" for > 2 minutes
      if (agent.status === "starting") {
        const createdAt = new Date(agent.createdAt).getTime();
        if (now - createdAt > AgentManager.START_TIMEOUT_MS) {
          logger.warn("[watchdog] Start timeout", { agentId: id, agentName: agent.name });
          agent.status = "error";
          agent.lastActivity = new Date().toISOString();
          saveAgentState(agent);
          this.handleEvent(id, {
            type: "system",
            subtype: "watchdog",
            message: "Agent failed to start within 2 minutes. Status changed to error.",
          });
        }
        continue;
      }

      // 3. Stall detection: running agent with no output for > 10 minutes
      //    AND process is still alive (exitCode is null)
      if (agent.status === "running" && proc && proc.exitCode === null) {
        const lastActivityTs = new Date(agent.lastActivity).getTime();
        if (now - lastActivityTs > AgentManager.STALL_TIMEOUT_MS) {
          agentProc.stallCount++;
          if (agentProc.stallCount >= AgentManager.MAX_STALL_COUNT) {
            // Too many consecutive stalls - escalate to error
            logger.warn("[watchdog] Agent stalled too many times - marking as error", {
              agentId: id,
              agentName: agent.name,
              stallCount: AgentManager.MAX_STALL_COUNT,
            });
            agent.status = "error";
            saveAgentState(agent);
            this.handleEvent(id, {
              type: "system",
              subtype: "watchdog",
              message: `Agent stalled ${AgentManager.MAX_STALL_COUNT} consecutive times. Marked as error.`,
            });
          } else {
            logger.warn("[watchdog] Stall detected - no output for 10+ minutes", {
              agentId: id,
              agentName: agent.name,
              stallCount: agentProc.stallCount,
              maxStallCount: AgentManager.MAX_STALL_COUNT,
            });
            agent.status = "stalled";
            saveAgentState(agent);
            this.handleEvent(id, {
              type: "system",
              subtype: "watchdog",
              message: `No output for 10+ minutes (stall ${agentProc.stallCount}/${AgentManager.MAX_STALL_COUNT}). Send a message to attempt recovery.`,
            });
            // Notify idle listeners so stalled agents can receive queued messages
            this.notifyIdleListeners(id);
          }
        }
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
          logger.info("[agents] Truncated event file", { agentId: id, before: lines.length, after: trimmed.length });
        } catch (err: unknown) {
          logger.warn("[agents] Failed to truncate events", { agentId: id, error: errorMessage(err) });
        }
      });
      this.writeQueues.set(id, next);
    }
  }

  private buildClaudeArgs(opts: CreateAgentRequest, model: string, resumeSessionId?: string): string[] {
    const args: string[] = [];
    if (opts.dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    args.push(
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      String(opts.maxTurns ?? 200),
      "--model",
      model,
    );
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    args.push("--print", "--", opts.prompt);
    return args;
  }

  /** Save attachments to the agent workspace and return a prompt suffix referencing them.
   *  Delegates to WorkspaceManager. */
  saveAttachments(workspaceDir: string, attachments: PromptAttachment[]): string {
    return this.workspace.saveAttachments(workspaceDir, attachments);
  }

  /** Refresh auth token files for all active agents. Called periodically (every 60 min)
   *  to ensure tokens never expire (4h TTL). Delegates to WorkspaceManager. */
  refreshAllAgentTokens(): void {
    this.workspace.refreshAllAgentTokens(this.agents, this.killed);
  }
}
