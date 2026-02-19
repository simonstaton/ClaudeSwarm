"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "../api";
import { useApi } from "./useApi";
import { usePageVisible } from "./usePageVisible";

export function useAgentPolling() {
  const api = useApi();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const visible = usePageVisible();
  const hasFetchedRef = useRef(false);
  const apiRef = useRef(api);
  apiRef.current = api;

  const refreshAgents = useCallback(async () => {
    if (!hasFetchedRef.current) setLoading(true);
    try {
      const list = await apiRef.current.fetchAgents();
      setAgents(list);
    } catch (err) {
      console.error("[useAgentPolling] fetch failed", err);
    } finally {
      hasFetchedRef.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;

    refreshAgents();
    const interval = setInterval(refreshAgents, 5000);
    return () => clearInterval(interval);
  }, [refreshAgents, visible]);

  return { agents, loading, refreshAgents };
}
