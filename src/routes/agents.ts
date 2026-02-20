import express, { type Request, type Response } from "express";
import type { AgentManager } from "../agents";
import { MAX_BATCH_SIZE } from "../guardrails";
import { logger } from "../logger";
import type { MessageBus } from "../messages";
import type { AuthenticatedRequest, StreamEvent } from "../types";
import { param, queryString } from "../utils/express";
import { listFilesRecursive } from "../utils/files";
import { setupSSE } from "../utils/sse";
import { validateAgentSpec, validateCreateAgent, validateMessage, validatePatchAgent } from "../validation";

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

  // Swarm topology graph - nodes + edges derived from parentId relationships.
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
      const message = err instanceof Error ? err.message : "Failed to create agent";
      res.status(400).json({ error: message });
    }
  });

  // Get agent details
  router.get("/api/agents/:id", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const agent = agentManager.get(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    // Update lastActivity when agent details are retrieved
    agentManager.touch(id);
    res.json(agent);
  });

  // Send message to agent (streams SSE)
  router.post("/api/agents/:id/message", validateMessage, (req: Request, res: Response) => {
    const { prompt, maxTurns, sessionId, attachments } = req.body;

    try {
      const agentId = param(req.params.id);
      const agent = agentManager.get(agentId);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      // Save any attachments to the agent's workspace and append file refs to prompt.
      // Normalize prompt to empty string so attachment-only messages don't produce
      // a fullPrompt that starts with the "\n\n" separator from saveAttachments.
      const promptText = typeof prompt === "string" ? prompt : "";
      let fullPrompt = promptText;
      if (Array.isArray(attachments) && attachments.length > 0) {
        const suffix = agentManager.saveAttachments(agent.workspaceDir, attachments);
        fullPrompt = promptText ? promptText + suffix : suffix.trimStart();
      }

      logger.info("[message] Sending message to agent", { agentId, promptSnippet: fullPrompt.slice(0, 80) });
      const { agent: updatedAgent, subscribe } = agentManager.message(agentId, fullPrompt, maxTurns, sessionId);
      setupSSE(res, updatedAgent.id, subscribe);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to send message";
      logger.error("[message] Error sending message to agent", { error: message });
      const status = message === "Agent not found" ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  // Reconnect to SSE stream
  router.get("/api/agents/:id/events", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const agent = agentManager.get(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

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
    const agent = agentManager.get(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

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
    const agent = agentManager.get(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const query = (queryString(req.query.q) || "").toLowerCase();
    const maxResults = Math.min(Number.parseInt(queryString(req.query.limit) ?? "", 10) || 50, 200);

    try {
      const files = listFilesRecursive(agent.workspaceDir, agent.workspaceDir, query, maxResults);
      res.json(files);
    } catch {
      res.json([]);
    }
  });

  // Update agent metadata (role, currentTask, name)
  // Input validation middleware enforces whitelist and sanitization (issue #62)
  router.patch("/api/agents/:id", validatePatchAgent, (req: Request, res: Response) => {
    const id = param(req.params.id);
    const agent = agentManager.get(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const { role, currentTask, name } = req.body ?? {};

    if (role !== undefined) {
      agent.role = role;
    }
    if (currentTask !== undefined) {
      agent.currentTask = currentTask;
    }
    if (name !== undefined) {
      agent.name = name;
    }

    agentManager.touch(id);
    res.json(agent);
  });

  // Agent runtime metadata (PID, git info, uptime, etc.)
  router.get("/api/agents/:id/metadata", async (req: Request, res: Response) => {
    const id = param(req.params.id);
    const metadata = await agentManager.getMetadata(id);
    if (!metadata) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(metadata);
  });

  // Token usage and cost for a single agent
  router.get("/api/agents/:id/usage", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const usage = agentManager.getUsage(id);
    if (!usage) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(usage);
  });

  // Destroy agent
  router.delete("/api/agents/:id", (req: Request, res: Response) => {
    const id = param(req.params.id);

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

  // WI-5: Pause an agent (SIGSTOP)
  router.post("/api/agents/:id/pause", (req: Request, res: Response) => {
    // Agents must not pause/resume other agents
    if ((req as AuthenticatedRequest).user?.sub === "agent-service") {
      res.status(403).json({ error: "Agent service tokens cannot pause agents" });
      return;
    }
    const id = param(req.params.id);
    if (!agentManager.get(id)) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (agentManager.pause(id)) {
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: "Cannot pause agent (not running or no process)" });
    }
  });

  // WI-5: Resume a paused agent (SIGCONT)
  router.post("/api/agents/:id/resume", (req: Request, res: Response) => {
    // Agents must not pause/resume other agents
    if ((req as AuthenticatedRequest).user?.sub === "agent-service") {
      res.status(403).json({ error: "Agent service tokens cannot resume agents" });
      return;
    }
    const id = param(req.params.id);
    if (!agentManager.get(id)) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (agentManager.resume(id)) {
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: "Cannot resume agent (not paused)" });
    }
  });

  return router;
}
