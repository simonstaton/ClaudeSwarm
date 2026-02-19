import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "./types";

const execFileAsync = promisify(execFile);
const PERSISTENT_REPOS = "/persistent/repos";

async function repoExists(): Promise<string[] | null> {
  try {
    const entries = await readdir(PERSISTENT_REPOS);
    return entries.filter((f) => f.endsWith(".git"));
  } catch {
    return null;
  }
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf-8", timeout: 10_000 });
  return stdout;
}

/**
 * Clean up git worktrees owned by a specific agent workspace.
 * Worktrees created by agents live under /tmp/workspace-{uuid}/ and reference
 * bare repos in /persistent/repos/*.git. When an agent is destroyed we need to
 * both `git worktree remove` them (so the bare repo's worktree list stays clean)
 * and delete the on-disk directory.
 */
export async function cleanupWorktreesForWorkspace(workspaceDir: string): Promise<void> {
  const bareRepos = await repoExists();
  if (!bareRepos) return;

  for (const repo of bareRepos) {
    const repoPath = path.join(PERSISTENT_REPOS, repo);
    try {
      await git(["-C", repoPath, "worktree", "prune"]);

      const output = await git(["-C", repoPath, "worktree", "list", "--porcelain"]);

      for (const block of output.split("\n\n")) {
        const wtLine = block.split("\n").find((l) => l.startsWith("worktree "));
        if (!wtLine) continue;
        const wtPath = wtLine.replace("worktree ", "");
        if (wtPath.startsWith(workspaceDir)) {
          try {
            await git(["-C", repoPath, "worktree", "remove", "--force", wtPath]);
          } catch {
            // If git worktree remove fails, prune will catch it later
          }
        }
      }

      await git(["-C", repoPath, "worktree", "prune"]);
    } catch {
      // repo may not be a valid git repo — skip
    }
  }
}

/**
 * Prune all stale worktrees across every bare repo in /persistent/repos/.
 * A worktree is stale when its working directory no longer exists on disk —
 * which happens when an agent's /tmp/workspace-{uuid} is cleaned up (either by
 * destroy, container restart, or OS tmpdir cleanup).
 *
 * Also detects and removes worktrees pointing at workspace dirs that have no
 * corresponding running agent (orphaned worktrees from crashed/killed agents).
 */
export async function pruneAllWorktrees(
  activeWorkspaceDirs?: Set<string>,
): Promise<{ pruned: number; errors: string[] }> {
  const result = { pruned: 0, errors: [] as string[] };
  const bareRepos = await repoExists();
  if (!bareRepos) return result;

  for (const repo of bareRepos) {
    const repoPath = path.join(PERSISTENT_REPOS, repo);
    try {
      await git(["-C", repoPath, "worktree", "prune"]);

      if (activeWorkspaceDirs) {
        const output = await git(["-C", repoPath, "worktree", "list", "--porcelain"]);

        for (const block of output.split("\n\n")) {
          const wtLine = block.split("\n").find((l) => l.startsWith("worktree "));
          if (!wtLine) continue;
          const wtPath = wtLine.replace("worktree ", "");

          if (wtPath === repoPath) continue;

          const wsMatch = wtPath.match(/^(\/tmp\/workspace-[a-f0-9-]+)/);
          if (wsMatch && !activeWorkspaceDirs.has(wsMatch[1])) {
            try {
              await git(["-C", repoPath, "worktree", "remove", "--force", wtPath]);
              result.pruned++;
              console.log(`[worktree] Pruned orphaned worktree: ${wtPath} (repo: ${repo})`);
            } catch (err: unknown) {
              result.errors.push(`Failed to remove ${wtPath}: ${errorMessage(err)}`);
            }
          }
        }
      }

      await git(["-C", repoPath, "worktree", "prune"]);
    } catch (err: unknown) {
      result.errors.push(`${repo}: ${errorMessage(err)}`);
    }
  }

  return result;
}

/**
 * Run a full worktree garbage collection. Intended to be called:
 * 1. On server startup (entrypoint.sh or server.ts init)
 * 2. Periodically (every 10 minutes) while the server is running
 * 3. On agent destroy (targeted cleanup)
 */
export function startWorktreeGC(getActiveWorkspaceDirs: () => Set<string>): ReturnType<typeof setInterval> {
  pruneAllWorktrees(getActiveWorkspaceDirs())
    .then((initial) => {
      if (initial.pruned > 0) {
        console.log(`[worktree] Startup GC: pruned ${initial.pruned} stale worktrees`);
      }
    })
    .catch((err) => {
      console.error("[worktree] Startup GC error:", err);
    });

  return setInterval(
    () => {
      pruneAllWorktrees(getActiveWorkspaceDirs())
        .then((result) => {
          if (result.pruned > 0) {
            console.log(`[worktree] Periodic GC: pruned ${result.pruned} stale worktrees`);
          }
        })
        .catch((err) => {
          console.error("[worktree] GC error:", err);
        });
    },
    10 * 60 * 1000,
  );
}
