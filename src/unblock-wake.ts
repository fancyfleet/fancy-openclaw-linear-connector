/**
 * INF-794 / INF-1297 — Unblock-wake fanout.
 *
 * When a blocker reaches Done/Canceled, Linear sends the webhook for the
 * blocker, not for each newly-unblocked target. This module fans out from the
 * blocker relation graph and synthesizes ordinary delegate/assignee routes for
 * live targets, so they pass through the normal (guarded) dispatch pipeline —
 * dispatch idempotency + durable lease checks in dispatchRoute.
 *
 * INF-1297 added the remaining-blocker guard: a target that is STILL blocked by
 * another open prerequisite must not be woken. The terminal event cleared one
 * blocker, but the target is not yet actionable, so waking it would dispatch an
 * agent into work it cannot start. We scan the target's own relation graph
 * (both directions) for any remaining non-terminal blocker via
 * isBlockedByOpenIssue.
 *
 * This is the SINGLE unblock-wake path. An earlier INF-1297 implementation
 * (dependency-clear-wake.ts) delivered wakes directly via deliverMessageToAgent,
 * bypassing dispatchRoute's idempotency/lease guards and duplicating the
 * INF-794 fanout; it was removed in favor of consolidating here.
 *
 * Dependencies are injectable for unit testing (the webhook module that calls
 * this is too heavy to import in tests).
 */

import { componentLogger, createLogger } from "./logger.js";
import { LINEAR_API_URL } from "./linear-helpers.js";
import { normalizeSessionKey } from "./session-key.js";
import {
  isTerminalIssueEvent,
  issueIdentifierFromEvent,
  isBlockedByOpenIssue,
} from "./linear-actionable.js";
import type { LinearIssueWithRelations } from "./linear-actionable.js";
import type { LinearEvent } from "./webhook/schema.js";
import type { RouteResult } from "./types.js";
import { buildAgentMap, getOpenclawAgentName } from "./agents.js";
import { resolveServiceCredential } from "./service-credential.js";

const log = componentLogger(
  createLogger(process.env.LOG_LEVEL ?? "info"),
  "unblock-wake",
);

/** In-memory claim set to suppress duplicate fanout within a process lifetime. */
const unblockWakeClaims = new Set<string>();

/** Injectable dependencies (production defaults; overridden in tests). */
export interface UnblockWakeDeps {
  fetchFn: typeof globalThis.fetch;
  resolveToken: () => string | undefined;
  agentMap: () => Record<string, string>;
  openclawName: (agentName: string) => string;
}

const defaultDeps: UnblockWakeDeps = {
  fetchFn: (...args) => globalThis.fetch(...args),
  resolveToken: () => resolveServiceCredential() || undefined,
  agentMap: () => buildAgentMap(),
  openclawName: (name) => getOpenclawAgentName(name),
};

function authHeaderForLinear(token: string): string {
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function terminalEventUpdatedAt(event: LinearEvent): string {
  const data = (event.data as Record<string, unknown> | undefined) ?? {};
  return (data.updatedAt as string | undefined) ?? event.createdAt ?? "unknown";
}

function sameLinearIssueRef(a: Record<string, unknown> | null | undefined, b: Record<string, unknown>): boolean {
  if (!a) return false;
  return Boolean(
    (typeof a.id === "string" && typeof b.id === "string" && a.id === b.id) ||
    (typeof a.identifier === "string" && typeof b.identifier === "string" && a.identifier === b.identifier),
  );
}

function isDoneOrCanceledState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  const record = state as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
  return type === "completed" || type === "canceled" || type === "cancelled" ||
    name === "done" || name === "canceled" || name === "cancelled";
}

function syntheticUnblockEvent(target: Record<string, unknown>, blocker: Record<string, unknown>, sourceEvent: LinearEvent): LinearEvent {
  const now = new Date().toISOString();
  const targetIdentifier = target.identifier as string | undefined;
  const team = target.team as Record<string, unknown> | undefined;
  const state = target.state as Record<string, unknown> | undefined;
  return {
    type: "Issue",
    action: "update",
    createdAt: now,
    actor: sourceEvent.actor,
    data: {
      ...target,
      identifier: targetIdentifier,
      updatedAt: (target.updatedAt as string | undefined) ?? now,
      state: {
        id: (state?.id as string | undefined) ?? "unknown",
        name: (state?.name as string | undefined) ?? "unknown",
        type: (state?.type as string | undefined) ?? "unknown",
      },
      priority: (target.priority as number | undefined) ?? 0,
      priorityLabel: (target.priorityLabel as string | undefined) ?? "No priority",
      teamId: (team?.id as string | undefined) ?? "unknown",
      teamKey: (team?.key as string | undefined) ?? "",
      labelIds: Array.isArray(target.labelIds) ? target.labelIds : [],
      url: (target.url as string | undefined) ?? "",
      createdAt: (target.createdAt as string | undefined) ?? now,
    },
    updatedFrom: {
      blockedBy: String(blocker.identifier ?? blocker.id ?? "unknown"),
    },
    raw: { synthetic: "unblock-wake", source: sourceEvent.raw },
  } as unknown as LinearEvent;
}

/**
 * Build wake routes for tickets newly unblocked by a terminal blocker event.
 * Read-only evaluation + route construction; the caller dispatches each route
 * through dispatchRoute (the guarded pipeline).
 */
export async function findUnblockWakeRoutesForTerminalIssue(
  event: LinearEvent,
  deps: UnblockWakeDeps = defaultDeps,
): Promise<RouteResult[]> {
  if (!isTerminalIssueEvent(event)) return [];
  const blocker = ((event.data as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const blockerId = blocker.id as string | undefined;
  const blockerIdentifier = issueIdentifierFromEvent(event);
  const blockerLookup = blockerId ?? blockerIdentifier;
  if (!blockerLookup || !isDoneOrCanceledState(blocker.state)) return [];

  const token = deps.resolveToken();
  if (!token) return [];

  const response = await deps.fetchFn(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeaderForLinear(token),
    },
    body: JSON.stringify({
      query: `query BlockedTargets($id: String!) {
        issue(id: $id) {
          id identifier
          relations(first: 50) {
            nodes {
              type
              issue { id identifier }
              relatedIssue {
                id identifier title url priority priorityLabel createdAt updatedAt
                state { id name type }
                team { id key }
                labelIds
                delegate { id name app }
                assignee { id name app }
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
      }`,
      variables: { id: blockerLookup },
    }),
  });
  if (!response.ok) {
    log.warn(`Blocked-target lookup failed for ${blockerIdentifier ?? blockerLookup}: HTTP ${response.status}`);
    return [];
  }
  const body = await response.json() as {
    data?: { issue?: { id?: string; identifier?: string; relations?: { nodes?: Array<Record<string, unknown>> | null } | null } | null };
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) {
    log.warn(`Blocked-target lookup errored for ${blockerIdentifier ?? blockerLookup}: ${body.errors.map((e) => e.message).join("; ")}`);
    return [];
  }

  const sourceIssue = {
    id: body.data?.issue?.id ?? blockerId,
    identifier: body.data?.issue?.identifier ?? blockerIdentifier,
  } as Record<string, unknown>;
  const agentMap = deps.agentMap();
  const routes: RouteResult[] = [];
  for (const rel of body.data?.issue?.relations?.nodes ?? []) {
    const type = typeof rel.type === "string" ? rel.type.toLowerCase() : "";
    if (type !== "blocks" && type !== "blocking") continue;
    const issue = rel.issue as Record<string, unknown> | null | undefined;
    if (!sameLinearIssueRef(issue, sourceIssue)) continue;
    const target = rel.relatedIssue as Record<string, unknown> | null | undefined;
    const targetIdentifier = target?.identifier as string | undefined;
    if (!target || !targetIdentifier) continue;

    // INF-1297: do not wake a target that is still blocked by ANOTHER open
    // prerequisite. The terminal event cleared this blocker, but if a second
    // blocker is still open the target is not actually actionable — waking it
    // would dispatch an agent into work it cannot start. Scan the target's own
    // relation graph (both directions) for any remaining non-terminal blocker.
    if (isBlockedByOpenIssue(target as unknown as LinearIssueWithRelations)) {
      log.info(
        `unblock-wake: ${targetIdentifier} still blocked by another open prerequisite ` +
        `(terminal ${sourceIssue.identifier ?? blockerLookup} cleared) — skipping wake`,
      );
      continue;
    }

    const delegate = target.delegate as { id?: string } | null | undefined;
    const assignee = target.assignee as { id?: string } | null | undefined;
    const delegateAgent = delegate?.id ? agentMap[delegate.id] : undefined;
    const assigneeAgent = assignee?.id ? agentMap[assignee.id] : undefined;
    const agentId = delegateAgent ?? assigneeAgent;
    const routingReason = delegateAgent ? "delegate" : assigneeAgent ? "assignee" : undefined;
    if (!agentId || !routingReason) continue;

    const claimKey = [
      sourceIssue.identifier ?? sourceIssue.id ?? blockerLookup,
      terminalEventUpdatedAt(event),
      targetIdentifier,
      agentId,
    ].join("->");
    if (unblockWakeClaims.has(claimKey)) continue;
    unblockWakeClaims.add(claimKey);

    const targetEvent = syntheticUnblockEvent(target, sourceIssue, event);
    routes.push({
      agentId: deps.openclawName(agentId),
      sessionKey: normalizeSessionKey(targetIdentifier),
      priority: 0,
      routingReason,
      event: targetEvent,
    });
  }
  return routes;
}

/** Test-only: clear the in-memory claim set between tests. */
export function __resetUnblockWakeClaimsForTest(): void {
  unblockWakeClaims.clear();
}
