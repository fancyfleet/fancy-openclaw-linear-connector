import type { LinearEvent } from "./webhook/schema.js";
export declare function isTerminalIssueState(state: unknown): boolean;
export declare function isParkedIssueState(state: unknown): boolean;
export interface LinearIssueState {
    name?: string;
    type?: string;
}
export interface LinearIssueReference {
    id?: string;
    identifier?: string;
    state?: LinearIssueState | null;
}
export interface LinearIssueRelation {
    type?: string;
    issue?: LinearIssueReference | null;
    relatedIssue?: LinearIssueReference | null;
}
export interface LinearIssueWithRelations extends LinearIssueReference {
    delegate?: {
        id?: string;
        name?: string;
    } | null;
    assignee?: {
        id?: string;
        name?: string;
    } | null;
    relations?: {
        nodes?: LinearIssueRelation[] | null;
    } | null;
}
export declare function isBlockedByOpenIssue(issue: LinearIssueWithRelations): boolean;
export declare function issueIdentifierFromSessionKey(ticketId: string): string;
export declare function isTerminalIssueEvent(event: LinearEvent): boolean;
export declare function issueIdentifierFromEvent(event: LinearEvent): string | null;
/**
 * Rich result from a Linear routing check.
 * - actionable: whether the ticket should be dispatched to the agent
 * - failOpen: true when actionable=true is due to a transient error (network/auth/API)
 *   rather than a confirmed routing decision. Callers that want strict-mode
 *   semantics (e.g. startup-replay) can treat failOpen=true as "defer, don't dispatch."
 */
export interface RoutingCheckResult {
    actionable: boolean;
    /** True when actionable is set by fail-open (transient error) not by confirmed routing. */
    failOpen: boolean;
}
/**
 * Core routing check. Returns a rich result distinguishing confirmed routing from fail-open.
 * Most callers should use isLinearIssueStillRoutedToAgent for the simple boolean interface.
 */
export declare function checkLinearIssueRouting(ticketId: string, agentId: string, routingReason: "delegate" | "assignee" | "mention" | "body-mention" | "department-prefix" | "steward-escalation" | undefined): Promise<RoutingCheckResult>;
/**
 * Return false only when Linear confirms the issue is terminal or missing.
 * On auth/network/API uncertainty, keep the ticket actionable so we do not
 * silently drop legitimate work because Linear had a transient failure.
 */
export declare function isLinearIssueStillRoutedToAgent(ticketId: string, agentId: string, routingReason: "delegate" | "assignee" | "mention" | "body-mention" | "department-prefix" | "steward-escalation" | undefined): Promise<boolean>;
export declare function isLinearIssueActionable(ticketId: string, agentId: string): Promise<boolean>;
//# sourceMappingURL=linear-actionable.d.ts.map