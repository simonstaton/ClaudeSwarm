"use client";

import { type FormEvent, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "../auth";

export function Login() {
  const { login } = useAuth();
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = "Login - AgentManager";
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;

    setLoading(true);
    setError("");
    try {
      await login(key.trim());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">AgentManager</h1>
          <p className="text-sm text-zinc-500 mt-1">Enter your access key to continue</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="access-key">Access key</Label>
          <Input
            id="access-key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Access key"
            autoFocus
            className="h-10 w-full"
          />
        </div>

        {error && <Alert variant="destructive">{error}</Alert>}

        <Button
          type="submit"
          disabled={loading || !key.trim()}
          className="w-full h-10 transition-colors duration-[var(--duration-fast)]"
        >
          {loading ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
