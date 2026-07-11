import type { ApplyProposal, AppliedRecord, MetricsBaseline } from "../proposal/apply-pipeline.js";
/**
 * AI-2039 (P4-C4) — persistence for learning-loop proposals and their apply
 * outcomes. Backs the `/admin/api/proposals` review-queue console (C5, AI-2040)
 * and the apply pipeline's idempotency store (AC4.5) in one row per proposal.
 *
 * A row carries both the C3-generated proposal (`proposal_json`, holding the
 * `targets[]` the pipeline consumes) and the apply outcome
 * (`status`/`version`/`commit`/`apply_json`). The apply pipeline reads it via
 * {@link getByIdempotencyKey} and writes back via {@link record}; the console
 * lists it via {@link list} and retries via {@link getById}.
 *
 * This is **operational state** — the queue can be rebuilt from the distillation
 * job; deleting the db only drops in-flight review items.
 */
/** A proposal row as surfaced to the console + retry route. */
export interface ProposalRow {
    id: string;
    idempotencyKey: string | null;
    status: string;
    version: number | null;
    commit: string | null;
    /** The C3 proposal (targets[] etc.), when one was stored — required for retry. */
    proposal: ApplyProposal | null;
    metricsBaseline: MetricsBaseline | null;
    error: string | null;
    retryable: boolean | null;
    staleTargets: string[] | null;
    updatedAt: string;
}
export declare class ProposalStore {
    private db;
    constructor(dbPath?: string);
    private migrate;
    /** Upsert a generated proposal (C3). Preserves any existing apply outcome. */
    saveProposal(proposal: ApplyProposal, status?: string): void;
    /** All proposals, newest first — the console queue source. */
    list(): ProposalRow[];
    getById(id: string): ProposalRow | null;
    /** Returns the apply outcome record for a proposal by idempotency key, or null. */
    getByIdempotencyKey(key: string): AppliedRecord | null;
    /** Persist an apply outcome onto the proposal row (creating one if absent). */
    record(rec: AppliedRecord): void;
    close(): void;
}
//# sourceMappingURL=proposal-store.d.ts.map