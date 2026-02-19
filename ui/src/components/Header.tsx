"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "../auth";
import type { KillSwitchState } from "../hooks/useKillSwitch";
import { SettingsDialog } from "../views/Settings";

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
  const [confirming, setConfirming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
            Swarm
          </button>
          {agentCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-medium bg-zinc-700 text-zinc-300 rounded-full">
              {agentCount}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Panic button — only shown when kill switch is not already active */}
          {!killSwitch.state.killed && (
            <button
              type="button"
              onClick={handlePanicClick}
              disabled={killSwitch.loading}
              title="Emergency kill switch — stops all agents immediately"
              aria-label="Activate emergency kill switch"
              className="px-3 py-1.5 text-sm font-medium bg-red-900/60 hover:bg-red-800 border border-red-700 hover:border-red-500 text-red-300 hover:text-red-100 rounded transition-colors disabled:opacity-50"
            >
              Kill Switch
            </button>
          )}

          <nav aria-label="Main navigation" className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push("/graph")}
              aria-current={pathname === "/graph" ? "page" : undefined}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${
                pathname === "/graph"
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              }`}
            >
              Graph
            </button>
            <button
              type="button"
              onClick={() => router.push("/costs")}
              aria-current={pathname === "/costs" ? "page" : undefined}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${
                pathname === "/costs"
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              }`}
            >
              Costs
            </button>
            <button
              type="button"
              onClick={() => router.push("/messages")}
              aria-current={pathname === "/messages" ? "page" : undefined}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${
                pathname === "/messages"
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              }`}
            >
              Messages
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
            >
              Settings
            </button>
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

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Full-screen confirmation modal — rendered outside the header so it covers the whole page */}
      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="kill-switch-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setConfirming(false);
          }}
        >
          <div className="bg-zinc-900 border border-red-800 rounded-lg shadow-2xl max-w-md w-full mx-4 p-6">
            {/* Header */}
            <div className="flex items-start gap-3 mb-4">
              <span className="text-red-500 text-2xl leading-none mt-0.5" aria-hidden="true">
                &#9888;
              </span>
              <div>
                <h2 id="kill-switch-dialog-title" className="text-base font-semibold text-red-400">
                  Activate Emergency Kill Switch?
                </h2>
                <p className="text-sm text-zinc-400 mt-1">
                  This action is immediate and cannot be undone without manual re-authentication.
                </p>
              </div>
            </div>

            {/* What will happen */}
            <div className="bg-zinc-950 border border-zinc-800 rounded-md p-4 mb-5">
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                What will happen immediately:
              </p>
              <ul className="space-y-2">
                <li className="flex items-start gap-2 text-sm text-zinc-300">
                  <span className="text-red-500 mt-0.5 flex-shrink-0">&#8226;</span>
                  <span>
                    All {agentCount > 0 ? agentCount : ""} running agent{agentCount !== 1 ? "s" : ""} will be{" "}
                    <strong className="text-red-400">force-killed</strong> (SIGKILL) — any in-progress work is lost
                  </span>
                </li>
                <li className="flex items-start gap-2 text-sm text-zinc-300">
                  <span className="text-red-500 mt-0.5 flex-shrink-0">&#8226;</span>
                  <span>
                    All agent state files are <strong className="text-red-400">permanently deleted</strong> — agents
                    cannot be restored
                  </span>
                </li>
                <li className="flex items-start gap-2 text-sm text-zinc-300">
                  <span className="text-red-500 mt-0.5 flex-shrink-0">&#8226;</span>
                  <span>
                    All API tokens are <strong className="text-red-400">invalidated</strong> — every session (including
                    this one) will require re-login
                  </span>
                </li>
                <li className="flex items-start gap-2 text-sm text-zinc-300">
                  <span className="text-red-500 mt-0.5 flex-shrink-0">&#8226;</span>
                  <span>
                    New agents <strong className="text-red-400">cannot be spawned</strong> until you manually deactivate
                    the kill switch
                  </span>
                </li>
                <li className="flex items-start gap-2 text-sm text-zinc-300">
                  <span className="text-red-500 mt-0.5 flex-shrink-0">&#8226;</span>
                  <span>
                    Kill switch state is <strong className="text-red-400">persisted to GCS</strong> — it survives
                    container restarts
                  </span>
                </li>
              </ul>
            </div>

            {/* Error */}
            {killSwitch.error && (
              <p className="text-xs text-red-400 mb-4 p-2 bg-red-950/50 border border-red-800 rounded">
                {killSwitch.error}
              </p>
            )}

            {/* Actions */}
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmKill}
                disabled={killSwitch.loading}
                className="px-4 py-2 text-sm font-semibold bg-red-700 hover:bg-red-600 text-white rounded transition-colors disabled:opacity-50"
              >
                {killSwitch.loading ? "Activating..." : "Yes, kill all agents"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
