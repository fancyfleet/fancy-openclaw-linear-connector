/**
 * INF-1277 AC1/AC4 — durable transition-audit persistence store.
 *
 * Persists every governed transition (ticket, intent, from→to, agent, status,
 * code, detail, gateResults, label-mismatch flag, timestamp) to a SQLite
 * store so records survive process restarts (AC4) and are queryable by the
 * admin console (AC2).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface TransitionAuditGateResult {
  name: string;
  passed: boolean;
  detail: string | null;
}

export interface TransitionAuditPersistInput {
  ticket: string;
  intent: string;
  fromState: string | null;
  toState: string | null;
  agent: string | null;
  status: "applied" | "noop" | "blocked" | "failed";
  code: string;
  detail: string | null;
  gateResults: TransitionAuditGateResult[];
  labelMismatch: boolean | null;
  ts?: string;
}

export interface TransitionAuditPersistedRecord extends Omit<TransitionAuditPersistInput, "ts"> {
  id: number;
  ts: string;
}

export interface TransitionAuditQuery {
  ticket?: string;
  status?: string;
  code?: string;
  since?: string;
  until?: string;
  limit?: number;
}

function parseGateResults(value: string): TransitionAuditGateResult[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as TransitionAuditGateResult[]) : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: Record<string, unknown>): TransitionAuditPersistedRecord {
  return {
    id: Number(row.id),
    ticket: String(row.ticket),
    intent: String(row.intent),
    fromState: (row.from_state as string | null) ?? null,
    toState: (row.to_state as string | null) ?? null,
    agent: (row.agent as string | null) ?? null,
    status: row.status as TransitionAuditPersistInput["status"],
    code: String(row.code),
    detail: (row.detail as string | null) ?? null,
    gateResults: parseGateResults(String(row.gate_results_json ?? "[]")),
    labelMismatch: row.label_mismatch === null || row.label_mismatch === undefined
      ? null
      : Boolean(row.label_mismatch),
    ts: String(row.ts),
  };
}

export class TransitionAuditStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(
      process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
      "transition-audit.db",
    );
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transition_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        ticket TEXT NOT NULL,
        intent TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        agent TEXT,
        status TEXT NOT NULL,
        code TEXT NOT NULL,
        detail TEXT,
        gate_results_json TEXT NOT NULL DEFAULT '[]',
        label_mismatch INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_transition_audit_ticket_ts ON transition_audit(ticket, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_transition_audit_status_ts ON transition_audit(status, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_transition_audit_code_ts ON transition_audit(code, ts DESC);
    `);
  }

  record(input: TransitionAuditPersistInput): number {
    const result = this.db.prepare(`
      INSERT INTO transition_audit (
        ts, ticket, intent, from_state, to_state, agent, status, code, detail,
        gate_results_json, label_mismatch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.ts ?? new Date().toISOString(),
      input.ticket,
      input.intent,
      input.fromState ?? null,
      input.toState ?? null,
      input.agent ?? null,
      input.status,
      input.code,
      input.detail ?? null,
      JSON.stringify(input.gateResults ?? []),
      input.labelMismatch === null || input.labelMismatch === undefined ? null : (input.labelMismatch ? 1 : 0),
    );
    return Number(result.lastInsertRowid);
  }

  /** Backfill the label-mismatch flag once post-transition verification resolves. */
  updateLabelMismatch(id: number, labelMismatch: boolean): void {
    this.db.prepare(`UPDATE transition_audit SET label_mismatch = ? WHERE id = ?`)
      .run(labelMismatch ? 1 : 0, id);
  }

  query(filter: TransitionAuditQuery): TransitionAuditPersistedRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.ticket) { clauses.push("ticket = ?"); params.push(filter.ticket); }
    if (filter.status) { clauses.push("status = ?"); params.push(filter.status); }
    if (filter.code) { clauses.push("code = ?"); params.push(filter.code); }
    if (filter.since) { clauses.push("ts >= ?"); params.push(filter.since); }
    if (filter.until) { clauses.push("ts <= ?"); params.push(filter.until); }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT * FROM transition_audit ${where} ORDER BY ts DESC, id DESC LIMIT ?`,
    ).all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  close(): void {
    this.db.close();
  }
}
