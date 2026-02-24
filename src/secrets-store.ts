/**
 * Encrypted secrets store for API keys and tokens set via Settings.
 * Stored on the backend only; env vars are still supported and override is store-first then env.
 * Login password (API_KEY) remains env-only and is never stored here.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger";
import { errorMessage } from "./types";

const PERSISTENT_BASE = "/persistent";
const FALLBACK_BASE = "/tmp";
const SECRETS_FILENAME = "secrets.enc";
const ALG = "aes-256-gcm";
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;

export type AnthropicStored = { key: string; mode: "openrouter" | "anthropic" };

export interface StoredSecrets {
  anthropic?: AnthropicStored;
  githubToken?: string;
  notionApiKey?: string;
  slackToken?: string;
  figmaToken?: string;
  linearApiKey?: string;
  /** PAT per repo (name without .git) */
  repoPats?: Record<string, string>;
}

function getSecretsPath(): string {
  const base = existsSync(PERSISTENT_BASE) ? PERSISTENT_BASE : FALLBACK_BASE;
  return path.join(base, SECRETS_FILENAME);
}

function getEncryptionKey(): Buffer {
  const fromEnv = process.env.SECRETS_ENCRYPTION_KEY;
  if (fromEnv && fromEnv.length >= 64 && /^[0-9a-fA-F]+$/.test(fromEnv.slice(0, 64))) {
    return Buffer.from(fromEnv.slice(0, 64), "hex");
  }
  if (fromEnv && fromEnv.length >= 16) {
    return createHash("sha256").update(fromEnv).digest();
  }
  const jwt = process.env.JWT_SECRET;
  if (jwt) {
    return scryptSync(jwt, "agent-manager-secrets", 32);
  }
  throw new Error("Secrets store requires SECRETS_ENCRYPTION_KEY or JWT_SECRET");
}

function encrypt(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  const authTag = (cipher as unknown as { getAuthTag(): Buffer }).getAuthTag();
  return Buffer.concat([iv, authTag, enc]);
}

function decrypt(buf: Buffer, key: Buffer): string {
  const iv = buf.subarray(0, IV_LEN);
  const authTag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const enc = buf.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  (decipher as unknown as { setAuthTag(tag: Buffer): void }).setAuthTag(authTag);
  return decipher.update(enc).toString("utf-8") + decipher.final("utf-8");
}

let inMemory: StoredSecrets = {};
let key: Buffer | null = null;

function loadKey(): Buffer {
  if (key) return key;
  key = getEncryptionKey();
  return key;
}

function loadFromDisk(): StoredSecrets {
  const filePath = getSecretsPath();
  if (!existsSync(filePath)) return {};
  try {
    const buf = readFileSync(filePath);
    const k = loadKey();
    const raw = decrypt(buf, k);
    return JSON.parse(raw) as StoredSecrets;
  } catch (err: unknown) {
    logger.warn("[secrets-store] Failed to load secrets file", { path: filePath, error: errorMessage(err) });
    return {};
  }
}

function saveToDisk(data: StoredSecrets): void {
  const filePath = getSecretsPath();
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const k = loadKey();
  const plain = JSON.stringify(data);
  const buf = encrypt(plain, k);
  writeFileSync(filePath, buf, { mode: 0o600 });
}

function readAll(): StoredSecrets {
  if (Object.keys(inMemory).length === 0) {
    inMemory = loadFromDisk();
  }
  return { ...inMemory };
}

function writeAll(data: StoredSecrets): void {
  inMemory = data;
  saveToDisk(data);
}

/** Load stored secrets into process.env so existing code keeps working. Call at startup and after any update. */
export function loadSecretsIntoEnv(): void {
  const s = readAll();
  if (s.anthropic) {
    if (s.anthropic.mode === "openrouter") {
      process.env.ANTHROPIC_AUTH_TOKEN = s.anthropic.key;
      process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = s.anthropic.key;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  }
  if (s.githubToken !== undefined) process.env.GITHUB_TOKEN = s.githubToken || undefined;
  if (s.notionApiKey !== undefined) process.env.NOTION_API_KEY = s.notionApiKey || undefined;
  if (s.slackToken !== undefined) process.env.SLACK_TOKEN = s.slackToken || undefined;
  if (s.figmaToken !== undefined) process.env.FIGMA_TOKEN = s.figmaToken || undefined;
  if (s.linearApiKey !== undefined) process.env.LINEAR_API_KEY = s.linearApiKey || undefined;
}

// ─── Getters (hints only for API responses; never return raw secrets) ────────

export function getAnthropicHint(): { hint: string; mode: "openrouter" | "anthropic" } | null {
  const s = readAll();
  if (!s.anthropic?.key) return null;
  const k = s.anthropic.key;
  return { hint: k.length > 8 ? `...${k.slice(-8)}` : "(set)", mode: s.anthropic.mode };
}

export function getIntegrationHints(): Record<string, { configured: boolean }> {
  const s = readAll();
  return {
    github: { configured: !!(s.githubToken && s.githubToken.length > 0) },
    notion: { configured: !!(s.notionApiKey && s.notionApiKey.length > 0) },
    slack: { configured: !!(s.slackToken && s.slackToken.length > 0) },
    figma: { configured: !!(s.figmaToken && s.figmaToken.length > 0) },
    linear: { configured: !!(s.linearApiKey && s.linearApiKey.length > 0) },
  };
}

export function hasRepoPat(repoName: string): boolean {
  const s = readAll();
  const pat = s.repoPats?.[repoName];
  return !!(pat && pat.length > 0);
}

export function getRepoPat(repoName: string): string | undefined {
  const s = readAll();
  return s.repoPats?.[repoName];
}

/** All repo names that have a PAT set (for building git credentials). */
export function getRepoPatEntries(): Array<{ repoName: string; pat: string }> {
  const s = readAll();
  const entries: Array<{ repoName: string; pat: string }> = [];
  if (!s.repoPats) return entries;
  for (const [name, pat] of Object.entries(s.repoPats)) {
    if (pat && pat.length > 0) entries.push({ repoName: name, pat });
  }
  return entries;
}

// ─── Setters (persist and optionally sync to env) ───────────────────────────

export function setAnthropic(key: string, mode: "openrouter" | "anthropic"): void {
  const s = readAll();
  s.anthropic = { key, mode };
  writeAll(s);
  loadSecretsIntoEnv();
}

export function setIntegration(name: "github" | "notion" | "slack" | "figma" | "linear", value: string): void {
  const s = readAll();
  if (name === "github") s.githubToken = value;
  else if (name === "notion") s.notionApiKey = value;
  else if (name === "slack") s.slackToken = value;
  else if (name === "figma") s.figmaToken = value;
  else if (name === "linear") s.linearApiKey = value;
  writeAll(s);
  loadSecretsIntoEnv();
}

export function setRepoPat(repoName: string, pat: string): void {
  const s = readAll();
  if (!s.repoPats) s.repoPats = {};
  if (pat.trim().length === 0) {
    delete s.repoPats[repoName];
  } else {
    s.repoPats[repoName] = pat.trim();
  }
  writeAll(s);
}

/** Get GitHub token for clone (store first, then env). */
export function getGitHubTokenForClone(): string | undefined {
  const s = readAll();
  if (s.githubToken && s.githubToken.length > 0) return s.githubToken;
  return process.env.GITHUB_TOKEN;
}
