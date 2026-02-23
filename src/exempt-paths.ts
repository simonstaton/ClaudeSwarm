/**
 * Paths that bypass auth and (where applicable) kill-switch and recovery blocking.
 * Single source of truth so server and auth stay in sync when adding exempt routes.
 */

/** Paths that do not require authentication (authMiddleware skips these). */
export const PATHS_SKIP_AUTH = ["/api/health", "/api/auth/token"] as const;

/**
 * Paths that remain reachable when kill-switch is active or server is recovering.
 * Includes PATHS_SKIP_AUTH plus /api/kill-switch (so it can be used to deactivate).
 */
export const PATHS_EXEMPT_FROM_KILL_AND_RECOVERY = ["/api/kill-switch", ...PATHS_SKIP_AUTH] as const;

export function isExemptFromAuth(path: string): boolean {
  return PATHS_SKIP_AUTH.some((p) => path === p || path.startsWith(`${p}/`));
}

export function isExemptFromKillAndRecovery(path: string): boolean {
  return PATHS_EXEMPT_FROM_KILL_AND_RECOVERY.some((p) => path === p || path.startsWith(`${p}/`));
}
