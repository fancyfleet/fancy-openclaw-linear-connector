/**
 * AI-1428 — DELEGATE_UNAVAILABLE escalation.
 *
 * When the liveness check confirms an agent is unreachable, this module
 * posts an explicit escalation comment on the Linear ticket and reassigns
 * the ticket to the steward (Ai) so a human can intervene.
 *
 * Builds on patterns from escalation-gate.ts but serves a different purpose:
 * escalation-gate enforces proxy-layer command rules; this module handles
 * the outbound "agent unreachable" notification path.
 */

import { createLogger, componentLogger } from "./logger.js";
import { getAccessToken, getAgent, getLinearUserIdForAgent } from "./agents.js";
import { notify } from "./alerts/alert-bus.js";

const log = componentLogger(createLogger(), "escalation");

const LINEAR_API_URL = "https://api.linear.app/graphql";

export interface EscalationResult {
  /** Comment was posted successfully. */
  commentPosted: boolean;
  /** Delegate was changed to steward. */
  delegateChanged: boolean;
}

/**
 * Emit a DELEGATE_UNAVAILABLE event: post an escalation comment on the
 * Linear ticket and (optionally) reassign the delegate to the steward.
 *
 * Returns a summary of what succeeded. Failures are logged but do not throw.
 */
export async function emitDelegateUnavailable(
  issueIdentifier: string,
  targetAgentId: string,
  reason: string,
  authToken?: string,
): Promise<EscalationResult> {
  const token =
    authToken ??
    getAccessToken(targetAgentId) ??
    process.env.LINEAR_OAUTH_TOKEN ??
    process.env.LINEAR_API_KEY;

  if (!token) {
    log.error(`escalation: no auth token for ${issueIdentifier} — cannot post DELEGATE_UNAVAILABLE`);
    return { commentPosted: false, delegateChanged: false };
  }

  const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;

  const result: EscalationResult = { commentPosted: false, delegateChanged: false };

  // 1. Resolve the internal issue ID.
  const internalId = await resolveIssueId(issueIdentifier, authHeader);
  if (!internalId) {
    log.error(`escalation: could not resolve issue ID for ${issueIdentifier}`);
    return result;
  }

  // 2. Post escalation comment.
  const commentBody =
    `[Connector] ${targetAgentId} is unreachable (${reason}) — escalating to steward (Ai).`;

  const posted = await postComment(internalId, commentBody, authHeader);
  result.commentPosted = posted;
  if (!posted) {
    log.error(`escalation: failed to post comment on ${issueIdentifier}`);
  }

  // 3. Reassign the delegate to the steward (Ai) so the ticket does not sit
  // stranded on a dead agent. Audit #11: the docstring always promised this
  // but delegateChanged was never set — the comment landed and nothing
  // re-fired until something else touched the ticket. The delegate write
  // itself emits a webhook, which routes to Ai and wakes her.
  const stewardUserId = getAgent(STEWARD_AGENT_ID)?.linearUserId ?? getLinearUserIdForAgent(STEWARD_AGENT_ID);
  if (stewardUserId && targetAgentId !== STEWARD_AGENT_ID) {
    result.delegateChanged = await updateDelegate(internalId, stewardUserId, authHeader);
    if (!result.delegateChanged) {
      log.error(`escalation: failed to reassign delegate to ${STEWARD_AGENT_ID} on ${issueIdentifier}`);
    }
  } else if (!stewardUserId) {
    log.error(`escalation: steward '${STEWARD_AGENT_ID}' has no linearUserId in the registry — cannot reassign`);
  }

  // 4. Structured log event.
  log.warn(
    `DELEGATE_UNAVAILABLE: agent=${targetAgentId} issue=${issueIdentifier} reason=${reason} reassigned=${result.delegateChanged}`,
  );

  // 5. Human push (audit #11): the ticket comment above is only visible to
  // someone reading that ticket, and delivery to the dead agent was SKIPPED.
  notify({
    severity: "warning",
    source: "dispatch",
    title: result.delegateChanged
      ? `delegate unreachable — delivery skipped, ticket reassigned to ${STEWARD_AGENT_ID} (${reason})`
      : `delegate unreachable — delivery skipped and reassignment FAILED, ticket is stranded on a dead agent (${reason})`,
    agent: targetAgentId,
    ticket: issueIdentifier,
  });

  return result;
}

/** Steward who inherits tickets stranded on unreachable delegates. */
const STEWARD_AGENT_ID = process.env.DELEGATE_UNAVAILABLE_STEWARD ?? "ai";

/** Set the issue's delegate. Fail-open: returns false on any error. */
async function updateDelegate(
  internalId: string,
  delegateLinearUserId: string,
  authHeader: string,
): Promise<boolean> {
  const mutation = `
    mutation UpdateDelegate($issueId: String!, $delegateId: String!) {
      issueUpdate(id: $issueId, input: { delegateId: $delegateId }) {
        success
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ query: mutation, variables: { issueId: internalId, delegateId: delegateLinearUserId } }),
    });
    const data = (await res.json()) as { data?: { issueUpdate?: { success: boolean } } };
    return Boolean(data.data?.issueUpdate?.success);
  } catch (err) {
    log.error(`escalation: delegate update failed for ${internalId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function resolveIssueId(
  identifier: string,
  authHeader: string,
): Promise<string | null> {
  const query = `query($id: String!) { issue(id: $id) { id } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({ query, variables: { id: identifier } }),
    });
    type Resp = { data?: { issue?: { id: string } | null } };
    const data = (await res.json()) as Resp;
    return data.data?.issue?.id ?? null;
  } catch (err) {
    log.error(`escalation: issue lookup failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function postComment(
  issueId: string,
  body: string,
  authHeader: string,
): Promise<boolean> {
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
    type Resp = { data?: { commentCreate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    return data.data?.commentCreate?.success === true;
  } catch (err) {
    log.error(`escalation: comment post failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
