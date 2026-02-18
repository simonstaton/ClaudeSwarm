import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "./useApi";

export interface KillSwitchState {
  killed: boolean;
  reason?: string;
  activatedAt?: string;
}

/** Poll the kill switch status every 5s and expose activate/deactivate actions. */
export function useKillSwitch() {
  const api = useApi();
  const [state, setState] = useState<KillSwitchState>({ killed: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const s = await api.getKillSwitchState();
      setState(s);
    } catch {
      // Swallow — if server is unreachable we don't want to spam errors
    }
  }, [api]);

  useEffect(() => {
    fetchState();
    pollRef.current = setInterval(fetchState, 5_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchState]);

  const activate = useCallback(
    async (reason?: string) => {
      setLoading(true);
      setError(null);
      try {
        await api.activateKillSwitch(reason);
        await fetchState();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to activate kill switch");
      } finally {
        setLoading(false);
      }
    },
    [api, fetchState],
  );

  const deactivate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await api.deactivateKillSwitch();
      await fetchState();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to deactivate kill switch");
    } finally {
      setLoading(false);
    }
  }, [api, fetchState]);

  return { state, loading, error, activate, deactivate };
}
