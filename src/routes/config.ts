import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { requireHumanUser } from "../auth";
import * as guardrails from "../guardrails";
import { logger } from "../logger";
import { MCP_SERVERS } from "../mcp-oauth-manager";
import { getAllTokens, isTokenExpired } from "../mcp-oauth-storage";
import { resetSanitizeCache } from "../sanitize";
import { getAnthropicHint, getIntegrationHints, setAnthropic, setIntegration } from "../secrets-store";
import { syncClaudeHome } from "../storage";
import type { AuthenticatedRequest } from "../types";
import { errorMessage } from "../types";
import { CLAUDE_HOME, HOME, isAllowedConfigPath, isSymlink } from "../utils/config-paths";
import { walkDir } from "../utils/files";

export function createConfigRouter() {
  const router = express.Router();

  // Get current settings (store first, then env for backwards compatibility)
  router.get("/api/settings", (_req, res) => {
    const anthropicFromStore = getAnthropicHint();
    const isOpenRouter = anthropicFromStore
      ? anthropicFromStore.mode === "openrouter"
      : !!process.env.ANTHROPIC_AUTH_TOKEN;
    const keyHint = anthropicFromStore
      ? anthropicFromStore.hint
      : (() => {
          const key = (isOpenRouter ? process.env.ANTHROPIC_AUTH_TOKEN : process.env.ANTHROPIC_API_KEY) || "";
          return key ? `...${key.slice(-8)}` : "(not set)";
        })();

    const storeHints = getIntegrationHints();
    const storedTokens = getAllTokens();
    const linearToken = storedTokens.find((t) => t.server === "linear");
    const hasLinearOAuth = !!linearToken && !isTokenExpired(linearToken);
    const linearConfigured = storeHints.linear.configured || hasLinearOAuth;

    // Build integrations status: store first, then MCP OAuth
    const integrations: Record<string, { configured: boolean; authMethod: string }> = {};
    for (const [name] of Object.entries(MCP_SERVERS)) {
      const token = storedTokens.find((t) => t.server === name);
      const hasOAuth = !!token && !isTokenExpired(token);
      const fromStore = storeHints[name as keyof typeof storeHints]?.configured ?? false;
      integrations[name] = {
        configured: fromStore || hasOAuth,
        authMethod: fromStore ? "token" : hasOAuth ? "oauth" : "none",
      };
    }

    res.json({
      anthropicKeyHint: keyHint,
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
      integrations,
      linearConfigured,
    });
  });

  // Switch API key - supports both OpenRouter (sk-or-) and direct Anthropic (sk-ant-). Stored securely on backend.
  router.put("/api/settings/anthropic-key", requireHumanUser, (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const { key } = req.body ?? {};
    if (!key || typeof key !== "string" || !(key.startsWith("sk-or-") || key.startsWith("sk-ant-"))) {
      res.status(400).json({ error: "Invalid API key format (expected sk-or-... or sk-ant-...)" });
      return;
    }
    const isOpenRouter = key.startsWith("sk-or-");
    try {
      setAnthropic(key, isOpenRouter ? "openrouter" : "anthropic");
    } catch (err: unknown) {
      logger.warn("[config] Failed to save API key to secrets store", { error: errorMessage(err) });
      res.status(500).json({ error: "Failed to save API key securely" });
      return;
    }
    resetSanitizeCache();
    logger.warn(
      `[AUDIT] API key changed to ${isOpenRouter ? "OpenRouter" : "Anthropic"} by user: ${user?.sub ?? "unknown"}`,
    );
    res.json({ ok: true, hint: `...${key.slice(-8)}`, keyMode: isOpenRouter ? "openrouter" : "anthropic" });
  });

  // Set integration tokens (GitHub, Notion, Slack, Figma, Linear). Stored securely; only set what you use.
  router.put("/api/settings/integrations", requireHumanUser, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed = ["githubToken", "notionApiKey", "slackToken", "figmaToken", "linearApiKey"] as const;
    const nameMap = {
      githubToken: "github" as const,
      notionApiKey: "notion" as const,
      slackToken: "slack" as const,
      figmaToken: "figma" as const,
      linearApiKey: "linear" as const,
    };
    try {
      for (const key of allowed) {
        const val = body[key];
        if (val === undefined) continue;
        const str = typeof val === "string" ? val : "";
        setIntegration(nameMap[key], str);
      }
      const hints = getIntegrationHints();
      res.json({ ok: true, integrations: hints });
    } catch (err: unknown) {
      logger.warn("[config] Failed to save integrations to secrets store", { error: errorMessage(err) });
      res.status(500).json({ error: "Failed to save integration tokens securely" });
      return;
    }
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
      } catch {
        /* ignore list errors */
      }
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
      } catch {
        /* ignore list errors */
      }
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
  router.put("/api/claude-config/file", async (req: Request, res: Response) => {
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
    let synced = true;
    try {
      await syncClaudeHome();
    } catch (err: unknown) {
      logger.warn("[config] Failed to sync claude-home to GCS", { error: errorMessage(err) });
      synced = false;
    }
    res.json({ ok: true, synced });
  });

  // Create a new skill/command
  router.post("/api/claude-config/commands", async (req: Request, res: Response) => {
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
    let synced = true;
    try {
      await syncClaudeHome();
    } catch (err: unknown) {
      logger.warn("[config] Failed to sync claude-home to GCS", { error: errorMessage(err) });
      synced = false;
    }
    res.json({
      ok: true,
      synced,
      file: {
        name: `commands/${filename}`,
        path: commandPath,
        description: `Skill: /${filename.replace(".md", "")}`,
        category: "skills",
        deletable: true,
      },
    });
  });

  // Update guardrails settings (bounds from guardrails.BOUNDS - single source of truth)
  const GUARDRAIL_SPECS: Array<{
    key: keyof typeof guardrails.BOUNDS;
    min: number;
    max: number;
    setter: (v: number) => void;
    errorMsg: string;
  }> = [
    {
      key: "maxPromptLength",
      min: guardrails.BOUNDS.maxPromptLength[0],
      max: guardrails.BOUNDS.maxPromptLength[1],
      setter: guardrails.setMaxPromptLength,
      errorMsg: "maxPromptLength must be between 1,000 and 1,000,000",
    },
    {
      key: "maxTurns",
      min: guardrails.BOUNDS.maxTurns[0],
      max: guardrails.BOUNDS.maxTurns[1],
      setter: guardrails.setMaxTurns,
      errorMsg: "maxTurns must be between 1 and 10,000",
    },
    {
      key: "maxAgents",
      min: guardrails.BOUNDS.maxAgents[0],
      max: guardrails.BOUNDS.maxAgents[1],
      setter: guardrails.setMaxAgents,
      errorMsg: "maxAgents must be between 1 and 100",
    },
    {
      key: "maxBatchSize",
      min: guardrails.BOUNDS.maxBatchSize[0],
      max: guardrails.BOUNDS.maxBatchSize[1],
      setter: guardrails.setMaxBatchSize,
      errorMsg: "maxBatchSize must be between 1 and 50",
    },
    {
      key: "maxAgentDepth",
      min: guardrails.BOUNDS.maxAgentDepth[0],
      max: guardrails.BOUNDS.maxAgentDepth[1],
      setter: guardrails.setMaxAgentDepth,
      errorMsg: "maxAgentDepth must be between 1 and 10",
    },
    {
      key: "maxChildrenPerAgent",
      min: guardrails.BOUNDS.maxChildrenPerAgent[0],
      max: guardrails.BOUNDS.maxChildrenPerAgent[1],
      setter: guardrails.setMaxChildrenPerAgent,
      errorMsg: "maxChildrenPerAgent must be between 1 and 20",
    },
    {
      key: "sessionTtlMs",
      min: guardrails.BOUNDS.sessionTtlMs[0],
      max: guardrails.BOUNDS.sessionTtlMs[1],
      setter: guardrails.setSessionTtlMs,
      errorMsg: "sessionTtlMs must be between 1 minute and 24 hours",
    },
  ];

  router.put("/api/settings/guardrails", requireHumanUser, (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const body = req.body ?? {};
    const updates: Record<string, number> = {};

    for (const { key, min, max, setter, errorMsg } of GUARDRAIL_SPECS) {
      const raw = body[key];
      if (raw === undefined) continue;
      const val = Number(raw);
      if (!Number.isInteger(val) || val < min || val > max) {
        res.status(400).json({ error: errorMsg });
        return;
      }
      setter(val);
      updates[key] = val;
    }

    logger.warn(`[AUDIT] Guardrails updated by user: ${user?.sub ?? "unknown"}`, updates);

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
  router.delete("/api/claude-config/file", async (req: Request, res: Response) => {
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
    let synced = true;
    try {
      await syncClaudeHome();
    } catch (err: unknown) {
      logger.warn("[config] Failed to sync claude-home to GCS", { error: errorMessage(err) });
      synced = false;
    }
    res.json({ ok: true, synced });
  });

  return router;
}
