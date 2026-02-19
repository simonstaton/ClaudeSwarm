"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth";
import { KillSwitchProvider } from "../killSwitch";

function RecoveryOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/90 backdrop-blur-sm">
      <div className="text-center max-w-sm px-6">
        <div className="mb-4 flex justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-zinc-600 border-t-zinc-200 animate-spin" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-100 mb-2">Starting up</h2>
        <p className="text-sm text-zinc-400">Restoring agents from previous session. This may take a moment.</p>
      </div>
    </div>
  );
}

export function ProtectedShell({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const router = useRouter();
  const [serverRecovering, setServerRecovering] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) return;
      const data = await res.json();
      const isRecovering = data.status === "recovering";
      setServerRecovering(isRecovering);
      if (!isRecovering && pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    } catch {
      // Server not reachable yet
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    checkHealth();
    pollingRef.current = setInterval(checkHealth, 2000);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [token, checkHealth]);

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  if (!token) return null;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-zinc-800 focus:text-white focus:px-4 focus:py-2 focus:rounded"
      >
        Skip to main content
      </a>
      <KillSwitchProvider>
        {serverRecovering && <RecoveryOverlay />}
        <div className="flex-1 overflow-hidden">{children}</div>
      </KillSwitchProvider>
    </div>
  );
}
