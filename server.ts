import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { AgentManager } from "./src/agents";
import { authMiddleware } from "./src/auth";
import { corsMiddleware } from "./src/cors";
import { CostTracker } from "./src/cost-tracker";
import { initDepCache } from "./src/dep-cache";
import { GradeStore } from "./src/grading";
import { isKilled, loadPersistedState, startGcsKillSwitchPoll } from "./src/kill-switch";
import { MessageBus } from "./src/messages";
import { Orchestrator } from "./src/orchestrator";
import { cleanupStaleState, hasTombstone } from "./src/persistence";
import { createAgentsRouter } from "./src/routes/agents";
import { createConfigRouter } from "./src/routes/config";
import { createContextRouter } from "./src/routes/context";
import { createCostRouter } from "./src/routes/cost";
import { createHealthRouter } from "./src/routes/health";
import { createKillSwitchRouter } from "./src/routes/kill-switch";
import { createMcpRouter } from "./src/routes/mcp";
import { createMessagesRouter } from "./src/routes/messages";
import { createSchedulerRouter } from "./src/routes/scheduler";
import { createTasksRouter } from "./src/routes/tasks";
import { createUsageRouter } from "./src/routes/usage";
import { Scheduler } from "./src/scheduler";
import {
  cleanupClaudeHome,
  ensureDefaultContextFiles,
  startPeriodicSync,
  stopPeriodicSync,
  syncFromGCS,
  syncToGCS,
} from "./src/storage";
import { TaskGraph } from "./src/task-graph";
import { getContextDir } from "./src/utils/context";
import { getContainerMemoryUsage } from "./src/utils/memory";
import { rateLimitMiddleware } from "./src/validation";
import { startWorktreeGC } from "./src/worktrees";

/** Format a message for auto-delivery to an agent. */
function formatDeliveryPrompt(header: string, content: string, replyToId: string): string {
  return `${header}\n<message-content>\n${content}\n</message-content>\n\n(Reply by sending a message back to agent ID: ${replyToId})`;
}

let uncaughtExceptionCount = 0;
const MAX_UNCAUGHT_EXCEPTIONS = 3;

process.on("uncaughtException", (err) => {
  uncaughtExceptionCount++;
  console.error(
    `[FATAL] Uncaught exception (${uncaughtExceptionCount}/${MAX_UNCAUGHT_EXCEPTIONS}) at ${new Date().toISOString()}:`,
    err.stack || err,
  );
  if (uncaughtExceptionCount >= MAX_UNCAUGHT_EXCEPTIONS) {
    console.error(`[FATAL] ${MAX_UNCAUGHT_EXCEPTIONS} uncaught exceptions reached — exiting to avoid corrupted state`);
    process.exit(1);
  }
});
process.on("unhandledRejection", (reason) => {
  console.error(`[FATAL] Unhandled rejection at ${new Date().toISOString()}:`, reason);
});

const app = express();

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self'",
      "img-src 'self' data: blob:",
    ].join("; "),
  );
  next();
});

app.use(corsMiddleware);

// Agent routes accept file attachments — allow up to 10 MB for those endpoints.
// All other routes use a 1 MB cap to limit DoS surface area (issue #65).
app.use("/api/agents", express.json({ limit: "10mb" }));
app.use(express.json({ limit: "1mb" }));

// Checked BEFORE auth so even valid tokens get blocked when the switch is active.
// Exempts: /api/kill-switch (to allow deactivation), /api/health, /api/auth/token.
app.use((req, res, next) => {
  if (!isKilled()) {
    next();
    return;
  }
  const exempt = ["/api/kill-switch", "/api/health", "/api/auth/token"];
  if (exempt.some((p) => req.path === p || req.path.startsWith(p))) {
    next();
    return;
  }
  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }
  res.status(503).json({
    error: "Kill switch is active — all agent operations are disabled",
    state: "killed",
  });
});

// Auth middleware for API routes
app.use(authMiddleware);
app.use(rateLimitMiddleware);

const messageBus = new MessageBus();
const costTracker = new CostTracker();
const agentManager = new AgentManager({ costTracker });
const taskGraph = new TaskGraph();
const scheduler = new Scheduler();
const gradeStore = new GradeStore();

const orchestrator = new Orchestrator(
  taskGraph,
  {
    getAvailableAgents: () =>
      agentManager.list().filter((a) => (a.status === "idle" || a.status === "restored") && a.claudeSessionId),
    getAgent: (id) => agentManager.get(id),
  },
  {
    sendTaskMessage: (agentId, taskMessage) => {
      const agent = agentManager.get(agentId);
      const agentName = agent?.name ?? agentId.slice(0, 8);
      messageBus.post({
        from: "orchestrator",
        fromName: "Orchestrator",
        to: agentId,
        type: "task",
        content: `[Task Assignment: ${taskMessage.taskId.slice(0, 8)}]\nType: ${taskMessage.type}\n${taskMessage.successCriteria ? `Acceptance Criteria: ${taskMessage.successCriteria}\n` : ""}${taskMessage.input ? `Input: ${JSON.stringify(taskMessage.input)}\n` : ""}${taskMessage.timeoutMs ? `Timeout: ${taskMessage.timeoutMs}ms` : ""}`,
        metadata: { taskMessage },
      });
      console.log(`[orchestrator] Sent ${taskMessage.type} to ${agentName} for task ${taskMessage.taskId.slice(0, 8)}`);
    },
    sendNotification: (agentId, content) => {
      messageBus.post({
        from: "orchestrator",
        fromName: "Orchestrator",
        to: agentId,
        type: "info",
        content,
      });
    },
  },
);

const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024 * 1024; // 32Gi — matches Cloud Run container limit
const MEMORY_WARN_THRESHOLD = 0.75;
const MEMORY_REJECT_THRESHOLD = 0.85;

/** Returns true when container memory exceeds the rejection threshold (85% of limit). */
function isMemoryPressure(): boolean {
  return getContainerMemoryUsage() > MEMORY_LIMIT_BYTES * MEMORY_REJECT_THRESHOLD;
}

// ── Instance keep-alive (prevents Cloud Run scale-to-zero while agents exist) ─
// Uses localhost to guarantee the request hits this container directly,
// avoiding issues with external URL routing through Cloud Run's load balancer.
const KEEPALIVE_PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  console.log("[keepalive] Starting — agents exist, keeping instance alive");
  fetch(`http://localhost:${KEEPALIVE_PORT}/api/health`).catch(() => {});
  keepAliveInterval = setInterval(async () => {
    if (agentManager.list().length === 0) {
      stopKeepAlive();
      return;
    }
    try {
      await fetch(`http://localhost:${KEEPALIVE_PORT}/api/health`);
    } catch (err) {
      console.warn("[keepalive] Health check failed:", err instanceof Error ? err.message : String(err));
    }
  }, 60_000); // every 60 seconds — well within Cloud Run's ~15min idle timeout
}

function stopKeepAlive() {
  if (!keepAliveInterval) return;
  console.log("[keepalive] Stopping — no agents, allowing scale-to-zero");
  clearInterval(keepAliveInterval);
  keepAliveInterval = null;
}

// ── Recovery state (set during startup while GCS sync + agent restore runs) ─
let recovering = true;

app.use(createHealthRouter(agentManager, MEMORY_LIMIT_BYTES, () => recovering));

// Block non-essential API calls until background recovery (GCS sync + agent
// restoration) is complete.  Health and auth endpoints are exempt.
app.use((req, res, next) => {
  if (!recovering || !req.path.startsWith("/api/") || req.path === "/api/health" || req.path === "/api/auth/token") {
    next();
    return;
  }
  res.status(503).json({ error: "Server is starting up — restoring agents from previous session", recovering: true });
});

app.use(createAgentsRouter(agentManager, messageBus, startKeepAlive, stopKeepAlive, isMemoryPressure));
app.use(createMessagesRouter(messageBus));
app.use(createUsageRouter(agentManager));
app.use(createConfigRouter());
app.use(createContextRouter());
app.use(createMcpRouter());
app.use(createCostRouter(agentManager, costTracker));
app.use(createTasksRouter(taskGraph, orchestrator, gradeStore));
app.use(createSchedulerRouter(scheduler));
// Layer 1: Kill switch endpoint (no extra auth beyond authMiddleware above)
app.use(createKillSwitchRouter(agentManager));

// When a message targets a specific agent that is idle, automatically resume
// the agent with the message content so it can respond. Without this, agents
// only see messages if they happen to poll — which they rarely do.
messageBus.subscribe((msg) => {
  // Only deliver targeted messages (not broadcasts) of actionable types
  if (!msg.to) return;
  if (msg.type === "status") return;

  // Don't deliver if kill switch is active
  if (isKilled()) return;

  const sender = msg.fromName || msg.from.slice(0, 8);

  // Interrupt messages bypass the idle check — they kill the running process
  // and deliver immediately. This allows a team lead (or the platform) to
  // redirect a busy agent without waiting for it to finish.
  if (msg.type === "interrupt" && agentManager.canInterrupt(msg.to)) {
    const prompt = formatDeliveryPrompt(
      `[INTERRUPT from ${sender}] ⚠️ Your current task has been interrupted. Read and act on this message immediately:`,
      msg.content,
      msg.from,
    );

    try {
      messageBus.markRead(msg.id, msg.to);
      console.log(`[auto-deliver] INTERRUPTING busy agent ${msg.to.slice(0, 8)} with message from ${sender}`);
      agentManager.message(msg.to, prompt);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[auto-deliver] Failed to interrupt agent ${msg.to.slice(0, 8)}: ${errMsg}`);
    }
    return;
  }

  // Don't deliver if the target agent can't receive right now.
  // canDeliver() atomically sets a delivery lock when returning true.
  if (!agentManager.canDeliver(msg.to)) return;

  const prompt = formatDeliveryPrompt(`[Message from ${sender} — type: ${msg.type}]`, msg.content, msg.from);

  try {
    // Mark as read before delivering so the idle handler doesn't re-deliver it
    messageBus.markRead(msg.id, msg.to);
    console.log(`[auto-deliver] Delivering ${msg.type} from ${sender} to agent ${msg.to.slice(0, 8)}`);
    agentManager.message(msg.to, prompt);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[auto-deliver] Failed to deliver message to ${msg.to.slice(0, 8)}: ${errMsg}`);
  } finally {
    agentManager.deliveryDone(msg.to);
  }
});

// How long to wait after an agent goes idle before delivering queued messages.
// The delay lets the agent process fully exit before a new prompt is injected.
// Configurable via DELIVERY_SETTLE_MS env var (default: 250ms).
const DELIVERY_SETTLE_MS = Number.parseInt(process.env.DELIVERY_SETTLE_MS ?? "250", 10);

// When an agent finishes and goes idle, check if there are unread messages
// waiting for it and deliver the oldest one. This handles messages that arrived
// while the agent was busy.
agentManager.onIdle((agentId) => {
  setTimeout(() => {
    // Skip delivery if kill switch is active
    if (isKilled()) return;

    // canDeliver() atomically sets a delivery lock when returning true,
    // preventing concurrent onIdle + subscribe deliveries from racing.
    if (!agentManager.canDeliver(agentId)) return;

    const agent = agentManager.get(agentId);
    const pending = messageBus.query({
      to: agentId,
      unreadBy: agentId,
      agentRole: agent?.role,
    });

    // Find the oldest actionable message (skip status messages)
    const next = pending.find((m) => m.type !== "status");
    if (!next) {
      agentManager.deliveryDone(agentId);
      return;
    }

    // Mark it as read so we don't re-deliver
    messageBus.markRead(next.id, agentId);

    const sender = next.fromName || next.from.slice(0, 8);
    const prompt = formatDeliveryPrompt(`[Message from ${sender} — type: ${next.type}]`, next.content, next.from);

    try {
      console.log(
        `[auto-deliver] Delivering queued ${next.type} from ${sender} to now-idle agent ${agentId.slice(0, 8)}`,
      );
      agentManager.message(agentId, prompt);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[auto-deliver] Failed to deliver queued message to ${agentId.slice(0, 8)}: ${errMsg}`);
    } finally {
      agentManager.deliveryDone(agentId);
    }
  }, DELIVERY_SETTLE_MS);
});

const uiDistPath = path.join(__dirname, "ui", "dist");
app.use(express.static(uiDistPath));

// Dynamic agent routes: serve the pre-rendered agent shell for any /agents/:id path.
// The static export only contains /agents/_/ (placeholder param); the client-side
// component reads the real ID from window.location.pathname at runtime.
app.get("/agents/:id/index.txt", (_req, res, next) => {
  res.type("text/plain");
  res.sendFile(path.join(uiDistPath, "agents", "_", "index.txt"), (err) => {
    if (err) next();
  });
});
app.get("/agents/:id{/*rest}", (_req, res, next) => {
  res.sendFile(path.join(uiDistPath, "agents", "_", "index.html"), (err) => {
    if (err) next();
  });
});

// Fallback: serve 404.html for unknown routes (Next.js generates this).
// Falls back to a plain text message if UI isn't built yet.
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(uiDistPath, "404.html"), (err) => {
    if (err) {
      res.status(200).send("ClaudeSwarm API is running. Build the UI with: cd ui && npm run build");
    }
  });
});

const memoryMonitorInterval = setInterval(() => {
  const containerMem = getContainerMemoryUsage();
  const { heapUsed, heapTotal } = process.memoryUsage();
  const pct = containerMem / MEMORY_LIMIT_BYTES;
  if (pct > MEMORY_WARN_THRESHOLD) {
    const limitGi = MEMORY_LIMIT_BYTES / 1024 / 1024 / 1024;
    console.warn(
      `[memory] WARNING: container ${(containerMem / 1024 / 1024).toFixed(0)}MB (${(pct * 100).toFixed(1)}% of ${limitGi}Gi limit) — ` +
        `heap ${(heapUsed / 1024 / 1024).toFixed(0)}/${(heapTotal / 1024 / 1024).toFixed(0)}MB — ` +
        `agents: ${agentManager.list().length}`,
    );
  }
}, 60_000);
memoryMonitorInterval.unref();

/** Kill orphaned `claude` processes left over from a previous container run.
 *  After a non-graceful restart, child processes may still be running under
 *  the same PID namespace (Cloud Run reuses the sandbox). We kill any `claude`
 *  processes that aren't children of the current server process. */
function cleanupOrphanedProcesses(): void {
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
      const [, pidStr, ppidStr, comm] = match;
      const pid = Number.parseInt(pidStr, 10);
      const ppid = Number.parseInt(ppidStr, 10);
      // Kill claude processes that are NOT children of the current server
      if (comm.trim() === "claude" && ppid !== myPid && pid !== myPid) {
        try {
          process.kill(pid, "SIGTERM");
          killed++;
        } catch {
          // Process may have already exited
        }
      }
    }
    if (killed > 0) {
      console.log(`[cleanup] Killed ${killed} orphaned claude process(es)`);
    }
  } catch {
    // ps not available or failed — skip
  }
}

/** Remove stale /tmp/workspace-* directories that don't belong to any restored agent,
 *  and clean up orphaned working-memory files in shared-context. */
function cleanupStaleWorkspaces(manager: AgentManager): void {
  // Clean stale workspace directories
  try {
    const activeWorkspaces = manager.getActiveWorkspaceDirs();
    const entries = fs.readdirSync("/tmp").filter((f) => f.startsWith("workspace-"));
    let cleaned = 0;
    for (const entry of entries) {
      const fullPath = `/tmp/${entry}`;
      if (!activeWorkspaces.has(fullPath)) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          cleaned++;
        } catch {}
      }
    }
    if (cleaned > 0) {
      console.log(`[cleanup] Removed ${cleaned} stale workspace director${cleaned === 1 ? "y" : "ies"}`);
    }
  } catch {
    // /tmp not readable — skip
  }

  // Clean orphaned working-memory files from shared-context
  const contextDir = getContextDir();
  try {
    const activeNames = new Set(manager.list().map((a) => a.name));
    const wmFiles = fs.readdirSync(contextDir).filter((f) => f.startsWith("working-memory-") && f.endsWith(".md"));
    let cleanedWm = 0;
    for (const file of wmFiles) {
      const agentName = file.replace("working-memory-", "").replace(".md", "");
      if (!activeNames.has(agentName)) {
        try {
          fs.unlinkSync(path.join(contextDir, file));
          cleanedWm++;
        } catch {}
      }
    }
    if (cleanedWm > 0) {
      console.log(`[cleanup] Removed ${cleanedWm} orphaned working-memory file(s)`);
    }
  } catch {
    // shared-context not readable — skip
  }
}

async function start() {
  const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

  // Start listening IMMEDIATELY so the startup probe passes while we recover.
  // GCS sync and agent restoration happen in the background.
  const server = app.listen(PORT, () => {
    console.log(`ClaudeSwarm listening on :${PORT}`);
  });

  let tokenRefreshInterval: ReturnType<typeof setInterval>;
  let worktreeGCInterval: ReturnType<typeof setInterval>;
  let stopGcsPoll: () => void = () => {};

  const shutdown = async () => {
    console.log("Shutting down...");
    stopGcsPoll();
    clearInterval(tokenRefreshInterval);
    clearInterval(worktreeGCInterval);
    clearInterval(memoryMonitorInterval);
    orchestrator.stop();
    agentManager.dispose();
    costTracker.close();
    taskGraph.close();
    scheduler.close();
    stopPeriodicSync();
    await syncToGCS();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ── Background recovery (runs while server is already accepting requests) ──
  try {
    await syncFromGCS();
    ensureDefaultContextFiles();
    startPeriodicSync();

    const wasKilled = await loadPersistedState();
    if (wasKilled) {
      agentManager.killed = true;
      console.log("[kill-switch] Kill switch was active on startup — agent restoration skipped");
    }

    if (hasTombstone()) {
      console.log("[kill-switch] Tombstone present — skipping all agent restoration");
    }

    cleanupStaleState();
    cleanupOrphanedProcesses();
    initDepCache();

    agentManager.restoreAgents();
    cleanupStaleWorkspaces(agentManager);

    // Prune stale Claude Code session data (projects, todos, etc.) for
    // workspaces that no longer exist, then delete them from GCS so they
    // are not re-downloaded on the next cold start.
    await cleanupClaudeHome(agentManager.getActiveWorkspaceDirs());
    if (agentManager.list().length > 0) {
      startKeepAlive();
    }

    const { ensureTokenDir } = await import("./src/mcp-oauth-storage");
    ensureTokenDir();

    tokenRefreshInterval = setInterval(() => {
      if (!isKilled()) {
        agentManager.refreshAllAgentTokens();
      }
    }, 60 * 60_000);
    tokenRefreshInterval.unref();

    worktreeGCInterval = startWorktreeGC(() => agentManager.getActiveWorkspaceDirs());

    stopGcsPoll = startGcsKillSwitchPoll(async () => {
      console.log("[kill-switch] Remote activation via GCS — running emergency shutdown");
      agentManager.emergencyDestroyAll();
      const { rotateJwtSecret } = await import("./src/auth");
      rotateJwtSecret();
    });

    // Start the orchestrator's assignment loop
    orchestrator.start();

    // Wire scheduler execution context and start
    scheduler.setExecutionContext({
      sendWebhook: async (url, body) => {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      },
      wakeAgent: (agentId, prompt) => {
        const agent = agentManager.get(agentId);
        if (agent?.claudeSessionId) {
          agentManager.message(agentId, prompt);
        } else {
          console.warn(`[scheduler] Cannot wake agent ${agentId.slice(0, 8)} - no session`);
        }
      },
      checkHealth: async () => {
        const agents = agentManager.list();
        const errorCount = agents.filter((a) => a.status === "error").length;
        return { healthy: errorCount === 0, details: `${agents.length} agents, ${errorCount} in error state` };
      },
    });
    scheduler.start();

    console.log("[startup] Recovery complete");
  } catch (err: unknown) {
    console.error("[startup] Recovery failed:", err instanceof Error ? err.message : String(err));
  } finally {
    recovering = false;
  }
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
