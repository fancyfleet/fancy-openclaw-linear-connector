export declare class StaleRedispatchCounter {
    private db;
    constructor(dbPath?: string);
    private migrate;
    incrementAndGet(ticketId: string): number;
    get(ticketId: string): number;
    reset(ticketId: string): void;
    close(): void;
}
//# sourceMappingURL=stale-redispatch-counter.d.ts.map