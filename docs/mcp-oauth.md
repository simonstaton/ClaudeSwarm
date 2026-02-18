# MCP OAuth Integration

> **For agents**: This is an operator/developer reference. Do NOT attempt OAuth flows from agent sessions — token auth is already pre-configured. Use MCP tools directly, or fall back to `/linear` and `/figma` slash commands. See `home-claude.md` for agent guidance.

This document describes the OAuth authentication flow for MCP servers (Figma and Linear) in the Claude Swarm platform. OAuth is a **fallback for human operators** who need to authenticate via browser.

## Overview

The MCP OAuth integration allows human operators to authenticate with external services (Figma, Linear) through their browser once, and have that authentication available to all agents running on the platform. Tokens are persisted across container restarts. In practice, **token auth (via env vars) is the standard method** — OAuth is only needed if tokens are not configured.

## Architecture

### Components

1. **Token Storage** (`src/mcp-oauth-storage.ts`)
   - Persists OAuth tokens to `/persistent/mcp-tokens/`
   - JSON file per server: `figma.json`, `linear.json`
   - Handles token loading, saving, deletion, and expiry checking

2. **OAuth Manager** (`src/mcp-oauth-manager.ts`)
   - Manages OAuth flow: authorization URL generation, state validation, token exchange
   - Handles token refresh for expired tokens
   - CSRF protection via state tokens (10-minute expiry)

3. **API Routes** (`src/routes/mcp.ts`)
   - `GET /api/mcp/servers` - List all MCP servers and auth status
   - `POST /api/mcp/auth/:server` - Initiate OAuth flow
   - `GET /api/mcp/callback` - OAuth callback endpoint
   - `GET /api/mcp/token/:server` - Get token status
   - `DELETE /api/mcp/token/:server` - Revoke token

4. **Entrypoint Integration** (`entrypoint.sh`)
   - On container startup, checks for stored OAuth tokens
   - Injects valid tokens into MCP settings
   - Priority: stored OAuth token > env var token > OAuth flow

### OAuth Flow

```
┌──────┐                ┌─────────────┐                ┌──────────┐
│ User │                │ Claude Swarm│                │ MCP      │
│      │                │   Platform  │                │ Server   │
└──┬───┘                └──────┬──────┘                └────┬─────┘
   │                           │                            │
   │ 1. POST /api/mcp/auth/figma                           │
   ├──────────────────────────>│                            │
   │                           │                            │
   │ 2. OAuth URL (with state) │                            │
   │<──────────────────────────┤                            │
   │                           │                            │
   │ 3. Open auth URL in browser                           │
   ├───────────────────────────┼────────────────────────────>│
   │                           │                            │
   │ 4. User authenticates     │                            │
   │<──────────────────────────┼────────────────────────────┤
   │                           │                            │
   │ 5. Redirect to /api/mcp/callback?code=...&state=...   │
   │───────────────────────────>│                            │
   │                           │                            │
   │                           │ 6. Exchange code for token │
   │                           ├────────────────────────────>│
   │                           │                            │
   │                           │ 7. Access token            │
   │                           │<────────────────────────────┤
   │                           │                            │
   │                           │ 8. Save to /persistent/mcp-tokens/
   │                           │                            │
   │ 9. Success page           │                            │
   │<──────────────────────────┤                            │
   │                           │                            │
```

## Usage

### For End Users

#### Authenticating with Figma or Linear

1. Make a POST request to initiate OAuth:
   ```bash
   curl -X POST http://localhost:8080/api/mcp/auth/figma \
     -H "Authorization: Bearer $TOKEN"
   ```

2. Response includes the authorization URL:
   ```json
   {
     "authUrl": "https://mcp.figma.com/oauth/authorize?client_id=...&state=...",
     "message": "Visit this URL in your browser to authenticate",
     "server": "figma"
   }
   ```

3. Open the `authUrl` in your browser and authenticate

4. After authentication, you'll be redirected to the callback URL and see a success message

5. The token is now stored and available to all agents

#### Checking Authentication Status

```bash
curl http://localhost:8080/api/mcp/servers \
  -H "Authorization: Bearer $TOKEN"
```

Response:
```json
{
  "servers": [
    {
      "name": "figma",
      "type": "http",
      "url": "https://mcp.figma.com/mcp",
      "authRequired": true,
      "authMethod": "oauth",
      "authenticated": true,
      "authenticatedAt": "2026-02-18T18:00:00Z",
      "configured": true,
      "tokenExpired": false
    }
  ]
}
```

#### Revoking Authentication

```bash
curl -X DELETE http://localhost:8080/api/mcp/token/figma \
  -H "Authorization: Bearer $TOKEN"
```

### For Developers

#### Adding a New OAuth-Enabled MCP Server

1. Update `src/mcp-oauth-manager.ts` to add the server configuration:
   ```typescript
   export const MCP_SERVERS: Record<string, MCPServerConfig> = {
     newserver: {
       name: "newserver",
       type: "http",
       url: "https://mcp.newserver.com/mcp",
       authMethod: "oauth",
       oauthConfig: {
         authUrl: "https://newserver.com/oauth/authorize",
         tokenUrl: "https://newserver.com/oauth/token",
         clientId: process.env.NEWSERVER_OAUTH_CLIENT_ID || "claude-swarm",
         clientSecret: process.env.NEWSERVER_OAUTH_CLIENT_SECRET,
         scope: "read write",
       },
     },
   };
   ```

2. Update `mcp/settings-template.json`:
   ```json
   {
     "mcpServers": {
       "newserver": {
         "type": "http",
         "url": "https://mcp.newserver.com/mcp",
         "_tokenEnv": "NEWSERVER_API_KEY",
         "_tokenHeader": "Authorization",
         "_tokenPrefix": "Bearer ",
         "_alwaysActivate": true
       }
     }
   }
   ```

3. Set environment variables (optional):
   ```bash
   NEWSERVER_OAUTH_CLIENT_ID=your_client_id
   NEWSERVER_OAUTH_CLIENT_SECRET=your_client_secret
   ```

## Security Considerations

### CSRF Protection
- State tokens are generated using cryptographically secure random bytes
- State tokens expire after 10 minutes
- Each state token is single-use only

### Token Storage
- Tokens stored in `/persistent/mcp-tokens/` (outside git)
- File permissions restrict access to agent user only
- Tokens never exposed in logs or API responses

### Token Expiry
- Tokens with `expiresAt` are validated before use
- Automatic refresh attempted if `refreshToken` is available
- Falls back to OAuth re-authentication if refresh fails

### Rate Limiting
- All API endpoints protected by platform rate limiting middleware
- State token cleanup prevents memory exhaustion attacks

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `MCP_TOKEN_DIR` | Directory for token storage | No (defaults to `/persistent/mcp-tokens`) |
| `PUBLIC_URL` | Public URL for OAuth callbacks | No (defaults to `http://localhost:8080`) |
| `FIGMA_OAUTH_CLIENT_ID` | Figma OAuth client ID | No (defaults to `claude-swarm`) |
| `FIGMA_OAUTH_CLIENT_SECRET` | Figma OAuth client secret | No |
| `LINEAR_OAUTH_CLIENT_ID` | Linear OAuth client ID | No (defaults to `claude-swarm`) |
| `LINEAR_OAUTH_CLIENT_SECRET` | Linear OAuth client secret | No |

## Troubleshooting

### "Invalid or expired state token"
- State tokens expire after 10 minutes
- Start the OAuth flow again by calling `POST /api/mcp/auth/:server`

### "Token exchange failed"
- Check that OAuth client credentials are correct
- Verify the callback URL is registered with the MCP server
- Check server logs for detailed error messages

### Token not persisting across restarts
- Ensure `/persistent` is mounted and writable
- Check that `MCP_TOKEN_DIR` environment variable is set correctly
- Verify file permissions on the token directory

### Agents can't access authenticated services
- Check that tokens are being injected into MCP settings (see container logs on startup)
- Verify token hasn't expired: `GET /api/mcp/token/:server`
- Try re-authenticating: `DELETE /api/mcp/token/:server` then `POST /api/mcp/auth/:server`

## API Reference

### GET /api/mcp/servers
List all configured MCP servers and their authentication status.

**Response:**
```json
{
  "servers": [
    {
      "name": "figma",
      "type": "http",
      "url": "https://mcp.figma.com/mcp",
      "authRequired": true,
      "authMethod": "oauth",
      "authenticated": true,
      "authenticatedAt": "2026-02-18T18:00:00Z",
      "configured": true,
      "tokenExpired": false
    }
  ]
}
```

### POST /api/mcp/auth/:server
Initiate OAuth flow for a specific server.

**Parameters:**
- `server` (path) - Server name (figma, linear)

**Response:**
```json
{
  "authUrl": "https://mcp.figma.com/oauth/authorize?...",
  "message": "Visit this URL in your browser to authenticate",
  "server": "figma"
}
```

### GET /api/mcp/callback
OAuth callback endpoint. Automatically called by MCP servers after user authentication.

**Query Parameters:**
- `code` - Authorization code
- `state` - CSRF protection token
- `error` - Error code (if authentication failed)
- `error_description` - Error description

**Response:** HTML success or error page

### GET /api/mcp/token/:server
Get current token status for a server.

**Parameters:**
- `server` (path) - Server name

**Response:**
```json
{
  "server": "figma",
  "authenticated": true,
  "tokenType": "Bearer",
  "scope": "mcp:connect",
  "authenticatedAt": "2026-02-18T18:00:00Z",
  "expiresAt": "2026-02-19T18:00:00Z",
  "expired": false
}
```

### DELETE /api/mcp/token/:server
Revoke OAuth token for a server.

**Parameters:**
- `server` (path) - Server name

**Response:**
```json
{
  "success": true,
  "message": "Token revoked for figma"
}
```

## References

- [Figma MCP Remote Server Documentation](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
- [Linear MCP Server Documentation](https://linear.app/docs/mcp)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [OAuth 2.0 RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)
