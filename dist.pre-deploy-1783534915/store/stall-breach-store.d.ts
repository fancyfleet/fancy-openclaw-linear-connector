/**
 * SQLite-backed dedup store for stall breach signals (AC3, G-12).
 *
 * Tracks (childId, stateEnteredAt) pairs that have already been signaled to
 * the steward, so a recurring cron tick does not flood on the same breach.
 * A new stall after recovery is a different stateEnteredAt epoch → new breach.
 */
export declare class StallBreachStore {
    private db;
    constructor(dbPath?: string);
    isAlreadySignaled(childId: string, stateEnteredAt: number): boolean;
    recordSignal(childId: string, stateEnteredAt: number): void;
    close(): void;
}
//# sourceMappingURL=stall-breach-store.d.ts.map