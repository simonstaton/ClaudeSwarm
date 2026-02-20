import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobExecutionContext } from "./scheduler";
import { Scheduler } from "./scheduler";

const TEST_DB_DIR = "/tmp/scheduler-test";
let dbCounter = 0;

function freshDbPath(): string {
  dbCounter++;
  return path.join(TEST_DB_DIR, `test-${Date.now()}-${dbCounter}.db`);
}

describe("Scheduler", () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    mkdirSync(TEST_DB_DIR, { recursive: true });
    scheduler = new Scheduler(freshDbPath());
  });

  afterEach(() => {
    scheduler.close();
  });

  describe("create()", () => {
    it("creates a job with valid cron expression", () => {
      const job = scheduler.create({
        name: "test-job",
        cronExpression: "* * * * *",
        jobType: "custom",
      });

      expect(job.id).toMatch(/^job-/);
      expect(job.name).toBe("test-job");
      expect(job.cronExpression).toBe("* * * * *");
      expect(job.jobType).toBe("custom");
      expect(job.status).toBe("active");
      expect(job.payload).toEqual({});
      expect(job.lastRunAt).toBeNull();
      expect(job.createdAt).toBeTruthy();
      expect(job.updatedAt).toBeTruthy();
    });

    it("creates a job with payload", () => {
      const job = scheduler.create({
        name: "webhook-job",
        cronExpression: "0 9 * * *",
        jobType: "webhook-notify",
        payload: { url: "https://example.com/webhook", channel: "#alerts" },
      });

      expect(job.payload).toEqual({ url: "https://example.com/webhook", channel: "#alerts" });
    });

    it("rejects invalid cron expression", () => {
      expect(() =>
        scheduler.create({
          name: "bad-cron",
          cronExpression: "not-a-cron",
          jobType: "custom",
        }),
      ).toThrow("Invalid cron expression");
    });

    it("rejects invalid job type", () => {
      expect(() =>
        scheduler.create({
          name: "bad-type",
          cronExpression: "* * * * *",
          jobType: "invalid" as "custom",
        }),
      ).toThrow("Invalid jobType");
    });

    it("rejects missing name", () => {
      expect(() =>
        scheduler.create({
          name: "",
          cronExpression: "* * * * *",
          jobType: "custom",
        }),
      ).toThrow("name is required");
    });
  });

  describe("get()", () => {
    it("returns a job by ID", () => {
      const created = scheduler.create({
        name: "findable",
        cronExpression: "*/5 * * * *",
        jobType: "health-check",
      });

      const found = scheduler.get(created.id);
      expect(found).not.toBeNull();
      expect(found?.name).toBe("findable");
      expect(found?.jobType).toBe("health-check");
    });

    it("returns null for unknown ID", () => {
      expect(scheduler.get("nonexistent")).toBeNull();
    });
  });

  describe("listAll()", () => {
    it("returns all jobs", () => {
      scheduler.create({ name: "job-1", cronExpression: "* * * * *", jobType: "custom" });
      scheduler.create({ name: "job-2", cronExpression: "0 * * * *", jobType: "health-check" });

      const jobs = scheduler.listAll();
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.name).sort()).toEqual(["job-1", "job-2"]);
    });

    it("returns empty array when no jobs", () => {
      expect(scheduler.listAll()).toEqual([]);
    });
  });

  describe("delete()", () => {
    it("deletes an existing job", () => {
      const job = scheduler.create({ name: "delete-me", cronExpression: "* * * * *", jobType: "custom" });
      expect(scheduler.delete(job.id)).toBe(true);
      expect(scheduler.get(job.id)).toBeNull();
    });

    it("returns false for unknown ID", () => {
      expect(scheduler.delete("nonexistent")).toBe(false);
    });
  });

  describe("pause() and resume()", () => {
    it("pauses an active job", () => {
      const job = scheduler.create({ name: "pausable", cronExpression: "* * * * *", jobType: "custom" });
      const paused = scheduler.pause(job.id);
      expect(paused).not.toBeNull();
      expect(paused?.status).toBe("paused");
    });

    it("resumes a paused job", () => {
      const job = scheduler.create({ name: "resumable", cronExpression: "* * * * *", jobType: "custom" });
      scheduler.pause(job.id);
      const resumed = scheduler.resume(job.id);
      expect(resumed).not.toBeNull();
      expect(resumed?.status).toBe("active");
    });

    it("pause returns null for unknown ID", () => {
      expect(scheduler.pause("nonexistent")).toBeNull();
    });

    it("resume returns null for unknown ID", () => {
      expect(scheduler.resume("nonexistent")).toBeNull();
    });

    it("pausing an already paused job returns current state", () => {
      const job = scheduler.create({ name: "double-pause", cronExpression: "* * * * *", jobType: "custom" });
      scheduler.pause(job.id);
      const paused = scheduler.pause(job.id);
      expect(paused?.status).toBe("paused");
    });

    it("resuming an already active job returns current state", () => {
      const job = scheduler.create({ name: "double-resume", cronExpression: "* * * * *", jobType: "custom" });
      const resumed = scheduler.resume(job.id);
      expect(resumed?.status).toBe("active");
    });
  });

  describe("persistence", () => {
    it("persists jobs across scheduler instances", () => {
      const dbPath = freshDbPath();
      const sched1 = new Scheduler(dbPath);
      sched1.create({ name: "persistent-job", cronExpression: "0 0 * * *", jobType: "custom" });
      sched1.close();

      const sched2 = new Scheduler(dbPath);
      const jobs = sched2.listAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe("persistent-job");
      sched2.close();
    });
  });

  describe("start() - re-queue on restart", () => {
    it("loads persisted active jobs on start", () => {
      const dbPath = freshDbPath();
      const sched1 = new Scheduler(dbPath);
      sched1.create({ name: "startup-job", cronExpression: "0 0 * * *", jobType: "health-check" });
      sched1.close();

      const sched2 = new Scheduler(dbPath);
      // start() should load and schedule the persisted job without error
      sched2.start();
      const jobs = sched2.listAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe("startup-job");
      expect(jobs[0].status).toBe("active");
      sched2.close();
    });

    it("does not schedule paused jobs on start", () => {
      const dbPath = freshDbPath();
      const sched1 = new Scheduler(dbPath);
      const job = sched1.create({ name: "paused-job", cronExpression: "0 0 * * *", jobType: "custom" });
      sched1.pause(job.id);
      sched1.close();

      const sched2 = new Scheduler(dbPath);
      sched2.start();
      const jobs = sched2.listAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("paused");
      sched2.close();
    });
  });

  describe("execution context", () => {
    it("executes agent-wake jobs via context", () => {
      const wakeAgent = vi.fn();
      const ctx: JobExecutionContext = {
        sendWebhook: vi.fn(),
        wakeAgent,
        checkHealth: vi.fn().mockResolvedValue({ healthy: true, details: "ok" }),
      };

      scheduler.setExecutionContext(ctx);
      const job = scheduler.create({
        name: "wake-test",
        cronExpression: "* * * * *",
        jobType: "agent-wake",
        payload: { agentId: "test-agent-123", prompt: "Time to wake up" },
      });

      // Trigger execution by accessing the private method via any
      // biome-ignore lint/suspicious/noExplicitAny: test helper
      (scheduler as any).executeJob(job);

      expect(wakeAgent).toHaveBeenCalledWith("test-agent-123", "Time to wake up");
    });

    it("executes webhook-notify jobs via context", async () => {
      const sendWebhook = vi.fn().mockResolvedValue(undefined);
      const ctx: JobExecutionContext = {
        sendWebhook,
        wakeAgent: vi.fn(),
        checkHealth: vi.fn().mockResolvedValue({ healthy: true, details: "ok" }),
      };

      scheduler.setExecutionContext(ctx);
      const job = scheduler.create({
        name: "webhook-test",
        cronExpression: "* * * * *",
        jobType: "webhook-notify",
        payload: { url: "https://example.com/hook" },
      });

      // biome-ignore lint/suspicious/noExplicitAny: test helper
      (scheduler as any).executeJob(job);

      expect(sendWebhook).toHaveBeenCalledWith(
        "https://example.com/hook",
        expect.objectContaining({
          type: "scheduled-notification",
          jobId: job.id,
          jobName: "webhook-test",
        }),
      );
    });

    it("executes health-check jobs via context", () => {
      const checkHealth = vi.fn().mockResolvedValue({ healthy: true, details: "all good" });
      const ctx: JobExecutionContext = {
        sendWebhook: vi.fn(),
        wakeAgent: vi.fn(),
        checkHealth,
      };

      scheduler.setExecutionContext(ctx);
      const job = scheduler.create({
        name: "health-test",
        cronExpression: "* * * * *",
        jobType: "health-check",
      });

      // biome-ignore lint/suspicious/noExplicitAny: test helper
      (scheduler as any).executeJob(job);

      expect(checkHealth).toHaveBeenCalled();
    });
  });
});
