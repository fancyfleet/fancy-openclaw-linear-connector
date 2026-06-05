import { PendingWorkBag } from "../bag/pending-work-bag.js";
import { SessionTracker } from "../bag/session-tracker.js";
import { LifecycleStore } from "./lifecycle-store.js";
export interface LifecycleReconcilerConfig {
    thresholdMin?: number;
    cooldownMin?: number;
    activeWindowMin?: number;
    maxDeadLetterResets?: number;
    hooksUrl?: string;
    hooksToken?: string;
    hooksThinking?: string;
    hooksModel?: string;
    openclawBin?: string;
    linearToken: string;
}
export interface LifecycleRunResult {
    freshSessions: number;
    normalBacklog: number;
    cooldown: number;
    waitingOnHuman: number;
    wakeAttempts: number;
    staleResets: number;
    deadLetters: number;
    errors: string[];
    clean: boolean;
    ranAt: string;
}
export interface LifecycleCumulativeMetrics {
    runs: number;
    wakeAttempts: number;
    staleResets: number;
    deadLetters: number;
    activeSessionsMatched: number;
    errors: number;
    lastRunAt: string | null;
    lastCleanRunAt: string | null;
}
export declare class LifecycleReconciler {
    private store;
    private bag;
    private sessionTracker;
    private linearToken;
    private thresholdMin;
    private cooldownMin;
    private activeWindowMin;
    private maxDeadLetterResets;
    private hooksUrl?;
    private hooksToken?;
    private hooksThinking?;
    private hooksModel?;
    private openclawBin?;
    private timer;
    private cumulative;
    constructor(store: LifecycleStore, bag: PendingWorkBag, sessionTracker: SessionTracker, config: LifecycleReconcilerConfig);
    start(intervalMs?: number): void;
    stop(): void;
    runOnce(): Promise<LifecycleRunResult>;
    getMetrics(): LifecycleCumulativeMetrics;
}
//# sourceMappingURL=reconciler.d.ts.map