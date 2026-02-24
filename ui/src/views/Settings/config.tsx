"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ClaudeConfigFile, createApi } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { TreeListSkeleton } from "../../components/Skeleton";
import { useFileEditor, useFolderToggle } from "./hooks";
import { buildTree, TreeList } from "./tree";

const CATEGORY_LABELS: Record<string, { label: string; description: string }> = {
  core: { label: "Core Config", description: "Main Claude configuration files" },
  skills: { label: "Skills / Commands", description: "Custom slash commands shared across agents" },
  memory: { label: "Memory", description: "Auto-generated memory files per project" },
  mcp: { label: "MCP Servers", description: "Model Context Protocol server definitions" },
};

const CATEGORY_ORDER = ["core", "skills", "mcp", "memory"];

const TREE_CATEGORIES: Record<string, string> = {
  skills: "commands/",
  memory: "memory/",
};

export function ConfigPanel({ api }: { api: ReturnType<typeof createApi> }) {
  const [files, setFiles] = useState<ClaudeConfigFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ClaudeConfigFile | null>(null);
  const [newSkillName, setNewSkillName] = useState("");
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ClaudeConfigFile | null>(null);
  const editor = useFileEditor();
  const folders = useFolderToggle();

  const refresh = useCallback(async () => {
    try {
      const list = await api.listClaudeConfig();
      setFiles(list);
    } catch (err) {
      console.error("[ConfigPanel] refresh failed", err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const folderKeys = new Set<string>();
    for (const f of files) {
      const parts = f.name.split("/");
      for (let i = 1; i < parts.length; i++) {
        folderKeys.add(`${f.category}:${parts.slice(0, i).join("/")}`);
      }
    }
    folders.setExpanded(folderKeys);
  }, [files, folders.setExpanded]);

  const loadFile = async (file: ClaudeConfigFile) => {
    if (!editor.confirmDiscard()) return;
    setSelected(file);
    try {
      const text = await api.readClaudeConfig(file.path);
      editor.setLoaded(text);
    } catch (err) {
      console.error("[ConfigPanel] loadFile failed", err);
      editor.setLoaded("Failed to load");
    }
  };

  const saveFile = async () => {
    if (!selected) return;
    editor.setSaving(true);
    try {
      if (selected.name.endsWith(".json")) {
        JSON.parse(editor.content);
      }
      await api.writeClaudeConfig(selected.path, editor.content);
      editor.markSaved("Saved & synced to GCS", 3000);
    } catch (err: unknown) {
      editor.flashMessage(err instanceof SyntaxError ? "Invalid JSON" : "Failed to save");
    } finally {
      editor.setSaving(false);
    }
  };

  const createSkill = async () => {
    const name = newSkillName.trim();
    if (!name) return;
    if (!editor.confirmDiscard()) return;
    setCreatingSkill(true);
    try {
      const newFile = await api.createCommand(
        name,
        `# ${name}\n\nDescribe what this skill does. The content here becomes the prompt for the /${name} slash command.\n\nYou can use $ARGUMENTS to reference user input passed to the command.\n`,
      );
      setNewSkillName("");
      await refresh();
      setSelected(newFile);
      const text = await api.readClaudeConfig(newFile.path);
      editor.setLoaded(text);
      editor.flashMessage("Skill created", 2000);
    } catch (err: unknown) {
      editor.flashMessage(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setCreatingSkill(false);
    }
  };

  const deleteFile = async (file: ClaudeConfigFile) => {
    try {
      await api.deleteClaudeConfig(file.path);
      if (selected?.path === file.path) {
        setSelected(null);
        editor.setLoaded("");
      }
      await refresh();
      editor.flashMessage("Deleted", 2000);
    } catch (err: unknown) {
      editor.flashMessage(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    ...CATEGORY_LABELS[cat],
    files: files.filter((f) => f.category === cat),
  })).filter((g) => g.files.length > 0 || g.category === "skills");

  return (
    <div className="flex gap-4 h-[600px]">
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete config file"
        description={`Are you sure you want to delete ${pendingDelete?.name ?? "this file"}?`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => {
          if (pendingDelete) deleteFile(pendingDelete);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
      <div className="w-64 flex-shrink-0 overflow-y-auto space-y-4">
        <p className="text-xs text-zinc-400">
          Edit Claude config, skills, and memory. Changes are synced to GCS and persist across Cloud Run reloads.
        </p>

        {loading ? (
          <TreeListSkeleton rows={6} />
        ) : (
          grouped.map((group) => {
            const stripPrefix = TREE_CATEGORIES[group.category];
            const useTree = stripPrefix && group.files.some((f) => f.name.includes("/"));

            return (
              <div key={group.category}>
                <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-1">{group.label}</p>
                <p className="text-[11px] text-zinc-400 mb-2">{group.description}</p>

                <div className="space-y-0.5">
                  {useTree ? (
                    <TreeList<ClaudeConfigFile>
                      nodes={buildTree<ClaudeConfigFile>(
                        group.files.map((f) => ({
                          key: f.name.startsWith(stripPrefix) ? f.name.slice(stripPrefix.length) : f.name,
                          data: f,
                        })),
                      )}
                      depth={0}
                      selectedKey={
                        selected
                          ? selected.name.startsWith(stripPrefix)
                            ? selected.name.slice(stripPrefix.length)
                            : selected.name
                          : null
                      }
                      expandedFolders={folders.expanded}
                      folderKeyPrefix={group.category}
                      onToggleFolder={folders.toggle}
                      onSelectNode={(node) => node.data && loadFile(node.data)}
                      renderActions={(node) => {
                        if (node.isFolder || !node.data?.deletable) return null;
                        return (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (node.data) setPendingDelete(node.data);
                            }}
                            className="text-zinc-400 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                          >
                            x
                          </Button>
                        );
                      }}
                    />
                  ) : (
                    group.files.map((f) => (
                      <button
                        type="button"
                        key={f.path}
                        className={`flex items-center justify-between w-full text-left px-2 py-1.5 rounded text-sm cursor-pointer transition-colors group ${
                          selected?.path === f.path ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/50"
                        }`}
                        onClick={() => loadFile(f)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-xs truncate">{f.name}</div>
                          <div className="text-[11px] text-zinc-400 truncate">{f.description}</div>
                        </div>
                        {f.deletable && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDelete(f);
                            }}
                            className="text-zinc-400 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                          >
                            x
                          </Button>
                        )}
                      </button>
                    ))
                  )}
                </div>

                {group.category === "skills" && (
                  <div className="flex gap-1 mt-2">
                    <Input
                      value={newSkillName}
                      onChange={(e) => setNewSkillName(e.target.value)}
                      placeholder="my-skill or sub/skill"
                      onKeyDown={(e) => e.key === "Enter" && createSkill()}
                      className="h-8 flex-1 min-w-0"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={createSkill}
                      disabled={!newSkillName.trim() || creatingSkill}
                    >
                      {creatingSkill ? "..." : "+"}
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex-1 flex flex-col">
        {selected ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <div className="min-w-0">
                <span className="text-sm text-zinc-300 font-mono">{selected.name}</span>
                <span className="text-xs text-zinc-400 ml-3 truncate">{selected.path}</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {editor.message && (
                  <span
                    className={`text-xs ${editor.message === "Invalid JSON" || editor.message.includes("Failed") ? "text-red-400" : "text-emerald-500"}`}
                  >
                    {editor.message}
                  </span>
                )}
                {editor.isDirty && !editor.message && <span className="text-xs text-amber-400">Unsaved</span>}
                {selected.deletable && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPendingDelete(selected)}
                    className="text-red-400 hover:text-red-300"
                  >
                    Delete
                  </Button>
                )}
                <Button variant="default" size="sm" onClick={saveFile} disabled={editor.saving}>
                  {editor.saving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
            {selected.name.includes("CLAUDE.md") && (
              <div className="mb-2 px-3 py-2 rounded-md bg-zinc-800/50 border border-zinc-700/50 text-xs text-zinc-400 space-y-1">
                {selected.name === "~/CLAUDE.md" ? (
                  <>
                    <p>
                      <strong className="text-zinc-300">Global instructions</strong> - Claude Code loads this
                      automatically for every agent session.
                    </p>
                    <p>
                      Content from <code className="text-amber-400/80">shared-context/about-you.md</code> is also
                      inlined into each agent's workspace CLAUDE.md on creation.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      <strong className="text-zinc-300">Project instructions</strong> - This is the workspace CLAUDE.md
                      template written to each agent's working directory.
                    </p>
                    <p>
                      Agents receive this file plus <code className="text-amber-400/80">~/CLAUDE.md</code> (global) and
                      inlined <code className="text-amber-400/80">about-you.md</code> content.
                    </p>
                  </>
                )}
              </div>
            )}
            <textarea
              value={editor.content}
              onChange={(e) => editor.setContent(e.target.value)}
              className="flex-1 p-3 text-sm font-mono rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 focus:outline-none focus:border-zinc-500 resize-none leading-relaxed"
              spellCheck={false}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
            <div className="text-center space-y-2">
              <p>Select a config file to view or edit</p>
              <p className="text-[11px] text-zinc-400">
                Create skills with the + button to add shared slash commands for all agents
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
