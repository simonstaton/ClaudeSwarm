import express, { type Request, type Response } from "express";
import type { AgentManager } from "../agents";
import { exchangeKeyForToken } from "../auth";
import { MAX_AGENTS } from "../guardrails";
import { getContainerMemoryUsage } from "../utils/memory";

export function createHealthRouter(agentManager: AgentManager, memoryLimitBytes: number, isRecovering: () => boolean) {
  const router = express.Router();

  // Health check — always returns 200 so the startup probe passes during recovery
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
    });
  });

  // Auth: exchange API key for JWT
  router.post("/api/auth/token", (req: Request, res: Response) => {
    const { apiKey } = req.body ?? {};
    if (!apiKey || typeof apiKey !== "string") {
      res.status(400).json({ error: "apiKey is required" });
      return;
    }

    const token = exchangeKeyForToken(apiKey);
    if (!token) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }

    res.json({ token });
  });

  return router;
}
