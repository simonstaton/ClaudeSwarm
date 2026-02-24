import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNameFromPrompt } from "./agents";
import type { AgentProcess, StreamEvent } from "./types";

const TEST_EVENTS_DIR = "/tmp/test-agents-events";

vi.mock("./persistence", () => ({
  EVENTS_DIR: "/tmp/test-agents-events",
  loadAllAgentStates: () => [],
  saveAgentState: vi.fn(),
  removeAgentState: vi.fn(),
  writeTombstone: vi.fn(),
}));
vi.mock("./storage", () => ({
  cleanupAgentClaudeData: vi.fn(),
  debouncedSyncToGCS: vi.fn(),
}));
vi.mock("./worktrees", () => ({
  cleanupWorktreesForWorkspace: vi.fn(),
}));

const ID = "3f2a1bcc-dead-beef-0000-111122223333";
const SUFFIX = "3f2a1b"; // id.slice(0, 6)

describe("generateNameFromPrompt", () => {
  describe("happy path — well-formed English prompts", () => {
    it("extracts up to 3 meaningful words and appends UUID suffix", () => {
      expect(generateNameFromPrompt("Analyze security vulnerabilities in auth module", ID)).toBe(
        `analyze-security-vulnerabilities-${SUFFIX}`,
      );
    });

    it("lowercases the result", () => {
      expect(generateNameFromPrompt("FIX Login Bug", ID)).toBe(`fix-login-bug-${SUFFIX}`);
    });

    it("stops at 3 content words even when more are available", () => {
      const result = generateNameFromPrompt("refactor the distributed rate limiting middleware layer", ID);
      expect(result).toBe(`refactor-distributed-rate-${SUFFIX}`);
    });

    it("uses only the first newline-delimited line", () => {
      const result = generateNameFromPrompt("analyze auth\nignore this second line completely", ID);
      expect(result).toBe(`analyze-auth-${SUFFIX}`);
    });

    it("strips punctuation and special characters", () => {
      expect(generateNameFromPrompt("Fix the bug! (ASAP) — auth/login", ID)).toBe(`fix-bug-asap-${SUFFIX}`);
    });
  });

  describe("dot-split fix — dots must not prematurely end the line", () => {
    it("does not split the line on dots in version strings", () => {
      expect(generateNameFromPrompt("v1.2.3 upgrade the auth module", ID)).toBe(`upgrade-auth-module-${SUFFIX}`);
    });

    it("does not split the line on dots in domain names", () => {
      expect(generateNameFromPrompt("api.example.com rate limit analysis", ID)).toBe(`api-example-com-${SUFFIX}`);
    });

    it("does not split the line on dots in file paths", () => {
      expect(generateNameFromPrompt("src/auth.ts refactor login flow", ID)).toBe(`src-auth-refactor-${SUFFIX}`);
    });

    it("does split on newlines as intended", () => {
      const result = generateNameFromPrompt("first line words\nnever appear in result", ID);
      const parts = result.split("-");
      expect(parts).not.toContain("never");
      expect(parts).not.toContain("appear");
    });
  });

  describe("uniqueness — identical prompts produce different names via UUID suffix", () => {
    it("two promptless-named agents from identical prompts get different names", () => {
      const idA = "aaaa1111-0000-0000-0000-000000000000";
      const idB = "bbbb2222-0000-0000-0000-000000000000";
      const nameA = generateNameFromPrompt("analyze the auth module", idA);
      const nameB = generateNameFromPrompt("analyze the auth module", idB);
      expect(nameA).not.toBe(nameB);
      expect(nameA).toContain("aaaa11");
      expect(nameB).toContain("bbbb22");
    });
  });

  describe("fallback to agent-<uuid8> for degenerate prompts", () => {
    it("falls back on empty string", () => {
      expect(generateNameFromPrompt("", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back on whitespace-only prompt", () => {
      expect(generateNameFromPrompt("   ", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back when all words are stop words", () => {
      expect(generateNameFromPrompt("do it", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back when all words are shorter than 3 chars", () => {
      expect(generateNameFromPrompt("go do it", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back on punctuation-only prompt", () => {
      expect(generateNameFromPrompt("!!! --- ???", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back on non-ASCII / non-Latin prompts", () => {
      expect(generateNameFromPrompt("こんにちは世界", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back on numeric-only tokens that are too short", () => {
      expect(generateNameFromPrompt("10 20", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });
  });

  describe("output constraints", () => {
    it("result never exceeds 40 characters", () => {
      const longPrompt = "implementation refactoring authentication middleware distributed";
      const result = generateNameFromPrompt(longPrompt, ID);
      expect(result.length).toBeLessThanOrEqual(40);
    });

    it("output contains only [a-z0-9-] characters", () => {
      const prompts = [
        "Fix the <XSS> injection vulnerability NOW!",
        "Analyze `auth.ts` — high priority",
        "v2.0 release: deploy to production environment",
        "Run 10 parallel tests",
      ];
      for (const p of prompts) {
        const result = generateNameFromPrompt(p, ID);
        expect(result).toMatch(/^[a-z0-9-]+$/);
      }
    });

    it("explicit name from caller is used unchanged (not passed through this function)", () => {
      const result = generateNameFromPrompt("some prompt", ID);
      expect(result).toContain(SUFFIX);
    });
  });
});

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

describe("skip-permissions lifecycle", () => {
  let AgentManager: typeof import("./agents").AgentManager;
  let manager: InstanceType<typeof AgentManager>;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret-skip-perms";
    process.env.SHARED_CONTEXT_DIR = "/tmp/test-skip-perms-context";
  });

  beforeEach(async () => {
    vi.resetModules();
    mkdirSync(TEST_EVENTS_DIR, { recursive: true });
    spawnMock.mockClear().mockReturnValue(makeMockProc());
    const mod = await import("./agents");
    AgentManager = mod.AgentManager;
    manager = new AgentManager();
  });

  afterEach(() => {
    manager.dispose();
    rmSync(TEST_EVENTS_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  afterAll(() => {
    process.env.SHARED_CONTEXT_DIR = undefined;
  });

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

const TEST_AGENT_ID = "test-ring-buffer-agent";

function makeAgentProc(overrides?: Partial<AgentProcess>): AgentProcess {
  return {
    agent: {
      id: TEST_AGENT_ID,
      name: "test-agent",
      status: "running",
      workspaceDir: "/tmp/test-ring-workspace",
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
    ...overrides,
  };
}

function makeEvent(n: number): StreamEvent {
  return { type: "raw", text: `event-${n}` };
}

describe("ring buffer", () => {
  let AgentManagerRing: typeof import("./agents").AgentManager;
  let managerRing: InstanceType<typeof AgentManagerRing>;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret-ring-buffer";
    process.env.SHARED_CONTEXT_DIR = "/tmp/test-ring-buffer-context";
    mkdirSync(TEST_EVENTS_DIR, { recursive: true });
  });

  beforeEach(async () => {
    mkdirSync(TEST_EVENTS_DIR, { recursive: true });
    const mod = await import("./agents");
    AgentManagerRing = mod.AgentManager;
    managerRing = new AgentManagerRing();
  });

  afterEach(() => {
    managerRing.dispose();
    rmSync(TEST_EVENTS_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  afterAll(() => {
    process.env.SHARED_CONTEXT_DIR = undefined;
  });

  function injectAgentRing(agentProc: AgentProcess): void {
    const agents = (managerRing as unknown as { agents: Map<string, AgentProcess> }).agents;
    agents.set(agentProc.agent.id, agentProc);
  }

  function readEventBuffer(agentProc: AgentProcess): StreamEvent[] {
    return (managerRing as unknown as { readEventBuffer: (ap: AgentProcess) => StreamEvent[] }).readEventBuffer(
      agentProc,
    );
  }

  describe("readEventBuffer", () => {
    it("returns empty array for empty buffer", () => {
      const proc = makeAgentProc();
      injectAgentRing(proc);
      expect(readEventBuffer(proc)).toEqual([]);
    });

    it("returns events in order when buffer has not wrapped", () => {
      const proc = makeAgentProc();
      for (let i = 0; i < 5; i++) {
        proc.eventBuffer.push(makeEvent(i));
      }
      proc.eventBufferTotal = 5;
      injectAgentRing(proc);

      const result = readEventBuffer(proc);
      expect(result).toHaveLength(5);
      expect(result[0]).toEqual(makeEvent(0));
      expect(result[4]).toEqual(makeEvent(4));
    });

    it("returns events in insertion order after wrap-around", () => {
      const proc = makeAgentProc();
      proc.eventBuffer = [makeEvent(4), makeEvent(5), makeEvent(6), makeEvent(3)];
      proc.eventBufferTotal = 1003;
      injectAgentRing(proc);

      const result = readEventBuffer(proc);
      expect(result).toHaveLength(4);
      expect(result[0]).toEqual(makeEvent(3));
      expect(result[1]).toEqual(makeEvent(4));
      expect(result[2]).toEqual(makeEvent(5));
      expect(result[3]).toEqual(makeEvent(6));
    });

    it("returns a copy, not a reference to the original buffer", () => {
      const proc = makeAgentProc();
      proc.eventBuffer = [makeEvent(0), makeEvent(1)];
      proc.eventBufferTotal = 2;
      injectAgentRing(proc);

      const result = readEventBuffer(proc);
      result.push(makeEvent(99));
      expect(proc.eventBuffer).toHaveLength(2);
    });
  });

  describe("getEvents (hot path - ring buffer)", () => {
    it("returns events from ring buffer when agent has events in memory", async () => {
      const proc = makeAgentProc();
      for (let i = 0; i < 3; i++) {
        proc.eventBuffer.push(makeEvent(i));
      }
      proc.eventBufferTotal = 3;
      injectAgentRing(proc);

      const events = await managerRing.getEvents(TEST_AGENT_ID);
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual(makeEvent(0));
      expect(events[2]).toEqual(makeEvent(2));
    });

    it("returns empty array for unknown agent", async () => {
      const events = await managerRing.getEvents("nonexistent");
      expect(events).toEqual([]);
    });
  });

  describe("getEvents (cold path - disk streaming)", () => {
    it("reads events from .jsonl file when ring buffer is empty", async () => {
      const proc = makeAgentProc();
      injectAgentRing(proc);

      const filePath = path.join(TEST_EVENTS_DIR, `${TEST_AGENT_ID}.jsonl`);
      const lines = [JSON.stringify(makeEvent(0)), JSON.stringify(makeEvent(1)), JSON.stringify(makeEvent(2))].join(
        "\n",
      );
      writeFileSync(filePath, `${lines}\n`);

      const events = await managerRing.getEvents(TEST_AGENT_ID);
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual(makeEvent(0));
      expect(events[2]).toEqual(makeEvent(2));
    });

    it("populates ring buffer after cold read for subsequent hot reads", async () => {
      const proc = makeAgentProc();
      injectAgentRing(proc);

      const filePath = path.join(TEST_EVENTS_DIR, `${TEST_AGENT_ID}.jsonl`);
      const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify(makeEvent(i))).join("\n");
      writeFileSync(filePath, `${lines}\n`);

      const coldEvents = await managerRing.getEvents(TEST_AGENT_ID);
      expect(coldEvents).toHaveLength(5);

      expect(proc.eventBuffer.length).toBeGreaterThan(0);
      expect(proc.eventBufferTotal).toBe(5);

      const hotEvents = await managerRing.getEvents(TEST_AGENT_ID);
      expect(hotEvents).toHaveLength(5);
      expect(hotEvents).toEqual(coldEvents);
    });

    it("skips malformed JSON lines gracefully", async () => {
      const proc = makeAgentProc();
      injectAgentRing(proc);

      const filePath = path.join(TEST_EVENTS_DIR, `${TEST_AGENT_ID}.jsonl`);
      const content = [
        JSON.stringify(makeEvent(0)),
        "not-valid-json{{{",
        JSON.stringify(makeEvent(1)),
        "",
        JSON.stringify(makeEvent(2)),
      ].join("\n");
      writeFileSync(filePath, `${content}\n`);

      const events = await managerRing.getEvents(TEST_AGENT_ID);
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual(makeEvent(0));
      expect(events[1]).toEqual(makeEvent(1));
      expect(events[2]).toEqual(makeEvent(2));
    });

    it("returns empty array when .jsonl file does not exist", async () => {
      const proc = makeAgentProc();
      injectAgentRing(proc);
      const events = await managerRing.getEvents(TEST_AGENT_ID);
      expect(events).toEqual([]);
    });
  });
});
