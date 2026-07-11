/**
 * AI-1428 / AI-1459 — Role-guard for agent routing / reassignment.
 *
 * Phase 1 (AI-1428): advisory-only. Detected wrong-body routing but never
 * blocked the dispatch.
 *
 * Phase 2 (AI-1459): enforcement mode. Before dispatching to an agent, the
 * guard checks the ticket's workflow state (from its labels), resolves the
 * owner_role for that state via the workflow definition, and verifies the
 * target agent fills that role in the capability policy. A failing check:
 *   - Returns blocked: true (caller must not dispatch)
 *   - Posts a blocking comment naming the illegal target, the expected legal
 *     target(s), and the reason
 *   - Attempts to correct the delegate: auto-assign to the singleton legal
 *     target, or clear + escalate when multiple bodies fill the role
 *
 * Ad-hoc tickets (no wf:* label) are full pass-through.
 * The guard fails open on any load error (missing yaml, network, unknown state)
 * so a misconfigured connector never silently drops real work.
 */
export interface RoleGuardResult {
    /** True when the dispatch has been blocked. */
    blocked: boolean;
    /** Human-readable reason if blocked. */
    reason?: string;
    /** Legal target body IDs when blocked and there is a singleton legal target. */
    correctedTo?: string;
    /** All legal body IDs for the state's owner_role when blocked. */
    legalBodies?: string[];
    /**
     * AI-2044: true when the dispatch was blocked but the ticket's current
     * delegate fills the owner_role (or could not be verified), so the guard
     * left delegate/assignee untouched and posted nothing.
     */
    delegatePreserved?: boolean;
}
/**
 * Sync advisory-only check using the static REVIEW_ONLY_AGENTS set.
 * Returns the reason text when a violation is detected, but `blocked` is
 * always false — this function never hard-blocks. Use `checkRoleGuardEnforced`
 * (async) for the full enforcement path.
 *
 * Retained for unit tests and backwards-compatible callers.
 *
 * Hard-coded set per AI-1428 design: "no need to parse capability-policy.yaml
 * at runtime for Phase 1". Phase 2 derives legalBodies from the workflow def
 * instead, so this set is only used by the legacy sync path.
 */
export declare const REVIEW_ONLY_AGENTS: Set<string>;
export declare function checkRoleGuard(targetAgentId: string, ticketLabels: string[]): RoleGuardResult;
/**
 * Enforcement-mode role-guard check (AI-1459).
 *
 * Loads the workflow definition and capability policy, derives the owner_role
 * for the current state, and blocks routing when the target agent does not fill
 * that role. Returns blocked: true with reason when a violation is found.
 *
 * Fails open on any error (missing def, unknown workflow, missing state label,
 * empty role set) so misconfiguration never silently drops legitimate work.
 */
export declare function checkRoleGuardEnforced(targetAgentId: string, ticketLabels: string[]): Promise<RoleGuardResult>;
/**
 * Run the enforcement-mode role-guard. When a violation is detected the guard
 * first checks who currently holds the ticket (AI-2044):
 *
 *   - Current delegate fills the owner_role (or cannot be verified): block
 *     delivery ONLY. No comment, no mutation — a blocked dispatch (e.g. a
 *     comment @-mentioning a non-role agent) must never evict a legal,
 *     in-flight delegate. This is the AI-2040 failure mode.
 *   - No delegate, or a delegate that verifiably does not fill the role:
 *     post a blocking comment, then correct — singleton legal target: update
 *     the delegate to that body; multiple legal targets: clear (if set) and
 *     raise a loud alert for manual routing.
 *
 * Returns the guard result; callers must check `result.blocked` and skip
 * delivery when true.
 *
 * Auth strategy (AI-2044): prefer the connector's own service token so
 * guard-issued writes are never attributed to an agent that took no action
 * (the 05:54:11Z delegate-null on AI-2040 was recorded under the blocked
 * target's OAuth token, producing a false audit trail). The blocked target's
 * token is a last resort.
 */
/**
 * Resolver that maps a body name (e.g. "igor") to its Linear user ID.
 * Injected by the caller so routing-guard.ts doesn't depend on agents.ts
 * at the module level (which has an external package dependency that breaks
 * the test compile path).
 */
export type LinearUserIdResolver = (bodyName: string) => string | null;
export declare function checkRoleGuardAndBlock(targetAgentId: string, issueIdentifier: string, ticketLabels: string[], delegateLinearUserIdResolver?: LinearUserIdResolver): Promise<RoleGuardResult>;
/**
 * Legacy compatibility wrapper.
 * Previous call sites that used `checkRoleGuardAndWarn` now route through
 * the enforcement path. This ensures the webhook caller is not broken by the
 * rename — update call sites to `checkRoleGuardAndBlock` at leisure.
 */
export declare function checkRoleGuardAndWarn(targetAgentId: string, issueIdentifier: string, ticketLabels: string[], delegateLinearUserIdResolver?: LinearUserIdResolver): Promise<RoleGuardResult>;
//# sourceMappingURL=routing-guard.d.ts.map