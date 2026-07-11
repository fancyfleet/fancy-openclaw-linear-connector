/**
 * AI-2008 — Dispatch delivery acknowledgment + retry — no fire-and-forget wakes.
 *
 * `deliverWithAck` is the seam that removes the fire-and-forget dispatch path.
 * It wraps a single delivery attempt with:
 *   - a recorded delivery outcome for EVERY attempt (AC1: no fire-and-forget),
 *   - bounded retry-with-backoff on failed/unconfirmed delivery (AC2),
 *   - a loud `dispatch-undeliverable` warning after the final attempt fails,
 *     naming ticket / state / delegate / gateway (AC3),
 *   - an ack expectation registered on success so an unacked wake still
 *     self-heals via the dispatch watchdog,
 *   - a stable dispatch id reused across every retry so the receiver can dedup
 *     — a retried wake never executes twice (AC5).
 *
 * `deliver` is injected so the orchestration is exercisable without a live
 * gateway; `sleep` is injected so backoff is asserted without real timers.
 */
import type { OperationalEventStore } from "../store/operational-event-store.js";
import type { DispatchAckTracker } from "../bag/dispatch-ack-tracker.js";
import type { DeliveryResult } from "./deliver.js";
export interface DeliverWithAckParams {
    /** Delegate agent id (also the "delegate" named in the loud warning). */
    agentId: string;
    /** Linear ticket id (raw, e.g. "AI-2008" — normalized internally for keys). */
    ticketId: string;
    /** Workflow state at dispatch time (e.g. "implementation"). */
    workflowState?: string;
    /** Gateway/host the delegate lives on (e.g. "grover"). */
    gateway?: string;
    /**
     * Stable dispatch id. Reused verbatim across every retry so the receiving
     * side can dedup (idempotent) — a retried wake never double-executes.
     */
    dispatchId: string;
    /** The single-attempt delivery primitive. Injected for testability. */
    deliver: (ctx: {
        attempt: number;
        dispatchId: string;
    }) => Promise<DeliveryResult>;
    eventStore: OperationalEventStore;
    ackTracker: DispatchAckTracker;
    /** Max RETRIES after the first attempt (bounded). Total attempts = maxRetries + 1. */
    maxRetries?: number;
    /** Backoff before the Nth retry, keyed by the attempt that just failed. */
    backoffMs?: (attempt: number) => number;
    /** Sleep primitive. Injected so backoff is deterministic in tests. */
    sleep?: (ms: number) => Promise<void>;
    /**
     * AI-2008: retry-depth observers so the DispatchDeliveryScheduler can report a
     * genuine live `pendingRetries` (in-flight backoff waits in the delivery
     * layer), not a value derived from a pre-existing store. Called around each
     * backoff wait; no-ops when a caller invokes deliverWithAck directly.
     */
    onRetryScheduled?: () => void;
    onRetryResolved?: () => void;
}
export interface DeliverWithAckOutcome {
    status: "delivered" | "undeliverable";
    attempts: number;
    dispatchId: string;
}
export declare function deliverWithAck(params: DeliverWithAckParams): Promise<DeliverWithAckOutcome>;
//# sourceMappingURL=deliver-with-ack.d.ts.map