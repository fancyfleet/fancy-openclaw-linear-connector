/**
 * HoldRetryTracker — per-(agent, ticket) hold-retry state.
 *
 * Problem (AI-1533): When an agent is dispatched for a ticket but produces no
 * state-advancing workflow transition before its session ends (e.g. it hit a
 * transient error and held with "no action taken"), the connector silently strands
 * the ticket. The no-activity-detector handles sessions that never start; this
 * tracker handles the complementary case — sessions that start, run briefly, and
 * end without a qualifying transition.
 *
 * How it works:
 *   1. onAgentActivity (webhook: agent authored Linear activity) → recordTransition
 *   2. /session-end callback → inspect ended session keys:
 *      - Transition seen: healthy run → clearTicket (reset all state)
 *      - No transition + holdAttempts < maxAttempts → shouldRetryHold → re-dispatch
 *      - No transition + holdAttempts >= maxAttempts → fall through to no-activity-detector
 *
 * Configuration (env vars, all optional):
 *   DISPATCH_RETRY_GRACE_MS       — max dispatch age (session duration) for hold-retry (default: 120s)
 *   DISPATCH_RETRY_MAX_ATTEMPTS   — max hold retries before falling through (default: 2)
 */
export interface HoldRetryConfig {
    /** Max dispatch age (ms) within which a hold will be retried. Default: 120 000. */
    graceMs: number;
    /** Max hold-retry attempts before falling through to no-activity-detector. Default: 2. */
    maxAttempts: number;
}
export declare class HoldRetryTracker {
    /** agentId → Set<ticketId> */
    private transitionSeen;
    /** agentId → ticketId → holdAttemptCount */
    private holdAttempts;
    readonly config: HoldRetryConfig;
    constructor(config?: Partial<HoldRetryConfig>);
    /**
     * Record that the agent authored a state-advancing transition for this ticket.
     * Called via the onAgentActivity webhook callback.
     */
    recordTransition(agentId: string, ticketId: string): void;
    /** True if a transition was observed for this (agent, ticket) since the last clearTransition/clearTicket. */
    hasTransition(agentId: string, ticketId: string): boolean;
    /** Current hold-retry attempt count for this (agent, ticket). */
    getHoldAttempts(agentId: string, ticketId: string): number;
    /**
     * Increment the hold-retry count and return the new value.
     * Called after deciding to re-dispatch; never called when a transition was seen.
     */
    incrementHoldAttempt(agentId: string, ticketId: string): number;
    /**
     * Return true if this (agent, ticket) should be re-dispatched after a hold.
     *
     * @param agentId
     * @param ticketId
     * @param dispatchAgeMs  Age of the dispatch in ms. When provided, retries are
     *   suppressed if the dispatch is older than graceMs — indicating a long-running
     *   deliberate hold rather than a transient error. Pass undefined to skip the age
     *   check (e.g., when the dispatch record is unavailable).
     */
    shouldRetryHold(agentId: string, ticketId: string, dispatchAgeMs?: number): boolean;
    /**
     * Clear transition state only — called for hold-end (no transition, will retry).
     * The holdAttempt count is preserved so the next hold is counted correctly.
     */
    clearTransition(agentId: string, ticketId: string): void;
    /**
     * Clear all state for this (agent, ticket): transition flag AND attempt count.
     * Call when a healthy run completes (transition seen) or the ticket changes delegate.
     */
    clearTicket(agentId: string, ticketId: string): void;
}
//# sourceMappingURL=hold-retry-tracker.d.ts.map