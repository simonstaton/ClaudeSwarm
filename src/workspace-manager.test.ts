import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "./types";
import { WorkspaceManager } from "./workspace-manager";

const TEST_WORKSPACE = "/tmp/test-workspace-manager";
const TEST_CONTEXT_DIR = "/tmp/test-workspace-manager-context";

describe("WorkspaceManager", () => {
  let wm: WorkspaceManager;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret-for-workspace-manager";
    process.env.SHARED_CONTEXT_DIR = TEST_CONTEXT_DIR;
  });

  beforeEach(() => {
    wm = new WorkspaceManager();
    mkdirSync(TEST_CONTEXT_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    rmSync(TEST_CONTEXT_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  afterAll(() => {
    process.env.SHARED_CONTEXT_DIR = undefined;
  });

  describe("ensureWorkspace", () => {
    it("creates workspace directory", () => {
      wm.ensureWorkspace(TEST_WORKSPACE, "test-agent", "agent-123");
      expect(existsSync(TEST_WORKSPACE)).toBe(true);
    });

    it("creates shared-context symlink", () => {
      wm.ensureWorkspace(TEST_WORKSPACE, "test-agent", "agent-123");
      const contextLink = path.join(TEST_WORKSPACE, "shared-context");
      expect(existsSync(contextLink)).toBe(true);
    });

    it("writes CLAUDE.md in workspace", () => {
      wm.ensureWorkspace(TEST_WORKSPACE, "test-agent", "agent-123");
      const claudeMdPath = path.join(TEST_WORKSPACE, "CLAUDE.md");
      expect(existsSync(claudeMdPath)).toBe(true);
      const content = readFileSync(claudeMdPath, "utf-8");
      expect(content).toContain("test-agent");
      expect(content).toContain("agent-123");
    });

    it("writes .agent-token file", () => {
      wm.ensureWorkspace(TEST_WORKSPACE, "test-agent", "agent-123");
      const tokenPath = path.join(TEST_WORKSPACE, ".agent-token");
      expect(existsSync(tokenPath)).toBe(true);
      const token = readFileSync(tokenPath, "utf-8");
      expect(token.length).toBeGreaterThan(0);
      // JWT format: header.payload.signature
      expect(token.split(".")).toHaveLength(3);
    });

    it("is idempotent - calling twice does not fail", () => {
      wm.ensureWorkspace(TEST_WORKSPACE, "test-agent", "agent-123");
      expect(() => wm.ensureWorkspace(TEST_WORKSPACE, "test-agent", "agent-123")).not.toThrow();
    });
  });

  describe("writeAgentTokenFile", () => {
    it("writes a valid JWT token", () => {
      mkdirSync(TEST_WORKSPACE, { recursive: true });
      wm.writeAgentTokenFile(TEST_WORKSPACE, "agent-456");
      const tokenPath = path.join(TEST_WORKSPACE, ".agent-token");
      const token = readFileSync(tokenPath, "utf-8");
      expect(token.split(".")).toHaveLength(3);
    });

    it("overwrites existing token on refresh", () => {
      mkdirSync(TEST_WORKSPACE, { recursive: true });
      wm.writeAgentTokenFile(TEST_WORKSPACE, "agent-456");
      const token1 = readFileSync(path.join(TEST_WORKSPACE, ".agent-token"), "utf-8");

      // Tokens include iat, so a new token should differ
      // (unless generated in the same second - sleep briefly)
      wm.writeAgentTokenFile(TEST_WORKSPACE, "agent-789");
      const token2 = readFileSync(path.join(TEST_WORKSPACE, ".agent-token"), "utf-8");

      // Different agent ID means different token
      expect(token2).not.toBe(token1);
    });
  });

  describe("saveAttachments", () => {
    it("returns empty object for no attachments", () => {
      const result = wm.saveAttachments(TEST_WORKSPACE, []);
      expect(result).toEqual({ prefix: "", names: [] });
    });

    it("saves file attachments and returns prompt suffix", () => {
      mkdirSync(TEST_WORKSPACE, { recursive: true });
      const result = wm.saveAttachments(TEST_WORKSPACE, [
        { name: "readme.txt", type: "file", data: "Hello, world!", mime: "text/plain" },
      ]);

      expect(result.names).toEqual(["readme.txt"]);
      expect(result.prefix).toContain("The following file(s) have been attached:");
      expect(result.prefix).toContain("readme.txt");
      expect(result.prefix).toContain(".attachments");

      // Verify the file was actually written
      const attachDir = path.join(TEST_WORKSPACE, ".attachments");
      expect(existsSync(attachDir)).toBe(true);
    });

    it("saves image attachments from data URLs", () => {
      mkdirSync(TEST_WORKSPACE, { recursive: true });
      const base64Data = "data:image/png;base64,iVBORw0KGgo=";
      const result = wm.saveAttachments(TEST_WORKSPACE, [
        { name: "screenshot.png", type: "image", data: base64Data, mime: "image/png" },
      ]);

      expect(result.names).toEqual(["screenshot.png"]);
      expect(result.prefix).toContain("Use your Read tool to view the following image(s) BEFORE responding:");
      expect(result.prefix).toContain("screenshot.png");
      expect(result.prefix).toContain(".attachments");
    });

    it("sanitizes filenames", () => {
      mkdirSync(TEST_WORKSPACE, { recursive: true });
      wm.saveAttachments(TEST_WORKSPACE, [
        { name: "file with spaces & special!chars.txt", type: "file", data: "content", mime: "text/plain" },
      ]);

      const attachDir = path.join(TEST_WORKSPACE, ".attachments");
      const files = require("node:fs").readdirSync(attachDir);
      // Should not contain spaces or special chars (except . - _)
      for (const f of files) {
        expect(f).not.toMatch(/[ &!]/);
      }
    });
  });

  describe("buildEnv", () => {
    it("always includes SHELL and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", () => {
      const env = wm.buildEnv("agent-123");
      expect(env.SHELL).toBe("/bin/sh");
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    });

    it("includes AGENT_AUTH_TOKEN", () => {
      const env = wm.buildEnv("agent-123");
      expect(env.AGENT_AUTH_TOKEN).toBeDefined();
      expect(typeof env.AGENT_AUTH_TOKEN).toBe("string");
    });

    it("forwards allowed env vars from process.env", () => {
      const origPath = process.env.PATH;
      process.env.ANTHROPIC_API_KEY = "test-api-key";
      const env = wm.buildEnv("agent-123");
      expect(env.ANTHROPIC_API_KEY).toBe("test-api-key");
      expect(env.PATH).toBe(origPath);
      process.env.ANTHROPIC_API_KEY = undefined;
    });

    it("does not forward server-only secrets", () => {
      process.env.GCS_BUCKET = "secret-bucket";
      process.env.DATABASE_URL = "secret-db";
      const env = wm.buildEnv("agent-123");
      expect(env.GCS_BUCKET).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      process.env.GCS_BUCKET = undefined;
      process.env.DATABASE_URL = undefined;
    });
  });

  describe("refreshAllAgentTokens", () => {
    it("refreshes tokens for all agents", () => {
      mkdirSync(TEST_WORKSPACE, { recursive: true });
      const agents = new Map<string, { agent: Agent }>([
        [
          "agent-1",
          {
            agent: {
              id: "agent-1",
              name: "test-1",
              status: "running",
              workspaceDir: TEST_WORKSPACE,
              createdAt: new Date().toISOString(),
              lastActivity: new Date().toISOString(),
              model: "claude-sonnet-4-6",
              depth: 1,
            },
          },
        ],
      ]);

      wm.refreshAllAgentTokens(agents, false);

      const tokenPath = path.join(TEST_WORKSPACE, ".agent-token");
      expect(existsSync(tokenPath)).toBe(true);
    });

    it("skips refresh when killed is true", () => {
      const spy = vi.spyOn(wm, "writeAgentTokenFile");
      const agents = new Map<string, { agent: Agent }>([
        [
          "agent-1",
          {
            agent: {
              id: "agent-1",
              name: "test-1",
              status: "running",
              workspaceDir: TEST_WORKSPACE,
              createdAt: new Date().toISOString(),
              lastActivity: new Date().toISOString(),
              model: "claude-sonnet-4-6",
              depth: 1,
            },
          },
        ],
      ]);

      wm.refreshAllAgentTokens(agents, true);

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("writeWorkspaceClaudeMd", () => {
    it("includes agent name and ID", () => {
      mkdirSync(TEST_WORKSPACE, { recursive: true });
      // Create shared-context symlink manually for this test
      const { symlinkSync } = require("node:fs");
      const contextLink = path.join(TEST_WORKSPACE, "shared-context");
      if (!existsSync(contextLink)) {
        symlinkSync(path.resolve(TEST_CONTEXT_DIR), contextLink);
      }

      wm.writeWorkspaceClaudeMd(TEST_WORKSPACE, "my-agent", "agent-xyz");

      const claudeMd = readFileSync(path.join(TEST_WORKSPACE, "CLAUDE.md"), "utf-8");
      expect(claudeMd).toContain("my-agent");
      expect(claudeMd).toContain("agent-xyz");
    });

    it("lists other agents when provider is set", () => {
      mkdirSync(TEST_WORKSPACE, { recursive: true });
      const { symlinkSync } = require("node:fs");
      const contextLink = path.join(TEST_WORKSPACE, "shared-context");
      if (!existsSync(contextLink)) {
        symlinkSync(path.resolve(TEST_CONTEXT_DIR), contextLink);
      }

      wm.setAgentListProvider({
        list: () => [
          {
            id: "other-id",
            name: "other-agent",
            status: "running" as const,
            workspaceDir: "/tmp/other",
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            model: "claude-sonnet-4-6",
            role: "researcher",
            depth: 1,
          },
        ],
      });

      wm.writeWorkspaceClaudeMd(TEST_WORKSPACE, "my-agent", "agent-xyz");

      const claudeMd = readFileSync(path.join(TEST_WORKSPACE, "CLAUDE.md"), "utf-8");
      expect(claudeMd).toContain("other-agent");
      expect(claudeMd).toContain("researcher");
    });
  });

  describe("env allowlist", () => {
    const originalEnv = { ...process.env };

    const ALLOWED_KEYS = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "LINEAR_API_KEY",
      "FIGMA_TOKEN",
      "SLACK_TOKEN",
      "NOTION_API_KEY",
      "GOOGLE_CREDENTIALS",
      "HOME",
      "USER",
      "PATH",
      "LANG",
      "LC_ALL",
      "TERM",
      "TMPDIR",
      "TZ",
      "NODE_ENV",
      "PORT",
      "CLAUDE_HOME",
      "SHARED_CONTEXT_DIR",
    ];

    const SERVER_ONLY_KEYS = [
      "JWT_SECRET",
      "GCS_BUCKET",
      "GCP_PROJECT",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "DATABASE_URL",
      "API_KEY",
      "OPENROUTER_API_KEY",
      "OAUTH_CLIENT_SECRET",
    ];

    beforeEach(() => {
      for (const key of [...ALLOWED_KEYS, ...SERVER_ONLY_KEYS]) {
        process.env[key] = `test-value-${key}`;
      }
    });

    afterEach(() => {
      process.env = { ...originalEnv };
      vi.restoreAllMocks();
    });

    it("forwards all allowed environment variables", () => {
      const env = wm.buildEnv("test-agent");

      for (const key of ALLOWED_KEYS) {
        expect(env[key]).toBe(`test-value-${key}`);
      }
    });

    it("excludes server-only secrets", () => {
      const env = wm.buildEnv("test-agent");

      for (const key of SERVER_ONLY_KEYS) {
        expect(env[key]).toBeUndefined();
      }
    });

    it("always injects SHELL and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", () => {
      const env = wm.buildEnv("test-agent");

      expect(env.SHELL).toBe("/bin/sh");
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    });

    it("injects AGENT_AUTH_TOKEN for the agent", () => {
      const env = wm.buildEnv("test-agent");

      expect(env.AGENT_AUTH_TOKEN).toBeDefined();
      expect(typeof env.AGENT_AUTH_TOKEN).toBe("string");
      expect(env.AGENT_AUTH_TOKEN?.length).toBeGreaterThan(0);
    });

    it("skips allowed vars that are not set in process.env", () => {
      delete process.env.FIGMA_TOKEN;
      delete process.env.LINEAR_API_KEY;

      const env = wm.buildEnv("test-agent");

      expect(env.FIGMA_TOKEN).toBeUndefined();
      expect(env.LINEAR_API_KEY).toBeUndefined();
    });
  });
});
