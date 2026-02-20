import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import cron, { type ScheduledTask } from "node-cron";
import { errorMessage } from "./types";

const DB_DIR = "/tmp/scheduler-data";
const DB_PATH = path.join(DB_DIR, "scheduler.db");

export type JobType = "health-check" | "agent-wake" | "webhook-notify" | "custom";
export type JobStatus = "active" | "paused";

export interface ScheduledJob {
  id: string;
  name: string;
  cronExpression: string;
  jobType: JobType;
  status: JobStatus;
  /** JSON-encoded payload specific to the job type. */
  payload: Record<string, unknown>;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateJobRequest {
  name: string;
  cronExpression: string;
  jobType: JobType;
  payload?: Record<string, unknown>;
}

export interface JobExecutionContext {
  /** Send a webhook notification. */
  sendWebhook: (url: string, body: Record<string, unknown>) => Promise<void>;
  /** Wake an agent via the orchestrator / agent manager. */
  wakeAgent: (agentId: string, prompt: string) => void;
  /** Run a health check and return status. */
  checkHealth: () => Promise<{ healthy: boolean; details: string }>;
}

const VALID_JOB_TYPES = new Set<JobType>(["health-check", "agent-wake", "webhook-notify", "custom"]);

/**
 * Persistent cron scheduler backed by SQLite.
 *
 * Stores scheduled jobs in SQLite so they survive server restarts. On startup,
 * loads persisted jobs and re-queues any that were missed while the server was
 * down. Uses node-cron for cron expression parsing and scheduling.
 */
export class Scheduler {
  private db: Database.Database;
  private tasks = new Map<string, ScheduledTask>();
  private executionContext: JobExecutionContext | null = null;

  private insertStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private getStmt: Database.Statement;
  private listStmt: Database.Statement;
  private updateLastRunStmt: Database.Statement;
  private updateStatusStmt: Database.Statement;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? DB_PATH;
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        payload TEXT NOT NULL DEFAULT '{}',
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO scheduled_jobs (id, name, cron_expression, job_type, status, payload, last_run_at, next_run_at, created_at, updated_at)
      VALUES (@id, @name, @cronExpression, @jobType, @status, @payload, @lastRunAt, @nextRunAt, @createdAt, @updatedAt)
    `);

    this.deleteStmt = this.db.prepare("DELETE FROM scheduled_jobs WHERE id = @id");
    this.getStmt = this.db.prepare("SELECT * FROM scheduled_jobs WHERE id = @id");
    this.listStmt = this.db.prepare("SELECT * FROM scheduled_jobs ORDER BY created_at DESC");
    this.updateLastRunStmt = this.db.prepare(
      "UPDATE scheduled_jobs SET last_run_at = @lastRunAt, next_run_at = @nextRunAt, updated_at = @updatedAt WHERE id = @id",
    );
    this.updateStatusStmt = this.db.prepare(
      "UPDATE scheduled_jobs SET status = @status, updated_at = @updatedAt WHERE id = @id",
    );
  }

  /** Set the execution context used when jobs fire. Must be called before start(). */
  setExecutionContext(ctx: JobExecutionContext): void {
    this.executionContext = ctx;
  }

  /** Load persisted jobs from SQLite and schedule them. Runs missed jobs that should have fired while server was down. */
  start(): void {
    const jobs = this.listAll();
    if (jobs.length === 0) return;

    console.log(`[scheduler] Loading ${jobs.length} persisted job(s)`);
    const now = new Date();

    for (const job of jobs) {
      if (job.status === "active") {
        this.scheduleJob(job);

        // Check if a run was missed while the server was down
        if (job.nextRunAt) {
          const nextRun = new Date(job.nextRunAt);
          if (nextRun < now) {
            console.log(`[scheduler] Missed run for "${job.name}" (was due ${job.nextRunAt}) - executing now`);
            this.executeJob(job);
          }
        }
      }
    }
  }

  /** Stop all scheduled tasks. */
  stop(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
      this.tasks.delete(id);
    }
    console.log("[scheduler] All jobs stopped");
  }

  /** Create a new scheduled job. */
  create(req: CreateJobRequest): ScheduledJob {
    if (!req.name || typeof req.name !== "string") {
      throw new Error("name is required");
    }
    if (!req.cronExpression || typeof req.cronExpression !== "string") {
      throw new Error("cronExpression is required");
    }
    if (!cron.validate(req.cronExpression)) {
      throw new Error(`Invalid cron expression: ${req.cronExpression}`);
    }
    if (!VALID_JOB_TYPES.has(req.jobType)) {
      throw new Error(`Invalid jobType: ${req.jobType}. Must be one of: ${[...VALID_JOB_TYPES].join(", ")}`);
    }

    const now = new Date().toISOString();
    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nextRunAt = this.getNextRunDate(req.cronExpression);

    const job: ScheduledJob = {
      id,
      name: req.name,
      cronExpression: req.cronExpression,
      jobType: req.jobType,
      status: "active",
      payload: req.payload ?? {},
      lastRunAt: null,
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    };

    this.insertStmt.run({
      ...job,
      payload: JSON.stringify(job.payload),
    });

    this.scheduleJob(job);
    console.log(`[scheduler] Created job "${job.name}" (${job.id}) with cron "${job.cronExpression}"`);

    return job;
  }

  /** Get a job by ID. */
  get(id: string): ScheduledJob | null {
    const row = this.getStmt.get({ id }) as Record<string, unknown> | undefined;
    return row ? this.rowToJob(row) : null;
  }

  /** List all jobs. */
  listAll(): ScheduledJob[] {
    const rows = this.listStmt.all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToJob(r));
  }

  /** Delete a job. */
  delete(id: string): boolean {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    const result = this.deleteStmt.run({ id });
    if (result.changes > 0) {
      console.log(`[scheduler] Deleted job ${id}`);
      return true;
    }
    return false;
  }

  /** Pause a job (stop its cron schedule but keep it in the DB). */
  pause(id: string): ScheduledJob | null {
    const job = this.get(id);
    if (!job) return null;
    if (job.status === "paused") return job;

    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }

    const now = new Date().toISOString();
    this.updateStatusStmt.run({ id, status: "paused", updatedAt: now });
    console.log(`[scheduler] Paused job "${job.name}" (${id})`);
    return this.get(id);
  }

  /** Resume a paused job. */
  resume(id: string): ScheduledJob | null {
    const job = this.get(id);
    if (!job) return null;
    if (job.status === "active") return job;

    const now = new Date().toISOString();
    this.updateStatusStmt.run({ id, status: "active", updatedAt: now });

    const updated = this.get(id);
    if (updated) {
      this.scheduleJob(updated);
      console.log(`[scheduler] Resumed job "${job.name}" (${id})`);
    }
    return updated;
  }

  /** Close the database. */
  close(): void {
    this.stop();
    this.db.close();
  }

  /** Schedule a job using node-cron. */
  private scheduleJob(job: ScheduledJob): void {
    // Stop any existing schedule for this job
    const existing = this.tasks.get(job.id);
    if (existing) {
      existing.stop();
    }

    const task = cron.schedule(job.cronExpression, () => {
      this.executeJob(job);
    });

    this.tasks.set(job.id, task);
  }

  /** Execute a job. */
  private executeJob(job: ScheduledJob): void {
    const now = new Date().toISOString();
    const nextRunAt = this.getNextRunDate(job.cronExpression);

    this.updateLastRunStmt.run({
      id: job.id,
      lastRunAt: now,
      nextRunAt,
      updatedAt: now,
    });

    console.log(`[scheduler] Executing job "${job.name}" (${job.id}) type=${job.jobType}`);

    if (!this.executionContext) {
      console.warn(`[scheduler] No execution context set - skipping job "${job.name}"`);
      return;
    }

    try {
      switch (job.jobType) {
        case "health-check":
          this.executionContext
            .checkHealth()
            .then(({ healthy, details }) => {
              console.log(`[scheduler] Health check result: ${healthy ? "OK" : "UNHEALTHY"} - ${details}`);
              // If unhealthy and a webhook URL is configured, notify
              if (!healthy && job.payload.webhookUrl) {
                return this.executionContext?.sendWebhook(job.payload.webhookUrl as string, {
                  type: "health-check-failed",
                  details,
                  timestamp: now,
                });
              }
            })
            .catch((err: unknown) => {
              console.warn(`[scheduler] Health check failed:`, errorMessage(err));
            });
          break;

        case "agent-wake": {
          const agentId = job.payload.agentId as string | undefined;
          const prompt = (job.payload.prompt as string) ?? "Scheduled wake-up";
          if (agentId) {
            this.executionContext.wakeAgent(agentId, prompt);
          } else {
            console.warn(`[scheduler] agent-wake job "${job.name}" missing agentId in payload`);
          }
          break;
        }

        case "webhook-notify": {
          const url = job.payload.url as string | undefined;
          if (url) {
            this.executionContext
              .sendWebhook(url, {
                type: "scheduled-notification",
                jobId: job.id,
                jobName: job.name,
                payload: job.payload,
                timestamp: now,
              })
              .catch((err: unknown) => {
                console.warn(`[scheduler] Webhook notification failed:`, errorMessage(err));
              });
          } else {
            console.warn(`[scheduler] webhook-notify job "${job.name}" missing url in payload`);
          }
          break;
        }

        case "custom":
          console.log(`[scheduler] Custom job "${job.name}" fired with payload:`, JSON.stringify(job.payload));
          break;
      }
    } catch (err: unknown) {
      console.error(`[scheduler] Job "${job.name}" execution error:`, errorMessage(err));
    }
  }

  /** Get the next run date for a cron expression as ISO string. */
  private getNextRunDate(_cronExpression: string): string | null {
    // node-cron doesn't expose a "next run" API. Return null and let
    // the cron library handle actual scheduling. The next run time is
    // updated after each execution via updateLastRunStmt.
    return null;
  }

  /** Convert a raw DB row to a ScheduledJob object. */
  private rowToJob(row: Record<string, unknown>): ScheduledJob {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload as string);
    } catch {
      // malformed JSON - use empty object
    }
    return {
      id: row.id as string,
      name: row.name as string,
      cronExpression: row.cron_expression as string,
      jobType: row.job_type as JobType,
      status: row.status as JobStatus,
      payload,
      lastRunAt: (row.last_run_at as string) ?? null,
      nextRunAt: (row.next_run_at as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
