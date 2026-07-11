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
import { normalizeSessionKey } from "../session-key.js";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = (attempt) => Math.min(attempt * 5000, 60000);
const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A failed attempt with an explicit error is "failed"; a silent miss is "unconfirmed". */
function failureOutcome(result) {
    return result.hookError || result.hookErrorSummary ? "delivery-failed" : "delivery-unconfirmed";
}
export async function deliverWithAck(params) {
    const { agentId, ticketId, workflowState, gateway, dispatchId, deliver, eventStore, ackTracker, } = params;
    const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoffMs = params.backoffMs ?? DEFAULT_BACKOFF_MS;
    const sleep = params.sleep ?? DEFAULT_SLEEP;
    // Canonical key for the operational event store and ack tracker.
    const key = normalizeSessionKey(ticketId);
    // Display ticket id for the loud warning (strip any linear- prefix).
    const displayTicket = ticketId.replace(/^linear-/i, "").toUpperCase();
    const totalAttempts = maxRetries + 1;
    const baseDetail = {
        ticket: displayTicket,
        state: workflowState ?? null,
        delegate: agentId,
        gateway: gateway ?? null,
        dispatchId,
    };
    let attempt = 0;
    while (attempt < totalAttempts) {
        attempt += 1;
        const result = await deliver({ attempt, dispatchId });
        if (result.dispatched) {
            // AC1: record the delivery outcome — no fire-and-forget.
            eventStore.append({
                outcome: "delivered",
                agent: agentId,
                key,
                sessionKey: key,
                workflowState: workflowState ?? null,
                attemptCount: attempt,
                runId: result.runId ?? null,
                wakeId: dispatchId,
                detail: baseDetail,
            });
            // Register the ack expectation so an unacked wake self-heals via the watchdog.
            ackTracker.recordDispatch(agentId, ticketId);
            return { status: "delivered", attempts: attempt, dispatchId };
        }
        // AC2: log every failed/unconfirmed attempt to the operational event store.
        eventStore.append({
            outcome: failureOutcome(result),
            agent: agentId,
            key,
            sessionKey: key,
            workflowState: workflowState ?? null,
            attemptCount: attempt,
            wakeId: dispatchId,
            errorSummary: result.hookErrorSummary ?? null,
            detail: baseDetail,
        });
        // Bounded retry with backoff — only wait when another attempt follows.
        if (attempt < totalAttempts) {
            params.onRetryScheduled?.();
            try {
                await sleep(backoffMs(attempt));
            }
            finally {
                params.onRetryResolved?.();
            }
        }
    }
    // AC3: every attempt failed — emit a loud, first-class undeliverable warning
    // naming ticket, state, delegate, and gateway. Not a silent log line.
    eventStore.append({
        outcome: "dispatch-undeliverable",
        agent: agentId,
        key,
        sessionKey: key,
        workflowState: workflowState ?? null,
        attemptCount: totalAttempts,
        wakeId: dispatchId,
        errorSummary: `dispatch-undeliverable after ${totalAttempts} attempt(s): ${displayTicket} (${workflowState ?? "?"}) → ${agentId} @ ${gateway ?? "?"}`,
        detail: baseDetail,
    });
    return { status: "undeliverable", attempts: totalAttempts, dispatchId };
}
//# sourceMappingURL=deliver-with-ack.js.map