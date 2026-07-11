/**
 * AI-1857 AC3 — In-process store for rescue-sweep run metadata.
 * Exposed on /health so "did it run" is answerable without log access.
 *
 * AI-1970: Added lastOutcomeType + lastSkipReason + lastError fields so all
 * outcomes (skip, fail, success) produce a non-null lastRunAt with context.
 */
let state = {
    lastRunAt: null,
    lastOutcomeType: null,
    lastOutcome: { rescued: 0, failed: 0, scanned: 0 },
    lastSkipReason: null,
    lastError: null,
};
/** Record a successful run with sweep result counts. */
export function recordRescueSweepRun(result) {
    state = {
        lastRunAt: new Date().toISOString(),
        lastOutcomeType: "success",
        lastOutcome: {
            scanned: result.scanned,
            rescued: result.rescued,
            failed: result.rescues.filter((r) => r.outcome === "failed").length,
        },
        lastSkipReason: null,
        lastError: null,
    };
}
/** Record a skipped run (e.g. no auth token available). */
export function recordRescueSweepSkip(reason) {
    state = {
        lastRunAt: new Date().toISOString(),
        lastOutcomeType: "skip",
        lastOutcome: { rescued: 0, failed: 0, scanned: 0 },
        lastSkipReason: reason,
        lastError: null,
    };
}
/** Record a failed run (thrown error caught by cron wrapper). */
export function recordRescueSweepFail(error) {
    state = {
        lastRunAt: new Date().toISOString(),
        lastOutcomeType: "fail",
        lastOutcome: { rescued: 0, failed: 0, scanned: 0 },
        lastSkipReason: null,
        lastError: error,
    };
}
export function getRescueSweepState() {
    return {
        lastRunAt: state.lastRunAt,
        lastOutcomeType: state.lastOutcomeType,
        lastOutcome: { ...state.lastOutcome },
        lastSkipReason: state.lastSkipReason,
        lastError: state.lastError,
    };
}
export function resetRescueSweepStateForTest() {
    state = {
        lastRunAt: null,
        lastOutcomeType: null,
        lastOutcome: { rescued: 0, failed: 0, scanned: 0 },
        lastSkipReason: null,
        lastError: null,
    };
}
//# sourceMappingURL=rescue-sweep-state.js.map