import type { GeneratedProposal } from "./proposal-generator.js";
export declare const PROPOSAL_STATUSES: readonly ["pending", "approved", "rejected", "applied", "apply-failed", "in-revision"];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export interface ProposalRevision {
    version: number;
    feedback: string;
    diff: string;
    newContent: string;
    idempotencyKey: string;
    createdAt: string;
}
export interface ProposalRecord extends GeneratedProposal {
    id: number;
    status: ProposalStatus;
    createdAt: string;
    updatedAt: string;
    revisions: ProposalRevision[];
}
export declare class ProposalStore {
    private db;
    constructor(dbPath?: string);
    private migrate;
    private hydrate;
    create(p: GeneratedProposal): ProposalRecord;
    get(id: number): ProposalRecord | null;
    query(q?: {
        status?: ProposalStatus;
        workflowId?: string;
        limit?: number;
    }): ProposalRecord[];
    setStatus(id: number, status: ProposalStatus): ProposalRecord;
    revise(id: number, feedback: string, regenerated: GeneratedProposal): ProposalRecord;
    close(): void;
}
//# sourceMappingURL=proposal-store.d.ts.map