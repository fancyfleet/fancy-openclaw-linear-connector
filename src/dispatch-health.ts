/**
 * AI-1801 — Dispatch-health badge projection.
 *
 * Pure projection from operational-events.db (joined on wake_id) and the
 * dispatch-ack tracker. No new instrumentation is added anywhere — this module
 * only reads existing signals and maps them to one of six badge states.
 *
 * Badge states:
 *   working     — engagement (thinking/doing) seen recently for this ticket
 *   quiet       — dispatch accepted, no engagement yet (within grace window)
 *   unconfirmed — delivery unconfirmed or watchdog re-signaling; show attempt N/3
 *   exhausted   — max re-signals reached, needs intervention
 *   at-capacity — wake parked because agent is at maxConcurrent
 *   idle        — no live wake cycle for this ticket
 *
 * The function is pure: given the events and ack entry, it returns a badge
 * state. This makes it trivially testable with fixtures.
 */

import type { OperationalEvent } from "./store/operational-event-store.js";
import type { DispatchAckEntry } from "./bag/dispatch-ack-tracker.js";

export type DispatchHealthBadge =
  | "working"
  | "quiet"
  | "unconfirmed"
  | "exhausted"
  | "at-capacity"
  | "idle";

export interface DispatchHealth {
  badge: DispatchHealthBadge;
  /** Attempt number for unconfirmed (N of max), null otherwise. */
  attempt: number | null;
  /** Max attempts (for display "N/3"). */
  maxAttempts: number;
}

/** Engagement outcomes that indicate the agent is actively working. */
const ENGAGEMENT_OUTCOMES = new Set([
  "engagement-thinking",
  "engagement-doing",
  "engagement-todo",
]);

/** Outcomes indicating delivery is unconfirmed / watchdog is re-signaling. */
const UNCONFIRMED_OUTCOMES = new Set([
  "delivery-unconfirmed",
  "watchdog-resignal",
  "delivery-failed",
]);

/** Outcome indicating the agent was deferred due to capacity. */
const AT_CAPACITY_OUTCOMES = new Set([
  "deferred-at-capacity",
]);

/** Outcome indicating capacity re-arm (slot freed, re-dispatched). */
const CAPACITY_REARM_OUTCOMES = new Set([
  "deferred-capacity-rearm",
]);

/**
 * How recently an engagement event must have occurred to count as "working".
 * Default: 5 minutes — matches the no-activity detector's default fail threshold.
 */
const DEFAULT_WORKING_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Grace window: if a dispatch was accepted but no engagement event has been
 * seen yet, and we're still within this window, the badge is "quiet" rather
 * than "unconfirmed". Default: 2 minutes — matches the no-activity warn threshold.
 */
const DEFAULT_QUIET_GRACE_MS = 2 * 60 * 1000;

export interface ComputeDispatchHealthOptions {
  /** Max re-signal attempts before exhaustion. Default: 3 (WATCHDOG_MAX_RESIGNALS). */
  maxAttempts?: number;
  /** How recently engagement must be to count as "working". */
  workingThresholdMs?: number;
  /** Grace window for "quiet" state after dispatch. */
  quietGraceMs?: number;
  /** Override "now" for deterministic testing. */
  now?: number;
}

/**
 * Compute the dispatch-health badge for a single ticket.
 *
 * @param events - Operational events for this ticket (queried by key or wake_id)
 * @param ackEntry - The dispatch-ack tracker entry for this ticket, or null
 * @param options - Tuning / test overrides
 */
export function computeDispatchHealth(
  events: OperationalEvent[],
  ackEntry: DispatchAckEntry | null,
  options?: ComputeDispatchHealthOptions,
): DispatchHealth {
  const now = options?.now ?? Date.now();
  const maxAttempts = options?.maxAttempts ?? 3;
  const workingThresholdMs = options?.workingThresholdMs ?? DEFAULT_WORKING_THRESHOLD_MS;
  const quietGraceMs = options?.quietGraceMs ?? DEFAULT_QUIET_GRACE_MS;

  // --- exhausted: ack tracker says escalated ---
  if (ackEntry?.ackStatus === "escalated") {
    return { badge: "exhausted", attempt: ackEntry.attemptCount, maxAttempts };
  }

  // --- at-capacity: ack tracker says deferred OR recent deferred-at-capacity event ---
  if (ackEntry?.ackStatus === "deferred") {
    // If a capacity-rearm happened after the deferral, the ticket may be
    // re-dispatched — but if the ack is still "deferred", show at-capacity.
    return { badge: "at-capacity", attempt: ackEntry.attemptCount, maxAttempts };
  }

  // Sort events newest-first for recency checks.
  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.occurredAt).getTime();
    const tb = new Date(b.occurredAt).getTime();
    return tb - ta;
  });

  // Check for recent at-capacity events that haven't been re-armed.
  const lastCapacityEvent = sorted.find((e) => AT_CAPACITY_OUTCOMES.has(e.outcome));
  const lastRearmEvent = sorted.find((e) => CAPACITY_REARM_OUTCOMES.has(e.outcome));
  if (lastCapacityEvent && (!lastRearmEvent || new Date(lastCapacityEvent.occurredAt) > new Date(lastRearmEvent.occurredAt))) {
    return {
      badge: "at-capacity",
      attempt: lastCapacityEvent.attemptCount ?? ackEntry?.attemptCount ?? null,
      maxAttempts,
    };
  }

  // --- working: recent engagement event ---
  const recentEngagement = sorted.find(
    (e) => ENGAGEMENT_OUTCOMES.has(e.outcome) && now - new Date(e.occurredAt).getTime() <= workingThresholdMs,
  );
  if (recentEngagement) {
    return { badge: "working", attempt: null, maxAttempts };
  }

  // --- unconfirmed: delivery-unconfirmed / watchdog-resignal / delivery-failed ---
  // Only if there is a live dispatch cycle (wake_id or pending ack entry).
  const hasWakeCycle = sorted.some((e) => e.wakeId);
  const lastUnconfirmed = sorted.find((e) => UNCONFIRMED_OUTCOMES.has(e.outcome));
  if (lastUnconfirmed && (hasWakeCycle || ackEntry)) {
    const attempt = lastUnconfirmed.attemptCount ?? ackEntry?.attemptCount ?? 1;
    // If attempts exceeded max, it's exhausted.
    if (attempt > maxAttempts) {
      return { badge: "exhausted", attempt, maxAttempts };
    }
    return { badge: "unconfirmed", attempt, maxAttempts };
  }

  // --- quiet: dispatch accepted but no engagement yet (grace window) ---
  if (ackEntry && (ackEntry.ackStatus === "pending" || ackEntry.ackStatus === "unconfirmed")) {
    const lastSignalMs = new Date(ackEntry.lastSignalAt.replace(" ", "T") + "Z").getTime();
    const ageMs = now - lastSignalMs;

    // If there are unconfirmed outcomes but we didn't match above (no recent
    // unconfirmed event), and we're still within the grace window, show quiet.
    if (ageMs <= quietGraceMs) {
      return { badge: "quiet", attempt: ackEntry.attemptCount || null, maxAttempts };
    }

    // Past grace and still pending but no unconfirmed event recorded yet —
    // the watchdog hasn't fired, but the ticket is waiting. Still "quiet"
    // until the watchdog records a delivery-unconfirmed.
    // If attempt_count > 1, a re-signal happened — show unconfirmed.
    if (ackEntry.attemptCount > 1) {
      return { badge: "unconfirmed", attempt: ackEntry.attemptCount, maxAttempts };
    }

    return { badge: "quiet", attempt: ackEntry.attemptCount || null, maxAttempts };
  }

  // --- idle: no live wake cycle ---
  return { badge: "idle", attempt: null, maxAttempts };
}

/**
 * Batch-compute dispatch health for all tickets on the board.
 *
 * @param ticketKeys - Map of ticketId → operational events for that ticket
 * @param ackEntriesByTicket - Map of ticketId → ack entry
 * @param options - Tuning overrides
 */
export function batchComputeDispatchHealth(
  ticketKeys: Map<string, OperationalEvent[]>,
  ackEntriesByTicket: Map<string, DispatchAckEntry | null>,
  options?: ComputeDispatchHealthOptions,
): Map<string, DispatchHealth> {
  const result = new Map<string, DispatchHealth>();
  for (const [ticketId, events] of ticketKeys) {
    const ack = ackEntriesByTicket.get(ticketId) ?? null;
    result.set(ticketId, computeDispatchHealth(events, ack, options));
  }
  return result;
}
