import express, { type Request, type Response } from "express";
import { requireHumanUser } from "../auth";
import type { JobType, Scheduler } from "../scheduler";
import { errorMessage } from "../types";
import { param } from "../utils/express";

/**
 * Scheduler route handler.
 *
 * Provides CRUD endpoints for managing scheduled jobs (cron-based).
 * Agent-service tokens are blocked from creating or deleting jobs.
 */
export function createSchedulerRouter(scheduler: Scheduler) {
  const router = express.Router();

  /** GET /api/scheduler/jobs - List all scheduled jobs. */
  router.get("/api/scheduler/jobs", (_req: Request, res: Response) => {
    const jobs = scheduler.listAll();
    res.json({ jobs });
  });

  /** GET /api/scheduler/jobs/:id - Get a single scheduled job. */
  router.get("/api/scheduler/jobs/:id", (req: Request, res: Response) => {
    const job = scheduler.get(param(req.params.id));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
  });

  /** POST /api/scheduler/jobs - Create a new scheduled job. */
  router.post("/api/scheduler/jobs", requireHumanUser, (req: Request, res: Response) => {
    const { name, cronExpression, jobType, payload } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required (string)" });
      return;
    }
    if (name.length > 200) {
      res.status(400).json({ error: "name must be 200 characters or fewer" });
      return;
    }
    if (!cronExpression || typeof cronExpression !== "string") {
      res.status(400).json({ error: "cronExpression is required (string)" });
      return;
    }
    if (cronExpression.length > 100) {
      res.status(400).json({ error: "cronExpression must be 100 characters or fewer" });
      return;
    }
    if (!jobType || typeof jobType !== "string") {
      res.status(400).json({ error: "jobType is required (string)" });
      return;
    }
    if (payload !== undefined) {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        res.status(400).json({ error: "payload must be a JSON object" });
        return;
      }
      if (JSON.stringify(payload).length > 10_000) {
        res.status(400).json({ error: "payload must be 10,000 characters or fewer when serialized" });
        return;
      }
    }

    try {
      const job = scheduler.create({ name, cronExpression, jobType: jobType as JobType, payload });
      res.status(201).json(job);
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  /** DELETE /api/scheduler/jobs/:id - Delete a scheduled job. */
  router.delete("/api/scheduler/jobs/:id", requireHumanUser, (req: Request, res: Response) => {
    const deleted = scheduler.delete(param(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ deleted: true });
  });

  /** POST /api/scheduler/jobs/:id/pause - Pause a scheduled job. */
  router.post("/api/scheduler/jobs/:id/pause", (req: Request, res: Response) => {
    const job = scheduler.pause(param(req.params.id));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
  });

  /** POST /api/scheduler/jobs/:id/resume - Resume a paused job. */
  router.post("/api/scheduler/jobs/:id/resume", (req: Request, res: Response) => {
    const job = scheduler.resume(param(req.params.id));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
  });

  return router;
}
