import express, { type Request, type Response } from "express";
import type { GradeStore } from "../grading";
import { validateGradeInput } from "../grading";
import type { Orchestrator } from "../orchestrator";
import type { TaskGraph, TaskPriority, TaskResult, TaskStatus } from "../task-graph";
import { MAX_DEPENDENCIES, MAX_RETRIES_LIMIT, MAX_TIMEOUT_MS } from "../task-graph";
import { param } from "../utils/express";

const VALID_STATUSES = new Set<TaskStatus>([
  "pending",
  "assigned",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);
const VALID_PRIORITIES = new Set<TaskPriority>([0, 1, 2, 3, 4]);
const MAX_CAPABILITIES = 20;
const MAX_CAPABILITY_KEY_LENGTH = 100;
const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_CRITERIA_LENGTH = 5_000;
const MAX_GOAL_LENGTH = 2_000;
const MAX_CAPABILITY_PROFILE_KEYS = 50;
const MAX_QUERY_LIMIT = 250;

/** Parse and clamp a limit query parameter. Returns undefined if not provided. */
function parseLimit(raw: string | undefined, defaultLimit?: number): number | undefined {
  if (!raw && defaultLimit === undefined) return undefined;
  if (!raw) return defaultLimit;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return defaultLimit;
  return Math.min(Math.max(parsed, 1), MAX_QUERY_LIMIT);
}

export function createTasksRouter(taskGraph: TaskGraph, orchestrator: Orchestrator, gradeStore?: GradeStore) {
  const router = express.Router();

  /** List/query tasks with optional filters. */
  router.get("/api/tasks", (req: Request, res: Response) => {
    const statusParam = req.query.status as string | undefined;
    const ownerAgentId = req.query.ownerAgentId as string | undefined;
    const parentTaskId = req.query.parentTaskId as string | undefined;
    const unblocked = req.query.unblocked === "true";
    const unowned = req.query.unowned === "true";
    const requiredCapability = req.query.requiredCapability as string | undefined;
    const limit = parseLimit(req.query.limit as string | undefined);

    // Validate status values
    let statusFilter: TaskStatus | TaskStatus[] | undefined;
    if (statusParam) {
      const statuses = statusParam.includes(",") ? statusParam.split(",") : [statusParam];
      for (const s of statuses) {
        if (!VALID_STATUSES.has(s as TaskStatus)) {
          res.status(400).json({ error: `Invalid status: ${s}` });
          return;
        }
      }
      statusFilter = statuses.length > 1 ? (statuses as TaskStatus[]) : (statuses[0] as TaskStatus);
    }

    const tasks = taskGraph.queryTasks({
      status: statusFilter,
      ownerAgentId,
      parentTaskId,
      unblocked: unblocked || undefined,
      unowned: unowned || undefined,
      requiredCapability,
      limit,
    });

    res.json(tasks);
  });

  /** Get task graph summary (DAG stats). */
  router.get("/api/tasks/summary", (_req: Request, res: Response) => {
    const summary = taskGraph.getSummary();
    res.json(summary);
  });

  /** Get the next available task for an agent. */
  router.get("/api/tasks/next", (req: Request, res: Response) => {
    const capabilities = req.query.capabilities ? (req.query.capabilities as string).split(",") : undefined;

    const task = taskGraph.getNextTask(capabilities);
    if (!task) {
      res.json(null);
      return;
    }
    res.json(task);
  });

  /** Get a single task by ID. */
  router.get("/api/tasks/:id", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const task = taskGraph.getTask(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  });

  /** Create a new task. */
  router.post("/api/tasks", (req: Request, res: Response) => {
    const {
      title,
      description,
      priority,
      ownerAgentId,
      parentTaskId,
      input,
      expectedOutput,
      acceptanceCriteria,
      requiredCapabilities,
      dependsOn,
      maxRetries,
      timeoutMs,
    } = req.body ?? {};

    // ── Title validation ──
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    if (title.length > MAX_TITLE_LENGTH) {
      res.status(400).json({ error: `title must be ${MAX_TITLE_LENGTH} characters or less` });
      return;
    }

    // ── Description validation ──
    if (description !== undefined && typeof description === "string" && description.length > MAX_DESCRIPTION_LENGTH) {
      res.status(400).json({ error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or less` });
      return;
    }

    // ── Acceptance criteria validation ──
    if (
      acceptanceCriteria !== undefined &&
      typeof acceptanceCriteria === "string" &&
      acceptanceCriteria.length > MAX_CRITERIA_LENGTH
    ) {
      res.status(400).json({ error: `acceptanceCriteria must be ${MAX_CRITERIA_LENGTH} characters or less` });
      return;
    }

    // ── Priority validation ──
    if (priority !== undefined && !VALID_PRIORITIES.has(priority as TaskPriority)) {
      res.status(400).json({ error: "priority must be 0 (none), 1 (urgent), 2 (high), 3 (normal), or 4 (low)" });
      return;
    }

    // ── maxRetries validation ──
    if (maxRetries !== undefined) {
      if (typeof maxRetries !== "number" || maxRetries < 0 || maxRetries > MAX_RETRIES_LIMIT) {
        res.status(400).json({ error: `maxRetries must be a number between 0 and ${MAX_RETRIES_LIMIT}` });
        return;
      }
    }

    // ── timeoutMs validation ──
    if (timeoutMs !== undefined) {
      if (typeof timeoutMs !== "number" || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
        res.status(400).json({ error: `timeoutMs must be between 1000 and ${MAX_TIMEOUT_MS}` });
        return;
      }
    }

    // ── requiredCapabilities validation ──
    if (requiredCapabilities !== undefined) {
      if (!Array.isArray(requiredCapabilities)) {
        res.status(400).json({ error: "requiredCapabilities must be an array" });
        return;
      }
      if (requiredCapabilities.length > MAX_CAPABILITIES) {
        res.status(400).json({ error: `requiredCapabilities must have at most ${MAX_CAPABILITIES} entries` });
        return;
      }
      for (const cap of requiredCapabilities) {
        if (typeof cap !== "string" || cap.length === 0 || cap.length > MAX_CAPABILITY_KEY_LENGTH) {
          res.status(400).json({
            error: `Each capability must be a non-empty string of max ${MAX_CAPABILITY_KEY_LENGTH} characters`,
          });
          return;
        }
      }
    }

    // ── dependsOn validation ──
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn)) {
        res.status(400).json({ error: "dependsOn must be an array of task IDs" });
        return;
      }
      if (dependsOn.length > MAX_DEPENDENCIES) {
        res.status(400).json({ error: `dependsOn must have at most ${MAX_DEPENDENCIES} entries` });
        return;
      }
      for (const depId of dependsOn) {
        if (typeof depId !== "string") {
          res.status(400).json({ error: "dependsOn entries must be strings" });
          return;
        }
        if (!taskGraph.getTask(depId)) {
          res.status(400).json({ error: `Dependency task ${depId} not found` });
          return;
        }
      }
    }

    try {
      const task = taskGraph.createTask({
        title,
        description,
        priority: priority as TaskPriority,
        ownerAgentId,
        parentTaskId,
        input,
        expectedOutput,
        acceptanceCriteria,
        requiredCapabilities,
        dependsOn,
        maxRetries,
        timeoutMs,
      });
      res.status(201).json(task);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to create task" });
    }
  });

  /** Delete a task. */
  router.delete("/api/tasks/:id", (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (taskGraph.deleteTask(id)) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: "Task not found" });
    }
  });

  /** Clear all tasks. Requires ?confirm=true to prevent accidental deletion. */
  router.delete("/api/tasks", (req: Request, res: Response) => {
    if (req.query.confirm !== "true") {
      res.status(400).json({ error: "This will delete ALL tasks. Pass ?confirm=true to confirm." });
      return;
    }
    const count = taskGraph.clearAll();
    res.json({ deleted: count });
  });

  /** Assign a task to an agent. */
  router.post("/api/tasks/:id/assign", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const { agentId } = req.body ?? {};

    if (!agentId || typeof agentId !== "string") {
      res.status(400).json({ error: "agentId is required" });
      return;
    }

    const task = taskGraph.getTask(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (taskGraph.assignTask(id, agentId, task.version)) {
      res.json(taskGraph.getTask(id));
    } else {
      res.status(409).json({ error: "Assignment failed — task may have been modified concurrently" });
    }
  });

  /** Mark a task as running. */
  router.post("/api/tasks/:id/start", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const task = taskGraph.getTask(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (taskGraph.startTask(id, task.version)) {
      res.json(taskGraph.getTask(id));
    } else {
      res.status(409).json({ error: "Failed to start task — check current status and version" });
    }
  });

  /** Submit a task result (complete or fail). */
  router.post("/api/tasks/:id/result", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const { status, output, confidence, durationMs, errorMessage } = req.body ?? {};

    if (status !== "completed" && status !== "failed") {
      res.status(400).json({ error: "status must be 'completed' or 'failed'" });
      return;
    }

    const result: TaskResult = {
      taskId: id,
      status,
      output: output ?? null,
      confidence: confidence ?? "medium",
      durationMs: durationMs ?? 0,
      errorMessage,
    };

    const outcome = orchestrator.submitResult(result);
    if (!outcome.accepted) {
      res.status(400).json({ error: outcome.error });
      return;
    }

    res.json({
      accepted: true,
      task: taskGraph.getTask(id),
      unblockedTasks: outcome.unblockedTasks,
    });
  });

  /** Cancel a task. */
  router.post("/api/tasks/:id/cancel", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const task = taskGraph.getTask(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (taskGraph.cancelTask(id, task.version)) {
      res.json(taskGraph.getTask(id));
    } else {
      res.status(409).json({ error: "Cannot cancel task — it may already be completed or cancelled" });
    }
  });

  /** Retry a failed task. */
  router.post("/api/tasks/:id/retry", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const { agentId } = req.body ?? {};

    if (taskGraph.retryTask(id, agentId)) {
      res.json(taskGraph.getTask(id));
    } else {
      res.status(400).json({ error: "Cannot retry task — check status and retry count" });
    }
  });

  /** Decompose a goal into subtasks via the orchestrator. */
  router.post("/api/orchestrator/decompose", (req: Request, res: Response) => {
    const { goal, subtasks, parentTaskId } = req.body ?? {};

    if (!goal || typeof goal !== "string") {
      res.status(400).json({ error: "goal is required" });
      return;
    }

    if (goal.length > MAX_GOAL_LENGTH) {
      res.status(400).json({ error: `goal must be ${MAX_GOAL_LENGTH} characters or less` });
      return;
    }

    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      res.status(400).json({ error: "subtasks array is required and must not be empty" });
      return;
    }

    if (subtasks.length > 50) {
      res.status(400).json({ error: "Maximum 50 subtasks per decomposition" });
      return;
    }

    for (let i = 0; i < subtasks.length; i++) {
      if (!subtasks[i].title || typeof subtasks[i].title !== "string") {
        res.status(400).json({ error: `subtasks[${i}].title is required` });
        return;
      }
      if (subtasks[i].title.length > MAX_TITLE_LENGTH) {
        res.status(400).json({ error: `subtasks[${i}].title must be ${MAX_TITLE_LENGTH} characters or less` });
        return;
      }
    }

    try {
      const tasks = orchestrator.decomposeGoal({ goal, subtasks, parentTaskId });
      res.status(201).json({ goal, tasks });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to decompose goal" });
    }
  });

  /** Trigger a manual assignment cycle. */
  router.post("/api/orchestrator/assign", (_req: Request, res: Response) => {
    const decisions = orchestrator.assignmentCycle();
    res.json({ assignments: decisions });
  });

  /** Get orchestrator status and event log. */
  router.get("/api/orchestrator/status", (_req: Request, res: Response) => {
    const status = orchestrator.getStatus();
    res.json(status);
  });

  /** Get orchestrator event log. */
  router.get("/api/orchestrator/events", (req: Request, res: Response) => {
    const limit = parseLimit(req.query.limit as string | undefined, 50) ?? 50;
    const events = orchestrator.getEventLog(limit);
    res.json(events);
  });

  /** Get an agent's capability profile. */
  router.get("/api/capabilities/:agentId", (req: Request, res: Response) => {
    const agentId = param(req.params.agentId);
    const profile = taskGraph.getCapabilityProfile(agentId);
    if (!profile) {
      res.status(404).json({ error: "No capability profile found for this agent" });
      return;
    }
    res.json(profile);
  });

  /** Get all capability profiles. */
  router.get("/api/capabilities", (_req: Request, res: Response) => {
    const profiles = taskGraph.getAllCapabilityProfiles();
    res.json(profiles);
  });

  /** Update an agent's capability profile (declare capabilities). */
  router.put("/api/capabilities/:agentId", (req: Request, res: Response) => {
    const agentId = param(req.params.agentId);
    const { capabilities } = req.body ?? {};

    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
      res.status(400).json({ error: "capabilities object is required (tag -> confidence 0-1)" });
      return;
    }

    const entries = Object.entries(capabilities);
    if (entries.length > MAX_CAPABILITY_PROFILE_KEYS) {
      res.status(400).json({ error: `capabilities must have at most ${MAX_CAPABILITY_PROFILE_KEYS} keys` });
      return;
    }

    // Validate capability values
    for (const [key, value] of entries) {
      if (typeof key !== "string" || key.length === 0 || key.length > MAX_CAPABILITY_KEY_LENGTH) {
        res
          .status(400)
          .json({ error: `Capability keys must be non-empty strings of max ${MAX_CAPABILITY_KEY_LENGTH} characters` });
        return;
      }
      if (typeof value !== "number" || value < 0 || value > 1) {
        res.status(400).json({ error: "Capability values must be numbers between 0 and 1" });
        return;
      }
    }

    const existing = taskGraph.getCapabilityProfile(agentId);
    taskGraph.upsertCapabilityProfile({
      agentId,
      capabilities: capabilities as Record<string, number>,
      successRate: existing?.successRate ?? {},
      totalCompleted: existing?.totalCompleted ?? 0,
      totalFailed: existing?.totalFailed ?? 0,
      updatedAt: new Date().toISOString(),
    });

    res.json(taskGraph.getCapabilityProfile(agentId));
  });

  /** Get tasks that depend on a given task. */
  router.get("/api/tasks/:id/dependents", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const task = taskGraph.getTask(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const dependents = taskGraph.getDependentTasks(id);
    res.json(dependents);
  });

  // ── Confidence grading endpoints (Phase 2.3) ──

  /** Submit a confidence grade for a task. */
  router.post("/api/grades", (req: Request, res: Response) => {
    if (!gradeStore) {
      res.status(501).json({ error: "Grading not enabled" });
      return;
    }

    const validationError = validateGradeInput(req.body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const grade = gradeStore.submit(req.body);

    // High-risk grades trigger orchestrator escalation
    if (grade.overallRisk === "high") {
      orchestrator.submitResult({
        taskId: grade.taskId,
        status: "failed",
        output: null,
        confidence: "low",
        durationMs: 0,
        errorMessage: `High-risk grade: ${grade.reasoning || "Requires human approval"}`,
      });
    }

    res.status(201).json(grade);
  });

  /** Get the grade for a specific task. */
  router.get("/api/grades/:taskId", (req: Request, res: Response) => {
    if (!gradeStore) {
      res.status(501).json({ error: "Grading not enabled" });
      return;
    }

    const taskId = param(req.params.taskId);
    const grade = gradeStore.get(taskId);
    if (!grade) {
      res.status(404).json({ error: "No grade found for this task" });
      return;
    }
    res.json(grade);
  });

  /** List all grades, optionally filtered by risk level or agentId. */
  router.get("/api/grades", (req: Request, res: Response) => {
    if (!gradeStore) {
      res.status(501).json({ error: "Grading not enabled" });
      return;
    }

    const risk = req.query.risk as string | undefined;
    const agentId = req.query.agentId as string | undefined;

    if (risk) {
      res.json(gradeStore.getByRisk(risk as "low" | "medium" | "high"));
      return;
    }
    if (agentId) {
      res.json(gradeStore.getByAgent(agentId));
      return;
    }
    res.json(gradeStore.getAll());
  });

  /** Approve a high-risk grade (human review). */
  router.post("/api/grades/:taskId/approve", (req: Request, res: Response) => {
    if (!gradeStore) {
      res.status(501).json({ error: "Grading not enabled" });
      return;
    }

    const taskId = param(req.params.taskId);
    const grade = gradeStore.get(taskId);
    if (!grade) {
      res.status(404).json({ error: "No grade found for this task" });
      return;
    }

    if (grade.overallRisk !== "high") {
      res.status(400).json({ error: "Only high-risk grades require approval" });
      return;
    }

    // Re-submit as completed via the orchestrator
    orchestrator.submitResult({
      taskId: grade.taskId,
      status: "completed",
      output: { approved: true, reviewer: "human", reasoning: grade.reasoning ?? null },
      confidence: "high",
      durationMs: 0,
    });

    res.json({ approved: true, taskId });
  });

  return router;
}
