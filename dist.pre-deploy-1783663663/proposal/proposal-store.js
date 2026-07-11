// THROWAWAY reference implementation — used only to validate the AI-2038 tests.
// Deleted before the test commit. Igor implements the real one.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
export const PROPOSAL_STATUSES = [
    "pending",
    "approved",
    "rejected",
    "applied",
    "apply-failed",
    "in-revision",
];
export class ProposalStore {
    constructor(dbPath) {
        const resolved = dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "proposals.db");
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        this.db = new Database(resolved);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        state_id TEXT NOT NULL,
        old_hash TEXT NOT NULL,
        old_snapshot TEXT NOT NULL,
        new_content TEXT NOT NULL,
        diff TEXT NOT NULL,
        confidence_score REAL NOT NULL,
        evidence_ticket_ids TEXT NOT NULL,
        evidence_counts TEXT NOT NULL,
        failure_count INTEGER NOT NULL,
        version INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposal_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        feedback TEXT NOT NULL,
        diff TEXT NOT NULL,
        new_content TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
    `);
    }
    hydrate(row) {
        const revisions = this.db
            .prepare(`SELECT * FROM proposal_revisions WHERE proposal_id = ? ORDER BY version ASC`)
            .all(row.id);
        return {
            id: row.id,
            workflowId: row.workflow_id,
            stateId: row.state_id,
            oldContent: { hash: row.old_hash, snapshot: row.old_snapshot },
            newContent: row.new_content,
            diff: row.diff,
            confidenceScore: row.confidence_score,
            evidenceCluster: {
                ticketIds: JSON.parse(row.evidence_ticket_ids),
                counts: JSON.parse(row.evidence_counts),
            },
            failureCount: row.failure_count,
            version: row.version,
            idempotencyKey: row.idempotency_key,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            revisions: revisions.map((r) => ({
                version: r.version,
                feedback: r.feedback,
                diff: r.diff,
                newContent: r.new_content,
                idempotencyKey: r.idempotency_key,
                createdAt: r.created_at,
            })),
        };
    }
    create(p) {
        const now = new Date().toISOString();
        const info = this.db
            .prepare(`INSERT INTO proposals (workflow_id, state_id, old_hash, old_snapshot, new_content, diff,
          confidence_score, evidence_ticket_ids, evidence_counts, failure_count, version,
          idempotency_key, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(p.workflowId, p.stateId, p.oldContent.hash, p.oldContent.snapshot, p.newContent, p.diff, p.confidenceScore, JSON.stringify(p.evidenceCluster.ticketIds), JSON.stringify(p.evidenceCluster.counts), p.failureCount, p.version, p.idempotencyKey, "pending", now, now);
        return this.get(Number(info.lastInsertRowid));
    }
    get(id) {
        const row = this.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id);
        return row ? this.hydrate(row) : null;
    }
    query(q = {}) {
        const where = [];
        const params = [];
        if (q.status) {
            where.push("status = ?");
            params.push(q.status);
        }
        if (q.workflowId) {
            where.push("workflow_id = ?");
            params.push(q.workflowId);
        }
        const sql = `SELECT * FROM proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ASC ${q.limit ? "LIMIT ?" : ""}`;
        if (q.limit)
            params.push(q.limit);
        return this.db.prepare(sql).all(...params).map((r) => this.hydrate(r));
    }
    setStatus(id, status) {
        if (!PROPOSAL_STATUSES.includes(status))
            throw new Error(`invalid status: ${status}`);
        const existing = this.get(id);
        if (!existing)
            throw new Error(`unknown proposal id: ${id}`);
        this.db
            .prepare(`UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?`)
            .run(status, new Date().toISOString(), id);
        return this.get(id);
    }
    revise(id, feedback, regenerated) {
        if (!feedback || !feedback.trim())
            throw new Error("operator feedback is required to revise");
        const current = this.get(id);
        if (!current)
            throw new Error(`unknown proposal id: ${id}`);
        const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO proposals (workflow_id, state_id, old_hash, old_snapshot, new_content, diff, confidence_score, evidence_ticket_ids, evidence_counts, failure_count, version, idempotency_key, status, created_at, updated_at) SELECT workflow_id, state_id, old_hash, old_snapshot, new_content, diff, confidence_score, evidence_ticket_ids, evidence_counts, failure_count, version, idempotency_key, status, created_at, updated_at FROM proposals WHERE id = ?`).run(id);
        this.db.transaction(() => {
            this.db
                .prepare(`INSERT INTO proposal_revisions (proposal_id, version, feedback, diff, new_content, idempotency_key, created_at)
           VALUES (?,?,?,?,?,?,?)`)
                .run(id, current.version, feedback, current.diff, current.newContent, current.idempotencyKey, now);
            this.db
                .prepare(`UPDATE proposals SET new_content = ?, diff = ?, idempotency_key = ?, confidence_score = ?,
             evidence_ticket_ids = ?, evidence_counts = ?, failure_count = ?,
             version = ?, status = ?, updated_at = ? WHERE id = ?`)
                .run(regenerated.newContent, regenerated.diff, regenerated.idempotencyKey, regenerated.confidenceScore, JSON.stringify(regenerated.evidenceCluster.ticketIds), JSON.stringify(regenerated.evidenceCluster.counts), regenerated.failureCount, current.version + 1, "in-revision", now, id);
        })();
        return this.get(id);
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=proposal-store.js.map