import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to control the STATE_DIR and EVENTS_DIR used by persistence.ts.
// Since those are module-level constants derived from existsSync("/persistent"),
// we use vi.mock to intercept existsSync at load time and reload the module
// pointing to a temp directory.

// Store original module paths so we can reset them
let stateDir: string;
let eventsDir: string;
let testRoot: string;

// We'll dynamically import persistence after setting up the mock environment
let persistence: typeof import("../persistence");

describe("persistence", () => {
  beforeEach(async () => {
    // Create isolated temp directories for each test
    testRoot = mkdtempSync(path.join(os.tmpdir(), "persistence-test-"));
    stateDir = path.join(testRoot, "agent-state");
    eventsDir = path.join(testRoot, "agent-events");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(eventsDir, { recursive: true });

    // Mock node:fs so that STATE_DIR and EVENTS_DIR point to our temp dirs.
    // We intercept existsSync("/persistent") → false (so it uses /tmp paths),
    // then redirect all path.join(STATE_DIR/EVENTS_DIR, ...) calls to our temp dirs.
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");

      const patchPath = (p: string) => {
        if (typeof p === "string") {
          if (p.startsWith("/tmp/agent-state")) return p.replace("/tmp/agent-state", stateDir);
          if (p.startsWith("/tmp/agent-events")) return p.replace("/tmp/agent-events", eventsDir);
        }
        return p;
      };

      return {
        ...actual,
        existsSync: (p: string) => {
          if (p === "/persistent") return false;
          return actual.existsSync(patchPath(p));
        },
        mkdirSync: (p: string, options?: object) => actual.mkdirSync(patchPath(p), options),
        readdirSync: (p: string) => actual.readdirSync(patchPath(p)),
        readFileSync: (p: string, enc?: BufferEncoding) => actual.readFileSync(patchPath(p), enc),
        unlinkSync: (p: string) => actual.unlinkSync(patchPath(p)),
        writeFileSync: (p: string, data: string, enc?: BufferEncoding) => actual.writeFileSync(patchPath(p), data, enc),
      };
    });

    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      const patchPath = (p: string) => {
        if (typeof p === "string") {
          if (p.startsWith("/tmp/agent-state")) return p.replace("/tmp/agent-state", stateDir);
          if (p.startsWith("/tmp/agent-events")) return p.replace("/tmp/agent-events", eventsDir);
        }
        return p;
      };

      return {
        ...actual,
        access: (p: string, mode?: number) => actual.access(patchPath(p), mode),
        unlink: (p: string) => actual.unlink(patchPath(p)),
        writeFile: (p: string, data: string, enc?: BufferEncoding) => actual.writeFile(patchPath(p), data, enc),
        rename: (from: string, to: string) => actual.rename(patchPath(from), patchPath(to)),
      };
    });

    vi.resetModules();
    persistence = await import("../persistence");
  });

  afterEach(async () => {
    vi.doUnmock("node:fs");
    vi.doUnmock("node:fs/promises");
    vi.resetModules();

    // Clean up temp directory
    if (testRoot && existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  // Helper to build a minimal valid Agent object
  function makeAgent(id: string, status: import("../types").AgentStatus = "idle"): import("../types").Agent {
    return {
      id,
      name: `Agent ${id}`,
      status,
      workspaceDir: "/tmp/workspace",
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      model: "claude-sonnet-4-6",
      depth: 1,
    };
  }

  describe("saveAgentState", () => {
    it("writes a JSON file for the agent", async () => {
      const agent = makeAgent("agent-save-1");
      persistence.saveAgentState(agent);

      // Wait for async write to complete (immediate for meaningful status changes)
      await new Promise((r) => setTimeout(r, 50));

      const filePath = path.join(stateDir, "agent-save-1.json");
      expect(existsSync(filePath)).toBe(true);

      const data = JSON.parse(require("node:fs").readFileSync(filePath, "utf-8"));
      expect(data.id).toBe("agent-save-1");
      expect(data.name).toBe("Agent agent-save-1");
    });

    it("saves immediately on meaningful status change (idle)", async () => {
      const agent = makeAgent("agent-save-immediate", "idle");
      persistence.saveAgentState(agent);

      // Give the async write a moment to complete
      await new Promise((r) => setTimeout(r, 50));

      const filePath = path.join(stateDir, "agent-save-immediate.json");
      expect(existsSync(filePath)).toBe(true);
    });

    it("saves immediately on meaningful status change (running)", async () => {
      const agent = makeAgent("agent-save-running", "running");
      persistence.saveAgentState(agent);

      await new Promise((r) => setTimeout(r, 50));

      const filePath = path.join(stateDir, "agent-save-running.json");
      expect(existsSync(filePath)).toBe(true);
    });

    it("saves immediately on meaningful status change (error)", async () => {
      const agent = makeAgent("agent-save-error", "error");
      persistence.saveAgentState(agent);

      await new Promise((r) => setTimeout(r, 50));

      const filePath = path.join(stateDir, "agent-save-error.json");
      expect(existsSync(filePath)).toBe(true);
    });

    it("debounces saves for non-meaningful status changes", async () => {
      // First set a meaningful status so lastSavedStatus is set
      const agentIdle = makeAgent("agent-debounce", "idle");
      persistence.saveAgentState(agentIdle);
      await new Promise((r) => setTimeout(r, 50));

      // Now save again with the same status (non-meaningful change) — should debounce
      const agentSame = makeAgent("agent-debounce", "idle");
      agentSame.currentTask = "doing something";
      persistence.saveAgentState(agentSame);

      // File exists from the first save; the second save will come after debounce
      const filePath = path.join(stateDir, "agent-debounce.json");
      expect(existsSync(filePath)).toBe(true);

      // After debounce window, updated content should be written
      await new Promise((r) => setTimeout(r, 600));
      const data = JSON.parse(require("node:fs").readFileSync(filePath, "utf-8"));
      expect(data.currentTask).toBe("doing something");
    });

    it("overwrites existing state for the same agent id", async () => {
      const agentV1 = makeAgent("agent-overwrite", "idle");
      agentV1.currentTask = "task-v1";
      persistence.saveAgentState(agentV1);
      await new Promise((r) => setTimeout(r, 50));

      const agentV2 = makeAgent("agent-overwrite", "running");
      agentV2.currentTask = "task-v2";
      persistence.saveAgentState(agentV2);
      await new Promise((r) => setTimeout(r, 50));

      const filePath = path.join(stateDir, "agent-overwrite.json");
      const data = JSON.parse(require("node:fs").readFileSync(filePath, "utf-8"));
      expect(data.status).toBe("running");
      expect(data.currentTask).toBe("task-v2");
    });
  });

  describe("loadAllAgentStates", () => {
    it("returns empty array when state directory is empty", () => {
      const agents = persistence.loadAllAgentStates();
      expect(agents).toEqual([]);
    });

    it("loads agents from JSON files in the state directory", () => {
      const agent1 = makeAgent("load-agent-1");
      const agent2 = makeAgent("load-agent-2", "running");

      writeFileSync(path.join(stateDir, "load-agent-1.json"), JSON.stringify(agent1), "utf-8");
      writeFileSync(path.join(stateDir, "load-agent-2.json"), JSON.stringify(agent2), "utf-8");

      const agents = persistence.loadAllAgentStates();
      expect(agents).toHaveLength(2);
      const ids = agents.map((a) => a.id).sort();
      expect(ids).toEqual(["load-agent-1", "load-agent-2"]);
    });

    it("skips .tmp files", () => {
      const agent = makeAgent("load-agent-tmp");
      writeFileSync(path.join(stateDir, "load-agent-tmp.json"), JSON.stringify(agent), "utf-8");
      writeFileSync(path.join(stateDir, "load-agent-tmp.json.tmp"), JSON.stringify(agent), "utf-8");

      const agents = persistence.loadAllAgentStates();
      expect(agents).toHaveLength(1);
    });

    it("skips files starting with underscore", () => {
      const agent = makeAgent("real-agent");
      writeFileSync(path.join(stateDir, "real-agent.json"), JSON.stringify(agent), "utf-8");
      writeFileSync(path.join(stateDir, "_internal.json"), JSON.stringify({ some: "data" }), "utf-8");

      const agents = persistence.loadAllAgentStates();
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe("real-agent");
    });

    it("skips files with invalid JSON", () => {
      writeFileSync(path.join(stateDir, "bad-agent.json"), "not valid json", "utf-8");
      const agent = makeAgent("good-agent");
      writeFileSync(path.join(stateDir, "good-agent.json"), JSON.stringify(agent), "utf-8");

      const agents = persistence.loadAllAgentStates();
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe("good-agent");
    });

    it("skips files with no id field", () => {
      writeFileSync(path.join(stateDir, "noid-agent.json"), JSON.stringify({ name: "no-id" }), "utf-8");
      const agent = makeAgent("valid-agent");
      writeFileSync(path.join(stateDir, "valid-agent.json"), JSON.stringify(agent), "utf-8");

      const agents = persistence.loadAllAgentStates();
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe("valid-agent");
    });

    it("removes and skips empty state files", () => {
      const emptyFilePath = path.join(stateDir, "empty-agent.json");
      writeFileSync(emptyFilePath, "", "utf-8");
      const agent = makeAgent("valid-agent-2");
      writeFileSync(path.join(stateDir, "valid-agent-2.json"), JSON.stringify(agent), "utf-8");

      const agents = persistence.loadAllAgentStates();
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe("valid-agent-2");
      // Empty file should have been removed
      expect(existsSync(emptyFilePath)).toBe(false);
    });

    it("returns empty array when tombstone exists", () => {
      const agent = makeAgent("tombstone-test");
      writeFileSync(path.join(stateDir, "tombstone-test.json"), JSON.stringify(agent), "utf-8");

      // Write tombstone
      persistence.writeTombstone();

      const agents = persistence.loadAllAgentStates();
      expect(agents).toEqual([]);
    });
  });

  describe("cleanupStaleState", () => {
    it("removes .tmp files from state directory", () => {
      const tmpFile = path.join(stateDir, "agent-abc.json.tmp");
      writeFileSync(tmpFile, "{}", "utf-8");
      expect(existsSync(tmpFile)).toBe(true);

      persistence.cleanupStaleState();

      expect(existsSync(tmpFile)).toBe(false);
    });

    it("removes multiple .tmp files", () => {
      const tmpFile1 = path.join(stateDir, "agent-1.json.tmp");
      const tmpFile2 = path.join(stateDir, "agent-2.json.tmp");
      writeFileSync(tmpFile1, "{}", "utf-8");
      writeFileSync(tmpFile2, "{}", "utf-8");

      persistence.cleanupStaleState();

      expect(existsSync(tmpFile1)).toBe(false);
      expect(existsSync(tmpFile2)).toBe(false);
    });

    it("removes orphaned event files with no matching agent state", () => {
      // Event file with no corresponding state file
      const orphanedEvent = path.join(eventsDir, "orphan-agent.jsonl");
      writeFileSync(orphanedEvent, '{"event": "test"}\n', "utf-8");
      expect(existsSync(orphanedEvent)).toBe(true);

      persistence.cleanupStaleState();

      expect(existsSync(orphanedEvent)).toBe(false);
    });

    it("keeps event files that have a matching agent state", () => {
      const agent = makeAgent("matched-agent");
      writeFileSync(path.join(stateDir, "matched-agent.json"), JSON.stringify(agent), "utf-8");

      const matchedEvent = path.join(eventsDir, "matched-agent.jsonl");
      writeFileSync(matchedEvent, '{"event": "test"}\n', "utf-8");

      persistence.cleanupStaleState();

      expect(existsSync(matchedEvent)).toBe(true);
    });

    it("does not remove regular state JSON files", () => {
      const agent = makeAgent("keep-me");
      const stateFile = path.join(stateDir, "keep-me.json");
      writeFileSync(stateFile, JSON.stringify(agent), "utf-8");

      persistence.cleanupStaleState();

      expect(existsSync(stateFile)).toBe(true);
    });

    it("handles empty directories without error", () => {
      expect(() => persistence.cleanupStaleState()).not.toThrow();
    });
  });

  describe("removeAgentState", () => {
    it("removes the state JSON file for the given agent", async () => {
      const agent = makeAgent("remove-me");
      const filePath = path.join(stateDir, "remove-me.json");
      writeFileSync(filePath, JSON.stringify(agent), "utf-8");
      expect(existsSync(filePath)).toBe(true);

      await persistence.removeAgentState("remove-me");

      expect(existsSync(filePath)).toBe(false);
    });

    it("does nothing if state file does not exist", async () => {
      await expect(persistence.removeAgentState("nonexistent-agent")).resolves.not.toThrow();
    });

    it("also removes .tmp file if it exists", async () => {
      const agent = makeAgent("remove-with-tmp");
      const filePath = path.join(stateDir, "remove-with-tmp.json");
      const tmpPath = `${filePath}.tmp`;
      writeFileSync(filePath, JSON.stringify(agent), "utf-8");
      writeFileSync(tmpPath, "{}", "utf-8");

      await persistence.removeAgentState("remove-with-tmp");

      expect(existsSync(filePath)).toBe(false);
      expect(existsSync(tmpPath)).toBe(false);
    });

    it("removes state for specific agent without affecting others", async () => {
      const agent1 = makeAgent("keep-agent");
      const agent2 = makeAgent("delete-agent");
      const keepPath = path.join(stateDir, "keep-agent.json");
      const deletePath = path.join(stateDir, "delete-agent.json");
      writeFileSync(keepPath, JSON.stringify(agent1), "utf-8");
      writeFileSync(deletePath, JSON.stringify(agent2), "utf-8");

      await persistence.removeAgentState("delete-agent");

      expect(existsSync(keepPath)).toBe(true);
      expect(existsSync(deletePath)).toBe(false);
    });
  });

  describe("writeTombstone / hasTombstone / clearTombstone", () => {
    it("writeTombstone creates a tombstone file", () => {
      persistence.writeTombstone();
      expect(persistence.hasTombstone()).toBe(true);
    });

    it("hasTombstone returns false when no tombstone exists", () => {
      expect(persistence.hasTombstone()).toBe(false);
    });

    it("clearTombstone removes the tombstone file", () => {
      persistence.writeTombstone();
      expect(persistence.hasTombstone()).toBe(true);

      persistence.clearTombstone();
      expect(persistence.hasTombstone()).toBe(false);
    });

    it("clearTombstone does not throw if no tombstone exists", () => {
      expect(() => persistence.clearTombstone()).not.toThrow();
    });
  });
});
