import type { ChildProcess } from "node:child_process";
import type { Request } from "express";

export type AgentStatus =
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

export interface AgentUsage {
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  tokenLimit: number;
  tokensRemaining: number;
  estimatedCost: number;
  model: string;
  sessionStart: string;
}

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  workspaceDir: string;
  claudeSessionId?: string;
  createdAt: string;
  lastActivity: string;
  model: string;
  role?: string;
  capabilities?: string[];
  currentTask?: string;
  parentId?: string;
  /** Layer 4: Spawn depth, set immutably at creation time. Depth 1 = top-level agent. */
  depth: number;
  /** Cumulative token usage across all sessions for this agent. */
  usage?: {
    tokensIn: number;
    tokensOut: number;
    estimatedCost: number;
  };
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

export interface CreateAgentRequest {
  prompt: string;
  name?: string;
  model?: string;
  maxTurns?: number;
  role?: string;
  capabilities?: string[];
  parentId?: string;
  attachments?: PromptAttachment[];
  /** When true, passes --dangerously-skip-permissions to the Claude CLI, bypassing all
   *  permission confirmations. Defaults to false (agents must confirm tool use). */
  dangerouslySkipPermissions?: boolean;
}

export interface PromptAttachment {
  name: string;
  type: "image" | "file";
  /** Data URL for images, text content for files */
  data: string;
  mime: string;
}

export interface AgentProcess {
  agent: Agent;
  proc: ChildProcess | null;
  lineBuffer: string;
  listeners: Set<(event: StreamEvent) => void>;
  /** Track which API message IDs we have already counted usage for. */
  seenMessageIds: Set<string>;
  /** WI-1: Prevents multiple setImmediate scheduling for line processing. */
  processingScheduled: boolean;
  /** WI-1: Accumulated JSONL lines for batched disk write. */
  persistBatch: string;
  /** WI-1: Timer for coalesced disk writes (16ms window). */
  persistTimer: ReturnType<typeof setTimeout> | null;
  /** WI-1: Events buffered for coalesced listener notification. */
  listenerBatch: StreamEvent[];
  /** WI-4: Consecutive stall detection count - escalates to error after threshold. */
  stallCount: number;
  /** Ring buffer of recent events for fast reconnect replay (avoids disk reads). */
  eventBuffer: StreamEvent[];
  /** Total number of events ever appended (used to compute ring buffer offset). */
  eventBufferTotal: number;
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

export interface AuthPayload {
  sub: string;
  iat: number;
  exp: number;
  agentId?: string;
}

/** Express Request with authenticated user context attached by authMiddleware */
export interface AuthenticatedRequest extends Request {
  user?: AuthPayload;
}

/** Safely extract an error message from an unknown catch value */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
