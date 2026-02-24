/**
 * Builds the list of repo remote URLs + PATs for writing .git-credentials in agent workspaces.
 * Used so agents can git fetch/push using per-repo PATs set in Settings.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { PERSISTENT_REPOS } from "./paths";
import { getRepoPat } from "./secrets-store";

const execFileAsync = promisify(execFile);

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

export interface RepoCredential {
  url: string;
  pat: string;
}

/** Returns credentials for all repos that have a PAT set. Used to write .git-credentials in workspace. */
export async function getRepoCredentialsForAgents(): Promise<RepoCredential[]> {
  const out: RepoCredential[] = [];
  if (!fs.existsSync(PERSISTENT_REPOS)) return out;

  const entries = fs
    .readdirSync(PERSISTENT_REPOS)
    .filter((f) => f.endsWith(".git") && fs.statSync(path.join(PERSISTENT_REPOS, f)).isDirectory());

  for (const entry of entries) {
    const repoName = entry.replace(/\.git$/, "");
    const pat = getRepoPat(repoName);
    if (!pat || pat.length === 0) continue;

    const repoPath = path.join(PERSISTENT_REPOS, entry);
    const url = await getRemoteUrl(repoPath);
    if (!url) continue;

    out.push({ url, pat });
  }

  return out;
}

/**
 * Build a single line for .git-credentials: https://oauth2:PAT@host/path (GitHub) or https://user:PAT@host/path.
 * Git uses the first matching URL. Returns "" for non-HTTPS (e.g. SSH) so we don't write useless lines.
 */
function credentialLine(url: string, pat: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") {
      return `https://oauth2:${pat}@${u.host}${u.pathname}`;
    }
  } catch {
    // ignore invalid URL
  }
  return "";
}

/**
 * Write .git-credentials in the workspace and return the path so callers can set GIT_CREDENTIAL_HELPER.
 */
export function writeGitCredentialsFile(workspaceDir: string, credentials: RepoCredential[]): string {
  const filePath = path.join(workspaceDir, ".git-credentials");
  if (credentials.length === 0) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore if missing */
    }
    return filePath;
  }

  const lines = credentials.map(({ url, pat }) => credentialLine(url, pat)).filter((line) => line.length > 0);
  if (lines.length === 0) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore if missing */
    }
    return filePath;
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { mode: 0o600 });
  return filePath;
}
