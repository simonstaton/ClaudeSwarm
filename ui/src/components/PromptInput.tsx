import { Button } from "@fanvue/ui";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Attachment {
  id: string;
  name: string;
  type: "image" | "file";
  /** Data URL for images, text content for files */
  data: string;
  /** MIME type */
  mime: string;
  size: number;
}

interface SlashCommand {
  name: string;
  description: string;
  handler: () => string | null;
}

interface CreateModeConfig {
  onCreateSubmit: (opts: {
    prompt: string;
    name?: string;
    model?: string;
    maxTurns?: number;
    attachments?: Attachment[];
  }) => void;
}

export interface PromptInputDefaultValues {
  prompt?: string;
  name?: string;
  model?: string;
  maxTurns?: number;
}

interface PromptInputProps {
  onSubmit: (prompt: string, attachments?: Attachment[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Function to search files in agent workspace */
  onSearchFiles?: (query: string) => Promise<string[]>;
  /** Callback to handle slash commands that produce output (e.g. /cost) */
  onSlashCommand?: (command: string) => void;
  /** Enable creation mode with agent config fields */
  createMode?: CreateModeConfig;
  /** Pre-fill values from a template selection */
  defaultValues?: PromptInputDefaultValues;
  /** Called after defaultValues have been applied to state */
  onDefaultsApplied?: () => void;
}

// ── Slash commands registry ────────────────────────────────────────────────

function getSlashCommands(onSlashCommand?: (cmd: string) => void): SlashCommand[] {
  return [
    {
      name: "/cost",
      description: "Show token usage and cost for this session",
      handler: () => {
        onSlashCommand?.("cost");
        return null;
      },
    },
    {
      name: "/help",
      description: "Show available commands and keyboard shortcuts",
      handler: () => {
        onSlashCommand?.("help");
        return null;
      },
    },
    {
      name: "/clear",
      description: "Clear the terminal output",
      handler: () => {
        onSlashCommand?.("clear");
        return null;
      },
    },
    {
      name: "/status",
      description: "Show current agent status and session info",
      handler: () => {
        onSlashCommand?.("status");
        return null;
      },
    },
    {
      name: "/compact",
      description: "Ask agent to summarize conversation so far",
      handler: () => "Please provide a compact summary of our conversation and what you've accomplished so far.",
    },
    {
      name: "/review",
      description: "Ask agent to review recent changes",
      handler: () =>
        "Please review the changes you've made so far. List what was changed and flag any potential issues.",
    },
  ];
}

// ── Component ──────────────────────────────────────────────────────────────

export function PromptInput({
  onSubmit,
  disabled,
  placeholder = "Send a message...",
  onSearchFiles,
  onSlashCommand,
  createMode,
  defaultValues,
  onDefaultsApplied,
}: PromptInputProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Create mode state
  const [agentName, setAgentName] = useState("");
  const [agentModel, setAgentModel] = useState("claude-sonnet-4-5-20250929");
  const [agentMaxTurns, setAgentMaxTurns] = useState(200);
  const [showCreateConfig, setShowCreateConfig] = useState(!!createMode);

  // Autocomplete state
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);

  const [showFileMenu, setShowFileMenu] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const [fileSearching, setFileSearching] = useState(false);
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const slashCommands = getSlashCommands(onSlashCommand);

  // Sync showCreateConfig with createMode prop changes
  useEffect(() => {
    setShowCreateConfig(!!createMode);
  }, [createMode]);

  // Apply default values from template selection
  useEffect(() => {
    if (!defaultValues) return;
    if (defaultValues.prompt !== undefined) setValue(defaultValues.prompt);
    if (defaultValues.name !== undefined) setAgentName(defaultValues.name);
    if (defaultValues.model !== undefined) setAgentModel(defaultValues.model);
    if (defaultValues.maxTurns !== undefined) setAgentMaxTurns(defaultValues.maxTurns);
    setShowCreateConfig(true);
    onDefaultsApplied?.();
    // Focus the textarea so user can edit or just hit enter
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
      }
    });
  }, [defaultValues, onDefaultsApplied]);

  // ── Slash command filtering ────────────────────────────────────────────

  const filteredCommands = slashCommands.filter((cmd) =>
    cmd.name.toLowerCase().startsWith(`/${slashFilter.toLowerCase()}`),
  );

  // ── File search with debounce ──────────────────────────────────────────

  useEffect(() => {
    if (!showFileMenu || !onSearchFiles) {
      setFileResults([]);
      return;
    }

    if (fileSearchTimer.current) clearTimeout(fileSearchTimer.current);

    setFileSearching(true);
    fileSearchTimer.current = setTimeout(async () => {
      try {
        const results = await onSearchFiles(fileFilter);
        setFileResults(results);
      } catch (err) {
        console.error("Failed to search files:", err);
        setFileResults([]);
      } finally {
        setFileSearching(false);
      }
    }, 150);

    return () => {
      if (fileSearchTimer.current) clearTimeout(fileSearchTimer.current);
    };
  }, [fileFilter, showFileMenu, onSearchFiles]);

  // ── Text analysis for autocomplete triggers ────────────────────────────

  const analyzeInput = useCallback(
    (text: string, cursorPos: number) => {
      const textBeforeCursor = text.slice(0, cursorPos);

      // Check for slash command at start of input
      if (textBeforeCursor.match(/^\/\S*$/) && attachments.length === 0) {
        setShowSlashMenu(true);
        setSlashFilter(textBeforeCursor.slice(1));
        setSlashIndex(0);
        setShowFileMenu(false);
        return;
      }

      // Check for @ trigger: @ followed by optional text, not preceded by a word char
      const atMatch = textBeforeCursor.match(/(?:^|[\s(])@([^\s]*)$/);
      if (atMatch && onSearchFiles) {
        setShowFileMenu(true);
        setFileFilter(atMatch[1]);
        setFileIndex(0);
        setShowSlashMenu(false);
        return;
      }

      // No active trigger
      setShowSlashMenu(false);
      setShowFileMenu(false);
    },
    [attachments.length, onSearchFiles],
  );

  // ── Submit handling ────────────────────────────────────────────────────

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;

    // Check for slash command (not in create mode)
    if (!createMode) {
      const cmdMatch = trimmed.match(/^\/(\S+)/);
      if (cmdMatch && attachments.length === 0) {
        const cmd = slashCommands.find((c) => c.name === `/${cmdMatch[1]}`);
        if (cmd) {
          const result = cmd.handler();
          setValue("");
          setShowSlashMenu(false);
          if (textareaRef.current) textareaRef.current.style.height = "auto";
          if (result) {
            onSubmit(result);
          }
          return;
        }
      }
    }

    // Send prompt text as-is; attachments are passed separately and handled by the backend
    const prompt = trimmed;

    if (createMode) {
      createMode.onCreateSubmit({
        prompt,
        name: agentName.trim() || undefined,
        model: agentModel,
        maxTurns: agentMaxTurns,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
    } else {
      onSubmit(prompt, attachments.length > 0 ? attachments : undefined);
    }

    setValue("");
    setAttachments([]);
    setShowSlashMenu(false);
    setShowFileMenu(false);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [value, attachments, disabled, onSubmit, slashCommands, createMode, agentName, agentModel, agentMaxTurns]);

  // ── Keyboard handling ──────────────────────────────────────────────────

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Autocomplete navigation
    if (showSlashMenu && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        selectSlashCommand(filteredCommands[slashIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSlashMenu(false);
        return;
      }
    }

    if (showFileMenu && fileResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileIndex((i) => Math.min(i + 1, fileResults.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        selectFile(fileResults[fileIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowFileMenu(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // ── Autocomplete selection ─────────────────────────────────────────────

  const selectSlashCommand = (cmd: SlashCommand) => {
    setValue(cmd.name);
    setShowSlashMenu(false);
    textareaRef.current?.focus();
  };

  const selectFile = (filePath: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = value.slice(0, cursorPos);
    const textAfterCursor = value.slice(cursorPos);

    // Find the @ trigger position
    const atMatch = textBeforeCursor.match(/(?:^|[\s(])@([^\s]*)$/);
    if (!atMatch) return;

    const atStart = textBeforeCursor.length - atMatch[0].length + (atMatch[0].startsWith("@") ? 0 : 1);
    const before = value.slice(0, atStart);
    const insertion = `@${filePath} `;
    const newValue = before + insertion + textAfterCursor;

    setValue(newValue);
    setShowFileMenu(false);

    // Set cursor after insertion
    requestAnimationFrame(() => {
      const newPos = before.length + insertion.length;
      textarea.setSelectionRange(newPos, newPos);
      textarea.focus();
    });
  };

  // ── Input change ───────────────────────────────────────────────────────

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    analyzeInput(newValue, e.target.selectionStart);
    autoResize();
  };

  const autoResize = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  };

  // ── File/image handling ────────────────────────────────────────────────

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const newAttachments: Attachment[] = [];

    for (const file of Array.from(files)) {
      if (file.size > 10 * 1024 * 1024) continue; // Skip files > 10MB

      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (file.type.startsWith("image/")) {
        const data = await readFileAsDataURL(file);
        newAttachments.push({
          id,
          name: file.name,
          type: "image",
          data,
          mime: file.type,
          size: file.size,
        });
      } else if (isTextFile(file)) {
        const data = await readFileAsText(file);
        newAttachments.push({
          id,
          name: file.name,
          type: "file",
          data,
          mime: file.type || "text/plain",
          size: file.size,
        });
      }
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
    }
  }, []);

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      processFiles(files);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      e.target.value = "";
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop zone for file attachments
    <section
      className={`relative border-t border-zinc-800 bg-zinc-900/50 ${isDragOver ? "ring-2 ring-blue-500/50 ring-inset" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-900/80 border-2 border-dashed border-blue-500/50 rounded pointer-events-none">
          <span className="text-blue-400 text-sm font-medium">Drop files or images here</span>
        </div>
      )}

      {/* Slash command menu */}
      {showSlashMenu && filteredCommands.length > 0 && (
        <div className="absolute bottom-full left-3 mb-1 w-72 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-20">
          <div className="px-3 py-1.5 border-b border-zinc-700/50">
            <span className="text-xs text-zinc-500">Commands</span>
          </div>
          {filteredCommands.map((cmd, i) => (
            <button
              type="button"
              key={cmd.name}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 text-sm transition-colors ${
                i === slashIndex
                  ? "bg-zinc-700/70 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-700/40 hover:text-zinc-200"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                selectSlashCommand(cmd);
              }}
              onMouseEnter={() => setSlashIndex(i)}
            >
              <span className="font-mono text-cyan-400 text-xs shrink-0">{cmd.name}</span>
              <span className="text-zinc-500 text-xs truncate">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}

      {/* File reference menu */}
      {showFileMenu && (
        <div className="absolute bottom-full left-3 mb-1 w-80 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-20">
          <div className="px-3 py-1.5 border-b border-zinc-700/50 flex items-center justify-between">
            <span className="text-xs text-zinc-500">Files in workspace</span>
            {fileSearching && <span className="text-xs text-zinc-600 animate-pulse">searching...</span>}
          </div>
          {fileResults.length === 0 ? (
            <div className="px-3 py-3 text-xs text-zinc-600">
              {fileSearching ? "Searching..." : fileFilter ? "No files match" : "Type to search files..."}
            </div>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {fileResults.map((filePath, i) => (
                <button
                  type="button"
                  key={filePath}
                  className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-sm transition-colors ${
                    i === fileIndex
                      ? "bg-zinc-700/70 text-zinc-100"
                      : "text-zinc-400 hover:bg-zinc-700/40 hover:text-zinc-200"
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectFile(filePath);
                  }}
                  onMouseEnter={() => setFileIndex(i)}
                >
                  <FileIcon filename={filePath} />
                  <span className="font-mono text-xs truncate">{filePath}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create mode config toolbar */}
      {createMode && showCreateConfig && (
        <div className="px-3 pt-3 pb-1 flex items-end gap-3 border-b border-zinc-800/50">
          <div className="flex-1 min-w-0">
            <label htmlFor="create-agent-name" className="block text-[10px] text-zinc-600 mb-0.5">
              Name
            </label>
            <input
              id="create-agent-name"
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="my-agent"
              className="w-full px-2 py-1 text-xs rounded border border-zinc-700 bg-zinc-800 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 font-[var(--font-mono)]"
            />
          </div>
          <div className="w-40 shrink-0">
            <label htmlFor="create-agent-model" className="block text-[10px] text-zinc-600 mb-0.5">
              Model
            </label>
            <select
              id="create-agent-model"
              value={agentModel}
              onChange={(e) => setAgentModel(e.target.value)}
              className="w-full px-2 py-1 text-xs rounded border border-zinc-700 bg-zinc-800 text-zinc-200 focus:outline-none focus:border-zinc-500"
            >
              <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
              <option value="claude-sonnet-4-5-20250929">Sonnet 4.5</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6</option>
              <option value="claude-opus-4-6">Opus 4.6</option>
            </select>
          </div>
          <div className="w-20 shrink-0">
            <label htmlFor="create-agent-turns" className="block text-[10px] text-zinc-600 mb-0.5">
              Max turns
            </label>
            <input
              id="create-agent-turns"
              type="number"
              value={agentMaxTurns}
              onChange={(e) => setAgentMaxTurns(Number(e.target.value))}
              min={1}
              max={500}
              className="w-full px-2 py-1 text-xs rounded border border-zinc-700 bg-zinc-800 text-zinc-200 focus:outline-none focus:border-zinc-500"
            />
          </div>
        </div>
      )}

      {/* Attachment preview strip */}
      {attachments.length > 0 && (
        <div className="flex items-center gap-2 px-3 pt-2 pb-0 overflow-x-auto">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="relative group shrink-0 flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1"
            >
              {att.type === "image" ? (
                <img src={att.data} alt={att.name} className="h-8 w-8 rounded object-cover" />
              ) : (
                <FileIcon filename={att.name} />
              )}
              <span className="text-xs text-zinc-400 max-w-[120px] truncate">{att.name}</span>
              <span className="text-[10px] text-zinc-600">{formatSize(att.size)}</span>
              <button
                type="button"
                onClick={() => removeAttachment(att.id)}
                className="ml-1 text-zinc-600 hover:text-red-400 transition-colors"
                title="Remove"
              >
                <svg
                  aria-hidden="true"
                  className="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2 p-3">
        {/* Attach button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="shrink-0 p-2 text-zinc-500 hover:text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors rounded hover:bg-zinc-800"
          title="Attach file or image (or paste / drag & drop)"
        >
          <svg
            aria-hidden="true"
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
            />
          </svg>
        </button>

        {/* Create mode: config toggle */}
        {createMode && (
          <button
            type="button"
            onClick={() => setShowCreateConfig((v) => !v)}
            className={`shrink-0 p-2 transition-colors rounded hover:bg-zinc-800 ${showCreateConfig ? "text-cyan-400" : "text-zinc-500 hover:text-zinc-300"}`}
            title="Agent settings (name, model, max turns)"
          >
            <GearIcon />
          </button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.yml,.yaml,.toml,.css,.html,.csv,.log,.sh,.bash,.zsh,.env,.cfg,.ini,.xml,.svg"
          onChange={handleFileInputChange}
          className="hidden"
        />

        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 disabled:cursor-not-allowed font-[var(--font-mono)]"
        />

        <Button
          variant="primary"
          size="40"
          onClick={submit}
          disabled={disabled || (!value.trim() && attachments.length === 0)}
        >
          {createMode ? "Create" : "Send"}
        </Button>
      </div>

      {/* Keyboard hints */}
      <div className="px-3 pb-1.5 flex items-center gap-3 text-[10px] text-zinc-700">
        {!createMode && (
          <span>
            <kbd className="px-1 bg-zinc-800 rounded text-zinc-600">/</kbd> commands
          </span>
        )}
        {onSearchFiles && !createMode && (
          <span>
            <kbd className="px-1 bg-zinc-800 rounded text-zinc-600">@</kbd> reference file
          </span>
        )}
        <span>
          <kbd className="px-1 bg-zinc-800 rounded text-zinc-600">Shift+Enter</kbd> newline
        </span>
        <span>paste or drag images/files</span>
        {createMode && (
          <span>
            <kbd className="px-1 bg-zinc-800 rounded text-zinc-600">
              <GearIcon className="w-2.5 h-2.5 inline" />
            </kbd>{" "}
            agent settings
          </span>
        )}
      </div>
    </section>
  );
}

// ── Helper components & utilities ────────────────────────────────────────────

const GEAR_PATH =
  "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z";

function GearIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d={GEAR_PATH} />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function FileIcon({ filename }: { filename: string }) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const iconColors: Record<string, string> = {
    ts: "text-blue-400",
    tsx: "text-blue-400",
    js: "text-yellow-400",
    jsx: "text-yellow-400",
    py: "text-green-400",
    rs: "text-orange-400",
    go: "text-cyan-400",
    md: "text-zinc-400",
    json: "text-yellow-500",
    css: "text-purple-400",
    html: "text-red-400",
    svg: "text-orange-300",
    yml: "text-pink-400",
    yaml: "text-pink-400",
    toml: "text-pink-400",
    sh: "text-green-300",
  };

  return <span className={`text-xs font-mono ${iconColors[ext] || "text-zinc-500"}`}>{ext ? `.${ext}` : "?"}</span>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function isTextFile(file: File): boolean {
  const textExtensions = new Set([
    "txt",
    "md",
    "json",
    "ts",
    "tsx",
    "js",
    "jsx",
    "py",
    "rs",
    "go",
    "yml",
    "yaml",
    "toml",
    "css",
    "html",
    "csv",
    "log",
    "sh",
    "bash",
    "zsh",
    "env",
    "cfg",
    "ini",
    "xml",
    "svg",
    "sql",
    "graphql",
    "gql",
    "prisma",
    "dockerfile",
    "makefile",
    "gitignore",
    "editorconfig",
  ]);
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  return (
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    file.type === "application/xml" ||
    textExtensions.has(ext)
  );
}
