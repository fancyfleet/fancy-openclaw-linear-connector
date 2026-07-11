/**
 * AI-1565: Pre-routing workflow bootstrap hook.
 *
 * When a wf:* label is added to a ticket with no state:* label, applies the
 * entry state from the workflow def and sets the first-owner delegate — no
 * human/agent action required.
 *
 * Reverse (demote): when wf:* is removed and state:* labels remain, cleans
 * them up so the ticket reverts to ad-hoc.
 *
 * This hook runs before the delegate-based router so a label-only change
 * (no delegate, no assignee, no mention) can bootstrap the ticket.
 */
import { type WorkflowDef } from "./workflow-gate.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import type { LinearEvent } from "./webhook/schema.js";
export interface BootstrapResult {
    action: "bootstrapped" | "demoted";
    workflowId?: string;
    entryState?: string;
    /** OpenClaw agent name of the newly-set delegate (bootstrapped only). */
    delegateAgentName?: string;
    /** Ticket identifier for wake delivery (bootstrapped only). */
    ticketIdentifier?: string;
    /** Ticket title for wake delivery (bootstrapped only). */
    ticketTitle?: string;
}
/** Issue context used by both the webhook bootstrap and the reconciliation sweep. */
export interface IssueContext {
    id: string;
    teamId: string;
    identifier: string;
    title: string;
    labels: Array<{
        id: string;
        name: string;
    }>;
}
/** Re-export so callers (sweep) can import from a single module. */
export type { WorkflowDef };
/**
 * Fetch an issue's current context (labels, team, identifier) from Linear.
 *
 * Shared by the webhook bootstrap path and the reconciliation sweep — the
 * sweep uses this for the idempotency re-fetch before healing a ticket.
 */
export declare function fetchIssueContext(issueId: string, authToken: string): Promise<IssueContext | null>;
/**
 * Atomically apply label IDs (+ optional delegate) to an issue.
 *
 * Shared primitive — used by both the webhook bootstrap and the sweep.
 */
export declare function issueUpdateAtomic(internalId: string, labelIds: string[], authToken: string, delegateId?: string | null): Promise<boolean>;
/**
 * Pre-routing bootstrap hook — runs before the delegate-based router.
 *
 * Returns a BootstrapResult if the bootstrap or demote path fired, null otherwise.
 * Never throws: all errors are caught and logged, failing safe.
 */
export declare function maybeBootstrapWorkflow(event: LinearEvent, authToken: string, enrolledTicketsStore?: EnrolledTicketsStore): Promise<BootstrapResult | null>;
/**
 * Apply bootstrap (entry-state label + first-owner delegate) to an issue whose
 * context has already been fetched.
 *
 * This is the shared core invoked by both:
 *   - the webhook bootstrap hook (`maybeBootstrapWorkflow`)
 *   - the periodic reconciliation sweep (`runBootstrapReconciliationSweep`)
 *
 * AI-1775: a parallel reimplementation is explicitly disallowed by AC1 — both
 * paths must funnel through this function so the heal is identical to the
 * webhook-triggered bootstrap.
 *
 * Pre-conditions (checked by the caller):
 *   - The issue has a `wf:*` label
 *   - The issue has NO `state:*` label (idempotency)
 *
 * This function re-checks idempotency defensively (state:* present → null) so
 * the race between a late webhook and the sweep is covered even when the
 * caller's context is slightly stale.
 *
 * Returns a BootstrapResult on success, or null if the ticket was already
 * enrolled, the workflow def is missing, or label/mutation application failed.
 */
export declare function applyBootstrapToIssue(issue: IssueContext, authToken: string, 
/** Optional registry override (used by the sweep). If absent, loads from file. */
workflowRegistryOverride?: Map<string, WorkflowDef>, 
/** AI-1799: optional mirror store — writes enrollment rows for board data. */
enrolledTicketsStore?: EnrolledTicketsStore): Promise<BootstrapResult | null>;
//# sourceMappingURL=workflow-bootstrap.d.ts.map