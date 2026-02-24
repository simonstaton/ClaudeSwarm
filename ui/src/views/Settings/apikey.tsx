"use client";

import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { createApi } from "../../api";
import { Skeleton } from "../../components/Skeleton";

export function ApiKeyPanel({ api }: { api: ReturnType<typeof createApi> }) {
  const [hint, setHint] = useState("");
  const [mode, setMode] = useState<"openrouter" | "anthropic">("openrouter");
  const [newKey, setNewKey] = useState("");
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
        setHint(s.anthropicKeyHint);
        setMode(s.keyMode);
      })
      .catch((err) => {
        console.error("[ApiKeyPanel] getSettings failed", err);
      });
  }, [api]);

  const switchKey = async () => {
    const key = newKey.trim();
    if (!key) return;
    try {
      const data = await api.setAnthropicKey(key);
      setHint(data.hint);
      setMode(data.keyMode);
      setNewKey("");
      const label = data.keyMode === "openrouter" ? "OpenRouter" : "Anthropic";
      setMessage(`Switched to ${label}. New agents will use this key.`);
      if (messageTimeoutRef.current != null) clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = setTimeout(() => {
        messageTimeoutRef.current = null;
        setMessage("");
      }, 4000);
    } catch (err) {
      console.error("[ApiKeyPanel] switchKey failed", err);
      setMessage("Invalid key format (expected sk-or-... or sk-ant-...)");
    }
  };

  const modeLabel = mode === "openrouter" ? "OpenRouter" : "Anthropic";

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
          Current API Key
          <span
            className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold ${mode === "openrouter" ? "bg-emerald-900/50 text-emerald-400" : "bg-orange-900/50 text-orange-400"}`}
          >
            {modeLabel}
          </span>
        </p>
        <div className="px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800 font-mono text-sm text-zinc-300">
          {hint || <Skeleton className="h-4 w-48" />}
        </div>
      </div>

      <div>
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Switch API Key</p>
        <div className="flex gap-2">
          <div className="flex-1 min-w-0 space-y-1.5">
            <Label htmlFor="api-key-new" className="sr-only">
              New API key
            </Label>
            <Input
              id="api-key-new"
              type="password"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="sk-or-v1-... or sk-ant-..."
              className="h-10 w-full"
            />
          </div>
          <Button variant="default" size="default" onClick={switchKey} disabled={!newKey.trim()}>
            Switch
          </Button>
        </div>
        {message && (
          <Alert variant={message.includes("Invalid") ? "destructive" : "default"} className="mt-2">
            {message}
          </Alert>
        )}
      </div>
    </div>
  );
}
