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
import { registerCron, formatIntervalMs } from "../cron/registry.js";
import { createLogger, componentLogger } from "../logger.js";
import { deliverWithAck, } from "./deliver-with-ack.js";
const log = componentLogger(createLogger(), "dispatch-delivery-scheduler");
const DEFAULT_HEARTBEAT_MS = 60000;
export class DispatchDeliveryScheduler {
    constructor(deps) {
        this.deps = deps;
        this.active = false;
        this.inFlightRetries = 0;
        this.heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    }
    /** Arm the driver. Registers in the cron registry on the timer-creation path. */
    start() {
        if (this.active)
            return;
        this.active = true;
        this.heartbeat = setInterval(() => {
            // Liveness heartbeat only — the retry loop runs inline in dispatch().
        }, this.heartbeatMs);
        this.heartbeat.unref?.();
        registerCron("dispatch-delivery-scheduler", `every ${formatIntervalMs(this.heartbeatMs)}`);
        log.info("dispatch delivery scheduler armed");
    }
    stop() {
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        this.active = false;
    }
    get schedulerActive() {
        return this.active;
    }
    get pendingRetries() {
        return this.inFlightRetries;
    }
    /** /health liveness field: `{ schedulerActive, pendingRetries }` (AC1, AI-1808). */
    liveness() {
        return { schedulerActive: this.active, pendingRetries: this.inFlightRetries };
    }
    /** Deliver a wake through the acknowledged, retrying, loud-failure path. */
    dispatch(params) {
        return deliverWithAck({
            ...params,
            eventStore: this.deps.eventStore,
            ackTracker: this.deps.ackTracker,
            onRetryScheduled: () => {
                this.inFlightRetries++;
            },
            onRetryResolved: () => {
                this.inFlightRetries = Math.max(0, this.inFlightRetries - 1);
            },
        });
    }
}
//# sourceMappingURL=dispatch-delivery-scheduler.js.map