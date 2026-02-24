"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { useApi } from "../hooks/useApi";
import type { KillSwitchState } from "../hooks/useKillSwitch";
import { ConfirmDialog } from "./ConfirmDialog";
import { LinearWorkflowDialog } from "./LinearWorkflowDialog";

const NAV_LINKS: Array<{ path: string; label: string; active: (pathname: string) => boolean }> = [
  { path: "/graph", label: "Graph", active: (p) => p === "/graph" },
  { path: "/costs", label: "Costs", active: (p) => p === "/costs" },
  { path: "/tasks", label: "Tasks", active: (p) => p === "/tasks" },
  { path: "/messages", label: "Messages", active: (p) => p === "/messages" },
  { path: "/settings", label: "Settings", active: (p) => p.startsWith("/settings") },
];

interface HeaderProps {
  agentCount: number;
  killSwitch: {
    state: KillSwitchState;
    loading: boolean;
    error: string | null;
    activate: (reason?: string) => Promise<void>;
  };
}

export function Header({ agentCount, killSwitch }: HeaderProps) {
  const { logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const api = useApi();
  const [confirming, setConfirming] = useState(false);
  const [linearDialogOpen, setLinearDialogOpen] = useState(false);
  const [linearConfigured, setLinearConfigured] = useState<boolean | null>(null);

  // Fetch Linear configuration status on mount
  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((settings) => {
        if (!cancelled) {
          setLinearConfigured(settings.linearConfigured ?? false);
        }
      })
      .catch(() => {
        if (!cancelled) setLinearConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const handlePanicClick = () => {
    if (killSwitch.state.killed) return;
    setConfirming(true);
  };

  const handleConfirmKill = async () => {
    setConfirming(false);
    await killSwitch.activate("Manual activation via UI panic button");
  };

  return (
    <>
      <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => router.push("/")}
            className="text-lg font-semibold tracking-tight hover:text-white transition-colors"
          >
            AgentManager
          </button>
          {agentCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-medium bg-zinc-700 text-zinc-300 rounded-full">
              {agentCount}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Linear workflow button - always visible, dialog handles auth state */}
          {linearConfigured !== null && (
            <button
              type="button"
              onClick={() => setLinearDialogOpen(true)}
              title={linearConfigured ? "Start a Linear issue workflow" : "Connect Linear"}
              className="px-3 py-1.5 text-sm font-medium bg-primary/40 hover:bg-primary/60 border border-primary/50 hover:border-primary/70 text-primary-foreground rounded transition-colors duration-[var(--duration-fast)]"
            >
              Linear
            </button>
          )}

          {/* Panic button - only shown when kill switch is not already active */}
          {!killSwitch.state.killed && (
            <button
              type="button"
              onClick={handlePanicClick}
              disabled={killSwitch.loading}
              title="Emergency kill switch - stops all agents immediately"
              aria-label="Activate emergency kill switch"
              className="px-3 py-1.5 text-sm font-medium bg-red-900/60 hover:bg-red-800 border border-red-700 hover:border-red-500 text-red-300 hover:text-red-100 rounded transition-colors disabled:opacity-50"
            >
              Kill Switch
            </button>
          )}

          <nav aria-label="Main navigation" className="flex items-center gap-2">
            {NAV_LINKS.map(({ path: href, label, active }) => (
              <button
                key={href}
                type="button"
                onClick={() => router.push(href)}
                aria-current={active(pathname) ? "page" : undefined}
                className={`px-3 py-1.5 text-sm rounded transition-colors ${
                  active(pathname) ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={logout}
              className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
            >
              Logout
            </button>
          </nav>
        </div>
      </header>

      <ConfirmDialog
        open={confirming}
        onConfirm={handleConfirmKill}
        onCancel={() => setConfirming(false)}
        title="Activate Emergency Kill Switch?"
        description="This action is immediate and cannot be undone without manual re-authentication."
        variant="destructive"
        confirmLabel={killSwitch.loading ? "Activating..." : "Yes, kill all agents"}
        cancelLabel="Cancel"
        confirmDisabled={killSwitch.loading}
      >
        <p className="text-sm text-zinc-400 mt-1 mb-4">
          This action is immediate and cannot be undone without manual re-authentication.
        </p>
        <div className="bg-zinc-950 border border-zinc-800 rounded-md p-4 mb-4">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
            What will happen immediately:
          </p>
          <ul className="space-y-2">
            <li className="flex items-start gap-2 text-sm text-zinc-300">
              <span className="text-red-500 mt-0.5 flex-shrink-0">&#8226;</span>
              <span>
                All {agentCount > 0 ? agentCount : ""} running agent{agentCount !== 1 ? "s" : ""} will be{" "}
                <strong className="text-red-400">force-killed</strong> (SIGKILL) - any in-progress work is lost
              </span>
            </li>
            <li className="flex items-start gap-2 text-sm text-zinc-300">
              <span className="text-red-500 mt-0.5 flex-shrink-0">&#8226;</span>
              <span>
                All agent state files are <strong className="text-red-400">permanently deleted</strong> - agents cannot
                be restored
              </span>
            </li>
            <li className="flex items-start gap-2 text-sm text-zinc-300">
              <span className="text-red-500 mt-0.5 flex-shrink-0">&#8226;</span>
              <span>
                All API tokens are <strong className="text-red-400">invalidated</strong> - every session (including this
                one) will require re-login
              </span>
            </li>
            <li className="flex items-start gap-2 text-sm text-zinc-300">
              <span className="text-red-500 mt-0.5 flex-shrink-0">&#8226;</span>
              <span>
                New agents <strong className="text-red-400">cannot be spawned</strong> until you manually deactivate the
                kill switch
              </span>
            </li>
            <li className="flex items-start gap-2 text-sm text-zinc-300">
              <span className="text-red-500 mt-0.5 flex-shrink-0">&#8226;</span>
              <span>
                Kill switch state is <strong className="text-red-400">persisted to GCS</strong> - it survives container
                restarts
              </span>
            </li>
          </ul>
        </div>
        {killSwitch.error && (
          <p className="text-xs text-red-400 mb-4 p-2 bg-red-950/50 border border-red-800 rounded">
            {killSwitch.error}
          </p>
        )}
      </ConfirmDialog>

      {/* Linear workflow dialog */}
      <LinearWorkflowDialog
        open={linearDialogOpen}
        onClose={() => setLinearDialogOpen(false)}
        linearConfigured={linearConfigured ?? false}
      />
    </>
  );
}
