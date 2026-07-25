import Database from "better-sqlite3";
import path from "path";
import { createLogger, componentLogger } from "../logger.js";

const log = componentLogger(createLogger(), "stale-redispatch-counter");

/**
 * How long a ticket may sit without a stall before the next stall counts as a
 * fresh burst (attempt 1) rather than compounding the old total. The escalation
 * ladder ("3 stalls → human") is meant to catch a ticket flapping *now*, not to
 * sum every stall over a long-lived ticket's entire life. Before INF-664 there
 * was no reset at all, so spawner stewards (INF-196, LIF-45, LIF-251) — which
 * are legitimately re-woken for days — climbed to 30+/3 and manufactured a
 * false human-escalation on every subsequent stall. Default 1h; override with
 * STALE_REDISPATCH_RESET_WINDOW_MS.
 */
const DEFAULT_RESET_WINDOW_MS = 60 * 60 * 1000;

function resolveResetWindowMs(): number {
  const raw = process.env.STALE_REDISPATCH_RESET_WINDOW_MS;
  if (!raw) return DEFAULT_RESET_WINDOW_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RESET_WINDOW_MS;
}

export class StaleRedispatchCounter {
  private db: Database.Database;
  private readonly resetWindowMs: number;

  constructor(dbPath?: string, resetWindowMs?: number) {
    const resolvedPath = dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "stale-redispatch-attempts.db");
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.resetWindowMs = resetWindowMs ?? resolveResetWindowMs();
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stale_redispatch_attempts (
        ticket_id        TEXT PRIMARY KEY,
        attempt_count    INTEGER NOT NULL DEFAULT 1,
        first_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_attempt_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  incrementAndGet(ticketId: string): number {
    // Reset a stale burst first: if the last stall for this ticket is older than
    // the reset window, drop the old total so this stall starts a fresh count of
    // consecutive-in-window stalls rather than compounding history (INF-664).
    const windowSeconds = Math.max(1, Math.round(this.resetWindowMs / 1000));
    const existing = this.db
      .prepare(
        `SELECT attempt_count,
                (strftime('%s','now') - strftime('%s', last_attempt_at)) AS age_seconds
           FROM stale_redispatch_attempts WHERE ticket_id = ?`,
      )
      .get(ticketId) as { attempt_count: number; age_seconds: number } | undefined;

    if (existing && existing.age_seconds > windowSeconds) {
      log.info(
        `Redispatch counter for ${ticketId} reset (last stall ${existing.age_seconds}s ago > ${windowSeconds}s window; was ${existing.attempt_count})`,
      );
      this.db
        .prepare(
          `UPDATE stale_redispatch_attempts
              SET attempt_count = 1, first_attempt_at = datetime('now'), last_attempt_at = datetime('now')
            WHERE ticket_id = ?`,
        )
        .run(ticketId);
      log.info(`Redispatch attempt 1 recorded for ticket ${ticketId}`);
      return 1;
    }

    this.db
      .prepare(
        `INSERT INTO stale_redispatch_attempts (ticket_id, attempt_count, first_attempt_at, last_attempt_at)
         VALUES (?, 1, datetime('now'), datetime('now'))
         ON CONFLICT(ticket_id) DO UPDATE SET
           attempt_count = attempt_count + 1,
           last_attempt_at = datetime('now')`,
      )
      .run(ticketId);

    const row = this.db
      .prepare(`SELECT attempt_count FROM stale_redispatch_attempts WHERE ticket_id = ?`)
      .get(ticketId) as { attempt_count: number } | undefined;

    const count = row?.attempt_count ?? 1;
    log.info(`Redispatch attempt ${count} recorded for ticket ${ticketId}`);
    return count;
  }

  get(ticketId: string): number {
    const row = this.db
      .prepare(`SELECT attempt_count FROM stale_redispatch_attempts WHERE ticket_id = ?`)
      .get(ticketId) as { attempt_count: number } | undefined;
    return row?.attempt_count ?? 0;
  }

  reset(ticketId: string): void {
    this.db.prepare(`DELETE FROM stale_redispatch_attempts WHERE ticket_id = ?`).run(ticketId);
    log.info(`Redispatch counter reset for ticket ${ticketId}`);
  }

  close(): void {
    this.db.close();
  }
}
