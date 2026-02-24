import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import type { AgentManager } from "../agents";
import { requireHumanUser } from "../auth";
import { logger } from "../logger";
import type { MessageBus } from "../messages";
import { buildManagerPrompt } from "../templates/linear-workflow-manager-prompt";
import { errorMessage } from "../types";

interface LinearWorkflow {
  id: string;
  linearUrl: string;
  repository: string;
  status: "starting" | "running" | "completed" | "failed" | "cancelled";
  agents: Array<{ id: string; name: string; role: string }>;
  prUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** Max concurrent workflows */
const MAX_WORKFLOWS = 5;

/** Max total stored workflows (evict oldest terminal workflows beyond this) */
const MAX_STORED_WORKFLOWS = 50;

/** Valid repository name pattern: alphanumeric, hyphens, underscores, dots, and optional owner/ prefix */
const REPO_NAME_RE = /^[\w.-]+(\/[\w.-]+)?$/;

function parseLinearUrl(url: string): { issueId: string; team: string; workspace: string } | null {
  // Anchored to https://linear.app to prevent matching spoofed domains
  const match = url.match(/^https:\/\/linear\.app\/([\w-]+)\/issue\/([\w]+-\d+)/);
  if (match) {
    const workspace = match[1];
    const issueId = match[2];
    const team = issueId.split("-")[0];
    return { issueId, team, workspace };
  }
  return null;
}

/** Reconstruct a clean Linear URL from parsed components (prevents prompt injection via URL) */
function buildSafeLinearUrl(parsed: { issueId: string; workspace: string }): string {
  return `https://linear.app/${parsed.workspace}/issue/${parsed.issueId}`;
}

/** Evict oldest terminal workflows when the store exceeds MAX_STORED_WORKFLOWS */
function evictStaleWorkflows(workflows: Map<string, LinearWorkflow>): void {
  if (workflows.size <= MAX_STORED_WORKFLOWS) return;
  const terminal = Array.from(workflows.entries())
    .filter(([, w]) => w.status === "completed" || w.status === "failed" || w.status === "cancelled")
    .sort((a, b) => new Date(a[1].createdAt).getTime() - new Date(b[1].createdAt).getTime());
  while (workflows.size > MAX_STORED_WORKFLOWS && terminal.length > 0) {
    const oldest = terminal.shift();
    if (oldest) workflows.delete(oldest[0]);
  }
}

export function createWorkflowsRouter(agentManager: AgentManager, messageBus: MessageBus) {
  const router = express.Router();
  const workflows = new Map<string, LinearWorkflow>();

  /**
   * POST /api/workflows/linear
   * Start a new Linear-to-PR workflow
   */
  router.post("/api/workflows/linear", requireHumanUser, (req: Request, res: Response) => {
    try {
      const { linearUrl, repository } = req.body ?? {};

      if (!linearUrl || typeof linearUrl !== "string") {
        res.status(400).json({ error: "linearUrl is required" });
        return;
      }

      if (!repository || typeof repository !== "string") {
        res.status(400).json({ error: "repository is required" });
        return;
      }

      // Validate repository name format (prevents prompt injection)
      if (!REPO_NAME_RE.test(repository) || repository.length > 100) {
        res.status(400).json({
          error: "Invalid repository name. Use alphanumeric characters, hyphens, underscores, and dots only.",
        });
        return;
      }

      // Validate Linear URL (anchored to https://linear.app)
      const parsed = parseLinearUrl(linearUrl);
      if (!parsed) {
        res.status(400).json({
          error: "Invalid Linear URL. Expected format: https://linear.app/team/issue/TEAM-123",
        });
        return;
      }

      // Reconstruct a safe URL from parsed components to prevent prompt injection
      const safeLinearUrl = buildSafeLinearUrl(parsed);

      // Check concurrent workflow limit
      const active = Array.from(workflows.values()).filter((w) => w.status === "starting" || w.status === "running");
      if (active.length >= MAX_WORKFLOWS) {
        res.status(429).json({
          error: `Maximum ${MAX_WORKFLOWS} concurrent workflows allowed. Wait for an existing workflow to complete.`,
        });
        return;
      }

      const workflowId = crypto.randomUUID();
      const now = new Date().toISOString();

      const workflow: LinearWorkflow = {
        id: workflowId,
        linearUrl: safeLinearUrl,
        repository,
        status: "starting",
        agents: [],
        createdAt: now,
        updatedAt: now,
      };

      workflows.set(workflowId, workflow);
      evictStaleWorkflows(workflows);

      // Spawn the manager agent, then respond with the result
      const managerPrompt = buildManagerPrompt(safeLinearUrl, repository, workflowId);

      try {
        const managerName = `workflow-${parsed.issueId.toLowerCase()}`;
        const { agent } = agentManager.create({
          prompt: managerPrompt,
          name: managerName,
          model: "claude-sonnet-4-6",
          maxTurns: 100,
          role: "workflow-manager",
        });

        workflow.agents.push({ id: agent.id, name: managerName, role: "manager" });
        workflow.status = "running";
        workflow.updatedAt = new Date().toISOString();

        res.status(201).json({ workflow });
      } catch (err: unknown) {
        logger.error(`[Workflows] Failed to spawn manager for ${workflowId}`, { error: errorMessage(err) });
        workflow.status = "failed";
        workflow.error = errorMessage(err);
        workflow.updatedAt = new Date().toISOString();

        res.status(500).json({ error: `Failed to start workflow: ${errorMessage(err)}`, workflow });
      }
    } catch (err: unknown) {
      logger.error("[Workflows] Error starting workflow", { error: errorMessage(err) });
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  /**
   * GET /api/workflows
   * List all workflows
   */
  router.get("/api/workflows", (_req: Request, res: Response) => {
    const all = Array.from(workflows.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    res.json(all);
  });

  /**
   * GET /api/workflows/:id
   * Get workflow status
   */
  router.get("/api/workflows/:id", (req: Request<{ id: string }>, res: Response) => {
    const workflow = workflows.get(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    // Enrich with live agent status
    const enriched = {
      ...workflow,
      agents: workflow.agents.map((a) => {
        const agent = agentManager.get(a.id);
        return {
          ...a,
          status: agent?.status ?? "unknown",
          currentTask: agent?.currentTask,
        };
      }),
    };

    res.json(enriched);
  });

  /**
   * DELETE /api/workflows/:id
   * Cancel a workflow and destroy its agents
   */
  router.delete("/api/workflows/:id", requireHumanUser, async (req: Request<{ id: string }>, res: Response) => {
    const workflow = workflows.get(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    // Destroy all associated agents
    for (const agent of workflow.agents) {
      try {
        const destroyed = await agentManager.destroy(agent.id);
        if (!destroyed) {
          logger.warn("[Workflows] Agent already gone on cancel", { agentId: agent.id });
        }
      } catch (err: unknown) {
        logger.warn(`[Workflows] Failed to destroy agent ${agent.id}`, { error: errorMessage(err) });
      }
    }

    workflow.status = "cancelled";
    workflow.updatedAt = new Date().toISOString();

    res.json({ ok: true, workflow });
  });

  // Listen for workflow completion messages
  messageBus.subscribe((msg) => {
    if (msg.type !== "result" || !msg.metadata?.workflowId) return;

    const wfId = msg.metadata.workflowId;
    if (typeof wfId !== "string") return;

    const workflow = workflows.get(wfId);
    if (!workflow) return;

    // Check if message contains a PR URL
    const prMatch = msg.content.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
    if (prMatch) {
      workflow.prUrl = prMatch[0];
      workflow.status = "completed";
      workflow.updatedAt = new Date().toISOString();
    }
  });

  return router;
}
