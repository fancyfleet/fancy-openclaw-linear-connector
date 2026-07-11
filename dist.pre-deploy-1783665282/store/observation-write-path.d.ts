/**
 * AI-2036 — the observation write path: resolution, telemetry, and liveness.
 *
 * Why this module exists
 * ─────────────────────
 * `observations` sat at 0 rows from P4-1 (AI-1378) until AI-2036. The write was
 * guarded by
 *
 *     if (transition.feedback?.required && observationStore && options.feedback)
 *
 * with no `else`. `options.feedback` was built in the proxy only when the request
 * carried `X-Openclaw-Feedback-Category`, and no client has ever sent that header
 * — the deployed CLI (`fancy-openclaw-linear-skill-cli`) has zero occurrences of
 * it. So the guard's third clause was always false, the block never ran, and
 * nothing was logged. The inner `X-Openclaw-From-Body` warning that AI-2027
 * fingered as the culprit was unreachable: to warn about a missing from-body you
 * must first have a feedback payload, and there never was one.
 *
 * The fix is to stop treating reviewer intent as something only a header can
 * carry. A `request-changes` on a feedback-required transition IS an observation;
 * the connector already knows the ticket, the workflow, the step, the reviewer,
 * and (via the implementer store) the body being sent back to. Only the category
 * genuinely needs the reviewer's input, so that — and only that — degrades to
 * `unclassified` when unstated.
 *
 * Resolution ladders
 * ──────────────────
 *   reason_code:  X-Openclaw-Feedback-Category header
 *               → `Category: <code>` marker in the review comment
 *               → `unclassified`
 *
 *   from_body:    X-Openclaw-From-Body header
 *               → implementer store (`prior-implementer`, the same source the
 *                 transition's own `assign.default` uses)
 *               → `unknown`
 *
 * An explicitly supplied but invalid header category is a caller bug, not a
 * missing value: it skips the write loudly rather than silently degrading, so a
 * typo in a future CLI flag surfaces instead of quietly poisoning the corpus.
 *
 * Every outcome — written or skipped — increments a counter and emits an
 * operational event (`observation-recorded` / `observation-skipped`). Nothing on
 * this path is silent again.
 */
import type { OperationalEventInput } from "./operational-event-store.js";
import { ObservationStore, type ReasonCode } from "./observation-store.js";
/** Where a resolved reason code came from. */
export type ReasonCodeSource = "header" | "comment" | "fallback";
/** Where a resolved from-body came from. */
export type FromBodySource = "header" | "implementer-store" | "unknown";
/** Why a write did not happen. */
export type ObservationSkipReason = "store-unwired" | "invalid-reason-code" | "write-failed";
/** Minimal sink shape — the operational event store, or any test double. */
export interface ObservationEventSink {
    append(event: OperationalEventInput): void;
}
export interface ObservationWritePathState {
    /** True once bootstrap registered a live store. */
    wired: boolean;
    /** True once the transition handler hook is attached to that store. */
    subscribed: boolean;
    /** ISO timestamp of registration in this process. */
    registeredAt: string | null;
    /** Rows currently in the table; null when unwired or unreadable. */
    rows: number | null;
    /** Observations written by this process since boot. */
    recorded: number;
    /** Writes skipped by this process since boot, by reason. */
    skipped: number;
    skippedByReason: Record<string, number>;
}
/**
 * Register the observation write path at server bootstrap.
 *
 * `subscribed` asserts the second half of AC1.5: not just that a store exists,
 * but that the transition handler is wired to receive from it. Callers pass the
 * same store instance they hand to the proxy's transition options.
 */
export declare function registerObservationWritePath(store: ObservationStore, opts?: {
    subscribed?: boolean;
}): void;
/** Live state for /health. */
export declare function getObservationWritePathState(): ObservationWritePathState;
/** Reset process state. Tests only. */
export declare function resetObservationWritePath(): void;
/** Extract a reason code from a `Category:` marker in free text, if present. */
export declare function parseCategoryFromComment(text?: string | null): ReasonCode | null;
export interface ReasonCodeResolution {
    reasonCode: ReasonCode | null;
    source: ReasonCodeSource;
    /** True when a header was supplied but was not a known code. */
    invalidHeader: boolean;
}
/**
 * header → comment marker → `unclassified`.
 *
 * A present-but-invalid header short-circuits with `reasonCode: null` so the
 * caller can skip loudly; an absent header falls through the ladder.
 */
export declare function resolveReasonCode(headerValue: string | null | undefined, commentText: string | null | undefined): ReasonCodeResolution;
export interface FromBodyResolution {
    fromBody: string;
    source: FromBodySource;
}
/**
 * header → implementer store → `"unknown"`.
 *
 * Never returns the reviewer's own id. A row whose from_body equals its
 * reviewer_body is useless to the P4-2/3/4 aggregation — that was the original,
 * correct objection to writing without a from-body, and it is enforced here
 * rather than left to callers. `"unknown"` keeps the row while making its
 * missing dimension explicit. The collapse is reachable in practice: the
 * implementer store's own fallback records the transitioning body's id when the
 * resolved delegate is not a registered agent.
 */
export declare function resolveFromBody(headerValue: string | null | undefined, resolveImplementer: () => Promise<string | null>, reviewerBody?: string): Promise<FromBodyResolution>;
export interface RecordObservationArgs {
    store: ObservationStore | undefined;
    events?: ObservationEventSink;
    ticket: string;
    workflow: string;
    step: string;
    reviewerBody: string;
    headerReasonCode?: string | null;
    headerFromBody?: string | null;
    freeText?: string | null;
    wakeId?: string | null;
    resolveImplementer: () => Promise<string | null>;
}
export interface RecordObservationResult {
    written: boolean;
    skipReason?: ObservationSkipReason;
    observationId?: number;
    reasonCode?: ReasonCode;
    reasonCodeSource?: ReasonCodeSource;
    fromBody?: string;
    fromBodySource?: FromBodySource;
}
/**
 * Resolve and append exactly one observation row for a feedback-required
 * transition. Fail-open: a storage error is counted and logged, never thrown —
 * an observation must not be able to block the transition it describes.
 */
export declare function recordObservation(args: RecordObservationArgs): Promise<RecordObservationResult>;
//# sourceMappingURL=observation-write-path.d.ts.map