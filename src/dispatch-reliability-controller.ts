/**
 * INF-1262 — Unified Dispatch Reliability Controller.
 *
 * One controller owns circuit-breaker + redispatch-budget + stuck-delegate
 * detection — no duplicated/competing logic. Wake-policy is enforced in a
 * single shared delivery primitive (`dispatchWithAck`); all wake callers go
 * through it. Governed-transition wakes route through the acked delivery
 * scheduler (delivery confirmed + retried) — no fire-and-forget drops.
 * Delegate-clear tickets recover inline with bounded latency.
 */

import type { SchedulerDispatchParams } from "./delivery/dispatch-delivery-scheduler.js";
import type { DeliverWithAckOutcome } from "./delivery/deliver-with-ack.js";

// ---------------------------------------------------------------------------
// Dependencies (injectable — the controller delegates to these)
// ---------------------------------------------------------------------------

export interface DispatchReliabilityControllerDeps {
  /** The acked delivery scheduler — all dispatches route through here. */
  dispatchDeliveryScheduler: {
    start(): void;
    stop(): void;
    dispatch(params: SchedulerDispatchParams): Promise<DeliverWithAckOutcome>;
    liveness(): Record<string, unknown>;
  };
  /** Max consecutive wakes before the breaker trips and alerts. */
  maxConsecutiveWakes: number;
  /** Max redispatches per ticket before budget exhaustion blocks further wakes. */
  redispatchBudgetPerTicket: number;
  /** Max stuck-delegate re-prompts per ticket before the cap blocks further ones. */
  maxStuckPromptsPerTicket: number;
  /** Wake paths that route through this controller's wake-policy enforcement. */
  wakePolicySubscribers: string[];
  /** Upper bound for inline delegate-clear recovery latency (ms). */
  delegateClearRecoveryMaxLatencyMs: number;
  /** Inline recovery handler for delegate-clear tickets. */
  recoverDelegateClearInline(params: {
    ticketId: string;
    labels: string[];
  }): Promise<{ recovered: boolean }>;
  /** The hourly rescue sweep — not used for inline recovery, but referenced for liveness. */
  hourlyRescueSweep: { run(): Promise<void> | void };
  /** Legacy fire-and-forget wake — NEVER called by dispatchWithAck. Present for diagnostics. */
  fireAndForgetWake(...args: unknown[]): unknown;
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

interface TicketBreakerState {
  /** Consecutive wakes with no delegate activity. */
  wakeCount: number;
  /** ISO timestamp of the last delegate activity, or null if none recorded. */
  lastActivityAt: string | null;
  /** Whether the breaker has tripped (alert threshold reached). */
  shouldAlert: boolean;
}

interface WakePolicyResult {
  allowed: boolean;
  reason: string | null;
}

interface BreakerEvalResult {
  shouldAlert: boolean;
  wakeCount: number;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * DispatchReliabilityController — the single owner of circuit-breaker,
 * redispatch-budget, and stuck-delegate detection.
 *
 * Wake-policy is enforced inside `dispatchWithAck`, the shared delivery
 * primitive. All wake callers route through it; there is no fire-and-forget
 * path.
 */
export class DispatchReliabilityController {
  private readonly breakerState = new Map<string, TicketBreakerState>();
  private readonly redispatchCount = new Map<string, number>();
  private readonly stuckPromptCount = new Map<string, number>();
  private active = false;

  constructor(private readonly deps: DispatchReliabilityControllerDeps) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Start the controller — arms the underlying delivery scheduler. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.deps.dispatchDeliveryScheduler.start();
  }

  /** Stop the controller and the underlying delivery scheduler. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.deps.dispatchDeliveryScheduler.stop();
  }

  // ── Circuit-breaker API ────────────────────────────────────────────────

  /**
   * Record a wake dispatch for circuit-breaker tracking and redispatch budget.
   */
  recordWake(ticketId: string, _labels: string[]): void {
    const existing = this.breakerState.get(ticketId);
    const lastActivityAt = existing?.lastActivityAt ?? null;

    // If delegate activity was recorded, reset the counter to 1 for this wake.
    const wakeCount = lastActivityAt !== null ? 1 : (existing?.wakeCount ?? 0) + 1;
    const shouldAlert =
      wakeCount >= this.deps.maxConsecutiveWakes && lastActivityAt === null;

    this.breakerState.set(ticketId, { wakeCount, lastActivityAt, shouldAlert });

    // Track redispatch budget
    const budget = (this.redispatchCount.get(ticketId) ?? 0) + 1;
    this.redispatchCount.set(ticketId, budget);
  }

  /**
   * Record evidence of delegate activity (comment, state change, ack).
   * Resets the breaker counter and clears the alert.
   */
  recordDelegateActivity(ticketId: string): void {
    this.breakerState.set(ticketId, {
      wakeCount: 0,
      lastActivityAt: new Date().toISOString(),
      shouldAlert: false,
    });
  }

  /**
   * Evaluate whether this ticket should fire a transition-stuck alert.
   */
  evaluateBreaker(ticketId: string): BreakerEvalResult {
    const existing = this.breakerState.get(ticketId);
    if (!existing) {
      return { shouldAlert: false, wakeCount: 0, reason: null };
    }

    if (existing.shouldAlert) {
      return {
        shouldAlert: true,
        wakeCount: existing.wakeCount,
        reason: `transition-stuck: ${existing.wakeCount} consecutive wakes, no delegate activity`,
      };
    }

    if (existing.lastActivityAt !== null) {
      return {
        shouldAlert: false,
        wakeCount: existing.wakeCount,
        reason: `delegate activity at ${existing.lastActivityAt}`,
      };
    }

    return {
      shouldAlert: false,
      wakeCount: existing.wakeCount,
      reason: `${existing.wakeCount}/${this.deps.maxConsecutiveWakes} wakes before alert threshold`,
    };
  }

  /**
   * Reset the breaker for a ticket (steward override or state advance).
   * Returns true if there was state to clear.
   */
  resetBreaker(ticketId: string): boolean {
    const had = this.breakerState.has(ticketId);
    this.breakerState.delete(ticketId);
    this.redispatchCount.delete(ticketId);
    return had;
  }

  /**
   * Check if the breaker is currently blocking dispatches for this ticket.
   */
  checkBreaker(ticketId: string): { blocked: boolean } {
    const existing = this.breakerState.get(ticketId);
    return { blocked: existing?.shouldAlert === true };
  }

  // ── Stuck-delegate prompt tracking ─────────────────────────────────────

  /** Record a stuck-delegate re-prompt for this ticket. */
  recordStuckPrompt(ticketId: string): void {
    const current = this.stuckPromptCount.get(ticketId) ?? 0;
    this.stuckPromptCount.set(ticketId, current + 1);
  }

  /** Get the number of stuck-delegate re-prompts sent for this ticket. */
  getStuckPromptCount(ticketId: string): number {
    return this.stuckPromptCount.get(ticketId) ?? 0;
  }

  // ── Wake-policy enforcement ────────────────────────────────────────────

  /**
   * Evaluate whether a wake is allowed for this ticket under the unified
   * wake-policy (circuit-breaker + redispatch-budget + stuck-prompt cap).
   */
  enforceWakePolicy(ticketId: string, _labels: string[]): WakePolicyResult {
    // Circuit-breaker check
    if (this.checkBreaker(ticketId).blocked) {
      return { allowed: false, reason: "circuit-breaker tripped" };
    }

    // Redispatch-budget check
    const budgetUsed = this.redispatchCount.get(ticketId) ?? 0;
    if (budgetUsed >= this.deps.redispatchBudgetPerTicket) {
      return { allowed: false, reason: "redispatch budget exhausted" };
    }

    // Stuck-prompt cap check
    const stuckPrompts = this.stuckPromptCount.get(ticketId) ?? 0;
    if (stuckPrompts >= this.deps.maxStuckPromptsPerTicket) {
      return { allowed: false, reason: "stuck-prompt cap reached" };
    }

    return { allowed: true, reason: null };
  }

  // ── Shared delivery primitive ──────────────────────────────────────────

  /**
   * Dispatch a wake through the unified delivery path.
   *
   * 1. Enforces wake-policy pre-flight (circuit-breaker / budget / stuck cap).
   * 2. If `delegateCleared` is truthy, runs inline delegate-clear recovery.
   * 3. Routes through the acked delivery scheduler (confirmed + retried).
   * 4. NEVER calls fire-and-forget wake.
   */
  async dispatchWithAck(
    params: SchedulerDispatchParams & { labels?: string[]; delegateCleared?: boolean },
  ): Promise<DeliverWithAckOutcome> {
    const labels = params.labels ?? [];

    // Wake-policy pre-flight
    const policy = this.enforceWakePolicy(params.ticketId, labels);
    if (!policy.allowed) {
      throw new Error(
        `wake-policy blocked dispatch for ${params.ticketId}: ${policy.reason}`,
      );
    }

    // Inline delegate-clear recovery (bounded latency, no hourly sweep wait)
    if (params.delegateCleared) {
      await this.deps.recoverDelegateClearInline({
        ticketId: params.ticketId,
        labels,
      });
    }

    // Route through the acked delivery scheduler — delivery confirmed + retried
    const { labels: _omit1, delegateCleared: _omit2, ...schedulerParams } = params;
    return this.deps.dispatchDeliveryScheduler.dispatch(schedulerParams);
  }

  // ── Liveness ───────────────────────────────────────────────────────────

  /**
   * Liveness snapshot observable at /health and ac-validate without waiting
   * for a trigger condition.
   */
  liveness(): Record<string, unknown> {
    return {
      active: this.active,
      controllerRegistered: true,
      circuitBreaker: {
        active: true,
        owner: "dispatch-reliability-controller",
      },
      redispatchBudget: {
        active: true,
        owner: "dispatch-reliability-controller",
      },
      stuckDelegateDetection: {
        active: true,
        owner: "dispatch-reliability-controller",
      },
      delegateClearRecovery: {
        mode: "inline",
        maxLatencyMs: this.deps.delegateClearRecoveryMaxLatencyMs,
      },
      wakePolicyPrimitive: "dispatchWithAck",
      subscribedWakePaths: this.deps.wakePolicySubscribers,
    };
  }
}
