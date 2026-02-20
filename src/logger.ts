/**
 * Structured logger for the ClaudeSwarm server.
 *
 * - In production (NODE_ENV=production): emits newline-delimited JSON to stdout/stderr,
 *   suitable for Cloud Run log ingestion and structured log filtering.
 * - In development: emits human-readable coloured text to stdout/stderr.
 *
 * Pass `agentId` in the meta object to correlate server-side log entries with a
 * specific agent; the field is included in the JSON output so operators can filter
 * Cloud Run logs by agent ID.
 */

const isProduction = process.env.NODE_ENV === "production";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Optional structured metadata attached to a log entry. */
export interface LogMeta {
  agentId?: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, meta?: LogMeta): void {
  if (isProduction) {
    const entry: Record<string, unknown> = {
      level,
      timestamp: new Date().toISOString(),
      message,
      ...meta,
    };
    const line = JSON.stringify(entry);
    if (level === "error" || level === "warn") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  } else {
    const ts = new Date().toISOString();
    const tag = `[${ts}] [${level.toUpperCase().padEnd(5)}]`;
    const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    const line = `${tag} ${message}${metaStr}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

export const logger = {
  debug(message: string, meta?: LogMeta): void {
    // Only emit debug in non-production or when LOG_LEVEL=debug is set
    if (!isProduction || process.env.LOG_LEVEL === "debug") {
      emit("debug", message, meta);
    }
  },

  info(message: string, meta?: LogMeta): void {
    emit("info", message, meta);
  },

  warn(message: string, meta?: LogMeta): void {
    emit("warn", message, meta);
  },

  error(message: string, meta?: LogMeta): void {
    emit("error", message, meta);
  },
};
