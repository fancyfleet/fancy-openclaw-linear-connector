/**
 * AI-1857 AC3 — In-process store for rescue-sweep run metadata.
 * Exposed on /health so "did it run" is answerable without log access.
 *
 * AI-1970: Added lastOutcomeType + lastSkipReason + lastError fields so all
 * outcomes (skip, fail, success) produce a non-null lastRunAt with context.
 */
export type RescueSweepOutcome = "success" | "skip" | "fail";
export interface RescueSweepRunState {
    /** ISO timestamp of most recent attempt (run, skip, or fail). */
    lastRunAt: string | null;
    /** Outcome of the most recent attempt. */
    lastOutcomeType: RescueSweepOutcome | null;
    /** Aggregate counts from the most recent successful sweep. */
    lastOutcome: {
        rescued: number;
        failed: number;
        scanned: number;
    };
    /** Reason for skipping (populated on skip outcome). */
    lastSkipReason: string | null;
    /** Error message from a failed run (populated on fail outcome). */
    lastError: string | null;
}
/** Record a successful run with sweep result counts. */
export declare function recordRescueSweepRun(result: {
    scanned: number;
    rescued: number;
    rescues: Array<{
        outcome: string;
    }>;
}): void;
/** Record a skipped run (e.g. no auth token available). */
export declare function recordRescueSweepSkip(reason: string): void;
/** Record a failed run (thrown error caught by cron wrapper). */
export declare function recordRescueSweepFail(error: string): void;
export declare function getRescueSweepState(): RescueSweepRunState;
export declare function resetRescueSweepStateForTest(): void;
//# sourceMappingURL=rescue-sweep-state.d.ts.map