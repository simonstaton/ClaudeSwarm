import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { generateServiceToken } from "./auth";
import { getDepCacheEnv } from "./dep-cache";
import { logger } from "./logger";
import { PERSISTENT_REPOS } from "./paths";
import { generateWorkspaceClaudeMd } from "./templates/workspace-claude-md";
import type { Agent, PromptAttachment } from "./types";
import { errorMessage } from "./types";
import { getContextDir } from "./utils/context";
import { scanCommands, walkMdFiles } from "./utils/files";

const AGENT_TOKEN_FILENAME = ".agent-token";

/** Build a shared-context index with summaries from file content. */
function buildSharedContextIndex(sharedContextDir: string): string {
  const files = walkMdFiles(sharedContextDir);
  const entries: string[] = [];

  for (const relPath of files) {
    const absPath = path.join(sharedContextDir, relPath);
    let content: string;
    let sizeKb: number;
    try {
      content = readFileSync(absPath, "utf-8");
      const stats = statSync(absPath);
      sizeKb = Math.ceil(stats.size / 1024);
    } catch {
      continue;
    }

    // Check for explicit <!-- summary: ... --> tag
    const summaryMatch = content.match(/<!--\s*summary:\s*(.+?)\s*-->/);
    let summary: string;

    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    } else {
      // Fallback: first heading + first content line
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const heading = lines.find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "") || "";
      const firstLine = lines.find((l) => !l.startsWith("#") && !l.startsWith("<!--")) || "";
      summary = heading && firstLine ? `${heading} - ${firstLine}`.substring(0, 120) : heading || relPath;
    }

    entries.push(`- **${relPath}** (${sizeKb}KB): ${summary}`);
  }

  // Sort: guides/ last, then alphabetical
  entries.sort((a, b) => {
    const aGuide = a.includes("guides/");
    const bGuide = b.includes("guides/");
    if (aGuide && !bGuide) return 1;
    if (!aGuide && bGuide) return -1;
    return a.localeCompare(b);
  });

  return entries.join("\n");
}

/** Provides agent list for workspace CLAUDE.md generation. */
export interface AgentListProvider {
  list(): Agent[];
}

export class WorkspaceManager {
  private agentListProvider: AgentListProvider | null = null;

  /** Set the provider used to list agents for workspace CLAUDE.md generation.
   *  Called by AgentManager after construction to break the circular dependency. */
  setAgentListProvider(provider: AgentListProvider): void {
    this.agentListProvider = provider;
  }

  /** Ensure workspace directory exists with symlinks and CLAUDE.md. */
  ensureWorkspace(workspaceDir: string, agentName: string, agentId?: string): void {
    mkdirSync(workspaceDir, { recursive: true });

    // Symlink shared context into workspace
    mkdirSync(getContextDir(), { recursive: true });
    const contextTarget = path.join(workspaceDir, "shared-context");
    if (!existsSync(contextTarget)) {
      symlinkSync(path.resolve(getContextDir()), contextTarget);
    }

    // Symlink persistent repos into workspace (if available)
    if (existsSync(PERSISTENT_REPOS)) {
      const reposTarget = path.join(workspaceDir, "repos");
      if (!existsSync(reposTarget)) {
        symlinkSync(PERSISTENT_REPOS, reposTarget);
      }
    }

    // Write workspace CLAUDE.md so agents know about shared context
    this.writeWorkspaceClaudeMd(workspaceDir, agentName, agentId);

    // Write fresh auth token file - agents read this before each API call
    this.writeAgentTokenFile(workspaceDir, agentId);
  }

  writeWorkspaceClaudeMd(workspaceDir: string, agentName: string, agentId?: string): void {
    // Build shared-context index with summaries
    const sharedContextPath = path.join(workspaceDir, "shared-context");
    const contextIndex = buildSharedContextIndex(sharedContextPath);

    // Build repo list if persistent storage is available
    let repoList: string[] = [];
    if (existsSync(PERSISTENT_REPOS)) {
      try {
        repoList = readdirSync(PERSISTENT_REPOS).filter((f) => f.endsWith(".git"));
      } catch (err: unknown) {
        logger.warn("[workspace] Failed to list persistent repos", { error: errorMessage(err) });
      }
    }

    // List existing skills/commands
    const commandsDir = path.join(
      process.env.CLAUDE_HOME || path.join(process.env.HOME || "/home/agent", ".claude"),
      "commands",
    );
    let skillFiles: string[] = [];
    if (existsSync(commandsDir)) {
      try {
        skillFiles = scanCommands(commandsDir);
      } catch (err: unknown) {
        logger.warn("[workspace] Failed to scan skills/commands", { error: errorMessage(err) });
      }
    }

    const skillsList = skillFiles.length > 0 ? skillFiles.map((f) => `- \`${f}\``).join("\n") : "(none yet)";

    // Gather agent list (no currentTask - CRIT-1 fix)
    const PORT = process.env.PORT ?? "8080";
    const otherAgents = this.agentListProvider
      ? this.agentListProvider
          .list()
          .filter((a) => a.id !== agentId)
          .map((a) => ({
            name: a.name,
            id: a.id,
            role: a.role,
            status: a.status,
          }))
      : [];

    const claudeMd = generateWorkspaceClaudeMd({
      agentName,
      agentId: agentId || "unknown",
      workspaceDir,
      port: PORT,
      otherAgents,
      contextIndex,
      repoList,
      skillsList,
    });

    writeFileSync(path.join(workspaceDir, "CLAUDE.md"), claudeMd);
  }

  /** Write a fresh auth token to the agent's workspace for file-based token reading.
   *  Agents read this via $(cat .agent-token) in curl commands, ensuring they always
   *  use the latest token even after periodic refresh. Uses atomic write-then-rename
   *  to prevent agents from reading a partially-written file. */
  writeAgentTokenFile(workspaceDir: string, agentId?: string): void {
    const tokenPath = path.join(workspaceDir, AGENT_TOKEN_FILENAME);
    const tmpPath = `${tokenPath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, generateServiceToken(agentId), { mode: 0o600 });
    renameSync(tmpPath, tokenPath);
  }

  /** Refresh auth token files for all active agents. Called periodically (every 60 min)
   *  to ensure tokens never expire (4h TTL). Bails out when kill switch is active. */
  refreshAllAgentTokens(agents: Map<string, { agent: Agent }>, killed: boolean): void {
    if (killed) return;
    let refreshed = 0;
    for (const [id, agentProc] of agents) {
      try {
        this.writeAgentTokenFile(agentProc.agent.workspaceDir, id);
        refreshed++;
      } catch (err: unknown) {
        logger.warn(`[workspace] Failed to refresh token for ${id.slice(0, 8)}`, { error: errorMessage(err) });
      }
    }
    if (refreshed > 0) {
      logger.info(`[workspace] Refreshed auth tokens for ${refreshed} agent(s)`);
    }
  }

  /** Save attachments to the agent workspace.
   *
   * Returns an object with:
   * - `prefix`  – text to prepend to the user message so the LLM reads attached
   *               files before forming its reply.
   * - `names`   – display names of every saved attachment (for the UI).
   *
   * Placing the instruction *before* the user text ensures the model encounters
   * it at the start of the turn and reliably calls the Read tool to view images.
   */
  saveAttachments(workspaceDir: string, attachments: PromptAttachment[]): { prefix: string; names: string[] } {
    if (attachments.length === 0) return { prefix: "", names: [] };

    const attachDir = path.join(workspaceDir, ".attachments");
    mkdirSync(attachDir, { recursive: true });

    const imageLines: string[] = [];
    const fileLines: string[] = [];
    const names: string[] = [];
    const timestamp = Date.now();

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${timestamp}-${i}-${safeName}`;
      const filePath = path.join(attachDir, filename);
      names.push(att.name);

      if (att.type === "image" && att.data.startsWith("data:")) {
        // Strip data URL prefix and decode base64
        const base64 = att.data.replace(/^data:[^;]+;base64,/, "");
        writeFileSync(filePath, Buffer.from(base64, "base64"));
        imageLines.push(`- ${filePath}  (original name: ${att.name})`);
      } else if (att.type === "file") {
        writeFileSync(filePath, att.data, "utf-8");
        fileLines.push(`- ${filePath}  (original name: ${att.name})`);
      }
    }

    const parts: string[] = [];
    if (imageLines.length > 0) {
      parts.push(`Use your Read tool to view the following image(s) BEFORE responding:\n${imageLines.join("\n")}`);
    }
    if (fileLines.length > 0) {
      parts.push(`The following file(s) have been attached:\n${fileLines.join("\n")}`);
    }

    const prefix = parts.length > 0 ? `${parts.join("\n\n")}\n\n` : "";
    return { prefix, names };
  }

  buildEnv(agentId?: string): NodeJS.ProcessEnv {
    // Allowlist approach - only forward env vars agents actually need.
    const ALLOWED_ENV_KEYS = [
      // Anthropic API access (needed for Claude CLI)
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      // GitHub CLI and git operations
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      // MCP integration tokens
      "LINEAR_API_KEY",
      "FIGMA_TOKEN",
      "SLACK_TOKEN",
      "NOTION_API_KEY",
      "GOOGLE_CREDENTIALS",
      // Runtime essentials
      "HOME",
      "USER",
      "PATH",
      "LANG",
      "LC_ALL",
      "TERM",
      "TMPDIR",
      "TZ",
      "NODE_ENV",
      "PORT",
      // Claude Code config
      "CLAUDE_HOME",
      // Shared context
      "SHARED_CONTEXT_DIR",
      // npm/pnpm cache (persistent across sessions - may be set by dep-cache)
      "npm_config_cache",
      "npm_config_store_dir",
    ];

    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/sh",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      AGENT_AUTH_TOKEN: generateServiceToken(agentId),
      ...getDepCacheEnv(),
    };

    for (const key of ALLOWED_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }

    return env;
  }
}
