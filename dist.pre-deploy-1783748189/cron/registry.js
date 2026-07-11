/**
 * AI-1810 — Connector-level cron/background-driver registry.
 *
 * Twice (AI-1773, AI-1775) a periodic driver shipped fully tested and
 * deployed while never registered at bootstrap — dead code in prod with all
 * ACs green. This registry makes scheduling state observable: every periodic
 * or background driver records itself here at the moment its timer is
 * actually created, and /health enumerates the entries.
 *
 * Contract:
 *  - Drivers call registerCron() from inside their register*Cron() function,
 *    NOT at module load. An entry therefore exists if and only if the
 *    production bootstrap really invoked the registrar — importing the module
 *    (as unit tests do) is not enough to appear in /health.
 *  - Conditional registrars (e.g. the G-20 canary, which skips when its env
 *    is missing) must only call registerCron() on the path that schedules
 *    the timer, so /health reflects live scheduling state, not intent.
 *
 * Verification loop this closes (AI-1808): at ac-validate the steward curls
 * /health and looks for the component by name — mechanical and generic,
 * instead of per-feature grep archaeology in index.ts.
 */
const entries = new Map();
/** Format a millisecond interval as a compact human-readable duration. */
export function formatIntervalMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0)
        return `${ms}ms`;
    if (ms % 3600000 === 0)
        return `${ms / 3600000}h`;
    if (ms % 60000 === 0)
        return `${ms / 60000}m`;
    if (ms % 1000 === 0)
        return `${ms / 1000}s`;
    return `${ms}ms`;
}
/**
 * Record a periodic/background driver as scheduled in this process.
 * Call from inside the registrar, on the same code path that creates the
 * timer. Re-registering the same name overwrites (last write wins) so a
 * hot-reload path can refresh its schedule without duplicating entries.
 */
export function registerCron(name, schedule) {
    entries.set(name, {
        name,
        schedule,
        registeredAt: new Date().toISOString(),
        // A hot-reload re-registers the driver but does not un-run it.
        lastRunAt: entries.get(name)?.lastRunAt ?? null,
    });
}
/**
 * Stamp a driver as having just run. Call at the END of each invocation, from
 * the same code path that does the work — a driver that throws before reaching
 * this call has not run, and its stale lastRunAt is the signal.
 * No-op for an unregistered name: liveness cannot precede scheduling.
 */
export function markCronRun(name, now = new Date()) {
    const entry = entries.get(name);
    if (!entry)
        return;
    entry.lastRunAt = now.toISOString();
}
/** All drivers registered in this process, sorted by name. */
export function getRegisteredCrons() {
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/** Test-only: clear the registry between cases. */
export function resetCronRegistryForTest() {
    entries.clear();
}
//# sourceMappingURL=registry.js.map