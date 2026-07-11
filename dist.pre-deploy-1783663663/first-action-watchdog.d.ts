/**
 * AI-2009 — Connector: first-action watchdog with auto-remediation ladder
 * (redispatch → unreachable + alert → optional capability-policy re-route).
 *
 * Stall DETECTION already exists (sweeps + nudges) but has no remediation power:
 * every major dev-impl stall was detected within hours, nudged with zero effect,
 * and ultimately resolved by hand. This watchdog closes the loop — it arms a
 * per-state deadline at dispatch delivery and, on breach, walks an escalation
 * ladder that actually re-wakes / re-routes / alerts, rung by rung.
 *
 * Design constraints baked into the contract (see the AI-2009 test suite):
 *   - NEVER auto-transitions workflow state (the ladder nudges the owner, it does
 *     not advance the machine).
 *   - NEVER fires on human-assigned or Matt-blocked (`needs-human`) tickets — the
 *     standing org rule against nudging Matt-blocked work.
 *   - Re-entry / revision dispatches get identical coverage to first-pass ones
 *     (round-trips are the fragile path).
 *   - The rung-1 re-dispatch is a genuine fresh wake that bypasses dispatch
 *     idempotency suppression (AI-1969 admit semantics) — an ordinary duplicate
 *     would be swallowed by the guard.
 *
 * I/O is injected (listTickets / redispatch / escalateUnreachable / reroute /
 * notify / now) exactly like runSlaSweep, so the ladder logic is unit-tested in
 * isolation; index.ts wires the real data plane (delivered-at from the
 * operational event store, first-owner-action-at from Linear, delegate/labels
 * from the enrolled-tickets mirror).
 */
import { type LadderHistoryEntry } from "./first-action-watchdog-state.js";
import type { DispatchIdempotencyStore } from "./store/dispatch-idempotency-store.js";
/** A watchdog ticket record as produced by the (injected) data plane. */
export interface WatchdogTicket {
    ticket: string;
    workflow: string;
    state: string;
    delegate: string;
    humanAssigned: boolean;
    labels: string[];
    /** Epoch ms the dispatch was delivered — the deadline is armed from here. */
    dispatchDeliveredAtMs: number;
    /** ISO updatedAt tuple component for the idempotency key. */
    dispatchUpdatedAt: string;
    /** Epoch ms of the first visible owner action, or null if none yet. */
    firstOwnerActionAtMs: number | null;
    isReentry?: boolean;
    /** Rungs already fired in prior sweeps (the persisted ladder accumulator). */
    rungsFired?: number;
}
/** Minimal shape of a capability policy for re-route resolution. */
export interface WatchdogCapabilityPolicy {
    bodies: Array<{
        id: string;
        fills_roles: string[];
    }>;
    roles?: Array<{
        id: string;
        exclusive?: boolean;
    }>;
    [key: string]: unknown;
}
export interface RedispatchPayload {
    ticket: string;
    state: string;
    agent: string;
}
export interface UnreachableAlert {
    severity: string;
    source: string;
    title: string;
    ticket: string;
    state: string;
    delegate: string;
    /** Real escalation rungs fired before exhaustion (≤ maxRungs) — use this in
     *  alert copy, NOT history.length (history also logs the exhaustion entry). */
    rungsFired: number;
    history: LadderHistoryEntry[];
    [key: string]: unknown;
}
/** Verdict of the on-breach cross-check against authoritative Linear state.
 *  "stale" means the caller found the mirror row wrong (ticket done / deleted /
 *  demoted / state-corrected) and healed it — the ladder must be dropped
 *  without firing a rung. "unknown" (Linear unreachable) fails open to normal
 *  ladder behavior. */
export type CrossCheckVerdict = "live" | "stale" | "unknown";
export interface ReroutePayload {
    ticket: string;
    fromAgent: string;
    toAgent: string;
    role: string;
}
export interface FirstActionWatchdogOptions {
    authToken?: string;
    /** File OR directory of workflow def YAML; per-state first_action_deadline. */
    workflowDefPath?: string;
    listTickets: () => Promise<WatchdogTicket[]>;
    now?: () => number;
    defaultDeadlineMs?: number;
    maxRungs?: number;
    capabilityPolicy?: WatchdogCapabilityPolicy;
    /** Ops-channel alert sink (rung 2). */
    notify?: (alert: UnreachableAlert) => void;
    /** Rung 1 — genuine fresh wake (bypasses idempotency in the wired impl). */
    redispatch?: (payload: RedispatchPayload) => Promise<{
        admitted: boolean;
    }>;
    /** Rung 2 — mark the delegate unreachable for this ticket. */
    escalateUnreachable?: (payload: {
        ticket: string;
        state: string;
        agent: string;
        history: LadderHistoryEntry[];
    }) => Promise<void>;
    /** Rung 3 — optional re-route to a fallback body. */
    reroute?: (payload: ReroutePayload) => Promise<void>;
    /** On-breach cross-check against authoritative Linear state. The caller is
     *  responsible for healing the mirror row when it returns "stale". Only
     *  invoked for breached tickets, so the Linear read cost stays proportional
     *  to actual stalls. */
    crossCheck?: (ticket: WatchdogTicket) => Promise<CrossCheckVerdict>;
    /** Present only so the sweep can assert it NEVER auto-transitions. */
    transition?: (payload: unknown) => Promise<void>;
    cadenceMs?: number;
}
export interface WatchdogSweepResult {
    scanned: number;
    armed: number;
    breached: number;
    redispatched: number;
    unreachable: number;
    reroutes: number;
    /** Breached tickets whose mirror row turned out stale (done/deleted/demoted
     *  in Linear) — healed by the cross-check and dropped without alerting. */
    staleCleared: number;
    /** Always 0 — the ladder never auto-transitions workflow state. */
    transitions: number;
    humanExcluded: number;
    errors: unknown[];
}
/** Row for the per-state dwell/idle metrics aggregate (p4 distillation). */
export interface DwellRow {
    state: string;
    enteredAtMs: number;
    firstOwnerActionAtMs: number | null;
    exitedAtMs: number | null;
}
export interface PerStateDwellAggregate {
    state: string;
    count: number;
    totalDwellMs: number;
    totalIdleMs: number;
    maxDwellMs: number;
}
/**
 * Resolve a fallback body that fills `role` and is NOT the current delegate.
 * Returns null for singleton/exclusive roles (e.g. test-author) and for roles
 * with no alternate body — the ladder must never re-route those.
 */
export declare function resolveRerouteTarget(policy: WatchdogCapabilityPolicy | undefined, role: string, currentDelegate: string): string | null;
/**
 * A watchdog re-dispatch is a GENUINE fresh wake: it must admit the same
 * (ticket, state, agent, updatedAt) tuple that dispatch idempotency would
 * otherwise suppress as a duplicate. We clear the prior idempotency rows for the
 * (ticket, agent) — the store's documented manual-recovery escape hatch — then
 * record afresh, so the wake is admitted rather than swallowed.
 */
export declare function redispatchViaWatchdog(store: DispatchIdempotencyStore, dispatch: {
    ticketKey: string;
    workflowState: string;
    agent: string;
    updatedAt: string;
}): {
    admitted: boolean;
    suppressed: boolean;
};
/**
 * Aggregate dwell (time in state) and idle (delivery → first owner action) per
 * state. Open rows (no exit) are measured to `nowMs`; rows with no owner action
 * count their whole dwell as idle. So this analysis is a dashboard read next
 * time, not a manual archaeology pass.
 */
export declare function computePerStateDwellAggregates(rows: DwellRow[], nowMs: number): PerStateDwellAggregate[];
export declare function runFirstActionWatchdogSweep(opts: FirstActionWatchdogOptions): Promise<WatchdogSweepResult>;
/**
 * Register the first-action watchdog as a periodic cron. Called from the
 * production entry point (index.ts) so the watchdog is armed at server bootstrap
 * — not merely importable dead code. Adds a `first-action-watchdog` registry
 * entry (feeds /health.crons) and marks the watchdog scheduled for liveness.
 */
export declare function registerFirstActionWatchdogCron(opts: FirstActionWatchdogOptions): ReturnType<typeof setInterval>;
//# sourceMappingURL=first-action-watchdog.d.ts.map