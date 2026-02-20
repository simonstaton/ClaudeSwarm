import { mkdirSync, rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProcess } from "../types";

/**
 * Tests for the dangerouslySkipPermissions lifecycle:
 * - buildClaudeArgs flag propagation
 * - create() persists the flag on agent state
 * - message() reads the flag from persisted agent state
 */

vi.mock("../persistence", () => ({
  EVENTS_DIR: "/tmp/test-skip-perms-events",
  loadAllAgentStates: () => [],
  saveAgentState: vi.fn(),
  removeAgentState: vi.fn(),
  writeTombstone: vi.fn(),
}));
vi.mock("../storage", () => ({
  cleanupAgentClaudeData: vi.fn(),
  debouncedSyncToGCS: vi.fn(),
}));
vi.mock("../worktrees", () => ({
  cleanupWorktreesForWorkspace: vi.fn(),
}));

/** Create a mock ChildProcess-like object for spawn. */
function makeMockProc(pid = 12345) {
  return {
    pid,
    killed: false,
    exitCode: null,
    stdout: { on: vi.fn(), once: vi.fn(), removeAllListeners: vi.fn(), pause: vi.fn() },
    stderr: { on: vi.fn(), removeAllListeners: vi.fn() },
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  };
}

const spawnMock = vi.fn().mockReturnValue(makeMockProc());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

const EVENTS_DIR = "/tmp/test-skip-perms-events";

describe("skip-permissions lifecycle", () => {
  let AgentManager: typeof import("../agents").AgentManager;
  let manager: InstanceType<typeof AgentManager>;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret-skip-perms";
    process.env.SHARED_CONTEXT_DIR = "/tmp/test-skip-perms-context";
  });

  beforeEach(async () => {
    vi.resetModules();
    mkdirSync(EVENTS_DIR, { recursive: true });
    spawnMock.mockClear().mockReturnValue(makeMockProc());
    const mod = await import("../agents");
    AgentManager = mod.AgentManager;
    manager = new AgentManager();
  });

  afterEach(() => {
    manager.dispose();
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  afterAll(() => {
    process.env.SHARED_CONTEXT_DIR = undefined;
  });

  /** Access the private buildClaudeArgs method via type cast. */
  function buildClaudeArgs(
    opts: { prompt: string; dangerouslySkipPermissions?: boolean; maxTurns?: number; model?: string },
    model: string,
    resumeSessionId?: string,
  ): string[] {
    return (
      manager as unknown as {
        buildClaudeArgs: (opts: Record<string, unknown>, model: string, resumeSessionId?: string) => string[];
      }
    ).buildClaudeArgs(opts, model, resumeSessionId);
  }

  /** Inject a fake agent into the manager's private agents map. */
  function injectAgent(agentProc: AgentProcess): void {
    const agents = (manager as unknown as { agents: Map<string, AgentProcess> }).agents;
    agents.set(agentProc.agent.id, agentProc);
  }

  describe("buildClaudeArgs", () => {
    it("includes --dangerously-skip-permissions when flag is true", () => {
      const args = buildClaudeArgs({ prompt: "hello", dangerouslySkipPermissions: true }, "claude-sonnet-4-6");
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args[0]).toBe("--dangerously-skip-permissions");
    });

    it("omits --dangerously-skip-permissions when flag is false", () => {
      const args = buildClaudeArgs({ prompt: "hello", dangerouslySkipPermissions: false }, "claude-sonnet-4-6");
      expect(args).not.toContain("--dangerously-skip-permissions");
    });

    it("omits --dangerously-skip-permissions when flag is undefined", () => {
      const args = buildClaudeArgs({ prompt: "hello" }, "claude-sonnet-4-6");
      expect(args).not.toContain("--dangerously-skip-permissions");
    });

    it("includes --resume when resumeSessionId is provided", () => {
      const args = buildClaudeArgs(
        { prompt: "hello", dangerouslySkipPermissions: true },
        "claude-sonnet-4-6",
        "session-abc",
      );
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).toContain("--resume");
      expect(args[args.indexOf("--resume") + 1]).toBe("session-abc");
    });
  });

  describe("create() stores dangerouslySkipPermissions", () => {
    it("persists dangerouslySkipPermissions=true on agent state", () => {
      const { agent } = manager.create({
        prompt: "test prompt",
        name: "test-skip-true",
        dangerouslySkipPermissions: true,
      });

      expect(agent.dangerouslySkipPermissions).toBe(true);
      const spawnArgs = spawnMock.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain("--dangerously-skip-permissions");
    });

    it("persists dangerouslySkipPermissions=false on agent state", () => {
      const { agent } = manager.create({
        prompt: "test prompt",
        name: "test-skip-false",
        dangerouslySkipPermissions: false,
      });

      expect(agent.dangerouslySkipPermissions).toBe(false);
      const spawnArgs = spawnMock.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain("--dangerously-skip-permissions");
    });
  });

  describe("message() passes dangerouslySkipPermissions from persisted agent state", () => {
    it("reads flag from agent state and passes to buildClaudeArgs", () => {
      const agentProc: AgentProcess = {
        agent: {
          id: "msg-test-agent",
          name: "msg-test",
          status: "idle",
          workspaceDir: "/tmp/test-skip-perms-workspace",
          dangerouslySkipPermissions: true,
          claudeSessionId: "session-123",
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          model: "claude-sonnet-4-6",
          depth: 1,
        },
        proc: null,
        lineBuffer: "",
        listeners: new Set(),
        seenMessageIds: new Set(),
        processingScheduled: false,
        persistBatch: "",
        persistTimer: null,
        listenerBatch: [],
        stallCount: 0,
        eventBuffer: [],
        eventBufferTotal: 0,
      };
      injectAgent(agentProc);

      const buildSpy = vi.spyOn(
        manager as unknown as { buildClaudeArgs: (...args: unknown[]) => string[] },
        "buildClaudeArgs",
      );

      manager.message("msg-test-agent", "follow-up prompt");

      expect(buildSpy).toHaveBeenCalled();
      const callArgs = buildSpy.mock.calls[0][0] as { dangerouslySkipPermissions?: boolean };
      expect(callArgs.dangerouslySkipPermissions).toBe(true);

      const result = buildSpy.mock.results[0].value as string[];
      expect(result).toContain("--dangerously-skip-permissions");
    });

    it("does not pass flag when agent state has dangerouslySkipPermissions=false", () => {
      const agentProc: AgentProcess = {
        agent: {
          id: "msg-test-no-skip",
          name: "msg-no-skip",
          status: "idle",
          workspaceDir: "/tmp/test-skip-perms-workspace",
          dangerouslySkipPermissions: false,
          claudeSessionId: "session-456",
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          model: "claude-sonnet-4-6",
          depth: 1,
        },
        proc: null,
        lineBuffer: "",
        listeners: new Set(),
        seenMessageIds: new Set(),
        processingScheduled: false,
        persistBatch: "",
        persistTimer: null,
        listenerBatch: [],
        stallCount: 0,
        eventBuffer: [],
        eventBufferTotal: 0,
      };
      injectAgent(agentProc);

      const buildSpy = vi.spyOn(
        manager as unknown as { buildClaudeArgs: (...args: unknown[]) => string[] },
        "buildClaudeArgs",
      );

      manager.message("msg-test-no-skip", "follow-up prompt");

      const result = buildSpy.mock.results[0].value as string[];
      expect(result).not.toContain("--dangerously-skip-permissions");
    });

    it("does not pass flag when agent state has dangerouslySkipPermissions=undefined (legacy agent)", () => {
      const agentProc: AgentProcess = {
        agent: {
          id: "msg-test-legacy",
          name: "msg-legacy",
          status: "idle",
          workspaceDir: "/tmp/test-skip-perms-workspace",
          // dangerouslySkipPermissions intentionally omitted (undefined)
          claudeSessionId: "session-789",
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          model: "claude-sonnet-4-6",
          depth: 1,
        },
        proc: null,
        lineBuffer: "",
        listeners: new Set(),
        seenMessageIds: new Set(),
        processingScheduled: false,
        persistBatch: "",
        persistTimer: null,
        listenerBatch: [],
        stallCount: 0,
        eventBuffer: [],
        eventBufferTotal: 0,
      };
      injectAgent(agentProc);

      const buildSpy = vi.spyOn(
        manager as unknown as { buildClaudeArgs: (...args: unknown[]) => string[] },
        "buildClaudeArgs",
      );

      manager.message("msg-test-legacy", "follow-up prompt");

      const callArgs = buildSpy.mock.calls[0][0] as { dangerouslySkipPermissions?: boolean };
      expect(callArgs.dangerouslySkipPermissions).toBe(false);

      const result = buildSpy.mock.results[0].value as string[];
      expect(result).not.toContain("--dangerously-skip-permissions");
    });
  });
});
