"use client";

import { Alert, Button, PasswordField } from "@fanvue/ui";
import { useEffect, useRef, useState } from "react";
import type { createApi } from "../../api";

const INTEGRATIONS = [
  {
    key: "githubToken" as const,
    name: "github",
    label: "GitHub PAT",
    description: "For cloning private repos and gh CLI (optional)",
  },
  { key: "notionApiKey" as const, name: "notion", label: "Notion API Key", description: "For Notion MCP (optional)" },
  { key: "slackToken" as const, name: "slack", label: "Slack Token", description: "For Slack MCP (optional)" },
  { key: "figmaToken" as const, name: "figma", label: "Figma Token", description: "For Figma MCP (optional)" },
  { key: "linearApiKey" as const, name: "linear", label: "Linear API Key", description: "For Linear MCP (optional)" },
] as const;

export function IntegrationsPanel({ api }: { api: ReturnType<typeof createApi> }) {
  const [configured, setConfigured] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const messageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (messageTimeoutRef.current != null) clearTimeout(messageTimeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        const next: Record<string, boolean> = {};
        if (s.integrations) {
          for (const [name, data] of Object.entries(s.integrations)) {
            next[name] = data.configured;
          }
        }
        setConfigured(next);
      })
      .catch((err) => {
        console.error("[IntegrationsPanel] getSettings failed", err);
      });
  }, [api]);

  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      const body: Record<string, string> = {};
      for (const { key } of INTEGRATIONS) {
        body[key] = values[key] ?? "";
      }
      const data = await api.setIntegrations(body);
      const next: Record<string, boolean> = {};
      for (const [name, val] of Object.entries(data.integrations)) {
        next[name] = val.configured;
      }
      setConfigured(next);
      setValues({});
      setMessage("Integration tokens saved. Only set what you use.");
      if (messageTimeoutRef.current != null) clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = setTimeout(() => {
        messageTimeoutRef.current = null;
        setMessage("");
      }, 4000);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const hasAnyValue = INTEGRATIONS.some(({ key }) => (values[key] ?? "").trim().length > 0);

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-1">Integrations</p>
        <p className="text-sm text-zinc-400">
          Set API keys or tokens only for integrations you use. Stored securely on the server. Leave blank to leave
          unchanged or to clear.
        </p>
      </div>

      <div className="space-y-4">
        {INTEGRATIONS.map(({ key, name, label, description }) => (
          <div key={key} className="rounded-lg bg-zinc-900 border border-zinc-800 p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium text-zinc-200">{label}</span>
              {configured[name] && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-900/50 text-emerald-400">
                  Configured
                </span>
              )}
            </div>
            {description && <p className="text-xs text-zinc-400 mb-2">{description}</p>}
            <PasswordField
              value={values[key] ?? ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
              placeholder="Leave blank to keep current or clear"
              size="40"
              fullWidth
            />
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <Button variant="primary" size="40" onClick={save} disabled={saving || !hasAnyValue} loading={saving}>
          Save
        </Button>
      </div>

      {message && <Alert variant={message.startsWith("Failed") ? "error" : "success"}>{message}</Alert>}
    </div>
  );
}
