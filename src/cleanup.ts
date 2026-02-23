/**
 * Startup and runtime cleanup: orphaned processes, stale workspaces, and
 * obsolete files. Used by server.ts during recovery so the composition root
 * stays thin and cleanup logic is easy to find and test.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentManager } from "./agents";
import { logger } from "./logger";
import { getContextDir } from "./utils/context";

/**
 * Kill orphaned `claude` processes left over from a previous container run.
 * After a non-graceful restart, child processes may still be running under
 * the same PID namespace (Cloud Run reuses the sandbox). We kill any `claude`
 * processes that aren't children of the current server process.
 */
export function cleanupOrphanedProcesses(): void {
  try {
    const myPid = process.pid;
    const output = execFileSync("ps", ["-eo", "pid,ppid,comm"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    let killed = 0;
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const [, pidStr, ppidStr, comm] = match;
      const pid = Number.parseInt(pidStr, 10);
      const ppid = Number.parseInt(ppidStr, 10);
      if (comm.trim() === "claude" && ppid !== myPid && pid !== myPid) {
        try {
          process.kill(pid, "SIGTERM");
          killed++;
        } catch (err: unknown) {
          logger.debug("[cleanup] Process already exited or not killable", { pid, error: String(err) });
        }
      }
    }
    if (killed > 0) {
      logger.info(`[cleanup] Killed ${killed} orphaned claude process(es)`);
    }
  } catch (err: unknown) {
    logger.debug("[cleanup] Could not list/kill orphaned processes", { error: String(err) });
  }
}

/**
 * Remove stale /tmp/workspace-* directories that don't belong to any restored
 * agent, and remove obsolete working-memory-*.md files from shared context.
 */
export function cleanupStaleWorkspaces(manager: AgentManager): void {
  try {
    const activeWorkspaces = manager.getActiveWorkspaceDirs();
    const entries = fs.readdirSync("/tmp").filter((f) => f.startsWith("workspace-"));
    let cleaned = 0;
    for (const entry of entries) {
      const fullPath = `/tmp/${entry}`;
      if (!activeWorkspaces.has(fullPath)) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          cleaned++;
        } catch (err: unknown) {
          logger.debug("[cleanup] Could not remove stale workspace", { path: fullPath, error: String(err) });
        }
      }
    }
    if (cleaned > 0) {
      logger.info(`[cleanup] Removed ${cleaned} stale workspace director${cleaned === 1 ? "y" : "ies"}`);
    }
  } catch (err: unknown) {
    logger.debug("[cleanup] Could not read /tmp for workspace cleanup", { error: String(err) });
  }

  try {
    const contextDir = getContextDir();
    const wmFiles = fs.readdirSync(contextDir).filter((f) => f.startsWith("working-memory-") && f.endsWith(".md"));
    for (const file of wmFiles) {
      try {
        fs.unlinkSync(path.join(contextDir, file));
      } catch (err: unknown) {
        logger.debug("[cleanup] Could not remove working-memory file", { file, error: String(err) });
      }
    }
    if (wmFiles.length > 0) {
      logger.info(`[cleanup] Removed ${wmFiles.length} stale working-memory file(s)`);
    }
  } catch (err: unknown) {
    logger.debug("[cleanup] Could not read shared-context for working-memory cleanup", { error: String(err) });
  }
}
