import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { logger } from "../logger";
import {
  exchangeCodeForToken,
  generateAuthUrl,
  getValidToken,
  MCP_SERVERS,
  revokeToken,
  validateState,
} from "../mcp-oauth-manager";
import { getAllTokens, isTokenExpired } from "../mcp-oauth-storage";
import { errorMessage } from "../types";
import { CLAUDE_HOME } from "../utils/config-paths";

const SETTINGS_PATH = path.join(CLAUDE_HOME, "settings.json");

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPage(title: string, heading: string, body: string, success: boolean): string {
  const bg = success ? "#efe" : "#fee";
  const border = success ? "#cfc" : "#fcc";
  const color = success ? "#3c3" : "#c33";
  return `<!DOCTYPE html>
<html>
  <head>
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; text-align: center; }
      .box { background: ${bg}; border: 1px solid ${border}; padding: 30px; border-radius: 8px; }
      h1 { color: ${color}; margin-bottom: 20px; }
      p { color: #666; line-height: 1.6; }
      code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
      .hint { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 0.9em; color: #999; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>${heading}</h1>
      ${body}
    </div>
  </body>
</html>`;
}

export function createMcpRouter() {
  const router = express.Router();

  /**
   * GET /api/mcp/servers
   * List all configured MCP servers and their auth status
   */
  router.get("/api/mcp/servers", (_req: Request, res: Response) => {
    try {
      let configuredServers: Record<string, { type?: string; url?: string; headers?: Record<string, string> }> = {};

      if (fs.existsSync(SETTINGS_PATH)) {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
        configuredServers = settings.mcpServers || {};
      }

      const storedTokens = getAllTokens();
      const tokenMap = new Map(storedTokens.map((t) => [t.server, t]));

      const servers = Object.entries(MCP_SERVERS).map(([name, config]) => {
        const token = tokenMap.get(name);
        const isConfigured = !!configuredServers[name];

        const serverSettings = configuredServers[name];
        const hasApiKeyAuth = !!serverSettings?.headers?.Authorization;
        const hasOAuthToken = !!token && !isTokenExpired(token);
        const activeAuthMethod = hasApiKeyAuth ? "token" : hasOAuthToken ? "oauth" : "none";

        return {
          name,
          type: config.type,
          url: config.url,
          authRequired: config.authMethod === "oauth",
          authMethod: activeAuthMethod,
          authenticated: hasApiKeyAuth || hasOAuthToken,
          authenticatedAt: token?.authenticatedAt,
          configured: isConfigured,
          tokenExpired: token ? isTokenExpired(token) : false,
        };
      });

      res.json({ servers });
    } catch (err: unknown) {
      logger.error("[MCP-Routes] Error listing servers", { error: errorMessage(err) });
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  /**
   * POST /api/mcp/auth/:server
   * Initiate OAuth flow for a specific server
   */
  router.post("/api/mcp/auth/:server", (req: Request<{ server: string }>, res: Response) => {
    try {
      const { server } = req.params;

      if (!MCP_SERVERS[server]) {
        res.status(404).json({ error: `Unknown MCP server: ${server}` });
        return;
      }

      const config = MCP_SERVERS[server];
      if (config.authMethod !== "oauth" || !config.oauthConfig) {
        res.status(400).json({ error: `Server ${server} does not support OAuth` });
        return;
      }

      const reqHeaders = {
        host: req.headers.host,
        "x-forwarded-proto": req.headers["x-forwarded-proto"] as string | undefined,
      };
      const authUrl = generateAuthUrl(server, reqHeaders);
      if (!authUrl) {
        res.status(500).json({ error: "Failed to generate authorization URL" });
        return;
      }

      logger.info(`[MCP-Routes] Initiating OAuth flow for ${server}`);
      res.json({
        authUrl,
        message: "Visit this URL in your browser to authenticate",
        server,
      });
    } catch (err: unknown) {
      logger.error("[MCP-Routes] Error initiating OAuth", { error: errorMessage(err) });
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  /**
   * GET /api/mcp/callback
   * OAuth callback endpoint
   * Query params: code, state
   */
  router.get("/api/mcp/callback", async (req: Request, res: Response) => {
    try {
      const { code, state, error, error_description } = req.query;

      if (error) {
        logger.error("[MCP-Routes] OAuth error", { error, error_description });
        const desc = typeof error_description === "string" ? `<p>${escapeHtml(error_description)}</p>` : "";
        res
          .status(400)
          .send(
            renderPage(
              "Authentication Failed",
              "Authentication Failed",
              `<p><strong>Error:</strong> <code>${escapeHtml(String(error))}</code></p>${desc}<p>Please try again or contact support.</p>`,
              false,
            ),
          );
        return;
      }

      if (!code || !state || typeof code !== "string" || typeof state !== "string") {
        res
          .status(400)
          .send(
            renderPage(
              "Invalid Request",
              "Invalid Request",
              "<p>Missing required parameters: code and state</p>",
              false,
            ),
          );
        return;
      }

      const stateData = validateState(state);
      if (!stateData) {
        logger.error("[MCP-Routes] Invalid or expired state token");
        res
          .status(400)
          .send(
            renderPage(
              "Invalid State",
              "Invalid or Expired State",
              "<p>The authentication state token is invalid or has expired. Please try again.</p>",
              false,
            ),
          );
        return;
      }

      const { server, callbackUrl } = stateData;
      logger.info(`[MCP-Routes] Exchanging code for token (server: ${server})`);

      const token = await exchangeCodeForToken(server, code, callbackUrl);

      if (!token) {
        res
          .status(500)
          .send(
            renderPage(
              "Token Exchange Failed",
              "Token Exchange Failed",
              "<p>Failed to exchange authorization code for access token. Please try again.</p>",
              false,
            ),
          );
        return;
      }

      logger.info(`[MCP-Routes] Successfully authenticated ${server}`);

      const safeServer = escapeHtml(server);
      res.send(
        renderPage(
          "Authentication Successful",
          "Authentication Successful!",
          `<div style="font-size:1.2em;font-weight:bold;color:#333;margin:20px 0">${safeServer.toUpperCase()}</div>
          <p>Your ${safeServer} account has been successfully connected.</p>
          <p>You can now close this window and return to AgentManager.</p>
          <p>All agents will have access to your ${safeServer} account.</p>
          <div class="hint">This window can be closed.</div>`,
          true,
        ),
      );
    } catch (err: unknown) {
      logger.error("[MCP-Routes] Error in OAuth callback", { error: errorMessage(err) });
      res
        .status(500)
        .send(
          renderPage(
            "Error",
            "Server Error",
            `<p>An unexpected error occurred. Please try again.</p><p><small>${escapeHtml(errorMessage(err))}</small></p>`,
            false,
          ),
        );
    }
  });

  /**
   * GET /api/mcp/token/:server
   * Get current token status for a server
   */
  router.get("/api/mcp/token/:server", async (req: Request<{ server: string }>, res: Response) => {
    try {
      const { server } = req.params;

      if (!MCP_SERVERS[server]) {
        res.status(404).json({ error: `Unknown MCP server: ${server}` });
        return;
      }

      const token = await getValidToken(server);

      if (!token) {
        res.json({
          server,
          authenticated: false,
          message: "No valid token available",
        });
        return;
      }

      res.json({
        server,
        authenticated: true,
        tokenType: token.tokenType,
        scope: token.scope,
        authenticatedAt: token.authenticatedAt,
        expiresAt: token.expiresAt,
        expired: isTokenExpired(token),
      });
    } catch (err: unknown) {
      logger.error("[MCP-Routes] Error getting token status", { error: errorMessage(err) });
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  /**
   * DELETE /api/mcp/token/:server
   * Revoke OAuth token for a server
   */
  router.delete("/api/mcp/token/:server", async (req: Request<{ server: string }>, res: Response) => {
    try {
      const { server } = req.params;

      if (!MCP_SERVERS[server]) {
        res.status(404).json({ error: `Unknown MCP server: ${server}` });
        return;
      }

      const success = await revokeToken(server);

      if (success) {
        logger.info(`[MCP-Routes] Revoked token for ${server}`);
        res.json({ success: true, message: `Token revoked for ${server}` });
      } else {
        res.status(404).json({ error: "No token found to revoke" });
      }
    } catch (err: unknown) {
      logger.error("[MCP-Routes] Error revoking token", { error: errorMessage(err) });
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  return router;
}
