import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, MessageType } from "./types";
import { errorMessage } from "./types";

const PERSISTENT_BASE = "/persistent";
const PERSISTENT_AVAILABLE = existsSync(PERSISTENT_BASE);
const DEFAULT_MESSAGES_FILE = PERSISTENT_AVAILABLE ? `${PERSISTENT_BASE}/messages.json` : "/tmp/messages.json";

// Cap stored messages to prevent unbounded growth
const MAX_MESSAGES = 500;

export class MessageBus {
  private messages: AgentMessage[] = [];
  private listeners = new Set<(msg: AgentMessage) => void>();
  private readonly messagesFile: string;

  constructor(messagesFile?: string) {
    this.messagesFile = messagesFile ?? DEFAULT_MESSAGES_FILE;
    this.loadFromDisk();
  }

  post(opts: {
    from: string;
    fromName?: string;
    to?: string;
    channel?: string;
    type: MessageType;
    content: string;
    metadata?: Record<string, unknown>;
    excludeRoles?: string[];
  }): AgentMessage {
    const msg: AgentMessage = {
      id: randomUUID(),
      from: opts.from,
      fromName: opts.fromName,
      to: opts.to,
      channel: opts.channel,
      type: opts.type,
      content: opts.content,
      metadata: opts.metadata,
      createdAt: new Date().toISOString(),
      readBy: [],
      excludeRoles: opts.excludeRoles,
    };

    this.messages.push(msg);

    // Trim old messages if over cap
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }

    this.saveToDisk();

    // Notify real-time listeners
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (err: unknown) {
        console.warn("[messages] Listener error:", errorMessage(err));
      }
    }

    return msg;
  }

  query(opts?: {
    to?: string;
    from?: string;
    channel?: string;
    type?: MessageType;
    unreadBy?: string;
    since?: string;
    limit?: number;
    agentRole?: string;
  }): AgentMessage[] {
    let results = this.messages;

    if (opts?.to) {
      results = results.filter((m) => {
        // Direct message to this agent
        if (m.to === opts.to) return true;

        // Broadcast message - check if agent role is excluded
        if (!m.to) {
          if (m.excludeRoles && opts.agentRole && m.excludeRoles.includes(opts.agentRole)) {
            return false;
          }
          return true;
        }

        return false;
      });
    }
    if (opts?.from) {
      results = results.filter((m) => m.from === opts.from);
    }
    if (opts?.channel) {
      results = results.filter((m) => m.channel === opts.channel);
    }
    if (opts?.type) {
      results = results.filter((m) => m.type === opts.type);
    }
    if (opts?.unreadBy) {
      results = results.filter((m) => !m.readBy.includes(opts.unreadBy as string));
    }
    if (opts?.since) {
      results = results.filter((m) => m.createdAt > (opts.since as string));
    }

    const limit = opts?.limit ?? 100;
    return results.slice(-limit);
  }

  markRead(messageId: string, agentId: string): boolean {
    const msg = this.messages.find((m) => m.id === messageId);
    if (!msg) return false;
    if (!msg.readBy.includes(agentId)) {
      msg.readBy.push(agentId);
      this.saveToDisk();
    }
    return true;
  }

  /** Mark all messages targeted to an agent as read */
  markAllRead(agentId: string, agentRole?: string): number {
    let count = 0;
    for (const msg of this.messages) {
      const isDirectMessage = msg.to === agentId;
      const isBroadcast = !msg.to;
      const isExcluded = isBroadcast && msg.excludeRoles && agentRole && msg.excludeRoles.includes(agentRole);

      if ((isDirectMessage || (isBroadcast && !isExcluded)) && !msg.readBy.includes(agentId)) {
        msg.readBy.push(agentId);
        count++;
      }
    }
    if (count > 0) this.saveToDisk();
    return count;
  }

  deleteMessage(id: string): boolean {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.messages.splice(idx, 1);
    this.saveToDisk();
    return true;
  }

  /** Subscribe to real-time messages. Returns unsubscribe function. */
  subscribe(listener: (msg: AgentMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Get unread count for an agent */
  unreadCount(agentId: string, agentRole?: string): number {
    return this.messages.filter((m) => {
      const isDirectMessage = m.to === agentId;
      const isBroadcast = !m.to;
      const isExcluded = isBroadcast && m.excludeRoles && agentRole && m.excludeRoles.includes(agentRole);

      return (isDirectMessage || (isBroadcast && !isExcluded)) && !m.readBy.includes(agentId);
    }).length;
  }

  /** Clean up messages from/to a specific agent */
  cleanupForAgent(agentId: string): void {
    this.messages = this.messages.filter((m) => m.from !== agentId && m.to !== agentId);
    this.saveToDisk();
  }

  private loadFromDisk(): void {
    try {
      if (existsSync(this.messagesFile)) {
        const data = readFileSync(this.messagesFile, "utf-8");
        this.messages = JSON.parse(data) as AgentMessage[];
        console.log(`[messages] Loaded ${this.messages.length} messages from disk`);
      }
    } catch (err: unknown) {
      console.warn("[messages] Failed to load messages:", errorMessage(err));
      this.messages = [];
    }
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;

  private saveToDisk(): void {
    if (this.saveTimer) return; // already scheduled
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushToDisk();
    }, 500);
  }

  private async flushToDisk(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      const dir = path.dirname(this.messagesFile);
      mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.messagesFile}.tmp`;
      await writeFile(tmpPath, JSON.stringify(this.messages), "utf-8");
      await rename(tmpPath, this.messagesFile);
    } catch (err: unknown) {
      console.warn("[messages] Failed to save messages:", errorMessage(err));
    } finally {
      this.saving = false;
    }
  }
}
