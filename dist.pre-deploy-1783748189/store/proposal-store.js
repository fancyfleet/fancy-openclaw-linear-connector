import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
export class ProposalStore {
    constructor(dbPath) {
        const resolvedPath = dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "proposals.db");
        if (resolvedPath !== ":memory:") {
            const dir = path.dirname(resolvedPath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id              TEXT PRIMARY KEY,
        idempotency_key TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        version         INTEGER,
        commit_hash     TEXT,
        proposal_json   TEXT,
        apply_json      TEXT,
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_idempotency ON proposals (idempotency_key);
    `);
    }
    /** Upsert a generated proposal (C3). Preserves any existing apply outcome. */
    saveProposal(proposal, status = "pending") {
        this.db
            .prepare(`INSERT INTO proposals (id, idempotency_key, status, proposal_json, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           idempotency_key = excluded.idempotency_key,
           proposal_json   = excluded.proposal_json,
           updated_at      = datetime('now')`)
            .run(proposal.id, proposal.idempotencyKey, status, JSON.stringify(proposal));
    }
    /** All proposals, newest first — the console queue source. */
    list() {
        const rows = this.db
            .prepare(`SELECT * FROM proposals ORDER BY updated_at DESC`)
            .all();
        return rows.map(rowToProposal);
    }
    getById(id) {
        const row = this.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id);
        return row ? rowToProposal(row) : null;
    }
    // ── Apply-pipeline store interface (AC4.5 idempotency) ────────────────────
    /** Returns the apply outcome record for a proposal by idempotency key, or null. */
    getByIdempotencyKey(key) {
        const row = this.db
            .prepare(`SELECT * FROM proposals WHERE idempotency_key = ?`)
            .get(key);
        if (!row)
            return null;
        const apply = row.apply_json ? JSON.parse(row.apply_json) : {};
        return {
            id: row.id,
            idempotencyKey: row.idempotency_key ?? key,
            status: row.status,
            version: row.version ?? undefined,
            commit: row.commit_hash ?? undefined,
            metricsBaseline: apply.metricsBaseline,
            staleTargets: apply.staleTargets,
            error: apply.error,
            retryable: apply.retryable,
            updatedAt: apply.updatedAt ?? 0,
        };
    }
    /** Persist an apply outcome onto the proposal row (creating one if absent). */
    record(rec) {
        this.db
            .prepare(`INSERT INTO proposals (id, idempotency_key, status, version, commit_hash, apply_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           idempotency_key = excluded.idempotency_key,
           status          = excluded.status,
           version         = excluded.version,
           commit_hash     = excluded.commit_hash,
           apply_json      = excluded.apply_json,
           updated_at      = datetime('now')`)
            .run(rec.id, rec.idempotencyKey, rec.status, rec.version ?? null, rec.commit ?? null, JSON.stringify(rec));
    }
    close() {
        this.db.close();
    }
}
function rowToProposal(row) {
    const apply = row.apply_json ? JSON.parse(row.apply_json) : {};
    return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        status: row.status,
        version: row.version,
        commit: row.commit_hash,
        proposal: row.proposal_json ? JSON.parse(row.proposal_json) : null,
        metricsBaseline: apply.metricsBaseline ?? null,
        error: apply.error ?? null,
        retryable: apply.retryable ?? null,
        staleTargets: apply.staleTargets ?? null,
        updatedAt: row.updated_at,
    };
}
//# sourceMappingURL=proposal-store.js.map