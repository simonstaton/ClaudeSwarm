import express, { type Request, type Response } from "express";
import type { MessageBus } from "../messages";
import type { AgentMessage } from "../types";
import { param } from "../utils/express";

export function createMessagesRouter(messageBus: MessageBus) {
  const router = express.Router();

  // Post a message
  router.post("/api/messages", (req: Request, res: Response) => {
    const { from, fromName, to, channel, type, content, metadata, excludeRoles } = req.body ?? {};
    if (!from || typeof from !== "string") {
      res.status(400).json({ error: "from is required" });
      return;
    }
    if (!type || !["task", "result", "question", "info", "status", "interrupt"].includes(type)) {
      res.status(400).json({ error: "type must be one of: task, result, question, info, status, interrupt" });
      return;
    }
    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "content is required" });
      return;
    }
    if (content.length > 50_000) {
      res.status(400).json({ error: "content exceeds max length of 50000" });
      return;
    }
    if (excludeRoles && !Array.isArray(excludeRoles)) {
      res.status(400).json({ error: "excludeRoles must be an array" });
      return;
    }

    const msg = messageBus.post({ from, fromName, to, channel, type, content, metadata, excludeRoles });
    res.json(msg);
  });

  // Query messages
  router.get("/api/messages", (req: Request, res: Response) => {
    const { to, from, channel, type, unreadBy, since, limit, agentRole } = req.query;
    const messages = messageBus.query({
      to: to as string,
      from: from as string,
      channel: channel as string,
      type: type as AgentMessage["type"],
      unreadBy: unreadBy as string,
      since: since as string,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      agentRole: agentRole as string,
    });
    res.json(messages);
  });

  // Mark message as read
  router.post("/api/messages/:id/read", (req: Request, res: Response) => {
    const { agentId } = req.body ?? {};
    if (!agentId || typeof agentId !== "string") {
      res.status(400).json({ error: "agentId is required" });
      return;
    }
    if (messageBus.markRead(param(req.params.id), agentId)) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: "Message not found" });
    }
  });

  // Mark all as read for agent
  router.post("/api/messages/read-all", (req: Request, res: Response) => {
    const { agentId, agentRole } = req.body ?? {};
    if (!agentId || typeof agentId !== "string") {
      res.status(400).json({ error: "agentId is required" });
      return;
    }
    const count = messageBus.markAllRead(agentId, agentRole);
    res.json({ ok: true, markedRead: count });
  });

  // Delete a message
  router.delete("/api/messages/:id", (req: Request, res: Response) => {
    if (messageBus.deleteMessage(param(req.params.id))) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: "Message not found" });
    }
  });

  // SSE stream for real-time messages
  router.get("/api/messages/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const agentFilter = req.query.agentId as string | undefined;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    const unsubscribe = messageBus.subscribe((msg: AgentMessage) => {
      if (closed) return;
      // If filtering by agent, only send messages relevant to that agent
      if (agentFilter && msg.to !== agentFilter && msg.from !== agentFilter && msg.to !== undefined) {
        return;
      }
      try {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      } catch {
        // Defer cleanup — we may be inside the subscriber iteration
        setImmediate(() => cleanup());
      }
    });

    const heartbeat = setInterval(() => {
      if (closed) {
        clearInterval(heartbeat);
        return;
      }
      // Detect connections destroyed by the proxy/client without a 'close' event
      if (res.destroyed || res.writableEnded) {
        cleanup();
        return;
      }
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        cleanup();
      }
    }, 15_000);

    res.on("close", () => {
      cleanup();
    });
  });

  return router;
}
