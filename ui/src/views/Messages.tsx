"use client";

import { useEffect } from "react";
import { Header } from "../components/Header";
import { MessageFeed } from "../components/MessageFeed";
import { Sidebar } from "../components/Sidebar";
import { useAgentPolling } from "../hooks/useAgentPolling";
import { useApi } from "../hooks/useApi";
import { useKillSwitchContext } from "../killSwitch";

export function Messages() {
  const api = useApi();
  const { agents } = useAgentPolling();
  const killSwitch = useKillSwitchContext();

  useEffect(() => {
    document.title = "Messages \u2014 ClaudeSwarm";
  }, []);

  return (
    <div className="h-screen flex flex-col">
      <Header agentCount={agents.length} killSwitch={killSwitch} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar agents={agents} activeId={null} />
        <main id="main-content" className="flex-1 overflow-hidden flex flex-col p-6">
          <MessageFeed api={api} agents={agents} />
        </main>
      </div>
    </div>
  );
}
