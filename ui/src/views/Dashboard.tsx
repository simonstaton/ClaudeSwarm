"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentTemplate } from "../agentTemplates";
import { AgentCard } from "../components/AgentCard";
import { AgentTemplates } from "../components/AgentTemplates";
import { Header } from "../components/Header";
import { type Attachment, PromptInput, type PromptInputDefaultValues } from "../components/PromptInput";
import { Sidebar } from "../components/Sidebar";
import { AgentCardSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { useAgentPolling } from "../hooks/useAgentPolling";
import { useApi } from "../hooks/useApi";
import { useKillSwitchContext } from "../killSwitch";

export function Dashboard() {
  const router = useRouter();
  const api = useApi();
  const { agents, loading, refreshAgents } = useAgentPolling();
  const [creating, setCreating] = useState(false);
  const killSwitch = useKillSwitchContext();
  const { toast } = useToast();
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);

  useEffect(() => {
    document.title = "Dashboard - AgentManager";
  }, []);

  const handleTemplateSelect = useCallback((template: AgentTemplate) => {
    setSelectedTemplate(template);
  }, []);

  const promptDefaults: PromptInputDefaultValues | undefined = selectedTemplate
    ? {
        prompt: selectedTemplate.prompt,
        name: selectedTemplate.name,
        model: selectedTemplate.model,
        maxTurns: selectedTemplate.maxTurns,
        dangerouslySkipPermissions: selectedTemplate.dangerouslySkipPermissions,
      }
    : undefined;

  const handleCreate = useCallback(
    async (opts: {
      prompt: string;
      name?: string;
      model?: string;
      maxTurns?: number;
      dangerouslySkipPermissions?: boolean;
      attachments?: Attachment[];
    }) => {
      setCreating(true);
      try {
        const { stream } = api.createAgentStream(opts);
        const reader = (await stream).getReader();

        // Read first event to confirm agent started, then navigate
        await reader.read();
        reader.cancel();

        // Refresh to get the new agent
        await refreshAgents();
        const updated = await api.fetchAgents();
        if (updated.length > 0) {
          // Navigate to the most recently created agent
          const newest = updated.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
          router.push(`/agents/${newest.id}/`);
        }
      } catch (err: unknown) {
        toast(err instanceof Error ? err.message : "Failed to create agent", "error");
      } finally {
        setCreating(false);
      }
    },
    [refreshAgents, api, toast, router],
  );

  const createModeConfig = useMemo(
    () => ({
      onCreateSubmit: handleCreate,
    }),
    [handleCreate],
  );

  return (
    <div className="h-screen flex flex-col">
      <Header agentCount={agents.length} killSwitch={killSwitch} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar agents={agents} activeId={null} />
        <div className="flex-1 flex flex-col overflow-hidden">
          <main id="main-content" className="flex-1 overflow-y-auto p-6">
            <h2 className="text-lg font-medium mb-6">Agents</h2>

            {loading && agents.length === 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {[1, 2, 3].map((i) => (
                  <AgentCardSkeleton key={i} />
                ))}
              </div>
            ) : agents.length === 0 ? (
              <div className="py-8">
                <p className="text-zinc-500 text-sm mb-4">No agents running. Pick a template or type a prompt below.</p>
                <AgentTemplates onSelect={handleTemplateSelect} />
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
                  {agents.map((agent) => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      onClick={() => router.push(`/agents/${agent.id}/`)}
                      parentName={agent.parentId ? agents.find((a) => a.id === agent.parentId)?.name : undefined}
                    />
                  ))}
                </div>
                <details className="group">
                  <summary className="text-xs text-zinc-400 cursor-pointer hover:text-zinc-400 transition-colors select-none mb-3">
                    Templates
                  </summary>
                  <AgentTemplates onSelect={handleTemplateSelect} />
                </details>
              </>
            )}
          </main>

          {/* Inline agent creation input - matches conversation page input */}
          <PromptInput
            onSubmit={() => {}}
            disabled={creating}
            placeholder={creating ? "Creating agent..." : "What should this agent do?"}
            createMode={createModeConfig}
            defaultValues={promptDefaults}
            onDefaultsApplied={() => setSelectedTemplate(null)}
          />
        </div>
      </div>
    </div>
  );
}
