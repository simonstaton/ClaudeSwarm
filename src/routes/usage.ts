import express, { type Request, type Response } from "express";
import type { AgentManager } from "../agents";

export function createUsageRouter(agentManager: AgentManager) {
  const router = express.Router();

  // Aggregate token usage and cost across all active agents
  router.get("/api/usage/summary", (_req: Request, res: Response) => {
    const { agents } = agentManager.getAllUsage();
    const totals = agents.reduce(
      (acc, { usage }) => {
        acc.tokensIn += usage.tokensIn;
        acc.tokensOut += usage.tokensOut;
        acc.estimatedCost += usage.estimatedCost;
        return acc;
      },
      { tokensIn: 0, tokensOut: 0, estimatedCost: 0 },
    );
    res.json({
      agents,
      totals: {
        tokensIn: totals.tokensIn,
        tokensOut: totals.tokensOut,
        tokensTotal: totals.tokensIn + totals.tokensOut,
        estimatedCost: Math.round(totals.estimatedCost * 1e6) / 1e6,
      },
    });
  });

  return router;
}
