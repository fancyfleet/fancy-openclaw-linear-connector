/**
 * AI-1775 — Bootstrap reconciliation sweep.
 *
 * A periodic safety net that finds governed-intent tickets (wf:* label) that
 * never enrolled (no state:* label) past a configurable grace window and heals
 * them using the same bootstrap core as the webhook path
 * (`applyBootstrapToIssue` in workflow-bootstrap.ts).
 *
 * Problem solved: if Linear drops the Issue-update webhook, a wf:* label sits
 * on a ticket with no state:* label, no delegate, and no alert — the ticket is
 * permanently dark. The sweep detects and recovers this.
 *
 * Design notes:
 *   - Query: batch Linear search for wf:* labeled tickets, filter client-side
 *     for no state:* label and past grace window.
 *   - Heal: re-fetch issue context (idempotency) then call `applyBootstrapToIssue`
 *     — the exact same core the webhook bootstrap uses.
 *   - Alert: each heal emits a warning via the alert bus (`bootstrap-reconciled`).
 *   - Race-safe: the idempotency re-fetch inside the heal path prevents
 *     double-bootstrap when a late webhook lands between query and heal.
 *   - Error-tolerant: a Linear API error alerts and does not kill the loop.
 */
import { type WorkflowDef } from "./workflow-bootstrap.js";
import { type AlertBus } from "./alerts/alert-bus.js";
export interface ReconciliationSweepOptions {
    authToken: string;
    /** Optional workflow registry override. If absent, the core loads from file. */
    workflowRegistry?: Map<string, WorkflowDef>;
    /** Grace window in ms. Tickets younger than this are skipped. Default 2 min. */
    graceWindowMs?: number;
    /** Override for `Date.now()` — used in tests for deterministic timing. */
    nowMs?: number;
    /** Alert bus for heal/failure notifications. */
    alertBus?: AlertBus;
    /** Called to wake the first-owner delegate after a successful heal. */
    wakeFn?: (agentName: string, ticketIdentifier: string) => Promise<void>;
    /** Injectable fetch (tests). Defaults to global fetch. */
    fetchFn?: typeof fetch;
}
export interface ReconciliationSweepResult {
    /** Total unenrolled tickets returned by the query. */
    scanned: number;
    /** Tickets successfully healed (bootstrap applied). */
    healed: number;
    /** Tickets within the grace window (skipped, not healed). */
    withinGrace: number;
    /** Non-fatal errors encountered during the sweep. */
    errors: string[];
}
/**
 * Run a single reconciliation sweep: query → filter → heal → alert.
 *
 * Never throws — all errors are captured in the `errors` array of the result
 * and surfaced via the alert bus.
 */
export declare function runBootstrapReconciliationSweep(opts: ReconciliationSweepOptions): Promise<ReconciliationSweepResult>;
/**
 * Register the reconciliation sweep as a recurring interval timer.
 *
 * The caller MUST supply the Linear auth token — typically resolved in
 * `index.ts` via `getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ??
 * process.env.LINEAR_API_KEY`, matching every other server-side Linear call.
 *
 * **Wake wiring (AC1):** the caller MUST supply a `wakeFn` that delivers a
 * workflow-aware wake to the healed delegate — identical to the post-bootstrap
 * wake delivery in the webhook path. Without it, a healed ticket gets labels
 * + delegate but the delegate is never notified.
 *
 * **Alert bus (AC2/AC4):** if `alertBus` is omitted, the sweep defaults to the
 * global alert-bus singleton (`getAlertBus()`), so alerts always fire in prod.
 *
 * Returns the NodeJS.Timeout so the caller can clear it (e.g. on shutdown).
 * In production this is called once from index.ts alongside other periodic
 * loops.
 */
export declare function registerBootstrapReconciliationCron(opts: {
    authToken: string;
    intervalMs?: number;
    /** Alert bus for heal/failure notifications. Defaults to the global singleton. */
    alertBus?: AlertBus;
    /** Delivers a wake to the first-owner delegate after a successful heal.
     *  Required for AC1 in the prod path — index.ts wires this to the same
     *  delivery mechanism the webhook bootstrap path uses. */
    wakeFn?: (agentName: string, ticketIdentifier: string) => Promise<void>;
}): NodeJS.Timeout;
//# sourceMappingURL=bootstrap-reconciliation-sweep.d.ts.map