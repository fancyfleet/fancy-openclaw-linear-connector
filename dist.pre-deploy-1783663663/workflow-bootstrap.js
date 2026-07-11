/**
 * AI-1565: Pre-routing workflow bootstrap hook.
 *
 * When a wf:* label is added to a ticket with no state:* label, applies the
 * entry state from the workflow def and sets the first-owner delegate — no
 * human/agent action required.
 *
 * Reverse (demote): when wf:* is removed and state:* labels remain, cleans
 * them up so the ticket reverts to ad-hoc.
 *
 * This hook runs before the delegate-based router so a label-only change
 * (no delegate, no assignee, no mention) can bootstrap the ticket.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { componentLogger, createLogger } from "./logger.js";
import { loadWorkflowRegistry } from "./workflow-gate.js";
import { resolveBodiesForRole } from "./escalation-gate.js";
import { findOrCreateLabel } from "./linear-helpers.js";
import { getAgents, getAccessToken } from "./agents.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "workflow-bootstrap");
const LINEAR_API_URL = "https://api.linear.app/graphql";
// ── Agents loader ─────────────────────────────────────────────────────────────
async function loadAgents() {
    const filePath = process.env.AGENTS_PATH ?? path.resolve(process.cwd(), "agents.json");
    try {
        const raw = await fs.readFile(filePath, "utf8");
        const data = JSON.parse(raw);
        return data.agents ?? [];
    }
    catch {
        return [];
    }
}
/**
 * Fetch an issue's current context (labels, team, identifier) from Linear.
 *
 * Shared by the webhook bootstrap path and the reconciliation sweep — the
 * sweep uses this for the idempotency re-fetch before healing a ticket.
 */
export async function fetchIssueContext(issueId, authToken) {
    const query = `
    query IssueWithLabels($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        team { id }
        labels { nodes { id name } }
        delegate { id }
      }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query, variables: { id: issueId } }),
        });
        const data = (await res.json());
        const issue = data.data?.issue;
        if (!issue)
            return null;
        return {
            id: issue.id,
            teamId: issue.team.id,
            identifier: issue.identifier,
            title: issue.title,
            labels: issue.labels.nodes,
        };
    }
    catch {
        return null;
    }
}
/**
 * Atomically apply label IDs (+ optional delegate) to an issue.
 *
 * Shared primitive — used by both the webhook bootstrap and the sweep.
 */
export async function issueUpdateAtomic(internalId, labelIds, authToken, delegateId) {
    const hasDelegate = delegateId !== undefined;
    const inputParts = ["labelIds: $labelIds"];
    if (hasDelegate)
        inputParts.push("delegateId: $delegateId");
    const mutation = `
    mutation ApplyAtomicTransition($issueId: String!, $labelIds: [String!]!${hasDelegate ? ", $delegateId: String" : ""}) {
      issueUpdate(id: $issueId, input: { ${inputParts.join(", ")} }) {
        success
      }
    }
  `;
    const variables = { issueId: internalId, labelIds };
    if (hasDelegate)
        variables.delegateId = delegateId;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query: mutation, variables }),
        });
        const data = (await res.json());
        return data.data?.issueUpdate?.success ?? false;
    }
    catch {
        return false;
    }
}
// ── Main hook ─────────────────────────────────────────────────────────────────
/**
 * Pre-routing bootstrap hook — runs before the delegate-based router.
 *
 * Returns a BootstrapResult if the bootstrap or demote path fired, null otherwise.
 * Never throws: all errors are caught and logged, failing safe.
 */
export async function maybeBootstrapWorkflow(event, authToken, enrolledTicketsStore) {
    if (event.type !== "Issue" || (event.action !== "update" && event.action !== "create"))
        return null;
    // For create events updatedFrom is absent — previousLabelIds will be [] and all current labels
    // are treated as "added", which is exactly what we want for pre-attached wf: labels.
    const issueEvent = event;
    const currentLabelIds = issueEvent.data.labelIds ?? [];
    const updatedFrom = issueEvent.updatedFrom;
    const previousLabelIds = updatedFrom?.labelIds ?? [];
    const currentSet = new Set(currentLabelIds);
    const previousSet = new Set(previousLabelIds);
    const addedIds = currentLabelIds.filter((id) => !previousSet.has(id));
    const removedIds = previousLabelIds.filter((id) => !currentSet.has(id));
    if (addedIds.length === 0 && removedIds.length === 0) {
        return null;
    }
    // Fetch current label names — needed to distinguish wf:* from state:* by ID.
    // Try the provided token first; if issue fetch fails, fall back to other
    // agent tokens (the provided token may lack access to the issue's team).
    let issue = null;
    let effectiveToken = authToken; // may be replaced by a fallback token
    const triedTokens = [];
    const tryFetch = async (token) => {
        triedTokens.push(token.slice(0, 8) + "...");
        return fetchIssueContext(issueEvent.data.id, token);
    };
    try {
        issue = await tryFetch(authToken);
    }
    catch {
        /* fall through to fallback */
    }
    if (!issue) {
        // Fallback: try other agent tokens that may have access to this issue's team.
        try {
            const agents = getAgents();
            for (const a of agents) {
                const t = getAccessToken(a.name);
                if (!t || t === authToken)
                    continue; // skip the one we already tried
                try {
                    issue = await tryFetch(t);
                    if (issue) {
                        effectiveToken = t;
                        break;
                    }
                }
                catch {
                    continue;
                }
            }
        }
        catch {
            /* give up */
        }
    }
    if (!issue) {
        return null;
    }
    const currentWfLabelNode = issue.labels.find((n) => n.name.startsWith("wf:"));
    const currentStateLabels = issue.labels.filter((n) => n.name.startsWith("state:"));
    // ── Bootstrap path: a wf:* label was newly added ──────────────────────────
    if (addedIds.length > 0 && currentWfLabelNode && addedIds.includes(currentWfLabelNode.id)) {
        // Idempotency: if state:* is already present, this ticket is already in-flight.
        if (currentStateLabels.length > 0)
            return null;
        return applyBootstrapToIssue(issue, effectiveToken, undefined, enrolledTicketsStore);
    }
    // ── Demote path: wf:* was removed, state:* labels remain ─────────────────
    if (removedIds.length > 0 && !currentWfLabelNode && currentStateLabels.length > 0) {
        const stateLabelIds = new Set(currentStateLabels.map((n) => n.id));
        const newLabelIds = currentLabelIds.filter((id) => !stateLabelIds.has(id));
        await issueUpdateAtomic(issue.id, newLabelIds, effectiveToken);
        log.info(`workflow-bootstrap: demoted ${issueEvent.data.id} — removed [${currentStateLabels.map((n) => n.name).join(", ")}]`);
        return { action: "demoted" };
    }
    return null;
}
// ── Shared bootstrap core ────────────────────────────────────────────────────
/**
 * Apply bootstrap (entry-state label + first-owner delegate) to an issue whose
 * context has already been fetched.
 *
 * This is the shared core invoked by both:
 *   - the webhook bootstrap hook (`maybeBootstrapWorkflow`)
 *   - the periodic reconciliation sweep (`runBootstrapReconciliationSweep`)
 *
 * AI-1775: a parallel reimplementation is explicitly disallowed by AC1 — both
 * paths must funnel through this function so the heal is identical to the
 * webhook-triggered bootstrap.
 *
 * Pre-conditions (checked by the caller):
 *   - The issue has a `wf:*` label
 *   - The issue has NO `state:*` label (idempotency)
 *
 * This function re-checks idempotency defensively (state:* present → null) so
 * the race between a late webhook and the sweep is covered even when the
 * caller's context is slightly stale.
 *
 * Returns a BootstrapResult on success, or null if the ticket was already
 * enrolled, the workflow def is missing, or label/mutation application failed.
 */
export async function applyBootstrapToIssue(issue, authToken, 
/** Optional registry override (used by the sweep). If absent, loads from file. */
workflowRegistryOverride, 
/** AI-1799: optional mirror store — writes enrollment rows for board data. */
enrolledTicketsStore) {
    // Defensive idempotency re-check — handles the webhook/sweep race.
    const currentStateLabels = issue.labels.filter((n) => n.name.startsWith("state:"));
    if (currentStateLabels.length > 0)
        return null;
    const wfLabelNode = issue.labels.find((n) => n.name.startsWith("wf:"));
    if (!wfLabelNode)
        return null;
    const workflowId = wfLabelNode.name.slice("wf:".length);
    let registry;
    if (workflowRegistryOverride) {
        registry = workflowRegistryOverride;
    }
    else {
        try {
            registry = await loadWorkflowRegistry();
        }
        catch (err) {
            log.warn(`workflow-bootstrap: failed to load registry for '${workflowId}': ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
    const def = registry.get(workflowId);
    if (!def?.entry_state) {
        log.warn(`workflow-bootstrap: no def (or no entry_state) for workflow '${workflowId}' — skipping bootstrap`);
        return null;
    }
    const entryState = def.entry_state;
    const entryStateDef = def.states.find((s) => s.id === entryState);
    // Resolve first-owner delegate from capability policy.
    let delegateLinearUserId;
    let delegateAgentName;
    let delegateRole = entryStateDef?.owner_role;
    if (delegateRole) {
        try {
            let bodies = await resolveBodiesForRole(delegateRole);
            // If the entry role has no bodies (e.g. synthetic "engine" role),
            // look ahead to the first transition target's owner_role.
            if (bodies.length === 0 && entryStateDef?.transitions?.length) {
                const firstTransTarget = def.states.find((s) => s.id === entryStateDef.transitions[0].to);
                const nextRole = firstTransTarget?.owner_role;
                if (nextRole && nextRole !== delegateRole) {
                    bodies = await resolveBodiesForRole(nextRole);
                    if (bodies.length > 0)
                        delegateRole = nextRole;
                }
            }
            if (bodies.length === 1) {
                delegateAgentName = bodies[0];
                const agents = await loadAgents();
                const agent = agents.find((a) => a.name === delegateAgentName);
                if (agent?.linearUserId) {
                    delegateLinearUserId = agent.linearUserId;
                }
                else {
                    log.warn(`workflow-bootstrap: body '${delegateAgentName}' has no linearUserId — delegate not set`);
                }
            }
        }
        catch (err) {
            log.warn(`workflow-bootstrap: role resolution failed for '${delegateRole}': ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // Find or create the entry state label.
    const stateLabelId = await findOrCreateLabel(issue.teamId, `state:${entryState}`, authToken);
    if (!stateLabelId) {
        log.warn(`workflow-bootstrap: could not resolve label 'state:${entryState}' — aborting bootstrap`);
        return null;
    }
    const currentLabelIds = issue.labels.map((l) => l.id);
    const newLabelIds = Array.from(new Set([...currentLabelIds, stateLabelId]));
    const success = await issueUpdateAtomic(issue.id, newLabelIds, authToken, delegateLinearUserId);
    if (!success) {
        log.warn(`workflow-bootstrap: issueUpdate returned non-success for ${issue.id}`);
    }
    else {
        log.info(`workflow-bootstrap: bootstrapped ${issue.id} → ${workflowId}:${entryState}, delegate=${delegateLinearUserId ?? "none"}`);
        // AI-1799: write enrollment row to the mirror so the board read API has data.
        enrolledTicketsStore?.enroll({
            ticketId: issue.identifier ?? issue.id,
            workflow: workflowId,
            state: entryState,
            delegate: delegateAgentName ?? null,
        });
    }
    return {
        action: "bootstrapped",
        workflowId,
        entryState,
        delegateAgentName,
        ticketIdentifier: issue.identifier,
        ticketTitle: issue.title,
    };
}
//# sourceMappingURL=workflow-bootstrap.js.map