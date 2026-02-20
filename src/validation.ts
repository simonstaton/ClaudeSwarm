import type { NextFunction, Request, Response } from "express";
import { ALLOWED_MODELS, BLOCKED_COMMAND_PATTERNS, MAX_PROMPT_LENGTH, MAX_TURNS } from "./guardrails";
import type { AuthenticatedRequest } from "./types";

// Simple in-memory token bucket rate limiter
const buckets = new Map<string, { tokens: number; lastRefill: number }>();
const RATE_LIMIT = 120; // requests per minute (sized for high-concurrency agent workloads)
const REFILL_INTERVAL_MS = 60_000;

// Cleanup old rate limiter buckets to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > 5 * 60_000) {
      buckets.delete(key);
    }
  }
}, 60_000);

/** Sanitize agent name: alphanumeric, hyphens, underscores, spaces only. Max 50 chars. */
export function sanitizeAgentName(name: string): string {
  if (!name || typeof name !== "string") return "agent";
  return (
    name
      .replace(/[^a-zA-Z0-9\-_ ]/g, "")
      .trim()
      .slice(0, 50) || "agent"
  );
}

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  let bucket = buckets.get(userId);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT, lastRefill: now };
    buckets.set(userId, bucket);
  }

  const elapsed = now - bucket.lastRefill;
  if (elapsed >= REFILL_INTERVAL_MS) {
    bucket.tokens = RATE_LIMIT;
    bucket.lastRefill = now;
  }

  if (bucket.tokens <= 0) return false;
  bucket.tokens--;
  return true;
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;
  if (!user) {
    next();
    return;
  }

  // Use per-identity key instead of shared JWT sub claim to prevent bucket sharing.
  // For agents: extract agent ID from request path if available, fall back to IP.
  // For users: use client IP (X-Forwarded-For on Cloud Run, or req.ip).
  const agentIdMatch = req.path.match(/^\/api\/agents\/([0-9a-f-]+)/);
  const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
  const identity = agentIdMatch ? agentIdMatch[1] : clientIp;

  if (!checkRateLimit(identity)) {
    res.status(429).json({ error: "Rate limit exceeded. Try again in a minute." });
    return;
  }
  next();
}

/** Pure validation for an agent creation spec. Returns an error string or null if valid.
 *  Mutates `spec` to sanitize name and normalize maxTurns. */
export function validateAgentSpec(spec: {
  prompt?: unknown;
  model?: string;
  name?: string;
  maxTurns?: unknown;
}): string | null {
  if (typeof spec.prompt !== "string" || !(spec.prompt as string).trim()) {
    return "prompt is required and must be a non-empty string";
  }
  if ((spec.prompt as string).length > MAX_PROMPT_LENGTH) {
    return `prompt exceeds max length of ${MAX_PROMPT_LENGTH}`;
  }
  if (spec.maxTurns !== undefined) {
    const turns = Number(spec.maxTurns);
    if (Number.isNaN(turns) || turns < 1 || turns > MAX_TURNS) {
      return `maxTurns must be between 1 and ${MAX_TURNS}`;
    }
    spec.maxTurns = turns;
  }
  if (spec.model && !ALLOWED_MODELS.includes(spec.model)) {
    return `model must be one of: ${ALLOWED_MODELS.join(", ")}`;
  }
  if (spec.name !== undefined) {
    spec.name = sanitizeAgentName(spec.name);
  }
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(spec.prompt as string)) {
      return "Prompt contains blocked content";
    }
  }
  return null;
}

export function validateCreateAgent(req: Request, res: Response, next: NextFunction): void {
  const error = validateAgentSpec(req.body ?? {});
  if (error) {
    res.status(400).json({ error });
    return;
  }
  next();
}

export function validateMessage(req: Request, res: Response, next: NextFunction): void {
  const { prompt, maxTurns, attachments } = req.body ?? {};

  // Allow empty prompt only if attachments are present (issue #56)
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const promptText = typeof prompt === "string" ? prompt : "";
  const hasPrompt = promptText.trim().length > 0;

  if (!hasPrompt && !hasAttachments) {
    res.status(400).json({ error: "prompt or attachments are required" });
    return;
  }

  if (hasPrompt && promptText.length > MAX_PROMPT_LENGTH) {
    res.status(400).json({ error: `prompt exceeds max length of ${MAX_PROMPT_LENGTH}` });
    return;
  }

  if (maxTurns !== undefined) {
    const turns = Number(maxTurns);
    if (Number.isNaN(turns) || turns < 1 || turns > MAX_TURNS) {
      res.status(400).json({ error: `maxTurns must be between 1 and ${MAX_TURNS}` });
      return;
    }
    req.body.maxTurns = turns;
  }

  // Layer 5: Apply blocked patterns on message() too, not just create().
  // Closes the gap where an agent gets an innocent initial prompt, then receives
  // blocked content via follow-up messages.
  if (hasPrompt) {
    for (const pattern of BLOCKED_COMMAND_PATTERNS) {
      if (pattern.test(promptText)) {
        res.status(400).json({ error: "Message contains blocked content" });
        return;
      }
    }
  }

  next();
}

/** Validate PATCH /api/agents/:id request.
 *  Enforces whitelist of allowed fields (role, currentTask, name) to prevent prompt injection.
 *  Rejects any fields not in the whitelist and enforces max lengths on string fields.
 */
export function validatePatchAgent(req: Request, res: Response, next: NextFunction): void {
  const body = req.body ?? {};

  // Define allowed fields and their max lengths
  const ALLOWED_FIELDS = {
    role: 100,
    currentTask: 1000,
    name: 100,
  };

  // Extract only allowed fields from the request body
  const sanitized: Record<string, unknown> = {};
  const providedFields = Object.keys(body);

  // Check for unauthorized fields
  const unauthorizedFields = providedFields.filter((field) => !Object.prototype.hasOwnProperty.call(ALLOWED_FIELDS, field));
  if (unauthorizedFields.length > 0) {
    res.status(400).json({ error: `Unauthorized fields: ${unauthorizedFields.join(", ")}` });
    return;
  }

  // Validate role if provided
  if (body.role !== undefined) {
    if (typeof body.role !== "string") {
      res.status(400).json({ error: "role must be a string" });
      return;
    }
    if (body.role.length > ALLOWED_FIELDS.role) {
      res.status(400).json({ error: `role must not exceed ${ALLOWED_FIELDS.role} characters` });
      return;
    }
    // Strip non-alphanumeric characters (including spaces and underscores are allowed)
    sanitized.role = body.role.replace(/[^a-zA-Z0-9\-_ ]/g, "").trim() || undefined;
  }

  // Validate currentTask if provided
  if (body.currentTask !== undefined) {
    if (typeof body.currentTask !== "string") {
      res.status(400).json({ error: "currentTask must be a string" });
      return;
    }
    if (body.currentTask.length > ALLOWED_FIELDS.currentTask) {
      res.status(400).json({ error: `currentTask must not exceed ${ALLOWED_FIELDS.currentTask} characters` });
      return;
    }
    sanitized.currentTask = body.currentTask;
  }

  // Validate name if provided
  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      res.status(400).json({ error: "name must be a string" });
      return;
    }
    if (body.name.length > ALLOWED_FIELDS.name) {
      res.status(400).json({ error: `name must not exceed ${ALLOWED_FIELDS.name} characters` });
      return;
    }
    sanitized.name = sanitizeAgentName(body.name);
  }

  // Replace request body with sanitized data
  req.body = sanitized;
  next();
}
