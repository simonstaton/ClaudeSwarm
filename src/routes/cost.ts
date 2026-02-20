import express, { type Request, type Response } from "express";
import type { AgentManager } from "../agents";
import type { CostTracker } from "../cost-tracker";
import { logger } from "../logger";
import type { MessageBus } from "../messages";
import type { AuthenticatedRequest } from "../types";

/**
 * Cost tracking route handler.
 *
 * Provides endpoints for tracking agent usage and costs.
 * Uses real token usage data from AgentManager for current session,
 * and CostTracker (SQLite) for persistent all-time history.
 */
export function createCostRouter(agentManager: AgentManager, costTracker?: CostTracker, messageBus?: MessageBus) {
  const router = express.Router();

  // Debounce flag to prevent race conditions on auto-kill
  let lastAutoKillTime = 0;
  const AUTO_KILL_DEBOUNCE_MS = 10000; // 10 seconds

  /**
   * GET /api/cost/summary
   * Returns aggregated cost and usage summary across all agents,
   * plus all-time totals from persistent storage.
   */
  router.get("/api/cost/summary", (_req: Request, res: Response) => {
    const agents = agentManager.list();
    let totalTokens = 0;
    let totalCost = 0;

    const agentCosts = agents.map((agent) => {
      // Use cumulative billing tokens (totalTokensSpent) so cost data survives context clears.
      // Falls back to session tokens for agents that predate the cumulative tracking.
      const tokensUsed = agent.usage?.totalTokensSpent ?? (agent.usage?.tokensIn ?? 0) + (agent.usage?.tokensOut ?? 0);
      const estimatedCost = agent.usage?.estimatedCost ?? 0;

      totalTokens += tokensUsed;
      totalCost += estimatedCost;

      return {
        agentId: agent.id,
        agentName: agent.name,
        tokensUsed,
        estimatedCost,
        createdAt: agent.createdAt,
        status: agent.status,
      };
    });

    const allTime = costTracker
      ? costTracker.getSummary()
      : { allTimeCost: 0, allTimeTokensIn: 0, allTimeTokensOut: 0, totalRecords: 0 };

    const spendLimit = costTracker ? costTracker.getSpendLimit() : null;

    // Auto-kill all agents if spend limit is exceeded
    // Use epsilon for floating point comparison to avoid precision issues
    const EPSILON = 0.005; // $0.005 tolerance
    const now = Date.now();
    if (spendLimit !== null && allTime.allTimeCost >= spendLimit - EPSILON) {
      const activeAgents = agentManager.list();
      // Debounce: only kill if we haven't killed recently
      if (activeAgents.length > 0 && now - lastAutoKillTime > AUTO_KILL_DEBOUNCE_MS) {
        lastAutoKillTime = now;
        logger.warn("[cost] Spend limit exceeded — destroying all agents", {
          limit: spendLimit,
          allTimeCost: allTime.allTimeCost,
          agentCount: activeAgents.length,
        });

        // Broadcast system message to notify users
        if (messageBus) {
          messageBus.post({
            from: "system",
            fromName: "Cost Tracker",
            type: "interrupt",
            content: `Spend limit of $${spendLimit.toFixed(2)} exceeded ($${allTime.allTimeCost.toFixed(4)} spent). All agents have been automatically stopped.`,
            metadata: {
              reason: "spend_limit_exceeded",
              limit: spendLimit,
              totalCost: allTime.allTimeCost,
              agentsKilled: activeAgents.length,
            },
          });
        }

        for (const agent of activeAgents) {
          try {
            agentManager.destroy(agent.id);
          } catch (err: unknown) {
            logger.warn("[cost] Failed to destroy agent on spend limit", { agentId: agent.id, error: String(err) });
          }
        }
      }
    }

    res.json({
      totalTokens,
      totalCost: Math.round(totalCost * 1e6) / 1e6,
      agentCount: agents.length,
      agents: agentCosts,
      allTime: {
        totalCost: Math.round(allTime.allTimeCost * 1e6) / 1e6,
        totalTokensIn: allTime.allTimeTokensIn,
        totalTokensOut: allTime.allTimeTokensOut,
        totalRecords: allTime.totalRecords,
      },
      spendLimit,
      spendLimitExceeded: spendLimit !== null && allTime.allTimeCost >= spendLimit - EPSILON,
    });
  });

  /**
   * GET /api/cost/history
   * Returns persistent cost records from SQLite (survives restarts).
   */
  router.get("/api/cost/history", (req: Request, res: Response) => {
    if (!costTracker) {
      res.json({ records: [], summary: { allTimeCost: 0, allTimeTokensIn: 0, allTimeTokensOut: 0, totalRecords: 0 } });
      return;
    }
    const limit = Math.min(Number.parseInt(req.query.limit as string, 10) || 500, 1000);
    const records = costTracker.getAll(limit);
    const summary = costTracker.getSummary();
    res.json({ records, summary });
  });

  /**
   * DELETE /api/cost/history
   * Resets all persistent cost records.
   */
  router.delete("/api/cost/history", (req: Request, res: Response) => {
    // Agents must not be able to wipe cost history
    if ((req as AuthenticatedRequest).user?.sub === "agent-service") {
      res.status(403).json({ error: "Agent service tokens cannot delete cost history" });
      return;
    }
    if (!costTracker) {
      res.json({ ok: true, deleted: 0 });
      return;
    }
    const result = costTracker.reset();
    agentManager.resetAllUsage();
    res.json({ ok: true, deleted: result.deleted });
  });

  /**
   * GET /api/cost/limit
   * Returns the current spend limit (null = no limit).
   */
  router.get("/api/cost/limit", (_req: Request, res: Response) => {
    const limit = costTracker ? costTracker.getSpendLimit() : null;
    res.json({ spendLimit: limit });
  });

  /**
   * PUT /api/cost/limit
   * Sets or clears the spend limit.
   * Body: { spendLimit: number | null }
   */
  router.put("/api/cost/limit", (req: Request, res: Response) => {
    if ((req as AuthenticatedRequest).user?.sub === "agent-service") {
      res.status(403).json({ error: "Agent service tokens cannot modify spend limits" });
      return;
    }
    if (!costTracker) {
      res.status(503).json({ error: "Cost tracker not available" });
      return;
    }
    const { spendLimit } = req.body as { spendLimit?: unknown };
    if (spendLimit !== null && spendLimit !== undefined && (typeof spendLimit !== "number" || spendLimit <= 0)) {
      res.status(400).json({ error: "spendLimit must be a positive number or null" });
      return;
    }
    costTracker.setSpendLimit(spendLimit == null ? null : (spendLimit as number));
    res.json({ ok: true, spendLimit: spendLimit ?? null });
  });

  /**
   * GET /api/cost/agent/:agentId
   * Returns cost details for a specific agent.
   */
  router.get("/api/cost/agent/:agentId", (req: Request, res: Response) => {
    const { agentId } = req.params;
    const agent = agentManager.list().find((a) => a.id === agentId);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const tokensUsed = agent.usage?.totalTokensSpent ?? (agent.usage?.tokensIn ?? 0) + (agent.usage?.tokensOut ?? 0);
    const estimatedCost = agent.usage?.estimatedCost ?? 0;

    res.json({
      agentId: agent.id,
      agentName: agent.name,
      tokensIn: agent.usage?.totalTokensIn ?? agent.usage?.tokensIn ?? 0,
      tokensOut: agent.usage?.totalTokensOut ?? agent.usage?.tokensOut ?? 0,
      tokensUsed,
      estimatedCost: Math.round(estimatedCost * 1e6) / 1e6,
      createdAt: agent.createdAt,
      status: agent.status,
    });
  });

  return router;
}
