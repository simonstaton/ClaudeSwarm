"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ContextFile, createApi } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { TreeListSkeleton } from "../../components/Skeleton";
import { useFileEditor, useFolderToggle } from "./hooks";
import { allFolderPaths, buildTree, TreeList } from "./tree";

export function ContextPanel({ api }: { api: ReturnType<typeof createApi> }) {
  const [files, setFiles] = useState<ContextFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const editor = useFileEditor();
  const folders = useFolderToggle();

  const refresh = useCallback(async () => {
    try {
      const list = await api.listContext();
      setFiles(list);
    } catch (err) {
      console.error("Failed to list context files:", err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    folders.setExpanded(allFolderPaths(files.map((f) => f.name)));
  }, [files, folders.setExpanded]);

  const loadFile = async (name: string) => {
    if (!editor.confirmDiscard()) return;
    setSelected(name);
    editor.setLoaded("Loading...");
    try {
      const text = await api.readContext(name);
      editor.setLoaded(text);
    } catch (err) {
      console.error("[ContextPanel] loadFile failed", err);
      editor.setLoaded("");
      editor.flashMessage("Failed to load file");
    }
  };

  const saveFile = async () => {
    if (!selected) return;
    editor.setSaving(true);
    try {
      await api.updateContext(selected, editor.content);
      editor.markSaved();
      refresh();
    } catch (err) {
      console.error("[ContextPanel] saveFile failed", err);
      editor.flashMessage("Failed to save");
    } finally {
      editor.setSaving(false);
    }
  };

  const createFile = async () => {
    const name = newName.trim();
    if (!name) return;
    if (!editor.confirmDiscard()) return;
    const filename = name.endsWith(".md") ? name : `${name}.md`;
    try {
      const initialContent = `# ${name.replace(".md", "")}\n\n`;
      await api.updateContext(filename, initialContent);
      setNewName("");
      await refresh();
      setSelected(filename);
      editor.setLoaded(initialContent);
    } catch (err) {
      console.error("[ContextPanel] createFile failed", err);
      editor.flashMessage("Failed to create file");
    }
  };

  const deleteFile = async (name: string) => {
    try {
      await api.deleteContext(name);
      if (selected === name) {
        setSelected(null);
        editor.setLoaded("");
      }
      refresh();
    } catch (err) {
      console.error("[ContextPanel] deleteFile failed", err);
      editor.flashMessage("Failed to delete");
    }
  };

  const tree = buildTree(files.map((f) => ({ key: f.name })));

  return (
    <div className="flex gap-4 h-[600px]">
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete file"
        description={`Are you sure you want to delete ${pendingDelete ?? "this file"}?`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => {
          if (pendingDelete) deleteFile(pendingDelete);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
      <div className="w-56 flex-shrink-0 space-y-2">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Context files</p>
        <p className="text-xs text-zinc-400 mb-3">Shared .md files accessible to all agents</p>
        {loading ? (
          <TreeListSkeleton rows={5} />
        ) : (
          <TreeList
            nodes={tree}
            depth={0}
            selectedKey={selected}
            expandedFolders={folders.expanded}
            onToggleFolder={folders.toggle}
            onSelectNode={(node) => loadFile(node.fullPath)}
            renderActions={(node) =>
              !node.isFolder && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete(node.fullPath);
                  }}
                  className="text-zinc-400 hover:text-red-400"
                >
                  x
                </Button>
              )
            }
          />
        )}
        <div className="flex gap-1 mt-3">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="file.md or folder/file.md"
            onKeyDown={(e) => e.key === "Enter" && createFile()}
            className="h-8 flex-1 min-w-0"
          />
          <Button variant="secondary" size="sm" onClick={createFile} disabled={!newName.trim()}>
            +
          </Button>
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        {selected ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-zinc-400 font-mono">{selected}</span>
              <div className="flex items-center gap-2">
                {editor.message && <span className="text-xs text-zinc-400">{editor.message}</span>}
                {editor.isDirty && !editor.message && <span className="text-xs text-amber-400">Unsaved</span>}
                <Button variant="default" size="sm" onClick={saveFile} disabled={editor.saving}>
                  {editor.saving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
            <textarea
              value={editor.content}
              onChange={(e) => editor.setContent(e.target.value)}
              className="flex-1 p-3 text-sm font-mono rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 focus:outline-none focus:border-zinc-500 resize-none leading-relaxed"
              spellCheck={false}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
            Select a file or create a new one
          </div>
        )}
      </div>
    </div>
  );
}
