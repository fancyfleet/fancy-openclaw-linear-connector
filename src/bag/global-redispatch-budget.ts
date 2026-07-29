/**
 * GlobalRedispatchBudget — unified per-session redispatch budget across all detectors.
 *
 * Problem: Stale-session recovery (stale-session-forensics), no-activity detection
 * (NoActivityDetector), and dispatch-watchdog each maintained independent counters
 * for how many times a ticket had been re-dispatched. A ticket could cycle through:
 *   C4 stale recovery (3x) → no-activity redispatch (3x) → watchdog redispatch (3x)
 * for 9+ total attempts before escalation reached a human.
 *
 * This module replaces the per-detector counters with a SINGLE SQLite-backed budget
 * that all three detectors share. Once the ticket hits the global cap, EVERY detector
 * escalates immediately — no more "max re-dispatch reached: 3/3" messages that the
 * next detector ignores.
 *
 * Usage:
 *   const budget = new GlobalRedispatchBudget();
 *   const attempts = budget.consume("INF-982");        // records + returns total
 *   const capped = attempts >= budget.maxAttempts;      // check if capped
 *   budget.reset("INF-982");                             // clear on successful dispatch
 *   budget.close();
 *
 * DB: shares the DATA_DIR/re-dispatch-budget.db file.
 * Schema: single table tracking cumulative attempts per ticket ID.
 */

import Database from "better-sqlite3";
import path from "path";
import { createLogger, componentLogger } from "../logger.js";

const log = componentLogger(createLogger(), "global-redispatch-budget");

const DEFAULT_MAX_ATTEMPTS = 3;

export interface RedispatchBudgetConfig {
  /** Directory for the SQLite DB. Defaults to DATA_DIR or cwd/data. */
  dbDir?: string;
  /** Global max re-dispatch attempts before escalation. Default: 3. */
  maxAttempts?: number;
}

export class GlobalRedispatchBudget {
  private db: Database.Database;
  public readonly maxAttempts: number;

  constructor(config: RedispatchBudgetConfig = {}) {
    const dbDir = config.dbDir ?? process.env.DATA_DIR ?? path.join(process.cwd(), "data");
    const resolvedPath = path.join(dbDir, "re-dispatch-budget.db");
    this.maxAttempts = config.maxAttempts ?? parseInt(
      process.env.GLOBAL_REDISPATCH_MAX_ATTEMPTS ?? String(DEFAULT_MAX_ATTEMPTS),
      10,
    );
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS global_redispatch_budget (
        ticket_id          TEXT PRIMARY KEY,
        attempt_count      INTEGER NOT NULL DEFAULT 1,
        first_attempt_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_attempt_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /**
   * Record one re-dispatch attempt for the given ticket.
   * Returns the cumulative attempt count AFTER this increment.
   */
  consume(ticketId: string): number {
    this.db
      .prepare(
        `INSERT INTO global_redispatch_budget (ticket_id, attempt_count, first_attempt_at, last_attempt_at)
         VALUES (?, 1, datetime('now'), datetime('now'))
         ON CONFLICT(ticket_id) DO UPDATE SET
           attempt_count = attempt_count + 1,
           last_attempt_at = datetime('now')`,
      )
      .run(ticketId);

    const row = this.db
      .prepare(`SELECT attempt_count FROM global_redispatch_budget WHERE ticket_id = ?`)
      .get(ticketId) as { attempt_count: number } | undefined;

    const count = row?.attempt_count ?? 1;
    log.debug(`Redispatch budget consumed for ${ticketId}: attempt ${count}/${this.maxAttempts}`);
    return count;
  }

  /**
   * Read the current attempt count without incrementing.
   */
  get(ticketId: string): number {
    const row = this.db
      .prepare(`SELECT attempt_count FROM global_redispatch_budget WHERE ticket_id = ?`)
      .get(ticketId) as { attempt_count: number } | undefined;
    return row?.attempt_count ?? 0;
  }

  /**
   * Check whether the ticket has exceeded the global budget.
   */
  isCapped(ticketId: string): boolean {
    return this.get(ticketId) >= this.maxAttempts;
  }

  /**
   * Returns true once the ticket reaches or exceeds the global cap.
   * Unlike isCapped(), this ALSO records one final attempt marker so
   * subsequent detectors see the cap too, even without calling consume().
   * Call this when a detector needs to "lock" the cap for other detectors.
   */
  seal(ticketId: string): boolean {
    const count = this.consume(ticketId);
    const capped = count >= this.maxAttempts;
    if (capped) {
      log.warn(`Redispatch budget SEALED for ${ticketId}: ${count}/${this.maxAttempts} — all detectors will escalate`);
    }
    return capped;
  }

  /**
   * Clear the budget for a ticket (successful fresh dispatch).
   */
  reset(ticketId: string): void {
    this.db.prepare(`DELETE FROM global_redispatch_budget WHERE ticket_id = ?`).run(ticketId);
    log.debug(`Redispatch budget reset for ${ticketId}`);
  }

  /**
   * Return all currently-tracked tickets and their attempt counts.
   */
  list(): Array<{ ticketId: string; attemptCount: number; firstAttemptAt: string; lastAttemptAt: string }> {
    const rows = this.db
      .prepare(`SELECT ticket_id, attempt_count, first_attempt_at, last_attempt_at FROM global_redispatch_budget ORDER BY last_attempt_at DESC`)
      .all() as Array<{
        ticket_id: string;
        attempt_count: number;
        first_attempt_at: string;
        last_attempt_at: string;
      }>;
    return rows.map((r) => ({
      ticketId: r.ticket_id,
      attemptCount: r.attempt_count,
      firstAttemptAt: r.first_attempt_at,
      lastAttemptAt: r.last_attempt_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
