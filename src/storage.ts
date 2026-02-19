import { existsSync, type FSWatcher, mkdirSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "./types";
import { getContextDir } from "./utils/context";
import { walkDir } from "./utils/files";

const GCS_BUCKET = process.env.GCS_BUCKET;
const HOME = process.env.HOME || "/home/agent";
const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(HOME, ".claude");
const SHARED_CONTEXT_DIR = getContextDir();
const GITCONFIG = path.join(HOME, ".gitconfig");

// When FUSE is mounted, shared-context is directly on GCS — no sync needed
const FUSE_ACTIVE = SHARED_CONTEXT_DIR.startsWith("/persistent");

let periodicSyncInterval: ReturnType<typeof setInterval> | null = null;
let contextWatcher: FSWatcher | null = null;
let contextSyncTimeout: ReturnType<typeof setTimeout> | null = null;
// biome-ignore lint/suspicious/noExplicitAny: GCS Storage is dynamically imported
let storage: any = null;
let syncInProgress = false;
let debouncedSyncTimer: ReturnType<typeof setTimeout> | null = null;
let debouncedSyncResolvers: Array<() => void> = [];

const RETRY_DELAYS = [100, 200, 400];
const DEBOUNCE_MS = 5_000;

/** Yield to the event loop so health checks and other handlers can run between file uploads. */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function retryWithBackoff<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      if (attempt < RETRY_DELAYS.length) {
        console.warn(
          `[retry] ${label} failed (attempt ${attempt + 1}/${RETRY_DELAYS.length + 1}), retrying in ${RETRY_DELAYS[attempt]}ms...`,
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }
  throw lastErr;
}

async function getStorage() {
  if (!GCS_BUCKET) return null;
  if (storage) return storage;
  try {
    const { Storage } = await import("@google-cloud/storage");
    storage = new Storage();
    return storage;
  } catch {
    console.warn("@google-cloud/storage not available, GCS sync disabled");
    return null;
  }
}

async function downloadDir(prefix: string, localDir: string): Promise<void> {
  const gcs = await getStorage();
  if (!gcs || !GCS_BUCKET) return;

  try {
    await retryWithBackoff(async () => {
      const bucket = gcs.bucket(GCS_BUCKET);
      const [files] = await bucket.getFiles({ prefix });

      mkdirSync(localDir, { recursive: true });

      for (const file of files) {
        const relativePath = file.name.slice(prefix.length);
        if (!relativePath || relativePath.endsWith("/")) continue;

        const localPath = path.join(localDir, relativePath);
        mkdirSync(path.dirname(localPath), { recursive: true });

        const [contents] = await file.download();
        writeFileSync(localPath, contents);
        await yieldToEventLoop();
      }
      console.log(`Synced from GCS: ${prefix} → ${localDir} (${files.length} files)`);
    }, `downloadDir(${prefix})`);
  } catch (err: unknown) {
    console.warn(`GCS download failed for ${prefix}:`, errorMessage(err));
  }
}

async function uploadDir(localDir: string, prefix: string): Promise<void> {
  const gcs = await getStorage();
  if (!gcs || !GCS_BUCKET) return;

  if (!existsSync(localDir)) return;

  try {
    await retryWithBackoff(async () => {
      const bucket = gcs.bucket(GCS_BUCKET);
      const files = walkDir(localDir);

      for (const filePath of files) {
        const relativePath = path.relative(localDir, filePath);
        const gcsPath = `${prefix}${relativePath}`;
        await bucket.upload(filePath, { destination: gcsPath });
        await yieldToEventLoop();
      }
      console.log(`Synced to GCS: ${localDir} → ${prefix} (${files.length} files)`);
    }, `uploadDir(${localDir})`);
  } catch (err: unknown) {
    console.warn(`GCS upload failed for ${localDir}:`, errorMessage(err));
  }
}

async function downloadFile(gcsPath: string, localPath: string): Promise<void> {
  const gcs = await getStorage();
  if (!gcs || !GCS_BUCKET) return;
  try {
    await retryWithBackoff(async () => {
      const bucket = gcs.bucket(GCS_BUCKET);
      const [exists] = await bucket.file(gcsPath).exists();
      if (!exists) return;
      const [contents] = await bucket.file(gcsPath).download();
      mkdirSync(path.dirname(localPath), { recursive: true });
      writeFileSync(localPath, contents);
      console.log(`Synced from GCS: ${gcsPath} → ${localPath}`);
    }, `downloadFile(${gcsPath})`);
  } catch (err: unknown) {
    console.warn(`GCS download failed for ${gcsPath}:`, errorMessage(err));
  }
}

async function uploadFile(localPath: string, gcsPath: string): Promise<void> {
  const gcs = await getStorage();
  if (!gcs || !GCS_BUCKET) return;
  if (!existsSync(localPath)) return;
  try {
    await retryWithBackoff(async () => {
      const bucket = gcs.bucket(GCS_BUCKET);
      await bucket.upload(localPath, { destination: gcsPath });
      console.log(`Synced to GCS: ${localPath} → ${gcsPath}`);
    }, `uploadFile(${localPath})`);
  } catch (err: unknown) {
    console.warn(`GCS upload failed for ${localPath}:`, errorMessage(err));
  }
}

async function deleteFile(gcsPath: string): Promise<void> {
  const gcs = await getStorage();
  if (!gcs || !GCS_BUCKET) return;
  try {
    await retryWithBackoff(async () => {
      const bucket = gcs.bucket(GCS_BUCKET);
      const [exists] = await bucket.file(gcsPath).exists();
      if (!exists) {
        console.log(`File not found in GCS, skipping: ${gcsPath}`);
        return;
      }
      await bucket.file(gcsPath).delete();
      console.log(`Deleted from GCS: ${gcsPath}`);
    }, `deleteFile(${gcsPath})`);
  } catch (err: unknown) {
    console.warn(`GCS deletion failed for ${gcsPath}:`, errorMessage(err));
  }
}

/**
 * Remove stale Claude Code session data from ~/.claude that was created by
 * destroyed/expired agent workspaces.  Claude Code creates per-project dirs
 * under `projects/`, `todos/`, `debug/`, and `shell-snapshots/` keyed by
 * workspace path.  Because agent workspaces are ephemeral
 * (`/tmp/workspace-{uuid}`), these accumulate without bound.
 *
 * @param activeWorkspaceDirs - Set of workspace directory paths belonging to
 *   agents that are still active (will be preserved).
 */
export async function cleanupClaudeHome(activeWorkspaceDirs: Set<string>): Promise<void> {
  const activeUUIDs = new Set<string>();
  for (const dir of activeWorkspaceDirs) {
    const match = dir.match(/workspace-([0-9a-f-]+)/);
    if (match) activeUUIDs.add(match[1]);
  }

  let localCleaned = 0;
  const gcsPrefixesToDelete: string[] = [];

  // Clean projects/ — each subdir is named like `-tmp-workspace-{uuid}`
  const projectsDir = path.join(CLAUDE_HOME, "projects");
  if (existsSync(projectsDir)) {
    try {
      for (const entry of readdirSync(projectsDir)) {
        const match = entry.match(/workspace-([0-9a-f-]+)/);
        if (!match) continue;
        if (activeUUIDs.has(match[1])) continue;
        const fullPath = path.join(projectsDir, entry);
        try {
          rmSync(fullPath, { recursive: true, force: true });
          localCleaned++;
          gcsPrefixesToDelete.push(`claude-home/projects/${entry}/`);
        } catch {}
      }
    } catch {}
  }

  // Clean todos/ — files/dirs named like `-tmp-workspace-{uuid}...`
  const todosDir = path.join(CLAUDE_HOME, "todos");
  if (existsSync(todosDir)) {
    try {
      for (const entry of readdirSync(todosDir)) {
        const match = entry.match(/workspace-([0-9a-f-]+)/);
        if (!match) continue;
        if (activeUUIDs.has(match[1])) continue;
        try {
          rmSync(path.join(todosDir, entry), { recursive: true, force: true });
          localCleaned++;
          gcsPrefixesToDelete.push(`claude-home/todos/${entry}`);
        } catch {}
      }
    } catch {}
  }

  // Trim debug/ and shell-snapshots/ to the newest MAX_KEPT files
  const MAX_KEPT = 20;
  for (const subdir of ["debug", "shell-snapshots"]) {
    const dir = path.join(CLAUDE_HOME, subdir);
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir)
        .map((name) => {
          try {
            return { name, mtime: statSync(path.join(dir, name)).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((e): e is { name: string; mtime: number } => e !== null)
        .sort((a, b) => b.mtime - a.mtime);

      for (const entry of entries.slice(MAX_KEPT)) {
        try {
          rmSync(path.join(dir, entry.name), { recursive: true, force: true });
          localCleaned++;
          gcsPrefixesToDelete.push(`claude-home/${subdir}/${entry.name}`);
        } catch {}
      }
    } catch {}
  }

  if (localCleaned > 0) {
    console.log(`[cleanup] Removed ${localCleaned} stale claude-home entries locally`);
  }

  // Delete stale entries from GCS so they don't get re-downloaded on next cold start
  if (gcsPrefixesToDelete.length > 0) {
    deleteGCSPrefixes(gcsPrefixesToDelete).catch((err: unknown) => {
      console.warn("[cleanup] GCS stale entry deletion failed:", errorMessage(err));
    });
  }
}

/** Delete multiple GCS objects/prefixes in parallel batches. */
async function deleteGCSPrefixes(prefixes: string[]): Promise<void> {
  const gcs = await getStorage();
  if (!gcs || !GCS_BUCKET) return;

  const bucket = gcs.bucket(GCS_BUCKET);
  let deleted = 0;

  const BATCH = 20;
  for (let i = 0; i < prefixes.length; i += BATCH) {
    const batch = prefixes.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (prefix) => {
        try {
          if (prefix.endsWith("/")) {
            const [files] = await bucket.getFiles({ prefix });
            await Promise.all(files.map((f: { delete: () => Promise<unknown> }) => f.delete().catch(() => {})));
            deleted += files.length;
          } else {
            await bucket
              .file(prefix)
              .delete()
              .catch(() => {});
            deleted++;
          }
        } catch {}
      }),
    );
    await yieldToEventLoop();
  }

  if (deleted > 0) {
    console.log(`[cleanup] Deleted ${deleted} stale file(s) from GCS claude-home/`);
  }
}

/**
 * Clean up a single agent's Claude Code project data when it's destroyed.
 * Removes `~/.claude/projects/-tmp-workspace-{uuid}` and matching todos.
 */
export async function cleanupAgentClaudeData(workspaceDir: string): Promise<void> {
  const match = workspaceDir.match(/workspace-([0-9a-f-]+)/);
  if (!match) return;

  const slug = workspaceDir.replace(/\//g, "-").replace(/^-/, "");
  let cleaned = 0;
  const gcsToDelete: string[] = [];

  const projectDir = path.join(CLAUDE_HOME, "projects", slug);
  try {
    await fsPromises.rm(projectDir, { recursive: true, force: true });
    cleaned++;
    gcsToDelete.push(`claude-home/projects/${slug}/`);
  } catch {
    // Directory may not exist — that's fine
  }

  const todosDir = path.join(CLAUDE_HOME, "todos");
  try {
    const entries = await fsPromises.readdir(todosDir);
    for (const entry of entries) {
      if (entry.includes(match[1])) {
        try {
          await fsPromises.rm(path.join(todosDir, entry), { recursive: true, force: true });
          cleaned++;
          gcsToDelete.push(`claude-home/todos/${entry}`);
        } catch {}
      }
    }
  } catch {
    // Directory may not exist — that's fine
  }

  if (cleaned > 0) {
    console.log(`[cleanup] Removed ${cleaned} claude-home entries for workspace ${match[1].slice(0, 8)}`);
    deleteGCSPrefixes(gcsToDelete).catch(() => {});
  }
}

export async function syncFromGCS(): Promise<void> {
  if (!GCS_BUCKET) {
    console.log("GCS_BUCKET not set, skipping GCS sync");
    return;
  }
  console.log("Syncing from GCS...");
  await downloadDir("claude-home/", CLAUDE_HOME);
  // Restore ~/CLAUDE.md (user-level instructions, lives outside ~/.claude/)
  await downloadFile("home-claude-md", path.join(HOME, "CLAUDE.md"));
  if (!FUSE_ACTIVE) {
    await downloadDir("shared-context/", SHARED_CONTEXT_DIR);
  }
  // SSH keys are excluded from GCS sync — they must not be stored in plaintext.
  // Provision SSH keys via Secret Manager or build-time injection instead.
  await downloadFile("gitconfig", GITCONFIG);
}

export async function syncContextFile(filename: string): Promise<void> {
  const localPath = path.join(SHARED_CONTEXT_DIR, filename);
  if (!existsSync(localPath)) return;
  await uploadFile(localPath, `shared-context/${filename}`);
}

export async function deleteContextFile(filename: string): Promise<void> {
  await deleteFile(`shared-context/${filename}`);
}

export async function syncClaudeHome(): Promise<void> {
  await uploadDir(CLAUDE_HOME, "claude-home/");
  // Also sync ~/CLAUDE.md (user-level instructions, lives outside ~/.claude/)
  const homeClaude = path.join(HOME, "CLAUDE.md");
  if (existsSync(homeClaude)) {
    await uploadFile(homeClaude, "home-claude-md");
  }
}

export async function syncToGCS(): Promise<void> {
  if (!GCS_BUCKET) return;
  if (syncInProgress) {
    console.log("[sync] syncToGCS already in progress, skipping");
    return;
  }
  syncInProgress = true;
  try {
    console.log("Syncing to GCS...");
    await uploadDir(CLAUDE_HOME, "claude-home/");
    // Also sync ~/CLAUDE.md (user-level instructions, lives outside ~/.claude/)
    const homeClaude = path.join(HOME, "CLAUDE.md");
    if (existsSync(homeClaude)) {
      await uploadFile(homeClaude, "home-claude-md");
    }
    if (!FUSE_ACTIVE) {
      await uploadDir(SHARED_CONTEXT_DIR, "shared-context/");
    }
    // SSH keys are excluded from GCS sync — they must not be stored in plaintext.
    await uploadFile(GITCONFIG, "gitconfig");
  } finally {
    syncInProgress = false;
  }
}

/**
 * Debounced version of syncToGCS that coalesces rapid-fire calls (e.g. from
 * multiple agents finishing close together) into a single sync after a delay.
 */
export function debouncedSyncToGCS(): Promise<void> {
  return new Promise<void>((resolve) => {
    debouncedSyncResolvers.push(resolve);
    if (debouncedSyncTimer) clearTimeout(debouncedSyncTimer);
    debouncedSyncTimer = setTimeout(async () => {
      debouncedSyncTimer = null;
      const resolvers = debouncedSyncResolvers;
      debouncedSyncResolvers = [];
      try {
        await syncToGCS();
      } catch (err: unknown) {
        console.warn("[sync] Debounced syncToGCS failed:", errorMessage(err));
      }
      for (const r of resolvers) r();
    }, DEBOUNCE_MS);
  });
}

const ABOUT_YOU_CONTENT = `<!-- summary: Agent identity, communication methods, collaboration protocol, capabilities, platform context -->
You are a **Claude agent** running on the **Claude Swarm** platform. You are part of a multi-agent system where multiple Claude instances work together on tasks.

## What you are
- A Claude Code CLI process running in an isolated workspace at \`/tmp/workspace-{uuid}/\`
- Connected to a shared context directory (\`shared-context/\`) that all agents can read and write
- Connected to a **message bus** for real-time communication with other agents
- Able to **spawn sub-agents** and **destroy them** via the platform API

## How you communicate
- **Message Bus (primary):** Use \`curl\` to send/receive structured messages via \`http://localhost:8080/api/messages\`. Your CLAUDE.md has your auth token and agent ID.
- **Shared Context (secondary):** Read/write \`.md\` files in \`shared-context/\` for persistent notes, decisions, and long-form documentation.
- **Working Memory:** Maintain \`shared-context/working-memory-{your-name}.md\` so other agents and the human operator can see your real-time status.

## How you collaborate
1. **Check messages** when starting work and periodically during long tasks
2. **Announce your status** by posting to the message bus so others know what you're doing
3. **Check the agent registry** before starting work to see who else is active and avoid duplicate effort
4. **Delegate tasks** by spawning sub-agents or sending task messages to existing agents
5. **Share results** by posting result messages back to whoever requested work

## Your capabilities
- Full access to Bash, file tools (Read/Write/Edit/Glob/Grep), web tools (WebFetch/WebSearch)
- **MCP tools for Figma and Linear** (token auth pre-configured) — use MCP tools directly; fall back to \`/figma\` or \`/linear\` slash commands if tools don't load
- Can clone and work with git repositories via persistent bare clones
- Can install tools to \`/persistent/tools/\` (persists across restarts)
- Can create slash command skills shared across all agents
- Can call the platform API to manage agents, messages, and configuration
`;

const BACKLOG_CONTENT = `<!-- summary: Project backlog -->

# Product Backlog

> Last groomed: 
> Sources: 
> Prioritization: 

## Open — Prioritized

---
`;

const REPOSITORY_CONTENT = `<!-- summary: Claude Swarm repo structure, stack (TS/Express/React/Vite/GCP), and dev commands -->
Claude Swarm Platform — manages and orchestrates Claude agent workspaces.

## Stack

| Layer | Tech |
|-------|------|
| Backend | TypeScript, Express 5, Node (tsx) |
| Frontend | React, Vite, Tailwind, React Router |
| Infra | Terraform → GCP Cloud Run, GCS |
| Container | Dockerfile + entrypoint.sh |
| MCP | Claude Code MCP server config (\`mcp/\`) |

## Structure

\`\`\`
server.ts          # Express entry point
src/
  agents.ts        # Agent orchestration logic
  auth.ts          # Authentication
  guardrails.ts    # Safety/guardrails
  storage.ts       # GCS storage layer
  types.ts         # Shared types
  validation.ts    # Input validation
ui/                # React SPA (Vite)
  src/
    App.tsx, pages/, components/, hooks/, api.ts, auth.tsx
terraform/         # GCP infra (Cloud Run, IAM, secrets, storage)
mcp/               # MCP server settings template
\`\`\`

## Commands

\`\`\`bash
npm run dev        # Run server + UI concurrently
npm run dev:server # Server only
npm run build      # Build UI (Vite)
npm start          # Production server
\`\`\`

## Notes
- Env config via \`.env\` (see \`.env.example\`)
- This repo IS the platform running the agents — modifying it modifies the system itself
`;

const UX_ROADMAP_CONTENT = `<!-- summary: UX improvement roadmap -->

# UX Improvement Roadmap

> Author: 
> Date: 
> Scope:
> Context:

---
`;

/** Default shared-context files seeded on first startup. */
const DEFAULT_CONTEXT_FILES: Record<string, string> = {
  "about-you.md": ABOUT_YOU_CONTENT,
  "backlog.md": BACKLOG_CONTENT,
  "repository.md": REPOSITORY_CONTENT,
  "ux-roadmap.md": UX_ROADMAP_CONTENT,
};

/**
 * Ensure default shared-context files exist.
 * Called at startup after GCS sync so we don't overwrite user edits
 * that were already synced from GCS.
 */
export function ensureDefaultContextFiles(): void {
  mkdirSync(SHARED_CONTEXT_DIR, { recursive: true });
  for (const [filename, content] of Object.entries(DEFAULT_CONTEXT_FILES)) {
    const filePath = path.join(SHARED_CONTEXT_DIR, filename);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content);
      console.log(`[context] Created default ${filename} in shared context`);
    }
  }
}

export function startPeriodicSync(): void {
  if (!GCS_BUCKET) return;

  // Watch shared-context for changes and sync immediately (debounced 3s)
  // Skip when FUSE is active — files are already on GCS
  if (!FUSE_ACTIVE) {
    mkdirSync(SHARED_CONTEXT_DIR, { recursive: true });
    try {
      contextWatcher = watch(SHARED_CONTEXT_DIR, (_eventType, filename) => {
        if (!filename) return;
        // Debounce: wait 3s after last change before syncing
        if (contextSyncTimeout) clearTimeout(contextSyncTimeout);
        contextSyncTimeout = setTimeout(async () => {
          try {
            console.log(`[sync] Shared context changed, syncing to GCS...`);
            await uploadDir(SHARED_CONTEXT_DIR, "shared-context/");
          } catch (err: unknown) {
            console.warn("Context watch sync failed:", errorMessage(err));
          }
        }, 3_000);
      });
      console.log(`[sync] Watching ${SHARED_CONTEXT_DIR} for changes`);
    } catch (err: unknown) {
      console.warn(`[sync] Could not watch ${SHARED_CONTEXT_DIR}:`, errorMessage(err));
    }
  } else {
    console.log("[sync] FUSE active, skipping shared-context watch/sync");
  }

  // Also sync everything every 5 minutes as a safety net
  periodicSyncInterval = setInterval(async () => {
    try {
      if (!FUSE_ACTIVE) {
        await uploadDir(SHARED_CONTEXT_DIR, "shared-context/");
      }
      await uploadDir(CLAUDE_HOME, "claude-home/");
    } catch (err: unknown) {
      console.warn("Periodic GCS sync failed:", errorMessage(err));
    }
  }, 5 * 60_000);
}

export function stopPeriodicSync(): void {
  if (periodicSyncInterval) {
    clearInterval(periodicSyncInterval);
    periodicSyncInterval = null;
  }
  if (contextWatcher) {
    contextWatcher.close();
    contextWatcher = null;
  }
  if (contextSyncTimeout) {
    clearTimeout(contextSyncTimeout);
    contextSyncTimeout = null;
  }
  if (debouncedSyncTimer) {
    clearTimeout(debouncedSyncTimer);
    debouncedSyncTimer = null;
    // Resolve pending callers — shutdown will run syncToGCS() directly, so they don't need to wait
    for (const r of debouncedSyncResolvers) r();
    debouncedSyncResolvers = [];
  }
}
