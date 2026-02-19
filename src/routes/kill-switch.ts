import { Router } from "express";
import type { AgentManager } from "../agents";
import { rotateJwtSecret } from "../auth";
import { activate, deactivate, getKillSwitchState } from "../kill-switch";
import { clearTombstone } from "../persistence";
import type { AuthenticatedRequest } from "../types";

export function createKillSwitchRouter(agentManager: AgentManager): Router {
  const router = Router();

  /** GET /api/kill-switch — returns current kill switch status */
  router.get("/api/kill-switch", (_req, res) => {
    res.json(getKillSwitchState());
  });

  /**
   * POST /api/kill-switch
   * Body: { action: "activate" | "deactivate", reason?: string }
   *
   * Only human users (JWT sub === "user") can activate/deactivate.
   * Agent service tokens (sub === "agent-service") are rejected.
   */
  router.post("/api/kill-switch", async (req, res) => {
    const user = (req as AuthenticatedRequest).user;

    // Only human users may operate the kill switch
    if (!user || user.sub === "agent-service") {
      res.status(403).json({ error: "Kill switch can only be operated by human users, not agent service tokens" });
      return;
    }

    const { action, reason } = req.body ?? {};

    if (action === "activate") {
      // Activate: set flag, destroy all agents, rotate JWT, write tombstone
      await activate(reason || "Manual activation via API");

      // Layer 2: Nuclear process kill — emergencyDestroyAll sets killed flag,
      // SIGKILLs all processes, deletes state, writes tombstone
      agentManager.emergencyDestroyAll();

      // Layer 3: Rotate JWT secret — all existing tokens (including agent service
      // tokens) are immediately invalidated
      rotateJwtSecret();

      console.log("[kill-switch] Activation sequence complete");
      res.json({ ok: true, state: getKillSwitchState() });
    } else if (action === "deactivate") {
      // Deactivate: clear flag, clear tombstone, rotate JWT so human must re-authenticate
      await deactivate();
      clearTombstone();

      // Rotate JWT on deactivation too — human must log in again with the API key.
      // This ensures the session that activated the kill switch can't silently
      // continue as if nothing happened.
      rotateJwtSecret();

      console.log("[kill-switch] Deactivation complete — JWT rotated, please re-authenticate");
      res.json({ ok: true, state: getKillSwitchState() });
    } else {
      res.status(400).json({ error: 'action must be "activate" or "deactivate"' });
    }
  });

  return router;
}
