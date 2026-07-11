/**
 * Phase 2 — registry ⇄ capability-policy cross-check (rebuild project, WS2).
 *
 * agents.json is the single source of truth for agent identity and physical
 * placement. The capability policy's `bodies:` section must agree with it:
 *
 *   1. Every policy body resolves to a registered agent. A body without a
 *      registration is dead config — a ticket delegated to it no-routes, and
 *      the audit's live example (`r2d2`) sat undetected for weeks.
 *   2. Each body's physical container matches the registry. The policy
 *      `container:` is a CAPABILITY BUNDLE and may legitimately diverge from
 *      the docker container name (igor: bundle `dev-backend`, lives in `dev`).
 *      Where they diverge, the body must say so explicitly via
 *      `openclaw_container:` — implicit divergence is exactly how the AI-1738
 *      half-applied cutover went unnoticed.
 *
 * Drift alerts loudly (alert bus, warning → push) but does NOT flip
 * config-health: config-health unhealthy fail-closes the whole engine, and
 * one stale body must not freeze unrelated tickets. Genuine load failures of
 * either file still flip config-health via their own artifact kinds.
 */
import { type AgentConfig } from "./agents.js";
import { type PolicyBody } from "./escalation-gate.js";
export interface RegistryPolicyStatus {
    /** ISO timestamp of the last completed check, or null if never run. */
    lastCheck: string | null;
    violations: string[];
    /** Non-failing observations (e.g. agents with no policy body). */
    notes: string[];
}
/** Physical (docker) container an agent runs in, derived from its secretsPath. */
export declare function physicalContainerOf(agent: Pick<AgentConfig, "secretsPath">): string | null;
/**
 * Pure cross-check. Returns violations (loud) and notes (informational).
 * Exported for tests.
 */
export declare function crossCheckRegistryPolicy(agents: AgentConfig[], bodies: PolicyBody[]): {
    violations: string[];
    notes: string[];
};
/**
 * Load both artifacts, run the cross-check, alert on drift.
 * Never throws — a check failure must not take down the caller.
 */
export declare function runRegistryPolicyCheck(trigger: string): Promise<RegistryPolicyStatus>;
/** Last check result — surfaced by /admin and, later, the console. */
export declare function getRegistryPolicyStatus(): RegistryPolicyStatus;
/** Wire the check to run now and again on every successful registry hot-reload. */
export declare function startRegistryPolicyCheck(): void;
//# sourceMappingURL=registry-policy.d.ts.map