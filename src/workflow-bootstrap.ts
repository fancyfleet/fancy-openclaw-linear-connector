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
import { loadWorkflowRegistry, type WorkflowDef } from "./workflow-gate.js";
import { resolveBodiesForRole } from "./escalation-gate.js";
import { findOrCreateLabel, postComment } from "./linear-helpers.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import type { LinearEvent, LinearIssueCreatedEvent, LinearIssueUpdatedEvent } from "./webhook/schema.js";
import { getAgents, getAccessToken } from "./agents.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "workflow-bootstrap");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * INF-552: sentinel label for the CLI authoring path.
 *
 * `linear create --workflow <id>` cannot attach a `wf:<id>` label directly: an
 * agent OAuth actor token cannot create IssueLabels, so an unregistered (or
 * simply not-yet-provisioned) `wf:<id>` fails opaquely at the CLI with a 400 and
 * the id never reaches the engine's registry validation. Instead the CLI
 * attaches this single, pre-provisioned, taxonomy-free sentinel and carries the
 * verbatim requested id in a description marker (below). The engine — the sole
 * registry holder — resolves the real id here, then swaps the sentinel for the
 * concrete `wf:<id>` label (registered) or loudly rejects it (unregistered).
 *
 * The sentinel encodes no workflow taxonomy — it means only "a workflow was
 * requested and is pending engine resolution" — so keeping it out of the CLI's
 * knowledge and pre-provisioning it once is not the label-existence-as-registry
 * anti-pattern that a per-workflow `wf:<id>` allowlist would be.
 */
export const WF_PENDING_LABEL = "wf:pending";

/**
 * INF-552: structured marker the CLI writes into a ticket's description to carry
 * the verbatim requested workflow id to the engine alongside the `wf:pending`
 * sentinel. An HTML comment so it is invisible in rendered Markdown. The id is
 * matched verbatim (no case-folding) — the engine matches it against the
 * registry exactly, mirroring the CLI's verbatim-preservation contract.
 */
const WORKFLOW_REQUEST_MARKER_RE = /<!--\s*openclaw:workflow-request\s+id="([^"]*)"\s*-->/;

/**
 * Extract the requested workflow id from a `wf:pending` ticket's description.
 * Returns the trimmed id, or null when no marker is present or the id is empty.
 */
export function parseWorkflowRequestMarker(description: string | undefined | null): string | null {
  if (!description) return null;
  const m = description.match(WORKFLOW_REQUEST_MARKER_RE);
  if (!m) return null;
  const id = m[1].trim();
  return id.length > 0 ? id : null;
}

/**
 * INF-594: workflow id for the non-code `task` workflow. `task` has no
 * merge-gate and no deploy state, so a code-fix mis-routed here dead-ends at
 * review-approved with no verb to engage merge (Hanzo) or deploy — the
 * INF-585 class. `dev-impl` is the workflow with code-review → merge-gate →
 * deploy built in, so code changes belong there.
 */
const TASK_WORKFLOW_ID = "task";

/**
 * INF-1023: the code workflow. `wf:task` is Design-scoped and has no code-review
 * gate; when the intake guardrail (below) detects code signals on a `wf:task`
 * request, it redirects the ticket here — the track with code-review → merge →
 * deploy built in — rather than admitting a code fix to a Design-only track.
 */
const DEV_IMPL_WORKFLOW_ID = "dev-impl";

/**
 * INF-594 / INF-1023: signals that a ticket's text describes a code change. The
 * original INF-594 set — a GitHub PR URL, a "PR #123" mention, an inline "pull
 * request" phrase, or a conventional git branch name — is extended by INF-1023
 * with three more fingerprints called out in the AC of record: a unified diff
 * header, a source-file path, and an explicit `engineering-domain:` marker. Any
 * one of these on a `wf:task` intake is the fingerprint of a request that must
 * run through `dev-impl`, not the Design track.
 *
 * The extension list is deliberately conservative about extensions (backend/code
 * source suffixes only — no css/html/scss/png/jpg/svg) so ordinary design/media
 * asks referencing an asset file never trip the guardrail (INF-1023 AC3).
 */
const PR_URL_RE = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;
const PR_HASH_RE = /\bPR\s*#?\d+\b/i;
const PULL_REQUEST_RE = /\bpull request\b/i;
// INF-1023: a unified-diff header ("diff --git a/… b/…").
const DIFF_RE = /(?:^|\n)\s*diff --git\s+/;
// INF-1023: a source-file path ("src/workflow-bootstrap.ts", "a/src/foo.py").
const SOURCE_PATH_RE =
  /\b[\w.-]+\/[\w./-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|sh|sql|ya?ml|json|toml)\b/i;
// INF-1023: an explicit engineering-domain marker ("engineering-domain: backend").
const ENG_DOMAIN_MARKER_RE = /\bengineering-domain\s*:/i;
const BRANCH_NAME_RE = /\b(?:feature|fix|bugfix|hotfix|chore|refactor)\/[A-Za-z0-9._-]+/;

/**
 * INF-594 / INF-1023: true when the ticket's title/description references a code
 * change — a PR, branch, unified diff, source path, or engineering-domain marker.
 * Used to catch code fixes mis-routed into the `task` workflow (INF-585 dead-end
 * class) and, per INF-1023, to redirect them off the Design track at intake.
 */
export function referencesCodeChange(title?: string | null, description?: string | null): boolean {
  const text = `${title ?? ""}\n${description ?? ""}`;
  return (
    PR_URL_RE.test(text) ||
    PR_HASH_RE.test(text) ||
    PULL_REQUEST_RE.test(text) ||
    DIFF_RE.test(text) ||
    SOURCE_PATH_RE.test(text) ||
    ENG_DOMAIN_MARKER_RE.test(text) ||
    BRANCH_NAME_RE.test(text)
  );
}

// ── Public result type ────────────────────────────────────────────────────────

export interface BootstrapResult {
  action: "bootstrapped" | "demoted" | "rejected";
  workflowId?: string;
  entryState?: string;
  /** OpenClaw agent name of the newly-set delegate (bootstrapped only). */
  delegateAgentName?: string;
  /** Ticket identifier for wake delivery (bootstrapped only). */
  ticketIdentifier?: string;
  /** Ticket title for wake delivery (bootstrapped only). */
  ticketTitle?: string;
  /** Human-readable reason (rejected only). */
  rejectionReason?: string;
}

// ── Agents loader ─────────────────────────────────────────────────────────────

async function loadAgents(): Promise<Array<{ name: string; linearUserId?: string }>> {
  const filePath = process.env.AGENTS_PATH ?? path.resolve(process.cwd(), "agents.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw) as { agents?: Array<{ name: string; linearUserId?: string }> };
    return data.agents ?? [];
  } catch {
    return [];
  }
}

// ── Linear API helpers ────────────────────────────────────────────────────────

/** Issue context used by both the webhook bootstrap and the reconciliation sweep. */
export interface IssueContext {
  id: string;
  teamId: string;
  identifier: string;
  title: string;
  labels: Array<{ id: string; name: string }>;
  /**
   * INF-552: Linear user ID of the issue creator ("requester"). Used to bounce
   * an unregistered-workflow authoring attempt back to whoever filed it. Absent
   * when the creator could not be resolved from the API.
   */
  creatorId?: string;
  /**
   * INF-552: issue description — carries the `wf:pending` authoring marker that
   * names the requested workflow id. Absent when not fetched (older callers).
   */
  description?: string | null;
}

/** Re-export so callers (sweep) can import from a single module. */
export type { WorkflowDef };

/**
 * Fetch an issue's current context (labels, team, identifier) from Linear.
 *
 * Shared by the webhook bootstrap path and the reconciliation sweep — the
 * sweep uses this for the idempotency re-fetch before healing a ticket.
 */
export async function fetchIssueContext(issueId: string, authToken: string): Promise<IssueContext | null> {
  const query = `
    query IssueWithLabels($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        team { id }
        labels { nodes { id name } }
        delegate { id }
        creator { id }
        description
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = {
      data?: {
        issue?: {
          id: string;
          identifier: string;
          title: string;
          team: { id: string };
          labels: { nodes: Array<{ id: string; name: string }> };
          delegate: { id: string } | null;
          creator: { id: string } | null;
          description: string | null;
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;
    return {
      id: issue.id,
      teamId: issue.team.id,
      identifier: issue.identifier,
      title: issue.title,
      labels: issue.labels.nodes,
      creatorId: issue.creator?.id,
      description: issue.description,
    };
  } catch {
    return null;
  }
}

/**
 * Atomically apply label IDs (+ optional delegate) to an issue.
 *
 * Shared primitive — used by both the webhook bootstrap and the sweep.
 */
export async function issueUpdateAtomic(
  internalId: string,
  labelIds: string[],
  authToken: string,
  delegateId?: string | null,
  assigneeId?: string | null,
): Promise<boolean> {
  const hasDelegate = delegateId !== undefined;
  const hasAssignee = assigneeId !== undefined;
  const inputParts: string[] = ["labelIds: $labelIds"];
  if (hasDelegate) inputParts.push("delegateId: $delegateId");
  if (hasAssignee) inputParts.push("assigneeId: $assigneeId");

  const varDecls = [
    "$issueId: String!",
    "$labelIds: [String!]!",
    ...(hasDelegate ? ["$delegateId: String"] : []),
    ...(hasAssignee ? ["$assigneeId: String"] : []),
  ];

  const mutation = `
    mutation ApplyAtomicTransition(${varDecls.join(", ")}) {
      issueUpdate(id: $issueId, input: { ${inputParts.join(", ")} }) {
        success
      }
    }
  `;
  const variables: Record<string, unknown> = { issueId: internalId, labelIds };
  if (hasDelegate) variables.delegateId = delegateId;
  if (hasAssignee) variables.assigneeId = assigneeId;

  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables }),
    });
    type Resp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    return data.data?.issueUpdate?.success ?? false;
  } catch {
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
export async function maybeBootstrapWorkflow(
  event: LinearEvent,
  authToken: string,
  enrolledTicketsStore?: EnrolledTicketsStore,
): Promise<BootstrapResult | null> {
  if (event.type !== "Issue" || (event.action !== "update" && event.action !== "create")) return null;
  // For create events updatedFrom is absent — previousLabelIds will be [] and all current labels
  // are treated as "added", which is exactly what we want for pre-attached wf: labels.
  const issueEvent = event as LinearIssueUpdatedEvent | LinearIssueCreatedEvent;

  const currentLabelIds: string[] = issueEvent.data.labelIds ?? [];
  const updatedFrom = (issueEvent as LinearIssueUpdatedEvent).updatedFrom as Record<string, unknown> | undefined;
  const previousLabelIds: string[] = (updatedFrom?.labelIds as string[] | undefined) ?? [];

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
  let issue: IssueContext | null = null;
  let effectiveToken = authToken; // may be replaced by a fallback token
  const triedTokens: string[] = [];
  const tryFetch = async (token: string) => {
    triedTokens.push(token.slice(0, 8) + "...");
    return fetchIssueContext(issueEvent.data.id, token);
  };
  try {
    issue = await tryFetch(authToken);
  } catch {
    /* fall through to fallback */
  }
  if (!issue) {
    // Fallback: try other agent tokens that may have access to this issue's team.
    try {
      const agents = getAgents();
      for (const a of agents) {
        const t = getAccessToken(a.name);
        if (!t || t === authToken) continue; // skip the one we already tried
        try {
          issue = await tryFetch(t);
          if (issue) {
            effectiveToken = t;
            break;
          }
        } catch {
          continue;
        }
      }
    } catch {
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
    if (currentStateLabels.length > 0) return null;

    return applyBootstrapToIssue(issue, effectiveToken, undefined, enrolledTicketsStore);
  }

  // ── Demote path: wf:* was removed, state:* labels remain ─────────────────
  if (removedIds.length > 0 && !currentWfLabelNode && currentStateLabels.length > 0) {
    const stateLabelIds = new Set(currentStateLabels.map((n) => n.id));
    const newLabelIds = currentLabelIds.filter((id) => !stateLabelIds.has(id));

    await issueUpdateAtomic(issue.id, newLabelIds, effectiveToken);

    log.info(
      `workflow-bootstrap: demoted ${issueEvent.data.id} — removed [${currentStateLabels.map((n) => n.name).join(", ")}]`,
    );
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
export async function applyBootstrapToIssue(
  issue: IssueContext,
  authToken: string,
  /** Optional registry override (used by the sweep). If absent, loads from file. */
  workflowRegistryOverride?: Map<string, WorkflowDef>,
  /** AI-1799: optional mirror store — writes enrollment rows for board data. */
  enrolledTicketsStore?: EnrolledTicketsStore,
): Promise<BootstrapResult | null> {
  // Defensive idempotency re-check — handles the webhook/sweep race.
  const currentStateLabels = issue.labels.filter((n) => n.name.startsWith("state:"));
  if (currentStateLabels.length > 0) return null;

  const wfLabelNode = issue.labels.find((n) => n.name.startsWith("wf:"));
  if (!wfLabelNode) return null;

  // INF-552: two authoring shapes converge here.
  //   1. A concrete `wf:<id>` label (dev-sprint fanout children, Linear UI) —
  //      the id is the label suffix, as before.
  //   2. The `wf:pending` CLI sentinel — the concrete id lives in a description
  //      marker because the CLI cannot create a `wf:<id>` label. Resolve it and
  //      remember the sentinel's label id so we can swap it for the real one on
  //      enrollment. A `wf:pending` with no readable marker is a malformed
  //      authoring attempt: reject it loudly (never silently strand).
  let workflowId: string;
  let pendingSentinelLabelId: string | undefined;
  if (wfLabelNode.name === WF_PENDING_LABEL) {
    pendingSentinelLabelId = wfLabelNode.id;
    const requested = parseWorkflowRequestMarker(issue.description);
    if (!requested) {
      log.warn(
        `workflow-bootstrap: ${issue.identifier ?? issue.id} carries ${WF_PENDING_LABEL} but no readable ` +
          `workflow-request marker — rejecting as a malformed authoring attempt`,
      );
      return rejectUnregisteredWorkflow(
        issue,
        "pending",
        authToken,
        `workflow authoring failed — the ${WF_PENDING_LABEL} sentinel is present but no workflow-request marker was found in the description`,
      );
    }
    workflowId = requested;
  } else {
    workflowId = wfLabelNode.name.slice("wf:".length);
  }

  // INF-1023: wf:task intake guardrail (parent decision INF-1022, fix #2a).
  // `wf:task` is Design-scoped — its routing/review states resolve only to the
  // Design head, so a code/PR-bearing request mis-filed onto it can never reach a
  // code reviewer and deadlocks (repro: INF-995). Detect code signals at intake
  // and redirect the ticket to `dev-impl` (code-review → merge → deploy built in)
  // instead of admitting it to the Design track. This is the loud, non-dropping
  // redirect: the ticket lands on `dev-impl` at its entry state with wf:task
  // swapped for wf:dev-impl below — it never enters `routing` on `wf:task`, and
  // no Eng-head route is added inside `task` (AC5; fix #2b rejected in INF-1022).
  // Supersedes the INF-594 advisory nudge, which only suggested dev-impl while
  // still letting the code fix into `task`.
  let redirectedFromLabelId: string | undefined;
  if (workflowId === TASK_WORKFLOW_ID && referencesCodeChange(issue.title, issue.description)) {
    log.info(
      `workflow-bootstrap: INF-1023 guardrail — ${issue.identifier ?? issue.id} carries code signals on ` +
        `wf:task; redirecting to dev-impl (the Design track has no code-review gate)`,
    );
    redirectedFromLabelId = wfLabelNode.id;
    workflowId = DEV_IMPL_WORKFLOW_ID;
  }

  let registry: Map<string, WorkflowDef>;
  if (workflowRegistryOverride) {
    registry = workflowRegistryOverride;
  } else {
    try {
      registry = await loadWorkflowRegistry();
    } catch (err) {
      log.warn(
        `workflow-bootstrap: failed to load registry for '${workflowId}': ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  const def = registry.get(workflowId);
  // INF-552: an unregistered workflow id is a loud rejection, not a silent
  // strand. Previously this returned null, leaving the ticket with a wf:* label
  // and no state:* — invisible limbo (fails canon 8). Now we bounce it back to
  // the requester with a named reason so a human/sweep actually sees it. This is
  // the "reject unregistered ids loudly" half of the engine primitive; the
  // entry-state instantiation below is the already-general registered half.
  if (!def) {
    return rejectUnregisteredWorkflow(issue, workflowId, authToken);
  }
  // A registered-but-malformed def (no entry_state) still fails safe as a skip —
  // that is a registry authoring defect, not an unregistered-id authoring attempt.
  if (!def.entry_state) {
    log.warn(`workflow-bootstrap: def for '${workflowId}' has no entry_state — skipping bootstrap`);
    return null;
  }

  const entryState = def.entry_state;
  const entryStateDef = def.states.find((s) => s.id === entryState);

  // Resolve first-owner delegate from capability policy.
  let delegateLinearUserId: string | undefined;
  let delegateAgentName: string | undefined;
  let delegateRole = entryStateDef?.owner_role;
  if (delegateRole) {
    try {
      let bodies = await resolveBodiesForRole(delegateRole);
      // If the entry role has no bodies (e.g. synthetic "engine" role),
      // look ahead to the first transition target's owner_role.
      if (bodies.length === 0 && (entryStateDef as { transitions?: Array<{ to: string }> })?.transitions?.length) {
        const firstTransTarget = def.states.find(
          (s) => s.id === (entryStateDef as { transitions?: Array<{ to: string }> }).transitions![0].to,
        );
        const nextRole = firstTransTarget?.owner_role;
        if (nextRole && nextRole !== delegateRole) {
          bodies = await resolveBodiesForRole(nextRole);
          if (bodies.length > 0) delegateRole = nextRole;
        }
      }
      if (bodies.length === 1) {
        delegateAgentName = bodies[0];
        const agents = await loadAgents();
        const agent = agents.find((a) => a.name === delegateAgentName);
        if (agent?.linearUserId) {
          delegateLinearUserId = agent.linearUserId;
        } else {
          log.warn(`workflow-bootstrap: body '${delegateAgentName}' has no linearUserId — delegate not set`);
        }
      }
    } catch (err) {
      log.warn(
        `workflow-bootstrap: role resolution failed for '${delegateRole}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Find or create the entry state label.
  const stateLabelId = await findOrCreateLabel(issue.teamId, `state:${entryState}`, authToken);
  if (!stateLabelId) {
    log.warn(`workflow-bootstrap: could not resolve label 'state:${entryState}' — aborting bootstrap`);
    return null;
  }

  // Swap the source wf:* label for the concrete target `wf:<id>` label when the
  // workflow id changed after label resolution. Two paths reach here:
  //   - INF-552 `wf:pending` sentinel authoring: the sentinel is replaced by the
  //     resolved `wf:<id>`.
  //   - INF-1023 task→dev-impl redirect: the `wf:task` label is replaced by
  //     `wf:dev-impl` so the ticket no longer carries the Design track.
  // The engine CAN create labels (unlike the CLI's agent OAuth token), so this is
  // where the real `wf:<id>` first materializes — find-or-create so a registered
  // workflow enrolls even on a team that has never used it. Drop the old label id
  // so the ticket is left cleanly managed under the single correct workflow.
  const currentLabelIds = issue.labels.map((l) => l.id);
  let baseLabelIds = currentLabelIds;
  const labelToSwapOutId = pendingSentinelLabelId ?? redirectedFromLabelId;
  if (labelToSwapOutId) {
    const wfLabelId = await findOrCreateLabel(issue.teamId, `wf:${workflowId}`, authToken);
    if (!wfLabelId) {
      log.warn(`workflow-bootstrap: could not resolve label 'wf:${workflowId}' — aborting bootstrap`);
      return null;
    }
    baseLabelIds = currentLabelIds.filter((id) => id !== labelToSwapOutId).concat(wfLabelId);
  }
  const newLabelIds = Array.from(new Set([...baseLabelIds, stateLabelId]));
  const success = await issueUpdateAtomic(issue.id, newLabelIds, authToken, delegateLinearUserId);

  if (!success) {
    log.warn(`workflow-bootstrap: issueUpdate returned non-success for ${issue.id}`);
  } else {
    log.info(
      `workflow-bootstrap: bootstrapped ${issue.id} → ${workflowId}:${entryState}, delegate=${delegateLinearUserId ?? "none"}`,
    );
    // AI-1799: write enrollment row to the mirror so the board read API has data.
    // INF-268: auto-bind designated_approver = Ai for sprint-spawner workflows so
    // the determining-scope:propose-brief signoff gate can resolve the approver
    // without circular error (the steward — Astrid — cannot self-approve).
    enrolledTicketsStore?.enroll({
      ticketId: issue.identifier ?? issue.id,
      workflow: workflowId,
      state: entryState,
      delegate: delegateAgentName ?? null,
      designatedApprover: workflowId === 'sprint-spawner' ? 'ai' : undefined,
      // INF-441: sprint-spawner children always mint to 'To Do' (state:todo)
      // instead of Backlog (state:intake) to ensure they are dispatched.
      entryStateLabel: workflowId === 'sprint-spawner' ? 'state:todo' : undefined,
    });

    // INF-594's advisory routing lint (a nudge posted while still admitting the
    // code fix to `task`) is superseded by the INF-1023 intake guardrail above,
    // which redirects code-signaled `wf:task` requests to `dev-impl` before they
    // ever bootstrap into the Design track. There is nothing left to nudge here.
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

/**
 * INF-552: loud rejection of an authoring attempt that named an unregistered
 * workflow id.
 *
 * The registry is the single source of truth for what workflows exist, so the
 * engine — not the CLI — decides whether a `wf:<id>` label resolves. When it
 * does not, this replaces the old silent strand (wf:* present, no state:* ever
 * stamped) with a rejection that leaves an auditable trail:
 *   - strip the wf:* / state:* limbo labels so the ticket is plain ad-hoc again,
 *   - bounce it to the requester (assignee = creator, delegate cleared) so a
 *     human's queue surfaces it,
 *   - post a named-reason comment.
 *
 * Never throws — mutation/comment failures are absorbed by the underlying
 * helpers and logged; the caller still gets a "rejected" result.
 */
async function rejectUnregisteredWorkflow(
  issue: IssueContext,
  workflowId: string,
  authToken: string,
  /**
   * INF-552: optional reason override for the sentinel authoring path, where a
   * `wf:pending` ticket carries no readable marker — "unknown workflow" would be
   * misleading there. Defaults to the registry-miss phrasing.
   */
  reasonOverride?: string,
): Promise<BootstrapResult> {
  const reason = reasonOverride ?? `unknown workflow '${workflowId}' — not registered`;

  // Drop every wf:* and state:* label — the authoring attempt leaves no managed
  // limbo behind; what remains is a plain, ad-hoc ticket.
  const strippedLabelIds = issue.labels
    .filter((l) => !l.name.startsWith("wf:") && !l.name.startsWith("state:"))
    .map((l) => l.id);

  // assigneeId = creator returns the ticket to whoever filed it (assignee means
  // "a human must act"); delegateId: null clears any agent-ownership limbo. Only
  // set assignee when the creator was resolvable — otherwise leave it untouched.
  const assigneeId = issue.creatorId ?? undefined;
  await issueUpdateAtomic(issue.id, strippedLabelIds, authToken, null, assigneeId);
  await postComment(issue.id, reason, authToken);

  log.warn(
    `workflow-bootstrap: rejected ${issue.identifier ?? issue.id} — ${reason}; ` +
      `bounced to requester (${issue.creatorId ?? "unknown"})`,
  );

  return {
    action: "rejected",
    workflowId,
    ticketIdentifier: issue.identifier,
    ticketTitle: issue.title,
    rejectionReason: reason,
  };
}
