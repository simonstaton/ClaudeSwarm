import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import * as guardrails from "../guardrails";
import { resetSanitizeCache } from "../sanitize";
import { syncClaudeHome } from "../storage";
import { errorMessage } from "../types";
import { CLAUDE_HOME, HOME, isAllowedConfigPath, isSymlink } from "../utils/config-paths";
import { walkDir } from "../utils/files";

export function createConfigRouter() {
  const router = express.Router();

  // Get current settings
  router.get("/api/settings", (_req, res) => {
    const isOpenRouter = !!process.env.ANTHROPIC_AUTH_TOKEN;
    const key = (isOpenRouter ? process.env.ANTHROPIC_AUTH_TOKEN : process.env.ANTHROPIC_API_KEY) || "";
    res.json({
      anthropicKeyHint: key ? `...${key.slice(-8)}` : "(not set)",
      keyMode: isOpenRouter ? "openrouter" : "anthropic",
      models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-opus-4-6"],
      guardrails: {
        maxPromptLength: guardrails.MAX_PROMPT_LENGTH,
        maxTurns: guardrails.MAX_TURNS,
        maxAgents: guardrails.MAX_AGENTS,
        maxBatchSize: guardrails.MAX_BATCH_SIZE,
        maxAgentDepth: guardrails.MAX_AGENT_DEPTH,
        maxChildrenPerAgent: guardrails.MAX_CHILDREN_PER_AGENT,
        sessionTtlMs: guardrails.SESSION_TTL_MS,
      },
    });
  });

  // Switch API key — supports both OpenRouter (sk-or-) and direct Anthropic (sk-ant-)
  router.put("/api/settings/anthropic-key", (req: Request, res: Response) => {
    // biome-ignore lint/suspicious/noExplicitAny: Express Request augmentation for auth
    const user = (req as any).user;
    if (user?.sub === "agent-service") {
      res.status(403).json({ error: "Agents are not allowed to change the API key" });
      return;
    }
    const { key } = req.body ?? {};
    if (!key || typeof key !== "string" || !(key.startsWith("sk-or-") || key.startsWith("sk-ant-"))) {
      res.status(400).json({ error: "Invalid API key format (expected sk-or-... or sk-ant-...)" });
      return;
    }
    const isOpenRouter = key.startsWith("sk-or-");
    if (isOpenRouter) {
      process.env.ANTHROPIC_AUTH_TOKEN = key;
      process.env.ANTHROPIC_API_KEY = "";
      process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    } else {
      process.env.ANTHROPIC_API_KEY = key;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_BASE_URL;
    }
    resetSanitizeCache();
    console.warn(
      `[AUDIT] API key changed to ${isOpenRouter ? "OpenRouter" : "Anthropic"} by user: ${user?.sub ?? "unknown"}`,
    );
    res.json({ ok: true, hint: `...${key.slice(-8)}`, keyMode: isOpenRouter ? "openrouter" : "anthropic" });
  });

  // List editable Claude config files
  router.get("/api/claude-config", (_req, res) => {
    const editableFiles: Array<{
      name: string;
      path: string;
      description: string;
      category: string;
      deletable: boolean;
    }> = [];

    // settings.json
    const settingsPath = path.join(CLAUDE_HOME, "settings.json");
    if (fs.existsSync(settingsPath)) {
      editableFiles.push({
        name: "settings.json",
        path: settingsPath,
        description: "Global Claude settings (allowed tools, model, etc.)",
        category: "core",
        deletable: false,
      });
    }

    // ~/.claude.json (identity config)
    const identityPath = path.join(HOME, ".claude.json");
    if (fs.existsSync(identityPath)) {
      editableFiles.push({
        name: ".claude.json",
        path: identityPath,
        description: "Identity config (onboarding, API key approval)",
        category: "core",
        deletable: false,
      });
    }

    // Home-level ~/CLAUDE.md (global agent instructions loaded by Claude Code automatically)
    const homeClaudeMdPath = path.join(HOME, "CLAUDE.md");
    if (fs.existsSync(homeClaudeMdPath)) {
      editableFiles.push({
        name: "~/CLAUDE.md",
        path: homeClaudeMdPath,
        description: "Global agent instructions (loaded by Claude Code for all sessions)",
        category: "core",
        deletable: false,
      });
    }

    // Project CLAUDE.md
    const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");
    if (fs.existsSync(claudeMdPath)) {
      editableFiles.push({
        name: "CLAUDE.md",
        path: claudeMdPath,
        description: "Project instructions for agents",
        category: "core",
        deletable: false,
      });
    }

    // MCP settings template
    const mcpTemplatePath = path.join(process.cwd(), "mcp", "settings-template.json");
    if (fs.existsSync(mcpTemplatePath)) {
      editableFiles.push({
        name: "settings-template.json",
        path: mcpTemplatePath,
        description: "MCP server definitions (conditionally activated via env vars)",
        category: "mcp",
        deletable: false,
      });
    }

    // User commands/skills (~/.claude/commands/)
    const userCommandsDir = path.join(CLAUDE_HOME, "commands");
    if (fs.existsSync(userCommandsDir)) {
      try {
        for (const fullPath of walkDir(userCommandsDir)) {
          if (!fullPath.endsWith(".md")) continue;
          const relPath = path.relative(userCommandsDir, fullPath);
          editableFiles.push({
            name: `commands/${relPath}`,
            path: fullPath,
            description: `Skill: /${relPath.replace(/\.md$/, "")}`,
            category: "skills",
            deletable: true,
          });
        }
      } catch {}
    }

    // Memory files
    const memoryDir = path.join(CLAUDE_HOME, "projects");
    if (fs.existsSync(memoryDir)) {
      try {
        for (const project of fs.readdirSync(memoryDir)) {
          const memDir = path.join(memoryDir, project, "memory");
          if (fs.existsSync(memDir) && fs.statSync(memDir).isDirectory()) {
            for (const file of fs.readdirSync(memDir)) {
              const filePath = path.join(memDir, file);
              if (fs.statSync(filePath).isFile()) {
                editableFiles.push({
                  name: `memory/${project}/${file}`,
                  path: filePath,
                  description: `Auto-memory for project ${project}`,
                  category: "memory",
                  deletable: true,
                });
              }
            }
          }
        }
      } catch {}
    }

    res.json(editableFiles);
  });

  // Read a config file
  router.get("/api/claude-config/file", (req: Request, res: Response) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== "string") {
      res.status(400).json({ error: "path query param required" });
      return;
    }
    if (!isAllowedConfigPath(filePath)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ content });
  });

  // Write a config file
  router.put("/api/claude-config/file", (req: Request, res: Response) => {
    const { path: filePath, content } = req.body ?? {};
    if (!filePath || typeof filePath !== "string" || typeof content !== "string") {
      res.status(400).json({ error: "path and content required" });
      return;
    }
    if (!isAllowedConfigPath(filePath)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    if (isSymlink(filePath)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    // Sync claude-home to GCS so changes persist across Cloud Run reloads
    syncClaudeHome().catch((err: unknown) => {
      console.warn("[config] Failed to sync claude-home to GCS:", errorMessage(err));
    });
    res.json({ ok: true });
  });

  // Create a new skill/command
  router.post("/api/claude-config/commands", (req: Request, res: Response) => {
    const { name, content } = req.body ?? {};
    if (!name || typeof name !== "string" || typeof content !== "string") {
      res.status(400).json({ error: "name and content required" });
      return;
    }

    // Validate name: allow alphanumeric, hyphens, underscores, forward slashes for subdirs
    const sanitized = name.replace(/[^a-zA-Z0-9\-_/]/g, "");
    if (!sanitized || sanitized !== name) {
      res.status(400).json({
        error:
          "Invalid command name. Use only alphanumeric characters, hyphens, underscores, and / for subdirectories.",
      });
      return;
    }

    const filename = sanitized.endsWith(".md") ? sanitized : `${sanitized}.md`;
    const commandPath = path.join(CLAUDE_HOME, "commands", filename);

    if (fs.existsSync(commandPath)) {
      res.status(409).json({ error: "Command already exists" });
      return;
    }

    fs.mkdirSync(path.dirname(commandPath), { recursive: true });
    fs.writeFileSync(commandPath, content, "utf-8");
    syncClaudeHome().catch((err: unknown) => {
      console.warn("[config] Failed to sync claude-home to GCS:", errorMessage(err));
    });

    res.json({
      ok: true,
      file: {
        name: `commands/${filename}`,
        path: commandPath,
        description: `Skill: /${filename.replace(".md", "")}`,
        category: "skills",
        deletable: true,
      },
    });
  });

  // Update guardrails settings
  router.put("/api/settings/guardrails", (req: Request, res: Response) => {
    // biome-ignore lint/suspicious/noExplicitAny: Express Request augmentation for auth
    const user = (req as any).user;
    if (user?.sub === "agent-service") {
      res.status(403).json({ error: "Agents are not allowed to change guardrails" });
      return;
    }

    const { maxPromptLength, maxTurns, maxAgents, maxBatchSize, maxAgentDepth, maxChildrenPerAgent, sessionTtlMs } =
      req.body ?? {};

    // Validate and update each setting if provided
    const updates: Record<string, number> = {};

    if (maxPromptLength !== undefined) {
      const val = Number(maxPromptLength);
      if (!Number.isInteger(val) || val < 1000 || val > 1_000_000) {
        res.status(400).json({ error: "maxPromptLength must be between 1,000 and 1,000,000" });
        return;
      }
      guardrails.setMaxPromptLength(val);
      updates.maxPromptLength = val;
    }

    if (maxTurns !== undefined) {
      const val = Number(maxTurns);
      if (!Number.isInteger(val) || val < 1 || val > 10000) {
        res.status(400).json({ error: "maxTurns must be between 1 and 10,000" });
        return;
      }
      guardrails.setMaxTurns(val);
      updates.maxTurns = val;
    }

    if (maxAgents !== undefined) {
      const val = Number(maxAgents);
      if (!Number.isInteger(val) || val < 1 || val > 100) {
        res.status(400).json({ error: "maxAgents must be between 1 and 100" });
        return;
      }
      guardrails.setMaxAgents(val);
      updates.maxAgents = val;
    }

    if (maxBatchSize !== undefined) {
      const val = Number(maxBatchSize);
      if (!Number.isInteger(val) || val < 1 || val > 50) {
        res.status(400).json({ error: "maxBatchSize must be between 1 and 50" });
        return;
      }
      guardrails.setMaxBatchSize(val);
      updates.maxBatchSize = val;
    }

    if (maxAgentDepth !== undefined) {
      const val = Number(maxAgentDepth);
      if (!Number.isInteger(val) || val < 1 || val > 10) {
        res.status(400).json({ error: "maxAgentDepth must be between 1 and 10" });
        return;
      }
      guardrails.setMaxAgentDepth(val);
      updates.maxAgentDepth = val;
    }

    if (maxChildrenPerAgent !== undefined) {
      const val = Number(maxChildrenPerAgent);
      if (!Number.isInteger(val) || val < 1 || val > 20) {
        res.status(400).json({ error: "maxChildrenPerAgent must be between 1 and 20" });
        return;
      }
      guardrails.setMaxChildrenPerAgent(val);
      updates.maxChildrenPerAgent = val;
    }

    if (sessionTtlMs !== undefined) {
      const val = Number(sessionTtlMs);
      if (!Number.isInteger(val) || val < 60_000 || val > 24 * 60 * 60 * 1000) {
        res.status(400).json({ error: "sessionTtlMs must be between 1 minute and 24 hours" });
        return;
      }
      guardrails.setSessionTtlMs(val);
      updates.sessionTtlMs = val;
    }

    console.warn(`[AUDIT] Guardrails updated by user: ${user?.sub ?? "unknown"}`, updates);

    res.json({
      ok: true,
      guardrails: {
        maxPromptLength: guardrails.MAX_PROMPT_LENGTH,
        maxTurns: guardrails.MAX_TURNS,
        maxAgents: guardrails.MAX_AGENTS,
        maxBatchSize: guardrails.MAX_BATCH_SIZE,
        maxAgentDepth: guardrails.MAX_AGENT_DEPTH,
        maxChildrenPerAgent: guardrails.MAX_CHILDREN_PER_AGENT,
        sessionTtlMs: guardrails.SESSION_TTL_MS,
      },
    });
  });

  // Delete a config file
  router.delete("/api/claude-config/file", (req: Request, res: Response) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== "string") {
      res.status(400).json({ error: "path query param required" });
      return;
    }
    if (!isAllowedConfigPath(filePath)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    if (isSymlink(filePath)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    // Only allow deleting files within commands/ or memory/ directories
    const resolved = path.resolve(filePath);
    const commandsDir = path.resolve(path.join(CLAUDE_HOME, "commands"));
    const projectsDir = path.resolve(path.join(CLAUDE_HOME, "projects"));
    if (!resolved.startsWith(commandsDir) && !resolved.startsWith(projectsDir)) {
      res.status(403).json({ error: "Can only delete skill and memory files" });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    fs.unlinkSync(filePath);
    syncClaudeHome().catch((err: unknown) => {
      console.warn("[config] Failed to sync claude-home to GCS:", errorMessage(err));
    });
    res.json({ ok: true });
  });

  return router;
}
