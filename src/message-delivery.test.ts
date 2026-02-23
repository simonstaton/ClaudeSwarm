import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "./agents";
import { attachMessageDelivery, deliverMessage, formatDeliveryPrompt } from "./message-delivery";
import type { MessageBus } from "./messages";
import type { AgentMessage } from "./types";

describe("message-delivery", () => {
  describe("formatDeliveryPrompt", () => {
    it("includes header, content, and replyToId in expected format", () => {
      const out = formatDeliveryPrompt("Hello", "body text", "agent-123");
      expect(out).toContain("Hello");
      expect(out).toContain("<message-content>");
      expect(out).toContain("body text");
      expect(out).toContain("</message-content>");
      expect(out).toContain("agent-123");
      expect(out).toMatch(/Reply by sending a message back to agent ID: agent-123/);
    });
  });

  describe("deliverMessage", () => {
    it("calls bus.markRead, then manager.message with given args", () => {
      const markRead = vi.fn();
      const message = vi.fn();
      const bus = { markRead } as unknown as MessageBus;
      const manager = { message } as unknown as AgentManager;
      deliverMessage(bus, manager, "aid", "mid", "prompt", "log", {});
      expect(markRead).toHaveBeenCalledWith("mid", "aid");
      expect(message).toHaveBeenCalledWith("aid", "prompt");
    });
  });

  describe("attachMessageDelivery", () => {
    let subscribeCallback: (msg: AgentMessage) => void;
    let onIdleCallback: (agentId: string) => void;
    let messageBus: {
      markRead: ReturnType<typeof vi.fn>;
      subscribe: (cb: (msg: AgentMessage) => void) => void;
      post: (
        opts: Partial<AgentMessage> & { from: string; type: AgentMessage["type"]; content: string },
      ) => AgentMessage;
      query: (opts: { to: string; unreadBy: string; agentRole?: string }) => AgentMessage[];
    };
    let agentManager: {
      canInterrupt: (id: string) => boolean;
      canDeliver: (id: string) => boolean;
      get: (id: string) => { role?: string } | undefined;
      message: ReturnType<typeof vi.fn>;
      deliveryDone: ReturnType<typeof vi.fn>;
      onIdle: (cb: (agentId: string) => void) => void;
    };

    beforeEach(() => {
      subscribeCallback = () => {};
      onIdleCallback = () => {};
      messageBus = {
        markRead: vi.fn(),
        subscribe: (cb) => {
          subscribeCallback = cb;
        },
        post: (opts) => {
          const msg: AgentMessage = {
            id: opts.id ?? "msg-1",
            from: opts.from,
            fromName: opts.fromName,
            to: opts.to,
            type: opts.type,
            content: opts.content,
            createdAt: new Date().toISOString(),
            readBy: [],
          };
          subscribeCallback(msg);
          return msg;
        },
        query: () => [],
      };
      agentManager = {
        canInterrupt: vi.fn(() => false),
        canDeliver: vi.fn(() => false),
        get: vi.fn(() => undefined),
        message: vi.fn(),
        deliveryDone: vi.fn(),
        onIdle: (cb) => {
          onIdleCallback = cb;
        },
      };
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it("does not deliver when msg.to is missing", () => {
      attachMessageDelivery(messageBus as unknown as MessageBus, agentManager as unknown as AgentManager, {
        isKilled: () => false,
        deliverySettleMs: 0,
      });
      messageBus.post({ from: "u", type: "task", content: "hi", to: undefined });
      expect(agentManager.message).not.toHaveBeenCalled();
    });

    it("does not deliver when msg.type is status", () => {
      attachMessageDelivery(messageBus as unknown as MessageBus, agentManager as unknown as AgentManager, {
        isKilled: () => false,
        deliverySettleMs: 0,
      });
      messageBus.post({ from: "u", type: "status", content: "idle", to: "agent-1" });
      expect(agentManager.message).not.toHaveBeenCalled();
    });

    it("does not deliver when isKilled() is true", () => {
      attachMessageDelivery(messageBus as unknown as MessageBus, agentManager as unknown as AgentManager, {
        isKilled: () => true,
        deliverySettleMs: 0,
      });
      messageBus.post({ from: "u", type: "task", content: "hi", to: "agent-1" });
      expect(agentManager.message).not.toHaveBeenCalled();
    });

    it("interrupt path does NOT call deliveryDone (contract: interrupt bypasses delivery lock)", () => {
      (agentManager.canInterrupt as ReturnType<typeof vi.fn>).mockReturnValue(true);
      attachMessageDelivery(messageBus as unknown as MessageBus, agentManager as unknown as AgentManager, {
        isKilled: () => false,
        deliverySettleMs: 0,
      });
      messageBus.post({ from: "u", type: "interrupt", content: "stop", to: "agent-1", id: "mid" });
      expect(agentManager.message).toHaveBeenCalledWith("agent-1", expect.stringContaining("INTERRUPT"));
      expect(agentManager.deliveryDone).not.toHaveBeenCalled();
    });

    it("normal delivery path calls deliveryDone in finally", () => {
      (agentManager.canDeliver as ReturnType<typeof vi.fn>).mockReturnValue(true);
      attachMessageDelivery(messageBus as unknown as MessageBus, agentManager as unknown as AgentManager, {
        isKilled: () => false,
        deliverySettleMs: 0,
      });
      messageBus.post({ from: "u", type: "task", content: "hi", to: "agent-1", id: "mid" });
      expect(agentManager.message).toHaveBeenCalledWith("agent-1", expect.any(String));
      expect(agentManager.deliveryDone).toHaveBeenCalledWith("agent-1");
    });

    it("onIdle with no agent calls deliveryDone and returns", () => {
      vi.useFakeTimers();
      (agentManager.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      (agentManager.canDeliver as ReturnType<typeof vi.fn>).mockReturnValue(true);
      attachMessageDelivery(messageBus as unknown as MessageBus, agentManager as unknown as AgentManager, {
        isKilled: () => false,
        deliverySettleMs: 0,
      });
      onIdleCallback("agent-1");
      vi.advanceTimersByTime(0);
      expect(agentManager.deliveryDone).toHaveBeenCalledWith("agent-1");
      expect(agentManager.message).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("onIdle with no pending message calls deliveryDone and returns", () => {
      vi.useFakeTimers();
      (agentManager.get as ReturnType<typeof vi.fn>).mockReturnValue({ role: "worker" });
      (agentManager.canDeliver as ReturnType<typeof vi.fn>).mockReturnValue(true);
      // messageBus.query already returns [] from beforeEach, so no pending message
      attachMessageDelivery(messageBus as unknown as MessageBus, agentManager as unknown as AgentManager, {
        isKilled: () => false,
        deliverySettleMs: 0,
      });
      onIdleCallback("agent-1");
      vi.advanceTimersByTime(0);
      expect(agentManager.deliveryDone).toHaveBeenCalledWith("agent-1");
      expect(agentManager.message).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
