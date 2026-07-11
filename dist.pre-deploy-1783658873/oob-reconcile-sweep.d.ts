/**
 * AI-1838 — Out-of-band mutation reconciliation sweep.
 *
 * Periodic safety net that compares Linear-webhook-observed state/label/delegate
 * changes against proxy-forwarded mutations. A webhook-observed change with no
 * corresponding proxy op is an out-of-band mutation — someone holding a raw
 * OAuth token called api.linear.app directly, bypassing the connector gate.
 *
 * This is the Pillar-1 bypass detection control (companion to the existing
 * enforcement layers in proxy.ts). Even when egress can't be blocked (AC2,
 * separate fleet decision with Matt), this surfaces out-of-band writes after
 * the fact so a human/agent can investigate.
 *
 * Design:
 *   - Reads uncorrelated webhook mutations past a grace window (lets the
 *     proxy op land first).
 *   - For each, looks for any proxy record for the same ticket + change type
 *     within a match window. If found → correlate. If not → flag.
 *   - Flagged mutations are surfaced via the alert bus + operational events.
 *   - Idempotent: correlating on re-runs is safe (already-correlated records
 *     are excluded by the query).
 */
import type { MutationAuditStore, ChangeType } from "./store/mutation-audit-store.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";
import { getAlertBus } from "./alerts/alert-bus.js";
export interface ReconcileOptions {
    /** Override grace window (ms). */
    graceMs?: number;
    /** Override lookback (ms). */
    lookbackMs?: number;
    /** Override match half-window (ms). */
    matchWindowMs?: number;
    /** Override `Date.now()` for tests. */
    nowMs?: number;
    /** Alert bus (defaults to global). */
    alertBus?: ReturnType<typeof getAlertBus>;
    /** Operational event store for surfacing flags. */
    operationalEventStore?: OperationalEventStore;
}
export interface ReconcileResult {
    /** Total uncorrelated webhook mutations examined. */
    examined: number;
    /** Successfully correlated to a proxy op. */
    correlated: number;
    /** Flagged as out-of-band (no matching proxy op). */
    flagged: number;
    /** Details of flagged mutations. */
    flaggedDetails: Array<{
        ticket: string;
        changeType: ChangeType;
        field: string | null;
        recordedAt: string;
        actorId: string | null;
    }>;
}
/**
 * Run a single reconcile pass over the mutation audit store.
 *
 * Pure I/O — reads uncorrelated webhook mutations, tries to match each against
 * proxy records, correlates matches, and flags the rest via the alert bus +
 * operational events.
 */
export declare function reconcileOobMutations(store: MutationAuditStore, opts?: ReconcileOptions): Promise<ReconcileResult>;
/**
 * Register the out-of-band reconcile sweep as a periodic cron driver.
 * Call from index.ts bootstrap alongside the other periodic sweeps.
 */
export declare function registerOobReconcileCron(store: MutationAuditStore, operationalEventStore?: OperationalEventStore, intervalMs?: number): void;
//# sourceMappingURL=oob-reconcile-sweep.d.ts.map