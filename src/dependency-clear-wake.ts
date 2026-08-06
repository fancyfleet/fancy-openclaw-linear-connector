/**
 * INF-1297 — Dependency-clear wake.
 *
 * When a ticket reaches a terminal state, any downstream tickets that were
 * blocked by it should be re-evaluated for dispatch. Today the terminal-event
 * path prunes the terminal ticket and checks the parent barrier, but never
 * looks at *dependent* tickets — tickets that had a `blocked_by` relation
 * pointing at the now-terminal ticket.
 *
 * The periodic sweeps (stuck-delegate-detector, delegation-reconciliation)
 * skip blocked tickets entirely, so a downstream child whose blocker clears
 * stays idle until some other event happens to re-dispatch it. This module
 * closes that gap with an event-driven wake: on terminal, find tickets this
 * ticket was blocking, check if they're now unblocked, and dispatch.
 *
 * Fail-open: errors are logged and never block the terminal prune or barrier.
 */

import { componentLogger, createLogger } from "./logger.js";
import { isBlockedByOpenIssue, isTerminalIssueState } from "./linear-actionable.js";
import type { LinearIssueWithRelations } from "./linear-actionable.js";

const log = componentLogger(
  createLogger(process.env.LOG_LEVEL ?? "info"),
  "dependency-clear-wake",
);

const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Types ────────────────────────────────────────────────────────────────────

interface BlockedTicket {
  identifier: string;
  delegateId: string | null;
  delegateName: string | null;
  state: { name: string; type: string } | null;
  labels: string[];
  relations: LinearIssueWithRelations["relations"];
  inverseRelations: LinearIssueWithRelations["relations"];
}

export interface DependencyClearResult {
  /** Tickets that were blocked by the terminal ticket and are now unblocked. */
  unblocked: Array<{ identifier: string; delegateId: string | null; delegateName: string | null }>;
  /** Tickets still blocked by other open prerequisites. */
  stillBlocked: string[];
  /** Tickets with no delegate — cannot be woken. */
  noDelegate: string[];
  errors: number;
}

// ── Linear queries ───────────────────────────────────────────────────────────

/**
 * Fetch tickets that the given (now-terminal) ticket was blocking.
 *
 * Linear stores "A blocks B" as a single relation edge. When querying A,
 * it appears under `relations` with type=blocks and relatedIssue=B.
 * We query A's relations to find all B tickets it was blocking.
 */
async function fetchBlockedTickets(
  terminalIdentifier: string,
  authToken: string,
): Promise<BlockedTicket[]> {
  const authHeader = /^Bearer\s+/i.test(authToken) ? authToken : `Bearer ${authToken}`;

  // First, get the terminal ticket's outgoing "blocks" relations
  const query = `
    query BlockedByMe($id: String!) {
      issue(id: $id) {
        identifier
        relations(first: 50) {
          nodes {
            type
            relatedIssue {
              id
              identifier
              state { name type }
              delegate { id name }
              labels { nodes { name } }
              relations(first: 50) {
                nodes { type issue { id identifier state { name type } } relatedIssue { id identifier state { name type } } }
              }
              inverseRelations(first: 50) {
                nodes { type issue { id identifier state { name type } } relatedIssue { id identifier state { name type } } }
              }
            }
          }
        }
      }
    }
  `;

  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authHeader },
    body: JSON.stringify({ query, variables: { id: terminalIdentifier } }),
  });

  if (!res.ok) {
    throw new Error(`Linear API returned ${res.status}`);
  }

  const body = (await res.json()) as {
    data?: {
      issue?: {
        relations?: {
          nodes?: Array<{
            type?: string;
            relatedIssue?: {
              id?: string;
              identifier?: string;
              state?: { name: string; type: string } | null;
              delegate?: { id: string; name: string } | null;
              labels?: { nodes: Array<{ name: string }> };
              relations?: LinearIssueWithRelations["relations"];
              inverseRelations?: LinearIssueWithRelations["relations"];
            } | null;
          }>;
        };
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    throw new Error(`Linear API errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }

  const relations = body.data?.issue?.relations?.nodes ?? [];
  const blocked: BlockedTicket[] = [];

  for (const rel of relations) {
    const type = rel.type?.toLowerCase();
    if (type !== "blocks" && type !== "blocking") continue;

    const target = rel.relatedIssue;
    if (!target?.identifier) continue;

    // Skip already-terminal targets — no point waking a done ticket
    if (target.state && isTerminalIssueState(target.state)) continue;

    blocked.push({
      identifier: target.identifier,
      delegateId: target.delegate?.id ?? null,
      delegateName: target.delegate?.name ?? null,
      state: target.state ?? null,
      labels: (target.labels?.nodes ?? []).map((l) => l.name),
      relations: target.relations ?? null,
      inverseRelations: target.inverseRelations ?? null,
    });
  }

  return blocked;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Find tickets that were blocked by the now-terminal ticket and are no longer
 * blocked by any other open prerequisite. Returns the list of tickets that
 * should be re-dispatched to their delegates.
 *
 * This is a read-only evaluation — it does NOT dispatch. The caller is
 * responsible for adding tickets to the bag / sending wake signals.
 */
export async function findNewlyUnblockedTickets(
  terminalIdentifier: string,
  authToken: string,
): Promise<DependencyClearResult> {
  const result: DependencyClearResult = {
    unblocked: [],
    stillBlocked: [],
    noDelegate: [],
    errors: 0,
  };

  let blockedTickets: BlockedTicket[];
  try {
    blockedTickets = await fetchBlockedTickets(terminalIdentifier, authToken);
  } catch (err) {
    log.error(
      `dependency-clear-wake: failed to fetch blocked tickets for ${terminalIdentifier}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    result.errors++;
    return result;
  }

  if (blockedTickets.length === 0) {
    return result;
  }

  log.info(
    `dependency-clear-wake: ${terminalIdentifier} was blocking ${blockedTickets.length} ticket(s): ` +
    blockedTickets.map((t) => t.identifier).join(", "),
  );

  for (const ticket of blockedTickets) {
    // Check if still blocked by OTHER open prerequisites
    const issueForCheck: LinearIssueWithRelations = {
      identifier: ticket.identifier,
      relations: ticket.relations,
      inverseRelations: ticket.inverseRelations,
    } as LinearIssueWithRelations;

    if (isBlockedByOpenIssue(issueForCheck)) {
      log.info(
        `dependency-clear-wake: ${ticket.identifier} still blocked by another open prerequisite — skipping`,
      );
      result.stillBlocked.push(ticket.identifier);
      continue;
    }

    if (!ticket.delegateId) {
      log.info(
        `dependency-clear-wake: ${ticket.identifier} is unblocked but has no delegate — cannot wake`,
      );
      result.noDelegate.push(ticket.identifier);
      continue;
    }

    log.info(
      `dependency-clear-wake: ${ticket.identifier} is newly unblocked (delegate=${ticket.delegateName ?? ticket.delegateId})`,
    );
    result.unblocked.push({
      identifier: ticket.identifier,
      delegateId: ticket.delegateId,
      delegateName: ticket.delegateName,
    });
  }

  return result;
}
