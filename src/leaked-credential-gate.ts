/**
 * INF-529 / Layer 1: leaked-credential rotation gate (proxy path).
 *
 * Blocks an *agent-issued* close of a `sec:leaked-credential` ticket unless a
 * rotation-confirmation artifact is present on the ticket. Wired into the proxy
 * chain in `proxy.ts` alongside `checkEnforcementRules` / `checkWorkflowRules`,
 * as a STANDALONE gate rather than a branch inside `checkWorkflowRules`:
 *
 *   The origin failure (AI-2372) was a *plain, ad-hoc* ticket with no `wf:*`
 *   label. Both the escalation gate and the workflow gate short-circuit for
 *   non-workflow tickets — so a gate living inside them would miss exactly the
 *   failure class this exists to close. This gate keys on the label alone and
 *   fires regardless of workflow membership.
 *
 * Fail posture (deliberately asymmetric):
 *   • Broad FAIL-OPEN until we have affirmative evidence the mutation is both a
 *     close AND on a labelled ticket — a transient Linear blip must not block
 *     unrelated fleet traffic.
 *   • Narrow FAIL-CLOSED once that evidence exists: if we cannot verify the
 *     rotation artifact, we block. For a security-critical ticket, the artifact
 *     must be affirmatively present, never assumed.
 *
 * See `leaked-credential-artifact.ts` for label/artifact definitions shared with
 * the reopen sweep (Layer 2).
 */

import { createModuleLogger } from "./logging.js";
import {
  SEC_LEAKED_CREDENTIAL_LABEL,
  anyCommentConfirmsRotation,
} from "./leaked-credential-artifact.js";
import { LINEAR_API_URL } from "./linear-helpers.js";

const log = createModuleLogger("leaked-credential-gate");

/**
 * Semantic verbs that resolve/close a ticket. The `stateId` type check below is
 * the authoritative catch-all (it sees the true destination regardless of verb
 * naming); this set is the cheap pre-filter and the fallback when a semantic
 * close carries no explicit `stateId` in the forwarded mutation.
 *
 * `refuse-work` is deliberately NOT here: it is decline-and-reroute (sets status
 * to Todo and re-delegates), not a terminal resolution. Gating it would strand a
 * mis-delegated `sec:leaked-credential` ticket behind its own protection — the
 * mandate is "cannot CLOSE without rotation", not "cannot reroute before
 * rotation." A refuse that genuinely resolves would still carry a
 * completed/canceled `stateId` and be caught by the `stateId` type check.
 */
export const CLOSE_INTENTS = new Set<string>([
  "complete-work",
  "complete",
  "cancel",
  "abandon",
  "invalidate",
]);

/** Linear `WorkflowState.type` values that mean "the ticket is closed/resolved". */
const CLOSING_STATE_TYPES = new Set<string>(["completed", "canceled"]);

/**
 * Resolve a `stateId` to its `WorkflowState.type`. Returns null on any failure
 * (network, unknown id) — the caller treats "unknown" as "not a close" so a
 * transient failure never blocks a non-close mutation.
 */
async function fetchStateType(stateId: string, authToken: string): Promise<string | null> {
  const query = `query StateType($id: String!) { workflowState(id: $id) { type } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: stateId } }),
    });
    type Resp = { data?: { workflowState?: { type?: string } } };
    const data = (await res.json()) as Resp;
    return data.data?.workflowState?.type ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`leaked-credential-gate: state-type fetch failed for ${stateId}: ${msg} — treating as non-close`);
    return null;
  }
}

/** Fetch an issue's label names. Returns null on failure (caller fails open). */
async function fetchLabels(issueId: string, authToken: string): Promise<string[] | null> {
  const query = `query IssueLabels($id: String!) { issue(id: $id) { labels { nodes { name } } } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = { data?: { issue?: { labels?: { nodes: Array<{ name: string }> } } } };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.issue?.labels?.nodes;
    if (!nodes) return null;
    return nodes.map((n) => n.name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`leaked-credential-gate: label fetch failed for ${issueId}: ${msg} — failing open`);
    return null;
  }
}

/**
 * Fetch recent comment bodies (newest first). Returns null on failure so the
 * caller can distinguish "no artifact" (fetched, absent) from "could not tell"
 * (fetch failed) and fail closed on the latter.
 */
async function fetchCommentBodies(issueId: string, authToken: string): Promise<string[] | null> {
  const query = `
    query LeakedCredComments($id: String!) {
      issue(id: $id) { comments(first: 50, orderBy: createdAt) { nodes { body } } }
    }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = { data?: { issue?: { comments?: { nodes: Array<{ body: string }> } } } };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.issue?.comments?.nodes;
    if (!nodes) return null;
    return nodes.map((n) => n.body ?? "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`leaked-credential-gate: comment fetch failed for ${issueId}: ${msg} — failing closed`);
    return null;
  }
}

/** Rejection message shared with tests. */
export function rotationBlockMessage(intent: string): string {
  return (
    `[Proxy] '${intent}' blocked: cannot close a '${SEC_LEAKED_CREDENTIAL_LABEL}' ticket ` +
    `without a rotation-confirmation artifact. Post a comment attesting the credential was ` +
    `rotated AND the old value revoked (marker: ` +
    `\`<!-- rotation-confirmed: {"credential":"<name>","revoked":true} -->\` ` +
    `or a \`ROTATION-CONFIRMED: … revoked …\` line), then retry. A leaked key left live in ` +
    `pushed history stays harvestable — rotation is the close condition, not a formality. ` +
    `Genuine non-rotation exceptions go through a steward (break-glass), not a silent close.`
  );
}

/**
 * Evaluate the leaked-credential close gate.
 *
 * @param intent            effective intent header (may be null)
 * @param issueId           issue UUID (may be null)
 * @param authToken         Linear authorization header value
 * @param targetStateId     `input.stateId` extracted from the mutation, if any
 * @param breakGlassOverride steward break-glass — bypasses the gate (audited by caller)
 * @returns rejection message string to BLOCK, or null to ALLOW.
 */
export async function checkLeakedCredentialGate(
  intent: string | null,
  issueId: string | null,
  authToken: string,
  targetStateId: string | null,
  breakGlassOverride: boolean = false,
): Promise<string | null> {
  // Steward escape valve — a genuine non-rotation close is a human decision.
  if (breakGlassOverride) return null;

  // Cheap pre-filter: skip all network work unless this mutation could close.
  const intentCloses = intent != null && CLOSE_INTENTS.has(intent);
  if (!intentCloses && !targetStateId) return null;

  if (!issueId) return null;

  // Confirm it is genuinely a close. A semantic close verb is authoritative on
  // its own; otherwise resolve the destination state's type.
  let isClose = intentCloses;
  if (!isClose && targetStateId) {
    const type = await fetchStateType(targetStateId, authToken);
    isClose = type != null && CLOSING_STATE_TYPES.has(type);
  }
  if (!isClose) return null;

  // Only now do we care about the label. Fail OPEN if we can't read it.
  const labels = await fetchLabels(issueId, authToken);
  if (labels == null) return null;
  if (!labels.includes(SEC_LEAKED_CREDENTIAL_LABEL)) return null;

  // Labelled security ticket being closed — from here we fail CLOSED.
  const bodies = await fetchCommentBodies(issueId, authToken);
  if (bodies == null) {
    log.warn(`leaked-credential-gate: ${issueId} close blocked — could not verify rotation artifact (comment fetch failed)`);
    return rotationBlockMessage(intent ?? "close");
  }
  if (anyCommentConfirmsRotation(bodies)) return null;

  log.warn(`leaked-credential-gate: ${issueId} close blocked — no rotation-confirmation artifact present`);
  return rotationBlockMessage(intent ?? "close");
}
