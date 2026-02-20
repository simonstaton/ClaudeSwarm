import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { errorMessage } from "./types";

/** Persistent paths for dependency caches. */
export const DEP_CACHE_PATHS = {
  /** npm cache directory - shared across all agents */
  npmCache: "/persistent/npm-cache",
  /** pnpm content-addressable store - shared across all agents */
  pnpmStore: "/persistent/pnpm-store",
} as const;

/** Whether the dependency cache has been warmed (pnpm store initialized). */
let cacheReady = false;
/** Listeners waiting for cache readiness. */
const readyListeners: Array<() => void> = [];

/** Returns true if the persistent cache infrastructure is available. */
export function hasPersistentCache(): boolean {
  return existsSync("/persistent");
}

/** Returns true if the cache pre-warm has completed. */
export function isCacheReady(): boolean {
  return cacheReady;
}

/** Wait for the cache to become ready (resolves immediately if already ready).
 *  Currently unused since initDepCache() is synchronous, but exported for future
 *  async warm-up scenarios (e.g. pre-populating packages from a manifest). */
export function waitForCache(): Promise<void> {
  if (cacheReady) return Promise.resolve();
  return new Promise<void>((resolve) => {
    readyListeners.push(resolve);
  });
}

/** Signal that the cache is ready and notify all waiting listeners. */
function signalReady(): void {
  cacheReady = true;
  for (const listener of readyListeners) {
    listener();
  }
  readyListeners.length = 0;
}

/**
 * Initialize dependency cache directories and configure pnpm.
 * Called once on server startup. Creates persistent cache directories
 * and configures pnpm to use a shared content-addressable store.
 *
 * This runs synchronously and quickly - it only creates directories
 * and sets pnpm config. The actual cache population happens as agents
 * run npm/pnpm install.
 */
export function initDepCache(): void {
  if (!hasPersistentCache()) {
    console.log("[dep-cache] No persistent storage - cache disabled, agents will use local installs");
    signalReady();
    return;
  }

  try {
    // Ensure cache directories exist
    mkdirSync(DEP_CACHE_PATHS.npmCache, { recursive: true });
    mkdirSync(DEP_CACHE_PATHS.pnpmStore, { recursive: true });

    // Configure pnpm to use the persistent shared store.
    // This sets the global pnpm config so all pnpm commands in any workspace
    // use the same content-addressable store on persistent storage.
    try {
      execFileSync("pnpm", ["config", "set", "store-dir", DEP_CACHE_PATHS.pnpmStore, "--global"], {
        timeout: 10_000,
        stdio: "pipe",
      });
      console.log(`[dep-cache] pnpm store configured at ${DEP_CACHE_PATHS.pnpmStore}`);
    } catch (err: unknown) {
      // pnpm may not be installed in dev - that's OK, npm cache still works
      console.warn("[dep-cache] Failed to configure pnpm store (pnpm may not be installed):", errorMessage(err));
    }

    console.log("[dep-cache] Cache directories initialized");
    console.log(`[dep-cache]   npm cache:   ${DEP_CACHE_PATHS.npmCache}`);
    console.log(`[dep-cache]   pnpm store:  ${DEP_CACHE_PATHS.pnpmStore}`);
  } catch (err: unknown) {
    console.warn("[dep-cache] Failed to initialize cache directories:", errorMessage(err));
  }

  signalReady();
}

/**
 * Build environment variables for an agent process that enable dependency caching.
 * These are merged into the agent's env by WorkspaceManager.buildEnv().
 */
export function getDepCacheEnv(): Record<string, string> {
  if (!hasPersistentCache()) return {};

  const env: Record<string, string> = {};

  // npm: point cache to persistent storage
  if (existsSync(DEP_CACHE_PATHS.npmCache)) {
    env.npm_config_cache = DEP_CACHE_PATHS.npmCache;
  }

  // pnpm: point store to persistent content-addressable storage
  if (existsSync(DEP_CACHE_PATHS.pnpmStore)) {
    env.npm_config_store_dir = DEP_CACHE_PATHS.pnpmStore;
  }

  return env;
}
