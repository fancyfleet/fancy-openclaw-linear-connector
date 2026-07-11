/**
 * Stewardship wake-up signal for Managing-state tickets.
 *
 * Bundles all due Managing tickets for an agent into a single wake message
 * so an agent with several stewardship tickets doesn't get woken once per
 * ticket. Uses the first ticket's `linear-<ID>` session key as the bundle
 * session, consistent with how multi-ticket bag wakes already work.
 *
 * The agent receives a prompt that lists each ticket plus a short checklist
 * of stewardship duties (subtask state, delegate sanity, ownership drift).
 */
import { type DeliveryConfig } from "../delivery/index.js";
export interface ManagingWakeTicket {
    identifier: string;
    title: string;
    /** Epoch ms of last stewardship wake for this ticket, or null if first time. */
    lastDispatchedAt: number | null;
}
export declare function buildManagingWakeMessage(tickets: ManagingWakeTicket[], now?: number): string;
/**
 * Deliver a stewardship wake to an agent for one or more due Managing tickets.
 * Uses the first ticket's `linear-<ID>` session key as the bundle session.
 */
export declare function sendManagingWakeSignal(agentId: string, tickets: ManagingWakeTicket[], config: DeliveryConfig): Promise<{
    runId?: string;
} | void>;
//# sourceMappingURL=managing-wake.d.ts.map