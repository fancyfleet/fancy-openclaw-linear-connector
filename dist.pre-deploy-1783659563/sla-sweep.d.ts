/**
 * AI-1773 — SLA evaluation driver for standalone governed tickets.
 *
 * Periodically sweeps all governed tickets (wf:* labels) and emits a
 * warning-level alert + steward wake for any ticket whose time in its current
 * state exceeds the per-state `sla:` value from the loaded workflow def.
 *
 * Design constraints:
 *  - One SLA vocabulary: reads `sla:` from workflow defs only.
 *  - No double-fire: managed children (barrier stall path) are excluded via
 *    isManagedBarrierFromLabels imported from barrier.ts — the same predicate,
 *    not a parallel heuristic.
 *  - Restart-resilient: breach dedup keyed on (ticket_id, state_entered_at_ms)
 *    in a SQLite store so restarts neither lose nor re-fire alerted breaches.
 *  - Batch fetch: one GraphQL query for all governed tickets; no per-ticket
 *    Linear API fan-out during the listing phase.
 */
export interface SlaSweepOptions {
    authToken: string;
    /** Path to a single YAML file or a directory of *.yaml files containing workflow defs.
     *  In directory mode (production WORKFLOW_DEFS_DIR), all *.yaml files are loaded. */
    workflowDefPath: string;
    /** Injectable fetch for testing; defaults to globalThis.fetch. */
    fetchFn?: (url: string | URL, init?: RequestInit) => Promise<Response>;
    /** Alert bus notify() — called once per new breach. */
    notify: (alert: {
        severity: string;
        source: string;
        title: string;
        ticket?: string;
        [key: string]: unknown;
    }) => void;
    /** Steward wake — called once per new breach. */
    wakeAgent: (identifier: string) => Promise<void>;
    /** Clock override for testing (epoch ms). */
    now?: () => number;
    /** Path to the SQLite breach store. Omit for per-call in-memory (no cross-call dedup). */
    breachStorePath?: string;
    /** Sweep cadence in ms for registerSlaSweepCron; defaults to 5 minutes. */
    cadenceMs?: number;
}
export interface SlaSweepResult {
    /** Total governed tickets found in this sweep. */
    scanned: number;
    /** Managed children excluded (barrier stall path owns them). */
    managedChildrenExcluded: number;
    /** Tickets whose time in state exceeds the SLA (before dedup). */
    breachesDetected: number;
    /** New alerts emitted (after dedup). */
    alertsEmitted: number;
    /** Steward wakes dispatched. */
    wakesDispatched: number;
    /** Non-fatal errors encountered during the sweep. */
    errors: unknown[];
}
/**
 * Run one SLA evaluation sweep over all governed tickets.
 *
 * Fetches all tickets with wf:* labels in a single batch query (AC5), checks
 * each for SLA breach, excludes managed children (AC2), and emits exactly one
 * alert + one steward wake per new breach (AC1, deduped via breach store, AC3).
 */
export declare function runSlaSweep(opts: SlaSweepOptions): Promise<SlaSweepResult>;
/**
 * Register a recurring SLA sweep on a configurable interval.
 * Returns the timer handle so the caller can cancel it on shutdown.
 * The timer is unref'd so it does not prevent process exit.
 */
export declare function registerSlaSweepCron(opts: SlaSweepOptions): ReturnType<typeof setInterval>;
//# sourceMappingURL=sla-sweep.d.ts.map