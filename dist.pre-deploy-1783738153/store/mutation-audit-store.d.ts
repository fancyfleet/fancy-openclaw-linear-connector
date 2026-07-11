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
export type MutationSource = "webhook" | "proxy";
export type ChangeType = "state" | "label" | "delegate" | "assignee";
export interface MutationAuditInput {
    source: MutationSource;
    ticket: string;
    changeType: ChangeType;
    /** Specific field name, e.g. "state:done", "wf:dev-impl", "delegateId". */
    field?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    /** Linear user id of the actor (webhook) or agent name (proxy). */
    actorId?: string | null;
    /** Connector agent name (proxy ops). */
    agent?: string | null;
    /** Workflow intent (proxy ops only, e.g. "advance", "request-changes"). */
    intent?: string | null;
    /** Delivery/event id from EventStore (webhook source). */
    webhookEventId?: string | null;
    /** GraphQL operation name (proxy source). */
    opName?: string | null;
    /** UUID of the issue (for cross-referencing when proxy only has UUID and webhook has identifier). */
    ticketUuid?: string | null;
    /**
     * AI-1860 AC7: invoking session key (proxy source) — the OpenClaw session that
     * ran the governed intent, e.g. "agent:astrid:linear-ai-1848". Recording it makes
     * "who ran this governed mutation" a one-query lookup (the AI-1909 forensics gap).
     */
    sessionKey?: string | null;
    /** ISO timestamp; defaults to now. */
    recordedAt?: string;
}
export interface MutationAuditRecord {
    id: number;
    source: MutationSource;
    recordedAt: string;
    ticket: string;
    changeType: ChangeType;
    field: string | null;
    oldValue: string | null;
    newValue: string | null;
    actorId: string | null;
    agent: string | null;
    intent: string | null;
    webhookEventId: string | null;
    opName: string | null;
    ticketUuid: string | null;
    sessionKey: string | null;
    correlated: number;
    correlatedAt: string | null;
}
export interface UnmatchedMutation {
    webhook: MutationAuditRecord;
    /** Proxy records for the same ticket in the time window (none matched). */
    candidateCount: number;
}
export declare class MutationAuditStore {
    private db;
    private writeCount;
    private readonly maxAgeDays;
    private readonly maxRows;
    private readonly pruneEveryN;
    constructor(dbPath?: string);
    private migrate;
    prune(): number;
    append(input: MutationAuditInput): number;
    /** Batch-append multiple records in a single transaction. */
    appendBatch(inputs: MutationAuditInput[]): number[];
    /**
     * Mark a webhook record as correlated to a proxy record.
     * Both records get `correlated=1` and a shared `correlated_at` timestamp.
     */
    correlate(webhookId: number, proxyId: number, correlatedAt?: string): void;
    /**
     * Find proxy records for a given ticket/change_type within a time window.
     * Matches on exact ticket OR ticket_uuid to handle the UUID⇄identifier gap
     * (proxy often only has the UUID; webhook has the human-readable identifier).
     * Used by the reconcile sweep to match against webhook-observed changes.
     */
    findProxyCandidates(ticket: string, changeType: ChangeType, sinceIso: string, untilIso: string, ticketUuid?: string | null): MutationAuditRecord[];
    /**
     * Return webhook-observed state/label/delegate mutations that are still
     * uncorrelated and older than the grace window. These are the candidates
     * for out-of-band detection.
     */
    uncorrelatedWebhookMutations(changeTypes: ChangeType[], sinceIso: string, graceCutoffIso: string): MutationAuditRecord[];
    /** All records for a ticket (admin/debug). */
    byTicket(ticket: string, limit?: number): MutationAuditRecord[];
    /** Stats for /health and admin views. */
    stats(): {
        webhookTotal: number;
        proxyTotal: number;
        correlated: number;
        uncorrelated: number;
    };
    close(): void;
}
//# sourceMappingURL=mutation-audit-store.d.ts.map