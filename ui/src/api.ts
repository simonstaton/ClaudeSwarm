"use client";

export interface Agent {
  id: string;
  name: string;
  status:
    | "starting"
    | "running"
    | "idle"
    | "error"
    | "restored"
    | "killing"
    | "destroying"
    | "paused"
    | "stalled"
    | "disconnected";
  workspaceDir: string;
  dangerouslySkipPermissions?: boolean;
  claudeSessionId?: string;
  createdAt: string;
  lastActivity: string;
  model: string;
  role?: string;
  capabilities?: string[];
  currentTask?: string;
  parentId?: string;
  gitBranch?: string;
  gitRepo?: string;
  gitWorktree?: string;
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

export interface TopologyNode {
  id: string;
  name: string;
  status:
    | "starting"
    | "running"
    | "idle"
    | "error"
    | "restored"
    | "killing"
    | "destroying"
    | "paused"
    | "stalled"
    | "disconnected";
  role?: string;
  model: string;
  depth: number;
  currentTask?: string;
  parentId?: string;
  lastActivity: string;
  tokensUsed: number;
  tokensSpent: number;
  estimatedCost: number;
}

export interface TopologyEdge {
  source: string;
  target: string;
}

export interface AgentTopology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export type TaskStatus = "pending" | "assigned" | "running" | "completed" | "failed" | "blocked" | "cancelled";
export type TaskPriority = 0 | 1 | 2 | 3 | 4;

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  ownerAgentId: string | null;
  parentTaskId: string | null;
  input: Record<string, unknown> | null;
  expectedOutput: Record<string, unknown> | null;
  acceptanceCriteria: string | null;
  requiredCapabilities: string[];
  dependsOn: string[];
  version: number;
  retryCount: number;
  maxRetries: number;
  timeoutMs: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskSummary {
  total: number;
  byStatus: Record<TaskStatus, number>;
  blockedChains: number;
}

export interface OrchestratorStatus {
  running: boolean;
  taskSummary: TaskSummary;
  recentEvents: OrchestratorEvent[];
  agentProfiles: Array<{
    agentId: string;
    totalCompleted: number;
    totalFailed: number;
    topCapabilities: Array<{ capability: string; successRate: number }>;
  }>;
}

export interface OrchestratorEvent {
  type: string;
  timestamp: string;
  details: Record<string, unknown>;
}

export interface AgentMetadata {
  pid: number | null;
  uptime: number;
  workingDir: string;
  repo: string | null;
  branch: string | null;
  worktreePath: string | null;
  tokensIn: number;
  tokensOut: number;
  estimatedCost: number;
  model: string;
  sessionId: string | null;
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

export interface Repository {
  name: string;
  dirName: string;
  url: string | null;
  path: string;
  hasActiveAgents: boolean;
  activeAgentCount: number;
  activeAgents: Array<{ id: string; name: string }>;
}

export type RiskLevel = "low" | "medium" | "high";

export interface GradeResult {
  taskId: string;
  agentId: string;
  ticketClarity: "high" | "medium" | "low";
  fixConfidence: "high" | "medium" | "low";
  blastRadius: "isolated" | "moderate" | "broad";
  overallRisk: RiskLevel;
  reasoning?: string;
  createdAt: string;
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

    async getAgentMetadata(id: string): Promise<AgentMetadata> {
      const res = await authFetch(`/api/agents/${id}/metadata`);
      if (!res.ok) throw new Error("Failed to fetch agent metadata");
      return res.json();
    },

    async patchAgent(
      id: string,
      patch: { dangerouslySkipPermissions?: boolean; role?: string; currentTask?: string; name?: string },
    ): Promise<Agent> {
      const res = await authFetch(`/api/agents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Failed to update agent");
      return res.json();
    },

    createAgentStream(opts: {
      prompt: string;
      name?: string;
      model?: string;
      maxTurns?: number;
      dangerouslySkipPermissions?: boolean;
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
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions ?? false,
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
        // Don't close on `done` - the reconnect stream replays historical events
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

    async fetchTopology(): Promise<AgentTopology> {
      const res = await authFetch("/api/agents/topology");
      if (!res.ok) throw new Error("Failed to fetch topology");
      return res.json();
    },

    async destroyAgent(id: string): Promise<void> {
      const res = await authFetch(`/api/agents/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to destroy agent");
    },

    async pauseAgent(id: string): Promise<void> {
      const res = await authFetch(`/api/agents/${id}/pause`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Failed to pause agent");
      }
    },

    async resumeAgent(id: string): Promise<void> {
      const res = await authFetch(`/api/agents/${id}/resume`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Failed to resume agent");
      }
    },

    async clearAgentContext(id: string): Promise<{ ok: boolean; tokensCleared: number }> {
      const res = await authFetch(`/api/agents/${id}/clear-context`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Failed to clear agent context");
      }
      return res.json();
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
    async getSettings(): Promise<{
      anthropicKeyHint: string;
      keyMode: "openrouter" | "anthropic";
      models: string[];
      guardrails: {
        maxPromptLength: number;
        maxTurns: number;
        maxAgents: number;
        maxBatchSize: number;
        maxAgentDepth: number;
        maxChildrenPerAgent: number;
        sessionTtlMs: number;
      };
      integrations?: Record<string, { configured: boolean; authMethod: string }>;
      linearConfigured?: boolean;
    }> {
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

    async updateGuardrails(settings: {
      maxPromptLength?: number;
      maxTurns?: number;
      maxAgents?: number;
      maxBatchSize?: number;
      maxAgentDepth?: number;
      maxChildrenPerAgent?: number;
      sessionTtlMs?: number;
    }): Promise<{
      ok: boolean;
      guardrails: {
        maxPromptLength: number;
        maxTurns: number;
        maxAgents: number;
        maxBatchSize: number;
        maxAgentDepth: number;
        maxChildrenPerAgent: number;
        sessionTtlMs: number;
      };
    }> {
      const res = await authFetch("/api/settings/guardrails", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update guardrails");
      }
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

    async clearAllMessages(): Promise<{ ok: boolean; deleted: number }> {
      const res = await authFetch("/api/messages", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to clear messages");
      return res.json();
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

    // Download agent logs as a text file
    async downloadAgentLogs(id: string, agentName: string): Promise<void> {
      const res = await authFetch(`/api/agents/${id}/logs?format=text`);
      if (!res.ok) throw new Error("Failed to download logs");
      const text = await res.text();
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${agentName}-log.txt`;
      a.click();
      URL.revokeObjectURL(url);
    },

    // Cost / usage
    async fetchCostSummary(): Promise<{
      totalTokens: number;
      totalCost: number;
      agentCount: number;
      agents: Array<{
        agentId: string;
        agentName: string;
        tokensUsed: number;
        estimatedCost: number;
        createdAt: string;
        status: string;
      }>;
      allTime: {
        totalCost: number;
        totalTokensIn: number;
        totalTokensOut: number;
        totalRecords: number;
      };
      spendLimit: number | null;
      spendLimitExceeded: boolean;
    }> {
      const res = await authFetch("/api/cost/summary");
      if (!res.ok) throw new Error(`Failed to fetch cost data: ${res.statusText}`);
      return res.json();
    },

    async fetchCostHistory(limit = 500): Promise<{
      records: Array<{
        agentId: string;
        agentName: string;
        model: string;
        tokensIn: number;
        tokensOut: number;
        estimatedCost: number;
        createdAt: string;
        closedAt: string | null;
      }>;
      summary: {
        allTimeCost: number;
        allTimeTokensIn: number;
        allTimeTokensOut: number;
        totalRecords: number;
      };
    }> {
      const res = await authFetch(`/api/cost/history?limit=${limit}`);
      if (!res.ok) throw new Error(`Failed to fetch cost history: ${res.statusText}`);
      return res.json();
    },

    async resetCostHistory(): Promise<{ ok: boolean; deleted: number }> {
      const res = await authFetch("/api/cost/history", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to reset cost history");
      return res.json();
    },

    async fetchSpendLimit(): Promise<{ spendLimit: number | null }> {
      const res = await authFetch("/api/cost/limit");
      if (!res.ok) throw new Error("Failed to fetch spend limit");
      return res.json();
    },

    async setSpendLimit(spendLimit: number | null): Promise<{ ok: boolean; spendLimit: number | null }> {
      const res = await authFetch("/api/cost/limit", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spendLimit }),
      });
      if (!res.ok) throw new Error("Failed to set spend limit");
      return res.json();
    },

    // Tasks
    async fetchTasks(opts?: { status?: TaskStatus; ownerAgentId?: string; limit?: number }): Promise<TaskNode[]> {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.ownerAgentId) params.set("ownerAgentId", opts.ownerAgentId);
      if (opts?.limit) params.set("limit", String(opts.limit));
      const res = await authFetch(`/api/tasks?${params}`);
      if (!res.ok) throw new Error("Failed to fetch tasks");
      return res.json();
    },

    async fetchTaskSummary(): Promise<TaskSummary> {
      const res = await authFetch("/api/tasks/summary");
      if (!res.ok) throw new Error("Failed to fetch task summary");
      return res.json();
    },

    async createTask(data: {
      title: string;
      description?: string;
      priority?: TaskPriority;
      dependsOn?: string[];
      requiredCapabilities?: string[];
    }): Promise<TaskNode> {
      const res = await authFetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to create task");
      }
      return res.json();
    },

    async deleteTask(id: string): Promise<void> {
      const res = await authFetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete task");
    },

    async clearAllTasks(): Promise<{ deleted: number }> {
      const res = await authFetch("/api/tasks?confirm=true", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to clear tasks");
      return res.json();
    },

    async assignTask(taskId: string, agentId: string): Promise<TaskNode> {
      const res = await authFetch(`/api/tasks/${taskId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to assign task");
      }
      return res.json();
    },

    async cancelTask(taskId: string): Promise<TaskNode> {
      const res = await authFetch(`/api/tasks/${taskId}/cancel`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to cancel task");
      }
      return res.json();
    },

    async retryTask(taskId: string): Promise<TaskNode> {
      const res = await authFetch(`/api/tasks/${taskId}/retry`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to retry task");
      }
      return res.json();
    },

    async fetchOrchestratorStatus(): Promise<OrchestratorStatus> {
      const res = await authFetch("/api/orchestrator/status");
      if (!res.ok) throw new Error("Failed to fetch orchestrator status");
      return res.json();
    },

    async fetchOrchestratorEvents(limit = 50): Promise<OrchestratorEvent[]> {
      const res = await authFetch(`/api/orchestrator/events?limit=${limit}`);
      if (!res.ok) throw new Error("Failed to fetch orchestrator events");
      return res.json();
    },

    async triggerAssignment(): Promise<{ assignments: Array<{ taskId: string; agentId: string }> }> {
      const res = await authFetch("/api/orchestrator/assign", { method: "POST" });
      if (!res.ok) throw new Error("Failed to trigger assignment");
      return res.json();
    },

    // Confidence grading
    async fetchGrades(opts?: { risk?: RiskLevel; agentId?: string }): Promise<GradeResult[]> {
      const params = new URLSearchParams();
      if (opts?.risk) params.set("risk", opts.risk);
      if (opts?.agentId) params.set("agentId", opts.agentId);
      const res = await authFetch(`/api/grades?${params}`);
      if (!res.ok) return [];
      return res.json();
    },

    async fetchGrade(taskId: string): Promise<GradeResult | null> {
      const res = await authFetch(`/api/grades/${taskId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch grade");
      return res.json();
    },

    async approveGrade(taskId: string): Promise<{ approved: boolean; taskId: string }> {
      const res = await authFetch(`/api/grades/${taskId}/approve`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Failed to approve grade");
      }
      return res.json();
    },

    // Repositories
    async listRepositories(): Promise<{ repositories: Repository[] }> {
      const res = await authFetch("/api/repositories");
      if (!res.ok) throw new Error("Failed to list repositories");
      return res.json();
    },

    async cloneRepository(url: string): Promise<Response> {
      return authFetch("/api/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
    },

    async deleteRepository(name: string): Promise<void> {
      const res = await authFetch(`/api/repositories/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Failed to remove repository");
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
        // Stream aborted (e.g. user sent a new message) - close gracefully
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
