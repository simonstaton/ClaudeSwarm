import express, { type Request, type Response } from "express";
import type { AgentManager } from "../agents";
import { requireHumanUser } from "../auth";
import { MAX_BATCH_SIZE } from "../guardrails";
import { logger } from "../logger";
import type { MessageBus } from "../messages";
import { errorMessage, type StreamEvent } from "../types";
import { param, queryString } from "../utils/express";
import { listFilesRecursive } from "../utils/files";
import { setupSSE } from "../utils/sse";
import { validateAgentSpec, validateCreateAgent, validateMessage, validatePatchAgent } from "../validation";
import { requireAgent } from "./require-agent";

export function createAgentsRouter(
  agentManager: AgentManager,
  messageBus: MessageBus,
  startKeepAlive: () => void,
  stopKeepAlive: () => void,
  isMemoryPressure: () => boolean,
) {
  const router = express.Router();

  // List all agents
  router.get("/api/agents", (_req, res) => {
    const agents = agentManager.list();
    // NOTE: Previously touched all agents here to prevent TTL cleanup while UI is active.
    // Removed because it prevents TTL-based cleanup entirely - any open dashboard tab
    // resets every agent's lastActivity every 5s. Individual agent interactions
    // (GET /api/agents/:id, message, events) still touch the specific agent.
    res.json(agents);
  });

  // Agent registry (must be before :id routes)
  router.get("/api/agents/registry", (_req, res) => {
    const agents = agentManager.list().map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      role: a.role,
      capabilities: a.capabilities,
      currentTask: a.currentTask,
      parentId: a.parentId,
      depth: a.depth,
      model: a.model,
      lastActivity: a.lastActivity,
      unreadMessages: messageBus.unreadCount(a.id, a.role),
    }));
    res.json(agents);
  });

  // Agent topology graph - nodes + edges derived from parentId relationships.
  // Agents can use this to discover direct paths to peers without multi-hop routing.
  router.get("/api/agents/topology", (_req, res) => {
    const agents = agentManager.list();
    const nodes = agents.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      role: a.role,
      model: a.model,
      depth: a.depth,
      currentTask: a.currentTask,
      parentId: a.parentId,
      lastActivity: a.lastActivity,
      tokensUsed: (a.usage?.tokensIn ?? 0) + (a.usage?.tokensOut ?? 0),
      tokensSpent: a.usage?.totalTokensSpent ?? (a.usage?.tokensIn ?? 0) + (a.usage?.tokensOut ?? 0),
      estimatedCost: a.usage?.estimatedCost ?? 0,
    }));
    const edges = agents.filter((a) => a.parentId).map((a) => ({ source: a.parentId as string, target: a.id }));
    res.json({ nodes, edges });
  });

  // Batch create agents (returns JSON, not SSE - designed for spawning multiple agents at once)
  router.post("/api/agents/batch", (req: Request, res: Response) => {
    if (isMemoryPressure()) {
      res.status(503).json({ error: "Server under memory pressure - cannot create new agents. Try again later." });
      return;
    }

    const { agents: specs } = req.body ?? {};

    if (!Array.isArray(specs) || specs.length === 0) {
      res.status(400).json({ error: "agents array is required and must not be empty" });
      return;
    }
    if (specs.length > MAX_BATCH_SIZE) {
      res.status(400).json({ error: `Maximum batch size is ${MAX_BATCH_SIZE}` });
      return;
    }

    for (let i = 0; i < specs.length; i++) {
      const error = validateAgentSpec(specs[i]);
      if (error) {
        res.status(400).json({ error: `agents[${i}]: ${error}` });
        return;
      }
    }

    const results = agentManager.createBatch(specs);
    startKeepAlive();
    res.json({ results });
  });

  // Create agent (streams SSE)
  router.post("/api/agents", validateCreateAgent, (req: Request, res: Response) => {
    if (isMemoryPressure()) {
      res.status(503).json({ error: "Server under memory pressure - cannot create new agents. Try again later." });
      return;
    }

    const { prompt, name, model, maxTurns, role, capabilities, parentId, attachments, dangerouslySkipPermissions } =
      req.body;

    try {
      // For create, we need to pre-compute the workspace path to save attachments
      // before the agent spawns (since the prompt is passed at spawn time).
      // We pass attachments through and let AgentManager handle them.
      const { agent, subscribe } = agentManager.create({
        prompt,
        name,
        model,
        maxTurns,
        role,
        capabilities,
        parentId,
        attachments: Array.isArray(attachments) ? attachments : undefined,
        dangerouslySkipPermissions: dangerouslySkipPermissions === true,
      });

      startKeepAlive();
      setupSSE(res, agent.id, subscribe);
    } catch (err: unknown) {
      const message = errorMessage(err);
      // Use 500 for spawn/fs errors; validation errors are caught earlier and return 400
      res.status(500).json({ error: message });
    }
  });

  // Get agent details
  router.get("/api/agents/:id", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const agent = requireAgent(agentManager, id, res);
    if (!agent) return;
    // Update lastActivity when agent details are retrieved
    agentManager.touch(id);
    res.json(agent);
  });

  // Send message to agent (streams SSE)
  router.post("/api/agents/:id/message", validateMessage, (req: Request, res: Response) => {
    const { prompt, maxTurns, sessionId, attachments } = req.body;

    try {
      const agentId = param(req.params.id);
      const agent = requireAgent(agentManager, agentId, res);
      if (!agent) return;

      // Save any attachments to the agent's workspace. The returned prefix is
      // placed BEFORE the user text so the LLM reads attached files first.
      // promptText is passed separately so the terminal shows clean user text
      // without the file-path instructions that are only meant for the LLM.
      const promptText = typeof prompt === "string" ? prompt : "";
      let fullPrompt = promptText;
      let attachmentNames: string[] = [];
      if (Array.isArray(attachments) && attachments.length > 0) {
        const { prefix, names } = agentManager.saveAttachments(agent.workspaceDir, attachments);
        fullPrompt = promptText ? prefix + promptText : prefix;
        attachmentNames = names;
      }

      logger.info("[message] Sending message to agent", { agentId, promptSnippet: fullPrompt.slice(0, 80) });
      const { agent: updatedAgent, subscribe } = agentManager.message(
        agentId,
        fullPrompt,
        maxTurns,
        sessionId,
        promptText,
        attachmentNames,
      );
      setupSSE(res, updatedAgent.id, subscribe);
    } catch (err: unknown) {
      const message = errorMessage(err);
      logger.error("[message] Error sending message to agent", { error: message });
      const status = message === "Agent not found" ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  // Reconnect to SSE stream
  router.get("/api/agents/:id/events", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const agent = requireAgent(agentManager, id, res);
    if (!agent) return;

    // Update lastActivity when reconnecting to event stream
    agentManager.touch(id);

    // Support ?after=N to skip events the client already has (for auto-reconnect)
    const afterIndex = req.query.after ? Number.parseInt(queryString(req.query.after) ?? "", 10) : undefined;

    // Set up fresh SSE with event replay (skipping events before afterIndex).
    // closeOnDone: false - historical `done` events from previous turns must not
    // terminate the SSE connection; we need to replay the full history and then
    // stay open for any future live events.
    const subscribe = (listener: (event: StreamEvent) => void) => {
      const unsub = agentManager.subscribe(id, listener, afterIndex);
      if (!unsub) throw new Error("Agent not found");
      return unsub;
    };

    setupSSE(res, id, subscribe, { closeOnDone: false });
  });

  // Raw events (debug)
  router.get("/api/agents/:id/raw-events", async (req: Request, res: Response) => {
    const events = await agentManager.getEvents(param(req.params.id));
    const sessionIds = [...new Set(events.filter((e) => e.session_id).map((e) => e.session_id))];
    const eventTypes = [...new Set(events.map((e) => `${e.type}${e.subtype ? `:${e.subtype}` : ""}`))];
    res.json({
      total: events.length,
      sessionIds,
      eventTypes,
      // Last 50 events with session_id info
      recent: events.slice(-50).map((e, i) => ({
        idx: events.length - 50 + i,
        type: e.type,
        subtype: e.subtype,
        session_id: e.session_id,
      })),
    });
  });

  // Session logs (readable format for agent self-debugging)
  router.get("/api/agents/:id/logs", async (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (!requireAgent(agentManager, id, res)) return;

    const types = req.query.type ? (queryString(req.query.type) ?? "").split(",") : undefined;
    const tail = req.query.tail ? Number.parseInt(queryString(req.query.tail) ?? "", 10) : undefined;

    const { lines, total } = await agentManager.getLogs(id, { types, tail });

    // Support plain text output for easy piping in agent terminals
    if (queryString(req.query.format) === "text" || req.headers.accept === "text/plain") {
      res.setHeader("Content-Type", "text/plain");
      res.send(lines.join("\n"));
      return;
    }

    res.json({ total, returned: lines.length, lines });
  });

  // List workspace files (for @ mentions)
  router.get("/api/agents/:id/files", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const agent = requireAgent(agentManager, id, res);
    if (!agent) return;

    const query = (queryString(req.query.q) || "").toLowerCase();
    const maxResults = Math.min(Number.parseInt(queryString(req.query.limit) ?? "", 10) || 50, 200);

    try {
      const files = listFilesRecursive(agent.workspaceDir, agent.workspaceDir, query, maxResults);
      res.json(files);
    } catch {
      res.json([]);
    }
  });

  // Update agent metadata (role, currentTask, name, dangerouslySkipPermissions)
  // Input validation middleware enforces whitelist and sanitization (issue #62)
  router.patch("/api/agents/:id", validatePatchAgent, (req: Request, res: Response) => {
    const id = param(req.params.id);
    const agent = requireAgent(agentManager, id, res);
    if (!agent) return;

    const { role, currentTask, name, dangerouslySkipPermissions } = req.body ?? {};

    if (role !== undefined) {
      agent.role = role;
    }
    if (currentTask !== undefined) {
      agent.currentTask = currentTask;
    }
    if (name !== undefined) {
      agent.name = name;
    }
    if (dangerouslySkipPermissions !== undefined) {
      agent.dangerouslySkipPermissions = dangerouslySkipPermissions || undefined;
    }

    agentManager.touch(id);
    res.json(agent);
  });

  // Agent runtime metadata (PID, git info, uptime, etc.)
  router.get("/api/agents/:id/metadata", async (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (!requireAgent(agentManager, id, res)) return;
    const metadata = await agentManager.getMetadata(id);
    res.json(metadata ?? {});
  });

  // Token usage and cost for a single agent
  router.get("/api/agents/:id/usage", (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (!requireAgent(agentManager, id, res)) return;
    const usage = agentManager.getUsage(id);
    res.json(
      usage ?? {
        tokensIn: 0,
        tokensOut: 0,
        tokensTotal: 0,
        tokenLimit: 0,
        tokensRemaining: 0,
        estimatedCost: 0,
        model: "",
        sessionStart: "",
      },
    );
  });

  // Destroy agent
  router.delete("/api/agents/:id", (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (!requireAgent(agentManager, id, res)) return;

    try {
      // Also destroy child agents (spawned by this agent)
      const children = agentManager.list().filter((a) => a.parentId === id);
      for (const child of children) {
        try {
          agentManager.destroy(child.id);
          messageBus.cleanupForAgent(child.id);
        } catch (err: unknown) {
          logger.warn("[agents] Failed to destroy child agent", { agentId: child.id, error: String(err) });
        }
      }

      if (agentManager.destroy(id)) {
        messageBus.cleanupForAgent(id);
        // Stop keep-alive if no agents remain
        if (agentManager.list().length === 0) {
          stopKeepAlive();
        }
        res.json({ ok: true });
      } else {
        res.status(404).json({ error: "Agent not found" });
      }
    } catch (err: unknown) {
      logger.error("[agents] Error destroying agent", { agentId: id, error: String(err) });
      res.status(500).json({ error: "Failed to destroy agent" });
    }
  });

  // Clear agent context (reset session, keep billing counter)
  router.post("/api/agents/:id/clear-context", requireHumanUser, async (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (!requireAgent(agentManager, id, res)) return;
    const result = await agentManager.clearContext(id);
    if (result.ok) {
      res.json({ ok: true, tokensCleared: result.tokensCleared });
    } else {
      const httpStatus = result.error?.includes("idle") || result.error?.includes("running") ? 409 : 404;
      res.status(httpStatus).json({ error: result.error });
    }
  });

  // WI-5: Pause an agent (SIGSTOP)
  router.post("/api/agents/:id/pause", requireHumanUser, (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (!requireAgent(agentManager, id, res)) return;
    if (agentManager.pause(id)) {
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: "Cannot pause agent (not running or no process)" });
    }
  });

  // WI-5: Resume a paused agent (SIGCONT)
  router.post("/api/agents/:id/resume", requireHumanUser, (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (!requireAgent(agentManager, id, res)) return;
    if (agentManager.resume(id)) {
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: "Cannot resume agent (not paused)" });
    }
  });

  return router;
}
