export interface OpenClawSession {
    key: string;
    agentId: string;
    updatedAt: number;
}
export declare function fetchOpenClawSessions(activeWindowMin: number, openclawBin?: string): Promise<OpenClawSession[]>;
export declare function hasRecentExactTicketSession(sessions: OpenClawSession[], agentId: string, ticketId: string, thresholdMin: number): boolean;
//# sourceMappingURL=openclaw-query.d.ts.map