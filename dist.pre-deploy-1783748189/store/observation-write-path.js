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
import { ObservationStore, UNCLASSIFIED_REASON_CODE, } from "./observation-store.js";
import { componentLogger, createLogger } from "../logger.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "observation-write-path");
let _store = null;
let _subscribed = false;
let _registeredAt = null;
let _recorded = 0;
const _skipped = new Map();
/**
 * Register the observation write path at server bootstrap.
 *
 * `subscribed` asserts the second half of AC1.5: not just that a store exists,
 * but that the transition handler is wired to receive from it. Callers pass the
 * same store instance they hand to the proxy's transition options.
 */
export function registerObservationWritePath(store, opts) {
    _store = store;
    _subscribed = opts?.subscribed ?? true;
    _registeredAt = new Date().toISOString();
    log.info(`observation write-path registered at bootstrap (subscribed=${_subscribed}) — ` +
        `feedback-required transitions will write to observations`);
}
/** Live state for /health. */
export function getObservationWritePathState() {
    let rows = null;
    if (_store) {
        try {
            rows = _store.total();
        }
        catch {
            rows = null;
        }
    }
    return {
        wired: _store !== null,
        subscribed: _subscribed,
        registeredAt: _registeredAt,
        rows,
        recorded: _recorded,
        skipped: Array.from(_skipped.values()).reduce((a, b) => a + b, 0),
        skippedByReason: Object.fromEntries(_skipped),
    };
}
/** Reset process state. Tests only. */
export function resetObservationWritePath() {
    _store = null;
    _subscribed = false;
    _registeredAt = null;
    _recorded = 0;
    _skipped.clear();
}
// ── Resolution ────────────────────────────────────────────────────────────
/**
 * A `Category: <code>` line anywhere in the review comment. Tolerates the
 * markdown reviewers actually write: list bullets, bold, and backticks.
 */
const CATEGORY_MARKER = /^[ \t]*(?:[-*+][ \t]+)?\*{0,2}category\*{0,2}[ \t]*[:=][ \t]*\*{0,2}[ \t]*`?([A-Za-z-]+)`?/im;
/** Extract a reason code from a `Category:` marker in free text, if present. */
export function parseCategoryFromComment(text) {
    if (!text)
        return null;
    const match = CATEGORY_MARKER.exec(text);
    if (!match)
        return null;
    return ObservationStore.validateReasonCode(match[1].toLowerCase());
}
/**
 * header → comment marker → `unclassified`.
 *
 * A present-but-invalid header short-circuits with `reasonCode: null` so the
 * caller can skip loudly; an absent header falls through the ladder.
 */
export function resolveReasonCode(headerValue, commentText) {
    if (headerValue) {
        const validated = ObservationStore.validateReasonCode(headerValue);
        if (validated)
            return { reasonCode: validated, source: "header", invalidHeader: false };
        return { reasonCode: null, source: "header", invalidHeader: true };
    }
    const fromComment = parseCategoryFromComment(commentText);
    if (fromComment)
        return { reasonCode: fromComment, source: "comment", invalidHeader: false };
    return { reasonCode: UNCLASSIFIED_REASON_CODE, source: "fallback", invalidHeader: false };
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
export async function resolveFromBody(headerValue, resolveImplementer, reviewerBody) {
    const distinct = (candidate) => candidate !== reviewerBody;
    if (headerValue && distinct(headerValue))
        return { fromBody: headerValue, source: "header" };
    try {
        const implementer = await resolveImplementer();
        if (implementer && distinct(implementer))
            return { fromBody: implementer, source: "implementer-store" };
    }
    catch (err) {
        log.warn(`implementer lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { fromBody: "unknown", source: "unknown" };
}
function noteSkip(reason, args, detail) {
    _skipped.set(reason, (_skipped.get(reason) ?? 0) + 1);
    log.warn(`observation SKIPPED for ${args.ticket} (${args.workflow}/${args.step}): ${reason} — ` +
        `${JSON.stringify(detail)}. Running skip count for this reason: ${_skipped.get(reason)}`);
    args.events?.append({
        outcome: "observation-skipped",
        type: "observation",
        agent: args.reviewerBody,
        key: args.ticket,
        workflowState: args.step,
        plane: "connector",
        wakeId: args.wakeId ?? null,
        errorSummary: reason,
        detail: { reason, workflow: args.workflow, step: args.step, ...detail },
    });
    return { written: false, skipReason: reason };
}
/**
 * Resolve and append exactly one observation row for a feedback-required
 * transition. Fail-open: a storage error is counted and logged, never thrown —
 * an observation must not be able to block the transition it describes.
 */
export async function recordObservation(args) {
    if (!args.store) {
        return noteSkip("store-unwired", args, { hint: "observationStore absent from transition options" });
    }
    const reason = resolveReasonCode(args.headerReasonCode, args.freeText);
    if (!reason.reasonCode) {
        return noteSkip("invalid-reason-code", args, { suppliedHeader: args.headerReasonCode });
    }
    const from = await resolveFromBody(args.headerFromBody, args.resolveImplementer, args.reviewerBody);
    let observationId;
    try {
        observationId = args.store.append({
            ticket: args.ticket,
            workflow: args.workflow,
            step: args.step,
            fromBody: from.fromBody,
            reviewerBody: args.reviewerBody,
            reasonCode: reason.reasonCode,
            freeText: args.freeText ?? null,
            wakeId: args.wakeId ?? null,
        });
    }
    catch (err) {
        return noteSkip("write-failed", args, {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    _recorded += 1;
    // A degraded row is still a row, but it should be visible as degraded.
    if (reason.source === "fallback") {
        log.warn(`observation for ${args.ticket} recorded as '${UNCLASSIFIED_REASON_CODE}' — ` +
            `reviewer supplied no category (no X-Openclaw-Feedback-Category header, no 'Category:' line in the comment)`);
    }
    if (from.source === "unknown") {
        log.warn(`observation for ${args.ticket} recorded with from_body='unknown' — no header and no implementer on record`);
    }
    args.events?.append({
        outcome: "observation-recorded",
        type: "observation",
        agent: args.reviewerBody,
        key: args.ticket,
        workflowState: args.step,
        plane: "connector",
        wakeId: args.wakeId ?? null,
        detail: {
            observationId,
            workflow: args.workflow,
            step: args.step,
            reasonCode: reason.reasonCode,
            reasonCodeSource: reason.source,
            fromBody: from.fromBody,
            fromBodySource: from.source,
        },
    });
    log.info(`observation recorded: id=${observationId} ticket=${args.ticket} workflow=${args.workflow} ` +
        `step=${args.step} reason=${reason.reasonCode} (${reason.source}) from_body=${from.fromBody} (${from.source})`);
    return {
        written: true,
        observationId,
        reasonCode: reason.reasonCode,
        reasonCodeSource: reason.source,
        fromBody: from.fromBody,
        fromBodySource: from.source,
    };
}
//# sourceMappingURL=observation-write-path.js.map