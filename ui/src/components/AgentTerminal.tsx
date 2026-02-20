"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { StreamEvent } from "../api";

/** Block kinds visible in simple mode (non-technical view) */
const SIMPLE_MODE_KINDS = new Set<TerminalBlock["kind"]>(["text", "user_prompt", "result"]);

// Stable component refs for Virtuoso - extracted outside the component to
// prevent creating new objects on every render (which defeats Virtuoso's
// internal memoization and causes unnecessary re-renders).
const VirtuosoSpacer = () => <div className="h-4" />;
const virtuosoComponents = { Header: VirtuosoSpacer, Footer: VirtuosoSpacer };

interface AgentTerminalProps {
  events: StreamEvent[];
}

// Parsed renderable block from raw stream events
export interface TerminalBlock {
  id: string;
  kind: "system" | "text" | "user_prompt" | "tool_use" | "tool_result" | "result" | "error" | "raw";
  content: string;
  meta?: Record<string, unknown>;
}

export function AgentTerminal({ events }: AgentTerminalProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [simpleMode, setSimpleMode] = useState(false);

  // Incremental parsing: only parse new events since last render
  const parsedRef = useRef<{ upTo: number; blocks: TerminalBlock[] }>({ upTo: 0, blocks: [] });
  const cached = parsedRef.current;
  if (events.length < cached.upTo) {
    // Events array was reset (e.g. agent switched) - reparse from scratch
    cached.upTo = 0;
    cached.blocks = [];
  }
  if (events.length > cached.upTo) {
    const newBlocks = parseEvents(events, cached.upTo);
    cached.blocks = cached.blocks.concat(newBlocks);
    cached.blocks = deduplicateResultBlocks(cached.blocks);
    cached.upTo = events.length;
  }

  // Limit blocks to prevent memory leak - keep last 2000 blocks
  // This matches MAX_EVENTS from useAgentStream and prevents unbounded growth
  const MAX_BLOCKS = 2000;
  if (cached.blocks.length > MAX_BLOCKS) {
    cached.blocks = cached.blocks.slice(-MAX_BLOCKS);
  }

  const allBlocks = cached.blocks;

  // In simple mode, filter out technical blocks (tool calls, system, errors, raw)
  const blocks = useMemo(
    () => (simpleMode ? allBlocks.filter((b) => SIMPLE_MODE_KINDS.has(b.kind)) : allBlocks),
    [simpleMode, allBlocks],
  );

  // followOutput keeps scroll pinned to the bottom when new items arrive,
  // but only if the user hasn't manually scrolled up.
  const followOutput = useCallback((isAtBottom: boolean) => {
    return isAtBottom ? ("smooth" as const) : false;
  }, []);

  return (
    <div
      className="terminal flex-1 overflow-hidden bg-zinc-950 flex flex-col"
      role="log"
      aria-live="polite"
      aria-label="Agent terminal output"
    >
      {/* Simple / Detailed view toggle */}
      <div className="flex items-center justify-end px-4 py-1.5 border-b border-zinc-800/50 bg-zinc-900/30 shrink-0">
        <button
          type="button"
          role="switch"
          aria-checked={simpleMode}
          onClick={() => setSimpleMode((prev) => !prev)}
          className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          aria-label="Simple output mode"
        >
          <span className={simpleMode ? "text-zinc-500" : "text-zinc-200 font-medium"}>Detailed</span>
          <span
            className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${simpleMode ? "bg-emerald-600" : "bg-zinc-700"}`}
          >
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full bg-white transition-transform ${simpleMode ? "translate-x-3.5" : "translate-x-1"}`}
            />
          </span>
          <span className={simpleMode ? "text-zinc-200 font-medium" : "text-zinc-500"}>Simple</span>
        </button>
      </div>

      {/* Terminal content */}
      <div className="flex-1 overflow-hidden">
        {blocks.length === 0 ? (
          <p className="text-zinc-400 text-sm italic p-4">
            {simpleMode && allBlocks.length > 0 ? "No conversation messages yet..." : "Waiting for output..."}
          </p>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={blocks}
            followOutput={followOutput}
            overscan={200}
            initialTopMostItemIndex={blocks.length - 1}
            className="h-full"
            itemContent={renderBlock}
            components={virtuosoComponents}
          />
        )}
      </div>
    </div>
  );
}

// Stable itemContent callback for Virtuoso - defined at module level so the
// function reference never changes between renders (avoids Virtuoso re-rendering
// every visible row on each parent render).
function renderBlock(_index: number, block: TerminalBlock) {
  return (
    <div className="px-4">
      <MemoizedBlock block={block} />
    </div>
  );
}

// Memoize individual blocks to prevent re-renders of unchanged content
export const MemoizedBlock = memo(Block);

function Block({ block }: { block: TerminalBlock }) {
  const [collapsed, setCollapsed] = useState(true);

  switch (block.kind) {
    case "system":
      if (block.meta?.isCommandOutput) {
        return (
          <div className="my-2 rounded bg-zinc-900/80 border border-zinc-800/60 px-3 py-2">
            <pre className="text-cyan-400/80 text-xs whitespace-pre-wrap font-[var(--font-mono)]">{block.content}</pre>
          </div>
        );
      }
      if (block.meta?.isWatchdog) {
        return (
          <div className="my-2 rounded bg-amber-950/30 border border-amber-800/50 px-3 py-2">
            <pre className="text-amber-400 text-xs whitespace-pre-wrap font-[var(--font-mono)]">{block.content}</pre>
          </div>
        );
      }
      return (
        <div className="terminal-line text-zinc-400 italic text-xs mb-2 pb-1 border-b border-zinc-800/50">
          {block.content}
        </div>
      );

    case "text":
      return <div className="terminal-line text-zinc-200 mb-2 leading-relaxed">{block.content}</div>;

    case "user_prompt":
      return (
        <div className="mt-3 mb-2 pt-2 border-t border-zinc-800">
          <div className="text-blue-400 text-sm font-medium mb-1">You</div>
          <div className="terminal-line text-zinc-300 mb-2 leading-relaxed">{block.content}</div>
        </div>
      );

    case "tool_use": {
      const toolName = String(block.meta?.name || "tool");
      const input = block.meta?.input as Record<string, unknown> | undefined;
      const summary = input ? summarizeInput(toolName, input) : "";
      return (
        <div className="mb-1.5 rounded bg-zinc-900/80 border border-zinc-800/60 px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-cyan-500 font-semibold">{toolName}</span>
            {summary && <span className="text-zinc-400 truncate text-xs font-mono">{summary}</span>}
          </div>
          {block.content && (
            <pre className="text-zinc-400 text-xs mt-1 whitespace-pre-wrap overflow-hidden max-h-24">
              {block.content}
            </pre>
          )}
        </div>
      );
    }

    case "tool_result":
      return (
        <div className="mb-2 ml-2 border-l-2 border-zinc-800 pl-3">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand tool output" : "Collapse tool output"}
            className="text-zinc-400 hover:text-zinc-300 text-xs transition-colors flex items-center gap-1"
          >
            <span className="text-[10px]">{collapsed ? "\u25B6" : "\u25BC"}</span>
            <span>
              output
              {block.meta?.is_error ? " (error)" : ""}
              {!collapsed ? "" : ` \u2014 ${block.content.slice(0, 80)}${block.content.length > 80 ? "\u2026" : ""}`}
            </span>
          </button>
          {!collapsed && (
            <pre className="text-zinc-400 text-xs mt-1 whitespace-pre-wrap max-h-60 overflow-y-auto">
              {block.content}
            </pre>
          )}
        </div>
      );

    case "result": {
      const cost = block.meta?.total_cost_usd;
      const duration = block.meta?.duration_ms;
      const turns = block.meta?.num_turns;
      return (
        <div className="mt-3 mb-2 pt-2 border-t border-zinc-800">
          <div className="text-emerald-400 terminal-line leading-relaxed mb-1">{block.content}</div>
          <div className="flex gap-3 text-xs text-zinc-400 mt-1">
            {duration != null && <span>{(Number(duration) / 1000).toFixed(1)}s</span>}
            {turns != null && (
              <span>
                {String(turns)} turn{Number(turns) !== 1 ? "s" : ""}
              </span>
            )}
            {cost != null && <span>${Number(cost).toFixed(4)}</span>}
          </div>
        </div>
      );
    }

    case "error":
      return <div className="terminal-line text-red-400/80 text-xs mb-1">{block.content}</div>;

    case "raw":
      return <div className="terminal-line text-zinc-400 text-xs mb-0.5">{block.content}</div>;
  }
}

/** Parse raw stream events into renderable blocks */
export function parseEvents(events: StreamEvent[], startIdx = 0): TerminalBlock[] {
  const blocks: TerminalBlock[] = [];
  let idx = startIdx;

  for (let i = startIdx; i < events.length; i++) {
    const event = events[i];
    const id = `evt-${idx++}`;

    switch (event.type) {
      case "system": {
        if (event.subtype === "init") {
          const model = String(event.model || "");
          const sid = String(event.session_id || "").slice(0, 8);
          const tools = (event.tools as string[] | undefined)?.length;
          const mcpServers = (event.mcp_servers as string[] | undefined)?.length;
          let info = `Session ${sid} \u00B7 ${model}`;
          if (tools) info += ` \u00B7 ${tools} tools`;
          if (mcpServers) info += ` \u00B7 ${mcpServers} MCP servers`;
          blocks.push({
            id,
            kind: "system",
            content: info,
          });
        } else if (event.subtype === "command_output") {
          blocks.push({
            id,
            kind: "system",
            content: String(event.text || ""),
            meta: { isCommandOutput: true },
          });
        } else if (event.subtype === "watchdog") {
          blocks.push({
            id,
            kind: "system",
            content: String(event.message || ""),
            meta: { isWatchdog: true },
          });
        } else if (event.subtype === "paused" || event.subtype === "resumed") {
          blocks.push({
            id,
            kind: "system",
            content: String(event.message || ""),
            meta: { isWatchdog: true },
          });
        }
        break;
      }

      case "user_prompt": {
        blocks.push({ id, kind: "user_prompt", content: String(event.text || "") });
        break;
      }

      case "assistant": {
        const msg = event.message as
          | {
              content?: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
            }
          | undefined;
        if (!msg?.content) break;

        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            blocks.push({ id: `${id}-text`, kind: "text", content: block.text });
          } else if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown> | undefined;
            blocks.push({
              id: `${id}-tool-${block.id || block.name}`,
              kind: "tool_use",
              content: input ? formatToolInput(String(block.name || ""), input) : "",
              meta: { name: block.name, input },
            });
          }
        }
        break;
      }

      case "user": {
        const msg = event.message as
          | {
              content?: Array<{ type: string; content?: string; tool_use_id?: string; is_error?: boolean }>;
            }
          | undefined;
        if (!msg?.content) break;

        for (const block of msg.content) {
          if (block.type === "tool_result") {
            blocks.push({
              id: `${id}-result-${block.tool_use_id}`,
              kind: "tool_result",
              content: typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2),
              meta: { is_error: block.is_error },
            });
          }
        }
        break;
      }

      case "result": {
        blocks.push({
          id,
          kind: "result",
          content: String(event.result || ""),
          meta: {
            total_cost_usd: event.total_cost_usd,
            duration_ms: event.duration_ms,
            num_turns: event.num_turns,
          },
        });
        break;
      }

      case "stderr":
        blocks.push({ id, kind: "error", content: String(event.text || "") });
        break;

      case "done":
        // Only show if non-zero exit
        if (event.exitCode && event.exitCode !== 0) {
          blocks.push({ id, kind: "error", content: `Process exited (${event.exitCode})` });
        }
        break;

      case "destroyed":
        blocks.push({ id, kind: "error", content: "Agent destroyed" });
        break;

      default:
        // Skip noisy events, only show if they have meaningful content
        break;
    }
  }

  return blocks;
}

/**
 * Remove trailing text blocks that duplicate a result block's content.
 * Claude emits an "assistant" event (rendered as white text) followed by a
 * "result" event (rendered as green) containing the same response text.
 * This function removes the white text blocks so the response only appears
 * once, in green.
 */
export function deduplicateResultBlocks(blocks: TerminalBlock[]): TerminalBlock[] {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind !== "result" || !blocks[i].content) continue;

    const resultText = blocks[i].content;
    // Walk backwards from just before this result to find contiguous text blocks
    let j = i - 1;
    while (j >= 0 && blocks[j].kind === "text") {
      j--;
    }
    const textStart = j + 1;
    if (textStart >= i) continue; // no text blocks before this result

    const trailingText = blocks
      .slice(textStart, i)
      .map((b) => b.content)
      .join("");
    if (resultText === trailingText || resultText.trim() === trailingText.trim()) {
      // Remove the duplicate text blocks
      blocks.splice(textStart, i - textStart);
      // Adjust index since we removed elements
      i = textStart;
    }
  }
  return blocks;
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return String(input.command || "").slice(0, 120);
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path || "");
    case "Glob":
    case "Grep":
      return String(input.pattern || "");
    case "WebFetch":
      return String(input.url || "");
    case "WebSearch":
      return String(input.query || "");
    case "Task":
      return String(input.description || "").slice(0, 80);
    default: {
      const keys = Object.keys(input);
      if (keys.length === 0) return "";
      const first = input[keys[0]];
      return typeof first === "string" ? first.slice(0, 80) : keys.join(", ");
    }
  }
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" && input.command) return String(input.command);
  if (toolName === "Write" && input.content) {
    const content = String(input.content);
    return content.length > 200 ? `${content.slice(0, 200)}\u2026` : content;
  }
  if (toolName === "Edit") {
    const old_s = input.old_string ? String(input.old_string).slice(0, 100) : "";
    const new_s = input.new_string ? String(input.new_string).slice(0, 100) : "";
    if (old_s || new_s) return `- ${old_s}\n+ ${new_s}`;
  }
  return "";
}
