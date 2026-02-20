"use client";

import { Badge } from "@fanvue/ui";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { OrchestratorEvent, TaskNode, TaskPriority, TaskStatus, TaskSummary } from "../api";
import { Header } from "../components/Header";
import { Sidebar } from "../components/Sidebar";
import { PRIORITY_COLOR, PRIORITY_LABELS, TASK_STATUS_BADGE_VARIANT, TASK_STATUS_LABELS, timeAgo } from "../constants";
import { useAgentPolling } from "../hooks/useAgentPolling";
import { useApi } from "../hooks/useApi";
import { useKillSwitchContext } from "../killSwitch";

const ALL_STATUSES: TaskStatus[] = ["pending", "assigned", "running", "completed", "failed", "blocked", "cancelled"];

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const tooltipId = useId();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: tooltip wrapper delegates keyboard interaction to children
    <span
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      <span
        id={tooltipId}
        role="tooltip"
        className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-lg shadow-lg w-56 text-center whitespace-normal z-50 transition-opacity ${visible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        {text}
        <span
          className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-zinc-800"
          aria-hidden="true"
        />
      </span>
    </span>
  );
}

function InfoTooltip({ text }: { text: string }) {
  const tooltipId = useId();
  const [visible, setVisible] = useState(false);
  return (
    <span className="relative inline-flex items-center ml-1">
      <button
        type="button"
        aria-label="More information"
        aria-describedby={tooltipId}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-zinc-700 text-zinc-400 text-[10px] font-semibold cursor-help leading-none hover:bg-zinc-600 hover:text-zinc-300 focus-visible:ring-1 focus-visible:ring-zinc-500 focus-visible:outline-none transition-colors"
      >
        i
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-lg shadow-lg w-56 text-center whitespace-normal z-50 transition-opacity ${visible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        {text}
        <span
          className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-zinc-800"
          aria-hidden="true"
        />
      </span>
    </span>
  );
}

function StatCard({ label, value, color, tooltip }: { label: string; value: number; color: string; tooltip?: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 min-w-[120px]">
      <p className="text-xs text-zinc-500 uppercase tracking-wider flex items-center">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </p>
      <p className={`text-2xl font-semibold mt-1 ${color}`}>{value}</p>
    </div>
  );
}

function CreateTaskForm({ onSubmit, submitting }: { onSubmit: (data: CreateFormData) => void; submitting: boolean }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>(3);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({ title: title.trim(), description: description.trim() || undefined, priority });
    setTitle("");
    setDescription("");
    setPriority(3);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
      <div className="flex gap-3">
        <input
          type="text"
          placeholder="Task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={500}
          className="flex-1 px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500"
        />
        <select
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value) as TaskPriority)}
          className="px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-300 focus:outline-none focus:border-zinc-500"
        >
          {([1, 2, 3, 4, 0] as TaskPriority[]).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!title.trim() || submitting}
          className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
        >
          {submitting ? "Creating..." : "Create"}
        </button>
      </div>
      <textarea
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        maxLength={10000}
        className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500 resize-none"
      />
    </form>
  );
}

interface CreateFormData {
  title: string;
  description?: string;
  priority: TaskPriority;
}

function TaskDetailPanel({
  task,
  agentName,
  agents,
  busyAction,
  onAssign,
  onCancel,
  onRetry,
  onDelete,
}: {
  task: TaskNode;
  agentName: string | null;
  agents: Array<{ id: string; name: string }>;
  busyAction: string | null;
  onAssign: (taskId: string, agentId: string) => void;
  onCancel: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onDelete: (taskId: string) => void;
}) {
  const [assignAgentId, setAssignAgentId] = useState("");
  const isBusy = busyAction !== null;

  return (
    <tr>
      <td colSpan={7} className="px-4 py-3 bg-zinc-900/50 border-b border-zinc-800">
        <div className="space-y-3">
          {task.description && (
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Description</p>
              <p className="text-sm text-zinc-300 whitespace-pre-wrap">{task.description}</p>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <p className="text-xs text-zinc-500">Owner</p>
              <p className="text-zinc-300">{agentName ?? task.ownerAgentId ?? "Unassigned"}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Version</p>
              <p className="text-zinc-300">{task.version}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Retries</p>
              <p className="text-zinc-300">
                {task.retryCount} / {task.maxRetries}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Timeout</p>
              <p className="text-zinc-300">{task.timeoutMs ? `${(task.timeoutMs / 1000).toFixed(0)}s` : "None"}</p>
            </div>
          </div>

          {task.requiredCapabilities.length > 0 && (
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Required Capabilities</p>
              <div className="flex flex-wrap gap-1">
                {task.requiredCapabilities.map((cap) => (
                  <span
                    key={cap}
                    className="px-2 py-0.5 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-400"
                  >
                    {cap}
                  </span>
                ))}
              </div>
            </div>
          )}

          {task.dependsOn.length > 0 && (
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Depends On</p>
              <p className="text-xs text-zinc-400 font-mono">{task.dependsOn.join(", ")}</p>
            </div>
          )}

          {task.errorMessage && (
            <div className="p-2 bg-red-950/30 border border-red-900 rounded">
              <p className="text-xs text-red-400">{task.errorMessage}</p>
            </div>
          )}

          {task.acceptanceCriteria && (
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Acceptance Criteria</p>
              <p className="text-sm text-zinc-300 whitespace-pre-wrap">{task.acceptanceCriteria}</p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            {(task.status === "pending" || task.status === "blocked") && agents.length > 0 && (
              <div className="flex items-center gap-2">
                <label htmlFor={`assign-select-${task.id}`} className="text-xs text-zinc-500">
                  Assign to agent:
                </label>
                <select
                  id={`assign-select-${task.id}`}
                  value={assignAgentId}
                  onChange={(e) => setAssignAgentId(e.target.value)}
                  disabled={isBusy}
                  className="px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-300 disabled:opacity-50"
                >
                  <option value="">Select an agent...</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    if (assignAgentId) onAssign(task.id, assignAgentId);
                  }}
                  disabled={!assignAgentId || isBusy}
                  className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
                >
                  {busyAction === "assign" ? "Assigning..." : "Assign"}
                </button>
              </div>
            )}

            {(task.status === "pending" || task.status === "assigned" || task.status === "running") && (
              <button
                type="button"
                onClick={() => onCancel(task.id)}
                disabled={isBusy}
                className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded disabled:opacity-50"
              >
                {busyAction === "cancel" ? "Cancelling..." : "Cancel"}
              </button>
            )}

            {task.status === "failed" && (
              <button
                type="button"
                onClick={() => onRetry(task.id)}
                disabled={isBusy}
                className="px-2 py-1 text-xs bg-amber-700 hover:bg-amber-600 text-white rounded disabled:opacity-50"
              >
                {busyAction === "retry" ? "Retrying..." : "Retry"}
              </button>
            )}

            {(task.status === "completed" || task.status === "cancelled" || task.status === "failed") && (
              <button
                type="button"
                onClick={() => onDelete(task.id)}
                disabled={isBusy}
                className="px-2 py-1 text-xs bg-red-800 hover:bg-red-700 text-red-200 rounded disabled:opacity-50"
              >
                {busyAction === "delete" ? "Deleting..." : "Delete"}
              </button>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

export function TasksView() {
  const api = useApi();
  const { agents } = useAgentPolling();
  const killSwitch = useKillSwitchContext();

  const [tasks, setTasks] = useState<TaskNode[]>([]);
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [events, setEvents] = useState<OrchestratorEvent[]>([]);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const apiRef = useRef(api);
  apiRef.current = api;
  const actionInFlight = useRef(false);

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);

  const load = useCallback(async () => {
    try {
      const [taskList, taskSummary, eventLog] = await Promise.all([
        apiRef.current.fetchTasks(statusFilter ? { status: statusFilter, limit: 250 } : { limit: 250 }),
        apiRef.current.fetchTaskSummary(),
        apiRef.current.fetchOrchestratorEvents(50),
      ]);
      setTasks(taskList);
      setSummary(taskSummary);
      setEvents(eventLog);
      setError(null);
    } catch {
      setError("Failed to load tasks");
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  const handleCreate = async (data: CreateFormData) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setSubmitting(true);
    try {
      await api.createTask(data);
      setShowCreate(false);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setSubmitting(false);
      actionInFlight.current = false;
    }
  };

  const handleAssign = async (taskId: string, agentId: string) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyAction("assign");
    try {
      await api.assignTask(taskId, agentId);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to assign task");
    } finally {
      setBusyAction(null);
      actionInFlight.current = false;
    }
  };

  const handleCancel = async (taskId: string) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyAction("cancel");
    try {
      await api.cancelTask(taskId);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to cancel task");
    } finally {
      setBusyAction(null);
      actionInFlight.current = false;
    }
  };

  const handleRetry = async (taskId: string) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyAction("retry");
    try {
      await api.retryTask(taskId);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to retry task");
    } finally {
      setBusyAction(null);
      actionInFlight.current = false;
    }
  };

  const handleDelete = async (taskId: string) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyAction("delete");
    try {
      await api.deleteTask(taskId);
      if (expandedId === taskId) setExpandedId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete task");
    } finally {
      setBusyAction(null);
      actionInFlight.current = false;
    }
  };

  const handleClearAll = async () => {
    if (actionInFlight.current) return;
    if (!confirm("Delete ALL tasks? This cannot be undone.")) return;
    actionInFlight.current = true;
    setBusyAction("clearAll");
    try {
      await api.clearAllTasks();
      setExpandedId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to clear tasks");
    } finally {
      setBusyAction(null);
      actionInFlight.current = false;
    }
  };

  const handleTriggerAssignment = async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyAction("triggerAssign");
    try {
      const result = await api.triggerAssignment();
      const count = result.assignments.length;
      if (count === 0) {
        setError("No assignments made -- no matching idle agents or pending tasks");
      } else {
        setError(null);
      }
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to trigger assignment");
    } finally {
      setBusyAction(null);
      actionInFlight.current = false;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <Header agentCount={agents.length} killSwitch={killSwitch} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar agents={agents} activeId={null} />
        <main id="main-content" className="flex-1 overflow-y-auto p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Tasks</h2>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreate((s) => !s)}
                  className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
                >
                  {showCreate ? "Cancel" : "+ New Task"}
                </button>
                <Tooltip text="Automatically matches pending tasks with idle agents. No effect if no tasks are pending or agents available.">
                  <button
                    type="button"
                    onClick={handleTriggerAssignment}
                    disabled={busyAction === "triggerAssign"}
                    className="px-3 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors disabled:opacity-50"
                  >
                    {busyAction === "triggerAssign" ? "Assigning..." : "Auto-Assign"}
                  </button>
                </Tooltip>
              </div>
              <button
                type="button"
                onClick={handleClearAll}
                disabled={busyAction === "clearAll"}
                className="px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded transition-colors disabled:opacity-50"
              >
                {busyAction === "clearAll" ? "Clearing..." : "Clear All"}
              </button>
            </div>
          </div>

          <details className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden group" open>
            <summary className="px-4 py-3 text-sm text-zinc-400 cursor-pointer hover:text-zinc-200 flex items-center gap-2 select-none">
              <svg
                className="w-4 h-4 text-zinc-500 transition-transform group-open:rotate-90"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <span className="font-medium text-zinc-300">How does the task queue work?</span>
              <span className="text-xs text-zinc-600 ml-auto hidden group-open:inline">Collapse</span>
              <span className="text-xs text-zinc-600 ml-auto group-open:hidden">Expand</span>
            </summary>
            <div className="px-4 pb-3 space-y-2 text-sm text-zinc-400 border-t border-zinc-800 pt-3">
              <p>
                The task queue lets you define work items that agents pick up and execute automatically. Create tasks
                here, then either manually assign them to agents or click{" "}
                <strong className="text-zinc-300">Auto-Assign</strong> to let the orchestrator match pending tasks with
                available agents.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Use the task queue when</p>
                  <ul className="space-y-0.5 text-zinc-400">
                    <li className="flex gap-1.5">
                      <span className="text-zinc-600" aria-hidden="true">
                        –
                      </span>
                      You have multiple tasks to queue and prioritize
                    </li>
                    <li className="flex gap-1.5">
                      <span className="text-zinc-600" aria-hidden="true">
                        –
                      </span>
                      Tasks have dependencies on each other
                    </li>
                    <li className="flex gap-1.5">
                      <span className="text-zinc-600" aria-hidden="true">
                        –
                      </span>
                      You want automatic assignment to idle agents
                    </li>
                    <li className="flex gap-1.5">
                      <span className="text-zinc-600" aria-hidden="true">
                        –
                      </span>
                      You need retry logic or timeout enforcement
                    </li>
                    <li className="flex gap-1.5">
                      <span className="text-zinc-600" aria-hidden="true">
                        –
                      </span>
                      You want a persistent audit trail of work done
                    </li>
                  </ul>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Spawn an agent directly when</p>
                  <ul className="space-y-0.5 text-zinc-400">
                    <li className="flex gap-1.5">
                      <span className="text-zinc-600" aria-hidden="true">
                        –
                      </span>
                      You want work to start immediately
                    </li>
                    <li className="flex gap-1.5">
                      <span className="text-zinc-600" aria-hidden="true">
                        –
                      </span>
                      The task is interactive or exploratory
                    </li>
                    <li className="flex gap-1.5">
                      <span className="text-zinc-600" aria-hidden="true">
                        –
                      </span>
                      You need a specific model or configuration
                    </li>
                    <li className="flex gap-1.5">
                      <span className="text-zinc-600" aria-hidden="true">
                        –
                      </span>
                      You want to message the agent directly
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </details>

          {error && (
            <div className="p-2 bg-red-950/50 border border-red-800 rounded text-sm text-red-400 flex items-center justify-between">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Dismiss error"
                className="text-red-500 hover:text-red-300 ml-2"
              >
                x
              </button>
            </div>
          )}

          {showCreate && <CreateTaskForm onSubmit={handleCreate} submitting={submitting} />}

          {summary && (
            <div className="flex gap-3 flex-wrap">
              <StatCard label="Total" value={summary.total} color="text-zinc-100" />
              <StatCard
                label="Active"
                value={summary.byStatus.running + summary.byStatus.assigned}
                color="text-green-400"
                tooltip="Tasks currently running or assigned to an agent"
              />
              <StatCard
                label="Pending"
                value={summary.byStatus.pending}
                color="text-zinc-400"
                tooltip="Tasks waiting to be assigned to an agent"
              />
              <StatCard label="Completed" value={summary.byStatus.completed} color="text-blue-400" />
              {summary.byStatus.failed > 0 && (
                <StatCard
                  label="Failed"
                  value={summary.byStatus.failed}
                  color="text-red-400"
                  tooltip="Tasks that errored out. Click a task to retry."
                />
              )}
              {summary.byStatus.blocked > 0 && (
                <StatCard
                  label="Blocked"
                  value={summary.byStatus.blocked}
                  color="text-amber-400"
                  tooltip="Tasks waiting on dependencies to complete first"
                />
              )}
            </div>
          )}

          <div className="flex gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setStatusFilter(null)}
              aria-pressed={statusFilter === null}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                statusFilter === null ? "bg-zinc-600 text-zinc-100" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              All
            </button>
            {ALL_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s === statusFilter ? null : s)}
                aria-pressed={statusFilter === s}
                className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                  statusFilter === s ? "bg-zinc-600 text-zinc-100" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                }`}
              >
                {TASK_STATUS_LABELS[s]}
                {summary ? ` (${summary.byStatus[s]})` : ""}
              </button>
            ))}
          </div>

          <div className="border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-900 text-zinc-500 text-left text-xs uppercase tracking-wider">
                  <th className="px-4 py-2.5">Title</th>
                  <th className="px-4 py-2.5 w-24">Status</th>
                  <th className="px-4 py-2.5 w-20">Priority</th>
                  <th className="px-4 py-2.5 w-28" title="The agent currently assigned to this task">
                    Owner
                  </th>
                  <th className="px-4 py-2.5 w-16" title="Number of tasks this depends on (must complete first)">
                    Deps
                  </th>
                  <th className="px-4 py-2.5 w-24">Created</th>
                  <th className="px-4 py-2.5 w-20">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tasks.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center">
                      {statusFilter ? (
                        <span className="text-zinc-500">No {statusFilter} tasks</span>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-zinc-400">No tasks in the queue</p>
                          <p className="text-xs text-zinc-600">
                            Click <strong className="text-zinc-400">+ New Task</strong> to create one, or use the{" "}
                            <strong className="text-zinc-400">Auto-Assign</strong> button after adding tasks to
                            automatically distribute them to idle agents.
                          </p>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                {tasks.map((task) => {
                  const ownerName = task.ownerAgentId ? (agentMap.get(task.ownerAgentId) ?? null) : null;
                  const isExpanded = expandedId === task.id;
                  return (
                    <Fragment key={task.id}>
                      <tr
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        onClick={() => setExpandedId(isExpanded ? null : task.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setExpandedId(isExpanded ? null : task.id);
                          }
                        }}
                        className={`border-b border-zinc-800/50 cursor-pointer transition-colors ${
                          isExpanded ? "bg-zinc-900/80" : "hover:bg-zinc-900/40"
                        }`}
                      >
                        <td className="px-4 py-2.5 text-zinc-200 truncate max-w-[300px]" title={task.title}>
                          <span className="flex items-center gap-1.5">
                            <svg
                              className={`w-3 h-3 text-zinc-600 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                              aria-hidden="true"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                            </svg>
                            {task.title}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge variant={TASK_STATUS_BADGE_VARIANT[task.status] || "default"}>
                            {TASK_STATUS_LABELS[task.status] || task.status}
                          </Badge>
                        </td>
                        <td className={`px-4 py-2.5 ${PRIORITY_COLOR[task.priority] || "text-zinc-600"}`}>
                          {PRIORITY_LABELS[task.priority]}
                        </td>
                        <td className="px-4 py-2.5 text-zinc-400 truncate max-w-[120px]">
                          {ownerName ?? (task.ownerAgentId ? task.ownerAgentId.slice(0, 8) : "--")}
                        </td>
                        <td className="px-4 py-2.5 text-zinc-500">{task.dependsOn.length || "--"}</td>
                        <td className="px-4 py-2.5 text-zinc-500">{timeAgo(task.createdAt)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex gap-1">
                            {(task.status === "pending" || task.status === "assigned" || task.status === "running") && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCancel(task.id);
                                }}
                                disabled={actionInFlight.current}
                                className="px-1.5 py-0.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            )}
                            {task.status === "failed" && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRetry(task.id);
                                }}
                                disabled={actionInFlight.current}
                                className="px-1.5 py-0.5 text-xs bg-amber-700 hover:bg-amber-600 text-white rounded disabled:opacity-50"
                              >
                                Retry
                              </button>
                            )}
                            {(task.status === "completed" ||
                              task.status === "cancelled" ||
                              task.status === "failed") && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDelete(task.id);
                                }}
                                disabled={actionInFlight.current}
                                className="px-1.5 py-0.5 text-xs bg-red-800/60 hover:bg-red-700 text-red-300 rounded disabled:opacity-50"
                              >
                                Del
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <TaskDetailPanel
                          key={`detail-${task.id}`}
                          task={task}
                          agentName={ownerName}
                          agents={agents.map((a) => ({ id: a.id, name: a.name }))}
                          busyAction={busyAction}
                          onAssign={handleAssign}
                          onCancel={handleCancel}
                          onRetry={handleRetry}
                          onDelete={handleDelete}
                        />
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {events.length > 0 && (
            <details className="border border-zinc-800 rounded-lg">
              <summary className="px-4 py-2.5 text-sm text-zinc-400 cursor-pointer hover:text-zinc-200">
                Orchestrator Events ({events.length})
              </summary>
              <div className="max-h-64 overflow-y-auto border-t border-zinc-800">
                {events
                  .slice()
                  .reverse()
                  .map((evt, i) => (
                    <div
                      key={`${evt.timestamp}-${i}`}
                      className="px-4 py-2 border-b border-zinc-800/50 text-xs flex items-start gap-3"
                    >
                      <span className="text-zinc-500 whitespace-nowrap shrink-0">{timeAgo(evt.timestamp)}</span>
                      <span className="text-zinc-400 font-mono">{evt.type}</span>
                      <span className="text-zinc-500 truncate">
                        {Object.entries(evt.details)
                          .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
                          .join(" ")}
                      </span>
                    </div>
                  ))}
              </div>
            </details>
          )}
        </main>
      </div>
    </div>
  );
}
