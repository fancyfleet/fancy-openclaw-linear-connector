/**
 * INF-879 — Durable sessions_spawn task-key idempotency.
 *
 * Keyed on (ticket_id, task_key) so a webhook/cron replay for the same unit of
 * work observes the already-started run instead of minting a second session.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type SessionSpawnRuntime = "codex" | "openclaw-acp" | string;
export type SessionSpawnRunState = "pending" | "live" | "completed" | "failed" | "blocked" | string;

/**
 * INF-1003: session states that mean the bound transcript is dead and will
 * produce no further turns. Re-dispatching onto such a binding resumes a frozen
 * session (the LIF-338 C3 silent-completion loop), so the re-dispatch path
 * rotates to a fresh session instead of replaying. `stop` is the codex-mirrored
 * `stopReason: stop` terminal turn seen in the INF-958 incident.
 */
const TERMINAL_SESSION_STATES = new Set<SessionSpawnRunState>(["stop"]);

/**
 * INF-1003: if `state` is terminal, return the rotation reason to record on the
 * fresh binding (`rotation_reason`); otherwise null (idempotent replay stands).
 */
export function terminalRotationReason(state: SessionSpawnRunState): string | null {
  return TERMINAL_SESSION_STATES.has(state) ? "terminal-stop" : null;
}

export interface SessionSpawnBeginInput {
  ticketId: string;
  taskKey: string;
  runtime: SessionSpawnRuntime;
  agentId: string;
  sessionKey: string;
  requestedAt?: string;
}

export interface SessionSpawnMarkSpawnedInput {
  runId: string;
  sessionId: string;
  state: SessionSpawnRunState;
  observedAt?: string;
  runtimeStatePath?: string | null;
  /**
   * INF-1003: when this spawn rotated away from a terminal bound session, the
   * session_id of the released (dead) session. Recorded as `rotation_from_session_id`
   * so the old→new rotation is observable at ac-validate without replaying the loop.
   */
  rotationFromSessionId?: string | null;
  /** INF-1003: why the rotation happened (e.g. `terminal-stop`). */
  rotationReason?: string | null;
}

export interface SessionSpawnRunRecord {
  id: number;
  ticket_id: string;
  task_key: string;
  runtime: string;
  agent_id: string;
  session_key: string;
  run_id: string | null;
  session_id: string | null;
  state: SessionSpawnRunState;
  requested_at: string;
  spawned_at: string | null;
  updated_at: string;
  runtime_state_path: string | null;
  /** INF-1003: session_id of the terminal binding this run rotated away from (null when no rotation). */
  rotation_from_session_id: string | null;
  /** INF-1003: reason the rotation occurred, e.g. `terminal-stop` (null when no rotation). */
  rotation_reason: string | null;
}

export interface SessionSpawnBeginResult {
  action: "start-new" | "return-existing";
  record: SessionSpawnRunRecord;
  existing: SessionSpawnRunRecord | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SessionSpawnIdempotencyStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(
      process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
      "session-spawn-idempotency.db",
    );
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_spawn_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        task_key TEXT NOT NULL,
        runtime TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        run_id TEXT,
        session_id TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        requested_at TEXT NOT NULL,
        spawned_at TEXT,
        updated_at TEXT NOT NULL,
        runtime_state_path TEXT,
        rotation_from_session_id TEXT,
        rotation_reason TEXT,
        UNIQUE (ticket_id, task_key)
      );
      CREATE INDEX IF NOT EXISTS idx_session_spawn_runs_ticket
        ON session_spawn_runs (ticket_id, task_key);
      CREATE INDEX IF NOT EXISTS idx_session_spawn_runs_session
        ON session_spawn_runs (session_key);
      CREATE INDEX IF NOT EXISTS idx_session_spawn_runs_run
        ON session_spawn_runs (run_id);
    `);
    // INF-1003: additive columns for the terminal-session rotation guard. Older
    // DBs predate them; ADD COLUMN is idempotent-guarded via PRAGMA table_info.
    this.ensureColumn("rotation_from_session_id", "TEXT");
    this.ensureColumn("rotation_reason", "TEXT");
  }

  private ensureColumn(name: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(session_spawn_runs)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === name)) {
      this.db.exec(`ALTER TABLE session_spawn_runs ADD COLUMN ${name} ${type}`);
    }
  }

  private rowById(id: number): SessionSpawnRunRecord {
    const row = this.db.prepare(
      `SELECT id, ticket_id, task_key, runtime, agent_id, session_key, run_id, session_id,
              state, requested_at, spawned_at, updated_at, runtime_state_path,
              rotation_from_session_id, rotation_reason
       FROM session_spawn_runs
       WHERE id = ?`,
    ).get(id) as SessionSpawnRunRecord | undefined;
    if (!row) throw new Error(`session spawn run ${id} was not found`);
    return row;
  }

  /**
   * Atomically reserve a run for (ticketId, taskKey), or return the existing
   * pending/live/completed record to the replaying caller.
   */
  beginOrGetExisting(input: SessionSpawnBeginInput): SessionSpawnBeginResult {
    const run = this.db.transaction((): SessionSpawnBeginResult => {
      const existing = this.inspect(input.ticketId, input.taskKey);
      if (existing) {
        return { action: "return-existing", record: existing, existing };
      }

      const requestedAt = input.requestedAt ?? nowIso();
      const result = this.db.prepare(
        `INSERT INTO session_spawn_runs
           (ticket_id, task_key, runtime, agent_id, session_key, state, requested_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        input.ticketId,
        input.taskKey,
        input.runtime,
        input.agentId,
        input.sessionKey,
        requestedAt,
        requestedAt,
      );

      const record = this.rowById(Number(result.lastInsertRowid));
      return { action: "start-new", record, existing: null };
    });

    return run();
  }

  markSpawned(id: number, input: SessionSpawnMarkSpawnedInput): SessionSpawnRunRecord {
    const observedAt = input.observedAt ?? nowIso();
    const result = this.db.prepare(
      `UPDATE session_spawn_runs
       SET run_id = ?,
           session_id = ?,
           state = ?,
           spawned_at = COALESCE(spawned_at, ?),
           updated_at = ?,
           runtime_state_path = COALESCE(?, runtime_state_path),
           rotation_from_session_id = COALESCE(?, rotation_from_session_id),
           rotation_reason = COALESCE(?, rotation_reason)
       WHERE id = ?`,
    ).run(
      input.runId,
      input.sessionId,
      input.state,
      observedAt,
      observedAt,
      input.runtimeStatePath ?? null,
      input.rotationFromSessionId ?? null,
      input.rotationReason ?? null,
      id,
    );
    if (result.changes === 0) throw new Error(`session spawn run ${id} was not found`);
    return this.rowById(id);
  }

  inspect(ticketId: string, taskKey: string): SessionSpawnRunRecord | null {
    const row = this.db.prepare(
      `SELECT id, ticket_id, task_key, runtime, agent_id, session_key, run_id, session_id,
              state, requested_at, spawned_at, updated_at, runtime_state_path,
              rotation_from_session_id, rotation_reason
       FROM session_spawn_runs
       WHERE ticket_id = ? AND task_key = ?`,
    ).get(ticketId, taskKey) as SessionSpawnRunRecord | undefined;
    return row ?? null;
  }

  listByTicket(ticketId: string): SessionSpawnRunRecord[] {
    return this.db.prepare(
      `SELECT id, ticket_id, task_key, runtime, agent_id, session_key, run_id, session_id,
              state, requested_at, spawned_at, updated_at, runtime_state_path,
              rotation_from_session_id, rotation_reason
       FROM session_spawn_runs
       WHERE ticket_id = ?
       ORDER BY requested_at ASC, id ASC`,
    ).all(ticketId) as SessionSpawnRunRecord[];
  }

  close(): void {
    this.db.close();
  }
}
