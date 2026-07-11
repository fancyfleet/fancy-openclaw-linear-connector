/**
 * AI-1807 — Delegation reconciliation sweep.
 *
 * Detects and heals two classes of stranded tickets caused by webhook-ingress
 * gaps (e.g. the 2026-07-05 Fujimoto outage):
 *
 *   1. Governed, non-terminal tickets whose current delegate has no dispatch
 *      record since the delegate was set (AC1). The delegate-change webhook
 *      was dropped, so the wake was never sent.
 *   2. wf-labeled tickets with no state:* label and no delegate — dropped
 *      enrollment webhooks (AC2). Complements AI-1775's bootstrap sweep.
 *
 * Each heal emits an operational event and an alert-bus notify (AC3).
 * Idempotent: a ticket whose delegate was already woken is never re-woken (AC4).
 *
 * The sweep is registered at server bootstrap via registerDelegationReconciliationCron
 * and is observable via /health crons field (AC6/AC7).
 *
 * POST /redispatch (ADMIN_SECRET-gated) triggers on-demand reconciliation
 * for a single ticket or a time window (AC5).
 */
import { type AlertBus } from "./alerts/alert-bus.js";
import { type OperationalEventStore as OperationalEventStoreType } from "./store/operational-event-store.js";
export interface DelegationReconciliationOptions {
    authToken: string;
    operationalEventStore: OperationalEventStoreType;
    alertBus: AlertBus;
    wakeFn: (agentName: string, ticketIdentifier: string) => Promise<void>;
    fetchFn?: typeof fetch;
    /** AC5: single-ticket mode — reconcile only these identifiers. */
    ticketIdentifiers?: string[];
    /** AC5: time-window mode — reconcile tickets updated within [since, until]. */
    since?: string;
    until?: string;
    /** Override for Date.now() — used in tests for deterministic timing. */
    now?: () => Date;
}
export interface DelegationReconciliationResult {
    scanned: number;
    healed: number;
    bootstrapHealed: number;
    skippedIdempotent: number;
    errors: string[];
}
/**
 * Run a single delegation reconciliation sweep: query → classify → heal → alert.
 *
 * Never throws — all errors are captured in the `errors` array and surfaced via
 * the alert bus (AC3).
 */
export declare function runDelegationReconciliationSweep(opts: DelegationReconciliationOptions): Promise<DelegationReconciliationResult>;
/**
 * Register the delegation reconciliation sweep as a recurring interval timer.
 *
 * **Wake wiring (AC1):** the caller MUST supply a `wakeFn` that delivers a
 * wake to the delegate agent — identical to the webhook delegation wake path.
 *
 * **Alert bus (AC3):** if `alertBus` is omitted, defaults to the global
 * alert-bus singleton.
 *
 * **Operational event store (AC4):** the caller MUST supply the store for
 * dispatch-record idempotency checks.
 *
 * Returns the NodeJS.Timeout so the caller can clear it on shutdown.
 */
export declare function registerDelegationReconciliationCron(opts: {
    authToken: string;
    intervalMs?: number;
    operationalEventStore?: OperationalEventStoreType;
    alertBus?: AlertBus;
    wakeFn?: (agentName: string, ticketIdentifier: string) => Promise<void>;
    fetchFn?: typeof fetch;
}): NodeJS.Timeout;
//# sourceMappingURL=delegation-reconciliation-sweep.d.ts.map