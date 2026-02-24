/**
 * Auto-delivery of messages to agents: when a message targets an idle agent (or
 * when an agent goes idle with pending messages), we format a prompt and call
 * AgentManager.message() so the agent resumes and sees the content.
 *
 * Used by server.ts via attachMessageDelivery(). Kept in a separate module so
 * the delivery rules and formatting are easy to find and test.
 */
import type { AgentManager } from "./agents";
import { logger } from "./logger";
import type { MessageBus } from "./messages";
import { errorMessage } from "./types";

/** Format a message for auto-delivery to an agent. */
export function formatDeliveryPrompt(header: string, content: string, replyToId: string): string {
  return `${header}\n<message-content>\n${content}\n</message-content>\n\n(Reply by sending a message back to agent ID: ${replyToId})`;
}

/** Mark read, log, and send prompt to agent. Caller must catch and call deliveryDone in finally (except for interrupt). */
export function deliverMessage(
  bus: MessageBus,
  manager: AgentManager,
  agentId: string,
  msgId: string,
  prompt: string,
  logMsg: string,
  logMeta: Record<string, unknown>,
): void {
  bus.markRead(msgId, agentId);
  logger.info(logMsg, logMeta);
  manager.message(agentId, prompt);
}

export interface AttachMessageDeliveryOptions {
  /** When true, no delivery is attempted (e.g. kill switch active). */
  isKilled: () => boolean;
  /** Delay in ms after agent goes idle before delivering next queued message. */
  deliverySettleMs: number;
}

/**
 * Subscribes to MessageBus and AgentManager.onIdle so that:
 * - Incoming targeted messages are delivered to idle (or interruptible) agents.
 * - When an agent goes idle, the oldest pending message for it is delivered after deliverySettleMs.
 */
export function attachMessageDelivery(
  messageBus: MessageBus,
  agentManager: AgentManager,
  options: AttachMessageDeliveryOptions,
): void {
  const { isKilled, deliverySettleMs } = options;

  messageBus.subscribe((msg) => {
    if (!msg.to) return;
    if (msg.type === "status") return;
    if (isKilled()) return;

    const sender = msg.fromName || msg.from.slice(0, 8);

    if (msg.type === "interrupt" && agentManager.canInterrupt(msg.to)) {
      const prompt = formatDeliveryPrompt(
        `[INTERRUPT from ${sender}] ⚠️ Your current task has been interrupted. Read and act on this message immediately:`,
        msg.content,
        msg.from,
      );
      try {
        deliverMessage(messageBus, agentManager, msg.to, msg.id, prompt, "[auto-deliver] INTERRUPTING busy agent", {
          agentId: msg.to,
          sender,
        });
      } catch (err: unknown) {
        logger.warn("[auto-deliver] Failed to interrupt agent", { agentId: msg.to, error: errorMessage(err) });
      }
      return;
    }

    if (!agentManager.canDeliver(msg.to)) return;

    const prompt = formatDeliveryPrompt(`[Message from ${sender} - type: ${msg.type}]`, msg.content, msg.from);
    try {
      deliverMessage(messageBus, agentManager, msg.to, msg.id, prompt, "[auto-deliver] Delivering message", {
        agentId: msg.to,
        sender,
        msgType: msg.type,
      });
    } catch (err: unknown) {
      logger.warn("[auto-deliver] Failed to deliver message", { agentId: msg.to, error: errorMessage(err) });
    } finally {
      agentManager.deliveryDone(msg.to);
    }
  });

  agentManager.onIdle((agentId) => {
    setTimeout(() => {
      if (isKilled()) return;
      if (!agentManager.canDeliver(agentId)) return;

      const agent = agentManager.get(agentId);
      if (!agent) {
        agentManager.deliveryDone(agentId);
        return;
      }
      const pending = messageBus.query({
        to: agentId,
        unreadBy: agentId,
        agentRole: agent.role,
      });
      const next = pending.find((m) => m.type !== "status");
      if (!next) {
        agentManager.deliveryDone(agentId);
        return;
      }

      const sender = next.fromName || next.from.slice(0, 8);
      const prompt = formatDeliveryPrompt(`[Message from ${sender} - type: ${next.type}]`, next.content, next.from);
      try {
        deliverMessage(
          messageBus,
          agentManager,
          agentId,
          next.id,
          prompt,
          "[auto-deliver] Delivering queued message to now-idle agent",
          { agentId, sender, msgType: next.type },
        );
      } catch (err: unknown) {
        logger.warn("[auto-deliver] Failed to deliver queued message", { agentId, error: errorMessage(err) });
      } finally {
        agentManager.deliveryDone(agentId);
      }
    }, deliverySettleMs);
  });
}
