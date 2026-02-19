import fs from "node:fs";
import path from "node:path";

const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(process.env.HOME || "/home/agent", ".claude");
const HOME = process.env.HOME || "/home/agent";

/**
 * Resolve a path to its real location, following symlinks if the file exists.
 * Falls back to path.resolve() for paths that don't exist yet (e.g. new files
 * being written for the first time).
 */
function safeRealpath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    // File doesn't exist yet — resolve without symlink expansion
    return path.resolve(filePath);
  }
}

export function isAllowedConfigPath(filePath: string): boolean {
  // Reject paths containing ".." segments before resolution
  if (filePath.includes("..")) {
    return false;
  }

  // Resolve symlinks so a symlink pointing outside the allowed tree is rejected
  const resolved = safeRealpath(filePath);

  return (
    resolved.startsWith(safeRealpath(CLAUDE_HOME)) ||
    resolved === safeRealpath(path.join(HOME, ".claude.json")) ||
    resolved === safeRealpath(path.join(HOME, "CLAUDE.md")) ||
    resolved === safeRealpath(path.join(process.cwd(), "CLAUDE.md")) ||
    resolved === safeRealpath(path.join(process.cwd(), "mcp", "settings-template.json"))
  );
}

/**
 * Reject symlinks on write operations — callers should use this before writing
 * to any config path to prevent symlink-based write attacks.
 */
export function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

export { CLAUDE_HOME, HOME };
