import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { errorMessage } from "./types";

// Always store SQLite on local filesystem - WAL mode requires POSIX mmap/flock
// semantics that GCS FUSE does not support. Data persists for the container lifetime;
// for cross-restart persistence, the DB would need a backup/restore mechanism.
const DB_DIR = "/tmp/cost-data";
const DB_PATH = path.join(DB_DIR, "costs.db");

export interface CostRecord {
  agentId: string;
  agentName: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  estimatedCost: number;
  createdAt: string;
  closedAt: string | null;
}

export interface CostHistorySummary {
  allTimeCost: number;
  allTimeTokensIn: number;
  allTimeTokensOut: number;
  totalRecords: number;
}

/**
 * Persistent cost tracker backed by SQLite (better-sqlite3).
 *
 * Stores its own copy of cost data independent of the agent map so that
 * doDestroy() can finalize records even after agents.delete(id) has run.
 * All operations are synchronous (better-sqlite3 is sync by design).
 */
export class CostTracker {
  private db: Database.Database;
  private upsertStmt: Database.Statement;
  private finalizeStmt: Database.Statement;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? DB_PATH;
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cost_records (
        agent_id TEXT NOT NULL PRIMARY KEY,
        agent_name TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        estimated_cost REAL DEFAULT 0,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.upsertStmt = this.db.prepare(`
      INSERT INTO cost_records (agent_id, agent_name, model, tokens_in, tokens_out, estimated_cost, created_at)
      VALUES (@agentId, @agentName, @model, @tokensIn, @tokensOut, @estimatedCost, @createdAt)
      ON CONFLICT(agent_id) DO UPDATE SET
        tokens_in = @tokensIn,
        tokens_out = @tokensOut,
        estimated_cost = @estimatedCost
    `);

    this.finalizeStmt = this.db.prepare(`
      UPDATE cost_records SET closed_at = @closedAt WHERE agent_id = @agentId
    `);
  }

  /** Insert or update a cost record for an agent. Called when usage data changes. */
  upsert(record: {
    agentId: string;
    agentName: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    estimatedCost: number;
    createdAt: string;
  }): void {
    try {
      this.upsertStmt.run(record);
    } catch (err: unknown) {
      console.warn("[cost-tracker] Failed to upsert:", errorMessage(err));
    }
  }

  /** Mark an agent's cost record as closed (agent destroyed). */
  finalize(agentId: string): void {
    try {
      this.finalizeStmt.run({ agentId, closedAt: new Date().toISOString() });
    } catch (err: unknown) {
      console.warn("[cost-tracker] Failed to finalize:", errorMessage(err));
    }
  }

  /** Get all cost records, newest first. */
  getAll(limit = 500): CostRecord[] {
    return this.db
      .prepare(
        `SELECT agent_id as agentId, agent_name as agentName, model,
                tokens_in as tokensIn, tokens_out as tokensOut,
                estimated_cost as estimatedCost, created_at as createdAt,
                closed_at as closedAt
         FROM cost_records ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as CostRecord[];
  }

  /** Get all-time aggregate summary. */
  getSummary(): CostHistorySummary {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(estimated_cost), 0) as allTimeCost,
                COALESCE(SUM(tokens_in), 0) as allTimeTokensIn,
                COALESCE(SUM(tokens_out), 0) as allTimeTokensOut,
                COUNT(*) as totalRecords
         FROM cost_records`,
      )
      .get() as CostHistorySummary;
    return row;
  }

  /** Delete all historical records. */
  reset(): { deleted: number } {
    const result = this.db.prepare("DELETE FROM cost_records").run();
    return { deleted: result.changes };
  }

  /** Get the spend limit (null = no limit set). */
  getSpendLimit(): number | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'spend_limit'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    const n = Number.parseFloat(row.value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** Set the spend limit. Pass null to remove the limit. */
  setSpendLimit(limit: number | null): void {
    if (limit === null || limit <= 0) {
      this.db.prepare("DELETE FROM settings WHERE key = 'spend_limit'").run();
    } else {
      this.db
        .prepare(
          "INSERT INTO settings (key, value) VALUES ('spend_limit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(limit));
    }
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
