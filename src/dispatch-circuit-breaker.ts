/**
 * AI-2178 / INF-94: Dispatch circuit breaker.
 *
 * Feature 1: Per-ticket dispatch circuit breaker (AI-2178)
 *   After N (3) consecutive wakes where the ticket's workflow state hasn't
 *   changed, stop re-dispatching, emit one loud alert, and park dispatch until
 *   the state advances or a steward resets the breaker.
 *
 * Feature 2: Comment-fed re-wake suppression (pre-wake heuristic) (AI-2178)
 *   Cheaper guard that runs BEFORE the circuit breaker counter increments.
 *   Suppress the wake when all of:
 *     (a) The triggering event is a comment
 *     (b) The comment author is the ticket's current delegate
 *     (c) The state:* workflow label is identical to what it was at the
 *         delegate's last dispatch
 *   If suppressed, don't increment the breaker counter.
 *
 * INF-94 fix: Ad-hoc tickets (no wf:* label) never trip the transition-stuck
 *   alert — they have no workflow transitions to measure progress against.
 *   The DispatchCircuitBreaker class accepts raw label arrays and extracts the
 *   wf:* label internally, exempting label-less tickets. The legacy functional
 *   API (recordDispatch etc.) treats null stateLabel as ad-hoc and skips
 *   trip accounting.
 */

import { createLogger, componentLogger } from "./logger.js";
import { notify } from "./alerts/alert-bus.js";

const log = componentLogger(createLogger(), "dispatch-circuit-breaker");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max consecutive wakes before tripping the breaker. */
const DEFAULT_MAX_WAKES = 3;

/**
 * INF-956: Hard ceiling on total wakes that only ever REVISIT states this
 * ticket has already occupied, tripping even when the state:* label churns
 * between arrivals.
 *
 * The consecutive-same-state counter (`DEFAULT_MAX_WAKES`) resets on any state
 * change, so it cannot catch a *dead-dispatch loop* that cycles through a small
 * ring of already-seen states without advancing — e.g. a `task` ticket scoped
 * to the wrong department head, re-stranded and re-dispatched as it churns
 * doing → intake → routing → doing. Each arrival lands on a different label, so
 * the consecutive counter is perpetually reset and the breaker never trips: the
 * observed pathology is 18+ dead dispatches against a nominal cap of 3.
 *
 * This second counter increments on every wake that lands on a *previously
 * seen* state and is reset ONLY by genuine forward progress (reaching a state
 * this ticket has never occupied) or an explicit steward reset. A healthy
 * ticket advances to new states (review → merge → sign-off → done) and stops
 * being dispatched at its terminal; a ticket cycling its history trips. Set
 * comfortably above a normal revision loop (review ⇄ doing) so ordinary
 * bounce-backs do not trip. Env-overridable via `DISPATCH_STATE_REVISIT_CAP`.
 *
 * Default 10: a normal revision cycle (review → doing → review) is 2 revisits,
 * so 10 tolerates ~5 revision bounces before tripping — comfortably above any
 * healthy ticket, comfortably below the observed 18x dead-loop.
 */
const DEFAULT_MAX_STATE_REVISITS = (() => {
  const raw = parseInt(process.env.DISPATCH_STATE_REVISIT_CAP ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
})();

// ---------------------------------------------------------------------------
// Legacy state types
// ---------------------------------------------------------------------------

export interface TicketBreakerState {
  /** The workflow state:* label observed at last dispatch. */
  lastStateLabel: string | null;
  /** ISO timestamp of the last dispatch. */
  lastDispatchAt: string | null;
  /** Consecutive wakes with no state change. */
  wakeCount: number;
  /** Whether the breaker is currently tripped (open). */
  tripped: boolean;
  /** ISO timestamp when the breaker tripped. */
  trippedAt: string | null;
  /**
   * INF-956: distinct state:* labels this ticket has occupied across its wake
   * history. A wake landing on a label already in this set is a *revisit* (no
   * forward progress); a new label is a genuine advance that resets the churn
   * counter. Absent (undefined) on states seeded before this field existed —
   * treated as an empty history.
   */
  seenStates?: string[];
  /**
   * INF-956: wakes that landed on an already-seen state without reaching new
   * territory. Reset only by a genuinely-new state or a steward reset — NOT by
   * ordinary label churn. Trips the breaker at `DEFAULT_MAX_STATE_REVISITS`.
   */
  revisitCount?: number;
}

/** Snapshot for /health exposure. */
export interface CircuitBreakerHealth {
  active: boolean;
  trackedTickets: number;
  trippedCount: number;
  config: {
    maxWakes: number;
    /** INF-956: hard ceiling on wakes revisiting already-seen states. */
    maxStateRevisits: number;
  };
}

// ---------------------------------------------------------------------------
// Class-based API types (INF-94)
// ---------------------------------------------------------------------------

export interface DispatchCircuitBreakerConfig {
  /** Number of wakes without progress before alerting. Default: 3. */
  maxWakesBeforeAlert?: number;
}

export interface DispatchCircuitBreakerResult {
  /** Whether a transition-stuck alert should fire. */
  shouldAlert: boolean;
  /** Total recorded wakes for this ticket. */
  wakeCount: number;
  /** The wf:* label if the ticket has one, otherwise null. */
  stateLabel: string | null;
  /** Human-readable reason for the result. */
  reason: string | null;
}

interface TicketState {
  /** The wf:* label (null for ad-hoc tickets). */
  stateLabel: string | null;
  /** Accumulated wake count. */
  wakeCount: number;
  /** ISO timestamp of the last delegate activity, if any. */
  lastActivityAt: string | null;
  /** Whether the breaker is currently alerting. */
  shouldAlert: boolean;
  /**
   * INF-629: true when the ticket carries a `designated-approver:*` label,
   * meaning it is legitimately parked awaiting a designated approver's signoff
   * rather than stuck. These tickets never fire transition-stuck / escape
   * guidance — the repeated wakes are the signoff request, not a stall.
   */
  awaitingDesignatedApprover: boolean;
  /** INF-629: the designated approver body named on the ticket, if any. */
  designatedApprover: string | null;
}

// ---------------------------------------------------------------------------
// Legacy in-memory state store
// ---------------------------------------------------------------------------

const breakerState = new Map<string, TicketBreakerState>();

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Extract the wf:* label from a Linear labels array.
 * Returns null if no wf:* label is present (ad-hoc ticket).
 */
export function extractWorkflowLabel(labels: string[]): string | null {
  return labels.find((l) => /^wf:/i.test(l)) ?? null;
}

/**
 * INF-629: extract the designated approver body from a `designated-approver:<body>`
 * label, if present. Returns null when the ticket is not parked on a designated
 * approver signoff. Used to distinguish "awaiting designated approver signoff"
 * from ordinary transition-stuck so the breaker does not advise `escape`.
 */
export function extractDesignatedApprover(labels: string[]): string | null {
  const label = labels.find((l) => /^designated-approver:/i.test(l));
  if (!label) return null;
  const value = label.slice(label.indexOf(":") + 1).trim();
  return value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Class-based API (INF-94)
// ---------------------------------------------------------------------------

/**
 * DispatchCircuitBreaker — transition-stuck detection with ad-hoc ticket exemption.
 *
 * Tracks wake dispatches per ticket and fires a `transition-stuck` signal when
 * a governed (wf:*) ticket receives multiple wakes without evidence of progress
 * (delegate activity or state transition). Ad-hoc tickets (no wf: label) are
 * exempt from transition-stuck firing because they have no workflow transitions
 * to measure progress against.
 */
export class DispatchCircuitBreaker {
  private readonly state = new Map<string, TicketState>();
  private readonly maxWakes: number;

  constructor(config?: DispatchCircuitBreakerConfig) {
    this.maxWakes = config?.maxWakesBeforeAlert ?? DEFAULT_MAX_WAKES;
  }

  /**
   * Record a successful wake dispatch to a ticket with its linear labels.
   * Labels are used to determine if the ticket is workflow-governed (wf:*).
   */
  recordWake(ticketId: string, labels: string[]): void {
    const wfLabel = extractWorkflowLabel(labels);
    // INF-629: a ticket carrying a designated-approver signoff label is parked
    // awaiting an approver, not stuck — never fire transition-stuck for it.
    const designatedApprover = extractDesignatedApprover(labels);
    const awaitingDesignatedApprover = designatedApprover !== null;
    const existing = this.state.get(ticketId);

    if (!existing) {
      // First wake for this ticket. Count starts at 1 (this IS a wake).
      const shouldAlert = wfLabel !== null && !awaitingDesignatedApprover
        ? 1 >= this.maxWakes
        : false;
      this.state.set(ticketId, {
        stateLabel: wfLabel,
        wakeCount: 1,
        lastActivityAt: null,
        shouldAlert,
        awaitingDesignatedApprover,
        designatedApprover,
      });
      return;
    }

    if (wfLabel === null) {
      // INF-94: Ad-hoc ticket (no wf:* label). Track the wake count for
      // observability but never alert. These tickets have no workflow
      // transitions to measure progress against.
      this.state.set(ticketId, {
        ...existing,
        stateLabel: null,
        wakeCount: existing.wakeCount + 1,
        shouldAlert: false,
        awaitingDesignatedApprover,
        designatedApprover,
      });
      return;
    }

    // If delegate already posted activity, reset the counter
    if (existing.lastActivityAt !== null) {
      this.state.set(ticketId, {
        ...existing,
        wakeCount: 1,
        shouldAlert: false,
        awaitingDesignatedApprover,
        designatedApprover,
      });
      return;
    }

    // wf:* ticket — accumulate wakes and alert if threshold exceeded without
    // any delegate activity. A designated-approver signoff park never alerts.
    const newCount = existing.wakeCount + 1;
    const shouldAlert =
      !awaitingDesignatedApprover &&
      newCount >= this.maxWakes &&
      existing.lastActivityAt === null;

    this.state.set(ticketId, {
      stateLabel: wfLabel,
      wakeCount: newCount,
      lastActivityAt: existing.lastActivityAt,
      shouldAlert,
      awaitingDesignatedApprover,
      designatedApprover,
    });
  }

  /**
   * Record evidence of delegate activity (comment posted, state changed, ack
   * received). For ad-hoc tickets this is the only "progress" signal; for wf:*
   * tickets it clears the stuck timer.
   */
  recordDelegateActivity(ticketId: string): void {
    const existing = this.state.get(ticketId);
    if (!existing) return;

    this.state.set(ticketId, {
      ...existing,
      wakeCount: 0,
      lastActivityAt: new Date().toISOString(),
      shouldAlert: false,
    });
  }

  /**
   * Evaluate whether this ticket should fire a transition-stuck alert.
   */
  evaluate(ticketId: string): DispatchCircuitBreakerResult {
    const existing = this.state.get(ticketId);
    if (!existing) {
      return { shouldAlert: false, wakeCount: 0, stateLabel: null, reason: null };
    }

    const { stateLabel, wakeCount, shouldAlert, lastActivityAt, awaitingDesignatedApprover, designatedApprover } = existing;

    // INF-629: a ticket parked awaiting a designated approver's signoff is not
    // transition-stuck — the repeated wakes ARE the signoff request. Report it
    // as such and never advise `escape` (which would abandon the signoff loop).
    if (awaitingDesignatedApprover) {
      return {
        shouldAlert: false,
        wakeCount,
        stateLabel,
        reason: `awaiting designated approver signoff${designatedApprover ? ` (${designatedApprover})` : ""}`,
      };
    }

    if (stateLabel === null) {
      // Ad-hoc ticket — never fire transition-stuck.
      return {
        shouldAlert: false,
        wakeCount,
        stateLabel: null,
        reason: `ad-hoc: no wf:* label — transition-stuck not applicable`,
      };
    }

    if (shouldAlert) {
      return {
        shouldAlert: true,
        wakeCount,
        stateLabel,
        reason: `transition-stuck: ${wakeCount} consecutive wakes on ${stateLabel}, no delegate activity`,
      };
    }

    if (lastActivityAt !== null) {
      return {
        shouldAlert: false,
        wakeCount,
        stateLabel,
        reason: `delegate activity at ${lastActivityAt}`,
      };
    }

    return {
      shouldAlert: false,
      wakeCount,
      stateLabel,
      reason: `${wakeCount}/${this.maxWakes} wakes before alert threshold`,
    };
  }

  /**
   * Reset tracking for a ticket (e.g., when the ticket transitions or is
   * completed).
   */
  reset(ticketId: string): void {
    this.state.delete(ticketId);
  }

  /** Access all tracked tickets (for diagnostics/testing). */
  allStates(): ReadonlyMap<string, TicketState> {
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// Legacy functional API (AI-2178 compatible)
// ---------------------------------------------------------------------------

/**
 * INF-956: whether `stateLabel` is a state this ticket has already occupied.
 * `seenStates` is optional (undefined on pre-INF-956 seeded state) — an absent
 * history means nothing has been seen, so nothing is a revisit yet.
 */
function isRevisit(existing: TicketBreakerState, stateLabel: string): boolean {
  return (existing.seenStates ?? []).includes(stateLabel);
}

/** INF-956: append a state to the seen-history without duplicates. */
function withSeenState(existing: TicketBreakerState | undefined, stateLabel: string): string[] {
  const prior = existing?.seenStates ?? (existing?.lastStateLabel ? [existing.lastStateLabel] : []);
  return prior.includes(stateLabel) ? prior : [...prior, stateLabel];
}

/**
 * Record a dispatch attempt and update the circuit breaker state.
 *
 * INF-94: If stateLabel is null (ad-hoc ticket, no wf:* workflow label), the
 * ticket has no workflow transitions to stall — never trip the breaker.
 *
 * INF-956: Two independent trip conditions. (1) `wakeCount` — consecutive wakes
 * on the SAME state, reset by any state change. (2) `revisitCount` — wakes that
 * land on an already-seen state, reset ONLY by reaching a genuinely-new state.
 * The second catches dead-dispatch loops that churn a ring of seen states so the
 * consecutive counter never accumulates (the 18x-vs-cap-3 pathology).
 *
 * @returns The updated breaker state.
 */
export function recordDispatch(
  ticketId: string,
  stateLabel: string | null,
  maxWakes: number = DEFAULT_MAX_WAKES,
  maxRevisits: number = DEFAULT_MAX_STATE_REVISITS,
): TicketBreakerState {
  // INF-94: Null stateLabel means this ticket has no workflow state to measure
  // progress against. Ad-hoc tickets (no wf:* label) always have null stateLabel.
  // Record the dispatch but never trip — there are no transitions to stall on.
  if (stateLabel === null) {
    const fresh: TicketBreakerState = {
      lastStateLabel: null,
      lastDispatchAt: new Date().toISOString(),
      wakeCount: 0,
      tripped: false,
      trippedAt: null,
      seenStates: [],
      revisitCount: 0,
    };
    breakerState.set(ticketId, fresh);
    return fresh;
  }

  const existing = breakerState.get(ticketId);

  if (!existing) {
    // First dispatch for this ticket — seed the state.
    const fresh: TicketBreakerState = {
      lastStateLabel: stateLabel,
      lastDispatchAt: new Date().toISOString(),
      wakeCount: 0,
      tripped: false,
      trippedAt: null,
      seenStates: [stateLabel],
      revisitCount: 0,
    };
    breakerState.set(ticketId, fresh);
    log.debug(`Circuit breaker: first dispatch for ${ticketId} → state=${stateLabel}`);
    return fresh;
  }

  // INF-956: forward progress is reaching a state this ticket has NEVER
  // occupied — not merely a label that differs from the last one. A churn-return
  // to a prior state is a revisit, not an advance, and must not reset counters.
  const isNewState = !isRevisit(existing, stateLabel);

  // If the breaker is tripped, only genuine forward progress un-trips it.
  // A churn-return to an already-seen state keeps it open (INF-956) — otherwise
  // the same loop that tripped it would immediately clear it on its next hop.
  if (existing.tripped) {
    if (isNewState) {
      const updated: TicketBreakerState = {
        lastStateLabel: stateLabel,
        lastDispatchAt: new Date().toISOString(),
        wakeCount: 0,
        tripped: false,
        trippedAt: null,
        seenStates: withSeenState(existing, stateLabel),
        revisitCount: 0,
      };
      breakerState.set(ticketId, updated);
      log.info(
        `Circuit breaker: forward progress (un-trip) for ${ticketId}: reached new state ${stateLabel} — breaker reset`,
      );
      return updated;
    }
    // Revisiting a seen state (or unchanged) while tripped — stay tripped.
    return { ...existing, lastStateLabel: stateLabel, lastDispatchAt: new Date().toISOString() };
  }

  // Genuine forward progress → reset BOTH counters (ticket advanced to new
  // territory) and record the new state in the history.
  if (isNewState) {
    const updated: TicketBreakerState = {
      lastStateLabel: stateLabel,
      lastDispatchAt: new Date().toISOString(),
      wakeCount: 0,
      tripped: false,
      trippedAt: null,
      seenStates: withSeenState(existing, stateLabel),
      revisitCount: 0,
    };
    breakerState.set(ticketId, updated);
    log.info(
      `Circuit breaker: forward progress for ${ticketId}: ${existing.lastStateLabel ?? "none"} → ${stateLabel} (new state) — counters reset`,
    );
    return updated;
  }

  // Revisit: the wake landed on an already-seen state. The consecutive-same
  // counter (`wakeCount`) still resets when the label differs from the last
  // dispatch, but the churn counter (`revisitCount`) always climbs.
  const sameAsLast = existing.lastStateLabel === stateLabel;
  const newCount = sameAsLast ? (existing.wakeCount ?? 0) + 1 : 0;
  const newRevisit = (existing.revisitCount ?? 0) + 1;
  const consecutiveTrip = sameAsLast && newCount >= maxWakes;
  const revisitTrip = newRevisit >= maxRevisits;
  const shouldTrip = consecutiveTrip || revisitTrip;

  const updated: TicketBreakerState = {
    lastStateLabel: stateLabel,
    lastDispatchAt: new Date().toISOString(),
    wakeCount: newCount,
    tripped: shouldTrip,
    trippedAt: shouldTrip ? new Date().toISOString() : null,
    seenStates: existing.seenStates ?? withSeenState(existing, stateLabel),
    revisitCount: newRevisit,
  };
  breakerState.set(ticketId, updated);

  if (shouldTrip) {
    const reason = revisitTrip
      ? `${newRevisit} wakes revisiting seen states (${(updated.seenStates ?? []).join(" → ")}), no forward progress`
      : `${newCount} consecutive wakes, state=${stateLabel}`;
    log.warn(`Circuit breaker TRIPPED for ${ticketId}: ${reason}`);
    notify({
      severity: "warning",
      source: "dispatch-circuit-breaker",
      title: revisitTrip
        ? `dead-dispatch-loop: ${ticketId.replace(/^linear-/, "")} — ${newRevisit} wakes cycling seen states, no progress`
        : `transition-stuck: ${ticketId.replace(/^linear-/, "")} ${stateLabel} — ${newCount} wakes, no progress`,
      detail: {
        ticketId,
        stateLabel,
        wakeCount: newCount,
        revisitCount: newRevisit,
        seenStates: updated.seenStates,
        trippedBy: revisitTrip ? "state-revisit-cap" : "consecutive-wake-cap",
        trippedAt: updated.trippedAt,
      },
      ticket: ticketId,
    });
  } else if (newCount > 1 || newRevisit > 1) {
    log.info(
      `Circuit breaker: ${ticketId} no progress (${newCount}/${maxWakes} consecutive, ` +
      `${newRevisit}/${maxRevisits} revisits, state=${stateLabel})`,
    );
  }

  return updated;
}

/**
 * Called by the dispatch path AFTER a successful dispatch returns, when the
 * state was the same as before. This increments the consecutive-wake counter.
 *
 * INF-94: If the ticket has no state label (ad-hoc, no wf:*), don't trip.
 */
export function recordFailedWake(
  ticketId: string,
  stateLabel: string | null,
  maxWakes: number = DEFAULT_MAX_WAKES,
): { tripped: boolean; wakeCount: number } {
  const existing = breakerState.get(ticketId);
  if (!existing || existing.tripped) {
    // If already tripped, don't mutate further — only a state advance or
    // explicit reset can un-trip.
    return { tripped: existing?.tripped ?? false, wakeCount: existing?.wakeCount ?? 0 };
  }

  // INF-94: If the ticket has no state label (ad-hoc, no wf:*), don't trip —
  // there are no transitions to stall on.
  const effectiveLabel = stateLabel ?? existing.lastStateLabel;
  if (effectiveLabel === null) {
    return { tripped: false, wakeCount: 0 };
  }

  const newCount = (existing.wakeCount ?? 0) + 1;
  const shouldTrip = newCount >= maxWakes;

  breakerState.set(ticketId, {
    lastStateLabel: effectiveLabel,
    lastDispatchAt: new Date().toISOString(),
    wakeCount: newCount,
    tripped: shouldTrip,
    trippedAt: shouldTrip ? new Date().toISOString() : null,
    // INF-956: preserve the churn history; this path only fires on same-state
    // repeats, so revisitCount is not advanced here (recordDispatch owns it).
    seenStates: existing.seenStates ?? withSeenState(existing, effectiveLabel),
    revisitCount: existing.revisitCount ?? 0,
  });

  if (shouldTrip) {
    log.warn(
      `Circuit breaker TRIPPED for ${ticketId}: ${newCount} consecutive wakes, state=${effectiveLabel}`,
    );
    notify({
      severity: "warning",
      source: "dispatch-circuit-breaker",
      title: `transition-stuck: ${ticketId} ${effectiveLabel} — ${newCount} wakes, no progress`,
      detail: {
        ticketId,
        stateLabel: effectiveLabel,
        wakeCount: newCount,
        trippedAt: breakerState.get(ticketId)!.trippedAt,
      },
      ticket: ticketId,
    });
  } else {
    log.info(
      `Circuit breaker: state unchanged for ${ticketId} (${newCount}/${maxWakes} wakes, state=${effectiveLabel})`,
    );
  }

  return { tripped: shouldTrip, wakeCount: newCount };
}

/**
 * INF-1157: Gate a cron-driven re-poke (stale-session recovery, first-action
 * watchdog, reconciliation re-dispatch) on the circuit breaker.
 *
 * The webhook dispatch path already records against and checks the breaker
 * (webhook/index.ts §9). The cron re-dispatch paths did NOT — so a ticket
 * wedged on the same workflow state (the exact off-spine `state:doing` shape:
 * its only forward verb resolves to a transition the bare re-poke can never
 * satisfy, so `continue-workflow` is declined every cycle) was re-poked
 * forever. The breaker would trip, but nothing on the cron path consulted it.
 *
 * This records THIS re-poke against the SAME per-ticket counter the webhook
 * path uses (so webhook wakes and cron re-pokes accumulate together toward one
 * no-progress ceiling) and reports whether the breaker is now tripped. When it
 * is, the caller drops the re-poke; the trip already emits the loud
 * `transition-stuck` alert (see recordDispatch), so the wedge escalates to a
 * steward instead of looping silently.
 *
 * `stateLabel` must be the same normalized form the webhook path records — the
 * `state:*` id(s) WITHOUT the `state:` prefix, lowercased, sorted, comma-joined
 * (or null when the ticket carries no `state:*` label). A null label is treated
 * as ad-hoc and never suppresses.
 */
export function recordRepokeAndCheckBreaker(
  ticketId: string,
  stateLabel: string | null,
): { suppress: boolean; state: TicketBreakerState } {
  const state = recordDispatch(ticketId, stateLabel);
  return { suppress: checkBreaker(ticketId).blocked, state };
}

/**
 * Check if the breaker is tripped for a ticket.
 * Returns `{ blocked: true, state }` if the breaker is open and dispatch should
 * be suppressed. Returns `{ blocked: false }` otherwise.
 */
export function checkBreaker(
  ticketId: string,
): { blocked: boolean; state?: TicketBreakerState } {
  const existing = breakerState.get(ticketId);
  if (existing?.tripped) {
    log.info(
      `Circuit breaker: blocking dispatch for ${ticketId} — tripped at ${existing.trippedAt} after ${existing.wakeCount} wakes (state=${existing.lastStateLabel ?? "unknown"})`,
    );
    return { blocked: true, state: existing };
  }
  return { blocked: false };
}

/**
 * Reset the breaker for a ticket (steward override or state advance from
 * an incoming webhook). Returns true if there was state to clear.
 */
export function resetBreaker(ticketId: string): boolean {
  const hadState = breakerState.has(ticketId);
  breakerState.delete(ticketId);
  if (hadState) {
    log.info(`Circuit breaker: reset for ${ticketId}`);
  }
  return hadState;
}

// ---------------------------------------------------------------------------
// Comment-fed re-wake suppression (Feature 2)
// ---------------------------------------------------------------------------

/**
 * Comment-fed suppression check that takes the ticket ID explicitly.
 *
 * @param ticketId - Normalized ticket session key (e.g. "linear-AI-2178").
 * @param event - The normalized Linear event (any subtype, actor access via duck-typing).
 * @param currentStateLabel - The state:* label from the current event data.
 * @param delegateAgentName - The agent name targeted for dispatch.
 * @returns suppression result.
 */
export function checkCommentFedSuppressionForTicket(
  ticketId: string,
  event: { type: string; actor?: { id?: string; name?: string } | null },
  currentStateLabel: string | null,
  delegateAgentName: string,
): { suppressed: boolean; reason?: string } {
  // (a) Must be a comment event
  if (event.type !== "Comment") {
    return { suppressed: false };
  }

  // (b) Author must be the current delegate
  const authorName = event.actor?.name ?? null;
  if (!authorName) {
    return { suppressed: false };
  }

  // The delegate agent name is the routed target. The author matches if the
  // clean agent name (openclaw agent name) matches the comment author's name.
  // In Linear, the author is the OAuth app user name (e.g. "Astrid (CPO)").
  // We compare case-insensitively against the delegate agent name.
  const authorLower = authorName.toLowerCase();
  const delegateLower = delegateAgentName.toLowerCase();
  const isAuthorTheDelegate =
    authorLower === delegateLower ||
    authorLower.startsWith(delegateLower) ||
    delegateLower.startsWith(authorLower);

  if (!isAuthorTheDelegate) {
    return { suppressed: false };
  }

  // (c) state label unchanged since last dispatch
  const existing = breakerState.get(ticketId);
  if (!existing) {
    // No prior dispatch tracked — nothing to compare against.
    // This is the first dispatch, so no suppression.
    return { suppressed: false };
  }

  const lastLabel = existing.lastStateLabel;
  if (lastLabel === currentStateLabel) {
    log.info(
      `Comment-fed suppression: ${delegateAgentName} commented on ${ticketId} but state unchanged (${lastLabel}) — suppressing wake`,
    );
    return { suppressed: true, reason: `state unchanged (${lastLabel}) since delegate's last dispatch` };
  }

  return { suppressed: false };
}

// ---------------------------------------------------------------------------
// Health / observability
// ---------------------------------------------------------------------------

/**
 * Get a snapshot of the circuit breaker state for /health.
 */
export function getCircuitBreakerHealth(): CircuitBreakerHealth {
  let trippedCount = 0;
  for (const state of breakerState.values()) {
    if (state.tripped) trippedCount++;
  }

  return {
    active: true,
    trackedTickets: breakerState.size,
    trippedCount,
    config: {
      maxWakes: DEFAULT_MAX_WAKES,
      maxStateRevisits: DEFAULT_MAX_STATE_REVISITS,
    },
  };
}

/**
 * Get a deep-clone of all breaker states (for admin endpoints or diagnostics).
 */
export function getAllBreakerStates(): Record<string, TicketBreakerState> {
  const out: Record<string, TicketBreakerState> = {};
  for (const [key, val] of breakerState) {
    out[key] = { ...val };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** Reset all breaker state (for testing). */
export function resetCircuitBreakerForTest(): void {
  breakerState.clear();
}
