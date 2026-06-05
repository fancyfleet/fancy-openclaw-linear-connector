import { sendWakeUpSignal, type WakeUpConfig } from "./wake-up.js";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
export interface ResignalOptions {
    /** Mark the agent active for the first successfully signaled ticket. */
    markActive?: boolean;
    /** Optional test hook / policy override for pruning no-longer-actionable tickets. */
    isTicketActionable?: (ticketId: string, agentId: string) => boolean | Promise<boolean>;
    /** Optional test hook for delivery. */
    sendWakeUp?: typeof sendWakeUpSignal;
}
/**
 * Re-signal queued work one Linear issue at a time.
 *
 * A single multi-ticket wake-up is dangerous because OpenClaw keys the session by
 * one `linear-TEAM-N` value; unrelated tickets then land in the first ticket's
 * session. This helper preserves one per-ticket session key per pending ticket.
 */
export declare function resignalPendingTickets(agentId: string, ticketIds: string[], bag: PendingWorkBag, sessionTracker: SessionTracker, wakeConfig: WakeUpConfig, options?: ResignalOptions): Promise<number>;
//# sourceMappingURL=resignal.d.ts.map