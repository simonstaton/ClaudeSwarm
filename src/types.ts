import type { ChildProcess } from "node:child_process";
import type { Request } from "express";

export type AgentStatus = "starting" | "running" | "idle" | "error" | "restored" | "killing" | "destroying";

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
}

export interface AuthPayload {
  sub: string;
  iat: number;
  exp: number;
}

/** Express Request with authenticated user context attached by authMiddleware */
export interface AuthenticatedRequest extends Request {
  user?: AuthPayload;
}

/** Safely extract an error message from an unknown catch value */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
