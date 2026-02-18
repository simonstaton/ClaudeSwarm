import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import type { KillSwitchState } from "../hooks/useKillSwitch";

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
  const navigate = useNavigate();
  const location = useLocation();
  const [confirming, setConfirming] = useState(false);

  const handlePanicClick = () => {
    if (killSwitch.state.killed) return;
    setConfirming(true);
  };

  const handleConfirmKill = async () => {
    setConfirming(false);
    await killSwitch.activate("Manual activation via UI panic button");
  };

  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm relative">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate("/")}
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
        {/* Panic button — always visible, deliberately styled to stand out */}
        {!killSwitch.state.killed && (
          <button
            type="button"
            onClick={handlePanicClick}
            disabled={killSwitch.loading}
            title="Emergency kill switch — stops all agents immediately"
            className="px-3 py-1.5 text-sm font-medium bg-red-900/60 hover:bg-red-800 border border-red-700 hover:border-red-500 text-red-300 hover:text-red-100 rounded transition-colors disabled:opacity-50"
          >
            Kill Switch
          </button>
        )}

        <button
          type="button"
          onClick={() => navigate("/settings")}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            location.pathname === "/settings"
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
          }`}
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
      </div>

      {/* Confirmation dialog overlay */}
      {confirming && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-900/95 rounded">
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            <p className="text-sm font-semibold text-red-400">
              Activate kill switch?
            </p>
            <p className="text-xs text-zinc-400 max-w-xs">
              This will immediately SIGKILL all agents, invalidate all tokens, and block new agent operations.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleConfirmKill}
                className="px-4 py-1.5 text-sm font-semibold bg-red-700 hover:bg-red-600 text-white rounded transition-colors"
              >
                Yes, kill all agents
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="px-4 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors"
              >
                Cancel
              </button>
            </div>
            {killSwitch.error && (
              <p className="text-xs text-red-400">{killSwitch.error}</p>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
