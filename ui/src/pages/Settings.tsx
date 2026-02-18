import { Alert, Button, PasswordField, Tabs, TabsContent, TabsList, TabsTrigger, TextField } from "@fanvue/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Agent, ClaudeConfigFile, ContextFile, createApi } from "../api";
import { Header } from "../components/Header";
import { MessageFeed } from "../components/MessageFeed";
import { Sidebar } from "../components/Sidebar";
import { useApi } from "../hooks/useApi";
import { useKillSwitchContext } from "../App";

// ── Generic file tree utilities ─────────────────────────────────────────────

interface TreeNode<T = undefined> {
  name: string;
  fullPath: string;
  isFolder: boolean;
  children: TreeNode<T>[];
  data?: T;
}

function buildTree<T>(items: Array<{ key: string; data?: T }>): TreeNode<T>[] {
  const root: TreeNode<T>[] = [];

  for (const item of items) {
    const parts = item.key.split("/");
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      let existing = currentLevel.find((n) => n.name === part && n.isFolder === !isLast);
      if (!existing) {
        existing = {
          name: part,
          fullPath: isLast ? item.key : parts.slice(0, i + 1).join("/"),
          isFolder: !isLast,
          children: [],
          data: isLast ? item.data : undefined,
        };
        currentLevel.push(existing);
      }
      if (!isLast) {
        currentLevel = existing.children;
      }
    }
  }

  const sortNodes = (nodes: TreeNode<T>[]) => {
    nodes.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.isFolder) sortNodes(node.children);
    }
  };
  sortNodes(root);

  return root;
}

function allFolderPaths(keys: string[]): Set<string> {
  const folders = new Set<string>();
  for (const key of keys) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) {
      folders.add(parts.slice(0, i).join("/"));
    }
  }
  return folders;
}

// ── Generic tree list component ──────────────────────────────────────────────

function TreeList<T>({
  nodes,
  depth,
  selectedKey,
  expandedFolders,
  folderKeyPrefix,
  onToggleFolder,
  onSelectNode,
  renderActions,
}: {
  nodes: TreeNode<T>[];
  depth: number;
  selectedKey: string | null;
  expandedFolders: Set<string>;
  folderKeyPrefix?: string;
  onToggleFolder: (key: string) => void;
  onSelectNode: (node: TreeNode<T>) => void;
  renderActions?: (node: TreeNode<T>) => React.ReactNode;
}) {
  return (
    <>
      {nodes.map((node) => {
        const folderKey = folderKeyPrefix ? `${folderKeyPrefix}:${node.fullPath}` : node.fullPath;

        if (node.isFolder) {
          return (
            <div key={folderKey}>
              <button
                type="button"
                className="flex items-center w-full px-2 py-1.5 rounded text-sm text-zinc-500 hover:bg-zinc-800/50 cursor-pointer"
                style={{ paddingLeft: `${8 + depth * 12}px` }}
                onClick={() => onToggleFolder(folderKey)}
              >
                <span className="text-[10px] mr-1.5 w-3 inline-block">
                  {expandedFolders.has(folderKey) ? "\u25BC" : "\u25B6"}
                </span>
                <span className="truncate">{node.name}/</span>
              </button>
              {expandedFolders.has(folderKey) && (
                <TreeList
                  nodes={node.children}
                  depth={depth + 1}
                  selectedKey={selectedKey}
                  expandedFolders={expandedFolders}
                  folderKeyPrefix={folderKeyPrefix}
                  onToggleFolder={onToggleFolder}
                  onSelectNode={onSelectNode}
                  renderActions={renderActions}
                />
              )}
            </div>
          );
        }

        return (
          <button
            type="button"
            key={node.fullPath}
            className={`flex items-center justify-between w-full px-2 py-1.5 rounded text-sm cursor-pointer transition-colors group ${
              selectedKey === node.fullPath ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/50"
            }`}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            onClick={() => onSelectNode(node)}
          >
            <span className="truncate">{node.name}</span>
            {renderActions?.(node)}
          </button>
        );
      })}
    </>
  );
}

// ── Shared editor state hook ──────────────────────────────────────────────

function useFileEditor() {
  const [content, setContent] = useState("");
  const savedContentRef = useRef("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const isDirty = content !== savedContentRef.current;

  // Warn on browser tab close when dirty
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const setLoaded = (text: string) => {
    setContent(text);
    savedContentRef.current = text;
    setMessage("");
  };

  const markSaved = (msg = "Saved", timeout = 2000) => {
    savedContentRef.current = content;
    setMessage(msg);
    setTimeout(() => setMessage(""), timeout);
  };

  const confirmDiscard = () => !isDirty || confirm("You have unsaved changes. Discard them?");

  const flashMessage = (msg: string, timeout = 3000) => {
    setMessage(msg);
    setTimeout(() => setMessage(""), timeout);
  };

  return {
    content,
    setContent,
    saving,
    setSaving,
    message,
    setMessage,
    isDirty,
    setLoaded,
    markSaved,
    confirmDiscard,
    flashMessage,
  };
}

// ── Folder toggle helper ─────────────────────────────────────────────────

function useFolderToggle(initial: Set<string> = new Set()) {
  const [expanded, setExpanded] = useState(initial);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return { expanded, setExpanded, toggle };
}

// ── Main Settings page ───────────────────────────────────────────────────────

export function Settings() {
  const navigate = useNavigate();
  const api = useApi();
  const [agents, setAgents] = useState<Agent[]>([]);
  const killSwitch = useKillSwitchContext();

  useEffect(() => {
    api
      .fetchAgents()
      .then(setAgents)
      .catch((err) => {
        console.error("[Settings] fetchAgents failed", err);
      });
  }, [api]);

  return (
    <div className="h-screen flex flex-col">
      <Header agentCount={agents.length} killSwitch={killSwitch} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar agents={agents} activeId={null} onSelect={(id) => navigate(`/agents/${id}`)} />
        <main className="flex-1 overflow-y-auto">
          <Tabs defaultValue="context" className="pt-6">
            <TabsList className="px-6 border-b border-zinc-800">
              <TabsTrigger value="context">Shared Context</TabsTrigger>
              <TabsTrigger value="messages">Messages</TabsTrigger>
              <TabsTrigger value="config">Claude Config</TabsTrigger>
              <TabsTrigger value="apikey">API Key</TabsTrigger>
            </TabsList>

            <div className="p-6">
              <TabsContent value="context">
                <ContextPanel api={api} />
              </TabsContent>
              <TabsContent value="messages">
                <div className="h-[calc(100vh-12rem)]">
                  <MessageFeed api={api} agents={agents} />
                </div>
              </TabsContent>
              <TabsContent value="config">
                <ConfigPanel api={api} />
              </TabsContent>
              <TabsContent value="apikey">
                <ApiKeyPanel api={api} />
              </TabsContent>
            </div>
          </Tabs>
        </main>
      </div>
    </div>
  );
}

// ── Shared Context Panel ────────────────────────────────────────────────────
function ContextPanel({ api }: { api: ReturnType<typeof createApi> }) {
  const [files, setFiles] = useState<ContextFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const editor = useFileEditor();
  const folders = useFolderToggle();

  const refresh = useCallback(async () => {
    const list = await api.listContext();
    setFiles(list);
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-expand all folders when files load
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
    if (!confirm(`Delete ${name}?`)) return;
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
    <div className="flex gap-4 h-[calc(100vh-12rem)]">
      {/* File list */}
      <div className="w-56 flex-shrink-0 space-y-2">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Context files</p>
        <p className="text-xs text-zinc-600 mb-3">Shared .md files accessible to all agents</p>
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
                variant="text"
                size="24"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteFile(node.fullPath);
                }}
                className="text-zinc-600 hover:text-red-400"
              >
                x
              </Button>
            )
          }
        />
        <div className="flex gap-1 mt-3">
          <TextField
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="file.md or folder/file.md"
            onKeyDown={(e) => e.key === "Enter" && createFile()}
            size="32"
            fullWidth
          />
          <Button variant="secondary" size="32" onClick={createFile} disabled={!newName.trim()}>
            +
          </Button>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col">
        {selected ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-zinc-400 font-mono">{selected}</span>
              <div className="flex items-center gap-2">
                {editor.message && <span className="text-xs text-zinc-500">{editor.message}</span>}
                {editor.isDirty && !editor.message && <span className="text-xs text-amber-400">Unsaved</span>}
                <Button variant="primary" size="24" onClick={saveFile} disabled={editor.saving} loading={editor.saving}>
                  Save
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
          <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
            Select a file or create a new one
          </div>
        )}
      </div>
    </div>
  );
}

// ── Claude Config Panel ─────────────────────────────────────────────────────
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

function ConfigPanel({ api }: { api: ReturnType<typeof createApi> }) {
  const [files, setFiles] = useState<ClaudeConfigFile[]>([]);
  const [selected, setSelected] = useState<ClaudeConfigFile | null>(null);
  const [newSkillName, setNewSkillName] = useState("");
  const [creatingSkill, setCreatingSkill] = useState(false);
  const editor = useFileEditor();
  const folders = useFolderToggle();

  const refresh = useCallback(async () => {
    try {
      const list = await api.listClaudeConfig();
      setFiles(list);
    } catch (err) {
      console.error("[ConfigPanel] refresh failed", err);
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-expand all config folders
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
    if (!confirm(`Delete ${file.name}?`)) return;
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
    <div className="flex gap-4 h-[calc(100vh-12rem)]">
      {/* File list */}
      <div className="w-64 flex-shrink-0 overflow-y-auto space-y-4">
        <p className="text-xs text-zinc-600">
          Edit Claude config, skills, and memory. Changes are synced to GCS and persist across Cloud Run reloads.
        </p>

        {grouped.map((group) => {
          const stripPrefix = TREE_CATEGORIES[group.category];
          const useTree = stripPrefix && group.files.some((f) => f.name.includes("/"));

          return (
            <div key={group.category}>
              <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1">{group.label}</p>
              <p className="text-[11px] text-zinc-600 mb-2">{group.description}</p>

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
                          variant="text"
                          size="24"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (node.data) deleteFile(node.data);
                          }}
                          className="text-zinc-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
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
                        <div className="text-[11px] text-zinc-600 truncate">{f.description}</div>
                      </div>
                      {f.deletable && (
                        <Button
                          variant="text"
                          size="24"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteFile(f);
                          }}
                          className="text-zinc-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
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
                  <TextField
                    value={newSkillName}
                    onChange={(e) => setNewSkillName(e.target.value)}
                    placeholder="my-skill or sub/skill"
                    onKeyDown={(e) => e.key === "Enter" && createSkill()}
                    size="32"
                    fullWidth
                  />
                  <Button
                    variant="secondary"
                    size="32"
                    onClick={createSkill}
                    disabled={!newSkillName.trim() || creatingSkill}
                    loading={creatingSkill}
                  >
                    +
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col">
        {selected ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <div className="min-w-0">
                <span className="text-sm text-zinc-300 font-mono">{selected.name}</span>
                <span className="text-xs text-zinc-600 ml-3 truncate">{selected.path}</span>
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
                    size="24"
                    onClick={() => deleteFile(selected)}
                    className="text-red-400 hover:text-red-300"
                  >
                    Delete
                  </Button>
                )}
                <Button variant="primary" size="24" onClick={saveFile} disabled={editor.saving} loading={editor.saving}>
                  Save
                </Button>
              </div>
            </div>
            {selected.name.includes("CLAUDE.md") && (
              <div className="mb-2 px-3 py-2 rounded-md bg-zinc-800/50 border border-zinc-700/50 text-xs text-zinc-400 space-y-1">
                {selected.name === "~/CLAUDE.md" ? (
                  <>
                    <p>
                      <strong className="text-zinc-300">Global instructions</strong> — Claude Code loads this
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
                      <strong className="text-zinc-300">Project instructions</strong> — This is the workspace CLAUDE.md
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
          <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
            <div className="text-center space-y-2">
              <p>Select a config file to view or edit</p>
              <p className="text-[11px] text-zinc-700">
                Create skills with the + button to add shared slash commands for all agents
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── API Key Panel ───────────────────────────────────────────────────────────
function ApiKeyPanel({ api }: { api: ReturnType<typeof createApi> }) {
  const [hint, setHint] = useState("");
  const [newKey, setNewKey] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setHint(s.anthropicKeyHint))
      .catch((err) => {
        console.error("[ApiKeyPanel] getSettings failed", err);
      });
  }, [api]);

  const switchKey = async () => {
    const key = newKey.trim();
    if (!key) return;
    try {
      const newHint = await api.setAnthropicKey(key);
      setHint(newHint);
      setNewKey("");
      setMessage("API key updated. New agents will use this key.");
      setTimeout(() => setMessage(""), 4000);
    } catch (err) {
      console.error("[ApiKeyPanel] switchKey failed", err);
      setMessage("Invalid key format (must start with sk-ant-)");
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Current Anthropic API Key</p>
        <div className="px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800 font-mono text-sm text-zinc-300">
          {hint || "Loading..."}
        </div>
        <p className="text-xs text-zinc-600 mt-1">Switch between personal and work API keys at runtime</p>
      </div>

      <div>
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Switch API Key</p>
        <div className="flex gap-2">
          <PasswordField
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="sk-ant-..."
            size="40"
            fullWidth
          />
          <Button variant="primary" size="40" onClick={switchKey} disabled={!newKey.trim()}>
            Switch
          </Button>
        </div>
        {message && (
          <Alert variant={message.includes("Invalid") ? "error" : "success"} className="mt-2">
            {message}
          </Alert>
        )}
      </div>
    </div>
  );
}
