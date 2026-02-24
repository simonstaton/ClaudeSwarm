"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Agent, GradeResult } from "../api";
import { AgentMetadataPanel } from "../components/AgentMetadataPanel";
import { AgentTerminal } from "../components/AgentTerminal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Header } from "../components/Header";
import { type Attachment, PromptInput } from "../components/PromptInput";
import { RiskBadge } from "../components/RiskBadge";
import { Sidebar } from "../components/Sidebar";
import { AgentHeaderSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { STATUS_BADGE_VARIANT, STATUS_LABELS } from "../constants";
import { useAgentPolling } from "../hooks/useAgentPolling";
import { useAgentStream } from "../hooks/useAgentStream";
import { useApi } from "../hooks/useApi";
import { usePageVisible } from "../hooks/usePageVisible";
import { useKillSwitchContext } from "../killSwitch";
import { formatRepo } from "../utils/git";

export function AgentView({ agentId }: { agentId: string }) {
  const router = useRouter();
  const id = agentId;
  const api = useApi();
  const apiRef = useRef(api);
  apiRef.current = api;
  const { agents } = useAgentPolling();
  const visible = usePageVisible();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isTogglingPerms, setIsTogglingPerms] = useState(false);
  const { events, isStreaming, error, sendMessage, reconnect, clearEvents, injectEvent } = useAgentStream(id || null);
  const killSwitch = useKillSwitchContext();
  const { toast } = useToast();
  const [grades, setGrades] = useState<GradeResult[]>([]);
  const [showApproveConfirm, setShowApproveConfirm] = useState<string | null>(null);
  const [scrollTrigger, setScrollTrigger] = useState(0);

  // Set page title based on agent name
  useEffect(() => {
    document.title = agent?.name ? `${agent.name} - AgentManager` : "AgentManager";
  }, [agent?.name]);

  // Load agent details and reconnect to stream.
  // Use refs for clearEvents/reconnect/api so this effect only re-runs when
  // `id` changes - not when callback references change (which caused redundant
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
        if (!cancelled) router.replace("/");
      }
    };
    load();

    return () => {
      cancelled = true;
      setAgent(null);
    };
  }, [id, router.replace]);

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
    try {
      await apiRef.current.destroyAgent(id);
      router.replace("/");
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to stop agent", "error");
      setIsStopping(false);
    }
  };

  const handleToggleSkipPermissions = async () => {
    if (!id || !agent || isTogglingPerms) return;
    const next = !agent.dangerouslySkipPermissions;
    setIsTogglingPerms(true);
    setAgent((prev) => (prev ? { ...prev, dangerouslySkipPermissions: next } : prev));
    try {
      const updated = await api.patchAgent(id, { dangerouslySkipPermissions: next });
      setAgent(updated);
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to update permissions", "error");
      setAgent((prev) => (prev ? { ...prev, dangerouslySkipPermissions: !next } : prev));
    } finally {
      setIsTogglingPerms(false);
    }
  };

  const isDisconnected = agent?.status === "disconnected";
  const canStop =
    agent && ["running", "idle", "restored", "error", "stalled", "paused", "disconnected"].includes(agent.status);
  const isErrored = agent?.status === "error";

  const handleSendMessage = (prompt: string, attachments?: Attachment[]) => {
    sendMessage(prompt, undefined, undefined, attachments);
    setScrollTrigger((c) => c + 1);
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
              "  /cost     - Show token usage and cost for this session",
              "  /status   - Show agent status and session info",
              "  /clear    - Clear terminal output",
              "  /compact  - Ask agent to summarize the conversation",
              "  /review   - Ask agent to review recent changes",
              "  /help     - Show this help",
              "",
              "Input features:",
              "  @filename  - Reference a file in the agent's workspace",
              "  Paste/drag - Attach images or text files",
              "  Shift+Enter - Insert newline",
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
    if (agent?.status === "disconnected") return "Agent disconnected after server restart - dismiss to remove";
    if (agent?.status === "restored") return "Agent restored from crash - send a message to resume...";
    if (agent?.status === "stalled") return "Agent appears stalled - send a message to attempt recovery...";
    if (agent?.status === "paused") return "Agent is paused - resume to continue...";
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
        title={isDisconnected ? "Dismiss this agent?" : isErrored ? "Destroy this agent?" : "Stop this agent?"}
        description={
          isDisconnected
            ? "The agent lost its process after a server restart. Dismissing will remove it permanently."
            : isErrored
              ? "The errored agent will be cleaned up and removed."
              : "The agent process will be terminated. Any in-progress work may be lost."
        }
        confirmLabel={isDisconnected ? "Dismiss Agent" : isErrored ? "Destroy Agent" : "Stop Agent"}
        variant="destructive"
      />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar agents={agents} activeId={id || null} />

        <main id="main-content" className="flex-1 flex flex-col overflow-hidden">
          {/* Agent header */}
          <header className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900/30">
            <div className="flex items-center gap-3 min-w-0">
              {agent ? (
                <>
                  <h2 className="text-sm font-medium shrink-0">{agent.name}</h2>
                  <StatusBadge status={agent.status} />
                  {grades.length > 0 && <RiskBadge risk={grades[grades.length - 1].overallRisk} />}
                  {(agent.gitBranch || agent.gitRepo) && (
                    <span
                      className="text-[11px] font-mono text-zinc-500 truncate"
                      title={[agent.gitRepo, agent.gitBranch, agent.gitWorktree ? `worktree: ${agent.gitWorktree}` : ""]
                        .filter(Boolean)
                        .join(" | ")}
                    >
                      {agent.gitRepo && <span>{formatRepo(agent.gitRepo)}</span>}
                      {agent.gitRepo && agent.gitBranch && <span className="text-zinc-600">:</span>}
                      {agent.gitBranch && <span className="text-emerald-400/70">{agent.gitBranch}</span>}
                      {agent.gitWorktree && <span className="text-zinc-600 ml-1">(wt)</span>}
                    </span>
                  )}
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
              {agent && (
                <label
                  className="flex items-center gap-1.5 cursor-pointer select-none"
                  title="Toggle --dangerously-skip-permissions for the next message (takes effect on next Claude process spawn)"
                >
                  <input
                    type="checkbox"
                    checked={agent.dangerouslySkipPermissions === true}
                    onChange={handleToggleSkipPermissions}
                    disabled={isTogglingPerms}
                    className="w-3 h-3 accent-amber-500"
                  />
                  <span className="text-[10px] text-zinc-400 whitespace-nowrap">Skip permissions</span>
                </label>
              )}
              <Button
                variant="ghost"
                size="sm"
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
              <Button variant="ghost" size="sm" onClick={reconnect}>
                Reconnect
              </Button>
              {agent &&
                (isPausing || agent.status === "running" || agent.status === "idle" || agent.status === "stalled") && (
                  <Button
                    variant="ghost"
                    size="sm"
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
                  variant="ghost"
                  size="sm"
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
                  variant="destructive"
                  size="sm"
                  onClick={() => setShowStopConfirm(true)}
                  disabled={isStopping}
                  className="transition-colors duration-[var(--duration-fast)]"
                >
                  {isStopping
                    ? "Stopping..."
                    : isDisconnected
                      ? "Dismiss Agent"
                      : isErrored
                        ? "Destroy Agent"
                        : "Stop Agent"}
                </Button>
              )}
            </div>
          </header>

          {/* Metadata panel */}
          {id && <AgentMetadataPanel agentId={id} />}

          {/* Disconnected warning banner */}
          {agent?.status === "disconnected" && (
            <div className="px-4 py-2 bg-zinc-800/60 border-b border-zinc-700/50 text-zinc-400 text-xs flex items-center justify-between gap-2">
              <span>
                This agent lost its backing process after a server restart. It cannot be resumed. Dismiss it to remove
                it from the list.
              </span>
              <Button variant="destructive" size="sm" onClick={() => setShowStopConfirm(true)}>
                Dismiss Agent
              </Button>
            </div>
          )}

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
                <Button variant="ghost" size="sm" onClick={() => setShowApproveConfirm(g.taskId)}>
                  Review &amp; Approve
                </Button>
              </div>
            ))}

          {/* Terminal */}
          <AgentTerminal events={events} scrollToBottomTrigger={scrollTrigger} />

          {/* Input */}
          <PromptInput
            onSubmit={handleSendMessage}
            disabled={
              !agent || agent.status === "error" || agent.status === "paused" || agent.status === "disconnected"
            }
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
  return <Badge variant={STATUS_BADGE_VARIANT[status] || "default"}>{STATUS_LABELS[status] ?? status}</Badge>;
}
