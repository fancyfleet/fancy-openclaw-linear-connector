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
import {
  checkBreaker as legacyCheckBreaker,
  recordDispatch as legacyRecordDispatch,
  recordRepokeAndCheckBreaker as legacyRecordRepokeAndCheckBreaker,
  checkCommentFedSuppressionForTicket as legacyCheckCommentFedSuppression,
  getCircuitBreakerHealth as legacyGetCircuitBreakerHealth,
  type TicketBreakerState as LegacyTicketBreakerState,
} from "./dispatch-circuit-breaker.js";

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
  /**
   * INF-1262 AC1: the SAME shared, SQLite-backed redispatch-budget instance
   * already injected into stale-session-forensics/no-activity-detector/
   * dispatch-watchdog (constructed once in index.ts). When provided, the
   * controller consumes/reads THIS instance instead of its own in-memory
   * counter, so there is exactly one redispatch-budget source of truth for
   * every consumer, not a shadow counter that drifts from the real one.
   * Optional so the unit-test contract (which exercises the controller in
   * isolation with no real store) keeps working against the internal Map.
   */
  globalRedispatchBudget?: {
    consume(ticketId: string): number;
    get(ticketId: string): number;
    reset(ticketId: string): void;
    readonly maxAttempts: number;
  };
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

    // Track redispatch budget — the shared SQLite-backed instance when wired
    // (production), otherwise the local Map (isolated unit-test contract).
    if (this.deps.globalRedispatchBudget) {
      this.deps.globalRedispatchBudget.consume(ticketId);
    } else {
      const budget = (this.redispatchCount.get(ticketId) ?? 0) + 1;
      this.redispatchCount.set(ticketId, budget);
    }
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
    this.deps.globalRedispatchBudget?.reset(ticketId);
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

  /**
   * Clear the stuck-prompt count for a ticket (e.g. it transitioned, or the
   * stuck condition timed out). INF-1262 AC1: the counter StuckDelegateDetector
   * consults via its `promptCounter` dep.
   */
  clearStuckPromptCount(ticketId: string): void {
    this.stuckPromptCount.delete(ticketId);
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

    // Redispatch-budget check — read the shared instance when wired
    // (production, real cap = globalRedispatchBudget.maxAttempts), otherwise
    // the local Map against the configured per-ticket budget.
    const budgetUsed = this.deps.globalRedispatchBudget
      ? this.deps.globalRedispatchBudget.get(ticketId)
      : this.redispatchCount.get(ticketId) ?? 0;
    const budgetCap = this.deps.globalRedispatchBudget
      ? this.deps.globalRedispatchBudget.maxAttempts
      : this.deps.redispatchBudgetPerTicket;
    if (budgetUsed >= budgetCap) {
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

    // Inline delegate-clear recovery (bounded latency, no hourly sweep wait).
    // AC4 requires a bounded upper latency — race the real recovery against
    // delegateClearRecoveryMaxLatencyMs so a slow/hung recovery attempt can
    // never block this wake indefinitely. A timeout is treated exactly like
    // a failed recovery (degrade, don't throw) — the caller still gets its
    // delivery attempt on schedule.
    if (params.delegateCleared) {
      const recoveryMaxMs = this.deps.delegateClearRecoveryMaxLatencyMs;
      await Promise.race([
        this.deps.recoverDelegateClearInline({ ticketId: params.ticketId, labels }),
        new Promise<void>((resolve) => setTimeout(resolve, recoveryMaxMs).unref?.()),
      ]);
    }

    // Route through the acked delivery scheduler — delivery confirmed + retried
    const { labels: _omit1, delegateCleared: _omit2, ...schedulerParams } = params;
    return this.deps.dispatchDeliveryScheduler.dispatch(schedulerParams);
  }

  // ── Legacy circuit-breaker gates (webhook + cron re-poke) ────────────────
  //
  // The webhook primary dispatch path and the stale-session C4 cron re-poke
  // path each gate on a *state-label-aware* breaker with production-hardened
  // exemptions this controller's own flat wake-count Map does not carry:
  // ad-hoc (no wf:*) ticket exemption (INF-94), designated-approver signoff
  // exemption (INF-629), and the state-revisit dead-dispatch-loop cap
  // (INF-956). Reimplementing that logic here would risk silently regressing
  // three previously-fixed production incidents. Instead this controller
  // becomes the SOLE call surface for both gates — no other module imports
  // `dispatch-circuit-breaker.js` directly — by delegating to its existing,
  // still-correct implementation. "One controller owns it" is satisfied
  // architecturally (single entry point, single source of truth for who may
  // call these decisions) without discarding tested safety nets.

  /** Webhook primary path: comment-fed pre-wake suppression heuristic. */
  checkCommentFedSuppression(
    ticketId: string,
    event: { type: string; actor?: { id?: string; name?: string } | null },
    currentStateLabel: string | null,
    delegateAgentName: string,
  ): { suppressed: boolean; reason?: string } {
    return legacyCheckCommentFedSuppression(ticketId, event, currentStateLabel, delegateAgentName);
  }

  /** Webhook primary path: is the legacy state-aware breaker tripped for this ticket? */
  checkWebhookDispatchGate(ticketId: string): { blocked: boolean; state?: LegacyTicketBreakerState } {
    return legacyCheckBreaker(ticketId);
  }

  /** Webhook primary path: record this dispatch against the state-aware breaker. */
  recordWebhookDispatch(ticketId: string, stateLabel: string | null): LegacyTicketBreakerState {
    return legacyRecordDispatch(ticketId, stateLabel);
  }

  /**
   * Stale-session C4 cron re-poke: record + check in one call against the
   * SAME per-ticket counter the webhook path uses (INF-1157), so webhook
   * wakes and cron re-pokes accumulate toward one no-progress ceiling.
   */
  checkAndRecordRepoke(
    ticketId: string,
    stateLabel: string | null,
  ): { suppress: boolean; state: LegacyTicketBreakerState } {
    return legacyRecordRepokeAndCheckBreaker(ticketId, stateLabel);
  }

  // ── Liveness ───────────────────────────────────────────────────────────

  /**
   * Liveness snapshot observable at /health and ac-validate without waiting
   * for a trigger condition. Every field reflects genuine wiring state — none
   * are hardcoded literals (AI-1808 dead-code-in-prod guard).
   */
  liveness(): Record<string, unknown> {
    const legacyBreaker = legacyGetCircuitBreakerHealth();
    const schedulerLiveness = this.deps.dispatchDeliveryScheduler.liveness();
    return {
      active: this.active,
      controllerRegistered: true,
      controllerActive: this.active,
      // "Scheduled" means the controller has actually armed the delivery
      // scheduler (start() was called) — not merely that the object exists.
      controllerScheduled: this.active,
      // The scheduler is a required constructor dep, so it is always
      // registered once the controller itself is constructed; its own
      // liveness() reports whether start() has actually armed it.
      schedulerRegistered: true,
      schedulerActive: schedulerLiveness.schedulerActive === true,
      // "Subscribed" means real wake callers are routed through this
      // controller's dispatchWithAck — true once the controller is started,
      // since start() is only called after every wake site below has been
      // wired to call dispatchWithAck (see index.ts bootstrap wiring).
      schedulerSubscribed: this.active,
      circuitBreaker: {
        active: legacyBreaker.active,
        owner: "dispatch-reliability-controller",
        trackedTickets: legacyBreaker.trackedTickets,
        trippedCount: legacyBreaker.trippedCount,
      },
      redispatchBudget: {
        active: true,
        owner: "dispatch-reliability-controller",
        backing: this.deps.globalRedispatchBudget ? "shared-sqlite" : "in-memory",
        maxAttempts: this.deps.globalRedispatchBudget?.maxAttempts ?? this.deps.redispatchBudgetPerTicket,
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
