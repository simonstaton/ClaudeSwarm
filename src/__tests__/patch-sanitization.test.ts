import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validatePatchAgent } from "../validation";

function mockReq(body: Record<string, unknown> = {}): Request {
  return { body } as unknown as Request;
}

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

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
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("capabilities") }));
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
      // < and > are stripped; alphanumeric letters are preserved
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

    it("preserves currentTask content as-is", () => {
      const task = "Deploy feature X, run tests, update docs";
      const req = mockReq({ currentTask: task });
      const res = mockRes();
      validatePatchAgent(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.body.currentTask).toBe(task);
    });

    it("sanitizes name using sanitizeAgentName", () => {
      const req = mockReq({ name: "my-agent/../etc/passwd" });
      const res = mockRes();
      validatePatchAgent(req, res, next);
      expect(next).toHaveBeenCalled();
      // sanitizeAgentName strips path chars
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
