import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSanitizeCache, sanitizeEvent } from "./sanitize";
import type { StreamEvent } from "./types";

// Helper to create events with complex message objects (the Claude CLI sends
// `message` as an object even though the TS interface types it as `string`).
// The index signature `[key: string]: unknown` on StreamEvent allows this at runtime.
function makeEvent(fields: Record<string, unknown>): StreamEvent {
  return fields as StreamEvent;
}

describe("sanitizeEvent", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetSanitizeCache();
    process.env.AGENT_AUTH_TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-service-token-value";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-or-v1-test-openrouter-key-1234567890";
    process.env.GITHUB_TOKEN = "ghp_test1234567890abcdef";
    process.env.JWT_SECRET = "super-secret-jwt-key-12345";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSanitizeCache();
  });

  it("redacts AGENT_AUTH_TOKEN from text fields", () => {
    const event: StreamEvent = {
      type: "raw",
      text: `curl -H "Authorization: Bearer ${process.env.AGENT_AUTH_TOKEN}" http://localhost:8080/api/agents`,
    };

    const sanitized = sanitizeEvent(event);
    expect(sanitized.text).not.toContain(process.env.AGENT_AUTH_TOKEN);
    expect(sanitized.text).toContain("[REDACTED]");
    expect(sanitized.text).toContain("curl");
  });

  it("redacts ANTHROPIC_AUTH_TOKEN from nested content", () => {
    const event = makeEvent({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: `echo ${process.env.ANTHROPIC_AUTH_TOKEN}` },
          },
        ],
      },
    });

    const sanitized = sanitizeEvent(event);
    const msg = (sanitized as Record<string, unknown>).message as {
      content: Array<{ input: { command: string } }>;
    };
    expect(msg.content[0].input.command).not.toContain(process.env.ANTHROPIC_AUTH_TOKEN);
    expect(msg.content[0].input.command).toContain("[REDACTED]");
  });

  it("redacts multiple different secrets in the same string", () => {
    const event: StreamEvent = {
      type: "raw",
      text: `TOKEN=${process.env.AGENT_AUTH_TOKEN} KEY=${process.env.ANTHROPIC_AUTH_TOKEN}`,
    };

    const sanitized = sanitizeEvent(event);
    expect(sanitized.text).not.toContain(process.env.AGENT_AUTH_TOKEN);
    expect(sanitized.text).not.toContain(process.env.ANTHROPIC_AUTH_TOKEN);
    expect((sanitized.text as string).match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  it("does not modify events without secrets", () => {
    const event = makeEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello, world!" }] },
    });

    const sanitized = sanitizeEvent(event);
    const msg = (sanitized as Record<string, unknown>).message as {
      content: Array<{ text: string }>;
    };
    expect(msg.content[0].text).toBe("Hello, world!");
  });

  it("does not mutate the original event", () => {
    const event: StreamEvent = {
      type: "raw",
      text: `secret: ${process.env.AGENT_AUTH_TOKEN}`,
    };

    const sanitized = sanitizeEvent(event);
    expect(event.text).toContain(process.env.AGENT_AUTH_TOKEN);
    expect(sanitized.text).not.toContain(process.env.AGENT_AUTH_TOKEN);
  });

  it("skips short env var values to avoid false positives", () => {
    process.env.API_KEY = "short"; // less than 8 chars
    resetSanitizeCache();

    const event: StreamEvent = { type: "raw", text: "This is a short string" };
    const sanitized = sanitizeEvent(event);
    expect(sanitized.text).toBe("This is a short string");
  });

  it("handles events with no string fields gracefully", () => {
    const event: StreamEvent = { type: "done", exitCode: 0 };
    const sanitized = sanitizeEvent(event);
    expect(sanitized).toEqual({ type: "done", exitCode: 0 });
  });

  it("redacts GITHUB_TOKEN from tool result content", () => {
    const event = makeEvent({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "123",
            content: `GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`,
          },
        ],
      },
    });

    const sanitized = sanitizeEvent(event);
    const msg = (sanitized as Record<string, unknown>).message as {
      content: Array<{ content: string }>;
    };
    expect(msg.content[0].content).not.toContain(process.env.GITHUB_TOKEN);
    expect(msg.content[0].content).toContain("[REDACTED]");
  });

  it("picks up new secrets after resetSanitizeCache", () => {
    const event: StreamEvent = { type: "raw", text: "new-secret-token-value" };

    // Before setting the env var, the string should pass through
    let sanitized = sanitizeEvent(event);
    expect(sanitized.text).toBe("new-secret-token-value");

    // Set a new secret and reset cache
    process.env.ANTHROPIC_AUTH_TOKEN = "new-secret-token-value";
    resetSanitizeCache();

    sanitized = sanitizeEvent(event);
    expect(sanitized.text).toBe("[REDACTED]");
  });
});

/**
 * Regression tests for API key switching logic in the config route.
 * Verifies that switching between OpenRouter and Anthropic keys properly
 * cleans up environment variables (no "undefined" string pollution).
 *
 * See: https://github.com/simonstaton/AgentManager_PRIVATE/pull/211
 */
function switchApiKey(key: string) {
  const isOpenRouter = key.startsWith("sk-or-");
  if (isOpenRouter) {
    process.env.ANTHROPIC_AUTH_TOKEN = key;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
  } else {
    process.env.ANTHROPIC_API_KEY = key;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
  }
  resetSanitizeCache();
}

describe("API key switching", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-or-v1-existing-key";
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    process.env.ANTHROPIC_API_KEY = "";
    resetSanitizeCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSanitizeCache();
  });

  it("switching to Anthropic key removes AUTH_TOKEN and BASE_URL from env", () => {
    switchApiKey("sk-ant-test-anthropic-key-12345");

    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-test-anthropic-key-12345");
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("switching to Anthropic key does not leave string 'undefined' in env", () => {
    switchApiKey("sk-ant-test-anthropic-key-12345");

    expect(process.env.ANTHROPIC_AUTH_TOKEN).not.toBe("undefined");
    expect(process.env.ANTHROPIC_BASE_URL).not.toBe("undefined");
    expect("ANTHROPIC_AUTH_TOKEN" in process.env).toBe(false);
    expect("ANTHROPIC_BASE_URL" in process.env).toBe(false);
  });

  it("switching to OpenRouter key removes API_KEY from env", () => {
    switchApiKey("sk-ant-test-anthropic-key-12345");
    switchApiKey("sk-or-v1-new-openrouter-key");

    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-v1-new-openrouter-key");
    expect(process.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
  });

  it("round-trip switch leaves correct state", () => {
    switchApiKey("sk-ant-test-key-12345");
    switchApiKey("sk-or-v1-final-key");

    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-v1-final-key");
    expect(process.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
  });

  it("isOpenRouter detection works correctly after switching to Anthropic", () => {
    switchApiKey("sk-ant-test-anthropic-key-12345");

    const isOpenRouter = !!process.env.ANTHROPIC_AUTH_TOKEN;
    expect(isOpenRouter).toBe(false);
  });
});
