import express from "express";
import type { AgentManager } from "../agents";
import { hasPersistentCache, isCacheReady } from "../dep-cache";
import { MAX_AGENTS } from "../guardrails";
import { getContainerMemoryUsage } from "../utils/memory";

/**
 * Health check route only. Auth (token exchange) lives in routes/auth.ts.
 */
export function createHealthRouter(agentManager: AgentManager, memoryLimitBytes: number, isRecovering: () => boolean) {
  const router = express.Router();

  router.get("/api/health", (_req, res) => {
    const agents = agentManager.list();
    const { rss, heapUsed, heapTotal } = process.memoryUsage();
    const containerBytes = getContainerMemoryUsage();
    const containerMB = Math.round(containerBytes / 1024 / 1024);
    res.json({
      status: isRecovering() ? "recovering" : "ok",
      timestamp: new Date().toISOString(),
      agents: agents.length,
      maxAgents: MAX_AGENTS,
      memory: {
        containerMB,
        rssMB: Math.round(rss / 1024 / 1024),
        heapUsedMB: Math.round(heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(heapTotal / 1024 / 1024),
        limitMB: Math.round(memoryLimitBytes / 1024 / 1024),
        pressurePct: Math.round((containerBytes / memoryLimitBytes) * 100),
      },
      depCache: {
        persistent: hasPersistentCache(),
        ready: isCacheReady(),
      },
    });
  });

  return router;
}
