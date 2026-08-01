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

import fs from "node:fs/promises";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { recordSuccess, recordFailure } from "./config-health.js";
import { defaultCapabilityPolicyPath } from "./instance-config.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "escalation-gate");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Resolve the policy path dynamically (reads env each call so test beforeAll works). */
function policyPath(): string {
  return process.env.CAPABILITY_POLICY_PATH ?? defaultCapabilityPolicyPath();
}

// ── YAML schema types ──────────────────────────────────────────────────────

export interface PolicyBody {
  id: string;
  /** Optional OpenClaw runtime agent alias. Resolves `x-openclaw-agent` headers that differ from `id` (e.g. main → ai). */
  openclaw_agent?: string;
  container: string;
  /**
   * Physical (docker) container when it legitimately differs from the
   * capability bundle named by `container:` (e.g. igor: bundle `dev-backend`,
   * runs in `dev`). Asserted against agents.json by the Phase-2
   * registry⇄policy cross-check (src/registry-policy.ts).
   */
  openclaw_container?: string;
  fills_roles: string[];
  /**
   * INF-924: departments this body belongs to (e.g. ["ENG"]). Used to team-scope
   * domain-routed role resolution (e.g. `department-head`) so a cross-team ticket
   * enrolled in another department's archetype never mis-routes to the wrong head.
   */
  departments?: string[];
  /** INF-924: teams this body belongs to (e.g. ["Engineering"]). See `departments`. */
  teams?: string[];
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

export interface CapabilityPolicy {
  bodies: PolicyBody[];
  containers: PolicyContainer[];
  capabilities?: PolicyCapability[];
  roles?: PolicyRole[];
}

// ── Data-driven rule table ─────────────────────────────────────────────────

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
export const ENFORCEMENT_RULES: EnforcementRule[] = [
  {
    intent: "needs-human",
    requiredCapability: "human:escalate",
    legalMove: "escalate → Ai (human gateway)",
  },
];

// ── Policy cache ───────────────────────────────────────────────────────────

let _policyCache: CapabilityPolicy | null = null;

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
export function validatePolicyInvariants(policy: CapabilityPolicy): string[] {
  const violations: string[] = [];
  const bodies = policy.bodies ?? [];
  const containers = policy.containers ?? [];
  const roles = policy.roles ?? [];
  const capabilities = policy.capabilities ?? [];

  const containerById = new Map(containers.map((c) => [c.id, c]));

  // 1. Container join — every body.container must resolve.
  for (const body of bodies) {
    if (!containerById.has(body.container)) {
      violations.push(
        `body '${body.id}' references container '${body.container}' which is not defined in containers[]`
      );
    }
  }

  // 2. Exclusive roles — filled by exactly one body.
  for (const role of roles) {
    if (!role.exclusive) continue;
    const holders = bodies
      .filter((b) => (b.fills_roles ?? []).includes(role.id))
      .map((b) => b.id);
    if (holders.length !== 1) {
      violations.push(
        `exclusive role '${role.id}' must be filled by exactly one body, found ${holders.length}` +
          (holders.length ? ` (${holders.join(", ")})` : "")
      );
    }
  }

  // 3. Exclusive capabilities — reachable via exactly one body's container.
  for (const cap of capabilities) {
    if (!cap.exclusive) continue;
    const holders = bodies
      .filter((b) => containerById.get(b.container)?.grants.includes(cap.id))
      .map((b) => b.id);
    if (holders.length !== 1) {
      violations.push(
        `exclusive capability '${cap.id}' must be reachable by exactly one body, found ${holders.length}` +
          (holders.length ? ` (${holders.join(", ")})` : "")
      );
    }
  }

  return violations;
}

async function loadPolicy(): Promise<CapabilityPolicy> {
  if (_policyCache) return _policyCache;
  try {
    const raw = await fs.readFile(policyPath(), "utf8");
    const parsed = yaml.load(raw) as CapabilityPolicy;
    _policyCache = parsed;
    // §16.0 load-time invariants (AI-1749). Do NOT throw on violation: the
    // fail-closed resolver already returns empty capability sets for unresolved
    // bodies, so runtime stays safe. We only make the degradation VISIBLE by
    // flipping config-health red instead of letting it silently stay green.
    const violations = validatePolicyInvariants(parsed);
    if (violations.length > 0) {
      recordFailure("capability-policy", `invariant violations: ${violations.join("; ")}`);
    } else {
      recordSuccess("capability-policy");
    }
    return _policyCache;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordFailure("capability-policy", msg);
    throw err;
  }
}

/** Invalidate the in-process policy cache (used in tests). */
export function resetPolicyCache(): void {
  _policyCache = null;
}

/** Policy bodies, for the registry⇄policy cross-check (src/registry-policy.ts). */
export async function getPolicyBodies(): Promise<PolicyBody[]> {
  const policy = await loadPolicy();
  return policy.bodies ?? [];
}

/**
 * Full capability-policy snapshot. Used by the first-action watchdog (AI-2009)
 * to resolve re-route targets: bodies that fill a role + which roles are
 * exclusive (singletons that must never be re-routed).
 */
export async function getCapabilityPolicy(): Promise<CapabilityPolicy> {
  return loadPolicy();
}

// ── Body → capability resolution ───────────────────────────────────────────

/**
 * Returns the set of capabilities granted to a body via its container.
 * Unknown body IDs return an empty set (fail-closed).
 */
async function resolveBodyCapabilities(bodyId: string): Promise<Set<string>> {
  const policy = await loadPolicy();
  const body = policy.bodies.find((b) => b.id === bodyId || b.openclaw_agent === bodyId);
  if (!body) {
    log.warn(`escalation-gate: unknown body '${bodyId}' — treating as no capabilities`);
    return new Set();
  }
  const container = policy.containers.find((c) => c.id === body.container);
  if (!container) {
    log.warn(`escalation-gate: unknown container '${body.container}' for body '${bodyId}'`);
    return new Set();
  }
  return new Set(container.grants);
}

/**
 * Returns true when the body holds the given capability via its container.
 * Exported for unit tests.
 */
export async function bodyHasCapability(bodyId: string, capability: string): Promise<boolean> {
  const caps = await resolveBodyCapabilities(bodyId);
  return caps.has(capability);
}

/**
 * Returns true when the body ID resolves to a known entry in the capability policy.
 * Unknown bodies (not in policy) are treated as untrusted callers.
 * Used by the workflow gate for fail-closed enforcement on wf:dev-impl tickets (AI-1402).
 */
export async function isBodyKnown(bodyId: string): Promise<boolean> {
  const policy = await loadPolicy();
  return policy.bodies.some((b) => b.id === bodyId || b.openclaw_agent === bodyId);
}

/**
 * Returns body IDs that fill the given role (§16.2).
 * Used by the workflow gate to derive legal assignment targets.
 */
export async function resolveBodiesForRole(roleId: string): Promise<string[]> {
  const policy = await loadPolicy();
  return policy.bodies
    .filter((b) => b.fills_roles.includes(roleId))
    .map((b) => b.id);
}

/**
 * INF-924: the team/department context of the ticket whose role is being resolved.
 * Passed by the outbound delivery path, the transition-target resolver, and the
 * routing guard so a domain-routed role (e.g. `department-head`) narrows to the
 * head that owns the *ticket's* team — never the head of the archetype's home
 * department via a blind prefix/default fallback.
 */
export interface TicketScope {
  issueIdentifier?: string;
  teamKey?: string;
  teamName?: string;
  workflowEnrollment?: {
    department?: string;
    team?: string;
  };
}

/**
 * INF-924 — team-scoped variant of {@link resolveBodiesForRole}.
 *
 * Root cause: a `wf:task` ticket is a Design-scoped archetype (`task.yaml`
 * department_scope: DSN/Design). Its `department-head` role is domain-routed,
 * but the resolution was team-blind — an ENG-team ticket running under the
 * Design-scoped def resolved the head via the department-prefix fallback to the
 * Design head (Laren) instead of the correct Engineering head (Charles). This
 * narrows the role's bodies to those matching the ticket's team/department.
 *
 * Conservative / fail-open by construction:
 *   - No scope, or a scope with no team/department signal → unchanged (all bodies).
 *   - None of the role's bodies carry team/department metadata → unchanged
 *     (policies predating INF-924 have no `teams`/`departments`).
 *   - A team/department signal that matches ≥1 body → the matching subset.
 *   - A signal that matches no body → the full set (never silently drop work;
 *     a no-legal-head ticket surfaces via the caller's existing empty/multi paths
 *     rather than mis-routing to an unrelated head).
 */
export async function resolveBodiesForRoleScoped(
  roleId: string,
  scope?: TicketScope,
): Promise<string[]> {
  const bodies = await resolveBodiesForRole(roleId);
  if (!scope || bodies.length <= 1) return bodies;

  const wantTeam = (scope.workflowEnrollment?.team ?? scope.teamName)?.trim().toLowerCase();
  const wantDept = (scope.workflowEnrollment?.department ?? scope.teamKey)?.trim().toLowerCase();
  if (!wantTeam && !wantDept) return bodies;

  const policy = await loadPolicy();
  const byId = new Map(policy.bodies.map((b) => [b.id, b]));

  const carriesScopeMeta = bodies.some((id) => {
    const b = byId.get(id);
    return (b?.teams?.length ?? 0) > 0 || (b?.departments?.length ?? 0) > 0;
  });
  if (!carriesScopeMeta) return bodies;

  const matched = bodies.filter((id) => {
    const b = byId.get(id);
    const teams = (b?.teams ?? []).map((t) => t.toLowerCase());
    const depts = (b?.departments ?? []).map((d) => d.toLowerCase());
    return (
      (wantTeam !== undefined && teams.includes(wantTeam)) ||
      (wantDept !== undefined && depts.includes(wantDept))
    );
  });

  if (matched.length === 0) {
    log.warn(
      `escalation-gate: role '${roleId}' has no body scoped to team='${wantTeam ?? "?"}' ` +
        `department='${wantDept ?? "?"}' — returning unscoped set [${bodies.join(", ")}] (no mis-route)`,
    );
    return bodies;
  }
  return matched;
}

// ── Workflow ticket detection ──────────────────────────────────────────────

/**
 * Fetch label names for a Linear issue using the caller's auth token.
 * The proxy does NOT trust agent-supplied state (design.md §11 Phase 2):
 * it independently queries Linear to determine ticket context.
 * Returns an empty array on any error (network failure, unknown issue) —
 * enforcement fails open rather than blocking legitimate traffic.
 */
async function fetchTicketLabels(issueId: string, authToken: string): Promise<string[]> {
  const query = `query IssueLabels($id: String!) { issue(id: $id) { labels { nodes { name } } } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type LabelResp = { data?: { issue?: { labels?: { nodes: Array<{ name: string }> } } } };
    const data = (await res.json()) as LabelResp;
    return (data.data?.issue?.labels?.nodes ?? []).map((n) => n.name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`escalation-gate: label fetch failed for issue ${issueId}: ${msg} — failing open`);
    return [];
  }
}

/** True when any label matches the wf:* pattern (§4.6 mode switch). */
function isWorkflowTicket(labels: string[]): boolean {
  return labels.some((l) => /^wf:/i.test(l));
}

// ── Public enforcement API ─────────────────────────────────────────────────

/**
 * Evaluate enforcement rules for an inbound proxied request.
 *
 * Returns a rejection message string when the request should be blocked,
 * or `null` if it should be forwarded unchanged.
 *
 * Fails open on ambiguity (no issue context, label fetch failure, unknown body):
 * enforcement only blocks when it has affirmative evidence of a violation.
 */
export async function checkEnforcementRules(
  intent: string,
  issueId: string | null,
  authToken: string,
  bodyId: string
): Promise<string | null> {
  const rule = ENFORCEMENT_RULES.find((r) => r.intent === intent);
  if (!rule) return null;

  // Without a ticket ID we can't determine workflow context — fail open.
  if (!issueId) return null;

  const labels = await fetchTicketLabels(issueId, authToken);

  // §4.6 mode switch: ad-hoc tickets (no wf:* label) are full pass-through.
  if (!isWorkflowTicket(labels)) return null;

  const allowed = await bodyHasCapability(bodyId, rule.requiredCapability);
  if (allowed) return null;

  return (
    `[Proxy] '${intent}' on a workflow ticket requires the '${rule.requiredCapability}' capability. ` +
    `Legal move: ${rule.legalMove}.`
  );
}
