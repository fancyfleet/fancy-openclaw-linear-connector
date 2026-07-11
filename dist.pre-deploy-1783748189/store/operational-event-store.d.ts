export declare const OPERATIONAL_EVENT_OUTCOMES: readonly ["received", "signature-rejected", "duplicate", "normalized", "terminal-pruned", "no-route", "no-route-human", "routed", "dedup-suppressed", "bag-added", "delivered", "dispatch-accepted", "dispatched", "queued", "delivery-failed", "delivery-unconfirmed", "session-ended", "stale-resignaled", "startup-replayed", "startup-pruned", "no-activity-warn", "no-activity-failed", "deferred-at-capacity", "deferred-capacity-rearm", "stuck-delegate-reprompt", "stale-c4-repoke", "stale-c4-repoke-failed", "engagement-thinking", "engagement-doing", "engagement-todo", "bootstrap-bootstrapped", "bootstrap-demoted", "bootstrap-wake-dispatched", "bootstrap-wake-delivered", "bootstrap-wake-failed", "enrollment-healed", "break-glass-used", "hold-retry-dispatch", "no-activity-redispatch", "delegation-reconciled", "delegation-reconciliation-failed", "watchdog-resignal", "comment-post-failed", "def-state-migrated", "def-state-migration-failed", "suppressed-duplicate", "dropped-stale", "transition-write-failed", "dispatch-undeliverable", "observation-recorded", "observation-skipped"];
export type OperationalEventOutcome = typeof OPERATIONAL_EVENT_OUTCOMES[number];
export interface OperationalEventInput {
    outcome: OperationalEventOutcome;
    type?: string | null;
    agent?: string | null;
    key?: string | null;
    deliveryMode?: string | null;
    attemptCount?: number | null;
    runId?: string | null;
    sessionKey?: string | null;
    errorSummary?: string | null;
    detail?: unknown;
    occurredAt?: string;
    /** AI-1799: workflow state resolved from the ticket's state:* label (null when not enrolled). */
    workflowState?: string | null;
    /** AI-1799: audience axis — 'agent' (narrative) or 'connector' (mechanics). */
    plane?: string | null;
    /** AI-1799: dispatch-cycle correlation id minted at route time. */
    wakeId?: string | null;
}
export interface OperationalEvent extends Omit<Required<OperationalEventInput>, "detail" | "occurredAt"> {
    id: number;
    occurredAt: string;
    detail: unknown;
}
export interface OperationalEventQuery {
    agent?: string;
    key?: string;
    outcome?: OperationalEventOutcome;
    type?: string;
    since?: string;
    until?: string;
    limit?: number;
}
export interface OperationalSnapshot {
    key?: string;
    agent?: string;
    lastSuccess?: OperationalEvent;
    lastError?: OperationalEvent;
    lifecycle: OperationalEvent[];
}
/**
 * AI-2037 / AC2.2: outcomes that never form a failure cluster.
 *
 * `signature-rejected` and `duplicate` are transport-level rejections, not
 * workflow failures; clustering them drowns the real signal. `dropped-stale`
 * and `suppressed-duplicate` are stale-digest noise emitted by connector bugs
 * since fixed (webhook/index.ts) — the AC calls for it to be filtered, not
 * clustered.
 */
export declare const NON_CLUSTERING_OUTCOMES: readonly OperationalEventOutcome[];
/** AI-2037: an operational failure cluster, keyed on forward-only enrichment columns. */
export interface OperationalEventCluster {
    workflowState: string;
    plane: string;
    outcome: OperationalEventOutcome;
    count: number;
    exceedsThreshold: boolean;
    wakeIds: string[];
}
export interface OperationalEventClusterResult {
    clusters: OperationalEventCluster[];
    /** Rows dropped for lacking enrichment columns — reported, not silently discarded. */
    excludedPreEnrichmentRows: number;
}
export declare function redactOperationalDetail(detail: unknown): unknown;
export declare class OperationalEventStore {
    private db;
    private writeCount;
    private readonly maxAgeDays;
    private readonly maxRows;
    constructor(dbPath?: string);
    private migrate;
    prune(): number;
    append(input: OperationalEventInput): number;
    query(query?: OperationalEventQuery): OperationalEvent[];
    snapshot(query: {
        key?: string;
        agent?: string;
        limit?: number;
    }): OperationalSnapshot;
    close(): void;
    /** AI-1799: query all events sharing a dispatch-cycle wake_id. */
    queryByWakeId(wakeId: string): OperationalEvent[];
    /**
     * AI-2037 / AC2.2 + AC2.5: cluster operational failures by
     * (workflow_state, plane, outcome).
     *
     * Two filters run before grouping, and both are load-bearing:
     *
     *  - NON_CLUSTERING_OUTCOMES are dropped (AC2.2).
     *  - Rows missing the AI-1799 enrichment columns are dropped (AC2.5). Those
     *    columns are forward-only, so a NULL workflow_state means "written before
     *    the columns existed", not "no workflow state". Counting such a row would
     *    assert something about history this data cannot support.
     *
     * The enrichment filter silently shrinks counts, which is indistinguishable
     * from a real drop in failures — so the number of rows it removed is returned
     * alongside the clusters rather than discarded.
     */
    clusters(query?: {
        since?: string;
        until?: string;
        threshold?: number;
        limit?: number;
    }): OperationalEventClusterResult;
}
//# sourceMappingURL=operational-event-store.d.ts.map