import Database from "better-sqlite3";
import path from "path";
import { createLogger, componentLogger } from "../logger.js";
const log = componentLogger(createLogger(), "stale-redispatch-counter");
export class StaleRedispatchCounter {
    constructor(dbPath) {
        const resolvedPath = dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "stale-redispatch-attempts.db");
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS stale_redispatch_attempts (
        ticket_id        TEXT PRIMARY KEY,
        attempt_count    INTEGER NOT NULL DEFAULT 1,
        first_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_attempt_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    }
    incrementAndGet(ticketId) {
        this.db
            .prepare(`INSERT INTO stale_redispatch_attempts (ticket_id, attempt_count, first_attempt_at, last_attempt_at)
         VALUES (?, 1, datetime('now'), datetime('now'))
         ON CONFLICT(ticket_id) DO UPDATE SET
           attempt_count = attempt_count + 1,
           last_attempt_at = datetime('now')`)
            .run(ticketId);
        const row = this.db
            .prepare(`SELECT attempt_count FROM stale_redispatch_attempts WHERE ticket_id = ?`)
            .get(ticketId);
        const count = row?.attempt_count ?? 1;
        log.info(`Redispatch attempt ${count} recorded for ticket ${ticketId}`);
        return count;
    }
    get(ticketId) {
        const row = this.db
            .prepare(`SELECT attempt_count FROM stale_redispatch_attempts WHERE ticket_id = ?`)
            .get(ticketId);
        return row?.attempt_count ?? 0;
    }
    reset(ticketId) {
        this.db.prepare(`DELETE FROM stale_redispatch_attempts WHERE ticket_id = ?`).run(ticketId);
        log.info(`Redispatch counter reset for ticket ${ticketId}`);
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=stale-redispatch-counter.js.map