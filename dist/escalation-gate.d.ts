/**
 * Phase 2 / slice 1 — escalation gate enforcement (AI-1346).
 *
 * Enforces inbound Linear CLI rules in the connector proxy. Slice 1 rule:
 * on workflow tickets (carrying a wf:* label), `needs-human` is steward-only.
 * Ad-hoc tickets (no wf:* label) are full pass-through — §4.6 mode switch.
 *
 * The rule table is data-driven so Phase 3 (full per-step command validation)
 * can add rules as config rather than surgery.
 *
 * Authority model:
 *   body → container (capability-policy.yaml) → grants capabilities[]
 *   The proxy NEVER trusts agent-supplied state; it fetches labels independently.
 *
 * Design: design.md §4.6, §11, §13.
 */
interface PolicyBody {
    id: string;
    /** Optional OpenClaw runtime agent alias. Resolves `x-openclaw-agent` headers that differ from `id` (e.g. main → ai). */
    openclaw_agent?: string;
    container: string;
    fills_roles: string[];
}
interface PolicyContainer {
    id: string;
    grants: string[];
}
interface PolicyCapability {
    id: string;
    /** Invariant: exactly ONE body fleet-wide may reach this capability (§16.0). */
    exclusive?: boolean;
}
interface PolicyRole {
    id: string;
    requires: string[];
    /** Invariant: exactly ONE body fleet-wide may fill this role (§16.0). */
    exclusive?: boolean;
}
interface CapabilityPolicy {
    bodies: PolicyBody[];
    containers: PolicyContainer[];
    capabilities?: PolicyCapability[];
    roles?: PolicyRole[];
}
/**
 * One enforcement rule. The proxy evaluates all rules matching the incoming
 * intent; the first violation produces a rejection.
 */
export interface EnforcementRule {
    /** Value of `x-openclaw-linear-intent` that triggers this rule. */
    intent: string;
    /** Capability the calling body must hold. */
    requiredCapability: string;
    /** Human-readable description of the legal alternative, used in the error. */
    legalMove: string;
}
/**
 * Phase 2 enforcement rules (slice 1: one rule).
 * Phase 3 will extend this table — adding a rule is config, not code surgery.
 */
export declare const ENFORCEMENT_RULES: EnforcementRule[];
/**
 * Validate structural invariants of the capability policy (design.md §16.0).
 * Returns a list of human-readable violation strings; empty array = healthy.
 *
 * Seeded by the AI-1738 incident: `bodies[astrid].container: workflow` was a
 * dangling reference (containers[] had `steward`, not `workflow`), so
 * resolveBodyCapabilities("astrid") silently returned an empty set — killing
 * her escalation authority while the YAML still parsed and config-health stayed
 * green. These invariants make that class of breakage loud (AI-1749).
 *
 * Checks:
 *   1. Container join — every body.container exists in containers[].
 *   2. Exclusive roles — every role with `exclusive: true` is filled by exactly
 *      one body via fills_roles.
 *   3. Exclusive capabilities — every capability with `exclusive: true` is
 *      reachable via exactly one body's container grant chain.
 */
export declare function validatePolicyInvariants(policy: CapabilityPolicy): string[];
/** Invalidate the in-process policy cache (used in tests). */
export declare function resetPolicyCache(): void;
/**
 * Returns true when the body holds the given capability via its container.
 * Exported for unit tests.
 */
export declare function bodyHasCapability(bodyId: string, capability: string): Promise<boolean>;
/**
 * Returns true when the body ID resolves to a known entry in the capability policy.
 * Unknown bodies (not in policy) are treated as untrusted callers.
 * Used by the workflow gate for fail-closed enforcement on wf:dev-impl tickets (AI-1402).
 */
export declare function isBodyKnown(bodyId: string): Promise<boolean>;
/**
 * Returns body IDs that fill the given role (§16.2).
 * Used by the workflow gate to derive legal assignment targets.
 */
export declare function resolveBodiesForRole(roleId: string): Promise<string[]>;
/**
 * Evaluate enforcement rules for an inbound proxied request.
 *
 * Returns a rejection message string when the request should be blocked,
 * or `null` if it should be forwarded unchanged.
 *
 * Fails open on ambiguity (no issue context, label fetch failure, unknown body):
 * enforcement only blocks when it has affirmative evidence of a violation.
 */
export declare function checkEnforcementRules(intent: string, issueId: string | null, authToken: string, bodyId: string): Promise<string | null>;
export {};
//# sourceMappingURL=escalation-gate.d.ts.map