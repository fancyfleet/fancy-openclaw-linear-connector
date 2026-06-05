export interface WakeRecord {
    agentId: string;
    ticketId: string;
    lastWakeSentAt: number | null;
    lastResetAt: number | null;
    resetCount: number;
    deadLetteredAt: number | null;
}
export interface LifecycleMetrics {
    totalTracked: number;
    deadLettered: number;
    totalWakesSent: number;
    totalResets: number;
}
export declare class LifecycleStore {
    private db;
    constructor(dbPath?: string);
    private migrate;
    recordWakeSent(agentId: string, ticketId: string, nowMs?: number): void;
    recordReset(agentId: string, ticketId: string, nowMs?: number): void;
    markDeadLetter(agentId: string, ticketId: string, nowMs?: number): void;
    getWakeRecord(agentId: string, ticketId: string): WakeRecord | null;
    getMetrics(): LifecycleMetrics;
    pruneStale(ttlMs?: number): number;
    close(): void;
}
//# sourceMappingURL=lifecycle-store.d.ts.map