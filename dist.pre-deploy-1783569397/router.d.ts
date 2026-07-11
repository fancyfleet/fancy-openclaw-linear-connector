/**
 * Event routing: determines which OpenClaw agent should handle a Linear event.
 *
 * Supports both traditional assignee-based routing and OAuth app actor
 * delegation (where the agent appears in the `delegate` field, not `assignee`).
 *
 * Also filters self-triggered events to prevent feedback loops,
 * while allowing agent-to-agent delegation.
 */
import type { LinearEvent } from "./webhook/schema.js";
import type { RouteResult } from "./types.js";
/**
 * Extract the target agent name from a webhook payload.
 * Checks delegate first (OAuth app actors), then assignee, then mentioned users.
 * Returns null if no agent target found or if it's a self-triggered event.
 */
export declare function extractAgentTarget(event: LinearEvent): {
    name: string;
    reason: "delegate" | "assignee" | "mention" | "body-mention";
} | null;
/**
 * All registered agents mentioned in the event beyond the given primary
 * registry name — payload `mentionedUsers` plus comment-body @mentions —
 * excluding the acting agent (self-trigger) and the primary itself.
 * Returns registry names. (Audit #3: only the first mention used to wake.)
 */
export declare function extractAdditionalMentionTargets(event: LinearEvent, primaryName: string | null): string[];
/**
 * Routing-candidate ids named by the event (delegate/assignee/mentioned users)
 * that do NOT resolve to a registered agent. Drives the webhook no-route alert
 * (audit #1): an unresolved id is the silent "assigned it and nothing
 * happened" case, whereas an event that names nobody (IssueLabel/Project/...
 * entity writes, unassigned issues, plain comments) no-routes by construction
 * and is not a routing failure.
 */
export declare function unresolvedRoutingCandidates(event: LinearEvent): string[];
/**
 * Route a Linear event to an OpenClaw agent.
 * Returns a RouteResult if routing succeeded, null if no agent found.
 */
export declare function routeEvent(event: LinearEvent): RouteResult | null;
/**
 * Route a Linear event to ALL its targets: the primary route (delegate →
 * assignee → first mention, exactly as routeEvent) plus one mention route per
 * additional registered agent mentioned in the event (audit #3 — previously
 * only the first mentioned agent was ever woken).
 */
export declare function routeEventAll(event: LinearEvent): RouteResult[];
//# sourceMappingURL=router.d.ts.map