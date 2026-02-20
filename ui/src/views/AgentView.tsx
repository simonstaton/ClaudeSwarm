"use client";

import { Badge, Button } from "@fanvue/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, GradeResult } from "../api";
import { AgentMetadataPanel } from "../components/AgentMetadataPanel";
import { AgentTerminal } from "../components/AgentTerminal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RiskBadge } from "../components/RiskBadge";
import { Header } from "../components/Header";
import { type Attachment, PromptInput } from "../components/PromptInput";
import { Sidebar } from "../components/Sidebar";
import { AgentHeaderSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { STATUS_BADGE_VARIANT } from "../constants";
import { useAgentPolling } from "../hooks/useAgentPolling";
import { useAgentStream } from "../hooks/useAgentStream";
import { useApi } from "../hooks/useApi";
import { usePageVisible } from "../hooks/usePageVisible";
import { useKillSwitchContext } from "../killSwitch";

export function AgentView({ agentId }: { agentId: string }) {
  const id = agentId;
  const api = useApi();
  const apiRef = useRef(api);
  apiRef.current = api;
  const { agents } = useAgentPolling();
  const visible = usePageVisible();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const { events, isStreaming, error, sendMessage, reconnect, clearEvents, injectEvent } = useAgentStream(id || null);
  const killSwitch = useKillSwitchContext();
  const { toast } = useToast();
  const [grades, setGrades] = useState<GradeResult[]>([]);
  const [showApproveConfirm, setShowApproveConfirm] = useState<string | null>(null);

  // Set page title based on agent name
  useEffect(() => {
    document.title = agent?.name ? `${agent.name} - ClaudeSwarm` : "ClaudeSwarm";
  }, [agent?.name]);

  // Load agent details and reconnect to stream.
  // Use refs for clearEvents/reconnect/api so this effect only re-runs when
  // `id` changes — not when callback references change (which caused redundant
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
        const a = await apiRef.current.getAgent(id);
        if (cancelled) return;
        setAgent(a);
        clearEventsRef.current();
        reconnectRef.current();
      } catch (err) {
        console.error("[AgentView] load failed", err);
        if (!cancelled) window.location.href = "/";
      }
    };
    load();

    return () => {
      cancelled = true;
      setAgent(null);
    };
  }, [id]);

  // Refresh agent details periodically (paused when tab is hidden)
  useEffect(() => {
    if (!id || !visible) return;
    const interval = setInterval(async () => {
      try {
        const a = await apiRef.current.getAgent(id);
        setAgent(a);
      } catch (err) {
        console.error("[AgentView] agent refresh failed", err);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [id, visible]);

  // Poll for confidence grades
  useEffect(() => {
    if (!id || !visible) return;
    const fetchGrades = async () => {
      try {
        const g = await apiRef.current.fetchGrades({ agentId: id });
        setGrades(g);
      } catch {
        // Grading endpoint may not be available
      }
    };
    fetchGrades();
    const interval = setInterval(fetchGrades, 10_000);
    return () => clearInterval(interval);
  }, [id, visible]);

  const handleApproveGrade = async (taskId: string) => {
    setShowApproveConfirm(null);
    try {
      await apiRef.current.approveGrade(taskId);
      setGrades((prev) => prev.filter((g) => g.taskId !== taskId));
      toast("Grade approved", "success");
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Approval failed", "error");
    }
  };

  const handleStopAgent = async () => {
    if (!id) return;
    setShowStopConfirm(false);
    setIsStopping(true);
    setStopError(null);
    try {
      await apiRef.current.destroyAgent(id);
      window.location.href = "/";
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to stop agent", "error");
      setIsStopping(false);
    }
  };

  const canStop = agent && ["running", "idle", "restored", "error", "stalled", "paused"].includes(agent.status);
  const isErrored = agent?.status === "error";

  const handleSendMessage = (prompt: string, attachments?: Attachment[]) => {
    sendMessage(prompt, undefined, undefined, attachments);
  };

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
    if (agent?.status === "stalled") return "Agent appears stalled — send a message to attempt recovery...";
    if (agent?.status === "paused") return "Agent is paused — resume to continue...";
    if (isStreaming) return "Send a message (will interrupt current task)...";
    return "Send a follow-up message...";
  };

  return (
    <div className="h-screen flex flex-col">
      <Header agentCount={agents.length} killSwitch={killSwitch} />
      <ConfirmDialog
        open={showApproveConfirm !== null}
        onConfirm={() => showApproveConfirm && handleApproveGrade(showApproveConfirm)}
        onCancel={() => setShowApproveConfirm(null)}
        title="Approve high-risk change?"
        description="This will mark the high-risk grade as approved and allow the task to proceed."
        confirmLabel="Approve"
        variant="default"
      />
      <ConfirmDialog
        open={showStopConfirm}
        onConfirm={handleStopAgent}
        onCancel={() => setShowStopConfirm(false)}
        title={isErrored ? "Destroy this agent?" : "Stop this agent?"}
        description={
          isErrored
            ? "The errored agent will be cleaned up and removed."
            : "The agent process will be terminated. Any in-progress work may be lost."
        }
        confirmLabel={isErrored ? "Destroy Agent" : "Stop Agent"}
        variant="destructive"
      />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar agents={agents} activeId={id || null} />

        <main id="main-content" className="flex-1 flex flex-col overflow-hidden">
          {/* Agent header */}
          <header className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900/30">
            <div className="flex items-center gap-3">
              {agent ? (
                <>
                  <h2 className="text-sm font-medium">{agent.name}</h2>
                  <StatusBadge status={agent.status} />
                  {grades.length > 0 && <RiskBadge risk={grades[grades.length - 1].overallRisk} />}
                </>
              ) : (
                <AgentHeaderSkeleton />
              )}
              {isStreaming && (
                <span className="text-xs text-zinc-400" aria-live="polite">
                  streaming...
                </span>
              )}
              {error && (
                <span className="text-xs text-red-400" role="alert">
                  {error}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {stopError && (
                <span className="text-xs text-red-400 mr-1" role="alert">
                  {stopError}
                </span>
              )}
              <Button
                variant="tertiary"
                size="24"
                onClick={() => {
                  if (id && agent) {
                    api
                      .downloadAgentLogs(id, agent.name)
                      .catch((err) => toast(err instanceof Error ? err.message : "Download failed", "error"));
                  }
                }}
              >
                Download Log
              </Button>
              <Button variant="tertiary" size="24" onClick={reconnect}>
                Reconnect
              </Button>
              {agent &&
                (isPausing || agent.status === "running" || agent.status === "idle" || agent.status === "stalled") && (
                  <Button
                    variant="tertiary"
                    size="24"
                    disabled={isPausing}
                    onClick={async () => {
                      if (!id || isPausing) return;
                      setIsPausing(true);
                      setAgent((prev) => (prev ? { ...prev, status: "paused" } : prev));
                      try {
                        await api.pauseAgent(id);
                      } catch (err: unknown) {
                        toast(err instanceof Error ? err.message : "Pause failed", "error");
                        setAgent((prev) => (prev ? { ...prev, status: "running" } : prev));
                      } finally {
                        setIsPausing(false);
                      }
                    }}
                  >
                    {isPausing ? "Pausing..." : "Pause"}
                  </Button>
                )}
              {!isPausing && (agent?.status === "paused" || isResuming) && (
                <Button
                  variant="tertiary"
                  size="24"
                  disabled={isResuming}
                  onClick={async () => {
                    if (!id || isResuming) return;
                    setIsResuming(true);
                    setAgent((prev) => (prev ? { ...prev, status: "running" } : prev));
                    try {
                      await api.resumeAgent(id);
                    } catch (err: unknown) {
                      toast(err instanceof Error ? err.message : "Resume failed", "error");
                      setAgent((prev) => (prev ? { ...prev, status: "paused" } : prev));
                    } finally {
                      setIsResuming(false);
                    }
                  }}
                >
                  {isResuming ? "Resuming..." : "Resume"}
                </Button>
              )}
              {canStop && (
                <Button
                  variant="tertiaryDestructive"
                  size="24"
                  onClick={() => setShowStopConfirm(true)}
                  disabled={isStopping}
                >
                  {isStopping ? "Stopping..." : isErrored ? "Destroy Agent" : "Stop Agent"}
                </Button>
              )}
            </div>
          </header>

          {/* Metadata panel */}
          {id && <AgentMetadataPanel agentId={id} />}

          {/* Stalled warning banner */}
          {agent?.status === "stalled" && (
            <div className="px-4 py-2 bg-amber-950/30 border-b border-amber-800/50 text-amber-300 text-xs flex items-center gap-2">
              <span>Agent appears stalled (no output for 10+ minutes). Send a message to attempt recovery.</span>
            </div>
          )}

          {/* High-risk grade approval banner */}
          {grades
            .filter((g) => g.overallRisk === "high")
            .map((g) => (
              <div
                key={g.taskId}
                className="px-4 py-2 bg-red-950/30 border-b border-red-800/50 text-red-300 text-xs flex items-center justify-between gap-2"
              >
                <span>
                  High-risk change for task {g.taskId.slice(0, 8)} requires approval.
                  {g.reasoning && ` Reason: ${g.reasoning}`}
                </span>
                <Button variant="tertiary" size="24" onClick={() => setShowApproveConfirm(g.taskId)}>
                  Review &amp; Approve
                </Button>
              </div>
            ))}

          {/* Terminal */}
          <AgentTerminal events={events} />

          {/* Input */}
          <PromptInput
            onSubmit={handleSendMessage}
            disabled={!agent || agent.status === "error" || agent.status === "paused"}
            placeholder={getPlaceholder()}
            onSearchFiles={handleSearchFiles}
            onSlashCommand={handleSlashCommand}
          />
        </main>
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
