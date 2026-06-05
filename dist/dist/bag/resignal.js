import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
import { sendWakeUpSignal } from "./wake-up.js";
import { isLinearIssueActionable } from "../linear-actionable.js";
const log = componentLogger(createLogger(), "resignal");
/**
 * Re-signal queued work one Linear issue at a time.
 *
 * A single multi-ticket wake-up is dangerous because OpenClaw keys the session by
 * one `linear-TEAM-N` value; unrelated tickets then land in the first ticket's
 * session. This helper preserves one per-ticket session key per pending ticket.
 */
export async function resignalPendingTickets(agentId, ticketIds, bag, sessionTracker, wakeConfig, options = {}) {
    const normalizedTickets = [...new Set(ticketIds.map((ticketId) => normalizeSessionKey(ticketId)))];
    const isTicketActionable = options.isTicketActionable ?? isLinearIssueActionable;
    const sendWakeUp = options.sendWakeUp ?? sendWakeUpSignal;
    let sent = 0;
    for (const ticketId of normalizedTickets) {
        try {
            if (!(await isTicketActionable(ticketId, agentId))) {
                bag.removeTicket(agentId, ticketId);
                sessionTracker.removePendingTicket(ticketId, agentId);
                log.info(`Pruned non-actionable pending ticket for ${agentId} [${ticketId}] before wake-up dispatch`);
                continue;
            }
            await sendWakeUp(agentId, [ticketId], wakeConfig);
            bag.removeTicket(agentId, ticketId);
            bag.recordSignal();
            if (options.markActive && sent === 0) {
                sessionTracker.startSession(agentId, ticketId);
            }
            sent++;
        }
        catch (err) {
            log.error(`Re-signal failed for ${agentId} [${ticketId}]: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return sent;
}
//# sourceMappingURL=resignal.js.map