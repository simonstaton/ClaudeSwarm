"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AgentView } from "../../../views/AgentView";
import { ProtectedShell } from "../../protected-shell";

/**
 * Reads the real agent ID from the URL after mount and on navigation.
 * useParams() cannot be used here because the static export pre-renders with
 * the placeholder id "_" from generateStaticParams, causing a hydration
 * mismatch (React #418) and a bogus GET /api/agents/_ 404.
 */
export function AgentPageClient() {
  const pathname = usePathname();
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    const segments = pathname.split("/").filter(Boolean);
    if (segments[0] === "agents" && segments[1]) {
      setId(segments[1]);
    }
  }, [pathname]);

  if (!id) return null;

  return (
    <ProtectedShell>
      <AgentView agentId={id} />
    </ProtectedShell>
  );
}
