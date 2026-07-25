/**
 * DelegatePingPongDetector — cycle detection + escalation ladder for delegate
 * chains on governed tickets.
 *
 * Problem (INF-195 / INF-218 parent): Blocked work bouncing between delegates
 * loops silently. Example: Hanzo diagnoses a merge-blocked ticket and
 * escalates to Ai; Ai re-delegates back to Hanzo 23 seconds later with no new
 * instruction. The ticket holds two delegates in alternating sequence, and
 * neither can advance it, but the connector treats each re-delegation as a
 * fresh dispatch — no cycle detection, no escalation.
 *
 * This detector closes the gap by:
 *   1. Tracking the delegate chain for each ticket (persisted).
 *   2. Detecting when the same ticket returns to a prior delegate ≥ N times
 *      within a configurable window (default N=3).
 *   3. On detection, firing the escalation ladder (escalate to steward/Ai)
 *      instead of continuing to bounce the delegate.
 *   4. Emitting a structured log entry and operational event for observability.
 *
 * The detector is integrated into the webhook dispatch path (router.ts or
 * webhook/index.ts) so every delegate-change event is recorded and checked.
 *
 * Configuration (env vars, all optional):
 *   PING_PONG_MAX_BOUNCES         — max allowed repeat delegate visits before
 *                                   escalation (default: 3)
 *   PING_PONG_WINDOW_MS           — sliding window for cycle counting
 *                                   (default: 30 min)
 */

import { createLogger, componentLogger } from "./logger.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";
import { getAccessToken, getLinearUserIdForAgent } from "./agents.js";
import { resolveAgentIdentifiersForRole } from "./escalation-gate.js";
import { getCurrentState, getWorkflowId, loadWorkflowDefById } from "./workflow-gate.js";

const log = componentLogger(createLogger(), "delegate-ping-pong-detector");

const DEFAULT_MAX_BOUNCES = 3;
const DEFAULT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const LINEAR_API_URL = "https://api.linear.app/graphql";

// INF-574: roles whose members are terminal, non-oscillation dispatch targets.
// A dispatch TO the merge-gate owner (Hanzo, role `deployment`) is the legitimate
// terminal action of a workflow, never a bounce — so it must not be suppressed as
// ping-pong even when some OTHER delegate cycled in the window (the INF-573 repro:
// repeated intake bounces cycle the steward, which then suppresses the correct,
// first dispatch to Hanzo). Overridable via PING_PONG_EXEMPT_ROLES (csv).
const DEFAULT_EXEMPT_TERMINAL_ROLES = ["deployment"];

function parseExemptRoles(): string[] {
  const raw = process.env.PING_PONG_EXEMPT_ROLES;
  if (raw === undefined) return [...DEFAULT_EXEMPT_TERMINAL_ROLES];
  const roles = raw.split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);
  return roles.length ? roles : [...DEFAULT_EXEMPT_TERMINAL_ROLES];
}

/**
 * Resolver deciding whether a dispatch's target agent is a terminal merge-gate
 * owner that must be exempt from ping-pong suppression. Injectable so tests can
 * stub the policy without a fixture; the default consults the capability policy.
 */
export type ExemptTerminalTargetResolver = (
  agentName: string,
  delegateId: string,
) => Promise<boolean> | boolean;

/**
 * Resolver deciding whether a dispatch target is already legal for the current
 * workflow state. Ping-pong suppression is a loop breaker, not a workflow
 * authority override; if the workflow def says the target fills the current
 * state's owner_role, the dispatch must be allowed through.
 */
export type LegalWorkflowTargetResolver = (
  agentName: string,
  delegateId: string,
  ticketLabels?: string[],
) => Promise<boolean> | boolean;

/**
 * Default terminal-target resolver: exempt when the target agent fills a
 * configured merge-gate/terminal role (default `deployment`, filled by Hanzo).
 * Resolves role → body identifiers via the capability policy and matches
 * case-insensitively against the openclaw agent name. Fails CLOSED to
 * not-exempt (normal oscillation protection stands) on any resolution error —
 * the exemption is a narrow safety valve, never a way to disable the guard.
 */
export async function defaultExemptTerminalTargetResolver(
  agentName: string,
  _delegateId: string,
): Promise<boolean> {
  const target = agentName?.toLowerCase().trim();
  if (!target) return false;
  try {
    for (const roleId of parseExemptRoles()) {
      const identifiers = await resolveAgentIdentifiersForRole(roleId);
      if (identifiers.has(target)) return true;
    }
    return false;
  } catch (err) {
    log.warn(
      `ping-pong exempt-target resolve failed (treating as non-exempt): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

export async function defaultLegalWorkflowTargetResolver(
  agentName: string,
  _delegateId: string,
  ticketLabels?: string[],
): Promise<boolean> {
  if (!ticketLabels?.length) return false;
  const workflowId = getWorkflowId(ticketLabels);
  if (!workflowId) return false;

  try {
    const def = await loadWorkflowDefById(workflowId);
    if (!def) return false;
    const currentState = getCurrentState(ticketLabels, def);
    if (!currentState) return false;
    const stateNode = def.states.find((s) => s.id === currentState);
    if (!stateNode || stateNode.kind === "terminal" || !stateNode.owner_role) return false;

    const identifiers = await resolveAgentIdentifiersForRole(stateNode.owner_role);
    return identifiers.has(agentName.toLowerCase().trim());
  } catch (err) {
    log.warn(
      `ping-pong legal-workflow-target resolve failed (treating as non-exempt): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface DelegatePingPongConfig {
  /**
   * How many times the same delegate must be seen in the chain before
   * a cycle is declared. Default: 3.
   */
  maxBounces: number;
  /**
   * Sliding window (in ms) within which delegate assignments are considered.
   * Assignments older than this are pruned. Default: 30 min.
   */
  windowMs: number;
}

export interface DelegateAssignment {
  /** The ticket identifier (e.g. "GEN-263"). */
  ticketId: string;
  /** The Linear user ID of the delegate. */
  delegateId: string;
  /** The agent name (openclaw name) of the delegate. */
  agentName: string;
  /** ISO timestamp of the assignment. */
  timestamp: string;
  /** Unix epoch ms of the assignment. */
  timestampMs: number;
}

export interface CycleDetectionResult {
  hasCycle: boolean;
  /** The delegate(s) that appeared ≥ maxBounces times. */
  cyclingDelegates: string[];
  /** How many times each cycling delegate appeared. */
  bounceCounts: Record<string, number>;
  /** The configured max bounces threshold. */
  maxAllowed: number;
  /** The full chain for the ticket (within window). */
  chain: DelegateAssignment[];
}

export interface EscalationResult {
  /** Whether escalation was fired. */
  fired: boolean;
  /** Ticket identifier that triggered escalation. */
  ticketId: string;
  /** Agent name that was escalated to (typically "ai"). */
  escalatedTo: string;
  /** Number of bounces detected. */
  bounceCount: number;
  /** The cycling delegate(s). */
  cyclingDelegates: string[];
}

export interface PingPongHandlingResult {
  /** Whether cycle detection was performed. */
  checked: boolean;
  /** Cycle detection result, if checked. */
  detection: CycleDetectionResult | null;
  /** Escalation result, if escalation was attempted. */
  escalation: EscalationResult | null;
  /** Whether the dispatch should be suppressed (cycle detected → no dispatch). */
  suppressDispatch: boolean;
}

export function shouldCheckDelegatePingPong(updatedFrom?: Record<string, unknown>): boolean {
  if (!updatedFrom || (!("delegateId" in updatedFrom) && !("delegate" in updatedFrom))) {
    return false;
  }

  return !("stateId" in updatedFrom) && !("state" in updatedFrom);
}

// ── DelegateChainTracker ─────────────────────────────────────────────────────

/**
 * Tracks delegate assignments per ticket. Maintains an in-memory chain
 * that records every delegate-change event seen by the webhook.
 */
export class DelegateChainTracker {
  private chains: Map<string, DelegateAssignment[]> = new Map();
  private config: DelegatePingPongConfig;

  constructor(config?: Partial<DelegatePingPongConfig>) {
    this.config = {
      maxBounces: config?.maxBounces ??
        (parseInt(process.env.PING_PONG_MAX_BOUNCES ?? "", 10) || DEFAULT_MAX_BOUNCES),
      windowMs: config?.windowMs ??
        (parseInt(process.env.PING_PONG_WINDOW_MS ?? "", 10) || DEFAULT_WINDOW_MS),
    };
  }

  /**
   * Record a delegate assignment for a ticket.
   */
  recordAssignment(ticketId: string, delegateId: string, agentName: string, now?: number): void {
    const timestampMs = now ?? Date.now();
    const assignment: DelegateAssignment = {
      ticketId,
      delegateId,
      agentName,
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
    };
    const chain = this.pruneChain(this.chains.get(ticketId) ?? [], timestampMs);
    chain.push(assignment);
    this.chains.set(ticketId, chain);
  }

  /**
   * Get the delegate assignment chain for a ticket (within the configured window).
   */
  getChain(ticketId: string): DelegateAssignment[] {
    return [...(this.chains.get(ticketId) ?? [])];
  }

  /**
   * Detect whether a ticket's delegate chain shows a ping-pong cycle.
   *
   * INF-574: a cycle is counted in BOUNCES (returns), not raw occurrences. The
   * class was always meant to catch the A→B→A shape — a delegate that *returns*
   * after a different delegate held the ticket — but the original code counted
   * bare occurrences, so a monotonic forward routing chain (or duplicate
   * delegate-change webhooks for a single delegate) was miscounted identically
   * to real oscillation. Collapsing consecutive runs of the same delegate before
   * counting closes that: A→A→A is one bounce, A→B→A is two. This strengthens
   * real A↔B protection AND stops false-positives on legitimate forward progress.
   */
  detectCycle(ticketId: string, now?: number): CycleDetectionResult {
    const timestampMs = now ?? Date.now();
    const chain = this.pruneChain(this.chains.get(ticketId) ?? [], timestampMs);
    this.chains.set(ticketId, chain);

    // Count bounces: an assignment only counts when it changes the delegate from
    // the immediately preceding one (a genuine hand-off/return), so consecutive
    // re-assignments of the same delegate collapse to a single bounce.
    const bounceCounts: Record<string, number> = {};
    let prevDelegateId: string | null = null;
    for (const assignment of chain) {
      if (assignment.delegateId === prevDelegateId) continue;
      bounceCounts[assignment.delegateId] = (bounceCounts[assignment.delegateId] ?? 0) + 1;
      prevDelegateId = assignment.delegateId;
    }

    const cyclingDelegates = Object.entries(bounceCounts)
      .filter(([, count]) => count >= this.config.maxBounces)
      .map(([delegateId]) => delegateId);

    return {
      hasCycle: cyclingDelegates.length > 0,
      cyclingDelegates,
      bounceCounts,
      maxAllowed: this.config.maxBounces,
      chain,
    };
  }

  /**
   * Clear the chain for a ticket.
   */
  clearTicket(ticketId: string): void {
    this.chains.delete(ticketId);
  }

  /**
   * Clear all chains.
   */
  clearAll(): void {
    this.chains.clear();
  }

  private pruneChain(chain: DelegateAssignment[], now: number): DelegateAssignment[] {
    const cutoff = now - this.config.windowMs;
    return chain.filter((assignment) => assignment.timestampMs >= cutoff);
  }
}

// ── Escalation ───────────────────────────────────────────────────────────────

/**
 * Fire the escalation ladder: post a comment to the Linear ticket and
 * re-delegate to the steward (Ai).
 */
export async function fireEscalation(
  ticketId: string,
  cyclingDelegates: string[],
  bounceCount: number,
  authToken?: string,
): Promise<EscalationResult> {
  const token =
    authToken ??
    getAccessToken("ai") ??
    process.env.LINEAR_OAUTH_TOKEN ??
    process.env.LINEAR_API_KEY;

  if (!token) {
    log.error(`ping-pong escalation: no auth token for ${ticketId}`);
    return {
      fired: false,
      ticketId,
      escalatedTo: "ai",
      bounceCount,
      cyclingDelegates,
    };
  }

  const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  const issueId = await resolveIssueId(ticketId, authHeader);
  if (!issueId) {
    log.error(`ping-pong escalation: could not resolve issue ID for ${ticketId}`);
    return {
      fired: false,
      ticketId,
      escalatedTo: "ai",
      bounceCount,
      cyclingDelegates,
    };
  }

  const delegates = cyclingDelegates.join(", ");
  const body =
    `[Connector] Delegate ping-pong cycle detected on ${ticketId}: ` +
    `${delegates} reached ${bounceCount} assignment(s) within the configured window. ` +
    "Suppressing this dispatch and escalating to steward (Ai).";
  const commentPosted = await postComment(issueId, body, authHeader);

  const stewardUserId = getLinearUserIdForAgent("ai");
  const delegateChanged = stewardUserId
    ? await updateDelegate(issueId, stewardUserId, authHeader)
    : false;

  if (!stewardUserId) {
    log.error("ping-pong escalation: steward 'ai' has no Linear user ID");
  }

  const fired = commentPosted && delegateChanged;
  log.warn(
    `PING_PONG_CYCLE_DETECTED: issue=${ticketId} delegates=${delegates} ` +
    `bounceCount=${bounceCount} escalatedTo=ai fired=${fired}`,
  );

  return {
    fired,
    ticketId,
    escalatedTo: "ai",
    bounceCount,
    cyclingDelegates,
  };
}

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
    log.error(`ping-pong escalation: issue lookup failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function postComment(
  issueId: string,
  body: string,
  authHeader: string,
): Promise<boolean> {
  const mutation = `
    mutation($issueId: String!, $body: String!) {
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
    log.error(`ping-pong escalation: comment post failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function updateDelegate(
  issueId: string,
  delegateId: string,
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
      body: JSON.stringify({ query: mutation, variables: { issueId, delegateId } }),
    });
    const data = (await res.json()) as { data?: { issueUpdate?: { success: boolean } } };
    return Boolean(data.data?.issueUpdate?.success);
  } catch (err) {
    log.error(`ping-pong escalation: delegate update failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Main Detector ────────────────────────────────────────────────────────────

/**
 * High-level detector that checks a delegate assignment against the chain
 * and fires escalation if a cycle is detected.
 */
export class DelegatePingPongDetector {
  private chainTracker: DelegateChainTracker;
  private config: DelegatePingPongConfig;
  private operationalEventStore?: OperationalEventStore;
  private isExemptTerminalTarget: ExemptTerminalTargetResolver;
  private isLegalWorkflowTarget: LegalWorkflowTargetResolver;

  constructor(
    chainTracker?: DelegateChainTracker,
    config?: Partial<DelegatePingPongConfig>,
    operationalEventStore?: OperationalEventStore,
    exemptTargetResolver?: ExemptTerminalTargetResolver,
    legalWorkflowTargetResolver?: LegalWorkflowTargetResolver,
  ) {
    this.chainTracker = chainTracker ?? new DelegateChainTracker(config);
    this.config = {
      maxBounces: config?.maxBounces ??
        (parseInt(process.env.PING_PONG_MAX_BOUNCES ?? "", 10) || DEFAULT_MAX_BOUNCES),
      windowMs: config?.windowMs ??
        (parseInt(process.env.PING_PONG_WINDOW_MS ?? "", 10) || DEFAULT_WINDOW_MS),
    };
    this.operationalEventStore = operationalEventStore;
    this.isExemptTerminalTarget = exemptTargetResolver ?? defaultExemptTerminalTargetResolver;
    this.isLegalWorkflowTarget = legalWorkflowTargetResolver ?? defaultLegalWorkflowTargetResolver;
  }

  getChainTracker(): DelegateChainTracker {
    return this.chainTracker;
  }

  /**
   * Check a delegate assignment for ping-pong cycles.
   * Records the assignment, detects cycles, and fires escalation if needed.
   *
   * Returns a PingPongHandlingResult describing what happened.
   */
  async checkAndHandle(
    ticketId: string,
    delegateId: string,
    agentName: string,
    now?: number,
    ticketLabels?: string[],
  ): Promise<PingPongHandlingResult> {
    this.chainTracker.recordAssignment(ticketId, delegateId, agentName, now);
    const detection = this.chainTracker.detectCycle(ticketId, now);
    let escalation: EscalationResult | null = null;
    let suppressDispatch = false;

    if (detection.hasCycle) {
      // INF-574: a dispatch whose TARGET is a terminal merge-gate owner (Hanzo,
      // role `deployment`) is the legitimate terminal action, not a bounce. The
      // per-delegate counter fires on ANY cycling delegate in the window, so a
      // repaired "third attempt that is finally the correct route to the merge
      // gate" gets suppressed because some earlier delegate (the steward, from
      // repeated intake bounces) cycled — the exact INF-573 failure. Let this
      // dispatch through and do not escalate. Narrowly scoped to the target
      // being the merge-gate role; every other route still suppresses (AC2).
      let exempt = false;
      try {
        exempt = await this.isExemptTerminalTarget(agentName, delegateId);
      } catch (err) {
        log.warn(
          `ping-pong exempt-target check failed for ${ticketId} (treating as non-exempt): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (exempt) {
        const bounceCount = Object.values(detection.bounceCounts).reduce((a, b) => Math.max(a, b), 0);
        log.warn(
          `PING_PONG_EXEMPT_TERMINAL_TARGET: issue=${ticketId} target=${agentName} ` +
          `cyclingDelegates=${detection.cyclingDelegates.join(", ")} bounceCount=${bounceCount} ` +
          "— cycle observed but dispatch allowed (terminal merge-gate owner).",
        );
        if (this.operationalEventStore) {
          try {
            this.operationalEventStore.append({
              outcome: "ping-pong-exempt-terminal-target",
              agent: agentName,
              key: ticketId,
              sessionKey: ticketId,
              deliveryMode: "delegate-ping-pong-detector",
              attemptCount: bounceCount,
              detail: {
                ticketId,
                target: agentName,
                cyclingDelegates: detection.cyclingDelegates,
                bounceCounts: detection.bounceCounts,
                maxAllowed: detection.maxAllowed,
              },
            });
          } catch (err) {
            log.error(
              `Operational event append failed for ping-pong exemption on ${ticketId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        return {
          checked: true,
          detection,
          escalation: null,
          suppressDispatch: false,
        };
      }

      let legalWorkflowTarget = false;
      try {
        legalWorkflowTarget = await this.isLegalWorkflowTarget(agentName, delegateId, ticketLabels);
      } catch (err) {
        log.warn(
          `ping-pong legal-workflow-target check failed for ${ticketId} (treating as non-exempt): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (legalWorkflowTarget) {
        const bounceCount = Object.values(detection.bounceCounts).reduce((a, b) => Math.max(a, b), 0);
        log.warn(
          `PING_PONG_EXEMPT_LEGAL_WORKFLOW_TARGET: issue=${ticketId} target=${agentName} ` +
          `cyclingDelegates=${detection.cyclingDelegates.join(", ")} bounceCount=${bounceCount} ` +
          "- cycle observed but dispatch allowed (target owns current workflow state).",
        );
        if (this.operationalEventStore) {
          try {
            this.operationalEventStore.append({
              outcome: "ping-pong-exempt-legal-workflow-target",
              agent: agentName,
              key: ticketId,
              sessionKey: ticketId,
              deliveryMode: "delegate-ping-pong-detector",
              attemptCount: bounceCount,
              detail: {
                ticketId,
                target: agentName,
                labels: ticketLabels ?? [],
                cyclingDelegates: detection.cyclingDelegates,
                bounceCounts: detection.bounceCounts,
                maxAllowed: detection.maxAllowed,
              },
            });
          } catch (err) {
            log.error(
              `Operational event append failed for ping-pong legal-workflow exemption on ${ticketId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        return {
          checked: true,
          detection,
          escalation: null,
          suppressDispatch: false,
        };
      }

      escalation = await fireEscalation(
        ticketId,
        detection.cyclingDelegates,
        Object.values(detection.bounceCounts).reduce((a, b) => Math.max(a, b), 0),
      );

      suppressDispatch = true;

      // Post operational event for observability
      if (this.operationalEventStore) {
        try {
          this.operationalEventStore.append({
            outcome: "ping-pong-cycle-detected",
            agent: agentName,
            key: ticketId,
            sessionKey: ticketId,
            deliveryMode: "delegate-ping-pong-detector",
            attemptCount: Object.values(detection.bounceCounts).reduce((a, b) => Math.max(a, b), 0),
            detail: {
              ticketId,
              cyclingDelegates: detection.cyclingDelegates,
              bounceCounts: detection.bounceCounts,
              maxAllowed: detection.maxAllowed,
              escalationFired: escalation.fired,
            },
          });
        } catch (err) {
          log.error(
            `Operational event append failed for ping-pong cycle on ${ticketId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    return {
      checked: true,
      detection,
      escalation,
      suppressDispatch,
    };
  }
}
