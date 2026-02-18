import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, AgentStatus } from "./types";
import { errorMessage } from "./types";

const PERSISTENT_BASE = "/persistent";
const PERSISTENT_AVAILABLE = existsSync(PERSISTENT_BASE);

const STATE_DIR = PERSISTENT_AVAILABLE ? `${PERSISTENT_BASE}/agent-state` : "/tmp/agent-state";
export const EVENTS_DIR = PERSISTENT_AVAILABLE ? `${PERSISTENT_BASE}/agent-events` : "/tmp/agent-events";

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(EVENTS_DIR, { recursive: true });

// Debounce: only save immediately on meaningful status changes; otherwise coalesce
const SAVE_DEBOUNCE_MS = 500;
const MEANINGFUL_STATUSES: Set<AgentStatus> = new Set(["idle", "running", "error"]);
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
const lastSavedStatus = new Map<string, AgentStatus>();

async function writeAgentState(agent: Agent): Promise<void> {
  try {
    const filePath = path.join(STATE_DIR, `${agent.id}.json`);
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(agent), "utf-8");
    await rename(tmpPath, filePath);
  } catch (err: unknown) {
    console.warn(`[persistence] Failed to save agent ${agent.id}:`, errorMessage(err));
  }
}

export function saveAgentState(agent: Agent): void {
  const isStatusChange = MEANINGFUL_STATUSES.has(agent.status) && lastSavedStatus.get(agent.id) !== agent.status;

  if (isStatusChange) {
    // Meaningful status change — save immediately, cancel any pending debounce
    const pending = pendingSaves.get(agent.id);
    if (pending) {
      clearTimeout(pending);
      pendingSaves.delete(agent.id);
    }
    lastSavedStatus.set(agent.id, agent.status);
    writeAgentState(agent);
    return;
  }

  // Non-critical update — debounce
  const existing = pendingSaves.get(agent.id);
  if (existing) clearTimeout(existing);
  pendingSaves.set(
    agent.id,
    setTimeout(() => {
      pendingSaves.delete(agent.id);
      lastSavedStatus.set(agent.id, agent.status);
      writeAgentState(agent);
    }, SAVE_DEBOUNCE_MS),
  );
}

export function loadAllAgentStates(): Agent[] {
  // If a kill-switch tombstone exists, skip all restoration
  if (existsSync(TOMBSTONE_FILE)) {
    console.log("[persistence] Kill switch tombstone found — skipping agent restoration");
    return [];
  }
  const agents: Agent[] = [];
  try {
    const files = readdirSync(STATE_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp") && !f.startsWith("_"));
    for (const file of files) {
      try {
        const data = readFileSync(path.join(STATE_DIR, file), "utf-8");
        if (!data.trim()) {
          // Empty file — leftover from a failed FUSE delete, clean it up
          console.warn(`[persistence] Removing empty state file: ${file}`);
          unlinkSync(path.join(STATE_DIR, file));
          continue;
        }
        const agent = JSON.parse(data) as Agent;
        if (!agent.id) {
          console.warn(`[persistence] Skipping invalid state file (no id): ${file}`);
          continue;
        }
        agents.push(agent);
      } catch (err: unknown) {
        console.warn(`[persistence] Failed to load ${file}:`, errorMessage(err));
      }
    }
  } catch (err: unknown) {
    console.warn("[persistence] Failed to read state directory:", errorMessage(err));
  }
  return agents;
}

/**
 * Clean up stale state between container restarts:
 * 1. Remove .tmp files left by partial saves
 * 2. Remove orphaned event files with no matching agent state
 */
export function cleanupStaleState(): void {
  let cleanedTmp = 0;
  let cleanedEvents = 0;

  // 1. Remove stale .tmp files in state directory
  try {
    const tmpFiles = readdirSync(STATE_DIR).filter((f) => f.endsWith(".tmp"));
    for (const file of tmpFiles) {
      try {
        unlinkSync(path.join(STATE_DIR, file));
        cleanedTmp++;
      } catch {}
    }
  } catch {}

  // 2. Remove orphaned event files (events exist but no matching agent state)
  try {
    const stateIds = new Set(
      readdirSync(STATE_DIR)
        .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
        .map((f) => f.replace(".json", "")),
    );
    const eventFiles = readdirSync(EVENTS_DIR).filter((f) => f.endsWith(".jsonl"));
    for (const file of eventFiles) {
      const id = file.replace(".jsonl", "");
      if (!stateIds.has(id)) {
        try {
          unlinkSync(path.join(EVENTS_DIR, file));
          cleanedEvents++;
        } catch {}
      }
    }
  } catch {}

  if (cleanedTmp > 0 || cleanedEvents > 0) {
    console.log(`[cleanup] Removed ${cleanedTmp} stale .tmp file(s), ${cleanedEvents} orphaned event file(s)`);
  }
}

const TOMBSTONE_FILE = path.join(STATE_DIR, "_kill-switch-tombstone");

/**
 * Write a tombstone file so loadAllAgentStates() skips all restoration on next
 * startup, even if individual state file deletes failed (e.g. GCS FUSE delay).
 */
export function writeTombstone(): void {
  try {
    writeFileSync(TOMBSTONE_FILE, JSON.stringify({ killedAt: new Date().toISOString() }), "utf-8");
    console.log("[persistence] Kill switch tombstone written");
  } catch (err: unknown) {
    console.warn("[persistence] Failed to write tombstone:", errorMessage(err));
  }
}

/** Check if a kill-switch tombstone exists (called on startup before restoring agents). */
export function hasTombstone(): boolean {
  return existsSync(TOMBSTONE_FILE);
}

/** Remove the tombstone (called on kill-switch deactivation). */
export function clearTombstone(): void {
  try {
    if (existsSync(TOMBSTONE_FILE)) unlinkSync(TOMBSTONE_FILE);
  } catch { /* best-effort */ }
}

export function removeAgentState(id: string): void {
  const filePath = path.join(STATE_DIR, `${id}.json`);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (err: unknown) {
    console.warn(`[persistence] Failed to remove state for ${id}:`, errorMessage(err));
  }
  // Also remove the .tmp file if it exists (e.g., from a partial save)
  try {
    const tmpPath = `${filePath}.tmp`;
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }
  } catch {}

  // Verify deletion — on GCS FUSE, unlinkSync can silently fail to propagate.
  // If the file still exists after deletion, overwrite it with an empty/tombstone
  // marker that loadAllAgentStates will skip, then retry unlink.
  try {
    if (existsSync(filePath)) {
      console.warn(`[persistence] State file for ${id} still exists after unlink, retrying...`);
      // Overwrite with empty content first (GCS FUSE handles overwrites more reliably than deletes)
      writeFileSync(filePath, "", "utf-8");
      unlinkSync(filePath);
    }
  } catch (err: unknown) {
    console.error(`[persistence] CRITICAL: Could not remove state file for ${id}:`, errorMessage(err));
  }
}
