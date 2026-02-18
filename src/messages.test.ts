import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageBus } from "./messages";

const TEST_MESSAGES_FILE = "/tmp/test-messages.json";

describe("MessageBus", () => {
  let bus: MessageBus;

  beforeEach(() => {
    // Clean up any existing test files
    if (existsSync(TEST_MESSAGES_FILE)) {
      rmSync(TEST_MESSAGES_FILE);
    }
    // Create a fresh MessageBus instance using a test-specific file path
    // to avoid reading/writing the production messages file
    bus = new MessageBus(TEST_MESSAGES_FILE);
  });

  afterEach(() => {
    // Clean up test files
    if (existsSync(TEST_MESSAGES_FILE)) {
      rmSync(TEST_MESSAGES_FILE);
    }
  });

  describe("post", () => {
    it("creates message with correct fields", () => {
      const msg = bus.post({
        from: "agent-1",
        fromName: "test-agent",
        to: "agent-2",
        type: "task",
        content: "Do something",
      });

      expect(msg.id).toBeTruthy();
      expect(msg.from).toBe("agent-1");
      expect(msg.fromName).toBe("test-agent");
      expect(msg.to).toBe("agent-2");
      expect(msg.type).toBe("task");
      expect(msg.content).toBe("Do something");
      expect(msg.createdAt).toBeTruthy();
      expect(msg.readBy).toEqual([]);
    });

    it("creates broadcast message when to is omitted", () => {
      const msg = bus.post({
        from: "agent-1",
        type: "status",
        content: "Status update",
      });

      expect(msg.to).toBeUndefined();
    });

    it("includes optional channel and metadata", () => {
      const msg = bus.post({
        from: "agent-1",
        type: "info",
        content: "Info",
        channel: "test-channel",
        metadata: { key: "value" },
      });

      expect(msg.channel).toBe("test-channel");
      expect(msg.metadata).toEqual({ key: "value" });
    });

    it("notifies subscribers", () => {
      const received: string[] = [];
      bus.subscribe((msg) => received.push(msg.content));

      bus.post({ from: "agent-1", type: "info", content: "Message 1" });
      bus.post({ from: "agent-2", type: "info", content: "Message 2" });

      expect(received).toEqual(["Message 1", "Message 2"]);
    });

    it("trims old messages when exceeding MAX_MESSAGES", () => {
      // Post 505 messages (MAX is 500)
      for (let i = 0; i < 505; i++) {
        bus.post({ from: "agent-1", type: "info", content: `Message ${i}` });
      }

      const all = bus.query({});
      expect(all.length).toBeLessThanOrEqual(500);
      // Should keep the most recent ones
      expect(all[all.length - 1].content).toBe("Message 504");
    });
  });

  describe("query", () => {
    beforeEach(() => {
      bus.post({ from: "agent-1", to: "agent-2", type: "task", content: "Task for agent-2" });
      bus.post({ from: "agent-1", type: "status", content: "Broadcast status", channel: "status" });
      bus.post({ from: "agent-2", to: "agent-1", type: "result", content: "Result for agent-1" });
      bus.post({ from: "agent-3", type: "info", content: "Info message" });
    });

    it("returns all messages by default", () => {
      const all = bus.query({});
      expect(all.length).toBe(4);
    });

    it("filters by to (includes broadcasts)", () => {
      const results = bus.query({ to: "agent-2" });
      // Should include message to agent-2 and broadcasts
      expect(results.length).toBe(3); // task + 2 broadcasts
    });

    it("filters by from", () => {
      const results = bus.query({ from: "agent-1" });
      expect(results.length).toBe(2);
      expect(results.every((m) => m.from === "agent-1")).toBe(true);
    });

    it("filters by channel", () => {
      const results = bus.query({ channel: "status" });
      expect(results.length).toBe(1);
      expect(results[0].content).toBe("Broadcast status");
    });

    it("filters by type", () => {
      const results = bus.query({ type: "task" });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe("task");
    });

    it("filters by unreadBy", () => {
      const msg = bus.post({ from: "agent-1", type: "info", content: "Test" });
      bus.markRead(msg.id, "agent-2");

      const unreadByAgent1 = bus.query({ unreadBy: "agent-1" });
      expect(unreadByAgent1.length).toBe(5); // all messages

      const unreadByAgent2 = bus.query({ unreadBy: "agent-2" });
      expect(unreadByAgent2.length).toBe(4); // all except the one marked read
    });

    it("filters by since timestamp", () => {
      // A far-future timestamp that is after all existing messages
      const since = new Date(Date.now() + 60_000).toISOString();
      bus.post({ from: "agent-1", type: "info", content: "Later" });

      // All messages have timestamps before `since`, so none should match
      const results = bus.query({ since });
      expect(results.length).toBe(0);

      // A far-past timestamp should return all messages
      const allResults = bus.query({ since: "2000-01-01T00:00:00.000Z" });
      expect(allResults.length).toBe(5); // 4 from beforeEach + 1 we just posted
    });

    it("respects limit", () => {
      const results = bus.query({ limit: 2 });
      expect(results.length).toBe(2);
    });

    it("returns most recent messages when limited", () => {
      const results = bus.query({ limit: 2 });
      expect(results[results.length - 1].content).toBe("Info message");
    });
  });

  describe("markRead", () => {
    it("marks message as read by agent", () => {
      const msg = bus.post({ from: "agent-1", type: "info", content: "Test" });
      expect(msg.readBy).toEqual([]);

      const success = bus.markRead(msg.id, "agent-2");
      expect(success).toBe(true);

      const updated = bus.query({}).find((m) => m.id === msg.id);
      expect(updated?.readBy).toContain("agent-2");
    });

    it("does not duplicate readBy entries", () => {
      const msg = bus.post({ from: "agent-1", type: "info", content: "Test" });

      bus.markRead(msg.id, "agent-2");
      bus.markRead(msg.id, "agent-2");

      const updated = bus.query({}).find((m) => m.id === msg.id);
      expect(updated?.readBy.filter((a) => a === "agent-2").length).toBe(1);
    });

    it("returns false for non-existent message", () => {
      const success = bus.markRead("non-existent-id", "agent-1");
      expect(success).toBe(false);
    });
  });

  describe("markAllRead", () => {
    it("marks all messages for an agent as read", () => {
      bus.post({ from: "agent-1", to: "agent-2", type: "task", content: "Task 1" });
      bus.post({ from: "agent-1", to: "agent-2", type: "task", content: "Task 2" });
      bus.post({ from: "agent-1", type: "info", content: "Broadcast" });

      const count = bus.markAllRead("agent-2");
      expect(count).toBe(3); // 2 direct + 1 broadcast

      const unread = bus.query({ to: "agent-2", unreadBy: "agent-2" });
      expect(unread.length).toBe(0);
    });

    it("returns 0 when no unread messages", () => {
      const count = bus.markAllRead("agent-1");
      expect(count).toBe(0);
    });
  });

  describe("deleteMessage", () => {
    it("removes message from bus", () => {
      const msg = bus.post({ from: "agent-1", type: "info", content: "Test" });
      const success = bus.deleteMessage(msg.id);
      expect(success).toBe(true);

      const found = bus.query({}).find((m) => m.id === msg.id);
      expect(found).toBeUndefined();
    });

    it("returns false for non-existent message", () => {
      const success = bus.deleteMessage("non-existent-id");
      expect(success).toBe(false);
    });
  });

  describe("subscribe", () => {
    it("notifies listener on new messages", () => {
      const received: string[] = [];
      bus.subscribe((msg) => received.push(msg.content));

      bus.post({ from: "agent-1", type: "info", content: "Test 1" });
      bus.post({ from: "agent-2", type: "info", content: "Test 2" });

      expect(received).toEqual(["Test 1", "Test 2"]);
    });

    it("allows unsubscribing", () => {
      const received: string[] = [];
      const unsubscribe = bus.subscribe((msg) => received.push(msg.content));

      bus.post({ from: "agent-1", type: "info", content: "Test 1" });
      unsubscribe();
      bus.post({ from: "agent-2", type: "info", content: "Test 2" });

      expect(received).toEqual(["Test 1"]); // Only first message
    });

    it("handles listener errors gracefully", () => {
      bus.subscribe(() => {
        throw new Error("Listener error");
      });

      // Should not throw
      expect(() => {
        bus.post({ from: "agent-1", type: "info", content: "Test" });
      }).not.toThrow();
    });
  });

  describe("cleanupForAgent", () => {
    it("removes messages from and to specified agent", () => {
      bus.post({ from: "agent-1", to: "agent-2", type: "task", content: "Task" });
      bus.post({ from: "agent-2", to: "agent-1", type: "result", content: "Result" });
      bus.post({ from: "agent-3", to: "agent-4", type: "info", content: "Other" });

      bus.cleanupForAgent("agent-1");

      const remaining = bus.query({});
      expect(remaining.length).toBe(1);
      expect(remaining[0].content).toBe("Other");
    });
  });

  describe("unreadCount", () => {
    it("returns count of unread messages for agent", () => {
      bus.post({ from: "agent-1", to: "agent-2", type: "task", content: "Task 1" });
      bus.post({ from: "agent-1", to: "agent-2", type: "task", content: "Task 2" });
      bus.post({ from: "agent-1", type: "info", content: "Broadcast" });

      expect(bus.unreadCount("agent-2")).toBe(3); // 2 direct + 1 broadcast
      expect(bus.unreadCount("agent-1")).toBe(1); // just broadcast
    });

    it("decreases after marking read", () => {
      const msg = bus.post({ from: "agent-1", to: "agent-2", type: "task", content: "Task" });
      expect(bus.unreadCount("agent-2")).toBe(1);

      bus.markRead(msg.id, "agent-2");
      expect(bus.unreadCount("agent-2")).toBe(0);
    });
  });

  describe("excludeRoles", () => {
    it("filters broadcasts by agent role", () => {
      bus.post({ from: "operator", type: "info", content: "General broadcast" });
      bus.post({ from: "operator", type: "info", content: "MCP update", excludeRoles: ["Haiku Coder"] });
      bus.post({ from: "operator", to: "agent-1", type: "task", content: "Direct message" });

      // Haiku Coder should only see general broadcast + direct message (not MCP update)
      const haikuMessages = bus.query({ to: "agent-1", agentRole: "Haiku Coder" });
      expect(haikuMessages.length).toBe(2);
      expect(haikuMessages.find((m) => m.content === "MCP update")).toBeUndefined();

      // Tech Lead should see all messages including MCP update
      const techLeadMessages = bus.query({ to: "agent-1", agentRole: "Tech Lead" });
      expect(techLeadMessages.length).toBe(3);
      expect(techLeadMessages.find((m) => m.content === "MCP update")).toBeDefined();
    });

    it("unreadCount respects excludeRoles", () => {
      bus.post({ from: "operator", type: "info", content: "Broadcast", excludeRoles: ["Haiku Coder"] });

      expect(bus.unreadCount("agent-1", "Haiku Coder")).toBe(0);
      expect(bus.unreadCount("agent-1", "Tech Lead")).toBe(1);
    });

    it("markAllRead respects excludeRoles", () => {
      bus.post({ from: "operator", type: "info", content: "Broadcast 1" });
      bus.post({ from: "operator", type: "info", content: "Broadcast 2", excludeRoles: ["Haiku Coder"] });

      const haikuCount = bus.markAllRead("agent-1", "Haiku Coder");
      expect(haikuCount).toBe(1); // Only general broadcast

      const techLeadCount = bus.markAllRead("agent-2", "Tech Lead");
      expect(techLeadCount).toBe(2); // Both broadcasts
    });
  });
});
