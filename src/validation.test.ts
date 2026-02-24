import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PROMPT_LENGTH, MAX_TURNS } from "./guardrails";
import {
  rateLimitMiddleware,
  sanitizeAgentName,
  validateCreateAgent,
  validateMessage,
  validatePatchAgent,
} from "./validation";

function mockReq(
  body: Record<string, unknown> = {},
  user?: { sub: string },
  path = "/api/agents",
  ip = "127.0.0.1",
): Request {
  return { body, user, path, headers: {}, ip } as unknown as Request;
}

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

describe("validateCreateAgent", () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it("rejects missing prompt", () => {
    const res = mockRes();
    validateCreateAgent(mockReq({}), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects empty prompt", () => {
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: "  " }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("accepts valid prompt", () => {
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: "Hello world" }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it("accepts boolean dangerouslySkipPermissions", () => {
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: "Hello world", dangerouslySkipPermissions: true }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects non-boolean dangerouslySkipPermissions", () => {
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: "Hello world", dangerouslySkipPermissions: "true" }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "dangerouslySkipPermissions must be a boolean" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects invalid model", () => {
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: "test", model: "gpt-4" }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("accepts valid model", () => {
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: "test", model: "claude-opus-4-6" }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects maxTurns out of range", () => {
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: "test", maxTurns: 0 }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("coerces maxTurns to number", () => {
    const req = mockReq({ prompt: "test", maxTurns: "5" });
    const res = mockRes();
    validateCreateAgent(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.body.maxTurns).toBe(5);
  });

  it("rejects blocked content", () => {
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: "DROP TABLE users;" }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Prompt contains blocked content" });
  });

  it("rejects prompt at MAX_PROMPT_LENGTH + 1", () => {
    const longPrompt = "x".repeat(MAX_PROMPT_LENGTH + 1);
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: longPrompt }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: `prompt exceeds max length of ${MAX_PROMPT_LENGTH}`,
    });
  });

  it("accepts prompt at exactly MAX_PROMPT_LENGTH", () => {
    const exactPrompt = "x".repeat(MAX_PROMPT_LENGTH);
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: exactPrompt }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects maxTurns = MAX_TURNS + 1", () => {
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: "test", maxTurns: MAX_TURNS + 1 }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("accepts maxTurns = MAX_TURNS", () => {
    const req = mockReq({ prompt: "test", maxTurns: MAX_TURNS });
    const res = mockRes();
    validateCreateAgent(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects DELETE FROM with WHERE clause", () => {
    const res = mockRes();
    validateCreateAgent(mockReq({ prompt: "DELETE FROM users WHERE id=1" }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Prompt contains blocked content" });
  });

  it("sanitizes agent name", () => {
    const req = mockReq({ prompt: "test", name: "my-agent/../../../etc/passwd" });
    const res = mockRes();
    validateCreateAgent(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.body.name).toBe("my-agentetcpasswd");
  });
});

describe("validateMessage", () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it("rejects missing prompt", () => {
    const res = mockRes();
    validateMessage(mockReq({}), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("accepts valid prompt", () => {
    const res = mockRes();
    validateMessage(mockReq({ prompt: "What time is it?" }), res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe("rateLimitMiddleware", () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it("passes through when no user", () => {
    const res = mockRes();
    rateLimitMiddleware(mockReq({}), res, next);
    expect(next).toHaveBeenCalled();
  });

  it("passes through for authenticated users within limit", () => {
    const res = mockRes();
    rateLimitMiddleware(mockReq({}, { sub: "test-rate-limit-pass" }, "/api/agents", "10.0.0.1"), res, next);
    expect(next).toHaveBeenCalled();
  });

  it("blocks user after exceeding rate limit", () => {
    const user = { sub: "test-rate-limit-block" };
    const res = mockRes();

    // Make 120 requests (the limit) - use unique IP to isolate from other tests
    for (let i = 0; i < 120; i++) {
      const mockNext = vi.fn();
      rateLimitMiddleware(mockReq({}, user, "/api/agents", "10.0.0.2"), mockRes(), mockNext);
      expect(mockNext).toHaveBeenCalled();
    }

    // 121st request should be blocked
    rateLimitMiddleware(mockReq({}, user, "/api/agents", "10.0.0.2"), res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ error: "Rate limit exceeded. Try again in a minute." });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("validatePatchAgent", () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  describe("whitelist enforcement", () => {
    it("accepts all whitelisted fields", () => {
      const req = mockReq({ role: "engineer", currentTask: "doing work", name: "my-agent" });
      const res = mockRes();
      validatePatchAgent(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("accepts empty body", () => {
      const req = mockReq({});
      const res = mockRes();
      validatePatchAgent(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it("rejects prompt field (not whitelisted)", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ prompt: "evil prompt" }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("prompt") }));
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects capabilities field (not whitelisted)", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ capabilities: ["admin"] }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("capabilities") }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects model field (not whitelisted)", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ model: "claude-opus-4-6" }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects mixed authorized and unauthorized fields", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ role: "engineer", prompt: "evil" }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects prototype pollution attempts", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ __proto__: "malicious", constructor: "dangerous" }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("max length enforcement", () => {
    it("accepts role at max length (100 chars)", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ role: "a".repeat(100) }), res, next);
      expect(next).toHaveBeenCalled();
    });

    it("rejects role exceeding max length (101 chars)", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ role: "a".repeat(101) }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("100") }));
      expect(next).not.toHaveBeenCalled();
    });

    it("accepts currentTask at max length (1000 chars)", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ currentTask: "a".repeat(1000) }), res, next);
      expect(next).toHaveBeenCalled();
    });

    it("rejects currentTask exceeding max length (1001 chars)", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ currentTask: "a".repeat(1001) }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("1000") }));
      expect(next).not.toHaveBeenCalled();
    });

    it("accepts name at max length (100 chars)", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ name: "a".repeat(100) }), res, next);
      expect(next).toHaveBeenCalled();
    });

    it("rejects name exceeding max length (101 chars)", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ name: "a".repeat(101) }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("100") }));
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("type validation", () => {
    it("rejects non-string role", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ role: 123 }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects non-string currentTask", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ currentTask: { nested: "exploit" } }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects non-string name", () => {
      const res = mockRes();
      validatePatchAgent(mockReq({ name: ["array"] }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("sanitization", () => {
    it("strips angle brackets from role", () => {
      const req = mockReq({ role: "senior-eng<script>" });
      const res = mockRes();
      validatePatchAgent(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.body.role).toBe("senior-engscript");
      expect(req.body.role).not.toContain("<");
      expect(req.body.role).not.toContain(">");
    });

    it("preserves hyphens and underscores in role", () => {
      const req = mockReq({ role: "senior-well_done" });
      const res = mockRes();
      validatePatchAgent(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.body.role).toBe("senior-well_done");
    });

    it("trims whitespace from role", () => {
      const req = mockReq({ role: "  engineer  " });
      const res = mockRes();
      validatePatchAgent(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.body.role).toBe("engineer");
    });

    it("removes role key when sanitized value is empty", () => {
      const req = mockReq({ role: "!!!***" });
      const res = mockRes();
      validatePatchAgent(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.body.role).toBeUndefined();
    });

    it("sanitizes currentTask (alphanumeric, hyphens, underscores, spaces) for safe UI display", () => {
      const task = "Deploy feature X, run tests, update docs";
      const req = mockReq({ currentTask: task });
      const res = mockRes();
      validatePatchAgent(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.body.currentTask).toBe("Deploy feature X run tests update docs");
    });

    it("sanitizes name using sanitizeAgentName", () => {
      const req = mockReq({ name: "my-agent/../etc/passwd" });
      const res = mockRes();
      validatePatchAgent(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.body.name).not.toContain("/");
      expect(req.body.name).not.toContain(".");
    });

    it("replaces req.body with sanitized fields only", () => {
      const req = mockReq({ role: "eng", currentTask: "do work" });
      const res = mockRes();
      validatePatchAgent(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(Object.keys(req.body)).toEqual(expect.arrayContaining(["role", "currentTask"]));
      expect(Object.keys(req.body).length).toBe(2);
    });
  });
});

describe("sanitizeAgentName", () => {
  it("removes path separators", () => {
    expect(sanitizeAgentName("my-agent/../test")).toBe("my-agenttest");
    expect(sanitizeAgentName("agent/subdir")).toBe("agentsubdir");
  });

  it("removes dots at start", () => {
    expect(sanitizeAgentName("..hidden")).toBe("hidden");
    expect(sanitizeAgentName(".config")).toBe("config");
  });

  it("keeps alphanumeric, hyphens, underscores, and spaces", () => {
    expect(sanitizeAgentName("My Agent_123-v2")).toBe("My Agent_123-v2");
  });

  it("removes special characters", () => {
    expect(sanitizeAgentName("agent@#$%^&*()")).toBe("agent");
    expect(sanitizeAgentName("test<script>alert(1)</script>")).toBe("testscriptalert1script");
  });

  it("truncates to 50 characters", () => {
    const longName = "a".repeat(100);
    expect(sanitizeAgentName(longName)).toHaveLength(50);
  });

  it("returns 'agent' for empty or invalid input", () => {
    expect(sanitizeAgentName("")).toBe("agent");
    expect(sanitizeAgentName("@#$%")).toBe("agent");
    // biome-ignore lint/suspicious/noExplicitAny: test
    expect(sanitizeAgentName(null as any)).toBe("agent");
  });

  it("trims whitespace", () => {
    expect(sanitizeAgentName("  my-agent  ")).toBe("my-agent");
  });
});
