import { useState } from "react";
import type { KillSwitchState } from "../hooks/useKillSwitch";

interface KillSwitchBannerProps {
  state: KillSwitchState;
  loading: boolean;
  onDeactivate: () => void;
}

/** Full-width warning banner shown when the kill switch is active. */
export function KillSwitchBanner({ state, loading, onDeactivate }: KillSwitchBannerProps) {
  const [confirming, setConfirming] = useState(false);

  if (!state.killed) return null;

  const activatedAt = state.activatedAt
    ? new Date(state.activatedAt).toLocaleString()
    : "unknown time";

  return (
    <div className="bg-red-900 border-b border-red-700 text-red-100 px-6 py-3 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-red-400 text-lg flex-shrink-0" aria-hidden>&#9888;</span>
        <div className="min-w-0">
          <span className="font-semibold text-red-100">KILL SWITCH ACTIVE</span>
          {state.reason && (
            <span className="text-red-300 text-sm ml-2 truncate">— {state.reason}</span>
          )}
          <span className="text-red-400 text-xs ml-2 hidden sm:inline">Activated {activatedAt}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {confirming ? (
          <>
            <span className="text-red-200 text-sm">Deactivate and re-enable agents?</span>
            <button
              type="button"
              onClick={() => { setConfirming(false); onDeactivate(); }}
              disabled={loading}
              className="px-3 py-1 text-sm font-medium bg-red-700 hover:bg-red-600 text-white rounded transition-colors disabled:opacity-50"
            >
              {loading ? "Deactivating..." : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={loading}
              className="px-3 py-1 text-sm bg-transparent border border-red-600 hover:border-red-400 text-red-200 hover:text-red-100 rounded transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="px-3 py-1 text-sm bg-transparent border border-red-600 hover:border-red-400 text-red-200 hover:text-red-100 rounded transition-colors"
          >
            Deactivate
          </button>
        )}
      </div>
    </div>
  );
}
