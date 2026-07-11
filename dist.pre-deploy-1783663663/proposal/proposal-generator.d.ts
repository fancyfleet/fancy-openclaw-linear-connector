export interface FailureCluster {
    workflow: string;
    step: string;
    reasonCode: string;
    count: number;
    fromBody?: string;
    exceedsThreshold: boolean;
    ticketIds: string[];
}
export interface GenerationContext {
    readGuidance(workflowId: string, stateId: string): string | null;
}
export interface GeneratedProposal {
    workflowId: string;
    stateId: string;
    oldContent: {
        hash: string;
        snapshot: string;
    };
    newContent: string;
    diff: string;
    confidenceScore: number;
    evidenceCluster: {
        ticketIds: string[];
        counts: Record<string, number>;
    };
    failureCount: number;
    version: number;
    idempotencyKey: string;
}
export declare function generateProposals(clusters: FailureCluster[], ctx: GenerationContext): GeneratedProposal[];
//# sourceMappingURL=proposal-generator.d.ts.map