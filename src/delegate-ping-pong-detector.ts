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
import { getAccessToken } from "./agents.js";

const log = componentLogger(createLogger(), "delegate-ping-pong-detector");

const DEFAULT_MAX_BOUNCES = 3;
const DEFAULT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

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
    // STUB: Implementation returns immediately without recording.
    // TODO: Record the assignment to the in-memory chain, push to the
    // ticket's chain array, and retain only entries within the configured
    // sliding window (config.windowMs).
    void log;
    void ticketId;
    void delegateId;
    void agentName;
    void now;
  }

  /**
   * Get the delegate assignment chain for a ticket (within the configured window).
   */
  getChain(ticketId: string): DelegateAssignment[] {
    // STUB: Returns empty array — implement by reading this.chains.
    void ticketId;
    return [];
  }

  /**
   * Detect whether a ticket's delegate chain shows a ping-pong cycle.
   */
  detectCycle(ticketId: string, now?: number): CycleDetectionResult {
    // STUB: Returns no-cycle — implement by:
    // 1. Pruning entries outside config.windowMs from `now`.
    // 2. Counting occurrences of each delegateId in the chain.
    // 3. Finding delegates with count >= config.maxBounces.
    void now;
    return {
      hasCycle: false,
      cyclingDelegates: [],
      bounceCounts: {},
      maxAllowed: this.config.maxBounces,
      chain: this.getChain(ticketId),
    };
  }

  /**
   * Clear the chain for a ticket.
   */
  clearTicket(ticketId: string): void {
    // STUB: Does nothing — implement by deleting from this.chains.
    void ticketId;
  }

  /**
   * Clear all chains.
   */
  clearAll(): void {
    // STUB: Does nothing — implement by clearing this.chains.
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
  // STUB: Returns not-fired — implement by:
  // 1. Acquiring an auth token (via getAccessToken("ai"), process.env, or authToken param).
  // 2. Resolving the Linear internal issue ID from ticketId.
  // 3. Posting a comment describing the cycle detection and escalation.
  // 4. Reassigning the delegate to the steward (Ai) via Linear API.
  // 5. Logging the event at warn level.
  void authToken;
  return {
    fired: false,
    ticketId,
    escalatedTo: "ai",
    bounceCount,
    cyclingDelegates,
  };
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

  constructor(
    chainTracker?: DelegateChainTracker,
    config?: Partial<DelegatePingPongConfig>,
    operationalEventStore?: OperationalEventStore,
  ) {
    this.chainTracker = chainTracker ?? new DelegateChainTracker(config);
    this.config = {
      maxBounces: config?.maxBounces ??
        (parseInt(process.env.PING_PONG_MAX_BOUNCES ?? "", 10) || DEFAULT_MAX_BOUNCES),
      windowMs: config?.windowMs ??
        (parseInt(process.env.PING_PONG_WINDOW_MS ?? "", 10) || DEFAULT_WINDOW_MS),
    };
    this.operationalEventStore = operationalEventStore;
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
  ): Promise<PingPongHandlingResult> {
    // STUB: Delegates to chain tracker but won't detect cycles until
    // the tracker is fully implemented.
    void delegateId;
    void agentName;

    this.chainTracker.recordAssignment(ticketId, delegateId, agentName, now);
    const detection = this.chainTracker.detectCycle(ticketId, now);
    let escalation: EscalationResult | null = null;
    let suppressDispatch = false;

    if (detection.hasCycle) {
      suppressionExpected:
      // Cycle detected — fire escalation (stub returns not-fired until implemented).
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
            outcome: "ping-pong-cycle-detected" as any,
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
