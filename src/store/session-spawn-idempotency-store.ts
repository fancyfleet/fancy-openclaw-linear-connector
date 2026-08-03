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

/**
 * INF-1101: canonical `rotation_reason` recorded when the re-dispatch guard
 * rotates away from a HUSK bound session — one that produced zero assistant
 * turns and is older than the husk age floor. This is the timed-out / C-UNK
 * variant that has no transcript tail at all (so `terminal` is false) and never
 * completed (so `statusCompleted` is false); the old guard replayed it forever.
 * Read via `probeBoundSessionTerminal().husk`.
 */
export const HUSK_ROTATION_REASON = "husk-timeout";

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

  /**
   * INF-1088: TTL for a `live` claim that DOES carry a concrete session binding
   * (run_id/session_id). INF-1026's `isStaleInFlight` deliberately exempts these
   * (`state === "live" && (run_id || session_id) => return false`) on the
   * assumption that a bound session is genuinely in-flight and must never be
   * double-spawned. But nothing terminalizes these claims: when the bound session
   * ends, dies, or the INF-1003/INF-1074 terminal-rotation probe cannot read its
   * terminal state (no transcript, an index the probe can't resolve, a frozen
   * tail), the `live` row persists forever and every re-dispatch for that
   * (ticket, task_key) short-circuits as an idempotent replay. That is the
   * fleet-wide dispatch-freeze (478 live rows, 7 pending, zero terminal — no claim
   * ever released; INF-1088). This TTL is the probe-independent backstop: a live
   * claim whose last update predates it is treated as expired and re-spawned
   * instead of replayed. Set well beyond the runtime session timeout (~26 min,
   * same envelope as STALE_INFLIGHT_MS) so a genuinely active session — whose
   * claim was written at spawn and is never refreshed — is not double-spawned.
   */
  private static readonly LIVE_CLAIM_TTL_MS = 30 * 60 * 1000;

  private recordAgeMs(r: SessionSpawnRunRecord, now: number): number {
    const lastIso = r.updated_at || r.spawned_at || r.requested_at;
    const last = lastIso ? Date.parse(lastIso) : NaN;
    if (Number.isNaN(last)) return NaN;
    return now - last;
  }

  private isStaleInFlight(r: SessionSpawnRunRecord): boolean {
    if (r.state !== "live" && r.state !== "pending") return false;
    if (r.state === "live" && (r.run_id || r.session_id)) return false;
    const age = this.recordAgeMs(r, Date.now());
    if (Number.isNaN(age)) return false;
    return age > SessionSpawnIdempotencyStore.STALE_INFLIGHT_MS;
  }

  /**
   * INF-1088: a `live` claim WITH a concrete session binding whose last update
   * predates LIVE_CLAIM_TTL_MS. This is the case isStaleInFlight (INF-1026) does
   * not cover — the corpse that freezes a seat forever.
   */
  private isExpiredLiveClaim(r: SessionSpawnRunRecord): boolean {
    if (r.state !== "live") return false;
    if (!r.run_id && !r.session_id) return false; // handled by isStaleInFlight
    const age = this.recordAgeMs(r, Date.now());
    if (Number.isNaN(age)) return false;
    return age > SessionSpawnIdempotencyStore.LIVE_CLAIM_TTL_MS;
  }

  /**
   * INF-1088: a claim dedups a replay ONLY while it is a still-live reservation —
   * a `pending`/`live` record inside its liveness window. A terminal claim
   * (explicitly released, or any non-pending/live state) and a stale/expired one
   * must NOT be treated as a valid replay: they fall through so the seat re-spawns.
   * This is the single gate that closes the freeze — before INF-1088 the only
   * exclusions were isStaleInFlight, which exempted every bound `live` row.
   */
  private isReplayableClaim(r: SessionSpawnRunRecord): boolean {
    if (r.state !== "pending" && r.state !== "live") return false;
    if (this.isStaleInFlight(r)) return false;
    if (this.isExpiredLiveClaim(r)) return false;
    return true;
  }

  /**
   * Atomically reserve a run for (ticketId, taskKey), or return the existing
   * still-live pending/live record to the replaying caller. Terminal, stale, or
   * expired claims are reset to `pending` and re-spawned (INF-1026 / INF-1088).
   */
  beginOrGetExisting(input: SessionSpawnBeginInput): SessionSpawnBeginResult {
    const run = this.db.transaction((): SessionSpawnBeginResult => {
      const existing = this.inspect(input.ticketId, input.taskKey);
      if (existing && this.isReplayableClaim(existing)) {
        return { action: "return-existing", record: existing, existing };
      }

      const requestedAt = input.requestedAt ?? nowIso();

      if (existing) {
        // INF-1026 / INF-1088: the prior claim is not replayable — it is stale
        // (in-flight session died without clearing it), a live-but-expired corpse
        // past LIVE_CLAIM_TTL_MS, or explicitly released/terminal. Reset it to
        // `pending` and re-run the spawn instead of short-circuiting — this is what
        // lets a dark agent re-wake and what unfreezes a permanently-claimed seat.
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

  /**
   * INF-1088: explicit release — terminalize a claim so the seat is immediately
   * re-dispatchable without waiting for LIVE_CLAIM_TTL_MS. This is the
   * "release on session end/terminal" primitive: a session-lifecycle signal that
   * knows a bound session has ended can call this to free the (ticket, task_key)
   * seat right away, rather than leaving a `live` corpse for the TTL backstop to
   * reap. Sets the claim to a terminal `state` (default `completed`); a terminal
   * claim is not `isReplayableClaim`, so the next dispatch re-spawns.
   * Returns the updated record, or null when no claim exists for the key.
   */
  release(ticketId: string, taskKey: string, opts?: { state?: SessionSpawnRunState; observedAt?: string }): SessionSpawnRunRecord | null {
    const observedAt = opts?.observedAt ?? nowIso();
    const state = opts?.state ?? "completed";
    const result = this.db.prepare(
      `UPDATE session_spawn_runs
         SET state = ?, updated_at = ?
       WHERE ticket_id = ? AND task_key = ?`,
    ).run(state, observedAt, ticketId, taskKey);
    if (result.changes === 0) return null;
    const existing = this.inspect(ticketId, taskKey);
    return existing;
  }

  /**
   * INF-1088: proactively terminalize every `live`/`pending` claim whose last
   * update predates the staleness window, returning the count released. The lazy
   * path in `beginOrGetExisting` already unfreezes each seat on its next
   * re-dispatch, but the fleet-wide freeze left ~478 `live` + 7 `pending` corpse
   * rows that read as active until re-dispatched. This is the one-shot sweep to
   * release them all (e.g. at bootstrap or from an admin task) so monitoring and
   * the dedup guard both reflect reality. Conservative by construction: it only
   * touches rows already older than the TTL, so a genuinely in-flight session is
   * never released.
   */
  sweepExpiredClaims(opts?: { olderThanMs?: number; observedAt?: string }): { released: number } {
    const olderThanMs = opts?.olderThanMs ?? SessionSpawnIdempotencyStore.LIVE_CLAIM_TTL_MS;
    const observedAt = opts?.observedAt ?? nowIso();
    const cutoffIso = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db.prepare(
      `UPDATE session_spawn_runs
         SET state = 'completed', updated_at = ?
       WHERE state IN ('live', 'pending')
         AND COALESCE(updated_at, spawned_at, requested_at) < ?`,
    ).run(observedAt, cutoffIso);
    return { released: result.changes };
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
