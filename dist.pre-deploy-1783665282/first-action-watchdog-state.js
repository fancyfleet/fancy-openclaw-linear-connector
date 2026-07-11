/**
 * AI-2009 — In-process state for the first-action watchdog.
 *
 * Mirrors the rescue-sweep-state.ts singleton idiom (module-level mutable state,
 * whole-object record / cloned getter / reset-for-test) but holds a per-ticket
 * ladder array plus a scheduled flag so both /admin (per-ticket ladder) and
 * /health (liveness: scheduled + armedCount) can read it without waiting for a
 * deadline breach.
 */
let scheduled = false;
const ladders = new Map();
/** Called by the cron registrar so /health can report the watchdog is armed. */
export function markFirstActionWatchdogScheduled() {
    scheduled = true;
}
/** Arm or update the ladder for a ticket (whole-object upsert, cloned history). */
export function upsertFirstActionLadder(ladder) {
    ladders.set(ladder.ticket, {
        ...ladder,
        history: ladder.history.map((h) => ({ ...h })),
    });
}
/** Read the current ladder for a ticket (clone), or null if not armed. */
export function getFirstActionLadder(ticket) {
    const l = ladders.get(ticket);
    if (!l)
        return null;
    return { ...l, history: l.history.map((h) => ({ ...h })) };
}
/** Drop a ladder entirely — used when the on-breach cross-check finds the
 *  mirror row was stale (ticket done/deleted/demoted in Linear). */
export function deleteFirstActionLadder(ticket) {
    ladders.delete(ticket);
}
export function getFirstActionWatchdogState() {
    const all = [...ladders.values()].map((l) => ({
        ...l,
        history: l.history.map((h) => ({ ...h })),
    }));
    return {
        scheduled,
        armedCount: all.filter((l) => !l.unreachable).length,
        ladders: all,
    };
}
export function resetFirstActionWatchdogStateForTest() {
    scheduled = false;
    ladders.clear();
}
//# sourceMappingURL=first-action-watchdog-state.js.map