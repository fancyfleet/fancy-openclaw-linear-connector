/**
 * Phase 4 / P4-1 — Append-only observation store for categorized reject feedback.
 *
 * Design: design.md §8 (learning loop), §9 (Observations tier), §10 (micro layer).
 *
 * Every `request-changes` and `reject` transition that carries a validated
 * `category_enum` value writes exactly one observation row. The store is
 * append-only — rows are never updated or deleted. Cheap, auditable,
 * machine-aggregatable.
 *
 * The store lives connector-side (§4.2 / §12 resolved), not in Linear labels.
 * Ad-hoc tickets (no wf:* label) produce no observations.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { componentLogger, createLogger } from "../logger.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "observation-store");
/**
 * The reason codes a row may carry.
 *
 * The first five mirror `feedback.category_enum` in the workflow definitions.
 * `unclassified` is the connector's own fallback: a reviewer who rejects work
 * without naming a category still produces a row (AI-2036). Losing the
 * rejection entirely — the pre-AI-2036 behaviour — is strictly worse than
 * recording one whose cause is unknown. Consumers that cluster by cause
 * should filter it out explicitly rather than assume every row is categorized.
 */
export const REASON_CODES = [
    "missing-tests",
    "style",
    "scope-creep",
    "correctness",
    "ac-mismatch",
    "unclassified",
];
/** The fallback used when no category is supplied by header or comment. */
export const UNCLASSIFIED_REASON_CODE = "unclassified";
export class ObservationStore {
    constructor(dbPath) {
        const resolvedPath = dbPath ??
            path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "observations.db");
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        this.db = new Database(resolvedPath);
        this.db.pragma("journal_mode = WAL");
        this.migrate();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket      TEXT    NOT NULL,
        workflow    TEXT    NOT NULL,
        step        TEXT    NOT NULL,
        from_body   TEXT    NOT NULL,
        reviewer_body TEXT  NOT NULL,
        reason_code TEXT    NOT NULL,
        free_text   TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_observations_workflow_step
        ON observations(workflow, step);
      CREATE INDEX IF NOT EXISTS idx_observations_reason_code
        ON observations(reason_code);
      CREATE INDEX IF NOT EXISTS idx_observations_workflow_step_reason
        ON observations(workflow, step, reason_code);
      CREATE INDEX IF NOT EXISTS idx_observations_ticket
        ON observations(ticket);
      CREATE INDEX IF NOT EXISTS idx_observations_created_at
        ON observations(created_at);
    `);
        // AI-2036 AC1.4: nullable wake_id, correlating a reviewer rejection with the
        // dispatch cycle that produced it (operational_events.wake_id). Forward-only —
        // rows written before this migration keep NULL. ALTER TABLE ADD COLUMN is the
        // only additive path SQLite offers, and it throws if the column already
        // exists, so guard on the live schema rather than swallowing every error.
        if (!this.hasColumn("observations", "wake_id")) {
            this.db.exec(`ALTER TABLE observations ADD COLUMN wake_id TEXT`);
        }
    }
    hasColumn(table, column) {
        const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
        return cols.some((c) => c.name === column);
    }
    /**
     * Validate that a reason code string is a known enum value.
     * Returns the typed ReasonCode, or null if invalid.
     */
    static validateReasonCode(value) {
        if (REASON_CODES.includes(value)) {
            return value;
        }
        return null;
    }
    /**
     * Append one observation row. Idempotent in the sense that duplicate
     * calls produce additional rows — this is intentional (append-only).
     * Returns the auto-incremented row ID.
     */
    append(input) {
        const result = this.db
            .prepare(`INSERT INTO observations (ticket, workflow, step, from_body, reviewer_body, reason_code, free_text, wake_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(input.ticket, input.workflow, input.step, input.fromBody, input.reviewerBody, input.reasonCode, input.freeText ?? null, input.wakeId ?? null, input.timestamp ?? new Date().toISOString());
        const id = Number(result.lastInsertRowid);
        log.info(`observation appended: id=${id} ticket=${input.ticket} workflow=${input.workflow} step=${input.step} reason=${input.reasonCode}`);
        return id;
    }
    /**
     * Query observations with optional filters. Returns rows ordered by
     * creation time descending (newest first).
     */
    query(query = {}) {
        const clauses = [];
        const params = [];
        if (query.workflow) {
            clauses.push("workflow = ?");
            params.push(query.workflow);
        }
        if (query.step) {
            clauses.push("step = ?");
            params.push(query.step);
        }
        if (query.reasonCode) {
            clauses.push("reason_code = ?");
            params.push(query.reasonCode);
        }
        if (query.ticket) {
            clauses.push("ticket = ?");
            params.push(query.ticket);
        }
        if (query.since) {
            clauses.push("created_at >= ?");
            params.push(query.since);
        }
        if (query.until) {
            clauses.push("created_at <= ?");
            params.push(query.until);
        }
        const rawLimit = query.limit;
        const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(rawLimit, 1000)
            : 100;
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.db
            .prepare(`SELECT id, ticket, workflow, step, from_body, reviewer_body, reason_code, free_text, wake_id, created_at
         FROM observations ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`)
            .all(...params, limit);
        return rows.map(rowToObservation);
    }
    /**
     * Total row count. Cheap, and reachable only if the table really exists —
     * so /health can prove the write path's storage is live (AI-2036 AC1.6)
     * rather than merely that an object was constructed.
     */
    total() {
        const row = this.db.prepare(`SELECT COUNT(*) AS c FROM observations`).get();
        return Number(row.c);
    }
    /**
     * Count observations grouped by (workflow, step, reason_code).
     * Used by P4-2 metric aggregation.
     */
    counts(query = {}) {
        return this.groupedCounts(query).map(({ tickets: _tickets, ...row }) => row);
    }
    /**
     * `counts()` plus the distinct tickets behind each group. Private: the ticket
     * ids reach consumers through `metrics()` (AI-2037 AC2.1). Widening `counts()`
     * itself would add an unrequested field to the admin counts endpoint, whose
     * response shape other callers assert on exactly.
     */
    groupedCounts(query = {}) {
        const clauses = [];
        const params = [];
        if (query.workflow) {
            clauses.push("workflow = ?");
            params.push(query.workflow);
        }
        if (query.step) {
            clauses.push("step = ?");
            params.push(query.step);
        }
        if (query.reasonCode) {
            clauses.push("reason_code = ?");
            params.push(query.reasonCode);
        }
        if (query.since) {
            clauses.push("created_at >= ?");
            params.push(query.since);
        }
        if (query.until) {
            clauses.push("created_at <= ?");
            params.push(query.until);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.db
            .prepare(`SELECT workflow, step, reason_code, COUNT(*) as cnt,
                GROUP_CONCAT(DISTINCT ticket) as tickets
         FROM observations ${where}
         GROUP BY workflow, step, reason_code
         ORDER BY cnt DESC`)
            .all(...params);
        return rows.map((r) => ({
            workflow: r.workflow,
            step: r.step,
            reasonCode: r.reason_code,
            count: r.cnt,
            tickets: splitTickets(r.tickets),
        }));
    }
    /**
     * Count observations grouped by (workflow, step, reason_code, from_body).
     * The P4-2 "macro" layer — where a step everyone fails becomes visible.
     * Optionally includes a body dimension for per-implementer breakdowns.
     */
    countsByBody(query = {}) {
        return this.groupedCountsByBody(query).map(({ tickets: _tickets, ...row }) => row);
    }
    /** `countsByBody()` plus the distinct tickets behind each group. See `groupedCounts`. */
    groupedCountsByBody(query = {}) {
        const clauses = [];
        const params = [];
        if (query.workflow) {
            clauses.push("workflow = ?");
            params.push(query.workflow);
        }
        if (query.step) {
            clauses.push("step = ?");
            params.push(query.step);
        }
        if (query.reasonCode) {
            clauses.push("reason_code = ?");
            params.push(query.reasonCode);
        }
        if (query.since) {
            clauses.push("created_at >= ?");
            params.push(query.since);
        }
        if (query.until) {
            clauses.push("created_at <= ?");
            params.push(query.until);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.db
            .prepare(`SELECT workflow, step, reason_code, from_body, COUNT(*) as cnt,
                GROUP_CONCAT(DISTINCT ticket) as tickets
         FROM observations ${where}
         GROUP BY workflow, step, reason_code, from_body
         ORDER BY cnt DESC`)
            .all(...params);
        return rows.map((r) => ({
            workflow: r.workflow,
            step: r.step,
            reasonCode: r.reason_code,
            fromBody: r.from_body,
            count: r.cnt,
            tickets: splitTickets(r.tickets),
        }));
    }
    /**
     * Compute metrics: the ranked reason-code counts per step.
     * This is the "missing-tests ×14 this month" view.
     * Returns results sorted by count descending, grouped by (workflow, step, reason_code).
     * If includeBody is true, also breaks down by from_body.
     * Returns empty cleanly when no observations exist.
     */
    metrics(query = {}) {
        const threshold = query.threshold;
        const countsData = query.includeBody
            ? this.groupedCountsByBody(query)
            : this.groupedCounts(query);
        const items = countsData.map((row) => ({
            workflow: row.workflow,
            step: row.step,
            reasonCode: row.reasonCode,
            count: row.count,
            ...("fromBody" in row ? { fromBody: row.fromBody } : {}),
            exceedsThreshold: threshold !== undefined && row.count >= threshold,
            tickets: row.tickets,
        }));
        // Compute totals per workflow+step for summary
        const stepTotals = new Map();
        for (const item of items) {
            const key = `${item.workflow}|${item.step}`;
            stepTotals.set(key, (stepTotals.get(key) ?? 0) + item.count);
        }
        const summary = {
            totalObservations: items.reduce((sum, i) => sum + i.count, 0),
            uniqueWorkflows: new Set(items.map((i) => i.workflow)).size,
            uniqueSteps: new Set(items.map((i) => i.step)).size,
            stepsAboveThreshold: threshold
                ? Array.from(stepTotals.entries())
                    .filter(([, total]) => total >= threshold)
                    .map(([key, total]) => {
                    const [workflow, step] = key.split("|");
                    return { workflow, step, total };
                })
                : [],
        };
        return { items, summary, query: { ...query } };
    }
    close() {
        this.db.close();
    }
}
/** GROUP_CONCAT emits a comma-joined string, or NULL for an empty group. */
function splitTickets(concatenated) {
    if (!concatenated)
        return [];
    return concatenated.split(",").filter((t) => t.length > 0).sort();
}
function rowToObservation(row) {
    return {
        id: Number(row.id),
        ticket: String(row.ticket),
        workflow: String(row.workflow),
        step: String(row.step),
        fromBody: String(row.from_body),
        reviewerBody: String(row.reviewer_body),
        reasonCode: String(row.reason_code),
        freeText: row.free_text === null || row.free_text === undefined ? null : String(row.free_text),
        wakeId: row.wake_id === null || row.wake_id === undefined ? null : String(row.wake_id),
        createdAt: String(row.created_at),
    };
}
//# sourceMappingURL=observation-store.js.map