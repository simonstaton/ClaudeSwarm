import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the environment variable allowlist in AgentManager.buildEnv().
 * Validates that only the intended env vars are forwarded to agent processes,
 * and server-only secrets are never leaked.
 */

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

describe("env allowlist", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of [...ALLOWED_KEYS, ...SERVER_ONLY_KEYS]) {
      process.env[key] = `test-value-${key}`;
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("forwards all allowed environment variables", async () => {
    const { AgentManager } = await import("../agents");
    const manager = new AgentManager();
    const env = (manager as unknown as { buildEnv: (id?: string) => NodeJS.ProcessEnv }).buildEnv("test-agent");

    for (const key of ALLOWED_KEYS) {
      expect(env[key]).toBe(`test-value-${key}`);
    }
  });

  it("excludes server-only secrets", async () => {
    const { AgentManager } = await import("../agents");
    const manager = new AgentManager();
    const env = (manager as unknown as { buildEnv: (id?: string) => NodeJS.ProcessEnv }).buildEnv("test-agent");

    for (const key of SERVER_ONLY_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("always injects SHELL and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", async () => {
    const { AgentManager } = await import("../agents");
    const manager = new AgentManager();
    const env = (manager as unknown as { buildEnv: (id?: string) => NodeJS.ProcessEnv }).buildEnv("test-agent");

    expect(env.SHELL).toBe("/bin/sh");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("injects AGENT_AUTH_TOKEN for the agent", async () => {
    const { AgentManager } = await import("../agents");
    const manager = new AgentManager();
    const env = (manager as unknown as { buildEnv: (id?: string) => NodeJS.ProcessEnv }).buildEnv("test-agent");

    expect(env.AGENT_AUTH_TOKEN).toBeDefined();
    expect(typeof env.AGENT_AUTH_TOKEN).toBe("string");
    expect(env.AGENT_AUTH_TOKEN?.length).toBeGreaterThan(0);
  });

  it("skips allowed vars that are not set in process.env", async () => {
    delete process.env.FIGMA_TOKEN;
    delete process.env.LINEAR_API_KEY;

    const { AgentManager } = await import("../agents");
    const manager = new AgentManager();
    const env = (manager as unknown as { buildEnv: (id?: string) => NodeJS.ProcessEnv }).buildEnv("test-agent");

    expect(env.FIGMA_TOKEN).toBeUndefined();
    expect(env.LINEAR_API_KEY).toBeUndefined();
  });
});
