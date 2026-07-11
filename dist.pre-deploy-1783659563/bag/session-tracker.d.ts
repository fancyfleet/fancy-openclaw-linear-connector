/**
 * Per-agent session state tracker.
 *
 * Tracks which (agent, ticket) pairs currently have active sessions. The connector
 * uses this to decide whether to send a wake-up signal immediately or defer.
 *
 * Each ticket gets its own independent session key (`linear-<TEAM>-<NUMBER>`).
 * An agent can have multiple concurrent active sessions — one per in-flight ticket.
 * Same-ticket dedup: a second webhook for the same ticket delivers into the existing
 * session immediately. Different-ticket webhooks always dispatch independently.
 *
 * Session-end detection: the connector exposes a POST /session-end endpoint
 * that the gateway (or a gateway plugin) calls when an agent's session ends.
 * The endpoint accepts an optional `sessionKey` for precise per-ticket tracking;
 * if omitted, all sessions for the agent are cleared (backward compat).
 * If no callback arrives within a timeout, sessions are assumed ended.
 */
export interface StaleSessionDetail {
    agentId: string;
    sessionKey: string;
    startedAt: number;
    timeoutMs: number;
    pendingTickets: string[];
}
export type StaleSessionHandler = (staleSessions: StaleSessionDetail[]) => void | Promise<void>;
export declare class SessionTracker {
    private activeSessions;
    private sessionTimeoutMs;
    private pendingSignals;
    private cleanupTimer?;
    private onStaleSessions?;
    constructor(sessionTimeoutMs?: number, onStaleSessions?: StaleSessionHandler);
    /**
     * Mark a per-ticket session as active.
     *
     * Returns false only if this exact (agentId, sessionKey) pair is already
     * tracked — same-ticket dedup. Different session keys for the same agent are
     * allowed concurrently; this method will return true for each distinct key.
     */
    startSession(agentId: string, sessionKey: string): boolean;
    /**
     * Mark a session as ended.
     *
     * If sessionKey is provided, removes only that specific (agentId, sessionKey)
     * entry. Pending signals are returned only when the agent has no remaining
     * active sessions after this call.
     *
     * If sessionKey is omitted, all sessions for the agent are cleared (backward
     * compatibility for callers that don't track per-ticket session keys, e.g. the
     * existing gateway plugin which sends only agentId).
     */
    endSession(agentId: string, sessionKey?: string): string[] | null;
    /**
     * Check if an agent has any active session.
     */
    isActive(agentId: string): boolean;
    /**
     * Check if an agent has an active session for a specific ticket key.
     */
    isActiveForTicket(agentId: string, sessionKey: string): boolean;
    /**
     * Check whether any agent currently has an active session for a ticket key,
     * optionally ignoring one agent. Used by the engagement-status overlay to
     * decide, at session-end, whether a successor (post-handoff delegate) already
     * holds the ticket — in which case the ending agent must NOT reset it to To Do.
     */
    isTicketActiveForAnyAgent(sessionKey: string, exceptAgentId?: string): boolean;
    /**
     * Queue a retry signal for a ticket whose delivery failed.
     * Will be returned from endSession() when all the agent's sessions complete.
     */
    queueSignal(agentId: string, ticketIds: string[]): void;
    /** Remove a queued pending signal, optionally across all agents. */
    removePendingTicket(ticketId: string, agentId?: string): number;
    /** Get the first active session key for an agent, or null. */
    getActiveSessionKey(agentId: string): string | null;
    /** Get all active session keys for an agent. */
    getActiveSessionKeys(agentId: string): string[];
    /** Get active-session metadata for the first session (diagnostics/metrics). */
    getActiveSessionInfo(agentId: string): {
        agentId: string;
        sessionKey: string;
        startedAt: number;
        ageMs: number;
    } | null;
    /** Get all currently active agent IDs. */
    getActiveAgents(): string[];
    close(): void;
    /**
     * Clean up stale sessions that exceeded the timeout.
     * Returns an array of StaleSessionDetail for sessions that were stale.
     * Each entry includes the session key, start time, timeout, and any
     * pending tickets that were queued for the agent.
     */
    cleanupStale(): StaleSessionDetail[];
}
//# sourceMappingURL=session-tracker.d.ts.map