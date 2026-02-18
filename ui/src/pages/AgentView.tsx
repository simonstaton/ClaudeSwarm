import { Badge, Button } from "@fanvue/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Agent } from "../api";
import { AgentTerminal } from "../components/AgentTerminal";
import { Header } from "../components/Header";
import { type Attachment, PromptInput } from "../components/PromptInput";
import { Sidebar } from "../components/Sidebar";
import { STATUS_BADGE_VARIANT } from "../constants";
import { useAgentPolling } from "../hooks/useAgentPolling";
import { useAgentStream } from "../hooks/useAgentStream";
import { useApi } from "../hooks/useApi";
import { usePageVisible } from "../hooks/usePageVisible";
import { useKillSwitchContext } from "../App";

export function AgentView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const api = useApi();
  const { agents } = useAgentPolling();
  const visible = usePageVisible();
  const [agent, setAgent] = useState<Agent | null>(null);
  const { events, isStreaming, error, sendMessage, reconnect, clearEvents, injectEvent } = useAgentStream(id || null);
  const killSwitch = useKillSwitchContext();

  // Load agent details and reconnect to stream.
  // Use refs for clearEvents/reconnect so this effect only re-runs when `id`
  // changes — not when callback references change (which caused redundant
  // SSE connections and leaked server-side listeners).
  const reconnectRef = useRef(reconnect);
  const clearEventsRef = useRef(clearEvents);
  reconnectRef.current = reconnect;
  clearEventsRef.current = clearEvents;

  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    const load = async () => {
      try {
        const a = await api.getAgent(id);
        if (cancelled) return;
        setAgent(a);
        // Clear events before reconnecting to prevent old data from accumulating
        clearEventsRef.current();
        reconnectRef.current();
      } catch (err) {
        console.error("[AgentView] load failed", err);
        if (!cancelled) navigate("/");
      }
    };
    load();

    // Cleanup: clear agent state when switching away or unmounting
    return () => {
      cancelled = true;
      setAgent(null);
    };
  }, [id, api, navigate]);

  // Refresh agent details periodically (paused when tab is hidden)
  useEffect(() => {
    if (!id || !visible) return;
    const interval = setInterval(async () => {
      try {
        const a = await api.getAgent(id);
        setAgent(a);
      } catch (err) {
        console.error("[AgentView] agent refresh failed", err);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [id, api, visible]);

  const handleDestroy = async () => {
    if (!id) return;
    if (!confirm("Destroy this agent?")) return;
    try {
      await api.destroyAgent(id);
      navigate("/");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to destroy agent");
    }
  };

  const handleSendMessage = (prompt: string, attachments?: Attachment[]) => {
    sendMessage(prompt, undefined, undefined, attachments);
  };

  // ── @ file search handler ──────────────────────────────────────────────

  const handleSearchFiles = useCallback(
    async (query: string): Promise<string[]> => {
      if (!id) return [];
      return api.listAgentFiles(id, query);
    },
    [id, api],
  );

  /** Inject a local-only system message into the event stream */
  const injectSystemMessage = useCallback(
    (text: string) => {
      injectEvent({
        type: "system",
        subtype: "command_output",
        text,
      });
    },
    [injectEvent],
  );

  // ── Slash command handler ──────────────────────────────────────────────

  const handleSlashCommand = useCallback(
    (command: string) => {
      if (!id || !agent) return;

      switch (command) {
        case "cost": {
          // Compute cost from result events
          const resultEvents = events.filter((e) => e.type === "result");
          let totalCost = 0;
          let totalTurns = 0;
          let totalDuration = 0;
          for (const ev of resultEvents) {
            if (ev.total_cost_usd) totalCost += Number(ev.total_cost_usd);
            if (ev.num_turns) totalTurns += Number(ev.num_turns);
            if (ev.duration_ms) totalDuration += Number(ev.duration_ms);
          }
          injectSystemMessage(
            `Session cost: $${totalCost.toFixed(4)} | ${totalTurns} turns | ${(totalDuration / 1000).toFixed(1)}s total`,
          );
          break;
        }
        case "status": {
          const sessionId = agent.claudeSessionId?.slice(0, 8) || "unknown";
          injectSystemMessage(
            `Agent: ${agent.name} (${agent.id.slice(0, 8)})\nStatus: ${agent.status}\nModel: ${agent.model}\nSession: ${sessionId}\nCreated: ${new Date(agent.createdAt).toLocaleString()}\nLast activity: ${new Date(agent.lastActivity).toLocaleString()}`,
          );
          break;
        }
        case "clear": {
          clearEvents();
          break;
        }
        case "help": {
          injectSystemMessage(
            [
              "Available commands:",
              "  /cost     — Show token usage and cost for this session",
              "  /status   — Show agent status and session info",
              "  /clear    — Clear terminal output",
              "  /compact  — Ask agent to summarize the conversation",
              "  /review   — Ask agent to review recent changes",
              "  /help     — Show this help",
              "",
              "Input features:",
              "  @filename  — Reference a file in the agent's workspace",
              "  Paste/drag — Attach images or text files",
              "  Shift+Enter — Insert newline",
            ].join("\n"),
          );
          break;
        }
      }
    },
    [id, agent, events, clearEvents, injectSystemMessage],
  );

  const getPlaceholder = () => {
    if (agent?.status === "error") return "Agent errored";
    if (agent?.status === "restored") return "Agent restored from crash — send a message to resume...";
    if (isStreaming) return "Send a message (will interrupt current task)...";
    return "Send a follow-up message...";
  };

  return (
    <div className="h-screen flex flex-col">
      <Header agentCount={agents.length} killSwitch={killSwitch} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar agents={agents} activeId={id || null} onSelect={(agentId) => navigate(`/agents/${agentId}`)} />

        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Agent header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900/30">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-medium">{agent?.name || "Loading..."}</h2>
              {agent && <StatusBadge status={agent.status} />}
              {isStreaming && <span className="text-xs text-zinc-600">streaming...</span>}
              {error && <span className="text-xs text-red-400">{error}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="tertiary" size="24" onClick={reconnect}>
                Reconnect
              </Button>
              <Button variant="tertiaryDestructive" size="24" onClick={handleDestroy}>
                Destroy
              </Button>
            </div>
          </div>

          {/* Terminal */}
          <AgentTerminal events={events} />

          {/* Input */}
          <PromptInput
            onSubmit={handleSendMessage}
            disabled={!agent || agent.status === "error"}
            placeholder={getPlaceholder()}
            onSearchFiles={handleSearchFiles}
            onSlashCommand={handleSlashCommand}
          />
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_BADGE_VARIANT[status] || "default"} leftDot>
      {status}
    </Badge>
  );
}
