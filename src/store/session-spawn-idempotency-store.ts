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
 * INF-1003: canonical `rotation_reason` recorded when the re-dispatch guard
 * rotates away from a terminal bound session. Terminal-ness is NOT read from the
 * `state` column above — that column's production domain is only `pending`/`live`
 * and never carries `stop`. The real signal is the bound session's last-assistant
 * `stopReason: stop`, probed from the live transcript by `probeBoundSessionTerminal`
 * in `bag/stale-session-forensics.ts`.
 */
export const TERMINAL_STOP_ROTATION_REASON = "terminal-stop";

/**
 * INF-1074: canonical `rotation_reason` recorded when the re-dispatch guard
 * rotates away from a bound session the OpenClaw session index marks
 * `status: "completed"`. This is the lifecycle signal the INF-1003 terminal-tail
 * guard did not consult: a session can be marked completed while its transcript
 * tail is a `tool_use`, an empty/frozen tail, or absent — none of which normalize
 * to `end_turn` — so `probeBoundSessionTerminal().terminal` stays false and the
 * old guard replayed the dead completed transcript (the ENG-5 zero-output C3
 * husk). Rotating on `status: "completed"` closes that gap. Read from the index
 * `status` column via `probeBoundSessionTerminal().statusCompleted`.
 */
export const COMPLETED_STATUS_ROTATION_REASON = "completed-status";

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
   * INF-1026: a `live`/`pending` spawn record whose last update predates this
   * window is treated as a DEAD session. The runtime times out (~26 min) without
   * clearing its record and nothing else moves a record out of `live`, so without
   * this bound the first session's record short-circuits every future wake and the
   * (ticket, task) becomes permanently un-wakeable — the agent goes dark forever,
   * across restarts (the record is persisted). Set safely beyond the runtime
   * timeout so a genuinely in-flight session is never double-spawned.
   */
  private static readonly STALE_INFLIGHT_MS = 30 * 60 * 1000;

  private isStaleInFlight(r: SessionSpawnRunRecord): boolean {
    if (r.state !== "live" && r.state !== "pending") return false;
    if (r.state === "live" && (r.run_id || r.session_id)) return false;
    const lastIso = r.updated_at || r.spawned_at || r.requested_at;
    const last = lastIso ? Date.parse(lastIso) : NaN;
    if (Number.isNaN(last)) return false;
    return Date.now() - last > SessionSpawnIdempotencyStore.STALE_INFLIGHT_MS;
  }

  /**
   * Atomically reserve a run for (ticketId, taskKey), or return the existing
   * pending/live/completed record to the replaying caller.
   */
  beginOrGetExisting(input: SessionSpawnBeginInput): SessionSpawnBeginResult {
    const run = this.db.transaction((): SessionSpawnBeginResult => {
      const existing = this.inspect(input.ticketId, input.taskKey);
      if (existing && !this.isStaleInFlight(existing)) {
        return { action: "return-existing", record: existing, existing };
      }

      const requestedAt = input.requestedAt ?? nowIso();

      if (existing) {
        // INF-1026: the prior in-flight record is stale (its session died without
        // clearing it). Reset it to `pending` and re-run the spawn instead of
        // short-circuiting on a corpse — this is what lets a dark agent re-wake.
        this.db.prepare(
          `UPDATE session_spawn_runs
             SET state = 'pending', run_id = NULL, session_id = NULL,
                 requested_at = ?, spawned_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(requestedAt, requestedAt, existing.id);
        return { action: "start-new", record: this.rowById(existing.id), existing: null };
      }

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
