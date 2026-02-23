import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { isExemptFromAuth } from "./exempt-paths";
import { logger } from "./logger";
import { resetSanitizeCache } from "./sanitize";
import type { AuthenticatedRequest, AuthPayload } from "./types";

if (!process.env.JWT_SECRET) {
  logger.error("FATAL: JWT_SECRET environment variable is not set. Exiting.");
  process.exit(1);
}

// Use mutable `let` so rotateJwtSecret() takes effect immediately for all sign/verify calls.
let jwtSecret = process.env.JWT_SECRET;
const apiKey = process.env.API_KEY || "";

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Rotate the JWT secret in-memory.
 * All tokens signed with the old secret are immediately invalidated.
 * Called on kill-switch activation and deactivation.
 */
export function rotateJwtSecret(): string {
  const newSecret = crypto.randomBytes(32).toString("hex");
  jwtSecret = newSecret;
  process.env.JWT_SECRET = newSecret;
  // Reset sanitize cache so the new secret value gets redacted in logs
  resetSanitizeCache();
  logger.info("[auth] JWT secret rotated - all existing tokens invalidated");
  return newSecret;
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

function signJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", jwtSecret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token: string): AuthPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;
  const expected = crypto.createHmac("sha256", jwtSecret).update(`${header}.${body}`).digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);

  // timingSafeEqual requires buffers of same length
  if (sigBuf.length !== expectedBuf.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as AuthPayload;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function exchangeKeyForToken(apiKey: string): string | null {
  const storedKey = process.env.API_KEY || "";
  if (!storedKey) return null;
  const provided = Buffer.from(apiKey);
  const expected = Buffer.from(storedKey);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }

  const now = unixNow();
  return signJwt({
    sub: "user",
    iat: now,
    exp: now + 86400, // 24h
  });
}

/** Exported for unit tests (auth.test.ts). */
export function verifyToken(token: string): AuthPayload | null {
  return verifyJwt(token);
}

/** Generate a short-lived service token for agents to call the platform API.
 *  Reduced from 7 days to 4 hours to limit blast radius if a token leaks.
 *  Optionally binds the token to a specific agent ID for audit attribution. */
export function generateServiceToken(agentId?: string): string {
  const now = unixNow();
  return signJwt({
    sub: "agent-service",
    ...(agentId && { agentId }),
    iat: now,
    exp: now + 4 * 3600, // 4 hours (was: 7 days)
  });
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for health and token exchange (see src/exempt-paths.ts)
  if (isExemptFromAuth(req.path)) {
    next();
    return;
  }

  // Skip auth for non-API routes (static files)
  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }

  // Try Bearer token first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const payload = verifyJwt(authHeader.slice(7));
    if (payload) {
      (req as AuthenticatedRequest).user = payload;
      next();
      return;
    }
  }

  // Fall back to x-api-key for backward compat
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;
  if (apiKeyHeader && apiKey) {
    const provided = Buffer.from(apiKeyHeader);
    const expected = Buffer.from(apiKey);
    if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
      const now = unixNow();
      (req as AuthenticatedRequest).user = { sub: "api-key-user", iat: now, exp: now + 86400 };
      next();
      return;
    }
  }

  res.status(401).json({ error: "Unauthorized" });
}

/**
 * Middleware: reject requests from agent-service tokens (403).
 * Use on routes that only human users (or API key) may call.
 */
export function requireHumanUser(req: Request, res: Response, next: NextFunction): void {
  if ((req as AuthenticatedRequest).user?.sub === "agent-service") {
    res.status(403).json({ error: "This action is not allowed for agent service tokens" });
    return;
  }
  next();
}
