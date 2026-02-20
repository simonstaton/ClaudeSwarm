"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "./useApi";
import { usePageVisible } from "./usePageVisible";

interface CostSummary {
  totalCost: number;
  totalTokens: number;
  agentCount: number;
  allTime: {
    totalCost: number;
    totalTokensIn: number;
    totalTokensOut: number;
  };
  spendLimit: number | null;
  spendLimitExceeded: boolean;
}

export function useCostPolling(intervalMs = 5000) {
  const api = useApi();
  const [cost, setCost] = useState<CostSummary | null>(null);
  const visible = usePageVisible();
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    const fetch = async () => {
      try {
        const data = await apiRef.current.fetchCostSummary();
        if (!cancelled) setCost(data);
      } catch {
        // silently ignore — sidebar cost is non-critical
      }
    };

    fetch();
    const id = setInterval(fetch, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [visible, intervalMs]);

  return cost;
}
