/**
 * Phase 5 / B-4 — Disposition review + parent-AC gate (F2b, §5.6).
 *
 * When the managing barrier fires and all children reach terminal state, the
 * parent transitions managing → review (done in B-3). This module handles
 * the **disposition** from review:
 *
 *   1. `→ done` (terminal) — gated on the **parent's own** AC being satisfied.
 *      The parent scope is NOT the sum of its children (the F2b fix, §5.6).
 *      The researcher must confirm that the parent issue's acceptance criteria
 *      are met independently of child completion.
 *
 *   2. `→ spawning` (follow-ups for gaps) — when the researcher identifies
 *      gaps that need additional children. Re-enters the spawning state to
 *      mint supplementary dev-impl tickets.
 *
 *   3. `→ escape` (break-glass) — always available per §4.4.
 *
 * Design: design.md §5.6, §14, §11 Phase 5 milestone.
 *
 * ACs:
 *   - managing barrier exits to review (disposition), not done. (B-3 — verified here)
 *   - From review the researcher dispositions: → done | → spawning | → escape.
 *   - → done is gated on the parent's own AC — not the sum of children (§5.6).
 */

import { componentLogger, createLogger } from "./logger.js";
import { fetchChildren, type ChildState } from "./barrier.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "review");

const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Types ─────────────────────────────────────────────────────────────────

/** Result of a parent-AC gate evaluation. */
export interface ParentAcGateResult {
  /** Whether the parent's own AC is satisfied. */
  satisfied: boolean;
  /** The parent issue identifier. */
  parentIdentifier: string;
  /** Reason for pass/fail. */
  reason: string;
  /** The parent's AC checklist items and their checked status, if available. */
  checklist?: AcChecklistItem[];
}

/** A single AC checklist item parsed from the issue description. */
export interface AcChecklistItem {
  /** The AC text. */
  text: string;
  /** Whether the checkbox is checked. */
  checked: boolean;
}

/** Result of a disposition attempt. */
export interface DispositionResult {
  /** Whether the disposition was applied. */
  applied: boolean;
  /** The disposition target state. */
  targetState: "done" | "spawning" | "escape";
  /** The parent issue identifier. */
  parentIdentifier: string;
  /** Error message if the disposition failed. */
  error?: string;
}

// ── AC Checklist Parsing ──────────────────────────────────────────────────

/**
 * Parse acceptance criteria from the issue description.
 *
 * Looks for Markdown checkboxes in the description:
 *   - [x] AC item text
 *   - [ ] Unchecked item
 *
 * Also supports "## Acceptance criteria" section with list items:
 *   ## Acceptance criteria
 *   - [x] First criterion
 *   - [ ] Second criterion
 *
 * Returns the list of parsed items, or an empty array if none found.
 */
export function parseAcChecklist(description: string | null | undefined): AcChecklistItem[] {
  if (!description) return [];

  const items: AcChecklistItem[] = [];

  // Match Markdown checkboxes: - [x] or - [ ] (case-insensitive for x)
  const checkboxRegex = /[-*]\s*\[([ xX])\]\s*(.+)/g;
  let match: RegExpExecArray | null;
  while ((match = checkboxRegex.exec(description)) !== null) {
    const checked = match[1].toLowerCase() === "x";
    const text = match[2].trim();
    if (text) {
      items.push({ text, checked });
    }
  }

  return items;
}

/**
 * Evaluate whether all acceptance criteria items in the checklist are checked.
 *
 * Returns { satisfied: true } only when:
 *   - At least one checklist item exists AND
 *   - Every item is checked.
 *
 * Returns { satisfied: false } when any item is unchecked or no items found.
 * The F2b fix (§5.6): this checks the **parent's own** AC, not the sum of
 * children. Even if all children are done, the parent's own AC might not be
 * satisfied (e.g., the parent's scope includes cross-cutting concerns that
 * no single child covers).
 */
export function evaluateAcGate(items: AcChecklistItem[]): { satisfied: boolean; reason: string } {
  if (items.length === 0) {
    return {
      satisfied: false,
      reason: "No acceptance criteria checkboxes found in the parent issue description. Add ACs as Markdown checkboxes (- [x] / - [ ]) and retry.",
    };
  }

  const unchecked = items.filter((item) => !item.checked);
  if (unchecked.length > 0) {
    const uncheckedList = unchecked.map((item) => `  - [ ] ${item.text}`).join("\n");
    return {
      satisfied: false,
      reason: `${unchecked.length} of ${items.length} AC item(s) unchecked:\n${uncheckedList}`,
    };
  }

  return {
    satisfied: true,
    reason: `All ${items.length} AC item(s) satisfied.`,
  };
}

// ── Linear API helpers ────────────────────────────────────────────────────

/**
 * Fetch the parent issue's description for AC parsing.
 */
async function fetchIssueDescription(
  identifier: string,
  authToken: string,
): Promise<string | null> {
  const query = `
    query IssueDescription($id: String!) {
      issue(id: $id) {
        description
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: identifier } }),
    });
    type Resp = { data?: { issue?: { description: string | null } | null } };
    const data = (await res.json()) as Resp;
    return data.data?.issue?.description ?? null;
  } catch (err) {
    log.error(`review: failed to fetch description for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Resolve a human-readable identifier to an internal UUID.
 */
async function resolveInternalId(
  identifier: string,
  authToken: string,
): Promise<string | null> {
  const query = `query($id: String!) { issue(id: $id) { id } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: identifier } }),
    });
    type Resp = { data?: { issue?: { id: string } | null } };
    const data = (await res.json()) as Resp;
    return data.data?.issue?.id ?? null;
  } catch (err) {
    log.error(`review: failed to resolve internal ID for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Fetch the issue's labels with IDs and team ID for label swap.
 */
async function fetchIssueWithLabels(
  identifier: string,
  authToken: string,
): Promise<{ internalId: string; teamId: string; labels: Array<{ id: string; name: string }> } | null> {
  const query = `
    query IssueLabels($id: String!) {
      issue(id: $id) {
        id
        team { id }
        labels { nodes { id name } }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: identifier } }),
    });
    type Resp = {
      data?: {
        issue?: {
          id: string;
          team: { id: string };
          labels: { nodes: Array<{ id: string; name: string }> };
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;
    return { internalId: issue.id, teamId: issue.team.id, labels: issue.labels.nodes };
  } catch (err) {
    log.error(`review: failed to fetch labels for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Find or create a label in the team.
 */
async function findOrCreateLabel(
  teamId: string,
  labelName: string,
  authToken: string,
): Promise<string | null> {
  // Look up existing
  const lookupQuery = `
    query TeamLabels($teamId: String!) {
      team(id: $teamId) {
        labels { nodes { id name } }
      }
    }
  `;
  try {
    const lookupRes = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: lookupQuery, variables: { teamId } }),
    });
    type LookupResp = { data?: { team?: { labels: { nodes: Array<{ id: string; name: string }> } } } };
    const lookupData = (await lookupRes.json()) as LookupResp;
    const existing = (lookupData.data?.team?.labels?.nodes ?? []).find(
      (n) => n.name === labelName,
    );
    if (existing) return existing.id;
  } catch (err) {
    log.error(`review: label lookup failed for ${labelName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // Create
  const createMutation = `
    mutation CreateLabel($teamId: String!, $name: String!, $color: String!) {
      issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
        success
        issueLabel { id }
      }
    }
  `;
  try {
    const createRes = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({
        query: createMutation,
        variables: { teamId, name: labelName, color: "#94a3b8" },
      }),
    });
    type CreateResp = {
      data?: { issueLabelCreate?: { success: boolean; issueLabel?: { id: string } } };
    };
    const createData = (await createRes.json()) as CreateResp;
    const result = createData.data?.issueLabelCreate;
    if (result?.success && result.issueLabel) {
      log.info(`review: created label '${labelName}' in team ${teamId}`);
      return result.issueLabel.id;
    }
    return null;
  } catch (err) {
    log.error(`review: label creation failed for ${labelName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Atomically swap labels on an issue.
 */
async function issueUpdateLabels(
  internalId: string,
  labelIds: string[],
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation ReviewTransition($issueId: String!, $labelIds: [String!]!) {
      issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
        success
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: internalId, labelIds } }),
    });
    type Resp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    if (!data.data?.issueUpdate?.success) {
      log.warn(`review: issueUpdate returned non-success for ${internalId}`);
      return false;
    }
    return true;
  } catch (err) {
    log.error(`review: issueUpdate failed for ${internalId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Post a comment on an issue.
 */
async function postComment(
  issueInternalId: string,
  body: string,
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId: issueInternalId, body } }),
    });
    type Resp = { data?: { commentCreate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    return data.data?.commentCreate?.success ?? false;
  } catch (err) {
    log.error(`review: comment post failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Evaluate the parent-AC gate for a ticket in `review` state.
 *
 * The F2b fix (§5.6): the parent's → done transition is gated on the **parent's
 * own** AC, not the sum of its children. This function fetches the parent's
 * description, parses the AC checklist, and verifies all items are checked.
 *
 * AC3: → done is gated on the parent's own AC being satisfied.
 */
export async function evaluateParentAcGate(
  parentIdentifier: string,
  authToken: string,
): Promise<ParentAcGateResult> {
  const description = await fetchIssueDescription(parentIdentifier, authToken);
  const items = parseAcChecklist(description);
  const { satisfied, reason } = evaluateAcGate(items);

  log.info(
    `review: parent-AC gate for ${parentIdentifier}: ${satisfied ? "PASSED" : "FAILED"} — ${reason}`,
  );

  return {
    satisfied,
    parentIdentifier,
    reason,
    checklist: items.length > 0 ? items : undefined,
  };
}

/**
 * Attempt the `review → done` disposition.
 *
 * AC3: The → done transition is gated on the parent's own AC being satisfied.
 * If the AC gate fails, the transition is blocked and a diagnostic comment
 * is posted on the issue explaining which ACs are unmet.
 *
 * If the AC gate passes:
 *   1. Atomically swap state:review → state:done.
 *   2. Post a disposition summary comment.
 *
 * Returns the result of the disposition attempt.
 */
export async function dispositionToDone(
  parentIdentifier: string,
  authToken: string,
): Promise<DispositionResult> {
  const result: DispositionResult = {
    applied: false,
    targetState: "done",
    parentIdentifier,
  };

  // 1. Evaluate the parent-AC gate (§5.6 F2b)
  const acGate = await evaluateParentAcGate(parentIdentifier, authToken);
  if (!acGate.satisfied) {
    result.error = `Parent-AC gate failed: ${acGate.reason}`;
    log.info(`review: → done blocked for ${parentIdentifier}: AC gate not satisfied`);

    // Post diagnostic comment
    const internalId = await resolveInternalId(parentIdentifier, authToken);
    if (internalId) {
      await postComment(
        internalId,
        `[Disposition Gate] Cannot advance to **done** — parent AC not satisfied.\n\n${acGate.reason}\n\nResolve the unchecked items and retry \`approve\`.`,
        authToken,
      );
    }
    return result;
  }

  // 2. Fetch children for the summary comment
  const children = await fetchChildren(parentIdentifier, authToken);

  // 3. Atomically swap state:review → state:done
  const issue = await fetchIssueWithLabels(parentIdentifier, authToken);
  if (!issue) {
    result.error = "Failed to fetch issue labels";
    return result;
  }

  const reviewLabel = issue.labels.find((l) => l.name === "state:review");
  if (!reviewLabel) {
    result.error = "No state:review label found on issue";
    return result;
  }

  const doneLabelId = await findOrCreateLabel(issue.teamId, "state:done", authToken);
  if (!doneLabelId) {
    result.error = "Failed to resolve state:done label";
    return result;
  }

  const newLabelIds = [
    ...issue.labels.filter((l) => l.id !== reviewLabel.id).map((l) => l.id),
    doneLabelId,
  ];

  const updated = await issueUpdateLabels(issue.internalId, newLabelIds, authToken);
  if (!updated) {
    result.error = "Label swap mutation returned non-success";
    return result;
  }

  // 4. Post disposition summary comment
  const childSummary = children.length > 0
    ? children.map((c) => `- ${c.identifier}: ${c.workflowState ?? "unknown"}`).join("\n")
    : "No children";
  const commentBody =
    `[Disposition] Parent AC satisfied — advancing review → done.\n\n` +
    `**AC gate:** ${acGate.reason}\n\n` +
    `**Children:**\n${childSummary}`;
  await postComment(issue.internalId, commentBody, authToken);

  result.applied = true;
  log.info(`review: ${parentIdentifier} review → done (parent AC satisfied)`);
  return result;
}

/**
 * Attempt the `review → spawning` disposition for follow-up gaps.
 *
 * AC2: From review, the researcher can disposition → spawning to create
 * follow-up children for gaps found during review. Re-enters the spawning
 * state so the fan-out engine can mint supplementary dev-impl tickets.
 *
 * Steps:
 *   1. Atomically swap state:review → state:spawning.
 *   2. Post a disposition comment noting the follow-up.
 *
 * The fan-out engine will trigger on the spawning transition as before.
 */
export async function dispositionToSpawning(
  parentIdentifier: string,
  authToken: string,
): Promise<DispositionResult> {
  const result: DispositionResult = {
    applied: false,
    targetState: "spawning",
    parentIdentifier,
  };

  const issue = await fetchIssueWithLabels(parentIdentifier, authToken);
  if (!issue) {
    result.error = "Failed to fetch issue labels";
    return result;
  }

  const reviewLabel = issue.labels.find((l) => l.name === "state:review");
  if (!reviewLabel) {
    result.error = "No state:review label found on issue";
    return result;
  }

  const spawningLabelId = await findOrCreateLabel(issue.teamId, "state:spawning", authToken);
  if (!spawningLabelId) {
    result.error = "Failed to resolve state:spawning label";
    return result;
  }

  const newLabelIds = [
    ...issue.labels.filter((l) => l.id !== reviewLabel.id).map((l) => l.id),
    spawningLabelId,
  ];

  const updated = await issueUpdateLabels(issue.internalId, newLabelIds, authToken);
  if (!updated) {
    result.error = "Label swap mutation returned non-success";
    return result;
  }

  // Post disposition comment
  await postComment(
    issue.internalId,
    `[Disposition] Researcher identified gaps — routing review → spawning for follow-up children.`,
    authToken,
  );

  result.applied = true;
  log.info(`review: ${parentIdentifier} review → spawning (follow-up gaps)`);
  return result;
}

/**
 * Determine if the disposition should trigger for a given workflow + state + command.
 * Returns the target disposition state, or null if not a review disposition.
 */
export function resolveDisposition(
  workflowId: string,
  currentState: string,
  intent: string,
): "done" | "spawning" | null {
  if (workflowId !== "ux-audit") return null;
  if (currentState !== "review") return null;

  if (intent === "approve") return "done";
  if (intent === "request-rework") return "spawning";

  return null;
}
