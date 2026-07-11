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
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { registerCron, formatIntervalMs } from "./cron/registry.js";
import { markFirstActionWatchdogScheduled, getFirstActionLadder, upsertFirstActionLadder, deleteFirstActionLadder, } from "./first-action-watchdog-state.js";
const CRON_NAME = "first-action-watchdog";
const MINUTE = 60000;
const DEFAULT_DEADLINE_MS = 45 * MINUTE;
const DEFAULT_MAX_RUNGS = 3;
const DEFAULT_CADENCE_MS = 5 * MINUTE;
// ── Helpers ─────────────────────────────────────────────────────────────────
/** Parse a duration string ("45m", "2h", "3600000") to ms; null if unparseable. */
function parseDurationToMs(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value !== "string")
        return null;
    const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(d|h|m|s|ms)?$/i);
    if (!m)
        return null;
    const n = parseFloat(m[1]);
    switch ((m[2] ?? "").toLowerCase()) {
        case "d": return n * 24 * 60 * MINUTE;
        case "h": return n * 60 * MINUTE;
        case "m": return n * MINUTE;
        case "s": return n * 1000;
        case "ms":
        case "": return n;
        default: return null;
    }
}
/**
 * Resolve the def for a (workflow, state) from a workflow-def path that may be a
 * single file or a directory of *.yaml defs. Returns the matched state def (with
 * owner_role + optional first_action_deadline), or undefined.
 */
function loadWorkflowStateDef(defPath, workflowId, stateId) {
    if (!defPath || !fs.existsSync(defPath))
        return undefined;
    let files;
    if (fs.statSync(defPath).isDirectory()) {
        files = fs
            .readdirSync(defPath)
            .filter((f) => /\.ya?ml$/i.test(f))
            .sort()
            .map((f) => path.join(defPath, f));
    }
    else {
        files = [defPath];
    }
    for (const file of files) {
        let def;
        try {
            def = yaml.load(fs.readFileSync(file, "utf8"));
        }
        catch {
            continue;
        }
        if (!def || def.id !== workflowId || !Array.isArray(def.states))
            continue;
        const state = def.states.find((s) => s.id === stateId);
        if (state)
            return state;
    }
    return undefined;
}
// ── Re-route resolution (rung 3) ──────────────────────────────────────────────
/**
 * Resolve a fallback body that fills `role` and is NOT the current delegate.
 * Returns null for singleton/exclusive roles (e.g. test-author) and for roles
 * with no alternate body — the ladder must never re-route those.
 */
export function resolveRerouteTarget(policy, role, currentDelegate) {
    if (!policy || !Array.isArray(policy.bodies))
        return null;
    const roleDef = policy.roles?.find((r) => r.id === role);
    // Exclusive/singleton roles are never re-routed — there is no legal alternate.
    if (roleDef?.exclusive)
        return null;
    const fallback = policy.bodies
        .filter((b) => Array.isArray(b.fills_roles) && b.fills_roles.includes(role))
        .map((b) => b.id)
        .find((id) => id !== currentDelegate);
    return fallback ?? null;
}
// ── Re-dispatch bypassing idempotency (rung 1, AI-1969 admit semantics) ────────
/**
 * A watchdog re-dispatch is a GENUINE fresh wake: it must admit the same
 * (ticket, state, agent, updatedAt) tuple that dispatch idempotency would
 * otherwise suppress as a duplicate. We clear the prior idempotency rows for the
 * (ticket, agent) — the store's documented manual-recovery escape hatch — then
 * record afresh, so the wake is admitted rather than swallowed.
 */
export function redispatchViaWatchdog(store, dispatch) {
    store.clearAgentRows(dispatch.ticketKey, dispatch.agent);
    const result = store.checkAndRecord(dispatch.ticketKey, dispatch.workflowState, dispatch.agent, dispatch.updatedAt);
    return { admitted: !result.suppressed, suppressed: result.suppressed };
}
// ── Per-state dwell/idle aggregates (AC5, p4 metrics distillation) ─────────────
/**
 * Aggregate dwell (time in state) and idle (delivery → first owner action) per
 * state. Open rows (no exit) are measured to `nowMs`; rows with no owner action
 * count their whole dwell as idle. So this analysis is a dashboard read next
 * time, not a manual archaeology pass.
 */
export function computePerStateDwellAggregates(rows, nowMs) {
    const byState = new Map();
    for (const row of rows) {
        const exitedOrNow = row.exitedAtMs ?? nowMs;
        const dwellMs = exitedOrNow - row.enteredAtMs;
        const idleEnd = row.firstOwnerActionAtMs ?? exitedOrNow;
        const idleMs = idleEnd - row.enteredAtMs;
        let agg = byState.get(row.state);
        if (!agg) {
            agg = { state: row.state, count: 0, totalDwellMs: 0, totalIdleMs: 0, maxDwellMs: 0 };
            byState.set(row.state, agg);
        }
        agg.count += 1;
        agg.totalDwellMs += dwellMs;
        agg.totalIdleMs += idleMs;
        if (dwellMs > agg.maxDwellMs)
            agg.maxDwellMs = dwellMs;
    }
    return [...byState.values()];
}
// ── The sweep ─────────────────────────────────────────────────────────────────
export async function runFirstActionWatchdogSweep(opts) {
    const now = opts.now ? opts.now() : Date.now();
    const defaultDeadlineMs = opts.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
    const maxRungs = opts.maxRungs ?? DEFAULT_MAX_RUNGS;
    const result = {
        scanned: 0,
        armed: 0,
        breached: 0,
        redispatched: 0,
        unreachable: 0,
        reroutes: 0,
        staleCleared: 0,
        transitions: 0,
        humanExcluded: 0,
        errors: [],
    };
    let tickets;
    try {
        tickets = await opts.listTickets();
    }
    catch (err) {
        result.errors.push(err);
        return result;
    }
    for (const t of tickets) {
        result.scanned += 1;
        try {
            // AC3 — never nudge human-assigned or Matt-blocked (`needs-human`) work.
            // Excluded tickets are not armed at all.
            if (t.humanAssigned || (t.labels ?? []).includes("needs-human")) {
                result.humanExcluded += 1;
                continue;
            }
            const stateDef = loadWorkflowStateDef(opts.workflowDefPath, t.workflow, t.state);
            const overrideMs = parseDurationToMs(stateDef?.first_action_deadline);
            const deadlineMs = overrideMs ?? defaultDeadlineMs;
            const armedAtMs = t.dispatchDeliveredAtMs;
            const deadlineAtMs = armedAtMs + deadlineMs;
            const existing = getFirstActionLadder(t.ticket);
            // A ladder only carries over for the SAME dispatch (same delivery time).
            // A fresh dispatch — re-entry, revision round-trip, or a state change
            // re-stamping entered_state_at — re-arms a clean ladder; rungs and an
            // "unreachable" verdict from a prior dispatch must not swallow it.
            const sameDispatch = existing != null && Date.parse(existing.armedAt) === armedAtMs;
            const priorRungs = t.rungsFired ?? (sameDispatch ? existing.rungsFired : 0);
            const history = sameDispatch ? [...existing.history] : [];
            let rungsFired = priorRungs;
            let unreachable = sameDispatch ? existing.unreachable : false;
            result.armed += 1;
            const actedInTime = t.firstOwnerActionAtMs != null && t.firstOwnerActionAtMs <= deadlineAtMs;
            const breached = !actedInTime && now >= deadlineAtMs;
            if (breached) {
                result.breached += 1;
                // A breach on a stale mirror row (ticket already done / deleted /
                // demoted in Linear) is not a stall — heal-and-drop, never alert.
                if (opts.crossCheck) {
                    let verdict = "unknown";
                    try {
                        verdict = await opts.crossCheck(t);
                    }
                    catch {
                        verdict = "unknown"; // fail open to normal ladder behavior
                    }
                    if (verdict === "stale") {
                        deleteFirstActionLadder(t.ticket);
                        result.staleCleared += 1;
                        continue;
                    }
                }
                if (unreachable) {
                    // Ladder already exhausted for this dispatch — the rung-2 alert
                    // fired once; stay silent instead of re-alerting every sweep.
                    continue;
                }
                if (priorRungs >= maxRungs) {
                    // Rung 2 — ladder exhausted: mark unreachable + alert ops, carrying
                    // ticket / state / delegate / history for the on-call human.
                    unreachable = true;
                    history.push({ rung: "unreachable", at: new Date(now).toISOString() });
                    result.unreachable += 1;
                    opts.notify?.({
                        severity: "critical",
                        source: "first-action-watchdog",
                        title: `Delegate ${t.delegate} unreachable on ${t.ticket} (${t.state})`,
                        ticket: t.ticket,
                        state: t.state,
                        delegate: t.delegate,
                        rungsFired: priorRungs,
                        history: history.map((h) => ({ ...h })),
                    });
                    if (opts.escalateUnreachable) {
                        await opts.escalateUnreachable({
                            ticket: t.ticket,
                            state: t.state,
                            agent: t.delegate,
                            history: history.map((h) => ({ ...h })),
                        });
                    }
                    // Rung 3 — optional re-route to a fallback body, respecting capability
                    // policy; never for singleton/exclusive roles without a fallback.
                    const role = stateDef?.owner_role;
                    const target = role
                        ? resolveRerouteTarget(opts.capabilityPolicy, role, t.delegate)
                        : null;
                    if (target && role && opts.reroute) {
                        history.push({
                            rung: "reroute",
                            at: new Date(now).toISOString(),
                            detail: `${t.delegate}→${target}`,
                        });
                        await opts.reroute({
                            ticket: t.ticket,
                            fromAgent: t.delegate,
                            toAgent: target,
                            role,
                        });
                        result.reroutes += 1;
                    }
                }
                else {
                    // Rung 1 — automatic re-dispatch (genuine fresh wake).
                    history.push({ rung: "redispatch", at: new Date(now).toISOString() });
                    if (opts.redispatch) {
                        await opts.redispatch({ ticket: t.ticket, state: t.state, agent: t.delegate });
                    }
                    rungsFired = priorRungs + 1;
                    result.redispatched += 1;
                }
            }
            const ladder = {
                ticket: t.ticket,
                state: t.state,
                delegate: t.delegate,
                armedAt: new Date(armedAtMs).toISOString(),
                deadlineAt: new Date(deadlineAtMs).toISOString(),
                rungsFired,
                unreachable,
                history,
            };
            upsertFirstActionLadder(ladder);
        }
        catch (err) {
            result.errors.push(err);
        }
    }
    return result;
}
// ── Cron registration (bootstrap wiring) ──────────────────────────────────────
/**
 * Register the first-action watchdog as a periodic cron. Called from the
 * production entry point (index.ts) so the watchdog is armed at server bootstrap
 * — not merely importable dead code. Adds a `first-action-watchdog` registry
 * entry (feeds /health.crons) and marks the watchdog scheduled for liveness.
 */
export function registerFirstActionWatchdogCron(opts) {
    const cadenceMs = opts.cadenceMs ?? DEFAULT_CADENCE_MS;
    registerCron(CRON_NAME, `every ${formatIntervalMs(cadenceMs)}`);
    markFirstActionWatchdogScheduled();
    const timer = setInterval(() => {
        runFirstActionWatchdogSweep(opts).catch((err) => {
            console.error(`[${CRON_NAME}] sweep failed:`, err);
        });
    }, cadenceMs);
    if (typeof timer.unref === "function")
        timer.unref();
    return timer;
}
//# sourceMappingURL=first-action-watchdog.js.map