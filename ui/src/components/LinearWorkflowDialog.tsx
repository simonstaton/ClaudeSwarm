"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth";
import { useToast } from "./Toast";

interface LinearWorkflow {
  id: string;
  linearUrl: string;
  repository: string;
  status: "starting" | "running" | "completed" | "failed" | "cancelled";
  agents: Array<{ id: string; name: string; role: string; status?: string; currentTask?: string }>;
  prUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface LinearWorkflowDialogProps {
  open: boolean;
  onClose: () => void;
  linearConfigured: boolean;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  starting: { label: "Starting", color: "text-amber-400" },
  running: { label: "Running", color: "text-cyan-400" },
  completed: { label: "Completed", color: "text-green-400" },
  failed: { label: "Failed", color: "text-red-400" },
  cancelled: { label: "Cancelled", color: "text-zinc-400" },
};

export function LinearWorkflowDialog({ open, onClose, linearConfigured }: LinearWorkflowDialogProps) {
  const { authFetch } = useAuth();
  const { toast } = useToast();
  const [linearUrl, setLinearUrl] = useState("");
  const [repository, setRepository] = useState("ClaudeSwarm_PRIVATE");
  const [submitting, setSubmitting] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [workflows, setWorkflows] = useState<LinearWorkflow[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch workflows when dialog opens; poll only while active workflows exist
  const hasActiveWorkflows = workflows.some((w) => w.status === "starting" || w.status === "running");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const fetchWorkflows = async () => {
      try {
        const res = await authFetch("/api/workflows");
        if (res.ok && !cancelled) {
          setWorkflows(await res.json());
        }
      } catch {
        // Ignore fetch errors for workflow list
      }
    };

    fetchWorkflows();

    // Only poll while there are active (non-terminal) workflows
    if (!hasActiveWorkflows) return;
    const interval = setInterval(fetchWorkflows, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [open, authFetch, hasActiveWorkflows]);

  // Focus input when dialog opens
  useEffect(() => {
    if (open && linearConfigured) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, linearConfigured]);

  const handleAuthorize = useCallback(async () => {
    setAuthorizing(true);
    try {
      const res = await authFetch("/api/mcp/auth/linear", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start authorization");
      }
      const { authUrl } = await res.json();
      if (authUrl) {
        window.open(authUrl, "_blank", "width=600,height=700");
        toast("Linear authorization started. Complete it in the opened window.", "info");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Authorization failed", "error");
    } finally {
      setAuthorizing(false);
    }
  }, [authFetch, toast]);

  const handleSubmit = useCallback(async () => {
    if (!linearUrl.trim()) {
      toast("Please enter a Linear issue URL", "warning");
      return;
    }

    setSubmitting(true);
    try {
      const res = await authFetch("/api/workflows/linear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linearUrl: linearUrl.trim(), repository: repository.trim() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start workflow");
      }

      const { workflow } = await res.json();
      toast(`Workflow started for ${linearUrl.split("/").pop()}`, "success");
      setLinearUrl("");
      setWorkflows((prev) => [workflow, ...prev]);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to start workflow", "error");
    } finally {
      setSubmitting(false);
    }
  }, [linearUrl, repository, authFetch, toast]);

  const handleCancel = useCallback(
    async (workflowId: string) => {
      try {
        const res = await authFetch(`/api/workflows/${workflowId}`, { method: "DELETE" });
        if (res.ok) {
          setWorkflows((prev) => prev.map((w) => (w.id === workflowId ? { ...w, status: "cancelled" as const } : w)));
          toast("Workflow cancelled", "info");
        }
      } catch {
        toast("Failed to cancel workflow", "error");
      }
    },
    [authFetch, toast],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="linear-workflow-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl max-w-lg w-full mx-4 p-6 max-h-[85vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 id="linear-workflow-title" className="text-base font-semibold text-zinc-100">
            Linear to PR
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 transition-colors p-1"
            aria-label="Close dialog"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {!linearConfigured ? (
          /* Authorization mode */
          <div className="text-center py-6">
            <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" role="img" aria-label="Linear integration">
                <title>Linear integration</title>
                <path
                  d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
                  fill="currentColor"
                  className="text-zinc-500"
                />
              </svg>
            </div>
            <p className="text-sm text-zinc-300 mb-2">Linear is not connected</p>
            <p className="text-xs text-zinc-500 mb-6">Authorize Linear to enable one-click issue-to-PR workflows.</p>
            <button
              type="button"
              onClick={handleAuthorize}
              disabled={authorizing}
              className="px-5 py-2.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors disabled:opacity-50"
            >
              {authorizing ? "Opening authorization..." : "Authorize Linear"}
            </button>
          </div>
        ) : (
          /* Workflow creation mode */
          <>
            <p className="text-xs text-zinc-400 mb-4">
              Paste a Linear issue URL and select a repository. A team of agents will implement the issue and create a
              PR for review.
            </p>

            <div className="space-y-3 mb-5">
              <div>
                <label htmlFor="linear-url" className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Linear Issue URL
                </label>
                <input
                  ref={inputRef}
                  id="linear-url"
                  type="url"
                  value={linearUrl}
                  onChange={(e) => setLinearUrl(e.target.value)}
                  placeholder="https://linear.app/team/issue/TEAM-123"
                  className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !submitting) handleSubmit();
                  }}
                />
              </div>

              <div>
                <label htmlFor="repository" className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Repository
                </label>
                <input
                  id="repository"
                  type="text"
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                  placeholder="ClaudeSwarm_PRIVATE"
                  className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !linearUrl.trim()}
              className="w-full px-4 py-2.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Starting workflow..." : "Start workflow"}
            </button>
          </>
        )}

        {/* Active workflows */}
        {workflows.length > 0 && (
          <div className="mt-6 pt-5 border-t border-zinc-800">
            <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">Workflows</h3>
            <div className="space-y-2">
              {workflows.map((wf) => {
                const statusInfo = STATUS_LABELS[wf.status] ?? { label: wf.status, color: "text-zinc-400" };
                const issueId = wf.linearUrl.match(/\/([\w]+-\d+)/)?.[1] ?? "Issue";
                return (
                  <div key={wf.id} className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-md">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-zinc-200 font-medium truncate">{issueId}</span>
                        <span className={`text-xs ${statusInfo.color}`}>{statusInfo.label}</span>
                      </div>
                      {wf.prUrl && (
                        <a
                          href={wf.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-indigo-400 hover:text-indigo-300 mt-0.5 block truncate"
                        >
                          {wf.prUrl}
                        </a>
                      )}
                      {wf.error && <p className="text-xs text-red-400 mt-0.5 truncate">{wf.error}</p>}
                      {wf.agents.length > 0 && (
                        <p className="text-xs text-zinc-500 mt-0.5">
                          {wf.agents.length} agent{wf.agents.length !== 1 ? "s" : ""} working
                        </p>
                      )}
                    </div>
                    {(wf.status === "starting" || wf.status === "running") && (
                      <button
                        type="button"
                        onClick={() => handleCancel(wf.id)}
                        className="ml-3 text-xs text-zinc-500 hover:text-red-400 transition-colors flex-shrink-0"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
