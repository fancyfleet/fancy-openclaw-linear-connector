/**
 * AI-1838 — Webhook mutation extraction.
 *
 * Extracts structured state/label/delegate changes from normalized Linear
 * webhook events into MutationAuditInput records for the audit store.
 *
 * This is the "observation" side of the out-of-band detection: every
 * state/label/delegate change Linear tells us about via webhook gets recorded
 * with source='webhook'. The reconcile sweep then checks whether a matching
 * proxy-forwarded mutation exists.
 */
import type { LinearEvent } from "./schema.js";
import type { MutationAuditInput } from "../store/mutation-audit-store.js";
/**
 * Extract mutation audit records from a normalized Linear webhook event.
 *
 * Only Issue-update events carry mutation signals (state/label/delegate changes).
 * Returns an empty array for non-applicable events.
 */
export declare function extractWebhookMutations(event: LinearEvent, webhookEventId?: string): MutationAuditInput[];
//# sourceMappingURL=mutation-extraction.d.ts.map