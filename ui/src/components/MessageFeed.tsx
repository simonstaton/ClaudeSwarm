import { Badge, type BadgeVariant, Button, TextField } from "@fanvue/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMessage, createApi, MessageType } from "../api";
import { timeAgo } from "../constants";

interface MessageFeedProps {
  api: ReturnType<typeof createApi>;
  agents: { id: string; name: string }[];
}

const TYPE_BADGE: Record<string, BadgeVariant> = {
  task: "warning",
  result: "success",
  question: "info",
  info: "default",
  status: "default",
};

const TYPE_LABELS: Record<string, string> = {
  task: "Task",
  result: "Result",
  question: "Question",
  info: "Info",
  status: "Status",
};

function agentName(id: string, agents: { id: string; name: string }[]): string {
  if (id === "user") return "User";
  const agent = agents.find((a) => a.id === id);
  return agent?.name || id.slice(0, 8);
}

export function MessageFeed({ api, agents }: MessageFeedProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [msgContent, setMsgContent] = useState("");
  const [msgType, setMsgType] = useState<MessageType>("info");
  const [msgTo, setMsgTo] = useState("");
  const [sending, setSending] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const msgs = await api.fetchMessages({ limit: 50 });
      setMessages(msgs);
    } catch (err) {
      console.error("[MessageFeed] refresh failed", err);
    }
  }, [api]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Auto-scroll to bottom when new messages arrive
  const messageCount = messages.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional re-trigger on message count change
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messageCount]);

  const sendMessage = async () => {
    if (!msgContent.trim()) return;
    setSending(true);
    try {
      await api.postMessage({
        from: "user",
        fromName: "User",
        to: msgTo || undefined,
        type: msgType,
        content: msgContent,
      });
      setMsgContent("");
      setComposerOpen(false);
      await refresh();
    } catch (err) {
      console.error("[MessageFeed] send failed", err);
    }
    setSending(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs font-medium text-zinc-400">
            Messages <span className="text-zinc-600">({messages.length})</span>
          </p>
        </div>
        <Button variant="secondary" size="24" onClick={() => setComposerOpen(!composerOpen)}>
          {composerOpen ? "Cancel" : "New"}
        </Button>
      </div>

      {/* Composer */}
      {composerOpen && (
        <div className="mb-3 p-3 rounded-lg border border-zinc-700 bg-zinc-900 space-y-2">
          <div className="flex gap-2">
            <select
              value={msgTo}
              onChange={(e) => setMsgTo(e.target.value)}
              className="px-2 py-1 text-xs rounded bg-zinc-800 border border-zinc-700 text-zinc-300 focus:outline-none"
            >
              <option value="">Broadcast (all)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select
              value={msgType}
              onChange={(e) => setMsgType(e.target.value as MessageType)}
              className="px-2 py-1 text-xs rounded bg-zinc-800 border border-zinc-700 text-zinc-300 focus:outline-none"
            >
              <option value="info">Info</option>
              <option value="task">Task</option>
              <option value="question">Question</option>
              <option value="status">Status</option>
            </select>
          </div>
          <TextField
            value={msgContent}
            onChange={(e) => setMsgContent(e.target.value)}
            placeholder="Message content..."
            size="32"
            fullWidth
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          />
          <Button
            variant="primary"
            size="24"
            onClick={sendMessage}
            disabled={!msgContent.trim() || sending}
            loading={sending}
          >
            Send
          </Button>
        </div>
      )}

      {/* Messages list */}
      <div ref={feedRef} className="flex-1 overflow-y-auto space-y-2">
        {messages.length === 0 ? (
          <div className="text-center text-zinc-600 text-xs py-8">
            No messages yet. Agents communicate here when they coordinate tasks.
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="p-2 rounded-lg border border-zinc-800 bg-zinc-900/50 text-xs">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-medium text-zinc-300">{msg.fromName || agentName(msg.from, agents)}</span>
                {msg.to && (
                  <>
                    <span className="text-zinc-600">→</span>
                    <span className="text-zinc-400">{agentName(msg.to, agents)}</span>
                  </>
                )}
                <Badge variant={TYPE_BADGE[msg.type] || "default"} className="text-[10px]">
                  {TYPE_LABELS[msg.type] || msg.type}
                </Badge>
                <span className="text-zinc-600 ml-auto">{timeAgo(msg.createdAt)}</span>
              </div>
              <p className="text-zinc-400 whitespace-pre-wrap break-words leading-relaxed">{msg.content}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
