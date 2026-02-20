import express, { type Request, type Response } from "express";
import type { AgentManager } from "../agents";
import type { CostTracker } from "../cost-tracker";
import type { AuthenticatedRequest } from "../types";

/**
 * Cost tracking route handler.
 *
 * Provides endpoints for tracking agent usage and costs.
 * Uses real token usage data from AgentManager for current session,
 * and CostTracker (SQLite) for persistent all-time history.
 */
export function createCostRouter(agentManager: AgentManager, costTracker?: CostTracker) {
  const router = express.Router();

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
      const tokensUsed = (agent.usage?.tokensIn ?? 0) + (agent.usage?.tokensOut ?? 0);
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

    const tokensUsed = (agent.usage?.tokensIn ?? 0) + (agent.usage?.tokensOut ?? 0);
    const estimatedCost = agent.usage?.estimatedCost ?? 0;

    res.json({
      agentId: agent.id,
      agentName: agent.name,
      tokensIn: agent.usage?.tokensIn ?? 0,
      tokensOut: agent.usage?.tokensOut ?? 0,
      tokensUsed,
      estimatedCost: Math.round(estimatedCost * 1e6) / 1e6,
      createdAt: agent.createdAt,
      status: agent.status,
    });
  });

  return router;
}
