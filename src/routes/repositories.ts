import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express, { type Request, type Response } from "express";
import type { AgentManager } from "../agents";
import { requireHumanUser } from "../auth";
import { logger } from "../logger";
import { PERSISTENT_REPOS } from "../paths";
import { getGitHubTokenForClone, hasRepoPat, setRepoPat } from "../secrets-store";
import { errorMessage } from "../types";

const execFileAsync = promisify(execFile);

/** Set of targetDirs currently being cloned - prevents concurrent duplicate clones. */
const cloningInProgress = new Set<string>();

/** Extract and sanitize a repository name from an HTTPS or SSH git URL. */
function extractRepoName(url: string): string | null {
  // HTTPS: https://github.com/org/repo.git or https://github.com/org/repo
  // SSH:   git@github.com:org/repo.git
  const match = url.match(/\/([^/]+?)(?:\.git)?\s*$/) || url.match(/:([^/]+?)(?:\.git)?\s*$/);
  if (!match) return null;
  // Strip characters that are unsafe in directory names
  const sanitized = match[1].replace(/[^a-zA-Z0-9._-]/g, "");
  return sanitized || null;
}

/** Validate that a string looks like a git remote URL (HTTPS or SSH). */
function isValidGitUrl(url: string): boolean {
  // HTTPS
  if (/^https?:\/\/.+\/.+/.test(url)) return true;
  // SSH
  if (/^[\w.-]+@[\w.-]+:.+/.test(url)) return true;
  return false;
}

/** Get the remote origin URL for a bare repo. */
async function getRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "config", "--get", "remote.origin.url"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Check if any active agent has a worktree linked to this repo. */
async function getActiveAgentsForRepo(
  repoPath: string,
  agentManager: AgentManager,
): Promise<Array<{ id: string; name: string }>> {
  const activeAgents: Array<{ id: string; name: string }> = [];
  const activeWorkspaceDirs = agentManager.getActiveWorkspaceDirs();
  if (activeWorkspaceDirs.size === 0) return activeAgents;

  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
      encoding: "utf-8",
      timeout: 10_000,
    });

    const agents = agentManager.list();
    for (const block of stdout.split("\n\n")) {
      const wtLine = block.split("\n").find((l) => l.startsWith("worktree "));
      if (!wtLine) continue;
      const wtPath = wtLine.replace("worktree ", "");
      // Skip the bare repo itself
      if (wtPath === repoPath) continue;

      // Check if this worktree belongs to an active agent workspace
      const wsMatch = wtPath.match(/^(\/tmp\/workspace-[a-f0-9-]+)/);
      if (wsMatch && activeWorkspaceDirs.has(wsMatch[1])) {
        const agent = agents.find((a) => a.workspaceDir === wsMatch[1]);
        if (agent) {
          activeAgents.push({ id: agent.id, name: agent.name });
        }
      }
    }
  } catch {
    // git worktree list may fail if repo is empty/invalid
  }

  return activeAgents;
}

export function createRepositoriesRouter(agentManager: AgentManager) {
  const router = express.Router();

  // List all persistent repositories
  router.get("/api/repositories", async (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(PERSISTENT_REPOS)) {
        res.json({ repositories: [] });
        return;
      }

      const entries = fs
        .readdirSync(PERSISTENT_REPOS)
        .filter((f) => f.endsWith(".git") && fs.statSync(path.join(PERSISTENT_REPOS, f)).isDirectory());
      const repositories = await Promise.all(
        entries.map(async (entry) => {
          const repoPath = path.join(PERSISTENT_REPOS, entry);
          const name = entry.replace(/\.git$/, "");
          const url = await getRemoteUrl(repoPath);
          const activeAgents = await getActiveAgentsForRepo(repoPath, agentManager);
          return {
            name,
            dirName: entry,
            url,
            patConfigured: hasRepoPat(name),
            hasActiveAgents: activeAgents.length > 0,
            activeAgentCount: activeAgents.length,
            activeAgents,
          };
        }),
      );

      res.json({ repositories });
    } catch (err: unknown) {
      logger.error("[repositories] Failed to list repos", { error: errorMessage(err) });
      res.status(500).json({ error: "Failed to list repositories" });
    }
  });

  // Set or clear PAT for a repository (for git fetch/push from agents)
  router.put("/api/repositories/:name/pat", requireHumanUser, (req: Request, res: Response) => {
    const name = (req.params.name as string).replace(/\.git$/, "");
    const { pat } = (req.body ?? {}) as { pat?: string };
    const dirName = `${name}.git`;
    const repoPath = path.join(PERSISTENT_REPOS, dirName);

    if (!fs.existsSync(repoPath)) {
      res.status(404).json({ error: `Repository "${name}" not found` });
      return;
    }

    const resolved = path.resolve(repoPath);
    if (!resolved.startsWith(path.resolve(PERSISTENT_REPOS) + path.sep)) {
      res.status(400).json({ error: "Invalid repository name" });
      return;
    }

    setRepoPat(name, typeof pat === "string" ? pat : "");
    res.json({ ok: true, patConfigured: hasRepoPat(name) });
  });

  // Clone a new repository (SSE streaming for progress). Uses global GitHub token from Settings if set.
  router.post("/api/repositories", (req: Request, res: Response) => {
    const { url } = req.body ?? {};

    if (!url || typeof url !== "string") {
      res.status(400).json({ error: "url is required" });
      return;
    }

    let trimmedUrl = url.trim();
    if (!isValidGitUrl(trimmedUrl)) {
      res.status(400).json({ error: "Invalid git URL. Provide an HTTPS or SSH URL." });
      return;
    }

    // Inject GitHub token for HTTPS clone when available (private repos)
    const ghToken = getGitHubTokenForClone();
    if (ghToken && trimmedUrl.startsWith("https://") && trimmedUrl.includes("github.com")) {
      try {
        const u = new URL(trimmedUrl);
        u.username = "oauth2";
        u.password = ghToken;
        trimmedUrl = u.toString();
      } catch {
        /* leave trimmedUrl as-is */
      }
    }

    const repoName = extractRepoName(trimmedUrl);
    if (!repoName) {
      res.status(400).json({ error: "Could not extract repository name from URL" });
      return;
    }

    const targetDir = path.join(PERSISTENT_REPOS, `${repoName}.git`);

    // Prevent path traversal
    const resolvedTarget = path.resolve(targetDir);
    if (!resolvedTarget.startsWith(path.resolve(PERSISTENT_REPOS) + path.sep)) {
      res.status(400).json({ error: "Invalid repository name" });
      return;
    }

    if (fs.existsSync(targetDir)) {
      res.status(409).json({ error: `Repository "${repoName}" already exists` });
      return;
    }

    if (cloningInProgress.has(resolvedTarget)) {
      res.status(409).json({ error: `Repository "${repoName}" is already being cloned` });
      return;
    }

    // Ensure /persistent/repos/ exists
    fs.mkdirSync(PERSISTENT_REPOS, { recursive: true });
    cloningInProgress.add(resolvedTarget);

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendEvent = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Redact token from URL for display (avoid leaking in SSE)
    let displayUrl = trimmedUrl;
    if (ghToken) {
      try {
        const u = new URL(trimmedUrl);
        u.password = "[REDACTED]";
        u.username = u.username ? "[REDACTED]" : u.username;
        displayUrl = u.toString();
      } catch {
        displayUrl = "https://github.com/[REDACTED]";
      }
    }
    sendEvent({ type: "clone-start", repo: repoName, url: displayUrl });

    const proc = spawn("git", ["clone", "--bare", "--progress", trimmedUrl, targetDir], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000, // 5 minute timeout
    });

    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) sendEvent({ type: "clone-progress", text });
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      stderr += `${text}\n`;
      // git clone --progress writes progress to stderr
      if (text) sendEvent({ type: "clone-progress", text });
    });

    proc.on("close", (code) => {
      cloningInProgress.delete(resolvedTarget);
      if (code === 0) {
        sendEvent({ type: "clone-complete", repo: repoName });
        logger.info(`[repositories] Cloned ${trimmedUrl} -> ${targetDir}`);
      } else {
        // Clean up partial clone
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          /* ignore rm errors */
        }
        sendEvent({ type: "clone-error", error: `Clone failed (exit code ${code})`, details: stderr.slice(-500) });
        logger.error(`[repositories] Clone failed for ${trimmedUrl}: exit code ${code}`);
      }
      res.end();
    });

    proc.on("error", (err) => {
      cloningInProgress.delete(resolvedTarget);
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
      } catch {
        /* ignore readdir */
      }
      sendEvent({ type: "clone-error", error: `Clone process error: ${errorMessage(err)}` });
      logger.error(`[repositories] Clone process error for ${trimmedUrl}`, {
        error: errorMessage(err),
      });
      res.end();
    });

    // Handle client disconnect
    req.on("close", () => {
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
    });
  });

  // Delete a repository
  router.delete("/api/repositories/:name", async (req: Request, res: Response) => {
    const name = req.params.name as string;
    const dirName = name.endsWith(".git") ? name : `${name}.git`;
    const repoPath = path.join(PERSISTENT_REPOS, dirName);

    if (!fs.existsSync(repoPath)) {
      res.status(404).json({ error: `Repository "${name}" not found` });
      return;
    }

    // Prevent path traversal
    const resolved = path.resolve(repoPath);
    if (!resolved.startsWith(path.resolve(PERSISTENT_REPOS) + path.sep)) {
      res.status(400).json({ error: "Invalid repository name" });
      return;
    }

    // Check for active agents
    const activeAgents = await getActiveAgentsForRepo(repoPath, agentManager);
    if (activeAgents.length > 0) {
      const agentNames = activeAgents.map((a) => a.name).join(", ");
      res.status(409).json({
        error: `Cannot remove repository - ${activeAgents.length} active agent(s) are using it: ${agentNames}. Destroy these agents first.`,
        activeAgents,
      });
      return;
    }

    try {
      // Prune any stale worktrees first
      try {
        await execFileAsync("git", ["-C", repoPath, "worktree", "prune"], {
          encoding: "utf-8",
          timeout: 10_000,
        });
      } catch {
        // May fail if repo is corrupted - proceed with deletion anyway
      }

      fs.rmSync(repoPath, { recursive: true, force: true });
      logger.info(`[repositories] Removed repository: ${dirName}`);
      res.json({ ok: true });
    } catch (err: unknown) {
      logger.error(`[repositories] Failed to remove ${dirName}`, {
        error: errorMessage(err),
      });
      res.status(500).json({ error: "Failed to remove repository" });
    }
  });

  return router;
}
