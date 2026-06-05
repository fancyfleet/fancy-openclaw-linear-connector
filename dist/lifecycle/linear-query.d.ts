export interface DelegatedTicket {
    identifier: string;
    uuid: string;
    teamId: string;
    state: string;
    delegateAgentId: string;
    delegateName: string;
    assigneeName: string | null;
    updatedAt: string;
    ageMs: number;
    priority: number;
}
export declare function loadLinearToken(): string | null;
export declare function fetchDelegatedOpenIssues(token: string): Promise<DelegatedTicket[]>;
export declare function resetTicketToTodo(issueUuid: string, teamId: string, token: string): Promise<boolean>;
export declare function postTicketComment(issueUuid: string, body: string, token: string): Promise<void>;
//# sourceMappingURL=linear-query.d.ts.map