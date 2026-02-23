import express, { type Request, type Response } from "express";
import { exchangeKeyForToken } from "../auth";

/**
 * Auth routes (no auth required). Mount before or alongside health so
 * /api/auth/token is exempt from kill-switch and recovery blocking.
 */
export function createAuthRouter() {
  const router = express.Router();

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
