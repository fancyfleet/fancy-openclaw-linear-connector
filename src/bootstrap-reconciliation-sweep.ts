/**
 * AI-1775 — Bootstrap reconciliation sweep.
 *
 * A periodic safety net that finds governed-intent tickets (wf:* label) that
 * never enrolled (no state:* label) past a configurable grace window and heals
 * them using the same bootstrap core as the webhook path
 * (`applyBootstrapToIssue` in workflow-bootstrap.ts).
 *
 * Problem solved: if Linear drops the Issue-update webhook, a wf:* label sits
 * on a ticket with no state:* label, no delegate, and no alert — the ticket is
 * permanently dark. The sweep detects and recovers this.
 *
 * Design notes:
 *   - Query: batch Linear search for wf:* labeled tickets, filter client-side
 *     for no state:* label and past grace window.
 *   - Heal (Pass 1 — unenrolled): re-fetch issue context (idempotency) then
 *     call `applyBootstrapToIssue` — the exact same core the webhook bootstrap uses.
 *   - Heal (Pass 2 — enrolled, AI-2016 AC3): for tickets WITH state:* labels that
 *     are native-Done with merged PRs, strip wf:* and state:* labels and clear
 *     delegate so the workflow record closes.
 *   - Heal (Pass 3 — enrolled, INF-497): the mirror of Pass 2. For tickets whose
 *     workflow label is terminal-done (`state:done`) but whose native Linear state
 *     is still active (the INF-496 shape — `wf:task` + `state:done` + native `To Do`
 *     + null delegate), push the native state to the team's completed state and
 *     clear the delegate. Labels are left untouched (the workflow record is already
 *     terminal and correct) and no ticket comment is posted.
 *   - Alert: each heal emits a warning via the alert bus (`bootstrap-reconciled`).
 *   - Race-safe: the idempotency re-fetch inside the heal path prevents
 *     double-bootstrap when a late webhook lands between query and heal.
 *   - Error-tolerant: a Linear API error alerts and does not kill the loop.
 */

import { componentLogger, createLogger } from "./logger.js";
import {
  fetchIssueContext,
  applyBootstrapToIssue,
} from "./workflow-bootstrap.js";
import { loadWorkflowRegistry, type WorkflowDef } from "./workflow-gate.js";
import { isTerminalIssueState } from "./linear-actionable.js";
import { getAlertBus, type AlertBus } from "./alerts/alert-bus.js";
import { registerCron, markCronRun, formatIntervalMs } from "./cron/registry.js";
import { buildAgentMap, getLinearUserIdForAgent, getOpenclawAgentName } from "./agents.js";
import { resolveBodiesForRole } from "./escalation-gate.js";
import type { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "bootstrap-reconciliation");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * INF-719: page size for the paginated wf:* sweep. Linear caps an unpaginated
 * `issues()` query at 50 nodes, which blinded this sweep to ~80% of the board
 * once 250+ wf:*-enrolled tickets went live. Mirrors the proven cursor loop in
 * delegation-reconciliation-sweep.ts (LINEAR_ISSUES_PAGE_SIZE = 50).
 */
const LINEAR_ISSUES_PAGE_SIZE = 50;

/** Default grace window: a ticket younger than this is given time for the
 *  Issue-update webhook to arrive naturally. */
const DEFAULT_GRACE_WINDOW_MS = 2 * 60 * 1000; // 2 min

/** Default sweep cadence (if registered via the cron helper). */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReconciliationSweepOptions {
  authToken: string | (() => string);
  /** Optional workflow registry override. If absent, the core loads from file. */
  workflowRegistry?: Map<string, WorkflowDef>;
  /** Grace window in ms. Tickets younger than this are skipped. Default 2 min. */
  graceWindowMs?: number;
  /** Override for `Date.now()` — used in tests for deterministic timing. */
  nowMs?: number;
  /** Alert bus for heal/failure notifications. */
  alertBus?: AlertBus;
  /** Called to wake the first-owner delegate after a successful heal. */
  wakeFn?: (agentName: string, ticketIdentifier: string) => Promise<void>;
  /** Dispatch ack tracker used by the watchdog/reconciliation backstop. */
  dispatchAckTracker?: DispatchAckTracker;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /**
   * INF-739 Mode 1: resolve the body ids that fill a workflow role. Defaults to
   * the capability-policy-backed `resolveBodiesForRole`. Injectable so the
   * Mode-1 auto-seat pass is testable without a live capability policy.
   */
  resolveBodiesForRole?: (roleId: string) => Promise<string[]>;
  /**
   * INF-739 Mode 1: resolve a body id → its Linear user id (the value written to
   * `delegateId`). Defaults to `getLinearUserIdForAgent`.
   */
  linearUserIdForBody?: (bodyId: string) => string | undefined;
  /**
   * INF-739 Mode 1: resolve a body id → the OpenClaw agent name used to route a
   * wake to the newly-seated owner. Defaults to `getOpenclawAgentName`.
   */
  openclawNameForBody?: (bodyId: string) => string;
}

export interface ReconciliationSweepResult {
  /** Total unenrolled tickets returned by the query. */
  scanned: number;
  /** Tickets successfully healed (bootstrap applied). */
  healed: number;
  /** Tickets within the grace window (skipped, not healed). */
  withinGrace: number;
  /**
   * INF-739 Mode 1: actionable null-delegate tickets on which the sweep
   * auto-seated the current state's role owner. Distinct from `healed`
   * (native-state reconciliation) so the two correction modes stay countable.
   */
  seated: number;
  /** Non-fatal errors encountered during the sweep. */
  errors: string[];
}

// ── Enrolled-ticket helpers (AI-2016 AC3) ────────────────────────────────────

interface EnrolledTicketNativeState {
  state: { id: string; name: string; type: string } | null;
  delegate: { id: string } | null;
}

type ReconciliationCandidate = {
  id: string;
  identifier: string;
  updatedAt: string;
  labels: Array<{ id: string; name: string }>;
  delegateId: string | null;
  teamId: string;
  /** INF-608: native Linear state, for the native-terminality guard (symmetric to INF-584). */
  nativeState?: { name?: string; type?: string } | null;
};

function workflowDefForLabel(registry: Map<string, WorkflowDef> | undefined, workflowLabel: string): WorkflowDef | undefined {
  if (!registry) return undefined;
  return registry.get(workflowLabel) ?? registry.get(workflowLabel.replace(/^wf:/, ""));
}

function isActionableWorkflowLabelState(
  registry: Map<string, WorkflowDef> | undefined,
  workflowLabel: string,
  stateLabel: string,
): boolean {
  const def = workflowDefForLabel(registry, workflowLabel);
  const state = def?.states.find((s) => s.id === stateLabel.replace(/^state:/, ""));
  return Boolean(state?.owner_role && state.kind !== "terminal");
}

function hasDispatchRecord(ackTracker: DispatchAckTracker, agentName: string, ticketIdentifier: string): boolean {
  return ackTracker
    .listFiltered({ agentId: agentName, limit: 1000 })
    .some((entry) => entry.ticketId === `linear-${ticketIdentifier}` || entry.ticketId === ticketIdentifier);
}

async function loadDispatchWorkflowRegistry(
  opts: ReconciliationSweepOptions,
  wakeFn: ReconciliationSweepOptions["wakeFn"],
): Promise<Map<string, WorkflowDef> | undefined> {
  if (opts.workflowRegistry) return opts.workflowRegistry;
  if (!opts.dispatchAckTracker || !wakeFn) return undefined;
  try {
    return await loadWorkflowRegistry();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`bootstrap-reconciliation: could not load workflow registry for actionable dispatch pass: ${msg}`);
    return undefined;
  }
}

/**
 * Fetch native state and delegate for an enrolled ticket.
 * Uses a query name that includes "IssueContext" so test mocks can intercept it
 * without the "IssueWithLabels" exclusion.
 */
async function queryEnrolledTicketState(
  issueId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<EnrolledTicketNativeState | null> {
  const query = `
    query IssueContextSweep($id: String!) {
      issue(id: $id) {
        id
        state { id name type }
        delegate { id }
      }
    }
  `;
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = {
      data?: {
        issue?: {
          state: { id: string; name: string; type: string } | null;
          delegate: { id: string } | null;
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;
    return {
      state: issue.state,
      delegate: issue.delegate,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch PR merge status for an enrolled ticket (inline — mirrors
 * fetchBranchAndPRStatus from workflow-gate.ts but avoids the export dependency).
 */
async function queryEnrolledPRStatus(
  issueId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<{ hasMergedPR: boolean } | null> {
  const query = `
    query IssueBranchAndPR($id: String!) {
      issue(id: $id) {
        attachments {
          nodes {
            url
            sourceType
            metadata
          }
        }
      }
    }
  `;
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = {
      data?: {
        issue?: {
          attachments: { nodes: Array<{ url?: string | null; sourceType?: string | null; metadata?: Record<string, unknown> | null }> };
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.issue?.attachments?.nodes ?? [];
    const prNodes = nodes.filter((n) =>
      typeof n.url === "string" && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(n.url),
    );
    const hasMergedPR = prNodes.some((n) => {
      const meta = n.metadata ?? {};
      const status = (meta as { status?: unknown; state?: unknown }).status ?? (meta as { state?: unknown }).state;
      return typeof status === "string" && status.toLowerCase() === "merged";
    });
    return { hasMergedPR };
  } catch {
    return null;
  }
}

/**
 * Heal an enrolled ticket that is native-Done with merged PRs:
 * strip wf:* and state:* labels, clear delegate.
 *
 * Uses the injected fetchFn (not global fetch) so tests can mock it.
 * Inlines the queries rather than calling shared helpers because those
 * helpers use globalThis.fetch which the mock cannot intercept.
 */
async function closeEnrolledTicket(
  issueId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  // Re-fetch to get label IDs for stripping (IssueWithLabels query)
  const labelsQuery = `
    query IssueWithLabelsForClose($id: String!) {
      issue(id: $id) {
        id
        identifier
        team { id }
        labels { nodes { id name } }
      }
    }
  `;
  let issueLabels: Array<{ id: string; name: string }> = [];
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: labelsQuery, variables: { id: issueId } }),
    });
    type LResp = {
      data?: { issue?: { labels: { nodes: Array<{ id: string; name: string }> } } | null };
    };
    const data = (await res.json()) as LResp;
    issueLabels = data.data?.issue?.labels?.nodes ?? [];
  } catch {
    return false;
  }

  // Filter OUT labels that start with wf:* or state:*
  const keepIds = issueLabels
    .filter((l) => !l.name.startsWith("state:") && !l.name.startsWith("wf:"))
    .map((l) => l.id);

  // Clear delegate and set remaining labels in one mutation
  const mutation = `
    mutation CloseEnrolledTicket($issueId: String!, $labelIds: [String!]!) {
      issueUpdate(id: $issueId, input: { labelIds: $labelIds, delegateId: null }) {
        success
      }
    }
  `;
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({
        query: mutation,
        variables: { issueId, labelIds: keepIds },
      }),
    });
    type MResp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as MResp;
    return data.data?.issueUpdate?.success ?? false;
  } catch {
    return false;
  }
}

/**
 * Resolve the team's completed Linear state id (INF-497).
 *
 * The `done` terminal workflow state projects to `native_state: done` — the
 * team's completed-type Linear state. When a ticket carries the terminal
 * `state:done` label but its native state was never advanced (a dropped
 * state-projection webhook), Pass 3 pushes the native state here. Prefers a
 * completed state literally named "Done"; otherwise the lowest-position
 * completed state (Linear teams virtually always have exactly one).
 *
 * Inlined query (injected fetchFn) so tests can intercept it, matching the
 * other sweep helpers.
 */
async function queryTeamCompletedStateId(
  teamId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  const query = `
    query TeamCompletedState($id: String!) {
      team(id: $id) {
        states { nodes { id name type position } }
      }
    }
  `;
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: teamId } }),
    });
    type Resp = {
      data?: {
        team?: {
          states: { nodes: Array<{ id: string; name: string; type: string; position: number }> };
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.team?.states?.nodes ?? [];
    const completed = nodes.filter((s) => s.type === "completed");
    if (completed.length === 0) return null;
    const named = completed.find((s) => s.name.trim().toLowerCase() === "done");
    if (named) return named.id;
    completed.sort((a, b) => a.position - b.position);
    return completed[0].id;
  } catch {
    return null;
  }
}

/** Terminal workflow-label prefixes: a ticket carrying one of these is
 *  lifecycle-finished and must NEVER have a delegate re-seated on it (the LSO-20
 *  bug — INF-717 fix A). Mode 1's auto-seat pass excludes them explicitly. */
const TERMINAL_STATE_LABEL_PREFIXES = ["state:done", "state:escape", "state:canceled"];

function isTerminalStateLabel(labels: Array<{ name: string }>): boolean {
  return labels.some((l) =>
    TERMINAL_STATE_LABEL_PREFIXES.some((t) => l.name.startsWith(t)),
  );
}

/**
 * INF-739 Mode 1: seat a delegate on an actionable, ownerless enrolled ticket.
 *
 * Writes only `delegateId` — it does NOT touch labels or native state (the
 * ticket is already correctly enrolled and actionable; the only defect is the
 * missing owner). Mirrors the raw `issueUpdate` delegate write the webhook
 * bootstrap path uses (INF-728 confirmed this path persists app-user delegates).
 */
async function seatRoleOwnerDelegate(
  issueId: string,
  delegateLinearUserId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const mutation = `
    mutation SeatRoleOwnerDelegate($issueId: String!, $delegateId: String!) {
      issueUpdate(id: $issueId, input: { delegateId: $delegateId }) {
        success
      }
    }
  `;
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId, delegateId: delegateLinearUserId } }),
    });
    type MResp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as MResp;
    return data.data?.issueUpdate?.success ?? false;
  } catch {
    return false;
  }
}

/**
 * Reconcile an enrolled ticket whose workflow label is terminal-done but whose
 * native Linear state is still active (INF-497 / the INF-496 shape).
 *
 * Sets native stateId → the team's completed state and clears the delegate — a
 * terminal ticket owns no agent. Does NOT touch the `state:*` / `wf:*` labels
 * (the workflow record is already terminal and correct) and posts no comment.
 */
async function reconcileTerminalNativeState(
  issueId: string,
  completedStateId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const mutation = `
    mutation ReconcileTerminalNativeState($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId, delegateId: null }) {
        success
      }
    }
  `;
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { issueId, stateId: completedStateId } }),
    });
    type MResp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as MResp;
    return data.data?.issueUpdate?.success ?? false;
  } catch {
    return false;
  }
}

// ── Sweep query ──────────────────────────────────────────────────────────────

/**
 * Query Linear for tickets that have a `wf:*` label but may not have enrolled.
 *
 * The query is intentionally broad (all wf:* labeled issues) — the sweep
 * filters client-side for the absence of `state:*` labels and the grace window.
 * Linear's API does not support a "label NOT present" filter, so we fetch and
 * filter.
 */
async function queryUnenrolledTickets(
  authToken: string,
  fetchFn: typeof fetch,
): Promise<ReconciliationCandidate[]> {
  type IssueNode = {
    id: string;
    identifier: string;
    updatedAt: string;
    labels: { nodes: Array<{ id: string; name: string }> };
    delegate: { id: string } | null;
    team: { id: string };
    state: { name: string; type: string } | null;
  };
  type Resp = {
    errors?: Array<{ message: string }>;
    data?: {
      issues?: {
        nodes: IssueNode[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    };
  };

  // INF-719: page through the full result set. An unpaginated issues() query is
  // hard-capped at 50 nodes by Linear, so any wf:* ticket beyond the first page
  // was never scanned and any desync on it was never healed (INF-717 / LSO-20).
  const nodes: IssueNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const afterArg = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
    const query = `
      query BootstrapReconciliation {
        issues(first: ${LINEAR_ISSUES_PAGE_SIZE}${afterArg}, filter: { labels: { some: { name: { startsWith: "wf:" } } } }) {
          nodes {
            id
            identifier
            updatedAt
            labels { nodes { id name } }
            delegate { id }
            team { id }
            state { name type }
            title
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query }),
    });

    const data = (await res.json()) as Resp;

    // INF-719/INF-585: fail loud on a non-2xx or a 200-with-errors response so
    // the caller's catch surfaces it — a swallowed error here would report
    // scanned:0 and silently heal nobody, the exact blindness this ticket fights.
    if (!res.ok || (data.errors && data.errors.length > 0)) {
      const detail = data.errors?.[0]?.message ?? `HTTP ${res.status}`;
      throw new Error(`BootstrapReconciliation query failed: ${detail}`);
    }

    nodes.push(...(data.data?.issues?.nodes ?? []));

    const pageInfo = data.data?.issues?.pageInfo;
    hasNextPage = pageInfo?.hasNextPage === true;
    cursor = pageInfo?.endCursor ?? null;
    if (hasNextPage && !cursor) break;
  }

  return nodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    updatedAt: n.updatedAt,
    labels: n.labels.nodes,
    delegateId: n.delegate?.id ?? null,
    teamId: n.team.id,
    nativeState: n.state ?? null,
  }));
}

// ── Main sweep ───────────────────────────────────────────────────────────────

/**
 * Run a single reconciliation sweep: query → filter → heal → alert.
 *
 * Never throws — all errors are captured in the `errors` array of the result
 * and surfaced via the alert bus.
 */
export async function runBootstrapReconciliationSweep(
  opts: ReconciliationSweepOptions,
): Promise<ReconciliationSweepResult> {
  // INF-683: resolve the token at pass time (getter) so the boot/~20h token
  // refresh can't strand a value captured at registration.
  const authToken = typeof opts.authToken === "function" ? opts.authToken() : opts.authToken;
  const graceWindowMs = opts.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  // Default to the global alert bus singleton so the prod cron path always
  // emits alerts even when the caller (index.ts) doesn't inject one.
  // Tests inject their own bus to assert alert behavior.
  const alertBus = opts.alertBus ?? getAlertBus();
  const wakeFn = opts.wakeFn;
  const workflowRegistry = await loadDispatchWorkflowRegistry(opts, wakeFn);

  const result: ReconciliationSweepResult = {
    scanned: 0,
    healed: 0,
    withinGrace: 0,
    seated: 0,
    errors: [],
  };

  // INF-739 Mode 1: injectable role/body resolvers (default to the real
  // capability-policy + agents-config backed functions) so the auto-seat pass
  // is testable without a live policy/agents.json.
  const resolveOwnerBodies = opts.resolveBodiesForRole ?? resolveBodiesForRole;
  const linearUserIdForBody = opts.linearUserIdForBody ?? getLinearUserIdForAgent;
  const openclawNameForBody = opts.openclawNameForBody ?? getOpenclawAgentName;

  // ── Query ──────────────────────────────────────────────────────────────
  let candidates: Awaited<ReturnType<typeof queryUnenrolledTickets>>;
  try {
    candidates = await queryUnenrolledTickets(authToken, fetchFn);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`query failed: ${msg}`);
    log.error(`bootstrap-reconciliation: query failed: ${msg}`);
    alertBus.notify({
      severity: "warning",
      source: "bootstrap-reconciled",
      title: `Bootstrap reconciliation sweep query failed: ${msg}`,
    });
    return result;
  }

  result.scanned = candidates.length;

  // ── Pass 1: Unenrolled tickets ────────────────────────────────────────────
  for (const ticket of candidates) {
    // INF-608: native Linear terminality wins over stale workflow labels. A
    // native-Done/Canceled ticket carrying a wf:* label but missing its state:*
    // label must NOT be re-enrolled (Done→Doing) — that is the DSN-5 loop.
    // Symmetric to INF-584's guard on the delegation sweep.
    if (isTerminalIssueState(ticket.nativeState)) {
      log.info(
        `bootstrap-reconciliation: skipping ${ticket.identifier} (Pass 1) — Linear entity is natively terminal ` +
        `(state.type='${ticket.nativeState?.type ?? "null"}', name='${ticket.nativeState?.name ?? "null"}'); ` +
        `no re-enrollment on a retired issue`,
      );
      continue;
    }

    // Filter: must have a wf:* label but NO state:* label
    const hasStateLabel = ticket.labels.some((l) => l.name.startsWith("state:"));
    if (hasStateLabel) continue; // already enrolled — handled in Pass 2

    // Filter: grace window — give the webhook time to arrive
    const updatedAtMs = new Date(ticket.updatedAt).getTime();
    const ageMs = nowMs - updatedAtMs;
    if (ageMs < graceWindowMs) {
      result.withinGrace++;
      continue;
    }

    // Heal: re-fetch fresh issue context (idempotency guard for the race where
    // a webhook landed between query and heal) then apply bootstrap via the
    // shared core.
    try {
      const issue = await fetchIssueContext(ticket.id, authToken);
      if (!issue) {
        result.errors.push(`could not re-fetch issue context for ${ticket.identifier}`);
        continue;
      }

      // Double-check idempotency on fresh data — if state:* appeared between
      // query and re-fetch, the ticket was enrolled by the webhook. Skip.
      if (issue.labels.some((l) => l.name.startsWith("state:"))) continue;

      const bootstrapResult = await applyBootstrapToIssue(
        issue,
        authToken,
        opts.workflowRegistry,
      );

      if (bootstrapResult?.action === "bootstrapped") {
        result.healed++;
        log.info(
          `bootstrap-reconciliation: healed ${ticket.identifier} → ${bootstrapResult.workflowId}:${bootstrapResult.entryState}`,
        );

        // Dispatch wake to the first-owner delegate
        if (wakeFn) {
          try {
            await wakeFn(
              bootstrapResult.delegateAgentName ?? "",
              bootstrapResult.ticketIdentifier ?? ticket.identifier,
            );
          } catch (wakeErr) {
            const wakeMsg = wakeErr instanceof Error ? wakeErr.message : String(wakeErr);
            log.warn(`bootstrap-reconciliation: wake failed for ${ticket.identifier}: ${wakeMsg}`);
          }
        }

        // Emit deduped warning alert — a heal is evidence a webhook was dropped
        alertBus.notify({
          severity: "warning",
          source: "bootstrap-reconciled",
          title: `Bootstrap reconciliation healed ${ticket.identifier}`,
          detail: {
            ticket: ticket.identifier,
            issueId: ticket.id,
            workflow: bootstrapResult.workflowId,
            entryState: bootstrapResult.entryState,
            delegate: bootstrapResult.delegateAgentName ?? null,
          },
          ticket: ticket.identifier,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`heal failed for ${ticket.identifier}: ${msg}`);
      log.error(`bootstrap-reconciliation: heal failed for ${ticket.identifier}: ${msg}`);
      alertBus.notify({
        severity: "warning",
        source: "bootstrap-reconciled",
        title: `Bootstrap reconciliation heal error for ${ticket.identifier}`,
        detail: { error: msg },
        ticket: ticket.identifier,
      });
    }
  }

  // ── Pass 2: Enrolled actionable tickets missing dispatch records (INF-570) ──
  for (const ticket of candidates) {
    // INF-608: a natively-terminal issue draws zero wakes from the bootstrap
    // sweep — an actionable-looking state:* label on a Done/Canceled ticket is
    // stale and must not re-dispatch its owner. Symmetric to INF-584.
    if (isTerminalIssueState(ticket.nativeState)) continue;

    const workflowLabel = ticket.labels.find((l) => l.name.startsWith("wf:"))?.name;
    const stateLabel = ticket.labels.find((l) => l.name.startsWith("state:"))?.name;
    if (!workflowLabel || !stateLabel || !ticket.delegateId) continue;
    if (!wakeFn || !opts.dispatchAckTracker) continue;
    if (!isActionableWorkflowLabelState(workflowRegistry, workflowLabel, stateLabel)) continue;

    const agentName = buildAgentMap()[ticket.delegateId];
    if (!agentName) continue;
    if (hasDispatchRecord(opts.dispatchAckTracker, agentName, ticket.identifier)) continue;

    try {
      await wakeFn(agentName, ticket.identifier);
      opts.dispatchAckTracker.recordDispatch(agentName, ticket.identifier);
      log.info(`bootstrap-reconciliation: dispatched missing actionable ack for ${ticket.identifier} to ${agentName}`);
    } catch (wakeErr) {
      const wakeMsg = wakeErr instanceof Error ? wakeErr.message : String(wakeErr);
      result.errors.push(`actionable dispatch failed for ${ticket.identifier}: ${wakeMsg}`);
      log.warn(`bootstrap-reconciliation: actionable dispatch failed for ${ticket.identifier}: ${wakeMsg}`);
    }
  }

  // ── Pass 3: Enrolled tickets whose native terminal state should close facets ──
  for (const ticket of candidates) {
    const hasStateLabel = ticket.labels.some((l) => l.name.startsWith("state:"));
    if (!hasStateLabel) continue; // only enrolled tickets
    const hasTerminalDoneLabel = ticket.labels.some((l) => l.name === "state:done");

    try {
      // Fetch native state. Completed tickets still require merged PR proof;
      // canceled/duplicate tickets are already terminal and should only have
      // stale workflow facets stripped without changing native state.
      const stateData = await queryEnrolledTicketState(ticket.id, authToken, fetchFn);
      if (!stateData || !stateData.state) continue;

      const nativeType = stateData.state.type.toLowerCase();
      if (nativeType === "completed") {
        // Fetch PR status — must have merged PRs to confirm shipped.
        const prStatus = await queryEnrolledPRStatus(ticket.id, authToken, fetchFn);
        if (!prStatus || !prStatus.hasMergedPR) continue;
      } else if (nativeType !== "canceled" && nativeType !== "cancelled" && nativeType !== "duplicate") {
        continue;
      } else if (hasTerminalDoneLabel) {
        continue;
      }

      // Native terminal: close the stale workflow record without writing stateId.
      const closed = await closeEnrolledTicket(ticket.id, authToken, fetchFn);
      if (closed) {
        result.healed++;
        log.info(
          `bootstrap-reconciliation: closed enrolled terminal ticket ${ticket.identifier}` +
          ` (native state: ${stateData.state.name})`,
        );
        alertBus.notify({
          severity: "warning",
          source: "bootstrap-reconciled",
          title: `Bootstrap reconciliation closed enrolled terminal ticket ${ticket.identifier}`,
          detail: {
            ticket: ticket.identifier,
            issueId: ticket.id,
            nativeState: stateData.state.name,
          },
          ticket: ticket.identifier,
        });
      } else {
        result.errors.push(`close enrolled mutation failed for ${ticket.identifier}`);
        log.warn(`bootstrap-reconciliation: close enrolled mutation returned false for ${ticket.identifier}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`enrolled-ticket close failed for ${ticket.identifier}: ${msg}`);
      log.error(`bootstrap-reconciliation: enrolled-ticket close error for ${ticket.identifier}: ${msg}`);
      alertBus.notify({
        severity: "warning",
        source: "bootstrap-reconciled",
        title: `Bootstrap reconciliation enrolled-ticket error for ${ticket.identifier}`,
        detail: { error: msg },
        ticket: ticket.identifier,
      });
    }
  }

  // ── Pass 4: Terminal workflow label but active native state (INF-497) ────────
  // The mirror image of Pass 3. Pass 3 closes tickets that are native-Done but
  // still carry live workflow labels. Pass 4 handles the inverse: the workflow
  // record already reached terminal `done` (label `state:done`) but the native
  // Linear state was never advanced off an active column — the INF-496 shape
  // (`wf:task` + `state:done` + native `To Do` + null delegate). The null-delegate
  // stall sweep then re-flags it forever as an active, ownerless ticket the
  // workflow engine itself considers terminal, with no legal agent verb to repair
  // it (`complete` is rejected from state `done`; `escape` would re-open it).
  //
  // Gate: reconcile ONLY when the terminal `state:done` label is present. This
  // moves native state strictly toward completion — it never re-opens a ticket,
  // never changes the workflow label, and posts no ticket comment (audit is the
  // alert-bus record below).
  for (const ticket of candidates) {
    const hasTerminalDoneLabel = ticket.labels.some((l) => l.name === "state:done");
    if (!hasTerminalDoneLabel) continue;

    try {
      const stateData = await queryEnrolledTicketState(ticket.id, authToken, fetchFn);
      if (!stateData || !stateData.state) continue;
      // Already terminal (completed/canceled) → nothing to reconcile. A native-Done
      // ticket with live labels is Pass 3's job; a canceled ticket must not be
      // force-completed.
      if (stateData.state.type === "completed" || stateData.state.type === "canceled") continue;

      const completedStateId = await queryTeamCompletedStateId(ticket.teamId, authToken, fetchFn);
      if (!completedStateId) {
        result.errors.push(`no completed state resolved for team of ${ticket.identifier}`);
        log.warn(`bootstrap-reconciliation: could not resolve completed state for ${ticket.identifier}`);
        continue;
      }

      const reconciled = await reconcileTerminalNativeState(ticket.id, completedStateId, authToken, fetchFn);
      if (reconciled) {
        result.healed++;
        log.info(
          `bootstrap-reconciliation: reconciled terminal-label ticket ${ticket.identifier}` +
          ` (native ${stateData.state.name} → completed; label state:done unchanged)`,
        );
        alertBus.notify({
          severity: "warning",
          source: "bootstrap-reconciled",
          title: `Bootstrap reconciliation reconciled terminal-label ticket ${ticket.identifier}`,
          detail: {
            ticket: ticket.identifier,
            issueId: ticket.id,
            fromNativeState: stateData.state.name,
            toStateId: completedStateId,
          },
          ticket: ticket.identifier,
        });
      } else {
        result.errors.push(`terminal-state reconcile mutation failed for ${ticket.identifier}`);
        log.warn(`bootstrap-reconciliation: terminal-state reconcile returned false for ${ticket.identifier}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`terminal-state reconcile failed for ${ticket.identifier}: ${msg}`);
      log.error(`bootstrap-reconciliation: terminal-state reconcile error for ${ticket.identifier}: ${msg}`);
      alertBus.notify({
        severity: "warning",
        source: "bootstrap-reconciled",
        title: `Bootstrap reconciliation terminal-state error for ${ticket.identifier}`,
        detail: { error: msg },
        ticket: ticket.identifier,
      });
    }
  }

  // ── Pass 5: Actionable null-delegate tickets → auto-seat role owner (INF-739 Mode 1) ─
  // The INF-735 shape: `wf:*` + a non-terminal `state:*` label, native state
  // still active, but NO delegate. The workflow record is correctly enrolled and
  // actionable — the only defect is that no agent owns the next move, so it stalls
  // until a human hand-seats the role owner. This pass seats the current state's
  // role owner (`resolveBodiesForRole`) automatically.
  //
  // HARD EXCLUSION (INF-717 fix A / the LSO-20 bug): a terminal-labeled ticket
  // (`state:done` / `state:escape` / `state:canceled`) correctly has a null
  // delegate — reconciling its native state is Pass 4's job, and re-seating a
  // delegate here would re-open a finished ticket. Mode 1 must never touch them.
  for (const ticket of candidates) {
    // Native terminality wins over stale labels (symmetric to Pass 1/2 guards).
    if (isTerminalIssueState(ticket.nativeState)) continue;

    // Only enrolled, ownerless tickets.
    if (ticket.delegateId) continue;
    const workflowLabel = ticket.labels.find((l) => l.name.startsWith("wf:"))?.name;
    const stateLabel = ticket.labels.find((l) => l.name.startsWith("state:"))?.name;
    if (!workflowLabel || !stateLabel) continue;

    // Never re-seat on a terminal-labeled ticket — that is Mode 2's shape and
    // re-seating it is the LSO-20 defect this pass is explicitly forbidden to repeat.
    if (isTerminalStateLabel(ticket.labels)) continue;

    // Must be an actionable state that declares an owner_role (excludes terminal
    // states via `kind !== "terminal"`; a null registry → skip, cannot resolve).
    if (!isActionableWorkflowLabelState(workflowRegistry, workflowLabel, stateLabel)) continue;

    const stateDef = workflowDefForLabel(workflowRegistry, workflowLabel)
      ?.states.find((s) => s.id === stateLabel.replace(/^state:/, ""));
    const ownerRole = stateDef?.owner_role;
    if (!ownerRole) continue;

    try {
      // Idempotency / race-safety: re-fetch live delegate+state right before the
      // write. A delegate-change webhook (or a prior sweep) may have seated an
      // owner between the batch query and now — if so, this pass is a no-op.
      const live = await queryEnrolledTicketState(ticket.id, authToken, fetchFn);
      if (live?.delegate?.id) continue;
      if (live?.state && (live.state.type === "completed" || live.state.type === "canceled")) continue;

      const bodies = await resolveOwnerBodies(ownerRole);
      if (bodies.length === 0) {
        result.errors.push(
          `mode-1 auto-seat: role '${ownerRole}' has no body to seat on ${ticket.identifier}`,
        );
        log.warn(
          `bootstrap-reconciliation: Mode 1 could not seat ${ticket.identifier} — role '${ownerRole}' resolves to zero bodies`,
        );
        continue;
      }
      // single → concrete; multi → first candidate (mirrors resolveBodiesForRole
      // usage across the gate; a multi-body role seats its first filler).
      const bodyId = bodies[0];
      const delegateLinearUserId = linearUserIdForBody(bodyId);
      if (!delegateLinearUserId) {
        result.errors.push(
          `mode-1 auto-seat: body '${bodyId}' (role '${ownerRole}') has no linearUserId for ${ticket.identifier}`,
        );
        log.warn(
          `bootstrap-reconciliation: Mode 1 could not seat ${ticket.identifier} — body '${bodyId}' has no linearUserId`,
        );
        continue;
      }

      const seated = await seatRoleOwnerDelegate(ticket.id, delegateLinearUserId, authToken, fetchFn);
      if (!seated) {
        result.errors.push(`mode-1 auto-seat mutation failed for ${ticket.identifier}`);
        log.warn(`bootstrap-reconciliation: Mode 1 seat mutation returned false for ${ticket.identifier}`);
        continue;
      }

      result.seated++;
      log.info(
        `bootstrap-reconciliation: Mode 1 seated role '${ownerRole}' owner '${bodyId}' on ${ticket.identifier}` +
        ` (state ${stateLabel}, native ${ticket.nativeState?.name ?? "active"})`,
      );

      // Audit trail (AC): one alert-bus record per auto-heal.
      alertBus.notify({
        severity: "warning",
        source: "bootstrap-reconciled",
        title: `Bootstrap reconciliation seated role owner on ${ticket.identifier}`,
        detail: {
          mode: "mode-1-auto-seat",
          ticket: ticket.identifier,
          issueId: ticket.id,
          workflowLabel,
          stateLabel,
          ownerRole,
          seatedBody: bodyId,
          delegateLinearUserId,
        },
        ticket: ticket.identifier,
      });

      // Wake the newly-seated owner — otherwise it is seated but dark, the exact
      // stall this sweep fights. Record the dispatch so the watchdog does not
      // double-fire. Wake is best-effort: seating already succeeded.
      if (wakeFn) {
        const wakeTarget = openclawNameForBody(bodyId);
        try {
          await wakeFn(wakeTarget, ticket.identifier);
          opts.dispatchAckTracker?.recordDispatch(wakeTarget, ticket.identifier);
        } catch (wakeErr) {
          const wakeMsg = wakeErr instanceof Error ? wakeErr.message : String(wakeErr);
          result.errors.push(`mode-1 wake failed for ${ticket.identifier}: ${wakeMsg}`);
          log.warn(`bootstrap-reconciliation: Mode 1 wake failed for ${ticket.identifier}: ${wakeMsg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`mode-1 auto-seat failed for ${ticket.identifier}: ${msg}`);
      log.error(`bootstrap-reconciliation: Mode 1 auto-seat error for ${ticket.identifier}: ${msg}`);
      alertBus.notify({
        severity: "warning",
        source: "bootstrap-reconciled",
        title: `Bootstrap reconciliation Mode 1 auto-seat error for ${ticket.identifier}`,
        detail: { error: msg },
        ticket: ticket.identifier,
      });
    }
  }

  markCronRun("bootstrap-reconciliation-sweep");
  return result;
}

// ── Cron registration ───────────────────────────────────────────────────────

/**
 * Register the reconciliation sweep as a recurring interval timer.
 *
 * The caller MUST supply the Linear auth token — typically resolved in
 * `index.ts` via `getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ??
 * process.env.LINEAR_API_KEY`, matching every other server-side Linear call.
 *
 * **Wake wiring (AC1):** the caller MUST supply a `wakeFn` that delivers a
 * workflow-aware wake to the healed delegate — identical to the post-bootstrap
 * wake delivery in the webhook path. Without it, a healed ticket gets labels
 * + delegate but the delegate is never notified.
 *
 * **Alert bus (AC2/AC4):** if `alertBus` is omitted, the sweep defaults to the
 * global alert-bus singleton (`getAlertBus()`), so alerts always fire in prod.
 *
 * Returns the NodeJS.Timeout so the caller can clear it (e.g. on shutdown).
 * In production this is called once from index.ts alongside other periodic
 * loops.
 */
export function registerBootstrapReconciliationCron(
  opts: {
    authToken: string | (() => string);
    intervalMs?: number;
    /** Alert bus for heal/failure notifications. Defaults to the global singleton. */
    alertBus?: AlertBus;
    /** Delivers a wake to the first-owner delegate after a successful heal.
     *  Required for AC1 in the prod path — index.ts wires this to the same
     *  delivery mechanism the webhook bootstrap path uses. */
    wakeFn?: (agentName: string, ticketIdentifier: string) => Promise<void>;
    /** Dispatch ack tracker used by the watchdog/reconciliation backstop. */
    dispatchAckTracker?: DispatchAckTracker;
  },
): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  registerCron("bootstrap-reconciliation-sweep", `every ${formatIntervalMs(intervalMs)}`);

  if (!opts.authToken) {
    log.warn(
      "bootstrap-reconciliation: no auth token provided — sweep will be skipped until the next call",
    );
  }

  const timer = setInterval(() => {
    // Fire-and-forget — errors are captured inside the sweep and surfaced
    // via the alert bus, not propagated to the interval handler.
    void runBootstrapReconciliationSweep({
      authToken: opts.authToken,
      alertBus: opts.alertBus,
      wakeFn: opts.wakeFn,
      dispatchAckTracker: opts.dispatchAckTracker,
    }).catch((err) => {
      log.error(
        `bootstrap-reconciliation: unexpected sweep failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, intervalMs);

  timer.unref();

  log.info(`bootstrap-reconciliation: cron registered (${intervalMs}ms interval, wakeFn=${opts.wakeFn ? "wired" : "absent"})`);
  return timer;
}
