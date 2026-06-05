/**
 * Wake-up signal delivery.
 *
 * Sends a thin "you have N pending tickets" message to an agent when the bag
 * has work for them and they're not in an active session. The agent then uses
 * `linear consider-work <ID>` (single ticket) or `linear queue --next` /
 * `linear queue` (multiple tickets) to fetch and process work in priority order.
 *
 * NOTE: The session key uses the ticket's `linear-<IDENTIFIER>` format (e.g.
 * `linear-ILL-148`) so that the wake-up session shares context with any
 * subsequent webhook events for the same ticket. For multi-ticket wake-ups,
 * the first ticket's identifier is used as the key.
 */
import { type DeliveryConfig } from "../delivery/index.js";
export interface WakeUpConfig extends DeliveryConfig {
    /** Signal message template. {count} and {tickets} are replaced. */
    signalTemplate?: string;
}
export declare const SINGLE_TICKET_TEMPLATE = "You have 1 pending ticket: {tickets}. Run `linear consider-work {tickets}` to begin.";
export declare const MULTI_TICKET_TEMPLATE = "You have {count} pending ticket(s) waiting: {tickets}. Run `linear queue --next` to pick up the highest-priority one, or `linear queue` to see all.";
export declare const MENTION_TICKET_TEMPLATE = "You have been @mentioned on ticket: {tickets}. Run `linear observe-issue {tickets}` to review.";
export declare function buildWakeUpMessage(ticketIds: string[], signalTemplate?: string): string;
/**
 * Send a wake-up signal to an agent.
 *
 * The signal is intentionally thin — just tells the agent how many tickets
 * are pending and their IDs. The agent re-queries Linear for full details.
 */
export declare function sendWakeUpSignal(agentId: string, ticketIds: string[], config: WakeUpConfig): Promise<{
    runId?: string;
} | void>;
//# sourceMappingURL=wake-up.d.ts.map