"use client";

import { type AgentTemplate, agentTemplates } from "../agentTemplates";

interface AgentTemplatesProps {
  onSelect: (template: AgentTemplate) => void;
}

const modelLabels: Record<string, string> = {
  "claude-opus-4-6": "Opus",
  "claude-sonnet-4-5-20250929": "Sonnet",
};

export function AgentTemplates({ onSelect }: AgentTemplatesProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
      {agentTemplates.map((template) => (
        <button
          type="button"
          key={template.id}
          onClick={() => onSelect(template)}
          className="group text-left p-3 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-600 hover:bg-zinc-800/50 transition-all"
        >
          <div className="flex items-start gap-2 mb-1.5">
            <span className="text-lg leading-none">{template.icon}</span>
            <span className="text-sm font-medium text-zinc-200 group-hover:text-zinc-100 leading-tight">
              {template.label}
            </span>
          </div>
          <p className="text-[11px] text-zinc-400 group-hover:text-zinc-300 leading-snug mb-2">
            {template.description}
          </p>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/50">
              {modelLabels[template.model] || template.model}
            </span>
            {template.maxTurns < 200 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                {template.maxTurns} turns
              </span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
