import type { StreamEvent } from "./types";

const REDACTED = "[REDACTED]";

function getSecretPatterns(): string[] {
  const secretEnvVars = [
    "AGENT_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "GITHUB_TOKEN",
    "JWT_SECRET",
    "API_KEY",
    "NOTION_API_KEY",
    "SLACK_TOKEN",
    "GCS_BUCKET",
  ];

  const values: string[] = [];
  for (const key of secretEnvVars) {
    const val = process.env[key];
    // Only include values long enough to be meaningful (avoid matching short strings like "1" or "true")
    if (val && val.length >= 8) {
      values.push(val);
    }
  }
  return values;
}

let cachedPatterns: string[] | null = null;

function getPatterns(): string[] {
  if (!cachedPatterns) {
    cachedPatterns = getSecretPatterns();
  }
  return cachedPatterns;
}

/** Reset the cached patterns (useful when env vars change, e.g. API key rotation). */
export function resetSanitizeCache(): void {
  cachedPatterns = null;
}

function sanitizeString(input: string, patterns: string[]): string {
  let result = input;
  for (const secret of patterns) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

function sanitizeValue(value: unknown, patterns: string[]): unknown {
  if (typeof value === "string") {
    return sanitizeString(value, patterns);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, patterns));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = sanitizeValue(v, patterns);
    }
    return result;
  }
  return value;
}

/** Sanitize a StreamEvent, replacing any known secret values with [REDACTED]. */
export function sanitizeEvent(event: StreamEvent): StreamEvent {
  const patterns = getPatterns();
  if (patterns.length === 0) return event;
  return sanitizeValue(event, patterns) as StreamEvent;
}
