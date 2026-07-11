/**
 * AI-1838 — Mutation audit log for out-of-band detection (Pillar-1 bypass).
 *
 * Records every state/label/delegate change the connector **observes** from
 * Linear webhooks (source = "webhook") and every state/label/delegate mutation
 * the proxy **forwards** upstream (source = "proxy"). The periodic reconcile
 * sweep (oob-reconcile-sweep.ts) compares the two populations to detect
 * out-of-band mutations — changes made directly to api.linear.app that
 * bypassed the proxy gate entirely.
 *
 * Design:
 *   - Single SQLite table with a `source` discriminator ('webhook' | 'proxy').
 *   - `correlated` flag: set by the reconcile sweep when a webhook record is
 *     matched to a proxy record. Unmatched webhook records past the grace
 *     window are the out-of-band signal.
 *   - Append-only: rows are never updated except for the correlation flag.
 *   - Pruning keeps the table bounded (default 30 days).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { componentLogger, createLogger } from "../logger.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "mutation-audit-store");
// ── Store ────────────────────────────────────────────────────────────────────
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_ROWS = 50000;
function parseEnvInt(name, defaultVal) {
    const raw = process.env[name];
    const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    return isNaN(parsed) || parsed <= 0 ? defaultVal : parsed;
}
export class MutationAuditStore {
    constructor(dbPath) {
        this.writeCount = 0;
        this.maxAgeDays = parseEnvInt("MUTATION_AUDIT_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS);
        this.maxRows = parseEnvInt("MUTATION_AUDIT_MAX_ROWS", DEFAULT_MAX_ROWS);
        this.pruneEveryN = 100;
        const resolvedPath = dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "mutation-audit.db");
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
        this.prune();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS mutation_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        ticket TEXT NOT NULL,
        change_type TEXT NOT NULL,
        field TEXT,
        old_value TEXT,
        new_value TEXT,
        actor_id TEXT,
        agent TEXT,
        intent TEXT,
        webhook_event_id TEXT,
        op_name TEXT,
        correlated INTEGER NOT NULL DEFAULT 0,
        correlated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mutation_audit_ticket_time
        ON mutation_audit(ticket, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mutation_audit_source_correlated
        ON mutation_audit(source, correlated, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mutation_audit_change_type
        ON mutation_audit(change_type, recorded_at DESC);
    `);
        // AI-1838: add ticket_uuid column for UUID⇄identifier cross-referencing.
        const addColumnIfMissing = (col, def) => {
            const exists = this.db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('mutation_audit') WHERE name = ?`).get(col);
            if (exists.c === 0) {
                this.db.exec(`ALTER TABLE mutation_audit ADD COLUMN ${col} ${def}`);
            }
        };
        addColumnIfMissing("ticket_uuid", "TEXT");
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mutation_audit_ticket_uuid ON mutation_audit(ticket_uuid)`);
        // AI-1860 AC7: invoking session identity for governed proxy mutations.
        addColumnIfMissing("session_key", "TEXT");
    }
    prune() {
        const ageResult = this.db.prepare(`DELETE FROM mutation_audit WHERE recorded_at < datetime('now', ?)`).run(`-${this.maxAgeDays} days`);
        const capResult = this.db.prepare(`DELETE FROM mutation_audit WHERE id NOT IN (
        SELECT id FROM mutation_audit ORDER BY recorded_at DESC, id DESC LIMIT ?
      )`).run(this.maxRows);
        const removed = ageResult.changes + capResult.changes;
        if (removed > 0) {
            log.info(`pruned ${removed} row(s) (age: ${ageResult.changes}, cap: ${capResult.changes})`);
        }
        return removed;
    }
    append(input) {
        const result = this.db.prepare(`
      INSERT INTO mutation_audit (
        recorded_at, source, ticket, change_type, field, old_value, new_value,
        actor_id, agent, intent, webhook_event_id, op_name, ticket_uuid, session_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.recordedAt ?? new Date().toISOString(), input.source, input.ticket, input.changeType, input.field ?? null, input.oldValue ?? null, input.newValue ?? null, input.actorId ?? null, input.agent ?? null, input.intent ?? null, input.webhookEventId ?? null, input.opName ?? null, input.ticketUuid ?? null, input.sessionKey ?? null);
        this.writeCount++;
        if (this.writeCount % this.pruneEveryN === 0)
            this.prune();
        return Number(result.lastInsertRowid);
    }
    /** Batch-append multiple records in a single transaction. */
    appendBatch(inputs) {
        if (inputs.length === 0)
            return [];
        const insert = this.db.prepare(`
      INSERT INTO mutation_audit (
        recorded_at, source, ticket, change_type, field, old_value, new_value,
        actor_id, agent, intent, webhook_event_id, op_name, ticket_uuid, session_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const ids = [];
        const tx = this.db.transaction(() => {
            for (const input of inputs) {
                const result = insert.run(input.recordedAt ?? new Date().toISOString(), input.source, input.ticket, input.changeType, input.field ?? null, input.oldValue ?? null, input.newValue ?? null, input.actorId ?? null, input.agent ?? null, input.intent ?? null, input.webhookEventId ?? null, input.opName ?? null, input.ticketUuid ?? null, input.sessionKey ?? null);
                ids.push(Number(result.lastInsertRowid));
            }
        });
        tx();
        this.writeCount += inputs.length;
        if (this.writeCount % this.pruneEveryN === 0)
            this.prune();
        return ids;
    }
    /**
     * Mark a webhook record as correlated to a proxy record.
     * Both records get `correlated=1` and a shared `correlated_at` timestamp.
     */
    correlate(webhookId, proxyId, correlatedAt) {
        const ts = correlatedAt ?? new Date().toISOString();
        this.db.prepare(`
      UPDATE mutation_audit SET correlated = 1, correlated_at = ?
      WHERE id = ? AND source = 'webhook'
    `).run(ts, webhookId);
        this.db.prepare(`
      UPDATE mutation_audit SET correlated = 1, correlated_at = ?
      WHERE id = ? AND source = 'proxy'
    `).run(ts, proxyId);
    }
    /**
     * Find proxy records for a given ticket/change_type within a time window.
     * Matches on exact ticket OR ticket_uuid to handle the UUID⇄identifier gap
     * (proxy often only has the UUID; webhook has the human-readable identifier).
     * Used by the reconcile sweep to match against webhook-observed changes.
     */
    findProxyCandidates(ticket, changeType, sinceIso, untilIso, ticketUuid) {
        const rows = this.db.prepare(`
      SELECT * FROM mutation_audit
      WHERE source = 'proxy'
        AND change_type = ?
        AND recorded_at >= ?
        AND recorded_at <= ?
        AND (ticket = ? OR ticket_uuid = ? ${ticketUuid ? "OR ticket = ? OR ticket_uuid = ?" : ""})
      ORDER BY recorded_at ASC
    `).all(changeType, sinceIso, untilIso, ticket, ticket ?? null, ...(ticketUuid ? [ticketUuid, ticketUuid] : []));
        return rows.map(rowToRecord);
    }
    /**
     * Return webhook-observed state/label/delegate mutations that are still
     * uncorrelated and older than the grace window. These are the candidates
     * for out-of-band detection.
     */
    uncorrelatedWebhookMutations(changeTypes, sinceIso, graceCutoffIso) {
        if (changeTypes.length === 0)
            return [];
        const placeholders = changeTypes.map(() => "?").join(",");
        const rows = this.db.prepare(`
      SELECT * FROM mutation_audit
      WHERE source = 'webhook'
        AND correlated = 0
        AND recorded_at >= ?
        AND recorded_at <= ?
        AND change_type IN (${placeholders})
      ORDER BY recorded_at ASC
    `).all(sinceIso, graceCutoffIso, ...changeTypes);
        return rows.map(rowToRecord);
    }
    /** All records for a ticket (admin/debug). */
    byTicket(ticket, limit = 100) {
        const rows = this.db.prepare(`
      SELECT * FROM mutation_audit WHERE ticket = ?
      ORDER BY recorded_at DESC LIMIT ?
    `).all(ticket, limit);
        return rows.map(rowToRecord);
    }
    /** Stats for /health and admin views. */
    stats() {
        const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN source = 'webhook' THEN 1 ELSE 0 END) AS webhook_total,
        SUM(CASE WHEN source = 'proxy' THEN 1 ELSE 0 END) AS proxy_total,
        SUM(CASE WHEN correlated = 1 THEN 1 ELSE 0 END) AS correlated,
        SUM(CASE WHEN source = 'webhook' AND correlated = 0 THEN 1 ELSE 0 END) AS uncorrelated
      FROM mutation_audit
    `).get();
        return {
            webhookTotal: row.webhook_total ?? 0,
            proxyTotal: row.proxy_total ?? 0,
            correlated: row.correlated ?? 0,
            uncorrelated: row.uncorrelated ?? 0,
        };
    }
    close() {
        this.db.close();
    }
}
function rowToRecord(row) {
    return {
        id: Number(row.id),
        source: row.source,
        recordedAt: String(row.recorded_at),
        ticket: String(row.ticket),
        changeType: row.change_type,
        field: row.field ?? null,
        oldValue: row.old_value ?? null,
        newValue: row.new_value ?? null,
        actorId: row.actor_id ?? null,
        agent: row.agent ?? null,
        intent: row.intent ?? null,
        webhookEventId: row.webhook_event_id ?? null,
        opName: row.op_name ?? null,
        ticketUuid: row.ticket_uuid ?? null,
        sessionKey: row.session_key ?? null,
        correlated: Number(row.correlated),
        correlatedAt: row.correlated_at ?? null,
    };
}
//# sourceMappingURL=mutation-audit-store.js.map