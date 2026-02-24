"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Agent } from "../api";
import { STATUS_BADGE_VARIANT } from "../constants";
import { useApi } from "../hooks/useApi";
import { useCostPolling } from "../hooks/useCostPolling";
import { useToast } from "./Toast";

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

interface SidebarProps {
  agents: Agent[];
  activeId: string | null;
}

export function Sidebar({ agents, activeId }: SidebarProps) {
  const cost = useCostPolling();
  const api = useApi();
  const { toast } = useToast();
  const [limitInput, setLimitInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const tooltipTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup tooltip timeout on unmount
  useEffect(() => {
    return () => {
      if (tooltipTimeout.current) clearTimeout(tooltipTimeout.current);
    };
  }, []);

  // Sync local input with server value once it loads
  const limitSynced = useRef(false);
  if (cost && !limitSynced.current) {
    limitSynced.current = true;
    setLimitInput(cost.spendLimit != null ? String(cost.spendLimit) : "");
  }

  const handleLimitSave = async () => {
    const val = limitInput.trim();
    const parsed = val === "" ? null : Number.parseFloat(val);
    if (val !== "" && (Number.isNaN(parsed) || (parsed as number) <= 0)) return;
    setSaving(true);
    try {
      await api.setSpendLimit(parsed as number | null);
    } catch (err) {
      toast(`Failed to save spend limit: ${String(err)}`, "error");
      // Revert to server value on error
      setLimitInput(cost?.spendLimit != null ? String(cost.spendLimit) : "");
    } finally {
      setSaving(false);
    }
  };

  const handleTooltipEnter = () => {
    if (tooltipTimeout.current) clearTimeout(tooltipTimeout.current);
    setShowTooltip(true);
  };

  const handleTooltipLeave = () => {
    tooltipTimeout.current = setTimeout(() => setShowTooltip(false), 100);
  };

  const limitExceeded = cost?.spendLimitExceeded ?? false;
  const currentLimit = cost?.spendLimit ?? null;
  const allTimeCost = cost?.allTime.totalCost ?? 0;

  const nearLimit = !limitExceeded && currentLimit !== null && allTimeCost > 0 && allTimeCost >= currentLimit * 0.9;

  return (
    <aside
      className="w-56 flex-shrink-0 border-r border-zinc-800 bg-zinc-900/30 flex flex-col"
      aria-label="Agent navigation"
    >
      <div className="p-3 flex-1 overflow-y-auto">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 px-2">Agents</p>
        {agents.length === 0 && <p className="text-xs text-zinc-400 px-2">No active agents</p>}
        <nav aria-label="Agent list" className="space-y-0.5">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}/`}
              aria-current={activeId === agent.id ? "page" : undefined}
              className={`w-full flex items-start gap-2 px-3 py-2.5 rounded text-sm text-left transition-colors ${
                activeId === agent.id
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <span
                className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                  STATUS_BADGE_VARIANT[agent.status] === "success"
                    ? "bg-emerald-500"
                    : STATUS_BADGE_VARIANT[agent.status] === "destructive"
                      ? "bg-red-500"
                      : STATUS_BADGE_VARIANT[agent.status] === "warning"
                        ? "bg-amber-500"
                        : STATUS_BADGE_VARIANT[agent.status] === "info"
                          ? "bg-blue-500"
                          : "bg-zinc-500"
                }`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <span className="truncate block">{agent.name}</span>
                {agent.gitBranch && (
                  <span className="text-[10px] font-mono text-zinc-600 truncate block">
                    <span className="text-emerald-400/60">{agent.gitBranch}</span>
                    {agent.gitWorktree && <span className="text-zinc-700"> wt</span>}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </nav>
      </div>

      {cost && (
        <div className="border-t border-zinc-800 px-4 py-3 space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Session</span>
            <span className="text-sm font-mono font-semibold text-zinc-100">{formatCost(cost.totalCost)}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">All time</span>
            <span
              className={`text-sm font-mono font-semibold ${
                limitExceeded ? "text-red-400" : nearLimit ? "text-amber-400" : "text-zinc-400"
              }`}
            >
              {formatCost(cost.allTime.totalCost)}
            </span>
          </div>
          <div className="text-[10px] text-zinc-600 font-mono">{formatTokens(cost.totalTokens)} tokens</div>

          {/* Spend limit */}
          <div className="pt-1.5 border-t border-zinc-800/60">
            <div className="flex items-center gap-1 mb-1.5">
              <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Spend limit</span>

              {/* Tooltip info icon */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: tooltip wrapper delegates to inner button */}
              <div
                className="relative"
                onMouseEnter={handleTooltipEnter}
                onMouseLeave={handleTooltipLeave}
                role="presentation"
              >
                <button
                  type="button"
                  aria-label="About spend limit"
                  className="w-3.5 h-3.5 rounded-full border border-zinc-600 text-zinc-500 hover:text-zinc-300 hover:border-zinc-400 flex items-center justify-center transition-colors focus:outline-none focus:ring-1 focus:ring-zinc-500"
                  style={{ fontSize: "8px", lineHeight: 1 }}
                >
                  ?
                </button>
                {showTooltip && (
                  <div
                    className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-44 rounded bg-zinc-800 border border-zinc-700 px-2.5 py-2 text-[10px] text-zinc-300 leading-relaxed shadow-lg z-50 pointer-events-none"
                    role="tooltip"
                  >
                    Set a maximum all-time spend in USD. When reached, all running agents are automatically stopped as a
                    safety barrier.
                  </div>
                )}
              </div>

              {limitExceeded && (
                <span className="ml-auto text-[9px] font-semibold text-red-400 uppercase tracking-wide">Hit!</span>
              )}
              {nearLimit && !limitExceeded && (
                <span className="ml-auto text-[9px] font-semibold text-amber-400 uppercase tracking-wide">Near</span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-500 font-mono">$</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="No limit"
                value={limitInput}
                onChange={(e) => setLimitInput(e.target.value)}
                onBlur={handleLimitSave}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                disabled={saving}
                aria-label="Spend limit in USD"
                className={`flex-1 min-w-0 bg-zinc-800/60 border rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 transition-colors disabled:opacity-50 ${
                  limitExceeded
                    ? "border-red-500/60 focus:ring-red-500/40"
                    : nearLimit
                      ? "border-amber-500/60 focus:ring-amber-500/40"
                      : "border-zinc-700 focus:ring-zinc-500"
                }`}
              />
            </div>

            {limitExceeded && (
              <p className="mt-1 text-[9px] text-red-400 leading-tight">Limit reached - all agents stopped.</p>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
