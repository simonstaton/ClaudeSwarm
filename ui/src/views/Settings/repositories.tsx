"use client";

import { Alert, Button, PasswordField, TextField } from "@fanvue/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { createApi, Repository } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Skeleton } from "../../components/Skeleton";

const CLONE_OUTPUT_MAX_LINES = 200;

export function RepositoriesPanel({ api }: { api: ReturnType<typeof createApi> }) {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneOutput, setCloneOutput] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [patValues, setPatValues] = useState<Record<string, string>>({});
  const [savingPat, setSavingPat] = useState<string | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const messageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (messageTimeoutRef.current != null) clearTimeout(messageTimeoutRef.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const data = await api.listRepositories();
      setRepos(data.repositories);
      setLoadError(false);
    } catch (err) {
      console.error("[RepositoriesPanel] refresh failed", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-scroll clone output
  // biome-ignore lint/correctness/useExhaustiveDependencies: cloneOutput change triggers the auto-scroll
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [cloneOutput]);

  const showMessage = (msg: string, type: "success" | "error") => {
    setMessage(msg);
    setMessageType(type);
    if (messageTimeoutRef.current != null) clearTimeout(messageTimeoutRef.current);
    messageTimeoutRef.current = setTimeout(() => {
      messageTimeoutRef.current = null;
      setMessage("");
    }, 5000);
  };

  const startClone = async () => {
    const url = newUrl.trim();
    if (!url || cloning) return;

    setCloning(true);
    setCloneOutput([]);
    setMessage("");

    try {
      const res = await api.cloneRepository(url);

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Clone request failed" }));
        showMessage(data.error || "Clone request failed", "error");
        setCloning(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        showMessage("No response stream", "error");
        setCloning(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "clone-progress" && event.text) {
              setCloneOutput((prev) => {
                const next = [...prev, event.text];
                return next.length > CLONE_OUTPUT_MAX_LINES ? next.slice(-CLONE_OUTPUT_MAX_LINES) : next;
              });
            } else if (event.type === "clone-complete") {
              showMessage(`Repository "${event.repo}" cloned successfully`, "success");
              setNewUrl("");
              await refresh();
            } else if (event.type === "clone-error") {
              showMessage(event.error || "Clone failed", "error");
            }
          } catch {
            // skip unparseable
          }
        }
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : "Clone failed", "error");
    } finally {
      setCloning(false);
    }
  };

  const saveRepoPat = async (repoName: string) => {
    const pat = (patValues[repoName] ?? "").trim();
    setSavingPat(repoName);
    try {
      await api.setRepositoryPat(repoName, pat);
      showMessage(pat ? `PAT saved for ${repoName}` : `PAT cleared for ${repoName}`, "success");
      setPatValues((prev) => {
        const next = { ...prev };
        delete next[repoName];
        return next;
      });
      await refresh();
    } catch (err) {
      showMessage(err instanceof Error ? err.message : "Failed to save PAT", "error");
    } finally {
      setSavingPat(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteRepository(pendingDelete);
      showMessage(`Repository "${pendingDelete}" removed`, "success");
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      showMessage(err instanceof Error ? err.message : "Failed to remove repository", "error");
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
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

  if (loadError) {
    return (
      <div className="max-w-2xl space-y-6">
        <Alert variant="error">Failed to load repositories. Check your connection and try again.</Alert>
        <Button
          variant="secondary"
          size="40"
          onClick={() => {
            setLoading(true);
            refresh();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Remove repository"
        description={`Are you sure you want to remove "${pendingDelete}"? This will delete the bare repo from persistent storage. Agents will no longer be able to access it.`}
        confirmLabel={deleting ? "Removing..." : "Remove"}
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      <div>
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-1">Persistent Repositories</p>
        <p className="text-xs text-zinc-400">
          Manage bare git repositories in persistent storage. Cloned repos are available to all agents via worktrees.
        </p>
      </div>

      <div>
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Clone Repository</p>
        <div className="flex gap-2">
          <TextField
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
            onKeyDown={(e) => e.key === "Enter" && startClone()}
            size="40"
            fullWidth
            disabled={cloning}
          />
          <Button
            variant="primary"
            size="40"
            onClick={startClone}
            disabled={!newUrl.trim() || cloning}
            loading={cloning}
          >
            Clone
          </Button>
        </div>
      </div>

      {cloneOutput.length > 0 && (
        <pre
          ref={outputRef}
          className="max-h-40 overflow-y-auto p-3 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 font-mono whitespace-pre-wrap"
        >
          {cloneOutput.join("\n")}
        </pre>
      )}

      {message && <Alert variant={messageType === "error" ? "error" : "success"}>{message}</Alert>}

      <div>
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Repositories ({repos.length})</p>

        {repos.length === 0 ? (
          <div className="px-4 py-8 rounded-lg bg-zinc-900 border border-zinc-800 text-center">
            <p className="text-sm text-zinc-400">No repositories cloned yet</p>
            <p className="text-xs text-zinc-400 mt-1">Clone a repository above to get started</p>
          </div>
        ) : (
          <div className="space-y-3">
            {repos.map((repo) => (
              <div key={repo.name} className="px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-200">{repo.name}</span>
                      {repo.patConfigured && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-900/50 text-emerald-400">
                          PAT set
                        </span>
                      )}
                      {repo.hasActiveAgents && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-900/50 text-amber-400">
                          {repo.activeAgentCount} active agent{repo.activeAgentCount !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    {repo.url && <p className="text-xs text-zinc-400 font-mono truncate mt-0.5">{repo.url}</p>}
                  </div>
                  <Button
                    variant="secondary"
                    size="24"
                    disabled={repo.hasActiveAgents}
                    title={
                      repo.hasActiveAgents
                        ? `Cannot remove - ${repo.activeAgentCount} active agent(s) using this repo. Destroy them first.`
                        : "Remove repository"
                    }
                    onClick={() => setPendingDelete(repo.name)}
                    className="text-zinc-400 hover:text-red-400 shrink-0 ml-3"
                  >
                    Remove
                  </Button>
                </div>
                <div className="flex gap-2 items-center">
                  <PasswordField
                    value={patValues[repo.name] ?? ""}
                    onChange={(e) => setPatValues((prev) => ({ ...prev, [repo.name]: e.target.value }))}
                    placeholder="Git PAT for this repo (optional)"
                    size="40"
                    className="flex-1 max-w-sm"
                  />
                  <Button
                    variant="secondary"
                    size="40"
                    onClick={() => saveRepoPat(repo.name)}
                    loading={savingPat === repo.name}
                  >
                    Save PAT
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
