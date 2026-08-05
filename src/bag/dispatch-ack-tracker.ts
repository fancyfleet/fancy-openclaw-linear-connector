/**
 * DispatchAckTracker — per-ticket dispatch acknowledgment state for the watchdog.
 *
 * Tracks every successful wake-up dispatch (agent, ticket). The watchdog queries
 * this store to find dispatches that have not been acknowledged within a timeout
 * window, then re-signals or escalates them.
 *
 * Acknowledgment sources:
 *   - /session-end callback fires → agent ran, work was picked up
 *   - Watchdog auto-acknowledges a ticket that disappears from the pending bag
 *     (implies the agent pulled it via linear queue)
 *
 * Schema note: UNIQUE(agent_id, ticket_id) means repeated dispatches to the same
 * agent+ticket update last_signal_at and increment attempt_count rather than
 * creating a new row. This keeps the table small and preserves the original
 * dispatched_at for age calculations.
 */

import Database from "better-sqlite3";
import path from "path";
import { createModuleLogger } from "../logging.js";
import { normalizeSessionKey } from "../session-key.js";
import { emitStreamTopic } from "../admin-stream.js";

const log = createModuleLogger("dispatch-ack-tracker", "info");

export type AckStatus = "pending" | "acknowledged" | "unconfirmed" | "escalated" | "deferred";

export interface DispatchAckEntry {
  id: number;
  agentId: string;
  ticketId: string;
  dispatchedAt: string;
  lastSignalAt: string;
  ackStatus: AckStatus;
  attemptCount: number;
  /** AI-2118: consecutive re-dispatch DELIVERY failures (wake-up threw / was
   *  skipped). Distinct from attemptCount, which counts only re-dispatches that
   *  actually started. Reset to 0 whenever a re-dispatch is admitted. */
  failureCount: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class DispatchAckTracker {
  private db: Database.Database;
  private ttlMs: number;
  /**
   * INF-1101: called whenever a ticket crosses the fresh-work-phase boundary —
   * a genuine new dispatch (recordDispatch) or an explicit escalated-row re-arm
   * (clearEscalated). Wired in index.ts to `globalRedispatchBudget.reset` so the
   * per-ticket redispatch budget seal and the escalated ack row clear TOGETHER;
   * clearing only one still silent-parks a legitimately re-dispatched ticket.
   * The internal no-activity / watchdog / stale retry loops do NOT call
   * recordDispatch (they use markResignaled + budget.consume), so a genuine loop
   * with no real new work phase never triggers this and still seals at the cap.
   */
  private onFreshDispatch?: (ticketId: string) => void;

  constructor(dbPath?: string, ttlMs?: number, onFreshDispatch?: (ticketId: string) => void) {
    const resolvedPath =
      dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "dispatch-acks.db");
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    this.onFreshDispatch = onFreshDispatch;
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_acks (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id       TEXT NOT NULL,
        ticket_id      TEXT NOT NULL,
        dispatched_at  TEXT NOT NULL DEFAULT (datetime('now')),
        last_signal_at TEXT NOT NULL DEFAULT (datetime('now')),
        ack_status     TEXT NOT NULL DEFAULT 'pending',
        attempt_count  INTEGER NOT NULL DEFAULT 1,
        UNIQUE(agent_id, ticket_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_acks_status
        ON dispatch_acks(ack_status, last_signal_at);
      CREATE INDEX IF NOT EXISTS idx_dispatch_acks_agent
        ON dispatch_acks(agent_id);
    `);
    // AI-2118: separate counter for consecutive re-dispatch DELIVERY failures.
    // Guarded ADD COLUMN so pre-existing DBs migrate in place.
    const cols = this.db
      .prepare(`PRAGMA table_info(dispatch_acks)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "redispatch_failure_count")) {
      this.db.exec(
        `ALTER TABLE dispatch_acks ADD COLUMN redispatch_failure_count INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }

  /**
   * Record a successful dispatch for a (agent, ticket) pair.
   *
   * If an entry already exists and is still pending/unconfirmed, updates
   * last_signal_at and increments attempt_count (idempotent re-signal tracking).
   * If it was previously acknowledged, resets to pending (re-delegation case).
   *
   * INF-1101: an `escalated` row is now ALSO re-armed to `pending` on a genuine
   * new dispatch, with attempt_count and the delivery-failure streak reset to a
   * fresh phase. Previously an escalated row survived a legitimate post-review
   * re-dispatch untouched — invisible to the no-activity ladder (which only sees
   * pending/unconfirmed) — so the ticket silently parked (INF-862/INF-761
   * re-crossings). recordDispatch is the "new-dispatch identity" boundary, so it
   * also fires onFreshDispatch to clear the sibling redispatch-budget seal.
   */
  recordDispatch(agentId: string, ticketId: string): void {
    const normalizedId = normalizeSessionKey(ticketId);
    this.db
      .prepare(
        `INSERT INTO dispatch_acks
           (agent_id, ticket_id, dispatched_at, last_signal_at, ack_status, attempt_count)
         VALUES (?, ?, datetime('now'), datetime('now'), 'pending', 1)
         ON CONFLICT(agent_id, ticket_id) DO UPDATE SET
           last_signal_at = datetime('now'),
           dispatched_at  = CASE WHEN ack_status = 'escalated' THEN datetime('now') ELSE dispatched_at END,
           ack_status     = CASE WHEN ack_status IN ('acknowledged', 'escalated') THEN 'pending' ELSE ack_status END,
           attempt_count  = CASE WHEN ack_status = 'escalated' THEN 1 ELSE attempt_count + 1 END,
           redispatch_failure_count = CASE WHEN ack_status = 'escalated' THEN 0 ELSE redispatch_failure_count END`,
      )
      .run(agentId, normalizedId);
    // Fresh-work-phase boundary: clear the sibling redispatch-budget seal so a
    // legitimately re-dispatched ticket gets its own budget again (INF-1101 AC1).
    this.onFreshDispatch?.(normalizedId);
    log.info(`Dispatch recorded: ${agentId} [${normalizedId}]`);
    emitStreamTopic("fleet");
  }

  /**
   * Register a pending dispatch expectation for a (agent, ticket) pair when the
   * connector commits to delivering to a newly-assigned delegate, BEFORE the
   * wake-up is actually sent.
   *
   * If a real dispatch follows, recordDispatch bumps this row (0 → 1) so the
   * happy-path attempt_count is unchanged. If the delivery is instead swallowed
   * (e.g. by nudge-dedup coalescing) or delivered through a path that records no
   * ack, this placeholder remains 'pending' and the watchdog re-signals it —
   * so a swallowed delivery self-heals instead of stalling indefinitely (AI-1538).
   *
   * Inserted with attempt_count=0 and ON CONFLICT DO NOTHING: it never bumps the
   * counter, never resets last_signal_at, and never resurrects an acknowledged
   * entry.
   */
  ensurePending(agentId: string, ticketId: string): void {
    const normalizedId = normalizeSessionKey(ticketId);
    this.db
      .prepare(
        `INSERT INTO dispatch_acks
           (agent_id, ticket_id, dispatched_at, last_signal_at, ack_status, attempt_count)
         VALUES (?, ?, datetime('now'), datetime('now'), 'pending', 0)
         ON CONFLICT(agent_id, ticket_id) DO NOTHING`,
      )
      .run(agentId, normalizedId);
  }

  /**
   * Acknowledge dispatches for an agent — called when /session-end fires.
   *
   * If ticketId is provided, acknowledges only that specific ticket.
   * If omitted, acknowledges all pending/unconfirmed tickets for the agent
   * (backward-compat path: session-end without per-ticket detail).
   *
   * Returns the number of rows updated.
   */
  acknowledge(agentId: string, ticketId?: string): number {
    if (ticketId) {
      const normalizedId = normalizeSessionKey(ticketId);
      const result = this.db
        .prepare(
          `UPDATE dispatch_acks SET ack_status = 'acknowledged'
           WHERE agent_id = ? AND ticket_id = ?
             AND ack_status IN ('pending', 'unconfirmed')`,
        )
        .run(agentId, normalizedId);
      return result.changes;
    }
    const result = this.db
      .prepare(
        `UPDATE dispatch_acks SET ack_status = 'acknowledged'
         WHERE agent_id = ? AND ack_status IN ('pending', 'unconfirmed')`,
      )
      .run(agentId);
    if (result.changes > 0) {
      log.info(`Acknowledged ${result.changes} dispatch(es) for ${agentId}`);
    }
    return result.changes;
  }

  /**
   * INF-989: record delegate-authored activity (a comment) that is NOT a
   * workflow transition, and decide whether it counts as recovery.
   *
   * The stale-session watchdog was single-shot: it poked a stalled dispatch
   * once, and then *any* delegate comment acknowledged the entry and ended
   * surveillance. An agent that posts a status ("still working on it") and then
   * goes idle again fell off the watchdog entirely (the INF-958 stall: ack at
   * 12:40Z, no follow-up for 5+ hours). A comment is a liveness signal but not
   * a state transition, so for a dispatch the watchdog has already poked it must
   * be treated as "acknowledged but not transitioned" — surveillance stays open
   * and the next cadence re-pokes (or escalates) if still no transition.
   *
   * Disposition by current ack_status:
   *   - pending      → acknowledge. Happy path: the agent picked the work up and
   *                    commented before the watchdog ever poked it. This is the
   *                    legitimate Doing-flip signal (AI-1564) and is preserved.
   *   - unconfirmed  → keep under surveillance ("surveilled"). The watchdog has
   *                    poked at least once, so this comment is an
   *                    ack-without-transition. Refresh last_signal_at so the
   *                    delegate gets a fresh cadence window from THIS ack before
   *                    the next re-poke, but do NOT clear the flag and do NOT
   *                    reset attempt_count — so continued ack-without-transition
   *                    still escalates once the re-signal cap is exhausted.
   *   - other/absent → no-op ("none").
   *
   * Returns the disposition so the caller only runs acknowledge-side effects
   * (e.g. clearing no-activity warnings) on genuine recovery.
   */
  noteAuthoredActivity(agentId: string, ticketId: string): "acknowledged" | "surveilled" | "none" {
    const normalizedId = normalizeSessionKey(ticketId);
    const row = this.db
      .prepare(`SELECT ack_status FROM dispatch_acks WHERE agent_id = ? AND ticket_id = ?`)
      .get(agentId, normalizedId) as { ack_status: string } | undefined;
    if (!row) return "none";
    if (row.ack_status === "unconfirmed") {
      this.db
        .prepare(
          `UPDATE dispatch_acks SET last_signal_at = datetime('now')
           WHERE agent_id = ? AND ticket_id = ?`,
        )
        .run(agentId, normalizedId);
      log.info(
        `Authored activity noted (ack-without-transition, surveillance kept): ${agentId} [${normalizedId}]`,
      );
      return "surveilled";
    }
    if (row.ack_status === "pending") {
      return this.acknowledge(agentId, ticketId) > 0 ? "acknowledged" : "none";
    }
    return "none";
  }

  /**
   * Return dispatches that are still pending/unconfirmed and whose last_signal_at
   * is older than timeoutMs milliseconds. The watchdog calls this each cycle.
   *
   * When timeoutMs <= 0, all pending/unconfirmed entries are returned immediately
   * (useful for testing and for a "check everything now" flush).
   */
  getPendingTimedOut(timeoutMs: number): DispatchAckEntry[] {
    let query: string;
    let params: unknown[];

    if (timeoutMs <= 0) {
      // No timeout: every pending/unconfirmed entry is considered overdue
      query = `SELECT id, agent_id, ticket_id, dispatched_at, last_signal_at,
                      ack_status, attempt_count, redispatch_failure_count
               FROM dispatch_acks
               WHERE ack_status IN ('pending', 'unconfirmed')
               ORDER BY last_signal_at ASC
               LIMIT 100`;
      params = [];
    } else {
      // JS-computed cutoff in "YYYY-MM-DD HH:MM:SS" (UTC) — same format as datetime('now')
      const cutoff = new Date(Date.now() - timeoutMs)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, "");
      query = `SELECT id, agent_id, ticket_id, dispatched_at, last_signal_at,
                      ack_status, attempt_count, redispatch_failure_count
               FROM dispatch_acks
               WHERE ack_status IN ('pending', 'unconfirmed')
                 AND last_signal_at <= ?
               ORDER BY last_signal_at ASC
               LIMIT 100`;
      params = [cutoff];
    }

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: number;
      agent_id: string;
      ticket_id: string;
      dispatched_at: string;
      last_signal_at: string;
      ack_status: string;
      attempt_count: number;
      redispatch_failure_count: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      ticketId: r.ticket_id,
      dispatchedAt: r.dispatched_at,
      lastSignalAt: r.last_signal_at,
      ackStatus: r.ack_status as AckStatus,
      attemptCount: r.attempt_count,
      failureCount: r.redispatch_failure_count,
    }));
  }

  /**
   * Filtered dispatch history for the admin console (AI-2140).
   * Supports optional agentId and/or ackStatus filters.
   */
  listFiltered(opts: { agentId?: string; ackStatus?: AckStatus; limit?: number } = {}): DispatchAckEntry[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (opts.agentId) {
      conditions.push('agent_id = ?');
      params.push(opts.agentId);
    }
    if (opts.ackStatus) {
      conditions.push('ack_status = ?');
      params.push(opts.ackStatus);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const capped = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    params.push(capped);

    const rows = this.db
      .prepare(
        `SELECT id, agent_id, ticket_id, dispatched_at, last_signal_at,
                ack_status, attempt_count, redispatch_failure_count
         FROM dispatch_acks
         ${where}
         ORDER BY last_signal_at DESC
         LIMIT ?`,
      )
      .all(...params) as Array<{
        id: number;
        agent_id: string;
        ticket_id: string;
        dispatched_at: string;
        last_signal_at: string;
        ack_status: string;
        attempt_count: number;
        redispatch_failure_count: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      ticketId: r.ticket_id,
      dispatchedAt: r.dispatched_at,
      lastSignalAt: r.last_signal_at,
      ackStatus: r.ack_status as AckStatus,
      attemptCount: r.attempt_count,
      failureCount: r.redispatch_failure_count,
    }));
  }

  /**
   * Most recent dispatch entries across all agents and statuses — the
   * management console's fleet/dispatch view (Phase 3). Read-only.
   */
  listRecent(limit = 200): DispatchAckEntry[] {
    const capped = Math.min(Math.max(limit, 1), 1000);
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, ticket_id, dispatched_at, last_signal_at,
                ack_status, attempt_count, redispatch_failure_count
         FROM dispatch_acks
         ORDER BY last_signal_at DESC
         LIMIT ?`,
      )
      .all(capped) as Array<{
        id: number;
        agent_id: string;
        ticket_id: string;
        dispatched_at: string;
        last_signal_at: string;
        ack_status: string;
        attempt_count: number;
        redispatch_failure_count: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      ticketId: r.ticket_id,
      dispatchedAt: r.dispatched_at,
      lastSignalAt: r.last_signal_at,
      ackStatus: r.ack_status as AckStatus,
      attemptCount: r.attempt_count,
      failureCount: r.redispatch_failure_count,
    }));
  }

  /**
   * Update a dispatch record after a watchdog re-signal attempt.
   * Sets status to 'unconfirmed', bumps attempt_count, resets last_signal_at
   * AND dispatched_at — a re-signal is a new dispatch attempt, so its
   * no-activity window starts now. Judging retries against the original
   * dispatch clock executed attempts 2 and 3 within one detector cycle
   * (~30s each) instead of giving them full windows (AI-1759, 2026-07-04).
   */
  markResignaled(agentId: string, ticketId: string): void {
    const normalizedId = normalizeSessionKey(ticketId);
    this.db
      .prepare(
        `UPDATE dispatch_acks
         SET ack_status = 'unconfirmed',
             dispatched_at = datetime('now'),
             last_signal_at = datetime('now'),
             attempt_count = attempt_count + 1,
             redispatch_failure_count = 0
         WHERE agent_id = ? AND ticket_id = ?`,
      )
      .run(agentId, normalizedId);
  }

  /**
   * AI-2118: record a re-dispatch whose DELIVERY failed (wake-up threw or was
   * skipped without being pruned). Resets last_signal_at so the watchdog backs
   * off a full no-activity window instead of re-firing every poll (~30s), and
   * increments the consecutive delivery-failure streak so a gateway that never
   * accepts wakes escalates instead of looping. Deliberately does NOT touch
   * attempt_count — a delivery that never started is not a real attempt.
   */
  markResignalFailed(agentId: string, ticketId: string): void {
    const normalizedId = normalizeSessionKey(ticketId);
    this.db
      .prepare(
        `UPDATE dispatch_acks
         SET last_signal_at = datetime('now'),
             redispatch_failure_count = redispatch_failure_count + 1
         WHERE agent_id = ? AND ticket_id = ?`,
      )
      .run(agentId, normalizedId);
  }

  /**
   * Mark a dispatch as escalated — max re-signals exhausted, admin action required.
   */
  markEscalated(agentId: string, ticketId: string): void {
    const normalizedId = normalizeSessionKey(ticketId);
    this.db
      .prepare(
        `UPDATE dispatch_acks SET ack_status = 'escalated'
         WHERE agent_id = ? AND ticket_id = ?`,
      )
      .run(agentId, normalizedId);
    log.error(`Dispatch escalated: ${agentId} [${normalizedId}] — max re-signals exceeded`);
  }

  /**
   * INF-1101: re-arm an `escalated` dispatch row back to `pending` on a fresh
   * work phase — the ack-tracker counterpart to `globalRedispatchBudget.reset`.
   *
   * A ticket that exhausted its redispatch budget pre-review is marked
   * `escalated` (removed from the pending set so the no-activity detector stops
   * looping). When it later re-enters a worker state via a legitimate
   * post-review re-dispatch, the escalated row must clear or the ticket is seen
   * as "already escalated, don't re-alert" and silently parks. Resets the phase
   * clocks, attempt_count (fresh budget), and the delivery-failure streak, and
   * fires onFreshDispatch so the sibling budget seal clears on the SAME
   * boundary. Returns true iff a row was actually re-armed (was escalated).
   *
   * No-op for non-escalated rows, so a genuine loop that never re-enters a work
   * phase is untouched and still seals + escalates exactly once (AC4).
   */
  clearEscalated(agentId: string, ticketId: string): boolean {
    const normalizedId = normalizeSessionKey(ticketId);
    const result = this.db
      .prepare(
        `UPDATE dispatch_acks
         SET ack_status = 'pending',
             dispatched_at = datetime('now'),
             last_signal_at = datetime('now'),
             attempt_count = 1,
             redispatch_failure_count = 0
         WHERE agent_id = ? AND ticket_id = ? AND ack_status = 'escalated'`,
      )
      .run(agentId, normalizedId);
    if (result.changes > 0) {
      this.onFreshDispatch?.(normalizedId);
      log.info(`Escalated ack re-armed (fresh work phase): ${agentId} [${normalizedId}]`);
      return true;
    }
    return false;
  }

  /**
   * Mark a dispatch as deferred — agent is alive but at capacity.
   * Does NOT increment attempt_count; this is not a retry, just a hold.
   * The entry will be rescued when a session-end fires or by the stale-deferred sweep.
   */
  markDeferred(agentId: string, ticketId: string): void {
    const normalizedId = normalizeSessionKey(ticketId);
    this.db
      .prepare(
        `UPDATE dispatch_acks
         SET ack_status = 'deferred',
             last_signal_at = datetime('now')
         WHERE agent_id = ? AND ticket_id = ?`,
      )
      .run(agentId, normalizedId);
    log.info(`Dispatch deferred (at-capacity): ${agentId} [${normalizedId}]`);
  }

  /**
   * Return deferred entries whose last_signal_at is older than staleMs.
   * Used by the no-activity detector to rescue entries that were never
   * re-dispatched by a session-end signal.
   */
  getDeferredStale(staleMs: number): DispatchAckEntry[] {
    const cutoff = new Date(Date.now() - staleMs)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, ticket_id, dispatched_at, last_signal_at,
                ack_status, attempt_count, redispatch_failure_count
         FROM dispatch_acks
         WHERE ack_status = 'deferred' AND last_signal_at <= ?
         ORDER BY last_signal_at ASC
         LIMIT 50`,
      )
      .all(cutoff) as Array<{
        id: number;
        agent_id: string;
        ticket_id: string;
        dispatched_at: string;
        last_signal_at: string;
        ack_status: string;
        attempt_count: number;
        redispatch_failure_count: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      ticketId: r.ticket_id,
      dispatchedAt: r.dispatched_at,
      lastSignalAt: r.last_signal_at,
      ackStatus: r.ack_status as AckStatus,
      attemptCount: r.attempt_count,
      failureCount: r.redispatch_failure_count,
    }));
  }

  /**
   * Return true if there is a pending/unconfirmed dispatch for (agentId, ticketId)
   * whose dispatched_at is within the last withinMs milliseconds.
   *
   * Used by StuckDelegateDetector (AI-1650) to guard against re-dispatching a
   * session that is still actively running after a connector restart. The in-memory
   * SessionTracker is reset on restart, so this persisted check is the only way to
   * know a session was recently dispatched and may still be in progress.
   */
  hasRecentPending(agentId: string, ticketId: string, withinMs: number): boolean {
    const normalizedId = normalizeSessionKey(ticketId);
    const cutoff = new Date(Date.now() - withinMs)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const row = this.db
      .prepare(
        `SELECT 1 FROM dispatch_acks
         WHERE agent_id = ? AND ticket_id = ?
           AND ack_status IN ('pending', 'unconfirmed')
           AND dispatched_at >= ?
         LIMIT 1`,
      )
      .get(agentId, normalizedId, cutoff);
    return row !== undefined;
  }

  /**
   * Prune acknowledged and escalated records older than ttlMs.
   * Called automatically at the end of each watchdog cycle.
   */
  cleanup(): number {
    const cutoff = new Date(Date.now() - this.ttlMs)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const result = this.db
      .prepare(
        `DELETE FROM dispatch_acks
         WHERE ack_status IN ('acknowledged', 'escalated')
           AND last_signal_at < ?`,
      )
      .run(cutoff);
    if (result.changes > 0) {
      log.info(`Pruned ${result.changes} dispatch ack record(s)`);
    }
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
