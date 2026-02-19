"use client";

import { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { Sidebar } from "../components/Sidebar";
import { useAgentPolling } from "../hooks/useAgentPolling";
import { useApi } from "../hooks/useApi";
import { useKillSwitchContext } from "../killSwitch";

interface AgentCost {
  agentId: string;
  agentName: string;
  tokensUsed: number;
  estimatedCost: number;
  createdAt: string;
  status: string;
}

interface CostStats {
  totalTokens: number;
  totalCost: number;
  agentCount: number;
  agents: AgentCost[];
}

export function CostDashboard() {
  const api = useApi();
  const { agents } = useAgentPolling();
  const killSwitch = useKillSwitchContext();
  const [stats, setStats] = useState<CostStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCostData = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await api.fetchCostSummary();
        setStats(data);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to fetch cost data";
        setError(message);
        console.error("Cost dashboard error:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchCostData();
    const interval = setInterval(fetchCostData, 10000); // Refresh every 10 seconds
    return () => clearInterval(interval);
  }, [api]);

  const formatCost = (cost: number): string => {
    return `$${cost.toFixed(4)}`;
  };

  const formatTokens = (tokens: number): string => {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(2)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(2)}K`;
    return tokens.toString();
  };

  return (
    <div className="h-screen flex flex-col">
      <Header agentCount={agents.length} killSwitch={killSwitch} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar agents={agents} activeId={null} onSelect={() => {}} />
        <div className="flex-1 flex flex-col overflow-hidden">
          <main className="flex-1 overflow-y-auto p-6">
            <h2 className="text-lg font-medium mb-6">Cost & Usage Dashboard</h2>

            {error && (
              <div className="mb-6 p-4 bg-red-950/30 border border-red-800 text-red-300 text-sm rounded-lg">
                {error}
              </div>
            )}

            {loading && !stats ? (
              <div className="space-y-4">
                <div className="h-32 rounded-lg bg-zinc-800/50 animate-pulse" />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-24 rounded-lg bg-zinc-800/50 animate-pulse" />
                  ))}
                </div>
              </div>
            ) : stats ? (
              <>
                {/* Summary Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                  <div className="bg-zinc-800/30 border border-zinc-700 rounded-lg p-6">
                    <p className="text-xs font-medium text-zinc-500 uppercase mb-2">Total Cost</p>
                    <p className="text-3xl font-semibold text-zinc-100">{formatCost(stats.totalCost)}</p>
                    <p className="text-xs text-zinc-500 mt-2">Estimated cost</p>
                  </div>

                  <div className="bg-zinc-800/30 border border-zinc-700 rounded-lg p-6">
                    <p className="text-xs font-medium text-zinc-500 uppercase mb-2">Total Tokens</p>
                    <p className="text-3xl font-semibold text-zinc-100">{formatTokens(stats.totalTokens)}</p>
                    <p className="text-xs text-zinc-500 mt-2">Tokens consumed</p>
                  </div>

                  <div className="bg-zinc-800/30 border border-zinc-700 rounded-lg p-6">
                    <p className="text-xs font-medium text-zinc-500 uppercase mb-2">Active Agents</p>
                    <p className="text-3xl font-semibold text-zinc-100">{stats.agentCount}</p>
                    <p className="text-xs text-zinc-500 mt-2">Running agents</p>
                  </div>
                </div>

                {/* Agents Table */}
                <div className="bg-zinc-800/20 border border-zinc-700 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-900/50 border-b border-zinc-700">
                        <tr>
                          <th className="px-4 py-3 text-left font-medium text-zinc-300">Agent Name</th>
                          <th className="px-4 py-3 text-left font-medium text-zinc-300">Status</th>
                          <th className="px-4 py-3 text-right font-medium text-zinc-300">Tokens</th>
                          <th className="px-4 py-3 text-right font-medium text-zinc-300">Est. Cost</th>
                          <th className="px-4 py-3 text-left font-medium text-zinc-300">Created</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-700">
                        {stats.agents.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                              No agents found
                            </td>
                          </tr>
                        ) : (
                          stats.agents.map((agent) => (
                            <tr key={agent.agentId} className="hover:bg-zinc-800/30 transition-colors">
                              <td className="px-4 py-3 text-zinc-100 font-medium">{agent.agentName}</td>
                              <td className="px-4 py-3">
                                <span className="inline-block px-2 py-1 text-xs font-medium rounded bg-zinc-700/50 text-zinc-300">
                                  {agent.status}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right text-zinc-400">{formatTokens(agent.tokensUsed)}</td>
                              <td className="px-4 py-3 text-right text-zinc-400">{formatCost(agent.estimatedCost)}</td>
                              <td className="px-4 py-3 text-zinc-400 text-xs">
                                {new Date(agent.createdAt).toLocaleDateString()}{" "}
                                {new Date(agent.createdAt).toLocaleTimeString()}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : null}
          </main>
        </div>
      </div>
    </div>
  );
}
