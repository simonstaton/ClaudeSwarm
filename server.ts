import path from "node:path";
import express from "express";
import { AgentManager } from "./src/agents";
import { authMiddleware } from "./src/auth";
import { cleanupOrphanedProcesses, cleanupStaleWorkspaces } from "./src/cleanup";
import { corsMiddleware } from "./src/cors";
import { CostTracker } from "./src/cost-tracker";
import { initDepCache } from "./src/dep-cache";
import { isExemptFromKillAndRecovery } from "./src/exempt-paths";
import { GradeStore } from "./src/grading";
import { isKilled, loadPersistedState, startGcsKillSwitchPoll } from "./src/kill-switch";
import { logger } from "./src/logger";
import { attachMessageDelivery } from "./src/message-delivery";
import { MessageBus } from "./src/messages";
import { Orchestrator } from "./src/orchestrator";
import { cleanupStaleState, hasTombstone } from "./src/persistence";
import { createAgentsRouter } from "./src/routes/agents";
import { createAuthRouter } from "./src/routes/auth";
import { createConfigRouter } from "./src/routes/config";
import { createContextRouter } from "./src/routes/context";
import { createCostRouter } from "./src/routes/cost";
import { createHealthRouter } from "./src/routes/health";
import { createKillSwitchRouter } from "./src/routes/kill-switch";
import { createMcpRouter } from "./src/routes/mcp";
import { createMessagesRouter } from "./src/routes/messages";
import { createRepositoriesRouter } from "./src/routes/repositories";
import { createSchedulerRouter } from "./src/routes/scheduler";
import { createTasksRouter } from "./src/routes/tasks";
import { createUsageRouter } from "./src/routes/usage";
import { createWorkflowsRouter } from "./src/routes/workflows";
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
import { getContainerMemoryUsage } from "./src/utils/memory";
import { rateLimitMiddleware } from "./src/validation";
import { isAllowedWebhookUrl } from "./src/webhook-url";
import { startWorktreeGC } from "./src/worktrees";

let exceptionHandlersSetup = false;

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

// Agent routes accept file attachments - allow up to 10 MB for those endpoints.
// All other routes use a 1 MB cap to limit DoS surface area (issue #65).
app.use("/api/agents", express.json({ limit: "10mb" }));
app.use(express.json({ limit: "1mb" }));

// Checked BEFORE auth so even valid tokens get blocked when the switch is active.
app.use((req, res, next) => {
  if (!isKilled()) {
    next();
    return;
  }
  if (isExemptFromKillAndRecovery(req.path)) {
    next();
    return;
  }
  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }
  res.status(503).json({
    error: "Kill switch is active - all agent operations are disabled",
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
      logger.info(`[orchestrator] Sent ${taskMessage.type} to ${agentName}`, { agentId, taskId: taskMessage.taskId });
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

const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024 * 1024; // 32Gi - matches Cloud Run container limit
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
  logger.info("[keepalive] Starting - agents exist, keeping instance alive");
  fetch(`http://localhost:${KEEPALIVE_PORT}/api/health`).catch(() => {});
  keepAliveInterval = setInterval(async () => {
    if (agentManager.list().length === 0) {
      stopKeepAlive();
      return;
    }
    try {
      await fetch(`http://localhost:${KEEPALIVE_PORT}/api/health`);
    } catch (err) {
      logger.warn("[keepalive] Health check failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }, 60_000); // every 60 seconds - well within Cloud Run's ~15min idle timeout
}

function stopKeepAlive() {
  if (!keepAliveInterval) return;
  logger.info("[keepalive] Stopping - no agents, allowing scale-to-zero");
  clearInterval(keepAliveInterval);
  keepAliveInterval = null;
}

// ── Recovery state (set during startup while GCS sync + agent restore runs) ─
let recovering = true;

app.use(createHealthRouter(agentManager, MEMORY_LIMIT_BYTES, () => recovering));
app.use(createAuthRouter());

// Block non-essential API calls until background recovery (GCS sync + agent
// restoration) is complete.  Health and auth endpoints are exempt.
app.use((req, res, next) => {
  if (!recovering || !req.path.startsWith("/api/") || isExemptFromKillAndRecovery(req.path)) {
    next();
    return;
  }
  res.status(503).json({ error: "Server is starting up - restoring agents from previous session", recovering: true });
});

app.use(createAgentsRouter(agentManager, messageBus, startKeepAlive, stopKeepAlive, isMemoryPressure));
app.use(createMessagesRouter(messageBus));
app.use(createUsageRouter(agentManager));
app.use(createConfigRouter());
app.use(createContextRouter());
app.use(createMcpRouter());
app.use(createCostRouter(agentManager, costTracker, messageBus));
app.use(createTasksRouter(taskGraph, orchestrator, gradeStore));
app.use(createSchedulerRouter(scheduler));
app.use(createWorkflowsRouter(agentManager, messageBus));
app.use(createRepositoriesRouter(agentManager));
// Layer 1: Kill switch endpoint (no extra auth beyond authMiddleware above)
app.use(createKillSwitchRouter(agentManager));

// Auto-deliver messages to idle agents (and interrupt busy ones for "interrupt" type). See src/message-delivery.ts.
const deliverySettleMs = Number.parseInt(process.env.DELIVERY_SETTLE_MS ?? "250", 10);
attachMessageDelivery(messageBus, agentManager, { isKilled, deliverySettleMs });

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
  res.status(404);
  res.sendFile(path.join(uiDistPath, "404.html"), (err) => {
    if (err) {
      res.status(404).send("AgentManager API is running. Build the UI with: cd ui && npm run build");
    }
  });
});

const memoryMonitorInterval = setInterval(() => {
  const containerMem = getContainerMemoryUsage();
  const { heapUsed, heapTotal } = process.memoryUsage();
  const pct = containerMem / MEMORY_LIMIT_BYTES;
  if (pct > MEMORY_WARN_THRESHOLD) {
    const limitGi = MEMORY_LIMIT_BYTES / 1024 / 1024 / 1024;
    logger.warn("[memory] WARNING: container memory high", {
      containerMb: Math.round(containerMem / 1024 / 1024),
      limitGib: limitGi,
      usagePct: Number((pct * 100).toFixed(1)),
      heapUsedMb: Math.round(heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(heapTotal / 1024 / 1024),
      agentCount: agentManager.list().length,
    });
  }
}, 60_000);
memoryMonitorInterval.unref();

async function start() {
  const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

  // Start listening IMMEDIATELY so the startup probe passes while we recover.
  // GCS sync and agent restoration happen in the background.
  const server = app.listen(PORT, () => {
    logger.info(`AgentManager listening on :${PORT}`);
  });

  let tokenRefreshInterval: ReturnType<typeof setInterval>;
  let worktreeGCInterval: ReturnType<typeof setInterval>;
  let stopGcsPoll: () => void = () => {};

  const shutdown = async () => {
    logger.info("Shutting down...");
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

  // Set up uncaught exception and unhandled rejection handlers.
  // On first occurrence, log with full stack trace, attempt graceful shutdown, then exit.
  if (!exceptionHandlersSetup) {
    exceptionHandlersSetup = true;

    const handleFatalError = (source: string, detail: unknown) => {
      logger.error(`[FATAL] ${source} at ${new Date().toISOString()}`, {
        error: detail instanceof Error ? detail.message : String(detail),
        stack: detail instanceof Error ? detail.stack : undefined,
      });
      logger.error("[FATAL] Attempting graceful shutdown...");

      server.close(() => {
        logger.error("[FATAL] HTTP server closed");
      });

      try {
        agentManager.emergencyDestroyAll();
      } catch (destroyErr: unknown) {
        logger.error("[FATAL] Error during agent destruction", {
          error: destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
        });
      }

      setTimeout(() => {
        logger.error(`[FATAL] Exiting due to ${source.toLowerCase()}`);
        process.exit(1);
      }, 1000);
    };

    process.on("uncaughtException", (err) => {
      handleFatalError("Uncaught exception", err);
    });

    process.on("unhandledRejection", (reason) => {
      handleFatalError("Unhandled rejection", reason);
    });
  }

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
      logger.info("[kill-switch] Kill switch was active on startup - agent restoration skipped");
    }

    if (hasTombstone()) {
      logger.info("[kill-switch] Tombstone present - skipping all agent restoration");
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
      logger.info("[kill-switch] Remote activation via GCS - running emergency shutdown");
      agentManager.emergencyDestroyAll();
      const { rotateJwtSecret } = await import("./src/auth");
      rotateJwtSecret();
    });

    // Start the orchestrator's assignment loop
    orchestrator.start();

    // Wire scheduler execution context and start
    scheduler.setExecutionContext({
      sendWebhook: async (url, body) => {
        if (!isAllowedWebhookUrl(url)) {
          logger.warn("[scheduler] Webhook URL rejected (SSRF protection)", { url });
          return;
        }
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
          logger.warn("[scheduler] Cannot wake agent - no session", { agentId });
        }
      },
      checkHealth: async () => {
        const agents = agentManager.list();
        const errorCount = agents.filter((a) => a.status === "error").length;
        return { healthy: errorCount === 0, details: `${agents.length} agents, ${errorCount} in error state` };
      },
    });
    scheduler.start();

    logger.info("[startup] Recovery complete");
  } catch (err: unknown) {
    logger.error("[startup] Recovery failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    recovering = false;
  }
}

start().catch((err) => {
  logger.error("Failed to start", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
