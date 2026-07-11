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
import { createLogger, componentLogger } from "./logger.js";
import { getAccessToken } from "./agents.js";
import { loadWorkflowDefById, getWorkflowId, getCurrentState } from "./workflow-gate.js";
import { resolveBodiesForRole } from "./escalation-gate.js";
const log = componentLogger(createLogger(), "routing-guard");
const LINEAR_API_URL = "https://api.linear.app/graphql";
// ── Sync advisory helper (kept for tests / callers that only have labels) ───
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
export const REVIEW_ONLY_AGENTS = new Set([
    "charles",
    "tdd",
    "ai",
    "astrid",
    "finn",
    "mckell",
    "yoshi",
    "ken",
    "miki",
    "poe",
    "kat",
    "maren",
    "kenji",
    "lacey",
    "scout",
]);
export function checkRoleGuard(targetAgentId, ticketLabels) {
    const hasWorkflowLabel = ticketLabels.some((l) => /^wf:/i.test(l));
    if (!hasWorkflowLabel)
        return { blocked: false };
    const isImplementation = ticketLabels.some((l) => /^state:implementation$/i.test(l));
    if (!isImplementation)
        return { blocked: false };
    const normalizedAgent = targetAgentId.toLowerCase();
    if (!REVIEW_ONLY_AGENTS.has(normalizedAgent))
        return { blocked: false };
    const reason = `Target agent '${targetAgentId}' is not an implementation body for wf:dev-impl (review-only).`;
    log.warn(`Role-guard advisory: ${reason}`);
    return { blocked: false, reason };
}
// ── Phase 2: Enforcement-mode async check ─────────────────────────────────
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
export async function checkRoleGuardEnforced(targetAgentId, ticketLabels) {
    // 1. No workflow label → pass-through.
    const workflowId = getWorkflowId(ticketLabels);
    if (!workflowId)
        return { blocked: false };
    // 2. No current state → fail open.
    const currentState = getCurrentState(ticketLabels);
    if (!currentState) {
        log.warn(`routing-guard: no state:* label for enforcement check — failing open for ${targetAgentId}`);
        return { blocked: false };
    }
    // 3. Load workflow def by id from registry → fail open on error.
    let def;
    try {
        def = await loadWorkflowDefById(workflowId);
    }
    catch {
        log.warn(`routing-guard: failed to load workflow def — failing open for ${targetAgentId}`);
        return { blocked: false };
    }
    if (!def) {
        log.warn(`routing-guard: no workflow def in registry for wf:${workflowId} — failing open for ${targetAgentId}`);
        return { blocked: false };
    }
    // 4. Find the state node.
    const stateNode = def.states.find((s) => s.id === currentState);
    if (!stateNode) {
        log.warn(`routing-guard: unknown state '${currentState}' — failing open for ${targetAgentId}`);
        return { blocked: false };
    }
    // Terminal states have no meaningful role constraint on the recipient.
    if (stateNode.kind === "terminal")
        return { blocked: false };
    const ownerRole = stateNode.owner_role;
    if (!ownerRole) {
        // State has no role constraint → pass-through.
        return { blocked: false };
    }
    // 5. Resolve legal bodies for this role.
    let legalBodies;
    try {
        legalBodies = await resolveBodiesForRole(ownerRole);
    }
    catch (err) {
        log.warn(`routing-guard: failed to resolve bodies for role '${ownerRole}' — failing open: ${err instanceof Error ? err.message : String(err)}`);
        return { blocked: false };
    }
    if (legalBodies.length === 0) {
        // No registered bodies for this role → fail open; system is misconfigured
        // but we shouldn't drop work silently.
        log.warn(`routing-guard: no bodies registered for role '${ownerRole}' in state '${currentState}' — failing open`);
        return { blocked: false };
    }
    // 6. Check if the target fills the role.
    const normalizedAgent = targetAgentId.toLowerCase();
    if (legalBodies.map((b) => b.toLowerCase()).includes(normalizedAgent)) {
        // Legal dispatch — pass-through.
        return { blocked: false };
    }
    // 7. Violation — build the blocking result.
    const legalList = legalBodies.join(", ");
    const reason = `'${targetAgentId}' does not fill role '${ownerRole}' required for ` +
        `state '${currentState}' (wf:${workflowId}). ` +
        `Legal target(s): ${legalList}.`;
    log.warn(`routing-guard: BLOCKED dispatch — ${reason}`);
    const result = {
        blocked: true,
        reason,
        legalBodies,
    };
    // Surface the correction target so the caller can update the delegate.
    if (legalBodies.length === 1) {
        result.correctedTo = legalBodies[0];
    }
    return result;
}
export async function checkRoleGuardAndBlock(targetAgentId, issueIdentifier, ticketLabels, delegateLinearUserIdResolver) {
    const result = await checkRoleGuardEnforced(targetAgentId, ticketLabels);
    if (!result.blocked || !result.reason) {
        return result;
    }
    // Resolve auth token.
    // AI-2044: prefer the connector's own service token for guard-issued writes.
    // Authenticating as the (blocked) routed target stamps Linear history with
    // an agent that took no action — on AI-2040 the delegate-clear was attributed
    // to tdd because tdd was merely the body-mentioned dispatch target.
    const rawToken = process.env.LINEAR_OAUTH_TOKEN ??
        process.env.LINEAR_API_KEY ??
        getAccessToken(targetAgentId);
    if (!rawToken) {
        log.warn(`routing-guard: no token available to post blocking comment for ${issueIdentifier}`);
        return result;
    }
    const authHeader = /^Bearer\s+/i.test(rawToken) ? rawToken : `Bearer ${rawToken}`;
    // Resolve the internal UUID for the issue.
    const internalId = await resolveIssueId(issueIdentifier, authHeader);
    if (!internalId) {
        log.warn(`routing-guard: could not resolve issue id for ${issueIdentifier} — skipping comment/correction`);
        return result;
    }
    // AI-2044: the enforcement check answers "is the dispatch TARGET legal for
    // this state?" — but any delegate correction must be gated on a different
    // question: "is the CURRENT DELEGATE legal?". A comment body-mentioning an
    // illegal agent must never evict a legal, in-flight delegate (AI-2040: Sage
    // was cleared mid-implementation because a third party's comment mentioned
    // tdd, and the multi-body branch fell through to an unconditional clear).
    const delegateFetch = await fetchCurrentDelegate(internalId, authHeader);
    if (!delegateFetch.ok) {
        // Could not read the current delegate — never mutate on uncertainty.
        log.warn(`routing-guard: dispatch blocked for ${targetAgentId} [${issueIdentifier}] but current delegate is unreadable — leaving delegate untouched`);
        result.delegatePreserved = true;
        return result;
    }
    const currentDelegateId = delegateFetch.delegateId;
    if (currentDelegateId) {
        const delegateIsLegal = !!delegateLinearUserIdResolver &&
            (result.legalBodies ?? []).some((body) => delegateLinearUserIdResolver(body) === currentDelegateId);
        if (delegateIsLegal || !delegateLinearUserIdResolver) {
            // A delegate exists and either fills the owner_role or cannot be
            // verified: block delivery to the illegal target, leave the ticket
            // alone. No comment — a stray mention should not spam a healthy ticket.
            log.info(`routing-guard: dispatch blocked for ${targetAgentId} [${issueIdentifier}]; current delegate ${delegateIsLegal ? "is legal for the state" : "legality unverifiable"} — delegate preserved, no mutation`);
            result.delegatePreserved = true;
            return result;
        }
    }
    // Delegate is absent or itself illegal for the state — correct it.
    // 1. Post blocking comment.
    await postBlockingComment(internalId, targetAgentId, issueIdentifier, result, authHeader);
    // 2. Correct the delegate.
    // If a singleton correctedTo is set, the caller (webhook) should resolve the
    // body's linearUserId and call updateDelegateForIssue; we expose that helper.
    // For the no-token path we skip correction here; the caller must handle it.
    if (result.correctedTo && delegateLinearUserIdResolver) {
        const newDelegateLinearId = delegateLinearUserIdResolver(result.correctedTo);
        if (newDelegateLinearId) {
            const corrected = await updateDelegate(internalId, newDelegateLinearId, authHeader);
            if (corrected) {
                log.info(`routing-guard: delegate corrected for ${issueIdentifier}: ${targetAgentId} → ${result.correctedTo}`);
            }
            else {
                log.warn(`routing-guard: delegate correction failed for ${issueIdentifier}`);
            }
        }
        else {
            log.warn(`routing-guard: could not resolve Linear user ID for corrected target '${result.correctedTo}' — skipping delegate update`);
        }
    }
    else if (!result.correctedTo) {
        // Multiple legal targets — clear the delegate so the ticket surfaces for
        // manual routing, rather than leaving it on the wrong body.
        const cleared = await clearDelegate(internalId, authHeader);
        if (cleared) {
            log.info(`routing-guard: delegate cleared for ${issueIdentifier} (multiple legal targets; requires manual routing)`);
        }
        else {
            log.warn(`routing-guard: delegate clear failed for ${issueIdentifier}`);
        }
    }
    return result;
}
/**
 * Legacy compatibility wrapper.
 * Previous call sites that used `checkRoleGuardAndWarn` now route through
 * the enforcement path. This ensures the webhook caller is not broken by the
 * rename — update call sites to `checkRoleGuardAndBlock` at leisure.
 */
export async function checkRoleGuardAndWarn(targetAgentId, issueIdentifier, ticketLabels, delegateLinearUserIdResolver) {
    return checkRoleGuardAndBlock(targetAgentId, issueIdentifier, ticketLabels, delegateLinearUserIdResolver);
}
// ── Internal helpers ────────────────────────────────────────────────────────
async function resolveIssueId(identifier, authHeader) {
    const query = `query($id: String!) { issue(id: $id) { id } }`;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: authHeader },
            body: JSON.stringify({ query, variables: { id: identifier } }),
        });
        const data = (await res.json());
        return data.data?.issue?.id ?? null;
    }
    catch (err) {
        log.error(`routing-guard: issue lookup failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
/**
 * AI-2044: read the ticket's current delegate before any guard mutation.
 * Accepts either an internal UUID or a human identifier (Linear's issue(id:)
 * resolves both). Distinguishes "no delegate" ({ok:true, delegateId:null})
 * from "could not read" ({ok:false}) so callers can fail safe — the guard
 * must never mutate a ticket whose delegate it could not verify.
 */
export async function fetchCurrentDelegate(issueIdOrIdentifier, authHeader) {
    const query = `query IssueDelegate($id: String!) { issue(id: $id) { delegate { id } } }`;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: authHeader },
            body: JSON.stringify({ query, variables: { id: issueIdOrIdentifier } }),
        });
        const data = (await res.json());
        if (!data.data?.issue)
            return { ok: false };
        return { ok: true, delegateId: data.data.issue.delegate?.id ?? null };
    }
    catch (err) {
        log.error(`routing-guard: delegate fetch failed for ${issueIdOrIdentifier}: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false };
    }
}
async function postBlockingComment(issueId, illegalTarget, issueIdentifier, result, authHeader) {
    const correctionNote = result.correctedTo
        ? `Delegate has been automatically corrected to **${result.correctedTo}**.`
        : `Delegate has been cleared — manual routing required.`;
    const body = `[Connector] Dispatch blocked: illegal routing target detected on **${issueIdentifier}**.\n\n` +
        `**Illegal target:** ${illegalTarget}\n` +
        `**Reason:** ${result.reason}\n\n` +
        correctionNote;
    const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: authHeader },
            body: JSON.stringify({ query: mutation, variables: { issueId, body } }),
        });
        const data = (await res.json());
        if (data.data?.commentCreate?.success) {
            log.info(`routing-guard: blocking comment posted on ${issueId}`);
        }
        else {
            log.warn(`routing-guard: blocking comment returned non-success for ${issueId}`);
        }
    }
    catch (err) {
        log.error(`routing-guard: blocking comment failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
async function updateDelegate(issueId, delegateLinearUserId, authHeader) {
    const mutation = `
    mutation UpdateDelegate($issueId: String!, $delegateId: String!) {
      issueUpdate(id: $issueId, input: { dueDate: null }) { success }
    }
  `;
    // Linear uses `subscriberIds` for delegate-adjacent fields, but the actual
    // delegate is set via the undocumented `delegateId` on issueUpdate.
    const delegateMutation = `
    mutation UpdateDelegate($issueId: String!, $delegateId: String!) {
      issueUpdate(id: $issueId, input: { delegateId: $delegateId }) {
        success
        issue { id }
      }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: authHeader },
            body: JSON.stringify({
                query: delegateMutation,
                variables: { issueId, delegateId: delegateLinearUserId },
            }),
        });
        const data = (await res.json());
        return data.data?.issueUpdate?.success === true;
    }
    catch (err) {
        log.error(`routing-guard: delegate update failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
async function clearDelegate(issueId, authHeader) {
    const mutation = `
    mutation ClearDelegate($issueId: String!) {
      issueUpdate(id: $issueId, input: { delegateId: null }) {
        success
        issue { id }
      }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: authHeader },
            body: JSON.stringify({ query: mutation, variables: { issueId } }),
        });
        const data = (await res.json());
        return data.data?.issueUpdate?.success === true;
    }
    catch (err) {
        log.error(`routing-guard: delegate clear failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
//# sourceMappingURL=routing-guard.js.map