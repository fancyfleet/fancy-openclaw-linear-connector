import crypto from "crypto";
import { Router, Request, Response } from "express";
import { verifyLinearSignatureMulti, parseWebhookSecrets } from "./signature.js";
import { normalizeLinearEvent } from "./normalize.js";
import type { LinearEvent } from "./schema.js";
import { EventStore } from "../store/event-store.js";
import { NudgeStore } from "../store/nudge-store.js";
import type { OperationalEventInput, OperationalEventStore } from "../store/operational-event-store.js";
import type { DeadLetterQueueStore } from "../dead-letter-queue.js";
import type { EnrolledTicketsStore } from "../store/enrolled-tickets-store.js";
import type { MutationAuditStore } from "../store/mutation-audit-store.js";
import type { DispatchIdempotencyStore } from "../store/dispatch-idempotency-store.js";
import type { DispatchLeaseStore } from "../store/dispatch-lease-store.js";
import type { DispatchInFlightStore } from "../store/dispatch-inflight-store.js";
import type { SessionSpawnIdempotencyStore } from "../store/session-spawn-idempotency-store.js";
import { extractWebhookMutations } from "./mutation-extraction.js";
import { routeEvent, routeEventAll, unresolvedRoutingCandidates } from "../router.js";
import { createSessionAndEmitThought, emitResponse } from "../agent-session.js";
import { deliverToAgent, DeliveryThrottle, type DeliveryConfig, assertDispatchTargetFetchable } from "../delivery/index.js";
import { markDispatchIntegrityGateActive } from "../dispatch-integrity-state.js";
import {
  checkBreaker,
  recordDispatch,
  checkCommentFedSuppressionForTicket,
} from "../dispatch-circuit-breaker.js";
import type { RouteResult } from "../types.js";
import { normalizeSessionKey } from "../session-key.js";
import { buildAgentMap, getAgent, getAccessToken, getOpenclawAgentName, getAgents } from "../agents.js";
import { checkAgentLiveness, type LivenessConfig } from "../liveness.js";
import { emitDelegateUnavailable } from "../escalation.js";
import { checkRoleGuardAndBlock, type LinearUserIdResolver } from "../routing-guard.js";
import { fetchWorkflowLabels, enrollIfMissing, autoEnrollByTeam, autoEnrollPlainDelegation, markAutoEnrollRegistered, markCommitmentActivityObserverRegistered, applyStateTransition, type WorkflowInstanceContext } from "../workflow-gate.js";
import { checkLabelSyncForTicket, emitLabelSyncWarning } from "../transition-audit.js";
import { AgentQueue } from "../queue/index.js";
import { PendingWorkBag, SessionTracker, resignalPendingTickets, type NoActivityDetector } from "../bag/index.js";
import { type WakeUpConfig } from "../bag/wake-up.js";
import { createLogger, componentLogger } from "../logger.js";
import { checkLinearIssueRouting, isTerminalIssueEvent, issueIdentifierFromEvent } from "../linear-actionable.js";
import { onChildTerminal } from "../barrier.js";
import { maybeBootstrapWorkflow } from "../workflow-bootstrap.js";
import { notify } from "../alerts/alert-bus.js";
import { loadKnownHumans } from "../known-humans.js";
import { emitStreamTopic } from "../admin-stream.js";
import { DelegatePingPongDetector, shouldCheckDelegatePingPong } from "../delegate-ping-pong-detector.js";
import type { DispatchRecordStore } from "../liveness-channel/dispatch-record-store.js";
import type { GatewayDispatchAck } from "../liveness-channel/gateway-ack-types.js";
import { extractRejectedWebhookDiagnostic, WebhookSecretDriftTracker } from "./drift.js";

const log = componentLogger(createLogger(), "webhook");

export type { LinearEvent } from "./schema.js";
export { verifyLinearSignature } from "./signature.js";
export { normalizeLinearEvent } from "./normalize.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function deriveWorkflowInstanceContextFromRoute(route: RouteResult, issueIdentifier: string): WorkflowInstanceContext {
  const data = asRecord(route.event.data) ?? {};
  const sessionData = asRecord(data.agentSession);
  const issueData = asRecord(data.issue ?? sessionData?.issue ?? data) ?? {};
  const team = asRecord(issueData.team);
  const enrollment = asRecord(issueData.workflowEnrollment);
  return {
    issueIdentifier,
    teamKey: typeof team?.key === "string" ? team.key : undefined,
    teamName: typeof team?.name === "string" ? team.name : undefined,
    workflowEnrollment: enrollment
      ? {
          department: typeof enrollment.department === "string" ? enrollment.department : undefined,
          team: typeof enrollment.team === "string" ? enrollment.team : undefined,
          charterRef: typeof enrollment.charterRef === "string" ? enrollment.charterRef : undefined,
        }
      : undefined,
  };
}

function signatureRejectedDetail(rawBody: Buffer | undefined, secretCount: number): Record<string, unknown> {
  return {
    ...extractRejectedWebhookDiagnostic(rawBody),
    loadedHmacCount: secretCount,
  };
}

/**
 * Creates the Express router for the Linear webhook endpoint.
 *
 * The router expects that the parent Express app has been configured to
 * preserve the raw body buffer on `req.rawBody` via `express.raw()` for this
 * route — signature validation requires the exact bytes as received.
 *
 * Environment variables consumed:
 *   LINEAR_WEBHOOK_SECRETS — comma-separated list of HMAC secrets (new, supports private teams)
 *   LINEAR_WEBHOOK_SECRET  — single HMAC secret (legacy, backward compatible)
 */
const NUDGE_DEDUP_WINDOW_MS = parseInt(process.env.NUDGE_DEDUP_WINDOW_MS ?? "120000", 10);

function errorSummary(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function appendOperationalEvent(store: OperationalEventStore | undefined, input: OperationalEventInput): void {
  if (!store) return;
  try { store.append(input); } catch (err) { log.error(`Operational event write failed: ${errorSummary(err)}`); }
}

const unblockWakeClaims = new Set<string>();

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
 * INF-794 AC2/AC3: when a blocker reaches Done/Canceled, Linear sends the
 * webhook for the blocker, not for each newly-unblocked target. Fan out from
 * the blocker relation graph and synthesize ordinary delegate/assignee routes
 * for live targets, so they pass through the normal dispatch pipeline.
 */
export async function findUnblockWakeRoutesForTerminalIssue(event: LinearEvent): Promise<RouteResult[]> {
  if (!isTerminalIssueEvent(event)) return [];
  const blocker = ((event.data as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const blockerId = blocker.id as string | undefined;
  const blockerIdentifier = issueIdentifierFromEvent(event);
  const blockerLookup = blockerId ?? blockerIdentifier;
  if (!blockerLookup || !isDoneOrCanceledState(blocker.state)) return [];

  const token = getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
  if (!token) return [];

  const response = await fetch("https://api.linear.app/graphql", {
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
  const agentMap = buildAgentMap();
  const routes: RouteResult[] = [];
  for (const rel of body.data?.issue?.relations?.nodes ?? []) {
    const type = typeof rel.type === "string" ? rel.type.toLowerCase() : "";
    if (type !== "blocks" && type !== "blocking") continue;
    const issue = rel.issue as Record<string, unknown> | null | undefined;
    if (!sameLinearIssueRef(issue, sourceIssue)) continue;
    const target = rel.relatedIssue as Record<string, unknown> | null | undefined;
    const targetIdentifier = target?.identifier as string | undefined;
    if (!target || !targetIdentifier) continue;

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
      agentId: getOpenclawAgentName(agentId),
      sessionKey: normalizeSessionKey(targetIdentifier),
      priority: 0,
      routingReason,
      event: targetEvent,
    });
  }
  return routes;
}

function labelNamesFromUnknown(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((label) => {
        if (typeof label === "string") return label;
        if (label && typeof label === "object") {
          const name = (label as { name?: unknown }).name;
          return typeof name === "string" ? name : null;
        }
        return null;
      })
      .filter((name): name is string => Boolean(name));
  }
  if (typeof value === "object") {
    const nodes = (value as { nodes?: unknown }).nodes;
    return labelNamesFromUnknown(nodes);
  }
  return [];
}

function resolveWorkflowStateFromEvent(event: LinearEvent): {
  workflowState: string | null;
  source: "state-label" | "native-state" | null;
  nativeState: string | null;
  staleNativeState: string | null;
} {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const rawData = ((event.raw as { data?: unknown } | undefined)?.data ?? {}) as Record<string, unknown>;
  const labelNames = [
    ...labelNamesFromUnknown(data.labels),
    ...labelNamesFromUnknown(rawData.labels),
  ];
  const stateLabel = labelNames
    .find((label) => /^state:/i.test(label))
    ?.slice("state:".length)
    .toLowerCase() ?? null;
  const nativeName = (() => {
    const state = data.state as { name?: unknown } | undefined;
    return typeof state?.name === "string" && state.name.trim() ? state.name : null;
  })();
  const nativeSlug = nativeName?.trim().toLowerCase().replace(/\s+/g, "-") ?? null;

  if (stateLabel) {
    return {
      workflowState: stateLabel,
      source: "state-label",
      nativeState: nativeName,
      staleNativeState: nativeSlug && nativeSlug !== stateLabel ? nativeName : null,
    };
  }
  if (nativeSlug) {
    return {
      workflowState: nativeSlug,
      source: "native-state",
      nativeState: nativeName,
      staleNativeState: null,
    };
  }
  return { workflowState: null, source: null, nativeState: null, staleNativeState: null };
}

async function checkDelegatePingPong(
  event: LinearEvent,
  detector: DelegatePingPongDetector,
): Promise<boolean> {
  if (event.type !== "Issue" || event.action !== "update") return false;
  const updatedFrom = (event as { updatedFrom?: Record<string, unknown> }).updatedFrom;
  if (!shouldCheckDelegatePingPong(updatedFrom)) return false;

  const data = (event as { data?: Record<string, unknown> }).data;
  const delegate = data?.delegate as { id?: string; name?: string } | null | undefined;
  const delegateId = delegate?.id;
  if (!delegateId) return false;

  const ticketId = issueIdentifierFromEvent(event) ?? (data?.id as string | undefined);
  if (!ticketId) return false;

  const mappedAgentName = buildAgentMap()[delegateId];
  const agentName = mappedAgentName ? getOpenclawAgentName(mappedAgentName) : delegate.name ?? delegateId;

  try {
    const result = await detector.checkAndHandle(ticketId, delegateId, agentName);
    if (result.suppressDispatch) {
      log.warn(
        `Delegate ping-pong cycle detected for ${ticketId}; suppressing dispatch ` +
        `and escalating to ${result.escalation?.escalatedTo ?? "ai"}`,
      );
      return true;
    }
  } catch (err) {
    log.warn(`Delegate ping-pong check failed (fail-open): ${errorSummary(err)}`);
  }
  return false;
}

/**
 * Rebuild WS1 (2026-07-03, pilot finding): Comment webhooks carry no delegate,
 * so "a comment wakes the ticket's delegate" NEVER worked — every plain
 * comment no-routed (verified live: AI-1755/AI-1756). Before routing, fetch
 * the issue's delegate/assignee and graft them onto event.data so the
 * standard sync router path (delegate → assignee → mention) applies.
 * Fail-open: on any error the event routes as before (mentions still work).
 */
export async function enrichCommentEventForRouting(event: LinearEvent): Promise<void> {
  if (event.type !== "Comment") return;
  const data = (event as { data?: Record<string, unknown> }).data;
  if (!data || data.delegate || data.assignee) return;
  const issueId = (data.issueId as string) || ((data.issue as Record<string, unknown> | undefined)?.id as string);
  if (!issueId) return;
  const token = (() => {
    for (const a of getAgents()) {
      const t = getAccessToken(a.name);
      if (t) return t;
    }
    return undefined;
  })();
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: token.startsWith("Bearer") ? token : `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        query: `query CommentRouting($id: String!) { issue(id: $id) { identifier delegate { id } assignee { id } } }`,
        variables: { id: issueId },
      }),
    });
    const json = (await res.json()) as { data?: { issue?: { identifier?: string | null; delegate?: { id: string } | null; assignee?: { id: string } | null } } };
    const issue = json.data?.issue;
    if (issue?.delegate?.id) data.delegate = { id: issue.delegate.id };
    if (issue?.assignee?.id) data.assignee = { id: issue.assignee.id };
    // AI-1766 AC2: stamp the human-readable identifier so a later no-route
    // operational event is keyed AI-nnnn instead of a raw issue UUID.
    if (issue?.identifier && !data.identifier && !data.issueIdentifier) data.issueIdentifier = issue.identifier;
    if (issue?.delegate?.id || issue?.assignee?.id) {
      log.info(`Comment routing enrichment: issue ${issueId} delegate=${issue?.delegate?.id ?? "none"} assignee=${issue?.assignee?.id ?? "none"}`);
    }
  } catch (err) {
    log.warn(`Comment routing enrichment failed (fail-open): ${errorSummary(err)}`);
  }
}

function acknowledgeAgentAuthoredActivity(
  event: LinearEvent,
  onAgentActivity?: (agentId: string, ticketId: string) => void,
): void {
  if (!onAgentActivity) return;
  // Only genuine human-visible authored content (comments, agent session events)
  // triggers the Doing-flip. Issue state/label updates are connector facet writes
  // that must not echo back as activity signals (AI-1564).
  if (event.type !== "Comment" && event.type !== "AgentSessionEvent") return;
  const actorId = event.actor?.id;
  if (!actorId) return;

  const agentName = buildAgentMap()[actorId];
  if (!agentName) return;

  const identifier = issueIdentifierFromEvent(event);
  if (!identifier) return;

  const agentId = getOpenclawAgentName(agentName);
  const ticketId = normalizeSessionKey(identifier);
  onAgentActivity(agentId, ticketId);
  log.info(`Agent-authored Linear activity acknowledged: ${agentId} [${ticketId}]`);
}

const commitmentAutoAcceptClaims = new Set<string>();

async function autoAcceptCommitmentOnActivity(
  event: LinearEvent,
  operationalEventStore?: OperationalEventStore,
): Promise<void> {
  if (event.type !== "Comment" && event.type !== "AgentSessionEvent") return;
  const actorId = event.actor?.id;
  if (!actorId) return;
  const agentName = buildAgentMap()[actorId];
  if (!agentName) return;
  const bodyId = getOpenclawAgentName(agentName);
  const data = (event as { data?: Record<string, unknown> }).data;
  const issue = data?.issue as Record<string, unknown> | undefined;
  const sessionIssue = ((data?.agentSession as Record<string, unknown> | undefined)?.issue ?? {}) as Record<string, unknown>;
  const issueId =
    (issue?.id as string | undefined) ??
    (data?.issueId as string | undefined) ??
    (sessionIssue.id as string | undefined) ??
    issueIdentifierFromEvent(event);
  if (!issueId) return;
  const claimKey = issueIdentifierFromEvent(event) ?? issueId;
  if (commitmentAutoAcceptClaims.has(claimKey)) return;
  commitmentAutoAcceptClaims.add(claimKey);
  const token = getAccessToken(bodyId) ?? getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
  if (!token) {
    commitmentAutoAcceptClaims.delete(claimKey);
    return;
  }
  try {
    const result = await applyStateTransition("accept", issueId, token, {
      bodyId,
      operationalEventStore,
      commitmentAutoAccept: true,
    });
    if (result.status === "applied") {
      log.info(`Commitment gate auto-accepted ${issueIdentifierFromEvent(event) ?? issueId} on ${event.type} activity`);
    }
    if (
      result.status !== "applied" &&
      result.code !== "commitment-exit-already-recorded" &&
      result.code !== "delegate-unresolved"
    ) {
      commitmentAutoAcceptClaims.delete(claimKey);
    }
  } catch (err) {
    commitmentAutoAcceptClaims.delete(claimKey);
    log.warn(`Commitment gate auto-accept failed (fail-open): ${errorSummary(err)}`);
  }
}

/** Wrap deliverToAgent with the global concurrent-dispatch semaphore. */
async function deliverWithSlot(
  route: RouteResult,
  config: DeliveryConfig,
  throttle?: DeliveryThrottle,
  dispatchLeaseStore?: DispatchLeaseStore,
  dispatchInFlightStore?: DispatchInFlightStore,
  sessionSpawnStore?: SessionSpawnIdempotencyStore,
): Promise<Awaited<ReturnType<typeof deliverToAgent>>> {
  if (throttle) await throttle.acquireSlot();
  try {
    return await deliverToAgent(route, config, dispatchLeaseStore, dispatchInFlightStore, sessionSpawnStore);
  } finally {
    if (throttle) throttle.releaseSlot();
  }
}

export function createWebhookRouter(
  eventStore?: EventStore,
  nudgeStore?: NudgeStore,
  agentQueue?: AgentQueue,
  bag?: PendingWorkBag,
  sessionTracker?: SessionTracker,
  throttle?: DeliveryThrottle,
  operationalEventStore?: OperationalEventStore,
  deadLetterQueue?: DeadLetterQueueStore,
  onDispatched?: (agentId: string, ticketId: string) => void,
  onAgentActivity?: (agentId: string, ticketId: string) => void,
  onDeliveryCommitted?: (agentId: string, ticketId: string) => void,
  enrolledTicketsStore?: EnrolledTicketsStore,
  mutationAuditStore?: MutationAuditStore,
  idempotencyStore?: DispatchIdempotencyStore,
  dispatchLeaseStore?: DispatchLeaseStore,
  livenessDispatchStore?: Pick<DispatchRecordStore, "recordDispatch" | "recordAck" | "getDispatch">,
  dispatchInFlightStore?: DispatchInFlightStore,
  sessionSpawnStore?: SessionSpawnIdempotencyStore,
  noActivityDetector?: Pick<NoActivityDetector, "recordAdmissionDeferral">,
): Router {
  const router = Router();
  const delegatePingPongDetector = new DelegatePingPongDetector(undefined, undefined, operationalEventStore);
  const webhookSecretDriftTracker = new WebhookSecretDriftTracker();

  // AI-2091 §2/§9 (G2): the delivery-time fetchability gate is wired into the
  // PRIMARY dispatch path (dispatchRoute → checkLinearIssueRouting →
  // assertDispatchTargetFetchable) right here, not just the C4 re-poke path.
  // Mark it live at the wiring site so /health.dispatchIntegrity reflects the
  // real installation rather than a hardcoded bootstrap literal (the AI-1808
  // dead-code guard).
  markDispatchIntegrityGateActive(
    "phantomFetchabilityGate",
    "primary webhook dispatch path (dispatchRoute → assertDispatchTargetFetchable)",
  );
  markAutoEnrollRegistered();
  markCommitmentActivityObserverRegistered();
  markDispatchIntegrityGateActive(
    "deliveryTimeRecipientResolution",
    "primary webhook dispatch path (dispatchRoute → roster-based recipient validation, AI-2192)",
  );

  if (NUDGE_DEDUP_WINDOW_MS > 0) {
    log.info(`Nudge dedup enabled: ${NUDGE_DEDUP_WINDOW_MS}ms window`);
  }

  router.get("/", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "fancy-openclaw-linear-connector" });
  });

  router.post(
    "/",
    async (req: Request, res: Response): Promise<void> => {
      const secrets = parseWebhookSecrets();

      // ── 1. Debug: log relevant headers ──────────────────────────────────
      log.info(`Webhook received. Headers: ${JSON.stringify(Object.keys(req.headers).filter(h => h.startsWith('x-') || h.startsWith('linear')))} `);
      log.info(`linear-event header: ${req.headers["linear-event"] || "(missing)"}`);
      log.info(`linear-timestamp header: ${req.headers["linear-timestamp"] || "(missing)"}`);
      appendOperationalEvent(operationalEventStore, { outcome: "received", type: typeof req.headers["linear-event"] === "string" ? req.headers["linear-event"] : null, detail: { headers: req.headers } });

      // ── 2. Get raw body ────────────────────────────────────────────────────
      const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;
      log.info(`Raw body length: ${rawBody?.length || 0} bytes`);

      // ── 3. Signature validation (skip if no secret configured) ────────────
      if (secrets.length > 0) {
        const signature = req.headers["x-linear-signature"] ?? req.headers["linear-signature"];
        if (!signature || typeof signature !== "string") {
          appendOperationalEvent(operationalEventStore, {
            outcome: "signature-rejected",
            errorSummary: "Missing signature header",
            detail: signatureRejectedDetail(rawBody, secrets.length),
          });
          res.status(400).json({
            error: "Missing signature header",
          });
          return;
        }

        if (!rawBody) {
          res.status(400).json({ error: "Empty or unreadable request body" });
          return;
        }

        const signatureValid = verifyLinearSignatureMulti(rawBody, signature as string, secrets);
      log.info(`Signature validation result: ${signatureValid ? "valid" : "invalid"}`);
        if (!signatureValid) {
          const diagnostic = extractRejectedWebhookDiagnostic(rawBody);
          appendOperationalEvent(operationalEventStore, {
            outcome: "signature-rejected",
            type: diagnostic.type,
            key: diagnostic.teamKey && diagnostic.webhookId ? `${diagnostic.teamKey}:${diagnostic.webhookId}` : diagnostic.webhookId ?? diagnostic.teamKey,
            errorSummary: "Invalid signature",
            detail: { ...diagnostic, loadedHmacCount: secrets.length },
          });
          webhookSecretDriftTracker.record({ diagnostic, secretCount: secrets.length });
          res.status(401).json({ error: "Invalid signature" });
          return;
        }
      } else {
        log.warn("No LINEAR_WEBHOOK_SECRETS or LINEAR_WEBHOOK_SECRET set — skipping signature validation");
      }

      // ── 4. Parse JSON payload ─────────────────────────────────────────────
      let payload: unknown;
      try {
        const body = rawBody ?? Buffer.from(JSON.stringify(req.body));
        payload = JSON.parse(body.toString("utf8"));
      log.info("JSON parsed successfully");
      } catch {
        res.status(400).json({ error: "Malformed JSON payload" });
        return;
      }

      // ── 6. Normalize event ────────────────────────────────────────────────
      let event: LinearEvent;
      try {
        event = normalizeLinearEvent(payload);
      log.info(`Event normalized: type=${event.type}`);
        appendOperationalEvent(operationalEventStore, { outcome: "normalized", type: event.type, detail: { action: event.action } });
      } catch (err) {
        res.status(400).json({
          error: "Invalid payload structure",
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // ── 7. Deduplication ──────────────────────────────────────────────────
      const deliveryId =
        (req.headers["x-linear-delivery"] as string | undefined) ??
        crypto.createHash("sha256").update(rawBody ?? Buffer.from(JSON.stringify(payload))).digest("hex");

      if (eventStore?.isDuplicate(deliveryId)) {
      log.info(`Checking duplicate for delivery: ${deliveryId}`);
        appendOperationalEvent(operationalEventStore, { outcome: "duplicate", type: event.type, key: deliveryId });
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      // ── 8. Acknowledge immediately ────────────────────────────────────────
      res.status(200).json({ ok: true });
      emitStreamTopic("events");

      // Record event for dedup & restart recovery
      eventStore?.recordEvent(deliveryId, payload as object);

      // AI-1838: Audit-log state/label/delegate changes from the webhook
      // payload for the out-of-band reconcile sweep. Every mutation Linear
      // tells us about gets a durable audit record.
      if (mutationAuditStore) {
        try {
          const mutations = extractWebhookMutations(event, deliveryId);
          if (mutations.length > 0) {
            mutationAuditStore.appendBatch(mutations);
          }
        } catch (err) {
          log.warn(`mutation audit extraction failed (non-blocking): ${errorSummary(err)}`);
        }
      }

      // ── 9. Route to agent ─────────────────────────────────────────────────
      log.info(`Normalized event: type=${event.type} hasData=${"data" in event} dataKeys=${event.data ? Object.keys(event.data as object).join(',') : 'none'}`);

      if (isTerminalIssueEvent(event)) {
        const identifier = issueIdentifierFromEvent(event);
        if (identifier) {
          const sessionKey = normalizeSessionKey(identifier);
          const removedBag = bag?.removeTicketForAllAgents(sessionKey) ?? 0;
          const removedQueued = sessionTracker?.removePendingTicket(sessionKey) ?? 0;
          log.info(
            `Terminal issue event for ${sessionKey}: pruned ${removedBag} pending bag entr${removedBag === 1 ? "y" : "ies"}` +
            ` and ${removedQueued} queued signal${removedQueued === 1 ? "" : "s"}; skipping agent dispatch`,
          );
          appendOperationalEvent(operationalEventStore, { outcome: "terminal-pruned", type: event.type, key: sessionKey, sessionKey, detail: { removedBag, removedQueued } });

          try {
            const unblockRoutes = await findUnblockWakeRoutesForTerminalIssue(event);
            for (const unblockRoute of unblockRoutes) {
              try {
                await dispatchRoute(unblockRoute);
              } catch (err) {
                log.error(
                  `unblock dispatchRoute failed for ${unblockRoute.agentId} [${unblockRoute.sessionKey}]: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
            if (unblockRoutes.length > 0) {
              appendOperationalEvent(operationalEventStore, {
                outcome: "unblock-wake-dispatched" as never,
                type: event.type,
                key: sessionKey,
                sessionKey,
                detail: { count: unblockRoutes.length, targets: unblockRoutes.map((r) => r.sessionKey) },
              });
            }
          } catch (err) {
            log.warn(`Blocked-target wake fanout failed for terminal ${sessionKey}: ${errorSummary(err)}`);
          }

          // Phase 5 / B-3: Barrier (N→1) — event-driven parent auto-advance.
          // When a child reaches a terminal state, check if all siblings are
          // terminal and auto-advance the parent managing → review.
          // Fail-open: barrier errors are logged and never block the terminal prune.
          const barrierToken = getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
          if (barrierToken) {
            onChildTerminal(identifier, barrierToken).then((result) => {
              if (result?.transitioned) {
                log.info(`Barrier: auto-advanced parent of ${identifier} managing → review`);
              }
            }).catch((err) => {
              log.warn(`Barrier check failed for terminal child ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        } else {
          log.info("Terminal issue event without identifier; skipping agent dispatch");
        }
        return;
      }

      acknowledgeAgentAuthoredActivity(event, onAgentActivity);
      await autoAcceptCommitmentOnActivity(event, operationalEventStore);

      // AI-2350: Renew dispatch lease on agent activity (comment posted,
      // agent session event). This extends the lease TTL so long-running
      // sessions don't lose their re-dispatch protection.
      if (dispatchLeaseStore && (event.type === "Comment" || event.type === "AgentSessionEvent")) {
        const actorId = event.actor?.id;
        if (actorId) {
          const agentName = buildAgentMap()[actorId];
          if (agentName) {
            const leaseAgentId = getOpenclawAgentName(agentName);
            const leaseIdentifier = issueIdentifierFromEvent(event);
            if (leaseIdentifier) {
              const leaseTicketKey = normalizeSessionKey(leaseIdentifier);
              dispatchLeaseStore.renew(leaseAgentId, leaseTicketKey);
              // INF-413: renew the ticket-level in-flight record on the same
              // signal so a long-running worker's guard is not lost to TTL
              // expiry mid-run (which would let a second worker be spawned).
              dispatchInFlightStore?.renew(leaseTicketKey);
            }
          }
        }
      }

      // AI-1584: Enrollment gap repair — heal wf:* tickets that lack state:* label.
      // Fires on every Issue event (create or update). Fail-open: never blocks routing.
      if (event.type === "Issue") {
        const enrollToken = getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
        const enrollData = event.data as Record<string, unknown> | null;
        const enrollIssueId = enrollData?.id as string | undefined;
        if (enrollToken && enrollIssueId) {
          const enrollIdentifier = (enrollData?.identifier as string | undefined) ?? enrollIssueId;
          enrollIfMissing(enrollIssueId, enrollToken, (heal) => {
            // AI-1585 / AC2: structured audit event for the reconciliation heal.
            appendOperationalEvent(operationalEventStore, {
              outcome: "enrollment-healed",
              type: event.type,
              key: enrollIdentifier,
              sessionKey: normalizeSessionKey(enrollIdentifier),
              detail: { workflowId: heal.workflowId, entryState: heal.entryState },
            });
          }).then((result) => {
            if (result.enrolled) {
              log.info(`Enrollment gap healed: stamped state:${result.entryState} on ${enrollIssueId}`);
            }
          }).catch((err) => {
            log.warn(`enrollIfMissing failed for ${enrollIssueId}: ${err instanceof Error ? err.message : String(err)}`);
          });

          // AI-2469 AC1(a): Auto-enroll AI-team tickets into dev-impl at intake.
          // Runs on every Issue event alongside enrollIfMissing. Skips tickets
          // that already have a wf:* label (enrollIfMissing handles the gap where
          // wf:* exists but state:* is missing; this handles the case where
          // neither exists).
          const enrollTeamKey = enrollData?.teamKey as string | undefined;
          if (enrollTeamKey) {
            autoEnrollByTeam(enrollIssueId, enrollTeamKey, enrollToken, undefined, (info) => {
              appendOperationalEvent(operationalEventStore, {
                outcome: "auto-enrolled",
                type: event.type,
                key: enrollIdentifier,
                sessionKey: normalizeSessionKey(enrollIdentifier),
                detail: { workflowId: info.workflowId, entryState: info.entryState, teamKey: info.teamKey },
              });
            }, enrolledTicketsStore).then((result) => {
              if (result.enrolled) {
                log.info(`Auto-enrolled: stamped wf:dev-impl + state:${result.entryState} on ${enrollIssueId} (team=AI)`);
              }
            }).catch((err) => {
              log.warn(`autoEnrollByTeam failed for ${enrollIssueId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }

          // INF-334: plain delegated tickets are still real work. If a ticket
          // gains a delegate without already being governed, enroll it into the
          // task worker phase so capacity rearm/rescue paths can see it.
          const updatedFrom = (event as { updatedFrom?: Record<string, unknown> }).updatedFrom;
          const delegateChanged =
            event.action === "update" &&
            updatedFrom !== undefined &&
            ("delegateId" in updatedFrom || "delegate" in updatedFrom);
          const delegate = enrollData?.delegate as { id?: string; name?: string } | null | undefined;
          const delegateId = delegate?.id;
          if (delegateChanged && delegateId) {
            const mappedAgentName = buildAgentMap()[delegateId];
            const delegateAgentName = mappedAgentName ? getOpenclawAgentName(mappedAgentName) : null;
            autoEnrollPlainDelegation(enrollIssueId, enrollToken, (info) => {
              appendOperationalEvent(operationalEventStore, {
                outcome: "auto-enrolled",
                type: event.type,
                key: enrollIdentifier,
                sessionKey: normalizeSessionKey(enrollIdentifier),
                detail: {
                  workflowId: info.workflowId,
                  entryState: info.entryState,
                  mode: "plain-delegation",
                  delegate: info.delegateAgentName ?? null,
                },
              });
            }, enrolledTicketsStore, delegateAgentName).then((result) => {
              if (result.enrolled) {
                log.info(
                  `Plain delegation auto-enrolled: stamped wf:${result.workflowId ?? "task"} + ` +
                  `state:${result.entryState ?? "doing"} on ${enrollIssueId}`,
                );
              }
            }).catch((err) => {
              log.warn(`autoEnrollPlainDelegation failed for ${enrollIssueId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }

          // ── AI-2554: On-webhook label-sync audit ──────────────────────────
          // Lightweight single-ticket check on Issue webhooks: compare proxy-store
          // recorded state against Linear's current state. Runs in background;
          // never blocks routing.
          checkLabelSyncForTicket(enrollIdentifier, enrollToken).then((divergence) => {
            if (divergence) {
              emitLabelSyncWarning(divergence);
              log.warn(
                `[webhook] label-sync audit: divergence detected for ${enrollIdentifier} ` +
                `(proxy: ${divergence.proxyState ?? "(none)"}, linear: ${divergence.linearStateLabel ?? "(none)"})`,
              );
            }
          }).catch((auditErr) => {
            const am = auditErr instanceof Error ? auditErr.message : String(auditErr);
            log.warn(`[webhook] label-sync audit failed for ${enrollIdentifier}: ${am}`);
          });
        }
      }

      // AgentSessionEvent — create session for Linear UI widget
      if (event.type === "AgentSessionEvent") {
        // Create a Linear agent session to show "Agent working" widget
        // This is separate from OpenClaw agent routing
        const data = (event.data as Record<string, unknown> | undefined) ?? {};
        const sessionData = (data.agentSession as Record<string, unknown> | undefined) ?? {};
        const issueData = (sessionData.issue as Record<string, unknown> | undefined) ?? {};
        const issueId = issueData.id as string | undefined;
        if (!issueId) {
          log.warn("AgentSessionEvent has no issue data - skipping session creation");
          return;
        }
        // Extract agent name from event data (for session creation)
        const agentName = (sessionData.user as { name?: string } | undefined)?.name || "unknown";
        let agentSessionId: string | null = null;
        try {
          const sessionResult = await createSessionAndEmitThought(issueId, agentName, {
            identifier: issueData.identifier as string | undefined,
            title: issueData.title as string | undefined,
            description: issueData.description as string | undefined,
          });
          agentSessionId = sessionResult.sessionId;
        } catch (err) {
          log.error(`Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── Pre-routing: workflow bootstrap hook (AI-1565) ─────────────────────
      // Fires before the delegate-based router so a wf:* label-add with no
      // delegate can bootstrap the ticket into its entry state and set the
      // first-owner delegate — which then fires the normal dispatch path.
      const bootstrapToken = getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? (() => {
        // Fallback: use any agent's OAuth token (needed when there's no
        // generic service token in the env — e.g. ILL Tokyo deployment).
        const agents = getAgents();
        for (const a of agents) {
          const t = getAccessToken(a.name);
          if (t) return t;
        }
        return undefined;
      })();
      if (bootstrapToken) {
        try {
          const bootstrapResult = await maybeBootstrapWorkflow(event, bootstrapToken, enrolledTicketsStore);
          if (bootstrapResult) {
            log.info(`Workflow bootstrap: ${bootstrapResult.action} (wf:${bootstrapResult.workflowId ?? "unknown"})`);
            const bootstrapOutcome =
              bootstrapResult.action === "bootstrapped"
                ? "bootstrap-bootstrapped"
                : bootstrapResult.action === "rejected"
                  ? "bootstrap-rejected"
                  : "bootstrap-demoted";
            appendOperationalEvent(operationalEventStore, { outcome: bootstrapOutcome, type: event.type });

            // AI-fix: after bootstrap, deliver a workflow-aware wake to the
            // newly-assigned delegate so they know what to do.
            if (bootstrapResult.action === "bootstrapped" && bootstrapResult.delegateAgentName && bootstrapResult.ticketIdentifier) {
              const wakeSessionKey = normalizeSessionKey(bootstrapResult.ticketIdentifier);
              const wakeRoute: RouteResult = {
                agentId: bootstrapResult.delegateAgentName,
                sessionKey: wakeSessionKey,
                priority: 0,
                routingReason: "delegate",
                event,
              };
              const agentCfg = getAgent(bootstrapResult.delegateAgentName);
              const wakeDeliveryConfig: DeliveryConfig = {
                nodeBin: process.execPath,
                hooksUrl: agentCfg?.hooksUrl ?? process.env.OPENCLAW_HOOKS_URL,
                hooksToken: agentCfg?.hooksToken ?? process.env.OPENCLAW_HOOKS_TOKEN,
                hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
                hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
                // AI-2420: gateway-API target comes from the agent's OWN config
                // (agents.json), never the global OPENCLAW_GATEWAY_URL. The global
                // points at ONE gateway (the host, which knows only grover/main),
                // so injecting it would strand every container agent (astrid@18822,
                // igor@18820, …) as "Unknown agent" while bypassing the correct
                // per-agent hooksUrl. With per-agent gatewayUrl+gatewayToken set,
                // delivery prefers the x-openclaw-session-key path; otherwise it
                // falls back to per-agent hooksUrl/hooksToken from agents.json.
                gatewayUrl: agentCfg?.gatewayUrl,
                gatewayToken: agentCfg?.gatewayToken,
              };
              try {
                if (throttle) {
                  await throttle.wait(wakeRoute.agentId);
                  throttle.record(wakeRoute.agentId);
                }
                const wakeResult = await deliverWithSlot(wakeRoute, wakeDeliveryConfig, throttle, dispatchLeaseStore, dispatchInFlightStore, sessionSpawnStore);
                log.info(
                  `Bootstrap wake delivered to ${bootstrapResult.delegateAgentName} for ${bootstrapResult.ticketIdentifier} (runId=${wakeResult.runId ?? "ok"})`,
                );
                appendOperationalEvent(operationalEventStore, {
                  outcome: wakeResult.runId ? "bootstrap-wake-dispatched" : "bootstrap-wake-delivered",
                  type: event.type,
                  agent: bootstrapResult.delegateAgentName,
                  key: wakeSessionKey,
                  sessionKey: wakeSessionKey,
                  deliveryMode: "bootstrap-wake",
                  attemptCount: 1,
                  runId: wakeResult.runId ?? null,
                  detail: wakeResult.canonVersion ? { canonVersion: wakeResult.canonVersion } : undefined,
                });
                if (onDispatched) onDispatched(bootstrapResult.delegateAgentName, wakeSessionKey);
              } catch (err) {
                log.error(
                  `Bootstrap wake delivery failed for ${bootstrapResult.delegateAgentName}: ${err instanceof Error ? err.message : String(err)}`,
                );
                appendOperationalEvent(operationalEventStore, {
                  outcome: "bootstrap-wake-failed",
                  type: event.type,
                  agent: bootstrapResult.delegateAgentName,
                  key: wakeSessionKey,
                  sessionKey: wakeSessionKey,
                  deliveryMode: "bootstrap-wake",
                  attemptCount: 1,
                  errorSummary: errorSummary(err),
                });
              }
            }
            return;
          }
        } catch (err) {
          log.warn(`Workflow bootstrap failed (fail-safe): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (await checkDelegatePingPong(event, delegatePingPongDetector)) {
        return;
      }

      await enrichCommentEventForRouting(event);
      const routes = routeEventAll(event);
      if (routes.length === 0) {
        log.info(`No agent target for event type=${event.type} action=${"action" in event ? event.action : "?"}`);
        const noRouteData = (event as { data?: Record<string, unknown> }).data;
        // AI-1766 AC2: attribute the event to a human-readable ticket
        // identifier whenever the payload carries one (Comment payloads nest
        // it under data.issue; enrichment stamps data.issueIdentifier). Only
        // fall back to raw UUIDs when no identifier exists — and say why the
        // event couldn't be attributed.
        const noRouteIssue = noRouteData?.issue as Record<string, unknown> | undefined;
        const noRouteTicket =
          (noRouteData?.identifier as string) ||
          (noRouteData?.issueIdentifier as string) ||
          (noRouteIssue?.identifier as string) ||
          null;
        const noRouteRawId = (noRouteData?.issueId as string) || (noRouteData?.id as string) || null;
        const attribution = noRouteTicket
          ? ` (${noRouteTicket})`
          : noRouteRawId
            ? ` (unattributable: payload carries no issue identifier, raw id ${noRouteRawId})`
            : " (unattributable: payload names no issue)";
        // Audit finding #1: this was the fully-silent "assigned it and nothing
        // happened" case — a delegate/assignee/mention matching no registered
        // agent left no artifact anywhere. Now it pushes — but only when the
        // event actually named someone we couldn't resolve. Events with no
        // routing candidates at all (IssueLabel/Project/... entity writes,
        // unassigned issues, plain comments, AgentSessionEvent UI widgets)
        // no-route by construction and stay log+store only.
        // AI-1900: candidates resolving to a configured known human (Matt) are
        // a *correct* no-route — humans are deliberately absent from
        // agents.json — so they are dropped from the pager (distinct
        // operational outcome, info log). Genuinely unknown ids keep paging;
        // a mixed event pages listing only the genuinely unknown ids.
        const unresolved = unresolvedRoutingCandidates(event);
        const knownHumans = loadKnownHumans();
        const humans = unresolved.filter((id) => knownHumans.has(id));
        const unknown = unresolved.filter((id) => !knownHumans.has(id));
        const humanOnly = humans.length > 0 && unknown.length === 0;
        const hasDeadLetterTarget = unknown.length > 0 && deadLetterQueue && noRouteTicket;

        if (hasDeadLetterTarget) {
          // ── INF-217: Dead-letter queue for genuinely unknown agents ──
          const intendedAgent = unknown[0];
          deadLetterQueue.append({
            ticketId: noRouteTicket,
            intendedAgent,
            reason: "not in roster",
            eventPayload: { eventType: event.type, eventAction: "action" in event ? event.action : undefined, unresolved, humans: humans.map((id) => knownHumans.get(id)) },
          });
          log.warn(
            `dead-letter: ${noRouteTicket} targeted agent ${intendedAgent} not in roster - ` +
            `wrote to DLQ (type=${event.type})`,
          );
          appendOperationalEvent(operationalEventStore, {
            outcome: "dead-letter",
            type: event.type,
            key: `linear-${noRouteTicket}`,
            sessionKey: `linear-${noRouteTicket}`,
            errorSummary: `Non-roster dispatch for ${noRouteTicket} - ${intendedAgent}`,
            detail: { ticketId: noRouteTicket, intendedAgent, reason: "not in roster" },
          });
        } else {
          appendOperationalEvent(operationalEventStore, {
            outcome: humanOnly ? "no-route-human" : "no-route",
            type: event.type,
            key: noRouteTicket ? `linear-${noRouteTicket}` : noRouteRawId ? `linear-${noRouteRawId}` : null,
            errorSummary:
              `No agent target for ${event.type}${attribution}` +
              (humans.length > 0 ? ` — known human: ${humans.map((id) => knownHumans.get(id)).join(", ")}` : ""),
          });
        }
        if (humans.length > 0) {
          log.info(
            `no-route candidates resolved to known human(s): ${humans.map((id) => `${knownHumans.get(id)} (${id})`).join(", ")}` +
            (humanOnly ? " — routing pager suppressed" : ""),
          );
        }
        if (unknown.length > 0) {
          notify({
            severity: "warning",
            source: "routing",
            title: "no-route: event named a delegate/assignee/mention unknown to agents.json",
            detail: `type=${event.type} action=${"action" in event ? event.action : "?"} unresolved=${unknown.join(",")}`,
            ticket: noRouteTicket ?? issueIdentifierFromEvent(event) ?? undefined,
          });
        }
        return;
      }

      // Dispatch each route through the full guard pipeline, sequentially.
      // Multi-route events (mention fan-out, audit #3) are rare; sequential
      // keeps per-agent throttle and bag semantics simple. A failure in one
      // route's dispatch must not starve the remaining routes.
      for (const dispatchTarget of routes) {
        try {
          await dispatchRoute(dispatchTarget);
        } catch (err) {
          log.error(`dispatchRoute failed for ${dispatchTarget.agentId} [${dispatchTarget.sessionKey}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;

      async function dispatchRoute(route: RouteResult): Promise<void> {
      const event = route.event;
      // AI-1799 AC2: mint a wake_id at route time so the full dispatch cycle
      // (routed → bag-added → dispatch-accepted → delivered) can be correlated.
      const wakeId = crypto.randomUUID();
      let livenessDispatchId: string | null = null;

      function recordLivenessDispatch(): string | null {
        if (!livenessDispatchStore) return null;
        if (livenessDispatchId) return livenessDispatchId;
        const record = livenessDispatchStore.recordDispatch({
          agentId: route.agentId,
          ticketId: route.sessionKey,
          sessionKey: route.sessionKey,
        });
        livenessDispatchId = record.dispatchId;
        return livenessDispatchId;
      }

      function recordLivenessAck(ack: GatewayDispatchAck): void {
        const dispatchId = recordLivenessDispatch();
        if (!dispatchId) return;
        livenessDispatchStore?.recordAck(dispatchId, ack);
      }

      // ── AI-1918: Dispatch idempotency + stale-dispatch guard ───────────
      // Check (ticket, workflowState, agent) against the persistent idempotency
      // store BEFORE emitting the routed event. A suppressed duplicate or
      // dropped stale dispatch must never reach the routed/bag/wake path.
      const workflowStateResolution = resolveWorkflowStateFromEvent(event);
      if (idempotencyStore) {
        const ticketId = route.sessionKey;
        const data = event.data as Record<string, unknown> | null;
        const stateName = workflowStateResolution.workflowState ?? route.routingReason ?? "unknown";
        const updatedAt = (data?.updatedAt as string) ?? new Date().toISOString();
        const idempotencyResult = idempotencyStore.checkAndRecord(
          ticketId, stateName, route.agentId, updatedAt,
        );
        if (idempotencyResult.stale) {
          log.info(`Dispatch idempotency: dropped stale dispatch for ${route.agentId} [${ticketId}]`);
          appendOperationalEvent(operationalEventStore, {
            outcome: "dropped-stale" as never,
            type: event.type,
            agent: route.agentId,
            key: ticketId,
            sessionKey: ticketId,
            workflowState: stateName,
            plane: "connector",
          });
          return;
        }
        if (idempotencyResult.suppressed) {
          log.info(`Dispatch idempotency: suppressed duplicate for ${route.agentId} [${ticketId}]`);
          appendOperationalEvent(operationalEventStore, {
            outcome: "suppressed-duplicate" as never,
            type: event.type,
            agent: route.agentId,
            key: ticketId,
            sessionKey: ticketId,
            workflowState: stateName,
            plane: "connector",
          });
          return;
        }
      }

      // ── AI-2350: Durable dispatch lease check ─────────────────────────
      // Before dispatching, acquire a lease for (agent, ticket). If an unexpired
      // lease exists, refuse the dispatch — regardless of whether this is the
      // sweep path or the webhook path (AI-2343 / AI-2344).
      //
      // Pass updatedAt so that a legitimate re-dispatch for a newer state
      // supersedes the old lease (AI-1969 / AI-1918 AC2) rather than being
      // blocked. The AI-1918 idempotency check above already determined this
      // is a legitimate re-dispatch (not stale, not a duplicate of the same
      // state); the lease must honor the same signal.
      if (dispatchLeaseStore) {
        const data = event.data as Record<string, unknown> | null;
        const updatedAt = (data?.updatedAt as string) ?? undefined;
        const lease = dispatchLeaseStore.acquire(
          route.agentId,
          route.sessionKey,
          { updatedAt },
        );
        if (lease.refused) {
          log.info(
            `Dispatch lease: refused for ${route.agentId} [${route.sessionKey}] ` +
            `— unexpired lease exists (expires ${lease.existingLease?.expires_at})`,
          );
          appendOperationalEvent(operationalEventStore, {
            outcome: "suppressed-duplicate" as never,
            type: event.type,
            agent: route.agentId,
            key: route.sessionKey,
            sessionKey: route.sessionKey,
            plane: "connector",
            detail: { reason: "dispatch-lease-active", existingExpiresAt: lease.existingLease?.expires_at },
          });
          return;
        }
      }

      // ── AI-2192: Delivery-time recipient resolution ─────────────────────
      // Check whether the resolved agent is registered in the live roster.
      // A non-roster agent means the resolution path (delegate/assignee/mention/
      // department-prefix/steward-escalation) produced a name absent from
      // agents.json — a half-applied rename, stale cache, or config drift.
      // Instead of silently attempting delivery (which will fail with retries
      // into the void), dead-letter immediately with a critical alert naming
      // the ticket, intended agent, and resolution path.
      const ticketId = route.sessionKey;
      const resolvedAgentName = route.agentId;
      const rosterNames = getAgents().map((a) => a.name);
      const rosterNameSet = new Set(rosterNames);
      if (!rosterNameSet.has(resolvedAgentName)) {
        const detail = {
          ticket: ticketId.replace(/^linear-/, ""),
          resolvedAgent: resolvedAgentName,
          routingReason: route.routingReason,
          eventType: event.type,
          rosterAgents: rosterNames,
        };
        log.error(
          `non-roster-agent: ${resolvedAgentName} is not in the agent roster — aborting dispatch for ${ticketId}. ` +
          `routingReason=${route.routingReason} roster=[${rosterNames.join(", ")}]`,
        );
        // Raise a critical alert naming the ticket, agent, and resolution path.
        notify({
          severity: "critical",
          source: "dispatch",
          title: `Non-roster dispatch target: ${resolvedAgentName} for ${ticketId.replace(/^linear-/, "")}`,
          detail: JSON.stringify(detail),
          agent: resolvedAgentName,
          ticket: ticketId.replace(/^linear-/, ""),
        });
        // Write an operational event recording the dead-letter.
        appendOperationalEvent(operationalEventStore, {
          outcome: "dispatch-undeliverable",
          type: event.type,
          agent: resolvedAgentName,
          key: ticketId,
          sessionKey: ticketId,
          deliveryMode: "non-roster-recipient",
          attemptCount: 0,
          errorSummary: `Non-roster dispatch target: ${resolvedAgentName} — routingReason=${route.routingReason}`,
          detail,
          wakeId,
          plane: "connector",
        });
        // Zero delivery attempts — return immediately. No retry, no wake.
        return;
      }

      // ── AI-2178: Dispatch circuit breaker + comment-fed suppression ─────
      // Checks run sequentially:
      //   1. Comment-fed re-wake suppression (pre-wake heuristic) — skip
      //      without incrementing breaker when the delegate comments on their
      //      own ticket without advancing state.
      //   2. Circuit breaker — skip when the breaker is tripped (N
      //      consecutive no-change wakes).
      //   3. State comparison — if state hasn't moved since last dispatch,
      //      increment the breaker counter. If it has, reset.
      {
        const cbTicketId = route.sessionKey;
        const cbData = event.data as Record<string, unknown> | null;

        // Resolve the current state:* label from the event payload.
        const cbLabels = ((): string[] => {
          if (Array.isArray(cbData?.labels)) return cbData.labels as string[];
          const issue = cbData?.issue as Record<string, unknown> | undefined;
          if (issue && Array.isArray(issue.labels)) return issue.labels as string[];
          return [];
        })();
        const cbStateLabel = cbLabels
          .filter((l: string) => /^state:/i.test(l))
          .map((l: string) => l.slice(l.indexOf(":") + 1).toLowerCase())
          .sort() // deterministic for multi-label edge case
          .join(",") || null;

        // Feature 2: comment-fed re-wake suppression (pre-wake heuristic).
        // Runs BEFORE the breaker counter increment so the dominant self-feed
        // loop never burns a breaker slot.
        const commentSuppress = checkCommentFedSuppressionForTicket(
          cbTicketId,
          event,
          cbStateLabel,
          route.agentId,
        );

        if (commentSuppress.suppressed) {
          log.info(
            `Comment-fed suppression: skipping wake for ${route.agentId} [${cbTicketId}] — ${commentSuppress.reason ?? "delegate comment, no state change"}`,
          );
          appendOperationalEvent(operationalEventStore, {
            outcome: "suppressed-comment-fed" as never,
            type: event.type,
            agent: route.agentId,
            key: cbTicketId,
            sessionKey: cbTicketId,
            deliveryMode: "circuit-breaker",
            plane: "connector",
            detail: { reason: commentSuppress.reason ?? "delegate comment, no state change" },
          });
          return;
        }

        // Feature 1: circuit breaker. First, check if tripped.
        const breakerCheck = checkBreaker(cbTicketId);
        if (breakerCheck.blocked) {
          log.info(
            `Circuit breaker: blocking dispatch for ${route.agentId} [${cbTicketId}] — tripped at ${breakerCheck.state!.trippedAt} (${breakerCheck.state!.wakeCount} wakes, state=${breakerCheck.state!.lastStateLabel ?? "unknown"})`,
          );
          appendOperationalEvent(operationalEventStore, {
            outcome: "breaked-blocked" as never,
            type: event.type,
            agent: route.agentId,
            key: cbTicketId,
            sessionKey: cbTicketId,
            deliveryMode: "circuit-breaker",
            plane: "connector",
            detail: { wakeCount: breakerCheck.state!.wakeCount, trippedAt: breakerCheck.state!.trippedAt, stateLabel: breakerCheck.state!.lastStateLabel },
          });
          return;
        }

        // Not blocked and not comment-suppressed. Determine whether this
        // wake is a repeat on the same state or a state advance (reset).
        // recordDispatch handles the comparison internally:
        //   - First dispatch: seed state, counter=0.
        //   - State changed from last: reset counter to 0.
        //   - State unchanged: keep existing counter.
        //
        // The counter is then incremented by a SUBSEQUENT webhook that
        // sees the state hasn't changed from THIS dispatch. That increment
        // happens in the next arrival's dispatchRoute call — when the
        // state label matches this recording, recordFailedWake fires.
        //
        // We record BEFORE the stale-route guard so the state snapshot
        // reflects THIS event, not a stale previous entry.
        recordDispatch(cbTicketId, cbStateLabel);
      }

      // ── 9a. Stale-route guard ───────────────────────────────────────────
      // Linear webhook payloads are snapshots. Before waking an agent from a
      // delegate/assignee event, re-check Linear's current issue state so an
      // accidental delegation that was already corrected does not let the old
      // agent take ownership or mutate the ticket later.
      const routingCheck = await checkLinearIssueRouting(ticketId, route.agentId, route.routingReason);

      // ── AI-2091 §2 (G2): delivery-time fetchability gate on the PRIMARY path.
      // A definitive not-found at delivery is a phantom — a dead identifier or a
      // deleted ticket (AI-2014 at 16:45Z, the AI-2034 dead-identifier cluster).
      // Abort loudly and ship ZERO delivery; never send a "workflow context
      // unavailable" wake for a ticket that does not exist. A transient fetch
      // failure is NOT a phantom (routingCheck.failOpen) and falls through to the
      // normal fail-open path — a Linear hiccup must not be swallowed as a phantom.
      if (routingCheck.terminalNotFound) {
        const fetchability = assertDispatchTargetFetchable({
          ticketId: ticketId.replace(/^linear-/, ""),
          fetchable: false,
          terminalNotFound: true,
        });
        if (!fetchability.dispatch) {
          log.warn(
            `phantom-dispatch-abort: ${ticketId} unfetchable at delivery — ${fetchability.reason}; aborting dispatch for ${route.agentId}`,
          );
          appendOperationalEvent(operationalEventStore, {
            outcome: "phantom-dispatch-abort" as never,
            type: event.type,
            agent: route.agentId,
            key: ticketId,
            sessionKey: ticketId,
            deliveryMode: "fetchability-gate",
            errorSummary: fetchability.reason,
            plane: "connector",
          });
          return;
        }
      }

      if (!routingCheck.actionable) {
        appendOperationalEvent(operationalEventStore, { outcome: "dedup-suppressed", type: event.type, agent: route.agentId, key: ticketId, sessionKey: ticketId, deliveryMode: "stale-route" });
        return;
      }

      // ── 9b. Nudge deduplication + coalescing (atomic) ────────────────────
      // Suppress rapid-fire duplicate events for the same agent+ticket.
      // Uses acquireNudgeSlot for an atomic read-check-write within a single
      // SQLite transaction — eliminates the TOCTOU race between the old
      // getCoalesceInfo + recordNudge/recordCoalesced two-step (AI-2376).
      if (NUDGE_DEDUP_WINDOW_MS > 0 && nudgeStore) {
        const { suppressed, coalescedCount } = nudgeStore.acquireNudgeSlot(
          route.agentId,
          ticketId,
          NUDGE_DEDUP_WINDOW_MS,
          event.type,
          "action" in event ? event.action : undefined,
        );

        if (suppressed) {
          // The nudge slot was NOT acquired — an existing suppression window
          // is still active, and this event was merged into the coalesced
          // counter. Return without delivering; the coalesced count will be
          // passed to the next delivery that refreshes the window.
          log.info(`Nudge dedup (atomic): coalescing delivery for ${route.agentId} [${ticketId}] — coalescedCount=${coalescedCount}`);
          appendOperationalEvent(operationalEventStore, { outcome: "dedup-suppressed", type: event.type, agent: route.agentId, key: ticketId, sessionKey: ticketId, deliveryMode: "nudge-dedup" });
          return;
        }

        // Slot acquired: the suppression window was absent or expired.
        // acquireNudgeSlot refreshed the nudge timestamp and zeroed the DB
        // coalesced_count. Any coalescedCount > 0 means events were merged
        // into the previous window and are now drained — the caller should
        // carry that as a signal of dropped events.
        if (coalescedCount > 0) {
          log.info(`Nudge dedup (atomic): delivering for ${route.agentId} [${ticketId}] with ${coalescedCount} coalesced event(s) from prior window`);
          route.coalescedCount = coalescedCount;
        }
      }

      const agentName = route.agentId;
      log.info(`Routed event to ${agentName} [${route.sessionKey}]`);
      appendOperationalEvent(operationalEventStore, {
        outcome: "routed",
        type: event.type,
        agent: agentName,
        key: route.sessionKey,
        sessionKey: route.sessionKey,
        deliveryMode: bag && sessionTracker ? "pending-bag" : agentQueue ? "agent-queue" : "direct",
        wakeId,
        workflowState: workflowStateResolution.workflowState,
        plane: "connector",
        detail: {
          authoritativeWorkflowStateSource: workflowStateResolution.source,
          nativeState: workflowStateResolution.nativeState,
          staleNativeState: workflowStateResolution.staleNativeState,
        },
      });

      // ── 9c. AI-1428: Pre-flight liveness check + role-guard ────────────
      // Before dispatching to an agent, verify it's reachable. If not,
      // emit DELEGATE_UNAVAILABLE instead of silently stalling.
      // Also check role-guard for implementation-state tickets.
      const livenessConfig: LivenessConfig = {
        hooksUrl: process.env.OPENCLAW_HOOKS_URL,
        hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
      };
      const agentLivenessCfg = getAgent(route.agentId);
      if (agentLivenessCfg?.hooksUrl) livenessConfig.hooksUrl = agentLivenessCfg.hooksUrl;
      if (agentLivenessCfg?.hooksToken) livenessConfig.hooksToken = agentLivenessCfg.hooksToken;
      // AI-2515: if the agent has a gatewayUrl configured, pass it as a fallback
      // for liveness checks. The gateway health endpoint is reachable from the
      // connector's runtime even when hooksUrl uses a container-only hostname.
      if (agentLivenessCfg?.gatewayUrl) livenessConfig.gatewayUrl = agentLivenessCfg.gatewayUrl;

      const liveness = await checkAgentLiveness(route.agentId, livenessConfig);
      if (!liveness.available) {
        // Agent unreachable — emit DELEGATE_UNAVAILABLE escalation.
        log.warn(
          `DELEGATE_UNAVAILABLE: ${route.agentId} is unreachable (${liveness.reason}: ${liveness.detail ?? "unknown"}) — skipping delivery for ${ticketId}`,
        );
        appendOperationalEvent(operationalEventStore, {
          outcome: "delivery-failed",
          type: event.type,
          agent: agentName,
          key: ticketId,
          sessionKey: ticketId,
          deliveryMode: "delegate-unavailable",
          attemptCount: 1,
          errorSummary: `DELEGATE_UNAVAILABLE: ${liveness.reason}: ${liveness.detail ?? "unknown"}`,
        });
        await emitDelegateUnavailable(
          ticketId.replace(/^linear-/, ""),
          route.agentId,
          `${liveness.reason}: ${liveness.detail ?? "unknown"}`,
        );
        // No delivery was sent — roll back the dedup priming so a later genuine
        // dispatch to this agent+ticket inside the window is not swallowed (AI-1538).
        nudgeStore?.clearNudge(route.agentId, ticketId);
        // Do NOT deliver — return immediately.
        return;
      }

      // Role-guard (AI-1459 enforcement mode): check whether the target agent
      // fills the owner_role for the ticket's current workflow state.
      // If blocked: skip delivery — the guard has posted a comment and
      // attempted delegate correction.
      const issueIdentifier = ticketId.replace(/^linear-/, "");
      const roleGuardToken =
        getAccessToken(route.agentId) ??
        process.env.LINEAR_OAUTH_TOKEN ??
        process.env.LINEAR_API_KEY;
      if (roleGuardToken) {
        try {
          const guardLabels = await fetchWorkflowLabels(issueIdentifier, roleGuardToken);
          // Provide a resolver so the guard can auto-correct the delegate
          // without needing to import agents.ts directly (avoids the test
          // compile-time dependency on fancy-openclaw-linear-skill-cli).
          const linearUserIdResolver: LinearUserIdResolver = (bodyName: string) => {
            const agents = getAgents();
            const agent = agents.find(
              (a) => a.name.toLowerCase() === bodyName.toLowerCase() ||
                     (a as { openclawAgent?: string }).openclawAgent?.toLowerCase() === bodyName.toLowerCase()
            );
            return (agent as { linearUserId?: string } | undefined)?.linearUserId ?? null;
          };
          const guardResult = await checkRoleGuardAndBlock(
            route.agentId,
            issueIdentifier,
            guardLabels,
            linearUserIdResolver,
            deriveWorkflowInstanceContextFromRoute(route, issueIdentifier),
          );
          if (guardResult.blocked) {
            log.warn(
              `routing-guard: dispatch blocked for ${route.agentId} [${issueIdentifier}] — ${guardResult.reason ?? "role mismatch"}; ` +
              (guardResult.correctedTo ? `corrected to ${guardResult.correctedTo}` : "delegate cleared")
            );
            appendOperationalEvent(operationalEventStore, {
              outcome: "delivery-failed",
              type: event.type,
              agent: agentName,
              key: ticketId,
              sessionKey: ticketId,
              deliveryMode: "role-guard-blocked",
              attemptCount: 1,
              errorSummary: `routing-guard blocked: ${guardResult.reason ?? "role mismatch"}`,
            });
            // No delivery was sent — roll back the dedup priming so the genuine
            // dispatch to the agent that legitimately becomes the delegate is not
            // swallowed as a "duplicate" of this blocked attempt (AI-1538).
            nudgeStore?.clearNudge(route.agentId, ticketId);
            return;
          }
        } catch (err) {
          log.warn(`Role-guard check failed for ${issueIdentifier}: ${err instanceof Error ? err.message : String(err)} — continuing`);
        }
      }

      // ── 10. Create agent session + emit thought ───────────────────────────
      const data = event.data as Record<string, unknown> | null;
      const issueId = data?.id as string | undefined;
      let agentSessionId: string | null = null;

      if (issueId && event.type === "Issue") {
        try {
          const sessionResult = await createSessionAndEmitThought(issueId, agentName, {
            identifier: data?.identifier as string | undefined,
            title: data?.title as string | undefined,
            description: data?.description as string | undefined,
          });
          agentSessionId = sessionResult.sessionId;
        } catch (err) {
          log.error(`Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── v1.1: Pull-based wake-up via PendingWorkBag ─────────────────────
      // Add to bag (deduped by ticket ID). Send wake-up signal only if
      // agent has no active session. Bursts collapse to 1 signal.
      if (bag && sessionTracker) {
        const normalizedTicketId = normalizeSessionKey(ticketId);
        bag.add(agentName, normalizedTicketId, event.type, route.routingReason);
        // Purge stale bag entries for this ticket from all other agents. When a
        // delegate changes, the previous holder's bag entry must be removed so it
        // doesn't receive a spurious consider-work wake for a ticket it no longer owns.
        if (route.routingReason === "delegate" || route.routingReason === "assignee") {
          const purgedStale = bag.removeTicketForOtherAgents(agentName, normalizedTicketId);
          if (purgedStale > 0) {
            log.info(`Bag: purged stale entries for ${normalizedTicketId} from ${purgedStale} other agent(s)`);
          }
        }
        appendOperationalEvent(operationalEventStore, { outcome: "bag-added", type: event.type, agent: agentName, key: normalizedTicketId, sessionKey: normalizedTicketId, deliveryMode: "pending-bag", wakeId, plane: "connector" });

        const agentConfig = getAgent(agentName);
        const maxConcurrent = agentConfig?.maxConcurrent;
        if (typeof maxConcurrent === "number" && maxConcurrent > 0) {
          const activeCount = sessionTracker.getActiveSessionKeys(agentName).length;
          if (activeCount >= maxConcurrent) {
            noActivityDetector?.recordAdmissionDeferral(agentName, normalizedTicketId, {
              activeCount,
              maxConcurrent,
            });
            return;
          }
        }

        // Delivery is now admitted. Register a pending dispatch expectation
        // before the actual send so a swallowed delivery self-heals, but only
        // after capacity deferral has had a chance to keep overflow local.
        onDeliveryCommitted?.(agentName, ticketId);

        const wakeConfig: WakeUpConfig = {
          nodeBin: process.execPath,
          hooksUrl: process.env.OPENCLAW_HOOKS_URL,
          hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
          hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
          hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
          // No global gatewayUrl/gatewayToken — see note at the wakeDeliveryConfig
          // above. A global gateway URL points at ONE gateway and would win the
          // delivery-path preference, stranding every container agent. AI-2420:
          // wakeConfigForAgent (below) now sets gatewayUrl/gatewayToken per agent
          // from agents.json; this base config stays gateway-less on purpose.
          timeoutMs: process.env.NODE_ENV === "test" ? 50 : undefined,
          maxRetries: process.env.NODE_ENV === "test" ? 0 : undefined,
        };

        // Per-agent override: prefer the agent's own hooksUrl/hooksToken from
        // agents.json so dispatches reach the right gateway/container instead of
        // always hitting OPENCLAW_HOOKS_URL (which may belong to a different fleet).
        const wakeConfigForAgent = (agentIdLookup: string): WakeUpConfig => {
          const cfg = getAgent(agentIdLookup);
          const rawToken = getAccessToken(agentIdLookup) ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
          const linearAuthToken = rawToken
            ? (/^Bearer\s+/i.test(rawToken) ? rawToken : `Bearer ${rawToken}`)
            : undefined;
          return {
            ...wakeConfig,
            hooksUrl: cfg?.hooksUrl ?? wakeConfig.hooksUrl,
            hooksToken: cfg?.hooksToken ?? wakeConfig.hooksToken,
            // AI-2420: per-agent gateway-API target (never a global URL).
            gatewayUrl: cfg?.gatewayUrl,
            gatewayToken: cfg?.gatewayToken,
            linearAuthToken,
          };
        };

        // Before honoring in-memory active-session locks, synchronously expire
        // stale sessions. The interval-based cleanup is only a backstop; webhook
        // traffic should not wait up to another minute behind an already-expired
        // lock, and stale cleanup must re-signal queued work instead of stranding it.
        const staleSessions = sessionTracker.cleanupStale();
        for (const stale of staleSessions) {
          log.info(`Webhook stale-session drain: re-signaling ${stale.agentId} for ${stale.pendingTickets.length} ticket(s)`);
          await resignalPendingTickets(stale.agentId, stale.pendingTickets, bag, sessionTracker, {
            ...wakeConfigForAgent(stale.agentId),
            sessionSpawnStore,
          }, { markActive: true, onDispatched });
        }

        if (sessionTracker.isActiveForTicket(agentName, normalizedTicketId)) {
          // Same ticket already has an active session: deliver directly into it.
          // Waiting for /session-end here would strand same-ticket conversational updates.
          log.info(`Bag: active same-ticket session for ${agentName} [${normalizedTicketId}], delivering immediately`);
          try {
            if (throttle) {
              log.info(`Dispatch throttle: waiting for ${agentName} (same-ticket active)`);
              await throttle.wait(route.agentId);
              throttle.record(route.agentId);
            }
            const sameTicketResult = await deliverWithSlot(route, wakeConfigForAgent(route.agentId), throttle, dispatchLeaseStore, dispatchInFlightStore, sessionSpawnStore);
            bag.removeTicket(agentName, normalizedTicketId);
            appendOperationalEvent(operationalEventStore, {
              outcome: sameTicketResult.runId ? "dispatch-accepted" : "delivered",
              type: event.type, agent: agentName, key: normalizedTicketId, sessionKey: normalizedTicketId,
              deliveryMode: "active-same-ticket", attemptCount: 1, runId: sameTicketResult.runId ?? null, wakeId, plane: "connector",
              detail: sameTicketResult.canonVersion ? { canonVersion: sameTicketResult.canonVersion } : undefined,
            });
          } catch (err) {
            log.error(`Same-ticket active delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
            appendOperationalEvent(operationalEventStore, { outcome: "delivery-failed", type: event.type, agent: agentName, key: normalizedTicketId, sessionKey: normalizedTicketId, deliveryMode: "active-same-ticket", attemptCount: 1, errorSummary: errorSummary(err) });
            sessionTracker.queueSignal(agentName, [normalizedTicketId]);
          }
          return;
        }

        // No active session for this specific ticket key. Dispatch a wake-up
        // immediately — even if the agent has other active sessions for other
        // tickets. Each ticket gets its own independent per-ticket session.
        const pending = bag.getPendingTickets(agentName);
        const pendingIds = pending.map((e) => e.ticketId);
        log.info(`Bag: sending wake-up signal(s) to ${agentName} with ${pendingIds.length} ticket(s)`);
        const dispatchResults = await resignalPendingTickets(agentName, pendingIds, bag, sessionTracker, {
          ...wakeConfigForAgent(agentName),
          sessionSpawnStore,
        }, { markActive: true, onDispatched });
        const dispatched = dispatchResults.filter(r => r.dispatched).length;
        const firstRunId = dispatchResults.find(r => r.runId)?.runId ?? null;
        const firstCanonVersion = dispatchResults.find(r => r.canonVersion)?.canonVersion ?? null;
        appendOperationalEvent(operationalEventStore, {
          outcome: dispatched > 0 ? "dispatch-accepted" : "delivery-failed",
          type: event.type, agent: agentName, key: normalizedTicketId, sessionKey: normalizedTicketId,
          deliveryMode: "wake-up", attemptCount: pendingIds.length, runId: firstRunId,
          errorSummary: dispatched > 0 ? null : "No wake-up signals dispatched", wakeId, plane: "connector",
          detail: firstCanonVersion ? { canonVersion: firstCanonVersion } : undefined,
        });
        return;
      }

      // ── v1.0 fallback: Agent queue with ticket-level coalescing ─────────
      onDeliveryCommitted?.(agentName, ticketId);

      if (agentQueue) {
        const queueResult = agentQueue.enqueueOrCoalesce(route);
        if (queueResult.action === "active-busy") {
          log.info(`Agent queue: ${route.agentId} already has active task for [${ticketId}] — skipping`);
          appendOperationalEvent(operationalEventStore, { outcome: "dedup-suppressed", type: event.type, agent: route.agentId, key: ticketId, sessionKey: ticketId, deliveryMode: "agent-queue-active-busy" });
          return;
        }
        if (queueResult.action === "coalesced") {
          log.info(`Agent queue: coalesced queued event for ${route.agentId} [${ticketId}]`);
          appendOperationalEvent(operationalEventStore, { outcome: "dedup-suppressed", type: event.type, agent: route.agentId, key: ticketId, sessionKey: ticketId, deliveryMode: "agent-queue-coalesced" });
          return;
        }
        if (queueResult.action === "queued") {
          log.info(`Agent queue: queued event for ${route.agentId} [${ticketId}] (active task for different ticket)`);
          recordLivenessAck({
            delivered: true,
            target_identity: route.agentId,
            status: "queued",
            queue_depth: 1,
            queue_age: 0,
          });
          appendOperationalEvent(operationalEventStore, { outcome: "queued", type: event.type, agent: route.agentId, key: ticketId, sessionKey: ticketId, deliveryMode: "agent-queue" });
          return;
        }
        log.info(`Agent queue: delivering immediately for ${route.agentId} [${ticketId}]`);
      }

      // Deliver to OpenClaw agent via delivery module
      const agentCfg = getAgent(route.agentId);
      const deliveryConfig = {
        nodeBin: process.execPath,
        hooksUrl: agentCfg?.hooksUrl ?? process.env.OPENCLAW_HOOKS_URL,
        hooksToken: agentCfg?.hooksToken ?? process.env.OPENCLAW_HOOKS_TOKEN,
        hooksThinking: process.env.OPENCLAW_HOOKS_THINKING,
        hooksModel: process.env.OPENCLAW_HOOKS_MODEL,
        // AI-2420: gateway-API target from the agent's OWN config (never the
        // global OPENCLAW_GATEWAY_URL — see note at wakeDeliveryConfig earlier).
        // With both set, delivery prefers the x-openclaw-session-key path; else
        // it falls back to per-agent hooksUrl/hooksToken so container agents stay
        // reachable.
        gatewayUrl: agentCfg?.gatewayUrl,
        gatewayToken: agentCfg?.gatewayToken,
      };
      try {
        if (throttle) {
          log.info(`Dispatch throttle: waiting for ${agentName}`);
          await throttle.wait(route.agentId);
          throttle.record(route.agentId);
        }
        const directResult = await deliverWithSlot(route, deliveryConfig, throttle, dispatchLeaseStore, dispatchInFlightStore, sessionSpawnStore);
        appendOperationalEvent(operationalEventStore, { outcome: directResult.runId ? "dispatch-accepted" : "delivered", type: event.type, agent: agentName, key: ticketId, sessionKey: ticketId, deliveryMode: "direct", attemptCount: 1, runId: directResult.runId ?? null, wakeId, plane: "connector", detail: directResult.canonVersion ? { canonVersion: directResult.canonVersion } : undefined });
        // Direct deliveries (incl. comment-routed wakes into an existing
        // session) must register the dispatch and flip engagement → Thinking
        // like every other delivery path. Observed on AI-1768 (2026-07-04
        // 07:13): a revision comment woke the delegate but the ticket sat at
        // To Do with no ack expectation — invisible pickup, unwatched dispatch.
        if (directResult.runId && onDispatched) onDispatched(agentName, ticketId);
      } catch (err) {
        log.error(`OpenClaw delivery failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
        appendOperationalEvent(operationalEventStore, { outcome: "delivery-failed", type: event.type, agent: agentName, key: ticketId, sessionKey: ticketId, deliveryMode: "direct", attemptCount: 1, errorSummary: errorSummary(err) });
      } finally {
        if (agentQueue) {
          let next = agentQueue.complete(route.agentId);
          while (next) {
            log.info(`Agent queue: promoting next task for ${route.agentId} [${next.sessionKey}]`);
            try {
              if (throttle) {
                log.info(`Dispatch throttle: waiting for ${route.agentId} (drain)`);
                await throttle.wait(route.agentId);
                throttle.record(route.agentId);
              }
              const drainResult = await deliverWithSlot(next, deliveryConfig, throttle, dispatchLeaseStore, dispatchInFlightStore, sessionSpawnStore);
              appendOperationalEvent(operationalEventStore, { outcome: drainResult.runId ? "dispatch-accepted" : "delivered", type: next.event.type, agent: route.agentId, key: next.sessionKey, sessionKey: next.sessionKey, deliveryMode: "agent-queue-drain", attemptCount: 1, runId: drainResult.runId ?? null, detail: drainResult.canonVersion ? { canonVersion: drainResult.canonVersion } : undefined });
            } catch (err) {
              log.error(`Agent queue: failed to deliver promoted task for ${route.agentId}: ${err instanceof Error ? err.message : String(err)}`);
              appendOperationalEvent(operationalEventStore, { outcome: "delivery-failed", type: next.event.type, agent: route.agentId, key: next.sessionKey, sessionKey: next.sessionKey, deliveryMode: "agent-queue-drain", attemptCount: 1, errorSummary: errorSummary(err) });
            }
            next = agentQueue.complete(route.agentId);
          }
        }
      }
      } // dispatchRoute
    },
  );

  return router;
}
