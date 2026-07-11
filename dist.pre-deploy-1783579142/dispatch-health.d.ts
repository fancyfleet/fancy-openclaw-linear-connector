/**
 * AI-1801 — Dispatch-health badge projection.
 *
 * Pure projection from operational-events.db (joined on wake_id) and the
 * dispatch-ack tracker. No new instrumentation is added anywhere — this module
 * only reads existing signals and maps them to one of six badge states.
 *
 * Badge states:
 *   working     — engagement (thinking/doing) seen recently for this ticket
 *   quiet       — dispatch accepted, no engagement yet (within grace window)
 *   unconfirmed — delivery unconfirmed or watchdog re-signaling; show attempt N/3
 *   exhausted   — max re-signals reached, needs intervention
 *   at-capacity — wake parked because agent is at maxConcurrent
 *   idle        — no live wake cycle for this ticket
 *
 * The function is pure: given the events and ack entry, it returns a badge
 * state. This makes it trivially testable with fixtures.
 */
import type { OperationalEvent } from "./store/operational-event-store.js";
import type { DispatchAckEntry } from "./bag/dispatch-ack-tracker.js";
export type DispatchHealthBadge = "working" | "quiet" | "unconfirmed" | "exhausted" | "at-capacity" | "idle";
export interface DispatchHealth {
    badge: DispatchHealthBadge;
    /** Attempt number for unconfirmed (N of max), null otherwise. */
    attempt: number | null;
    /** Max attempts (for display "N/3"). */
    maxAttempts: number;
}
export interface ComputeDispatchHealthOptions {
    /** Max re-signal attempts before exhaustion. Default: 3 (WATCHDOG_MAX_RESIGNALS). */
    maxAttempts?: number;
    /** How recently engagement must be to count as "working". */
    workingThresholdMs?: number;
    /** Grace window for "quiet" state after dispatch. */
    quietGraceMs?: number;
    /** Override "now" for deterministic testing. */
    now?: number;
}
/**
 * Compute the dispatch-health badge for a single ticket.
 *
 * @param events - Operational events for this ticket (queried by key or wake_id)
 * @param ackEntry - The dispatch-ack tracker entry for this ticket, or null
 * @param options - Tuning / test overrides
 */
export declare function computeDispatchHealth(events: OperationalEvent[], ackEntry: DispatchAckEntry | null, options?: ComputeDispatchHealthOptions): DispatchHealth;
/**
 * Batch-compute dispatch health for all tickets on the board.
 *
 * @param ticketKeys - Map of ticketId → operational events for that ticket
 * @param ackEntriesByTicket - Map of ticketId → ack entry
 * @param options - Tuning overrides
 */
export declare function batchComputeDispatchHealth(ticketKeys: Map<string, OperationalEvent[]>, ackEntriesByTicket: Map<string, DispatchAckEntry | null>, options?: ComputeDispatchHealthOptions): Map<string, DispatchHealth>;
//# sourceMappingURL=dispatch-health.d.ts.map