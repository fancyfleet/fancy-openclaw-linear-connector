/**
 * AI-2036 — The transition-handler hook that writes one observation row per
 * feedback-required transition.
 *
 * Root cause it fixes (AC1.1)
 * ---------------------------
 * P4-1 (AI-1378) shipped the *reader* of two headers — `X-Openclaw-Feedback-
 * Category` and `X-Openclaw-From-Body` — but no client ever sent either one.
 * The proxy only built a `feedback` payload when the category header was
 * present, so `options.feedback` was always undefined, the whole observation
 * block short-circuited, and not even the `fromBody` warn inside it ever fired.
 * The store recorded 0 rows for its entire life, silently.
 *
 * The fix is to stop requiring a client to tell the connector what the connector
 * already knows. Both fields are now *derived* server-side, with the headers
 * kept as the highest-priority source so a future CLI that sends them wins:
 *
 *   from_body   ← header → resolved destination delegate → implementer store
 *   reason_code ← header → `Category:` directive in the comment → `unspecified`
 *
 * The destination delegate of a feedback transition IS the implementer: every
 * feedback-required transition in the canonical defs routes back to the worker
 * state. That derivation is exact, which retires the original author's reason
 * for skipping (`from_body == reviewer_body` producing useless data).
 *
 * Nothing here can block a transition. Every path — written, degraded, skipped —
 * is counted and mirrored to operational_events (AC1.3).
 */
import { ObservationStore, type StoredReasonCode } from "./store/observation-store.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";
import { type ObservationSkipReason } from "./observation-wiring.js";
/**
 * Extract a reviewer-declared category from a comment body.
 * Returns null when absent or not legal for this transition.
 */
export declare function parseReasonCodeFromComment(text: string | null | undefined, allowed: readonly string[]): string | null;
export interface FeedbackObservationContext {
    /** Ticket identifier, e.g. "AI-2036". */
    issueId: string;
    /** Workflow ID, e.g. "dev-impl". */
    workflowId: string;
    /** The state the feedback was given FROM, e.g. "code-review". */
    step: string;
    /** The reviewer that issued the transition. */
    reviewerBody: string;
    /**
     * Categories legal for this transition, from the def's `feedback.category_enum`.
     * Falls back to the full REASON_CODES enum when the def omits it.
     */
    allowedCategories?: readonly string[];
    /** Reviewer-supplied category (X-Openclaw-Feedback-Category), if any. */
    rawReasonCode?: string | null;
    /** The comment body carrying the feedback. Also searched for a directive. */
    freeText?: string | null;
    /**
     * Implementer candidates in priority order; the first non-empty one wins.
     * Production order: header, resolved destination delegate, implementer store.
     */
    fromBodyCandidates: Array<string | null | undefined>;
    /** Dispatch-cycle correlation id, when known (AC1.4). */
    wakeId?: string | null;
    /** The registered store. Absent ⇒ a counted `store-unwired` skip. */
    observationStore?: ObservationStore;
    /** Telemetry sink. Absent ⇒ log-only (counters still increment). */
    operationalEventStore?: OperationalEventStore;
}
export type FeedbackObservationResult = {
    written: true;
    id: number;
    reasonCode: StoredReasonCode;
    degraded: boolean;
    fromBody: string;
} | {
    written: false;
    skipReason: ObservationSkipReason;
};
/**
 * Write one observation row for a feedback-required transition.
 *
 * Never throws — a failed observation must never block a state transition.
 */
export declare function recordFeedbackObservation(ctx: FeedbackObservationContext): FeedbackObservationResult;
//# sourceMappingURL=observation-hook.d.ts.map