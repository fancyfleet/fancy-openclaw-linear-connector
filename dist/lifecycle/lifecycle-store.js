import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
export class LifecycleStore {
    constructor(dbPath) {
        const resolvedPath = dbPath ?? path.join(process.cwd(), "data", "lifecycle-reconciler.db");
        const dir = path.dirname(resolvedPath);
        if (dir !== "." && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_wake_record (
        agent_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        last_wake_sent_at INTEGER,
        last_reset_at INTEGER,
        reset_count INTEGER NOT NULL DEFAULT 0,
        dead_lettered_at INTEGER,
        PRIMARY KEY (agent_id, ticket_id)
      );
      CREATE TABLE IF NOT EXISTS lifecycle_wake_counter (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        total_wakes INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO lifecycle_wake_counter (id, total_wakes) VALUES (1, 0);
    `);
    }
    recordWakeSent(agentId, ticketId, nowMs) {
        const now = nowMs ?? Date.now();
        this.db
            .prepare(`INSERT INTO lifecycle_wake_record (agent_id, ticket_id, last_wake_sent_at, reset_count)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(agent_id, ticket_id) DO UPDATE SET
           last_wake_sent_at = excluded.last_wake_sent_at`)
            .run(agentId, ticketId, now);
        this.db
            .prepare(`UPDATE lifecycle_wake_counter SET total_wakes = total_wakes + 1 WHERE id = 1`)
            .run();
    }
    recordReset(agentId, ticketId, nowMs) {
        const now = nowMs ?? Date.now();
        this.db
            .prepare(`INSERT INTO lifecycle_wake_record (agent_id, ticket_id, last_reset_at, reset_count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(agent_id, ticket_id) DO UPDATE SET
           last_reset_at = excluded.last_reset_at,
           reset_count = reset_count + 1`)
            .run(agentId, ticketId, now);
    }
    markDeadLetter(agentId, ticketId, nowMs) {
        const now = nowMs ?? Date.now();
        this.db
            .prepare(`INSERT INTO lifecycle_wake_record (agent_id, ticket_id, dead_lettered_at, reset_count)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(agent_id, ticket_id) DO UPDATE SET
           dead_lettered_at = excluded.dead_lettered_at`)
            .run(agentId, ticketId, now);
    }
    getWakeRecord(agentId, ticketId) {
        const row = this.db
            .prepare(`SELECT agent_id, ticket_id, last_wake_sent_at, last_reset_at, reset_count, dead_lettered_at
         FROM lifecycle_wake_record
         WHERE agent_id = ? AND ticket_id = ?`)
            .get(agentId, ticketId);
        if (!row)
            return null;
        return {
            agentId: row.agent_id,
            ticketId: row.ticket_id,
            lastWakeSentAt: row.last_wake_sent_at,
            lastResetAt: row.last_reset_at,
            resetCount: row.reset_count,
            deadLetteredAt: row.dead_lettered_at,
        };
    }
    getMetrics() {
        const tracked = this.db
            .prepare(`SELECT COUNT(*) as cnt FROM lifecycle_wake_record`)
            .get();
        const deadLettered = this.db
            .prepare(`SELECT COUNT(*) as cnt FROM lifecycle_wake_record WHERE dead_lettered_at IS NOT NULL`)
            .get();
        const resets = this.db
            .prepare(`SELECT COALESCE(SUM(reset_count), 0) as total FROM lifecycle_wake_record`)
            .get();
        const wakes = this.db
            .prepare(`SELECT total_wakes FROM lifecycle_wake_counter WHERE id = 1`)
            .get();
        return {
            totalTracked: tracked.cnt,
            deadLettered: deadLettered.cnt,
            totalWakesSent: wakes?.total_wakes ?? 0,
            totalResets: resets.total,
        };
    }
    pruneStale(ttlMs) {
        const cutoff = Date.now() - (ttlMs ?? 7 * 24 * 60 * 60 * 1000);
        const result = this.db
            .prepare(`DELETE FROM lifecycle_wake_record
         WHERE last_wake_sent_at IS NOT NULL AND last_wake_sent_at < ?`)
            .run(cutoff);
        return result.changes;
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=lifecycle-store.js.map