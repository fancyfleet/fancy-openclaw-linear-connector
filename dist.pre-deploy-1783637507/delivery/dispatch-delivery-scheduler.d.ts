/**
 * AI-2008 — DispatchDeliveryScheduler.
 *
 * The armed, bootstrap-wired front door for acknowledged dispatch delivery. It
 * owns the retry/ack machinery (deliverWithAck) and is the object real dispatch
 * sites route through, so every workflow wake records a delivery outcome and
 * retries on failure (AC1: no fire-and-forget path).
 *
 * Liveness is genuine, not cosmetic: `schedulerActive` is false until `start()`
 * arms the driver and registers it in the connector cron registry, and
 * `pendingRetries` is the live count of in-flight retry waits inside the
 * delivery layer — not a value derived from a pre-existing store. This is the
 * dead-code-in-prod guard from AI-1808 (AI-1773/AI-1775 shipped fully tested but
 * never registered at bootstrap).
 */
import { OperationalEventStore } from "../store/operational-event-store.js";
import { DispatchAckTracker } from "../bag/dispatch-ack-tracker.js";
import { type DeliverWithAckParams, type DeliverWithAckOutcome } from "./deliver-with-ack.js";
export interface DispatchDeliverySchedulerDeps {
    eventStore: OperationalEventStore;
    ackTracker: DispatchAckTracker;
    /** Liveness heartbeat interval; the timer keeps the driver observably armed. */
    heartbeatMs?: number;
}
/** Per-dispatch params — the stores + retry observers are supplied by the scheduler. */
export type SchedulerDispatchParams = Omit<DeliverWithAckParams, "eventStore" | "ackTracker" | "onRetryScheduled" | "onRetryResolved">;
export declare class DispatchDeliveryScheduler {
    private readonly deps;
    private active;
    private inFlightRetries;
    private heartbeat?;
    private readonly heartbeatMs;
    constructor(deps: DispatchDeliverySchedulerDeps);
    /** Arm the driver. Registers in the cron registry on the timer-creation path. */
    start(): void;
    stop(): void;
    get schedulerActive(): boolean;
    get pendingRetries(): number;
    /** /health liveness field: `{ schedulerActive, pendingRetries }` (AC1, AI-1808). */
    liveness(): {
        schedulerActive: boolean;
        pendingRetries: number;
    };
    /** Deliver a wake through the acknowledged, retrying, loud-failure path. */
    dispatch(params: SchedulerDispatchParams): Promise<DeliverWithAckOutcome>;
}
//# sourceMappingURL=dispatch-delivery-scheduler.d.ts.map