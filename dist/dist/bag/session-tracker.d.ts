/**
 * Per-agent session state tracker.
 *
 * Tracks which agents currently have active sessions. The connector uses this
 * to decide whether to send a wake-up signal immediately (no active session)
 * or defer (agent is busy; signal after session ends).
 *
 * Session-end detection: the connector exposes a POST /session-end endpoint
 * that the gateway (or a gateway plugin) calls when an agent's session ends.
 * If no callback arrives within a timeout, the session is assumed ended.
 *
 * NOTE: Session keys follow the canonical `linear-<TEAM>-<NUMBER>` format
 * (e.g. `linear-ILL-152`) so that connector sessions share context with
 * subsequent webhook events for the same ticket. Once the gateway plugin
 * is implemented (see follow-up ticket), the real gateway session ID
 * should round-trip through the connector instead.
 */
export type StaleSessionHandler = (staleSessions: {
    agentId: string;
    pendingTickets: string[];
}[]) => void | Promise<void>;
export declare class SessionTracker {
    private activeSessions;
    private sessionTimeoutMs;
    private pendingSignals;
    private cleanupTimer?;
    private onStaleSessions?;
    constructor(sessionTimeoutMs?: number, onStaleSessions?: StaleSessionHandler);
    /**
     * Mark an agent's session as active. Returns false if the agent already
     * has an active session (caller should queue work instead).
     */
    startSession(agentId: string, sessionKey: string): boolean;
    /**
     * Mark an agent's session as ended. If there are pending signals for this
     * agent, returns the ticket IDs that should trigger a new wake-up.
     */
    endSession(agentId: string): string[] | null;
    /**
     * Check if an agent has an active session.
     */
    isActive(agentId: string): boolean;
    /**
     * Queue a signal for an agent that's currently busy.
     * Will be returned from endSession() when the session completes.
     */
    queueSignal(agentId: string, ticketIds: string[]): void;
    /** Remove a queued pending signal, optionally across all agents. */
    removePendingTicket(ticketId: string, agentId?: string): number;
    /** Get the session key for an active agent session, or null. */
    getActiveSessionKey(agentId: string): string | null;
    /** Get active-session metadata for diagnostics/metrics, or null. */
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
     * Returns an array of { agentId, pendingTickets } for agents that had
     * pending signals queued, so the caller can re-signal them.
     */
    cleanupStale(): {
        agentId: string;
        pendingTickets: string[];
    }[];
}
//# sourceMappingURL=session-tracker.d.ts.map