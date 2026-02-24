"use client";

import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { createApi } from "../../api";
import { Skeleton } from "../../components/Skeleton";
import { GuardrailField } from "./GuardrailField";

export function GuardrailsPanel({ api }: { api: ReturnType<typeof createApi> }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const messageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [values, setValues] = useState({
    maxPromptLength: 100000,
    maxTurns: 500,
    maxAgents: 20,
    maxBatchSize: 10,
    maxAgentDepth: 3,
    maxChildrenPerAgent: 6,
    sessionTtlMs: 4 * 60 * 60 * 1000,
  });

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
        setValues(s.guardrails);
        setLoading(false);
      })
      .catch((err) => {
        console.error("[GuardrailsPanel] getSettings failed", err);
        setLoading(false);
      });
  }, [api]);

  const saveSettings = async () => {
    setSaving(true);
    setMessage("");
    try {
      const result = await api.updateGuardrails(values);
      setValues(result.guardrails);
      setMessage("Guardrails updated successfully");
      if (messageTimeoutRef.current != null) clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = setTimeout(() => {
        messageTimeoutRef.current = null;
        setMessage("");
      }, 3000);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Failed to update guardrails";
      setMessage(errMsg);
    } finally {
      setSaving(false);
    }
  };

  const updateValue = (key: keyof typeof values, value: number) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="max-w-2xl space-y-6">
        <Skeleton className="h-4 w-64 mb-4" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <p className="text-xs text-zinc-400 mb-4">
          Configure spawn limits and resource constraints for agent creation and operations. Changes take effect
          immediately for new operations.
        </p>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-3">
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Spawn Limits</p>

            <GuardrailField
              label="Max Batch Size"
              labelHint="agents spawned at once"
              value={values.maxBatchSize}
              onChange={(v) => updateValue("maxBatchSize", v)}
              hint="Range: 1-50 (default: 10)"
            />
            <GuardrailField
              label="Max Total Agents"
              labelHint="concurrent limit"
              value={values.maxAgents}
              onChange={(v) => updateValue("maxAgents", v)}
              hint="Range: 1-100 (default: 20)"
            />
            <GuardrailField
              label="Max Agent Depth"
              labelHint="spawning hierarchy"
              value={values.maxAgentDepth}
              onChange={(v) => updateValue("maxAgentDepth", v)}
              hint="Range: 1-10 (default: 3)"
            />
            <GuardrailField
              label="Max Children Per Agent"
              labelHint="sub-agents"
              value={values.maxChildrenPerAgent}
              onChange={(v) => updateValue("maxChildrenPerAgent", v)}
              hint="Range: 1-20 (default: 6)"
            />
          </div>

          <div className="space-y-3">
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Session Limits</p>

            <GuardrailField
              label="Max Prompt Length"
              labelHint="characters"
              value={values.maxPromptLength}
              onChange={(v) => updateValue("maxPromptLength", v)}
              hint="Range: 1,000-1,000,000 (default: 100,000)"
            />
            <GuardrailField
              label="Max Turns"
              labelHint="conversation rounds"
              value={values.maxTurns}
              onChange={(v) => updateValue("maxTurns", v)}
              hint="Range: 1-10,000 (default: 500)"
            />
            <GuardrailField
              label="Session TTL"
              labelHint="milliseconds"
              value={values.sessionTtlMs}
              onChange={(v) => updateValue("sessionTtlMs", v)}
              hint="Range: 60,000-86,400,000 (1min-24hr, default: 4hr)"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 pt-4">
          <Button variant="default" size="default" onClick={saveSettings} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
          {message && (
            <Alert variant={message.includes("Failed") || message.includes("must") ? "destructive" : "default"}>
              {message}
            </Alert>
          )}
        </div>
      </div>
    </div>
  );
}
