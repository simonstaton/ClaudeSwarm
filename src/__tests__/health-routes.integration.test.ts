import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentManager } from "../agents";
import { createAuthRouter } from "../routes/auth";
import { createHealthRouter } from "../routes/health";

describe("health and auth routes (integration)", () => {
  let server: ReturnType<express.Express["listen"]> | null = null;
  const mockAgentManager = { list: () => [] } as unknown as AgentManager;

  beforeEach(() => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(createHealthRouter(mockAgentManager, 32 * 1024 ** 3, () => false));
    app.use(createAuthRouter());
    server = app.listen(0);
  });

  afterEach(() => {
    if (server) server.close();
    server = null;
  });

  function getPort(): number {
    const addr = server?.address() as { port: number } | null;
    if (addr?.port == null) throw new Error("server not listening");
    return addr.port;
  }

  it("GET /api/health returns 200 and status", async () => {
    const res = await fetch(`http://127.0.0.1:${getPort()}/api/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; agents: number };
    expect(data.status).toBe("ok");
    expect(typeof data.agents).toBe("number");
  });

  it("POST /api/auth/token with valid key returns 200 and token", async () => {
    // Test sets API_KEY so exchangeKeyForToken accepts the request; not mocked elsewhere.
    const orig = process.env.API_KEY;
    process.env.API_KEY = "test-key-for-integration";
    try {
      const res = await fetch(`http://127.0.0.1:${getPort()}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test-key-for-integration" }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { token: string };
      expect(typeof data.token).toBe("string");
      expect(data.token.length).toBeGreaterThan(0);
    } finally {
      process.env.API_KEY = orig;
    }
  });

  it("POST /api/auth/token with invalid key returns 401", async () => {
    const res = await fetch(`http://127.0.0.1:${getPort()}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "wrong-key" }),
    });
    expect(res.status).toBe(401);
  });
});
