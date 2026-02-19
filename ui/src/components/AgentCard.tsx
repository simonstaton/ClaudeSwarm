"use client";

import { Badge } from "@fanvue/ui";
import type { Agent } from "../api";
import { STATUS_BADGE_VARIANT, STATUS_LABELS, timeAgo } from "../constants";

interface AgentCardProps {
  agent: Agent;
  onClick: () => void;
  parentName?: string;
}

export function AgentCard({ agent, onClick, parentName }: AgentCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/50 hover:border-zinc-700 transition-all group"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-sm text-zinc-200 group-hover:text-zinc-100 truncate">{agent.name}</h3>
          {agent.role && <span className="text-[11px] text-zinc-400">{agent.role}</span>}
        </div>
        <Badge variant={STATUS_BADGE_VARIANT[agent.status] || "default"} leftDot className="flex-shrink-0 ml-2">
          {STATUS_LABELS[agent.status] || agent.status}
        </Badge>
      </div>

      {agent.currentTask && <p className="text-xs text-zinc-400 mb-2 truncate">{agent.currentTask}</p>}

      <div className="flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
        <span>{agent.model.replace("claude-", "").split("-202")[0]}</span>
        <span>·</span>
        <span>{timeAgo(agent.lastActivity)}</span>
        {parentName && (
          <>
            <span>·</span>
            <span className="text-zinc-400">child of {parentName}</span>
          </>
        )}
      </div>
    </button>
  );
}
