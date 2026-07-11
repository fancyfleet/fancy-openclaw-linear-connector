/**
 * AI-2009 — In-process state for the first-action watchdog.
 *
 * Mirrors the rescue-sweep-state.ts singleton idiom (module-level mutable state,
 * whole-object record / cloned getter / reset-for-test) but holds a per-ticket
 * ladder array plus a scheduled flag so both /admin (per-ticket ladder) and
 * /health (liveness: scheduled + armedCount) can read it without waiting for a
 * deadline breach.
 */
/** One rung fired against a ticket, logged for the ops alert + /admin history. */
export interface LadderHistoryEntry {
    /** "redispatch" | "unreachable" | "reroute" */
    rung: string;
    /** ISO timestamp the rung fired. */
    at: string;
    /** Optional human-readable detail (e.g. reroute target). */
    detail?: string;
}
/** Per-ticket ladder state — armed deadline plus escalation progress. */
export interface FirstActionLadder {
    ticket: string;
    state: string;
    delegate: string;
    /** ISO — dispatch delivery time the deadline is armed from. */
    armedAt: string;
    /** ISO — armedAt + the per-state (or default) first-action deadline. */
    deadlineAt: string;
    /** How many escalation rungs have fired for this ticket. */
    rungsFired: number;
    /** Set once the ladder is exhausted and the delegate is marked unreachable. */
    unreachable: boolean;
    history: LadderHistoryEntry[];
}
/** Liveness + ladder view surfaced at /health and /admin. */
export interface FirstActionWatchdogState {
    /** True once the watchdog cron is registered (armed and scheduled). */
    scheduled: boolean;
    /** Count of currently-armed ladders (not yet marked unreachable). */
    armedCount: number;
    ladders: FirstActionLadder[];
}
/** Called by the cron registrar so /health can report the watchdog is armed. */
export declare function markFirstActionWatchdogScheduled(): void;
/** Arm or update the ladder for a ticket (whole-object upsert, cloned history). */
export declare function upsertFirstActionLadder(ladder: FirstActionLadder): void;
/** Read the current ladder for a ticket (clone), or null if not armed. */
export declare function getFirstActionLadder(ticket: string): FirstActionLadder | null;
export declare function getFirstActionWatchdogState(): FirstActionWatchdogState;
export declare function resetFirstActionWatchdogStateForTest(): void;
//# sourceMappingURL=first-action-watchdog-state.d.ts.map