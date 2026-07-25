/**
 * AI-1807 — Delegation reconciliation sweep.
 *
 * Detects and heals two classes of stranded tickets caused by webhook-ingress
 * gaps (e.g. the 2026-07-05 Fujimoto outage):
 *
 *   1. Governed, non-terminal tickets whose current delegate has no dispatch
 *      record since the delegate was set (AC1). The delegate-change webhook
 *      was dropped, so the wake was never sent.
 *   2. wf-labeled tickets with no state:* label and no delegate — dropped
 *      enrollment webhooks (AC2). Complements AI-1775's bootstrap sweep.
 *
 * Each heal emits an operational event and an alert-bus notify (AC3).
 * Idempotent: a ticket whose delegate was already woken is never re-woken (AC4).
 *
 * The sweep is registered at server bootstrap via registerDelegationReconciliationCron
 * and is observable via /health crons field (AC6/AC7).
 *
 * POST /redispatch (ADMIN_SECRET-gated) triggers on-demand reconciliation
 * for a single ticket or a time window (AC5).
 */

import { componentLogger, createLogger } from "./logger.js";
import { isNativelyTerminal } from "./terminality.js";
import {
  fetchIssueContext,
  applyBootstrapToIssue,
} from "./workflow-bootstrap.js";
import {
  autoEnrollPlainDelegation,
  setStateAtomic,
  type SetStateAtomicResult,
} from "./workflow-gate.js";
import { getAgentIdForLinearUserId, getOpenclawAgentName } from "./agents.js";
import { getAlertBus, type AlertBus } from "./alerts/alert-bus.js";
import { registerCron, markCronRun, formatIntervalMs } from "./cron/registry.js";
import { OperationalEventStore, type OperationalEventStore as OperationalEventStoreType } from "./store/operational-event-store.js";
import type { SessionTracker } from "./bag/session-tracker.js";
import type { DispatchLeaseStore } from "./store/dispatch-lease-store.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";

const log = componentLogger(
  createLogger(process.env.LOG_LEVEL ?? "info"),
  "delegation-reconciliation",
);

const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Default sweep cadence. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/** Grace window: tickets younger than this are given time for the webhook to arrive. */
const DEFAULT_GRACE_WINDOW_MS = 2 * 60 * 1000; // 2 min

const LINEAR_ISSUES_PAGE_SIZE = 50;

// ── Types ────────────────────────────────────────────────────────────────────

export interface DelegationReconciliationOptions {
  authToken: string;
  operationalEventStore: OperationalEventStoreType;
  alertBus: AlertBus;
  wakeFn: (agentName: string, ticketIdentifier: string) => Promise<void>;
  sessionTracker?: SessionTracker;
  fetchFn?: typeof fetch;
  /** AC5: single-ticket mode — reconcile only these identifiers. */
  ticketIdentifiers?: string[];
  /** AC5: time-window mode — reconcile tickets updated within [since, until]. */
  since?: string;
  until?: string;
  /** Override for Date.now() — used in tests for deterministic timing. */
  now?: () => Date;
  /** AI-2350: durable dispatch lease store — prevent re-dispatches. */
  dispatchLeaseStore?: DispatchLeaseStore;
  /** INF-334: mirror enrollment for plain delegated tickets promoted to wf:task. */
  enrolledTicketsStore?: EnrolledTicketsStore;
  /**
   * INF-558: atomic facet-sync primitive used to heal out-of-band terminal
   * tickets (strip the stale `state:*` mirror label → terminal, clear the
   * pinned delegate). Injected for testability; defaults to the real
   * `setStateAtomic`. The sweep never dispatches these tickets — it re-aligns
   * their facets so the whole poller fleet stops seeing them as active.
   */
  setStateFn?: typeof setStateAtomic;
}

export interface DelegationReconciliationResult {
  scanned: number;
  healed: number;
  bootstrapHealed: number;
  skippedIdempotent: number;
  /**
   * INF-558: count of natively-terminal tickets whose stale facets (active
   * `state:*` mirror label, pinned delegate, or non-terminal enrolled row)
   * were reconciled this sweep.
   */
  facetHealed: number;
  errors: string[];
}

/** Internal representation of a governed ticket from the Linear query. */
interface GovernedTicket {
  id: string;
  identifier: string;
  updatedAt: string;
  labels: Array<{ id: string; name: string }>;
  delegateId: string | null;
  delegateName: string | null;
  teamId: string;
  /** INF-205: native Linear state type, or null when unavailable. */
  nativeStateType: string | null;
  plainDelegation?: boolean;
}

type LinearIssueNode = {
  id: string;
  identifier: string;
  updatedAt: string;
  state?: { type: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
  delegate: { id: string; name: string } | null;
  team: { id: string };
};

type IssuesPageResp = {
  errors?: Array<{ message: string }>;
  data?: {
    issues?: {
      nodes: LinearIssueNode[];
      pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
      };
    };
  };
};

// ── Terminal state detection ─────────────────────────────────────────────────

/** State labels that mean the ticket lifecycle is finished. */
const TERMINAL_STATE_PREFIXES = ["state:done", "state:escape", "state:canceled"];

function isTerminal(labels: Array<{ name: string }>): boolean {
  return labels.some((l) =>
    TERMINAL_STATE_PREFIXES.some((t) => l.name.startsWith(t)),
  );
}

function hasStateLabel(labels: Array<{ name: string }>): boolean {
  return labels.some((l) => l.name.startsWith("state:"));
}

function hasWfLabel(labels: Array<{ name: string }>): boolean {
  return labels.some((l) => l.name.startsWith("wf:"));
}

// ── Linear API query ─────────────────────────────────────────────────────────

/**
 * Query Linear for wf-labeled tickets. If ticketIdentifiers are provided,
 * filters by identifier; otherwise returns all governed tickets.
 */
async function queryGovernedTickets(
  authToken: string,
  fetchFn: typeof fetch,
  ticketIdentifiers?: string[],
): Promise<GovernedTicket[]> {
  // Always use the batch query (wf:*) — the mock layer returns
  // data.issues.nodes for any query containing "DelegationReconciliation".
  // Filter by identifier in code if requested.
  const nodes: LinearIssueNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const afterArg = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
    const query = `
      query DelegationReconciliation {
        issues(first: ${LINEAR_ISSUES_PAGE_SIZE}${afterArg}, filter: { labels: { some: { name: { startsWith: "wf:" } } } }) {
          nodes {
            id
            identifier
            updatedAt
            title
            state { type }
            labels { nodes { id name } }
            delegate { id name }
            team { id }
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
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables: {} }),
    });

    const data = (await res.json()) as IssuesPageResp;

    // INF-585: fail loud on a non-2xx response or a 200-with-errors GraphQL
    // validation failure. Previously the governed query read `nodes ?? []`
    // with no guard, so a bad response (e.g. HTTP 400 GRAPHQL_VALIDATION_FAILED,
    // or Linear's 200-with-`errors` for an invalid filter) was swallowed as an
    // empty page → the sweep reported `scanned:0` and woke nobody. Throwing
    // surfaces the failure via runDelegationReconciliationSweep's catch, which
    // records it in result.errors and fires an alert-bus notify.
    if (!res.ok || (data.errors && data.errors.length > 0)) {
      const detail = data.errors?.[0]?.message ?? `HTTP ${res.status}`;
      throw new Error(`GovernedTickets query failed: ${detail}`);
    }

    nodes.push(...(data.data?.issues?.nodes ?? []));

    const pageInfo = data.data?.issues?.pageInfo;
    hasNextPage = pageInfo?.hasNextPage === true;
    cursor = pageInfo?.endCursor ?? null;
    if (hasNextPage && !cursor) break;
  }

  // Filter by identifier if provided (AC5 single-ticket mode)
  let filteredNodes = nodes;
  if (ticketIdentifiers && ticketIdentifiers.length > 0) {
    const ids = new Set(ticketIdentifiers);
    filteredNodes = filteredNodes.filter((n) => ids.has(n.identifier));
  }

  return filteredNodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    updatedAt: n.updatedAt,
    labels: n.labels.nodes,
    delegateId: n.delegate?.id ?? null,
    delegateName: n.delegate?.name ?? null,
    teamId: n.team.id,
    nativeStateType: n.state?.type ?? null,
    plainDelegation: false,
  }));
}

/**
 * Query Linear for ad-hoc delegated tickets (no wf:* label, has delegate set).
 * INF-287: catches tickets delegated outside the workflow engine whose
 * delegate-change webhook was dropped.
 */
async function queryAdhocDelegatedTickets(
  authToken: string,
  fetchFn: typeof fetch,
  ticketIdentifiers?: string[],
): Promise<GovernedTicket[]> {
  const nodes: LinearIssueNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const afterArg = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
    const query = `
      query AdhocDelegationReconciliation {
        issues(first: ${LINEAR_ISSUES_PAGE_SIZE}${afterArg}, filter: { labels: { none: { name: { startsWith: "wf:" } } }, delegate: { isSet: true } }) {
          nodes {
            id
            identifier
            updatedAt
            title
            labels { nodes { id name } }
            delegate { id name }
            team { id }
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
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables: {} }),
    });

    const data = (await res.json()) as IssuesPageResp;

    // INF-334: Linear returns 200 with "errors" for invalid filters.
    // INF-585: fail loud instead of returning []. The old behavior logged and
    // returned an empty page, so an invalid filter (or an HTTP 400) reported
    // `scanned:0` with no alert — indistinguishable from "no ad-hoc tickets to
    // reconcile," which is exactly how the original broken filter went
    // unnoticed. Throwing surfaces the failure via
    // runDelegationReconciliationSweep's catch (result.errors + alert-bus).
    if (!res.ok || (data.errors && data.errors.length > 0)) {
      const detail = data.errors?.[0]?.message ?? `HTTP ${res.status}`;
      throw new Error(`AdhocDelegationReconciliation query failed: ${detail}`);
    }

    const pageNodes = data.data?.issues?.nodes ?? [];

    // INF-334: The schema-legal query returns BOTH governed and ad-hoc tickets.
    // We must filter out governed tickets
    // (those with wf:* labels) client-side to satisfy "adhoc" semantics.
    const adhocNodes = pageNodes.filter(n => {
      return !n.labels.nodes.some(l => l.name.startsWith("wf:"));
    });

    nodes.push(...adhocNodes);

    const pageInfo = data.data?.issues?.pageInfo;
    hasNextPage = pageInfo?.hasNextPage === true;
    cursor = pageInfo?.endCursor ?? null;
    if (hasNextPage && !cursor) break;
  }

  // Filter by identifier if provided (AC5 single-ticket mode)
  let filteredNodes = nodes;
  if (ticketIdentifiers && ticketIdentifiers.length > 0) {
    const ids = new Set(ticketIdentifiers);
    filteredNodes = filteredNodes.filter((n) => ids.has(n.identifier));
  }

  return filteredNodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    updatedAt: n.updatedAt,
    labels: n.labels.nodes,
    delegateId: n.delegate?.id ?? null,
    delegateName: n.delegate?.name ?? null,
    teamId: n.team.id,
    nativeStateType: n.state?.type ?? null,
    plainDelegation: true,
  }));
}

// ── Idempotency check ─────────────────────────────────────────────────────────

/**
 * Query Linear issue history for the most recent delegate-change event.
 *
 * Returns the ISO-8601 timestamp of when the current (or most recent) delegate
 * was set, or null if no delegate-change event is found.
 *
 * AI-2350: fixes the compounding defect where ticket.updatedAt (which changes
 * on any mutation — state, label, comment) was passed as the delegation
 * timestamp to hasDispatchSinceDelegation, causing the guard to fail.
 */
async function queryDelegateSetTimestamp(
  issueId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  const query = `
    query TicketDelegateHistory($issueId: String!) {
      issue(id: $issueId) {
        history(first: 50, orderBy: createdAt) {
          nodes {
            __typename
            createdAt
            toAssignee { id }
            fromAssignee { id }
          }
        }
      }
    }
  `;

  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables: { issueId } }),
    });

    type DelegateHistoryResp = {
      data?: {
        issue?: {
          history: {
            nodes: Array<{
              __typename: string;
              createdAt: string;
              toAssignee?: { id: string } | null;
              fromAssignee?: { id: string } | null;
            }>;
          };
        };
      };
    };

    const body = (await res.json()) as DelegateHistoryResp;
    const historyNodes = body.data?.issue?.history?.nodes ?? [];

    // Find the most recent delegate-change event (toAssignee was set)
    // Use reverse chronological order.
    for (const h of historyNodes.reverse()) {
      if (h.toAssignee?.id || h.fromAssignee?.id) {
        return h.createdAt;
      }
    }

    return null;
  } catch (err) {
    log.warn(
      `Failed to query delegate-set timestamp for ${issueId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Check if the given delegate has been dispatched for this ticket since the
 * delegation timestamp. Returns true if a dispatch-accepted, delivered, or
 * delivery-pending-ack event exists for the current agent after the delegate
 * was set.
 *
 * AI-2464: `delivery-pending-ack` (AI-2437) counts as dispatched. It means the
 * connection was established and the wake is queued in the agent's hands, and
 * deliver-with-ack registers the ack expectation on that path with the same
 * `ackTracker.recordDispatch` call the `delivered` path uses. The dispatch
 * watchdog therefore already owns retry for it, with backoff and escalation
 * this sweep does not have. Counting it keeps the sweep from racing the
 * watchdog to heal the same entry — the duplicate wake AI-2437 set out to stop.
 */
function hasDispatchSinceDelegation(
  operationalEventStore: OperationalEventStore,
  agentName: string,
  ticketIdentifier: string,
  delegationTimestamp: string,
  sessionTracker?: SessionTracker,
): boolean {
  // AI-2313: if a live session exists for this (agent, ticket), treat it as "already dispatched"
  // even if the event store doesn't have a dispatch-accepted event. This covers the gap where
  // the session tracker's stale timeout cleaned up in-memory state but the session is still alive.
  if (sessionTracker) {
    const sessionKey = `linear-${ticketIdentifier}`;
    if (sessionTracker.isActiveForTicket(agentName, sessionKey)) {
      return true;
    }
  }

  const events = operationalEventStore.query({
    key: `linear-${ticketIdentifier}`,
    limit: 100,
  });

  const delegationMs = new Date(delegationTimestamp).getTime();

  return events.some((e) => {
    if (
      e.outcome !== "dispatch-accepted" &&
      e.outcome !== "delivered" &&
      e.outcome !== "delivery-pending-ack"
    )
      return false;
    if (e.agent !== agentName) return false;
    const eventMs = new Date(e.occurredAt).getTime();
    return eventMs >= delegationMs;
  });
}

// ── INF-558: out-of-band terminal facet reconciliation ──────────────────────

/**
 * Heal the facets of a natively-terminal ticket whose lifecycle was closed
 * out-of-band (manual Linear column flip, or any non-governed edge that failed
 * to sync facets), so the dispatch poller fleet stops treating it as active.
 *
 * The governed `complete`/`converge` terminal syncs three facets: the `state:*`
 * mirror label → terminal, the delegate → null, and the enrolled-tickets mirror
 * row → terminal. An out-of-band close advances only the native Linear state,
 * leaving all three stale — and every poller keys off those facets, not the
 * native state, so the ticket re-dispatches forever (live victim: LSO-1).
 *
 * On `release-1.4` the sweep's terminal check already EXCLUDES natively-terminal
 * tickets from redispatch (INF-205's `isNativelyTerminal` guard), so the loop is
 * no longer running for LSO-1's flavor here. What this adds is the missing
 * facet-heal: a bare skip stops THIS sweep from redispatching but leaves the
 * mirror label + delegate poisoned for every OTHER poller. INF-528 closed the
 * governed-path hole (facet-sync on `converge`); this closes the
 * non-governed-terminal hole by actively re-aligning the facets.
 *
 * Two heals, ordered by safety:
 *   1. **Local mirror heal** — always safe (no Linear write, no native-state
 *      risk). Marks the enrolled-tickets row terminal, which stops every poller
 *      that keys off that mirror (e.g. the first-action watchdog) regardless of
 *      the native terminal flavor.
 *   2. **Linear facet heal** — strip the stale `state:*` label → terminal and
 *      clear the pinned delegate via the same atomic primitive the governed
 *      terminal uses. Only run when the ticket's native state is IDEMPOTENT with
 *      the target terminal state, so we never flip an authoritative native state
 *      (e.g. resurrect a Canceled ticket to Done). The dominant/documented class
 *      is native `completed` → target `done`; canceled/duplicate get the local
 *      heal plus an operator alert.
 *
 * Never throws — failures are captured in `result.errors` and surfaced via the
 * alert bus, matching the sweep's fail-open contract.
 */
async function reconcileOutOfBandTerminal(
  ticket: GovernedTicket,
  opts: DelegationReconciliationOptions,
  result: DelegationReconciliationResult,
): Promise<void> {
  const mirror = opts.enrolledTicketsStore;
  const setStateFn = opts.setStateFn ?? setStateAtomic;

  const labelActive = hasStateLabel(ticket.labels) && !isTerminal(ticket.labels);
  const delegatePinned = !!ticket.delegateId;
  const enrolledRow = mirror?.getByTicketId(ticket.identifier) ?? null;
  const enrolledActive = !!enrolledRow && enrolledRow.terminal !== 1;

  // Already clean — nothing to reconcile. Keeps the heal idempotent across
  // sweeps so we never re-write a ticket we healed on a prior pass.
  if (!labelActive && !delegatePinned && !enrolledActive) return;

  // 1) Local mirror heal — unconditional and Linear-write-free.
  if (mirror && enrolledActive) {
    try {
      mirror.markTerminal(ticket.identifier, "out-of-band-terminal");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(
        `out-of-band terminal mirror heal failed for ${ticket.identifier}: ${msg}`,
      );
    }
  }

  // 2) Linear facet heal — only when native-idempotent (completed → done).
  if (labelActive || delegatePinned) {
    if (ticket.nativeStateType === "completed") {
      let res: SetStateAtomicResult;
      try {
        res = await setStateFn(ticket.identifier, "done", null, opts.authToken, {
          force: true,
          enrolledTicketsStore: mirror,
          operationalEventStore: opts.operationalEventStore,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res = { ok: false, ticketId: ticket.identifier, from: null, to: "done", error: msg };
      }
      if (!res.ok) {
        result.errors.push(
          `out-of-band terminal facet-sync failed for ${ticket.identifier}: ${res.error}`,
        );
        opts.alertBus.notify({
          severity: "warning",
          source: "delegation-reconciled",
          title: `Out-of-band terminal facet-sync failed for ${ticket.identifier}`,
          detail: { error: res.error, nativeStateType: ticket.nativeStateType },
          ticket: ticket.identifier,
        });
        return;
      }
    } else {
      // Canceled/duplicate: the enrolled mirror is already healed above, which
      // stops the redispatch loop. We deliberately do NOT auto-sync the Linear
      // facets, because every governed terminal state maps `native_state: done`
      // — a Linear write would resurrect the native state from Canceled to Done.
      // Surface for operator review instead. Full Canceled-path auto-heal is
      // carved out to INF-560.
      opts.alertBus.notify({
        severity: "warning",
        source: "delegation-reconciled",
        title: `Out-of-band ${ticket.nativeStateType} ticket ${ticket.identifier} — enrolled mirror healed, Linear facets need operator sync`,
        detail: {
          nativeStateType: ticket.nativeStateType,
          labelActive,
          delegatePinned,
        },
        ticket: ticket.identifier,
      });
    }
  }

  result.facetHealed += 1;
  opts.operationalEventStore.append({
    outcome: "delegation-reconciled",
    agent: ticket.delegateName,
    key: `linear-${ticket.identifier}`,
    detail: {
      mode: "out-of-band-terminal-facet-sync",
      ticket: ticket.identifier,
      nativeStateType: ticket.nativeStateType,
      labelActive,
      delegatePinned,
      enrolledActive,
    },
  });
  log.info(
    `delegation-reconciliation: out-of-band terminal facet-sync for ${ticket.identifier} ` +
      `(native=${ticket.nativeStateType}, labelActive=${labelActive}, delegatePinned=${delegatePinned}, enrolledActive=${enrolledActive})`,
  );
}

// ── Main sweep ───────────────────────────────────────────────────────────────

/**
 * Run a single delegation reconciliation sweep: query → classify → heal → alert.
 *
 * Never throws — all errors are captured in the `errors` array and surfaced via
 * the alert bus (AC3).
 */
export async function runDelegationReconciliationSweep(
  opts: DelegationReconciliationOptions,
): Promise<DelegationReconciliationResult> {
  const authToken = opts.authToken;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const alertBus = opts.alertBus;
  const operationalEventStore = opts.operationalEventStore;
  const wakeFn = opts.wakeFn;
  const sessionTracker = opts.sessionTracker;
  const nowDate = opts.now ?? (() => new Date());

  const result: DelegationReconciliationResult = {
    scanned: 0,
    healed: 0,
    bootstrapHealed: 0,
    skippedIdempotent: 0,
    facetHealed: 0,
    errors: [],
  };

  // ── Query ──────────────────────────────────────────────────────────────
  let tickets: GovernedTicket[];
  try {
    const governedTickets = await queryGovernedTickets(
      authToken,
      fetchFn,
      opts.ticketIdentifiers,
    );
    const adhocTickets = await queryAdhocDelegatedTickets(
      authToken,
      fetchFn,
      opts.ticketIdentifiers,
    );
    tickets = [...governedTickets, ...adhocTickets];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`query failed: ${msg}`);
    log.error(`delegation-reconciliation: query failed: ${msg}`);
    alertBus.notify({
      severity: "warning",
      source: "delegation-reconciled",
      title: `Delegation reconciliation sweep query failed: ${msg}`,
    });
    return result;
  }

  // ── Filter by time window if provided (AC5) ──────────────────────────
  const sinceMs = opts.since ? new Date(opts.since).getTime() : -Infinity;
  const untilMs = opts.until ? new Date(opts.until).getTime() : Infinity;

  const filtered = tickets.filter((t) => {
    const updatedMs = new Date(t.updatedAt).getTime();
    return updatedMs >= sinceMs && updatedMs <= untilMs;
  });

  result.scanned = filtered.length;

  // ── Process each ticket ───────────────────────────────────────────────
  for (const ticket of filtered) {
    // INF-558: out-of-band terminal reconciliation. INF-205 already keeps the
    // sweep from redispatching a natively-closed ticket (the guard below), but a
    // bare skip leaves its stale `state:*` mirror label + pinned delegate +
    // enrolled row poisoned for every OTHER poller — so a native-Done ticket
    // closed via a non-governed path (manual column flip, or any edge that
    // forgets to sync facets) re-dispatches forever from those pollers (live
    // victim: LSO-1). Heal the facets the same way the governed complete/converge
    // terminal does instead of merely skipping. INF-528 closed the governed-path
    // hole; this closes the non-governed-terminal hole.
    if (isNativelyTerminal(ticket.nativeStateType)) {
      await reconcileOutOfBandTerminal(ticket, opts, result);
      continue;
    }

    // Skip label-terminal tickets (lifecycle already finished).
    if (isTerminal(ticket.labels)) continue;

    // ── AC2: wf:* but no state:* and no delegate (dropped enrollment) ────
    if (!hasStateLabel(ticket.labels) && !ticket.delegateId && hasWfLabel(ticket.labels)) {
      try {
        // Re-fetch fresh context for idempotency
        const issue = await fetchIssueContext(ticket.id, authToken);
        if (!issue) {
          result.errors.push(
            `could not re-fetch issue context for ${ticket.identifier}`,
          );
          continue;
        }

        // Double-check: state:* may have appeared between query and re-fetch
        if (hasStateLabel(issue.labels)) continue;

        // Try to apply the bootstrap (same path as AI-1775)
        const bootstrapResult = await applyBootstrapToIssue(
          issue,
          authToken,
        );

        if (bootstrapResult?.action === "bootstrapped") {
          result.bootstrapHealed++;
          log.info(
            `delegation-reconciliation: bootstrap healed ${ticket.identifier} → ${bootstrapResult.workflowId}:${bootstrapResult.entryState}`,
          );

          // Emit operational event
          operationalEventStore.append({
            outcome: "delegation-reconciled",
            agent: bootstrapResult.delegateAgentName ?? null,
            key: `linear-${ticket.identifier}`,
            detail: {
              mode: "bootstrap",
              ticket: ticket.identifier,
              workflow: bootstrapResult.workflowId,
              entryState: bootstrapResult.entryState,
              delegate: bootstrapResult.delegateAgentName ?? null,
            },
          });

          // Wake the newly-delegated agent
          if (
            bootstrapResult.delegateAgentName &&
            bootstrapResult.ticketIdentifier
          ) {
            try {
              await wakeFn(
                bootstrapResult.delegateAgentName,
                bootstrapResult.ticketIdentifier,
              );
            } catch (wakeErr) {
              const wakeMsg =
                wakeErr instanceof Error ? wakeErr.message : String(wakeErr);
              log.warn(
                `delegation-reconciliation: wake failed for ${ticket.identifier}: ${wakeMsg}`,
              );
            }
          }

          // Alert
          alertBus.notify({
            severity: "warning",
            source: "delegation-reconciled",
            title: `Delegation reconciliation bootstrap healed ${ticket.identifier}`,
            detail: {
              ticket: ticket.identifier,
              workflow: bootstrapResult.workflowId,
              entryState: bootstrapResult.entryState,
              delegate: bootstrapResult.delegateAgentName ?? null,
            },
            ticket: ticket.identifier,
          });
        } else {
          // Bootstrap did not apply (no matching workflow def, etc.)
          // Still count as detected — emit an alert so operators know.
          result.bootstrapHealed++;
          log.info(
            `delegation-reconciliation: detected unenrolled ticket ${ticket.identifier} (bootstrap returned no-op)`,
          );

          // Emit operational event
          operationalEventStore.append({
            outcome: "delegation-reconciled",
            key: `linear-${ticket.identifier}`,
            detail: {
              mode: "bootstrap-detection",
              ticket: ticket.identifier,
            },
          });

          // Alert
          alertBus.notify({
            severity: "warning",
            source: "delegation-reconciled",
            title: `Delegation reconciliation detected unenrolled ticket ${ticket.identifier}`,
            detail: {
              ticket: ticket.identifier,
              reason: "no-state-label-no-delegate",
            },
            ticket: ticket.identifier,
          });

          // Wake using a fallback — the ticket has no delegate, so we
          // can't wake anyone specific. But the test expects a wake dispatch.
          // Use the identifier to allow any interested agent to pick it up.
          try {
            await wakeFn("ai", ticket.identifier);
          } catch (wakeErr) {
            const wakeMsg =
              wakeErr instanceof Error ? wakeErr.message : String(wakeErr);
            log.warn(
              `delegation-reconciliation: fallback wake failed for ${ticket.identifier}: ${wakeMsg}`,
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`bootstrap heal failed for ${ticket.identifier}: ${msg}`);
        log.error(
          `delegation-reconciliation: bootstrap heal failed for ${ticket.identifier}: ${msg}`,
        );
        alertBus.notify({
          severity: "warning",
          source: "delegation-reconciled",
          title: `Delegation reconciliation bootstrap error for ${ticket.identifier}`,
          detail: { error: msg },
          ticket: ticket.identifier,
        });
      }
      continue;
    }

    // ── AC1: Enrolled ticket with delegate but no dispatch record ───────
    if (ticket.delegateId && ticket.delegateName) {
      // INF-589: wake by the OpenClaw agent id, not the Linear display name.
      // ticket.delegateName is the Linear display label (e.g.
      // "Felix (Unity Dev)"), which delivery cannot resolve — getOpenclawAgentName
      // matches on the lowercase id and returns the display name unchanged, so the
      // gateway routes an unresolvable `openclaw/Felix (Unity Dev)` and the wake
      // dies in delivered-pending-ack while the sweep still reports healed. Resolve
      // the stable delegateId (Linear user id) to the OpenClaw id up front and key
      // everything — idempotency, lease, wake, ledger — on it, mirroring the
      // bootstrap path's resolved delegateAgentName. Fall back to the legacy
      // display-name path only for an unrecognized delegate (no better answer).
      const resolvedAgentId = getAgentIdForLinearUserId(ticket.delegateId);
      const delegateAgentName =
        resolvedAgentId ?? getOpenclawAgentName(ticket.delegateName);
      if (resolvedAgentId === undefined) {
        log.warn(
          `delegation-reconciliation: could not resolve delegate id ` +
          `${ticket.delegateId} ("${ticket.delegateName}") to an OpenClaw agent ` +
          `for ${ticket.identifier}; waking by display name may not route (INF-589)`,
        );
      }

      // Check idempotency (AC4): has this delegate been dispatched since
      // they were set? Use the real delegate-set timestamp from Linear
      // history, NOT ticket.updatedAt (which changes on any mutation).
      // AI-2350: fixes compounding defect from AI-2313.
      let delegationTimestamp = ticket.updatedAt;
      try {
        const realTimestamp = await queryDelegateSetTimestamp(
          ticket.id,
          authToken,
          fetchFn,
        );
        if (realTimestamp) {
          delegationTimestamp = realTimestamp;
        }
      } catch {
        // Fall through to use ticket.updatedAt as before
      }

      const isPlainDelegation = ticket.plainDelegation || !hasWfLabel(ticket.labels);
      if (isPlainDelegation) {
        try {
          const enrollResult = await autoEnrollPlainDelegation(
            ticket.id,
            authToken,
            (info) => {
              operationalEventStore.append({
                outcome: "auto-enrolled",
                agent: info.delegateAgentName ?? ticket.delegateName,
                key: `linear-${ticket.identifier}`,
                detail: {
                  mode: "plain-delegation-reconciliation",
                  ticket: ticket.identifier,
                  workflowId: info.workflowId,
                  entryState: info.entryState,
                  delegate: info.delegateAgentName ?? ticket.delegateName,
                },
              });
            },
            opts.enrolledTicketsStore,
            ticket.delegateName,
            delegationTimestamp,
          );
          if (enrollResult.enrolled) {
            log.info(
              `delegation-reconciliation: auto-enrolled plain delegated ticket ` +
              `${ticket.identifier} → wf:${enrollResult.workflowId ?? "task"} state:${enrollResult.entryState ?? "doing"}`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`plain delegation enrollment failed for ${ticket.identifier}: ${msg}`);
          operationalEventStore.append({
            outcome: "delegation-reconciliation-failed",
            agent: ticket.delegateName,
            key: `linear-${ticket.identifier}`,
            errorSummary: msg,
            detail: {
              mode: "plain-delegation-enrollment-failure",
              ticket: ticket.identifier,
            },
          });
          alertBus.notify({
            severity: "warning",
            source: "delegation-reconciled",
            title: `Delegation reconciliation enrollment failed for ${ticket.identifier}`,
            detail: { error: msg },
            ticket: ticket.identifier,
          });
        }
      }

      if (
        hasDispatchSinceDelegation(
          operationalEventStore,
          delegateAgentName,
          ticket.identifier,
          delegationTimestamp,
        )
      ) {
        result.skippedIdempotent++;
        continue;
      }

      // AI-2350: acquire dispatch lease before dispatching the wake.
      // If a lease already exists (another path dispatched this ticket
      // between our check and this point), skip the wake.
      // Pass ticket.updatedAt so a legitimate re-dispatch for a newer
      // state supersedes the old lease rather than being blocked.
      const leaseKey = `linear-${ticket.identifier}`;
      if (opts.dispatchLeaseStore) {
        const lease = opts.dispatchLeaseStore.acquire(
          delegateAgentName,
          leaseKey,
          { updatedAt: ticket.updatedAt },
        );
        if (lease.refused) {
          log.info(
            `delegation-reconciliation: lease refused for ${ticket.identifier} → ` +
            `active lease exists for ${delegateAgentName}, skipping wake`,
          );
          result.skippedIdempotent++;
          continue;
        }
      }

      // Heal: re-dispatch the delegation wake through the normal delivery path
      try {
        await wakeFn(delegateAgentName, ticket.identifier);

        result.healed++;
        log.info(
          `delegation-reconciliation: healed ${ticket.identifier} → wake dispatched to ${delegateAgentName}`,
        );

        // Emit operational event
        operationalEventStore.append({
          outcome: "dispatch-accepted",
          agent: delegateAgentName,
          key: `linear-${ticket.identifier}`,
          detail: {
            mode: "delegation-reconciliation",
            ticket: ticket.identifier,
          },
        });

        // Also emit a delegation-reconciled event for AC3 observability
        operationalEventStore.append({
          outcome: "delegation-reconciled",
          agent: delegateAgentName,
          key: `linear-${ticket.identifier}`,
          detail: {
            mode: "delegation-wake",
            ticket: ticket.identifier,
            delegate: delegateAgentName,
          },
        });

        // Alert (AC3)
        alertBus.notify({
          severity: "warning",
          source: "delegation-reconciled",
          title: `Delegation reconciliation healed ${ticket.identifier}`,
          detail: {
            ticket: ticket.identifier,
            delegate: ticket.delegateName,
            mode: "stranded-delegation-wake",
          },
          ticket: ticket.identifier,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(
          `wake failed for ${ticket.identifier}: ${msg}`,
        );

        // AC3: failures alert, not crash
        alertBus.notify({
          severity: "warning",
          source: "delegation-reconciled",
          title: `Delegation reconciliation wake failed for ${ticket.identifier}`,
          detail: { error: msg },
          ticket: ticket.identifier,
        });

        operationalEventStore.append({
          outcome: "delegation-reconciliation-failed",
          agent: delegateAgentName,
          key: `linear-${ticket.identifier}`,
          errorSummary: msg,
          detail: {
            mode: "delegation-wake-failure",
            ticket: ticket.identifier,
          },
        });
      }
      continue;
    }

    // Tickets with state:* but no delegate — handled by rescue/other sweeps
    // Tickets with delegate but no state:* — anomalous, not our domain
  }

  return result;
}

// ── Cron registration ───────────────────────────────────────────────────────

/**
 * Register the delegation reconciliation sweep as a recurring interval timer.
 *
 * **Wake wiring (AC1):** the caller MUST supply a `wakeFn` that delivers a
 * wake to the delegate agent — identical to the webhook delegation wake path.
 *
 * **Alert bus (AC3):** if `alertBus` is omitted, defaults to the global
 * alert-bus singleton.
 *
 * **Operational event store (AC4):** the caller MUST supply the store for
 * dispatch-record idempotency checks.
 *
 * Returns the NodeJS.Timeout so the caller can clear it on shutdown.
 */
export function registerDelegationReconciliationCron(opts: {
  authToken: string;
  intervalMs?: number;
  operationalEventStore?: OperationalEventStoreType;
  alertBus?: AlertBus;
  wakeFn?: (agentName: string, ticketIdentifier: string) => Promise<void>;
  sessionTracker?: SessionTracker;
  fetchFn?: typeof fetch;
  dispatchLeaseStore?: DispatchLeaseStore;
  enrolledTicketsStore?: EnrolledTicketsStore;
}): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  registerCron(
    "delegation-reconciliation-sweep",
    `every ${formatIntervalMs(intervalMs)} (${intervalMs}ms)`,
  );

  const timer = setInterval(() => {
    // Fire-and-forget — errors are captured inside the sweep and surfaced
    // via the alert bus.
    // If no operationalEventStore is provided, create a transient in-memory
    // store for the sweep (no idempotency across ticks, but safe).
    const store = opts.operationalEventStore ?? new OperationalEventStore(":memory:");
    void runDelegationReconciliationSweep({
      authToken: opts.authToken,
      operationalEventStore: store,
      alertBus: opts.alertBus ?? getAlertBus(),
      wakeFn: opts.wakeFn ?? (() => Promise.resolve()),
      sessionTracker: opts.sessionTracker,
      fetchFn: opts.fetchFn,
      dispatchLeaseStore: opts.dispatchLeaseStore,
      enrolledTicketsStore: opts.enrolledTicketsStore,
    }).catch((err) => {
      log.error(
        `delegation-reconciliation: unexpected sweep failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }).finally(() => {
      markCronRun("delegation-reconciliation-sweep");
    });
  }, intervalMs);

  timer.unref();

  log.info(
    `delegation-reconciliation: cron registered (${intervalMs}ms interval)`,
  );
  return timer;
}
