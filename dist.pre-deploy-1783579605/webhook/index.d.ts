import { Router } from "express";
import type { LinearEvent } from "./schema.js";
import { EventStore } from "../store/event-store.js";
import { NudgeStore } from "../store/nudge-store.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import type { EnrolledTicketsStore } from "../store/enrolled-tickets-store.js";
import type { MutationAuditStore } from "../store/mutation-audit-store.js";
import type { DispatchIdempotencyStore } from "../store/dispatch-idempotency-store.js";
import { DeliveryThrottle } from "../delivery/index.js";
import { AgentQueue } from "../queue/index.js";
import { PendingWorkBag, SessionTracker } from "../bag/index.js";
export type { LinearEvent } from "./schema.js";
export { verifyLinearSignature } from "./signature.js";
export { normalizeLinearEvent } from "./normalize.js";
/**
 * Rebuild WS1 (2026-07-03, pilot finding): Comment webhooks carry no delegate,
 * so "a comment wakes the ticket's delegate" NEVER worked — every plain
 * comment no-routed (verified live: AI-1755/AI-1756). Before routing, fetch
 * the issue's delegate/assignee and graft them onto event.data so the
 * standard sync router path (delegate → assignee → mention) applies.
 * Fail-open: on any error the event routes as before (mentions still work).
 */
export declare function enrichCommentEventForRouting(event: LinearEvent): Promise<void>;
export declare function createWebhookRouter(eventStore?: EventStore, nudgeStore?: NudgeStore, agentQueue?: AgentQueue, bag?: PendingWorkBag, sessionTracker?: SessionTracker, throttle?: DeliveryThrottle, operationalEventStore?: OperationalEventStore, onDispatched?: (agentId: string, ticketId: string) => void, onAgentActivity?: (agentId: string, ticketId: string) => void, onDeliveryCommitted?: (agentId: string, ticketId: string) => void, enrolledTicketsStore?: EnrolledTicketsStore, mutationAuditStore?: MutationAuditStore, idempotencyStore?: DispatchIdempotencyStore): Router;
//# sourceMappingURL=index.d.ts.map