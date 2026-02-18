/**
 * Kill Switch — Layer 1 of the defense-in-depth emergency stop.
 *
 * State file is stored at /tmp/platform/kill-switch.json — NOT in shared-context
 * or /persistent, both of which are agent-accessible. The /tmp/platform/ directory
 * is not symlinked into any agent workspace.
 *
 * On activation:
 *   - Sets in-memory flag (fast path for all requests)
 *   - Writes local file (survives process restarts within same container)
 *   - Uploads to GCS via Storage API (not FUSE) for cross-container persistence
 *
 * Remote activation: upload kill-switch.json to GCS at platform/kill-switch.json.
 *   echo '{"killed":true,"reason":"emergency"}' | gsutil cp - gs://BUCKET/platform/kill-switch.json
 *
 * The server polls GCS every 10 seconds via startGcsKillSwitchPoll().
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { errorMessage } from "./types";

const PLATFORM_DIR = "/tmp/platform";
const KILL_SWITCH_FILE = path.join(PLATFORM_DIR, "kill-switch.json");
const GCS_BUCKET = process.env.GCS_BUCKET;
const GCS_PATH = "platform/kill-switch.json";

export interface KillSwitchState {
  killed: boolean;
  reason?: string;
  activatedAt?: string;
}

// In-memory flag — fast path, no disk I/O on the hot path
let inMemoryState: KillSwitchState = { killed: false };
// biome-ignore lint/suspicious/noExplicitAny: GCS Storage is dynamically imported
let gcsStorage: any = null;

async function getStorage() {
  if (!GCS_BUCKET) return null;
  if (gcsStorage) return gcsStorage;
  try {
    const { Storage } = await import("@google-cloud/storage");
    gcsStorage = new Storage();
    return gcsStorage;
  } catch {
    return null;
  }
}

/** Ensure /tmp/platform/ exists and is not accessible via agent workspace symlinks. */
function ensurePlatformDir(): void {
  mkdirSync(PLATFORM_DIR, { recursive: true });
}

/** Read the local kill switch file (if it exists). */
function readLocalState(): KillSwitchState | null {
  try {
    if (!existsSync(KILL_SWITCH_FILE)) return null;
    const data = readFileSync(KILL_SWITCH_FILE, "utf-8");
    return JSON.parse(data) as KillSwitchState;
  } catch {
    return null;
  }
}

/** Write kill switch state to the local file. */
function writeLocalState(state: KillSwitchState): void {
  ensurePlatformDir();
  writeFileSync(KILL_SWITCH_FILE, JSON.stringify(state), "utf-8");
}

/** Remove the local kill switch file. */
function clearLocalState(): void {
  try {
    if (existsSync(KILL_SWITCH_FILE)) {
      unlinkSync(KILL_SWITCH_FILE);
    }
  } catch {
    // Best-effort
  }
}

/** Upload kill switch state to GCS via Storage API (not FUSE). */
async function uploadToGcs(state: KillSwitchState): Promise<void> {
  const gcs = await getStorage();
  if (!gcs || !GCS_BUCKET) return;
  try {
    const bucket = gcs.bucket(GCS_BUCKET);
    await bucket.file(GCS_PATH).save(JSON.stringify(state), { contentType: "application/json" });
    console.log("[kill-switch] Uploaded state to GCS");
  } catch (err: unknown) {
    console.warn("[kill-switch] Failed to upload to GCS:", errorMessage(err));
  }
}

/** Delete kill switch file from GCS. */
async function deleteFromGcs(): Promise<void> {
  const gcs = await getStorage();
  if (!gcs || !GCS_BUCKET) return;
  try {
    const bucket = gcs.bucket(GCS_BUCKET);
    const [exists] = await bucket.file(GCS_PATH).exists();
    if (exists) {
      await bucket.file(GCS_PATH).delete();
      console.log("[kill-switch] Removed GCS kill switch file");
    }
  } catch (err: unknown) {
    console.warn("[kill-switch] Failed to delete from GCS:", errorMessage(err));
  }
}

/** Check GCS for a remote kill switch file (called by the 10s poll). */
async function checkGcsState(): Promise<KillSwitchState | null> {
  const gcs = await getStorage();
  if (!gcs || !GCS_BUCKET) return null;
  try {
    const bucket = gcs.bucket(GCS_BUCKET);
    const [exists] = await bucket.file(GCS_PATH).exists();
    if (!exists) return null;
    const [contents] = await bucket.file(GCS_PATH).download();
    return JSON.parse(contents.toString()) as KillSwitchState;
  } catch {
    return null;
  }
}

/**
 * Check if the kill switch is currently active.
 * Fast in-memory check — no disk I/O.
 */
export function isKilled(): boolean {
  return inMemoryState.killed;
}

/** Get the current kill switch state (for API responses). */
export function getKillSwitchState(): KillSwitchState {
  return { ...inMemoryState };
}

/**
 * Activate the kill switch.
 * Sets in-memory flag, writes local file, uploads to GCS.
 */
export async function activate(reason?: string): Promise<void> {
  const state: KillSwitchState = {
    killed: true,
    reason: reason || "Kill switch activated",
    activatedAt: new Date().toISOString(),
  };
  inMemoryState = state;
  writeLocalState(state);
  console.log(`[kill-switch] ACTIVATED — reason: ${state.reason}`);
  await uploadToGcs(state);
}

/**
 * Deactivate the kill switch.
 * Clears in-memory flag, removes local file, removes from GCS.
 */
export async function deactivate(): Promise<void> {
  inMemoryState = { killed: false };
  clearLocalState();
  console.log("[kill-switch] Deactivated");
  await deleteFromGcs();
}

/**
 * Load persisted kill switch state on startup.
 * Checks local file first, then GCS if no local file found.
 * Returns true if kill switch was found active.
 */
export async function loadPersistedState(): Promise<boolean> {
  ensurePlatformDir();

  // Check local file first (fast path — same container restart)
  const local = readLocalState();
  if (local?.killed) {
    inMemoryState = local;
    console.log(`[kill-switch] Loaded persisted ACTIVE state from local file (reason: ${local.reason})`);
    return true;
  }

  // Check GCS (cross-container — remote activation via gsutil)
  const gcsState = await checkGcsState();
  if (gcsState?.killed) {
    inMemoryState = gcsState;
    // Also write locally so future restarts don't need to hit GCS
    writeLocalState(gcsState);
    console.log(`[kill-switch] Loaded ACTIVE state from GCS (reason: ${gcsState.reason})`);
    return true;
  }

  return false;
}

let gcsPollingInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start a 10-second polling loop that checks GCS for remote kill switch activation.
 * Uses the Storage API directly (not FUSE) to avoid stat cache delays.
 * Returns a cleanup function.
 */
export function startGcsKillSwitchPoll(onActivated: () => Promise<void>): () => void {
  if (!GCS_BUCKET) {
    console.log("[kill-switch] GCS_BUCKET not set, skipping GCS kill switch poll");
    return () => {};
  }

  gcsPollingInterval = setInterval(async () => {
    // Skip if already killed — no need to poll
    if (inMemoryState.killed) return;

    try {
      const gcsState = await checkGcsState();
      if (gcsState?.killed) {
        console.log(`[kill-switch] Remote activation detected via GCS (reason: ${gcsState.reason})`);
        inMemoryState = gcsState;
        writeLocalState(gcsState);
        await onActivated();
      }
    } catch {
      // Best-effort — don't crash the poll interval
    }
  }, 10_000);

  // Don't keep the process alive just for polling
  gcsPollingInterval.unref();

  console.log("[kill-switch] GCS kill switch poll started (10s interval)");

  return () => {
    if (gcsPollingInterval) {
      clearInterval(gcsPollingInterval);
      gcsPollingInterval = null;
    }
  };
}
