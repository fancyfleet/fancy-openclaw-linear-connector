export type AlertSeverity = "info" | "warning" | "critical";
export interface AlertInput {
    severity: AlertSeverity;
    /** Subsystem slug, e.g. "dispatch", "config-health", "token-refresh". */
    source: string;
    /** One-line human summary. */
    title: string;
    /** Optional multiline context. Redacted + truncated before storage. */
    detail?: unknown;
    agent?: string | null;
    ticket?: string | null;
    /** Dedup identity. Defaults to source|title|agent|ticket. */
    dedupKey?: string;
}
export interface AlertRow {
    id: number;
    firstAt: string;
    lastAt: string;
    severity: AlertSeverity;
    source: string;
    title: string;
    detail: unknown;
    agent: string | null;
    ticket: string | null;
    dedupKey: string;
    count: number;
    pushedAt: string | null;
    pushedVia: string | null;
    ackedAt: string | null;
}
export interface AlertQuery {
    severity?: AlertSeverity;
    source?: string;
    agent?: string;
    ticket?: string;
    unackedOnly?: boolean;
    since?: string;
    limit?: number;
}
export interface RecordResult {
    row: AlertRow;
    /** True when this occurrence was folded into an existing burst row. */
    suppressed: boolean;
    /** Count of the previous burst with the same dedupKey, if any (for "xN" context). */
    priorBurstCount: number | null;
}
export declare function defaultDedupKey(alert: AlertInput): string;
/**
 * Persistent, human-facing alert history (design: docs/alert-bus.md).
 *
 * One row per BURST: repeats of the same dedupKey inside the suppression
 * window increment `count` on the existing row instead of inserting. The
 * operational-event store remains the full-detail machine log; this table is
 * what a human (and later the console) should actually look at.
 */
export declare class AlertStore {
    private db;
    constructor(dbPath?: string);
    /**
     * Record an occurrence. If the latest row for the dedupKey started within
     * `suppressWindowMs`, the occurrence folds into it (suppressed=true).
     */
    record(alert: AlertInput, suppressWindowMs: number, now?: Date): RecordResult;
    markPushed(id: number, now?: Date, via?: string): void;
    ack(id: number, now?: Date): boolean;
    query(q?: AlertQuery): AlertRow[];
    close(): void;
}
//# sourceMappingURL=alert-store.d.ts.map