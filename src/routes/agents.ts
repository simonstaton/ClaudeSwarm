import express, { type Request, type Response } from "express";
import type { AgentManager } from "../agents";
import { MAX_BATCH_SIZE } from "../guardrails";
import type { MessageBus } from "../messages";
import type { StreamEvent } from "../types";
import { param } from "../utils/express";
import { listFilesRecursive } from "../utils/files";
import { setupSSE } from "../utils/sse";
import { validateAgentSpec, validateCreateAgent, validateMessage } from "../validation";

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
    // Update lastActivity for all agents to prevent premature cleanup while UI is active
    for (const agent of agents) agentManager.touch(agent.id);
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
      model: a.model,
      lastActivity: a.lastActivity,
      unreadMessages: messageBus.unreadCount(a.id, a.role),
    }));
    res.json(agents);
  });

  // Batch create agents (returns JSON, not SSE — designed for spawning multiple agents at once)
  router.post("/api/agents/batch", (req: Request, res: Response) => {
    if (isMemoryPressure()) {
      res.status(503).json({ error: "Server under memory pressure — cannot create new agents. Try again later." });
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
      res.status(503).json({ error: "Server under memory pressure — cannot create new agents. Try again later." });
      return;
    }

    const { prompt, name, model, maxTurns, role, capabilities, parentId, attachments } = req.body;

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

      // Save any attachments to the agent's workspace and append file refs to prompt
      let fullPrompt = prompt;
      if (Array.isArray(attachments) && attachments.length > 0) {
        const suffix = agentManager.saveAttachments(agent.workspaceDir, attachments);
        fullPrompt = prompt + suffix;
      }

      console.log(`[message] Agent ${agentId}, prompt: "${fullPrompt.slice(0, 80)}"`);
      const { agent: updatedAgent, subscribe } = agentManager.message(agentId, fullPrompt, maxTurns, sessionId);
      setupSSE(res, updatedAgent.id, subscribe);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to send message";
      console.error(`[message] Error: ${message}`);
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
    const afterIndex = req.query.after ? parseInt(req.query.after as string, 10) : undefined;

    // Set up fresh SSE with event replay (skipping events before afterIndex).
    // closeOnDone: false — historical `done` events from previous turns must not
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

    const types = req.query.type ? (req.query.type as string).split(",") : undefined;
    const tail = req.query.tail ? parseInt(req.query.tail as string, 10) : undefined;

    const { lines, total } = await agentManager.getLogs(id, { types, tail });

    // Support plain text output for easy piping in agent terminals
    if (req.query.format === "text" || req.headers.accept === "text/plain") {
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

    const query = ((req.query.q as string) || "").toLowerCase();
    const maxResults = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);

    try {
      const files = listFilesRecursive(agent.workspaceDir, agent.workspaceDir, query, maxResults);
      res.json(files);
    } catch {
      res.json([]);
    }
  });

  // Update agent metadata (role, capabilities, currentTask)
  router.patch("/api/agents/:id", (req: Request, res: Response) => {
    const id = param(req.params.id);
    const agent = agentManager.get(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const { role, capabilities, currentTask } = req.body ?? {};
    if (role !== undefined) agent.role = role;
    if (capabilities !== undefined) agent.capabilities = capabilities;
    if (currentTask !== undefined) agent.currentTask = currentTask;
    agentManager.touch(id);
    res.json(agent);
  });

  // Destroy agent
  router.delete("/api/agents/:id", (req: Request, res: Response) => {
    const id = param(req.params.id);

    // Also destroy child agents (spawned by this agent)
    const children = agentManager.list().filter((a) => a.parentId === id);
    for (const child of children) {
      agentManager.destroy(child.id);
      messageBus.cleanupForAgent(child.id);
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
  });

  return router;
}
