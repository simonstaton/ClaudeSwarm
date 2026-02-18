import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamEvent } from "../api";
import { useApi } from "./useApi";

interface PromptAttachment {
  name: string;
  type: "image" | "file";
  data: string;
  mime: string;
}

interface UseAgentStreamReturn {
  events: StreamEvent[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (prompt: string, maxTurns?: number, sessionId?: string, attachments?: PromptAttachment[]) => void;
  reconnect: () => void;
  clearEvents: () => void;
  /** Inject a local-only event (not sent to the agent) */
  injectEvent: (event: StreamEvent) => void;
}

// Maximum number of events to keep in memory to prevent unbounded growth
// Older events beyond this limit will be discarded
const MAX_EVENTS = 5000;

/**
 * Create a fingerprint for a StreamEvent to detect duplicates.
 * Uses type + subtype + content-bearing fields to identify unique events.
 * Two events with the same fingerprint are considered duplicates.
 */
function eventFingerprint(event: StreamEvent): string {
  const parts = [event.type, event.subtype ?? ""];
  switch (event.type) {
    case "result":
      parts.push(String(event.result ?? ""), String(event.duration_ms ?? ""), String(event.num_turns ?? ""));
      break;
    case "user_prompt":
      parts.push(String(event.text ?? ""));
      break;
    case "assistant":
      // Use stringified message content for assistant events
      parts.push(JSON.stringify(event.message ?? ""));
      break;
    case "system":
      parts.push(String(event.session_id ?? ""), String(event.message ?? event.text ?? ""));
      break;
    case "done":
      parts.push(String(event.exitCode ?? ""));
      break;
    default:
      parts.push(String(event.text ?? event.content ?? ""));
  }
  return parts.join("\0");
}

/** Abort and clean up all stream resources. */
function cleanupStream(
  abortRef: React.MutableRefObject<(() => void) | null>,
  retryTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  abortRef.current?.();
  abortRef.current = null;

  if (retryTimerRef.current) {
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }
}

export function useAgentStream(agentId: string | null): UseAgentStreamReturn {
  const api = useApi();
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentIdRef = useRef(agentId);
  // Generation counter: incremented on every new stream (sendMessage, reconnect,
  // agent switch). Retry callbacks compare their captured generation to the
  // current value — if they differ, another stream has taken over and the
  // retry is a stale no-op. This closes the race window between cleanupStream
  // and the new stream where a queued setTimeout could fire in between.
  const generationRef = useRef(0);
  // Track how many events have been received from the server (persisted events).
  // Used to request only new events on auto-retry reconnects, preventing
  // the full history from replaying and causing stale responses to flash.
  const serverEventCountRef = useRef(0);
  // Set of event fingerprints for deduplication. When events arrive from
  // different stream paths (reconnect vs message), the same persisted event
  // can be delivered twice. This set lets us skip duplicates.
  // Bounded to 2x MAX_EVENTS to prevent unbounded memory growth
  const seenFingerprintsRef = useRef(new Set<string>());

  // Keep agentId ref current for retry callbacks
  // When agentId changes, immediately abort streams and clear state
  useEffect(() => {
    const prevId = agentIdRef.current;
    agentIdRef.current = agentId;

    // Only clean up when the agent actually changes (not on initial mount
    // with the same id, which would race with the reconnect in AgentView)
    if (prevId !== agentId) {
      // Abort any active streams and cancel pending retries
      cleanupStream(abortRef, retryTimerRef);
      generationRef.current++;

      // Clear events to free memory immediately
      setEvents([]);
      setIsStreaming(false);
      setError(null);
      serverEventCountRef.current = 0;
      seenFingerprintsRef.current.clear();
      retryCountRef.current = 0;
    }
  }, [agentId]);

  const doReconnect = useCallback(
    (id: string, incremental = false) => {
      // Abort any previous stream before starting a new one
      cleanupStream(abortRef, retryTimerRef);
      const gen = ++generationRef.current;

      // For incremental reconnects (auto-retry), request only events after
      // what we already have to avoid replaying the full history
      const afterIndex = incremental ? serverEventCountRef.current : undefined;
      const { stream, abort } = api.reconnectStream(id, afterIndex);
      abortRef.current = abort;

      setIsStreaming(true);
      setError(null);

      if (!incremental) {
        // Full reconnect — clear existing events since the server replays full history
        setEvents([]);
        serverEventCountRef.current = 0;
        seenFingerprintsRef.current.clear();
      }

      (async () => {
        try {
          const s = await stream;
          const reader = s.getReader();
          retryCountRef.current = 0; // Reset on successful connection

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Only add events if we're still viewing this agent
            if (agentIdRef.current === id) {
              serverEventCountRef.current++;
              // Deduplicate: skip events we've already seen (can happen when
              // an incremental reconnect replays events the client received
              // through a previous message or reconnect stream)
              const fp = eventFingerprint(value);
              if (!seenFingerprintsRef.current.has(fp)) {
                seenFingerprintsRef.current.add(fp);
                // Prevent fingerprint Set from growing unbounded
                if (seenFingerprintsRef.current.size > MAX_EVENTS * 2) {
                  // Convert to array, slice, and recreate Set to remove oldest entries
                  const fps = Array.from(seenFingerprintsRef.current);
                  seenFingerprintsRef.current = new Set(fps.slice(-MAX_EVENTS));
                }
                setEvents((prev) => {
                  const updated = [...prev, value];
                  // Limit array size to prevent memory leak with long-running agents
                  return updated.length > MAX_EVENTS ? updated.slice(-MAX_EVENTS) : updated;
                });
              }
            } else {
              // Agent switched — cancel the reader which propagates to the
              // underlying fetch body, closing the server-side SSE connection
              // and removing the listener from agentProc.listeners
              abort();
              reader.cancel();
              break;
            }
          }
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === "AbortError") return;

          // Auto-retry with exponential backoff (max 30s)
          // Uses incremental mode to avoid clearing the display
          const delay = Math.min(1000 * 2 ** retryCountRef.current, 30_000);
          retryCountRef.current++;

          if (retryCountRef.current <= 8) {
            retryTimerRef.current = setTimeout(() => {
              // Only proceed if no newer stream has been started (generation
              // unchanged) and the user is still viewing this agent.
              if (generationRef.current === gen && agentIdRef.current === id) {
                doReconnect(id, true);
              }
            }, delay);
          } else {
            setError("Connection lost — click Reconnect to retry");
          }
        } finally {
          setIsStreaming(false);
        }
      })();
    },
    [api],
  );

  const consumeStream = useCallback(
    async (streamPromise: Promise<ReadableStream<StreamEvent>>, agentId: string, abort: () => void) => {
      setIsStreaming(true);
      setError(null);

      try {
        const stream = await streamPromise;
        const reader = stream.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Only add events if we're still viewing this agent
          if (agentIdRef.current === agentId) {
            // Track server events so auto-retry reconnects can skip them
            serverEventCountRef.current++;
            // Deduplicate: skip events already in the terminal (can happen
            // when a reconnect replays events the message stream already
            // delivered, or vice versa)
            const fp = eventFingerprint(value);
            if (!seenFingerprintsRef.current.has(fp)) {
              seenFingerprintsRef.current.add(fp);
              // Prevent fingerprint Set from growing unbounded
              if (seenFingerprintsRef.current.size > MAX_EVENTS * 2) {
                // Convert to array, slice, and recreate Set to remove oldest entries
                const fps = Array.from(seenFingerprintsRef.current);
                seenFingerprintsRef.current = new Set(fps.slice(-MAX_EVENTS));
              }
              setEvents((prev) => {
                const updated = [...prev, value];
                // Limit array size to prevent memory leak with long-running agents
                return updated.length > MAX_EVENTS ? updated.slice(-MAX_EVENTS) : updated;
              });
            }
          } else {
            // Agent switched — abort the fetch to close the server-side SSE
            // connection and free the listener from agentProc.listeners
            abort();
            reader.cancel();
            break;
          }
        }
      } catch (err: unknown) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : "Stream error");
          // Don't auto-reconnect after a message stream error.
          // Reconnecting replays ALL historical events from the server,
          // which duplicates content already in the events array.
          // The user can manually reconnect if needed.
        }
      } finally {
        setIsStreaming(false);
      }
    },
    [],
  );

  const sendMessage = useCallback(
    (prompt: string, maxTurns?: number, sessionId?: string, attachments?: PromptAttachment[]) => {
      if (!agentId) return;

      // Abort previous stream and cancel pending retries
      cleanupStream(abortRef, retryTimerRef);
      generationRef.current++;
      retryCountRef.current = 0;

      // Don't inject a synthetic user_prompt — the server now persists one,
      // and the message stream will deliver it. Injecting here would create
      // a duplicate if the user later reconnects.
      // Instead, we rely on the server-side user_prompt event.

      const { stream, abort } = api.messageAgentStream(agentId, prompt, maxTurns, sessionId, attachments);
      abortRef.current = abort;
      consumeStream(stream, agentId, abort);
    },
    [agentId, consumeStream, api],
  );

  const reconnect = useCallback(() => {
    if (!agentId) return;

    retryCountRef.current = 0;
    doReconnect(agentId); // doReconnect bumps generation internally
  }, [agentId, doReconnect]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setError(null);
    seenFingerprintsRef.current.clear();
  }, []);

  const injectEvent = useCallback((event: StreamEvent) => {
    setEvents((prev) => {
      const updated = [...prev, event];
      // Limit array size to prevent memory leak
      return updated.length > MAX_EVENTS ? updated.slice(-MAX_EVENTS) : updated;
    });
  }, []);

  // Cleanup on unmount — abort all active streams and timers
  useEffect(() => {
    return () => {
      cleanupStream(abortRef, retryTimerRef);
    };
  }, []);

  return { events, isStreaming, error, sendMessage, reconnect, clearEvents, injectEvent };
}
