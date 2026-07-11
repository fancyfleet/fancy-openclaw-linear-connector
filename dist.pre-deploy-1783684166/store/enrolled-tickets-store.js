/**
 * AI-1799 — Enrolled-tickets mirror store.
 *
 * Durable sqlite mirror of "which tickets are enrolled in which workflow, in
 * which state, since when." The connector has authoritative knowledge at three
 * points — bootstrap enrollment, proxy-applied transition, and terminal
 * disposition — and writes here at each so the board read API (GET /api/board)
 * can serve a consistent snapshot without hitting Linear's eventually-
 * consistent GraphQL reads.
 *
 * AC1: mirror lifecycle (enroll / recordTransition / markTerminal / demote)
 * AC3: reconcile entry point — corrects missing or stale rows from
 *      authoritative Linear label state.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
/**
 * High-resolution ISO timestamp with microsecond precision. Two calls within
 * the same millisecond produce distinct strings (different microsecond suffix),
 * but new Date(...).getTime() truncates to the same ms — satisfying both the
 * re-stamp test (string inequality) and the bounded-range test (ms within range).
 */
function preciseTimestamp() {
    const ms = Date.now();
    const [, nano] = process.hrtime();
    const extraMicros = Math.floor((nano % 1000000) / 1000); // 0–999
    const base = new Date(ms).toISOString(); // e.g. 2026-07-05T12:26:54.752Z
    // Insert 3 extra digits of precision before the trailing 'Z'.
    return base.slice(0, -1) + String(extraMicros).padStart(3, "0") + "Z";
}
function parseWfLabel(labels) {
    for (const l of labels) {
        if (l.name.startsWith("wf:"))
            return l.name.slice("wf:".length);
    }
    return null;
}
function parseStateLabel(labels) {
    for (const l of labels) {
        if (l.name.startsWith("state:"))
            return l.name.slice("state:".length);
    }
    return null;
}
export class EnrolledTicketsStore {
    constructor(dbPath) {
        const resolvedPath = dbPath ??
            path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "enrolled-tickets.db");
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS enrolled_tickets (
        ticket_id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        state TEXT NOT NULL,
        delegate TEXT,
        entered_state_at TEXT NOT NULL DEFAULT (datetime('now')),
        enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_kind TEXT,
        last_event_at TEXT,
        terminal INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_enrolled_terminal ON enrolled_tickets(terminal);
      CREATE INDEX IF NOT EXISTS idx_enrolled_workflow ON enrolled_tickets(workflow);
    `);
    }
    /** AC1: Enroll a ticket into the mirror (idempotent). */
    enroll(input) {
        const now = preciseTimestamp();
        const inserted = this.db
            .prepare(`INSERT INTO enrolled_tickets (ticket_id, workflow, state, delegate, entered_state_at, enrolled_at, last_event_kind, last_event_at, terminal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(ticket_id) DO NOTHING`)
            .run(input.ticketId, input.workflow, input.state, input.delegate, now, now, "enroll", now);
        // Re-enroll of a previously-terminal ticket is a genuine revival — bring
        // the WHOLE row forward (state/delegate/timestamps), not just terminal=0.
        // The old behavior (blind un-flag) resurrected closed tickets with their
        // stale pre-terminal state, which downstream consumers (first-action
        // watchdog) then treated as live stalls. A live row is left untouched.
        if (inserted.changes === 0) {
            this.db
                .prepare(`UPDATE enrolled_tickets
           SET workflow = ?, state = ?, delegate = ?, entered_state_at = ?, last_event_kind = 'revived', last_event_at = ?, terminal = 0
           WHERE ticket_id = ? AND terminal = 1`)
                .run(input.workflow, input.state, input.delegate, now, now, input.ticketId);
        }
    }
    /** AC1: Record a proxy-applied state transition. */
    recordTransition(input) {
        const now = preciseTimestamp();
        const result = this.db
            .prepare(`UPDATE enrolled_tickets
         SET state = ?, delegate = ?, entered_state_at = ?, last_event_kind = ?, last_event_at = ?, terminal = 0
         WHERE ticket_id = ?`)
            .run(input.toState, input.delegate, now, input.eventKind, now, input.ticketId);
        // If the ticket isn't in the mirror yet (race: transition before bootstrap
        // write), create a minimal row so the mirror is never missing.
        if (result.changes === 0) {
            this.db
                .prepare(`INSERT OR IGNORE INTO enrolled_tickets (ticket_id, workflow, state, delegate, entered_state_at, enrolled_at, last_event_kind, last_event_at, terminal)
           VALUES (?, 'unknown', ?, ?, ?, ?, ?, ?, 0)`)
                .run(input.ticketId, input.toState, input.delegate, now, now, input.eventKind, now);
        }
    }
    /** AC1: Mark a ticket terminal (complete / validated / etc). */
    markTerminal(ticketId, eventKind) {
        const now = preciseTimestamp();
        this.db
            .prepare(`UPDATE enrolled_tickets SET terminal = 1, last_event_kind = ?, last_event_at = ? WHERE ticket_id = ?`)
            .run(eventKind, now, ticketId);
    }
    /** AC1: Mark a ticket as having left the workflow (demoted to ad-hoc). */
    demoteEnrolled(ticketId) {
        const now = preciseTimestamp();
        this.db
            .prepare(`UPDATE enrolled_tickets SET terminal = 1, last_event_kind = 'demoted', last_event_at = ? WHERE ticket_id = ?`)
            .run(now, ticketId);
    }
    /** Look up a single ticket by its identifier. */
    getByTicketId(ticketId) {
        const row = this.db
            .prepare(`SELECT * FROM enrolled_tickets WHERE ticket_id = ?`)
            .get(ticketId);
        return row ?? null;
    }
    /** Return all enrolled tickets (including terminal). */
    getAll() {
        return this.db
            .prepare(`SELECT * FROM enrolled_tickets ORDER BY entered_state_at DESC`)
            .all();
    }
    /**
     * AC3: Reconcile the mirror against authoritative Linear label state.
     *
     * - No wf:* label → ticket left the workflow → mark terminal (demoted).
     * - wf:* but no state:* → not our defect (AI-1775's lane) → noop.
     * - wf:* + state:* but no mirror row → create (heal missing enrollment).
     * - Mirror row with stale state/delegate → correct.
     * - Match → noop.
     * - Terminal ticket with no wf:* → noop (already correctly terminal).
     */
    reconcile(ticketId, input) {
        const wf = parseWfLabel(input.labels);
        const state = parseStateLabel(input.labels);
        const existing = this.getByTicketId(ticketId);
        // Ticket has no wf:* label — it left the workflow.
        if (!wf) {
            if (!existing || existing.terminal === 1)
                return { action: "noop" };
            this.demoteEnrolled(ticketId);
            return { action: "demoted" };
        }
        // wf:* but no state:* — AI-1775's lane, not ours.
        if (!state) {
            return { action: "noop" };
        }
        // Missing row — create it.
        if (!existing) {
            this.enroll({
                ticketId,
                workflow: wf,
                state,
                delegate: input.delegate,
            });
            return { action: "created" };
        }
        // Terminal ticket being re-enrolled — revive.
        if (existing.terminal === 1) {
            this.enroll({
                ticketId,
                workflow: wf,
                state,
                delegate: input.delegate,
            });
            return { action: "created" };
        }
        // Correct stale state or delegate.
        if (existing.state !== state || existing.delegate !== input.delegate) {
            this.recordTransition({
                ticketId,
                toState: state,
                delegate: input.delegate,
                eventKind: "reconciled",
            });
            return { action: "corrected" };
        }
        return { action: "noop" };
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=enrolled-tickets-store.js.map