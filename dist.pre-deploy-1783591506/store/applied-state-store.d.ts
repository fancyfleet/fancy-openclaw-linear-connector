/**
 * AI-1534 — Authoritative post-transition state cache.
 *
 * Linear's GraphQL reads are eventually consistent. After the connector applies
 * a state transition (the proxy is the SOLE writer of transitions — see
 * applyStateTransition), a near-immediate label read by the outbound per-step
 * delivery path (build-message.ts → fetchWorkflowLabels) can still return the
 * PRE-transition state. That read-after-write lag made a freshly-reassigned
 * delegate (e.g. tdd on AI-1531) be told to run the previous state's verb
 * (`accept` from `write-tests`), which the gate then rejected as illegal,
 * stalling the ticket.
 *
 * Because the connector knows the authoritative destination state at write time,
 * we record it here, keyed by human issue identifier (e.g. "AI-1531"), with a
 * short TTL. The delivery path prefers this value over the (possibly-stale) live
 * read while it is fresh. After the TTL the live read is authoritative again.
 *
 * In-memory only: the lag window is seconds, and a connector restart drops
 * in-flight deliveries anyway. Keeping it off-disk also avoids the shared
 * /tmp state-file hazard that has bitten other stores.
 */
/** How long a recorded post-transition state is trusted over a live read. */
export declare const APPLIED_STATE_TTL_MS = 60000;
/** Record the authoritative destination state for a just-applied transition. */
export declare function recordAppliedState(issueId: string, state: string, now?: number): void;
/**
 * Return the recorded post-transition state if it is still within the TTL,
 * else null. Expired entries are evicted on read.
 */
export declare function getAppliedState(issueId: string, now?: number): string | null;
/**
 * Drop any recorded state for a ticket. Called when a ticket leaves the
 * workflow (demote to ad-hoc) or reaches a terminal disposition, so a stale
 * cached state can never override a later live read.
 */
export declare function clearAppliedState(issueId: string): void;
/** Test helper — reset the in-memory store between cases. */
export declare function _resetAppliedStateStore(): void;
//# sourceMappingURL=applied-state-store.d.ts.map