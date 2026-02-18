export interface Agent {
  id: string;
  name: string;
  status: "starting" | "running" | "idle" | "error" | "restored";
  workspaceDir: string;
  claudeSessionId?: string;
  createdAt: string;
  lastActivity: string;
  model: string;
  role?: string;
  capabilities?: string[];
  currentTask?: string;
  parentId?: string;
}

export type MessageType = "task" | "result" | "question" | "info" | "status" | "interrupt";

export interface AgentMessage {
  id: string;
  from: string;
  fromName?: string;
  to?: string;
  channel?: string;
  type: MessageType;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  readBy: string[];
  excludeRoles?: string[];
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: string;
  tool?: string;
  content?: string;
  result?: string;
  text?: string;
  exitCode?: number;
  [key: string]: unknown;
}

export interface ContextFile {
  name: string;
  size: number;
  modified: string;
}

export interface ClaudeConfigFile {
  name: string;
  path: string;
  description: string;
  category: string;
  deletable: boolean;
}

type AuthFetch = (url: string, opts?: RequestInit) => Promise<Response>;

export function createApi(authFetch: AuthFetch) {
  return {
    async fetchAgents(): Promise<Agent[]> {
      const res = await authFetch("/api/agents");
      if (!res.ok) throw new Error("Failed to fetch agents");
      return res.json();
    },

    async getAgent(id: string): Promise<Agent> {
      const res = await authFetch(`/api/agents/${id}`);
      if (!res.ok) throw new Error("Agent not found");
      return res.json();
    },

    createAgentStream(opts: {
      prompt: string;
      name?: string;
      model?: string;
      maxTurns?: number;
      attachments?: Array<{ name: string; type: "image" | "file"; data: string; mime: string }>;
    }): {
      stream: Promise<ReadableStream<StreamEvent>>;
      abort: () => void;
    } {
      const controller = new AbortController();
      const body: Record<string, unknown> = {
        prompt: opts.prompt,
        name: opts.name,
        model: opts.model,
        maxTurns: opts.maxTurns,
      };
      if (opts.attachments && opts.attachments.length > 0) {
        body.attachments = opts.attachments.map((a) => ({
          name: a.name,
          type: a.type,
          data: a.data,
          mime: a.mime,
        }));
      }
      const stream = authFetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).then((res) => {
        if (!res.ok) throw new Error("Failed to create agent");
        return parseSSEStream(res);
      });

      return { stream, abort: () => controller.abort() };
    },

    messageAgentStream(
      id: string,
      prompt: string,
      maxTurns?: number,
      sessionId?: string,
      attachments?: Array<{ name: string; type: "image" | "file"; data: string; mime: string }>,
    ): { stream: Promise<ReadableStream<StreamEvent>>; abort: () => void } {
      const controller = new AbortController();
      const body: Record<string, unknown> = { prompt, maxTurns, sessionId };
      if (attachments && attachments.length > 0) {
        body.attachments = attachments.map((a) => ({
          name: a.name,
          type: a.type,
          data: a.data,
          mime: a.mime,
        }));
      }
      const stream = authFetch(`/api/agents/${id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).then((res) => {
        if (!res.ok) throw new Error("Failed to message agent");
        return parseSSEStream(res);
      });

      return { stream, abort: () => controller.abort() };
    },

    reconnectStream(
      id: string,
      afterIndex?: number,
    ): {
      stream: Promise<ReadableStream<StreamEvent>>;
      abort: () => void;
    } {
      const controller = new AbortController();
      const params = afterIndex != null && afterIndex > 0 ? `?after=${afterIndex}` : "";
      const stream = authFetch(`/api/agents/${id}/events${params}`, {
        signal: controller.signal,
      }).then((res) => {
        if (!res.ok) throw new Error("Failed to reconnect");
        // Don't close on `done` — the reconnect stream replays historical events
        // which include `done` events from previous turns. Closing early would
        // truncate the history and lose subsequent conversation turns.
        return parseSSEStream(res, { closeOnDone: false });
      });

      return { stream, abort: () => controller.abort() };
    },

    async listAgentFiles(id: string, query?: string): Promise<string[]> {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      params.set("limit", "30");
      const res = await authFetch(`/api/agents/${id}/files?${params}`);
      if (!res.ok) return [];
      return res.json();
    },

    async destroyAgent(id: string): Promise<void> {
      const res = await authFetch(`/api/agents/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to destroy agent");
    },

    async readContext(filename: string): Promise<string> {
      const res = await authFetch(`/api/context/file?name=${encodeURIComponent(filename)}`);
      if (!res.ok) throw new Error("Failed to read context file");
      const data = await res.json();
      return data.content;
    },

    async listContext(): Promise<ContextFile[]> {
      const res = await authFetch("/api/context");
      if (!res.ok) return [];
      return res.json();
    },

    async updateContext(filename: string, content: string): Promise<void> {
      const res = await authFetch("/api/context/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: filename, content }),
      });
      if (!res.ok) throw new Error("Failed to update context");
    },

    async deleteContext(filename: string): Promise<void> {
      const res = await authFetch(`/api/context/file?name=${encodeURIComponent(filename)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete context");
    },

    // Claude config
    async listClaudeConfig(): Promise<ClaudeConfigFile[]> {
      const res = await authFetch("/api/claude-config");
      if (!res.ok) return [];
      return res.json();
    },

    async readClaudeConfig(filePath: string): Promise<string> {
      const res = await authFetch(`/api/claude-config/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) throw new Error("Failed to read config");
      const data = await res.json();
      return data.content;
    },

    async writeClaudeConfig(filePath: string, content: string): Promise<void> {
      const res = await authFetch("/api/claude-config/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content }),
      });
      if (!res.ok) throw new Error("Failed to save config");
    },

    async createCommand(name: string, content: string): Promise<ClaudeConfigFile> {
      const res = await authFetch("/api/claude-config/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to create command");
      }
      const data = await res.json();
      return data.file;
    },

    async deleteClaudeConfig(filePath: string): Promise<void> {
      const res = await authFetch(`/api/claude-config/file?path=${encodeURIComponent(filePath)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete config file");
      }
    },

    // Settings
    async getSettings(): Promise<{ anthropicKeyHint: string; keyMode: "openrouter" | "anthropic"; models: string[] }> {
      const res = await authFetch("/api/settings");
      if (!res.ok) throw new Error("Failed to get settings");
      return res.json();
    },

    async setAnthropicKey(key: string): Promise<{ hint: string; keyMode: "openrouter" | "anthropic" }> {
      const res = await authFetch("/api/settings/anthropic-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) throw new Error("Invalid API key format");
      return res.json();
    },

    // Messages
    async fetchMessages(opts?: {
      to?: string;
      from?: string;
      channel?: string;
      type?: MessageType;
      unreadBy?: string;
      limit?: number;
    }): Promise<AgentMessage[]> {
      const params = new URLSearchParams();
      if (opts?.to) params.set("to", opts.to);
      if (opts?.from) params.set("from", opts.from);
      if (opts?.channel) params.set("channel", opts.channel);
      if (opts?.type) params.set("type", opts.type);
      if (opts?.unreadBy) params.set("unreadBy", opts.unreadBy);
      if (opts?.limit) params.set("limit", String(opts.limit));
      const res = await authFetch(`/api/messages?${params}`);
      if (!res.ok) return [];
      return res.json();
    },

    async postMessage(msg: {
      from: string;
      fromName?: string;
      to?: string;
      channel?: string;
      type: MessageType;
      content: string;
      metadata?: Record<string, unknown>;
    }): Promise<AgentMessage> {
      const res = await authFetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg),
      });
      if (!res.ok) throw new Error("Failed to post message");
      return res.json();
    },

    async deleteMessage(id: string): Promise<void> {
      const res = await authFetch(`/api/messages/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete message");
    },

    // Kill switch
    async getKillSwitchState(): Promise<{ killed: boolean; reason?: string; activatedAt?: string }> {
      const res = await authFetch("/api/kill-switch");
      if (!res.ok) throw new Error("Failed to get kill switch state");
      return res.json();
    },

    async activateKillSwitch(reason?: string): Promise<void> {
      const res = await authFetch("/api/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "activate", reason }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Failed to activate kill switch");
      }
    },

    async deactivateKillSwitch(): Promise<void> {
      const res = await authFetch("/api/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deactivate" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Failed to deactivate kill switch");
      }
    },
  };
}

interface ParseSSEOptions {
  /** When false, `done`/`destroyed` events are enqueued but don't close the stream. Default: true. */
  closeOnDone?: boolean;
}

function parseSSEStream(res: Response, options: ParseSSEOptions = {}): ReadableStream<StreamEvent> {
  const { closeOnDone = true } = options;

  if (!res.body) throw new Error("Response body is null");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream<StreamEvent>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            // Skip heartbeat comments and empty lines
            if (line.startsWith(":") || line.startsWith("id:") || !line.trim()) continue;

            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6)) as StreamEvent;
                controller.enqueue(event);

                if (closeOnDone && (event.type === "done" || event.type === "destroyed")) {
                  // Release the underlying reader so the fetch body is freed
                  reader.cancel();
                  controller.close();
                  return;
                }
              } catch {
                // Skip unparseable lines
              }
            }
          }
        }
      } catch (err: unknown) {
        // Always release the underlying reader on error to prevent leaks
        reader.cancel().catch(() => {});
        // Stream aborted (e.g. user sent a new message) — close gracefully
        if (err instanceof DOMException && err.name === "AbortError") {
          controller.close();
        } else {
          controller.error(err);
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}
