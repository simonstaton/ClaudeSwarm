"use client";

import Link from "next/link";
import { SettingsLayout } from "../../components/SettingsLayout";
import { ProtectedShell } from "../protected-shell";

export default function SettingsPage() {
  return (
    <ProtectedShell>
      <SettingsLayout>
        <div className="max-w-2xl space-y-6">
          <h2 className="text-lg font-medium text-zinc-200">Settings</h2>
          <p className="text-sm text-zinc-400">Configure shared context, Claude config, guardrails, and API keys.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Link
              href="/settings/context"
              className="block p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors"
            >
              <span className="font-medium text-zinc-200">Shared Context</span>
              <p className="text-xs text-zinc-400 mt-1">Shared .md files accessible to all agents</p>
            </Link>
            <Link
              href="/settings/config"
              className="block p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors"
            >
              <span className="font-medium text-zinc-200">Claude Config</span>
              <p className="text-xs text-zinc-400 mt-1">Edit Claude config, skills, and memory</p>
            </Link>
            <Link
              href="/settings/guardrails"
              className="block p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors"
            >
              <span className="font-medium text-zinc-200">Guardrails</span>
              <p className="text-xs text-zinc-400 mt-1">Spawn limits and resource constraints</p>
            </Link>
            <Link
              href="/settings/apikey"
              className="block p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors"
            >
              <span className="font-medium text-zinc-200">API Key</span>
              <p className="text-xs text-zinc-400 mt-1">Switch between OpenRouter and Anthropic keys</p>
            </Link>
          </div>
        </div>
      </SettingsLayout>
    </ProtectedShell>
  );
}
