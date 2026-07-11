/**
 * SQLite-backed bookkeeping for Managing-state stewardship wakes.
 *
 * For each (agent, ticket) pair in the Managing state, tracks when the agent
 * was last woken to review it. The ManagingPoller uses this to decide whether
 * the next wake is due, given the ticket's configured interval.
 *
 * This is purely operational state. Wiping it causes a one-time burst of
 * stewardship wakes (everything looks "never dispatched"), which is recoverable.
 */
export interface ManagingEntry {
    agentId: string;
    ticketId: string;
    lastDispatchedAt: number | null;
}
export declare class ManagingStateStore {
    private db;
    constructor(dbPath?: string);
    private migrate;
    /** Read the last-dispatched timestamp for one (agent, ticket). null if never dispatched. */
    getLastDispatched(agentId: string, ticketId: string): number | null;
    /** Record a stewardship wake dispatch for a (agent, ticket) at the given epoch ms. */
    recordDispatch(agentId: string, ticketId: string, atMs: number): void;
    /** Ensure a (agent, ticket) row exists. Leaves last_dispatched_at as null when freshly inserted. */
    ensure(agentId: string, ticketId: string): void;
    /** Remove the row when a ticket leaves Managing or is no longer delegated to the agent. */
    remove(agentId: string, ticketId: string): void;
    /** Drop entries that aren't in the current set of (agent, ticket) pairs returned from Linear. */
    pruneAgent(agentId: string, currentTicketIds: string[]): number;
    /** All rows for an agent. Useful for diagnostics. */
    listByAgent(agentId: string): ManagingEntry[];
    close(): void;
}
//# sourceMappingURL=managing-state-store.d.ts.map