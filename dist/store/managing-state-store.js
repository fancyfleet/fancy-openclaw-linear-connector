import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
export class ManagingStateStore {
    constructor(dbPath) {
        const resolvedPath = dbPath ?? path.join(process.cwd(), "data", "managing-state.db");
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS managing_state (
        agent_id           TEXT NOT NULL,
        ticket_id          TEXT NOT NULL,
        last_dispatched_at INTEGER,
        PRIMARY KEY (agent_id, ticket_id)
      );
      CREATE INDEX IF NOT EXISTS idx_managing_state_agent
        ON managing_state (agent_id);
    `);
    }
    /** Read the last-dispatched timestamp for one (agent, ticket). null if never dispatched. */
    getLastDispatched(agentId, ticketId) {
        const row = this.db
            .prepare("SELECT last_dispatched_at FROM managing_state WHERE agent_id = ? AND ticket_id = ?")
            .get(agentId, ticketId);
        if (!row)
            return null;
        return row.last_dispatched_at;
    }
    /** Record a stewardship wake dispatch for a (agent, ticket) at the given epoch ms. */
    recordDispatch(agentId, ticketId, atMs) {
        this.db
            .prepare(`INSERT INTO managing_state (agent_id, ticket_id, last_dispatched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id, ticket_id) DO UPDATE SET last_dispatched_at = excluded.last_dispatched_at`)
            .run(agentId, ticketId, atMs);
    }
    /** Ensure a (agent, ticket) row exists. Leaves last_dispatched_at as null when freshly inserted. */
    ensure(agentId, ticketId) {
        this.db
            .prepare(`INSERT OR IGNORE INTO managing_state (agent_id, ticket_id, last_dispatched_at)
         VALUES (?, ?, NULL)`)
            .run(agentId, ticketId);
    }
    /** Remove the row when a ticket leaves Managing or is no longer delegated to the agent. */
    remove(agentId, ticketId) {
        this.db
            .prepare("DELETE FROM managing_state WHERE agent_id = ? AND ticket_id = ?")
            .run(agentId, ticketId);
    }
    /** Drop entries that aren't in the current set of (agent, ticket) pairs returned from Linear. */
    pruneAgent(agentId, currentTicketIds) {
        if (currentTicketIds.length === 0) {
            const r = this.db.prepare("DELETE FROM managing_state WHERE agent_id = ?").run(agentId);
            return r.changes;
        }
        const placeholders = currentTicketIds.map(() => "?").join(",");
        const params = [agentId, ...currentTicketIds];
        const r = this.db
            .prepare(`DELETE FROM managing_state WHERE agent_id = ? AND ticket_id NOT IN (${placeholders})`)
            .run(...params);
        return r.changes;
    }
    /** All rows for an agent. Useful for diagnostics. */
    listByAgent(agentId) {
        const rows = this.db
            .prepare("SELECT agent_id, ticket_id, last_dispatched_at FROM managing_state WHERE agent_id = ?")
            .all(agentId);
        return rows.map((r) => ({
            agentId: r.agent_id,
            ticketId: r.ticket_id,
            lastDispatchedAt: r.last_dispatched_at,
        }));
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=managing-state-store.js.map