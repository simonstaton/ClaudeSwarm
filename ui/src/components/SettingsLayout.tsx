"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAgentPolling } from "../hooks/useAgentPolling";
import { useKillSwitchContext } from "../killSwitch";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";

const SETTINGS_LINKS = [
  { href: "/settings/context", label: "Shared Context" },
  { href: "/settings/config", label: "Claude Config" },
  { href: "/settings/guardrails", label: "Guardrails" },
  { href: "/settings/apikey", label: "API Key" },
] as const;

export function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { agents } = useAgentPolling();
  const killSwitch = useKillSwitchContext();

  return (
    <div className="h-screen flex flex-col">
      <Header agentCount={agents.length} killSwitch={killSwitch} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar agents={agents} activeId={null} />
        <div className="flex-1 flex flex-col overflow-hidden">
          <nav aria-label="Settings sections" className="flex-shrink-0 px-6 py-2 border-b border-zinc-800 flex gap-1">
            {SETTINGS_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                aria-current={pathname === href ? "page" : undefined}
                className={`px-3 py-1.5 text-sm rounded transition-colors ${
                  pathname === href
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>
          <main className="flex-1 overflow-y-auto p-6" id="main-content">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
