import { type WakeUpConfig } from "./wake-up.js";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
export interface DispatchResult {
    ticketId: string;
    dispatched: boolean;
    runId?: string;
    pruned?: boolean;
    /** True when dispatch was skipped because the routing check returned fail-open and failOpenBehavior is "defer". */
    deferred?: boolean;
    /** Canon version injected into this dispatch (null when no canon loaded). */
    canonVersion?: string | null;
}
export interface ResignalOptions {
    /** Mark the agent active for the first successfully signaled ticket. */
    markActive?: boolean;
    /** Optional test hook / policy override for pruning no-longer-actionable tickets. */
    isTicketActionable?: (ticketId: string, agentId: string) => boolean | Promise<boolean>;
    /** Optional test hook for delivery. */
    sendWakeUp?: (agentId: string, ticketIds: string[], config: WakeUpConfig) => Promise<{
        runId?: string;
        canonVersion?: string;
    } | void>;
    /** Optional callback after successful dispatch — used for ack tracking. */
    onDispatched?: (agentId: string, ticketId: string) => void;
    /**
     * How to handle a fail-open result (transient Linear API error) during the default routing check.
     * - "dispatch" (default): treat as actionable and dispatch — preserves fail-open protection for
     *   live webhook events where dropping legitimate work would be worse than a spurious wake-up.
     * - "defer": skip dispatch but leave in bag for retry on the next connector start — safe for
     *   startup-replay where a transient error should not resurrect Done tickets.
     * Has no effect when isTicketActionable is provided (custom override bypasses this logic).
     */
    failOpenBehavior?: "dispatch" | "defer";
}
/**
 * Re-signal queued work one Linear issue at a time.
 *
 * A single multi-ticket wake-up is dangerous because OpenClaw keys the session by
 * one `linear-TEAM-N` value; unrelated tickets then land in the first ticket's
 * session. This helper preserves one per-ticket session key per pending ticket.
 */
export declare function resignalPendingTickets(agentId: string, ticketIds: string[], bag: PendingWorkBag, sessionTracker: SessionTracker, wakeConfig: WakeUpConfig, options?: ResignalOptions): Promise<DispatchResult[]>;
//# sourceMappingURL=resignal.d.ts.map