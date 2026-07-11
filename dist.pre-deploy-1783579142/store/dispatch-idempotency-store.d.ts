/**
 * AI-1918 — Persistent dispatch idempotency store.
 *
 * Deduplicates dispatches keyed on (ticket, workflowState, agent) so that:
 *   1. A single webhook event replayed (different delivery IDs) produces at most
 *      one wake per target agent (AC1: dispatch dedup).
 *   2. An older snapshot that arrives after a newer one is dropped (AC2: stale-
 *      dispatch guard) — the updatedAt from the ticket payload is compared against
 *      the latest seen timestamp for that (ticket, agent) tuple.
 *   3. The store is durable (SQLite/WAL) so it survives connector restarts,
 *      preventing restart-echo fan-out (AC4: root-cause regression).
 *
 * AI-1973 extensions:
 *   - Delegate-change invalidation: when a dispatch carries delegateChanged:true,
 *     all prior rows for (ticket, agent) are cleared before admitting the new
 *     dispatch. This fixes the permanent re-wake suppression behind the AI-1965
 *     merge-gate stall (AI-1855 19h, AI-1926 19.6h).
 *   - Dedup TTL: rows older than the TTL stop suppressing. Prevents long-lived
 *     stale rows from locking out re-dispatches.
 *   - clearAgentRows() escape hatch for manual recovery.
 */
/** Default TTL: 6 hours. Replay storms happen in seconds-to-minutes, not days.
 *  The AI-1855 stall was ~19 hours — beyond this window. */
export declare const DEFAULT_DEDUP_TTL_MS: number;
export interface IdempotencyRecord {
    /** Normalized ticket key, e.g. "linear-AI-1918". */
    ticketKey: string;
    /** Workflow state name or event id at dispatch time. */
    workflowState: string;
    /** Target agent name. */
    agent: string;
    /** ISO-8601 updatedAt from the webhook payload at dispatch time. */
    updatedAt: string;
    /** ISO-8601 timestamp of when the record was created. */
    createdAt: string;
}
export interface IdempotencyCheckResult {
    /** True if this dispatch should be suppressed as a duplicate. */
    suppressed: boolean;
    /** True if this dispatch should be dropped as stale (older snapshot). */
    stale: boolean;
    /** True if the existing row existed but was past its TTL, allowing admit. */
    ttlExpired?: boolean;
    /** Number of prior rows cleared for (ticket, agent) due to delegate change. */
    clearedRows?: number;
}
export interface IdempotencyCounters {
    suppressedDuplicates: number;
    droppedStale: number;
    /** Rows cleared by delegate-change invalidation. */
    delegateChangeCleared: number;
    /** Admits granted because the existing row exceeded the TTL. */
    ttlExpiredAdmits: number;
}
export interface IdempotencyOptions {
    /** Override "now" timestamp (ms since epoch) for deterministic testing. */
    nowMs?: number;
    /** True when this dispatch is triggered by a delegate change. When true,
     *  all prior idempotency rows for (ticket, agent) are cleared before
     *  admitting the new dispatch. */
    delegateChanged?: boolean;
}
export declare class DispatchIdempotencyStore {
    private db;
    private _suppressedDuplicates;
    private _droppedStale;
    private _delegateChangeCleared;
    private _ttlExpiredAdmits;
    private readonly dedupTtlMs;
    constructor(dbPath?: string, dedupTtlMs?: number);
    /** Read DISPATCH_IDEMPOTENCY_TTL_MS env var, or fall back to DEFAULT_DEDUP_TTL_MS. */
    private envTtlMs;
    private migrate;
    /**
     * Resolve the "now" timestamp from options or wall clock.
     */
    private now;
    /**
     * Check whether a dispatch should be admitted, suppressed (duplicate), or
     * dropped (stale). If admitted, the record is persisted. If suppressed or
     * dropped, the relevant in-memory counter is incremented.
     *
     * When options.delegateChanged is true, all prior rows for (ticket, agent)
     * are cleared before admitting — this ensures a re-delegated agent receives
     * the wake even if they previously handled the ticket in the same native
     * state (AI-1973, AI-1855/AI-1926 round-trip fix).
     */
    checkAndRecord(ticketKey: string, workflowState: string, agent: string, updatedAt: string, options?: IdempotencyOptions): IdempotencyCheckResult;
    /**
     * Delete all idempotency rows for (ticketKey, agent). Returns the count
     * of deleted rows. Escape hatch for manual recovery.
     */
    clearAgentRows(ticketKey: string, agent: string): number;
    /** In-memory counters for observability (reset on restart, persisted counts
     *  come from operational events). */
    get counters(): IdempotencyCounters;
    close(): void;
}
//# sourceMappingURL=dispatch-idempotency-store.d.ts.map