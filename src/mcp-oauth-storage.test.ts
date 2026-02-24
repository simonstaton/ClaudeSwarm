import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteToken, loadToken, saveToken } from "./mcp-oauth-storage";

describe("mcp-oauth-storage", () => {
  let tokenDir: string;

  beforeEach(() => {
    tokenDir = path.join("/tmp", `mcp-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    process.env.MCP_TOKEN_DIR = tokenDir;
  });

  afterEach(() => {
    if (fs.existsSync(tokenDir)) {
      fs.rmSync(tokenDir, { recursive: true, force: true });
    }
    delete process.env.MCP_TOKEN_DIR;
  });

  it("saveToken and loadToken round-trip", () => {
    const token = {
      server: "linear",
      accessToken: "at-123",
      refreshToken: "rt-456",
      tokenType: "Bearer",
      authenticatedAt: new Date().toISOString(),
    };
    saveToken(token);
    const loaded = loadToken("linear");
    expect(loaded).not.toBeNull();
    expect(loaded?.server).toBe("linear");
    expect(loaded?.accessToken).toBe("at-123");
    expect(loaded?.refreshToken).toBe("rt-456");
  });

  it("loadToken returns null when no token", () => {
    expect(loadToken("nonexistent")).toBeNull();
  });

  it("deleteToken removes token file", () => {
    saveToken({
      server: "test",
      accessToken: "x",
      tokenType: "Bearer",
      authenticatedAt: new Date().toISOString(),
    });
    expect(loadToken("test")).not.toBeNull();
    deleteToken("test");
    expect(loadToken("test")).toBeNull();
  });
});
