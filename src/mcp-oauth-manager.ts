import crypto from "node:crypto";
import { logger } from "./logger";
import type { MCPOAuthToken } from "./mcp-oauth-storage";
import { deleteToken, isTokenExpired, loadToken, saveToken } from "./mcp-oauth-storage";
import { errorMessage } from "./types";

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
}

export interface MCPServerConfig {
  name: string;
  type: "http" | "stdio";
  url?: string;
  authMethod?: "oauth" | "token" | "none";
  oauthConfig?: {
    authUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scope?: string;
  };
}

/** In-memory store for OAuth state tokens (CSRF protection) */
const pendingStates = new Map<string, { server: string; createdAt: number; callbackUrl: string }>();

/** State token expiry time (10 minutes) */
const STATE_EXPIRY_MS = 10 * 60 * 1000;

/**
 * Clean up expired state tokens
 */
function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [state, data] of pendingStates.entries()) {
    if (now - data.createdAt > STATE_EXPIRY_MS) {
      pendingStates.delete(state);
    }
  }
}

// Run cleanup every 5 minutes (unref so it doesn't block process exit)
const cleanupInterval = setInterval(cleanupExpiredStates, 5 * 60 * 1000);
cleanupInterval.unref();

/**
 * MCP server configurations
 * In a real implementation, these would be loaded from the MCP settings template
 */
export const MCP_SERVERS: Record<string, MCPServerConfig> = {
  figma: {
    name: "figma",
    type: "http",
    url: "https://mcp.figma.com/mcp",
    authMethod: "oauth",
    oauthConfig: {
      authUrl: "https://mcp.figma.com/oauth/authorize",
      tokenUrl: "https://mcp.figma.com/oauth/token",
      clientId: process.env.FIGMA_OAUTH_CLIENT_ID || "agent-manager",
      clientSecret: process.env.FIGMA_OAUTH_CLIENT_SECRET,
      scope: "mcp:connect",
    },
  },
  linear: {
    name: "linear",
    type: "http",
    url: "https://mcp.linear.app/mcp",
    authMethod: "oauth",
    oauthConfig: {
      authUrl: "https://mcp.linear.app/oauth/authorize",
      tokenUrl: "https://mcp.linear.app/oauth/token",
      clientId: process.env.LINEAR_OAUTH_CLIENT_ID || "agent-manager",
      clientSecret: process.env.LINEAR_OAUTH_CLIENT_SECRET,
      scope: "read write",
    },
  },
};

/**
 * Get callback URL for OAuth redirects.
 * Derives the URL from the incoming request headers when available,
 * falling back to PUBLIC_URL env var or localhost for dev.
 */
function getCallbackUrl(reqHeaders?: { host?: string; "x-forwarded-proto"?: string }): string {
  if (process.env.PUBLIC_URL) {
    return `${process.env.PUBLIC_URL}/api/mcp/callback`;
  }

  if (reqHeaders?.host) {
    const proto = reqHeaders["x-forwarded-proto"] || "https";
    return `${proto}://${reqHeaders.host}/api/mcp/callback`;
  }

  return "http://localhost:8080/api/mcp/callback";
}

/**
 * Generate OAuth authorization URL
 */
export function generateAuthUrl(
  server: string,
  reqHeaders?: { host?: string; "x-forwarded-proto"?: string },
): string | null {
  const config = MCP_SERVERS[server];
  if (!config?.oauthConfig) {
    return null;
  }

  const { authUrl, clientId, scope } = config.oauthConfig;
  const callbackUrl = getCallbackUrl(reqHeaders);

  // Generate state token for CSRF protection, storing callback URL for token exchange
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.set(state, { server, createdAt: Date.now(), callbackUrl });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: "code",
    state,
  });

  if (scope) {
    params.set("scope", scope);
  }

  return `${authUrl}?${params.toString()}`;
}

/**
 * Validate OAuth state token. Returns server name and the callback URL
 * that was used when generating the auth URL (so token exchange matches).
 */
export function validateState(state: string): { server: string; callbackUrl: string } | null {
  cleanupExpiredStates();
  const data = pendingStates.get(state);

  if (!data) {
    return null;
  }

  if (Date.now() - data.createdAt > STATE_EXPIRY_MS) {
    pendingStates.delete(state);
    return null;
  }

  pendingStates.delete(state);
  return { server: data.server, callbackUrl: data.callbackUrl };
}

/**
 * Exchange authorization code for access token.
 * callbackUrl must match the redirect_uri used in the original auth URL.
 */
export async function exchangeCodeForToken(
  server: string,
  code: string,
  callbackUrl?: string,
): Promise<MCPOAuthToken | null> {
  const config = MCP_SERVERS[server];
  if (!config?.oauthConfig) {
    logger.error(`[MCP-OAuth] No OAuth config for server: ${server}`);
    return null;
  }

  const { tokenUrl, clientId, clientSecret } = config.oauthConfig;
  const redirectUri = callbackUrl || getCallbackUrl();

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
    });

    if (clientSecret) {
      params.set("client_secret", clientSecret);
    }

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[MCP-OAuth] Token exchange failed for ${server}`, { error: errorText });
      return null;
    }

    const data = (await response.json()) as OAuthTokenResponse;

    const token: MCPOAuthToken = {
      server,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type || "Bearer",
      scope: data.scope,
      authenticatedAt: new Date().toISOString(),
    };

    if (data.expires_in) {
      const expiresAt = new Date(Date.now() + data.expires_in * 1000);
      token.expiresAt = expiresAt.toISOString();
    }

    saveToken(token);

    return token;
  } catch (err: unknown) {
    logger.error("[MCP-OAuth] Error exchanging code for token", {
      error: errorMessage(err),
    });
    return null;
  }
}

/**
 * Refresh an expired token
 */
export async function refreshAccessToken(server: string): Promise<MCPOAuthToken | null> {
  const storedToken = loadToken(server);
  if (!storedToken?.refreshToken) {
    logger.warn(`[MCP-OAuth] No refresh token available for ${server}`);
    return null;
  }

  const config = MCP_SERVERS[server];
  if (!config?.oauthConfig) {
    return null;
  }

  const { tokenUrl, clientId, clientSecret } = config.oauthConfig;

  try {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: storedToken.refreshToken,
      client_id: clientId,
    });

    if (clientSecret) {
      params.set("client_secret", clientSecret);
    }

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[MCP-OAuth] Token refresh failed for ${server}`, { error: errorText });
      // Delete invalid token
      deleteToken(server);
      return null;
    }

    const data = (await response.json()) as OAuthTokenResponse;

    const token: MCPOAuthToken = {
      server,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || storedToken.refreshToken,
      tokenType: data.token_type || "Bearer",
      scope: data.scope || storedToken.scope,
      authenticatedAt: new Date().toISOString(),
    };

    if (data.expires_in) {
      const expiresAt = new Date(Date.now() + data.expires_in * 1000);
      token.expiresAt = expiresAt.toISOString();
    }

    saveToken(token);
    return token;
  } catch (err: unknown) {
    logger.error("[MCP-OAuth] Error refreshing token", {
      error: errorMessage(err),
    });
    return null;
  }
}

/**
 * Get valid token for a server (refreshes if needed)
 */
export async function getValidToken(server: string): Promise<MCPOAuthToken | null> {
  const token = loadToken(server);
  if (!token) {
    return null;
  }

  if (isTokenExpired(token)) {
    logger.info(`[MCP-OAuth] Token expired for ${server}, attempting refresh`);
    return refreshAccessToken(server);
  }

  return token;
}

/**
 * Revoke OAuth token for a server
 */
export async function revokeToken(server: string): Promise<boolean> {
  const token = loadToken(server);
  if (!token) {
    return false;
  }

  // Delete from storage
  deleteToken(server);

  // Optionally call revocation endpoint if server supports it
  // This is not implemented as it varies per server

  logger.info(`[MCP-OAuth] Deleted local token for ${server}`);
  return true;
}
