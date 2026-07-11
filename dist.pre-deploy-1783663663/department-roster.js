/**
 * AI-1479 (Phase 6.5 / H-4) — Routing functionary.
 *
 * The deterministic, checkable routing core extracted from Astrid-the-person
 * (design §7 / §16.5). A request is matched to a department worker by roster,
 * with mechanical-first ordering; anything the rules can't disposition escalates
 * to the steward — a *judgment* act that puts a person back in the loop.
 *
 * Ordering (steward design decision, 2026-07-09T23:04:51):
 *   1. Explicit mechanical route (delegate / assignee / mention) — ALWAYS wins.
 *   2. Department-prefix match — a fallback for otherwise-unrouted requests.
 *   3. Steward escalation — last; the roster steward, never a hardcoded name.
 *
 * The department-prefix layer is a *fallback only*: on a single-prefix workspace
 * (everything AI-) putting it above the mechanical delegate would silently
 * override every explicit delegation, the opposite of "narrow functionary,
 * judgment stays with the person". No per-event-type override ships (the stale
 * `Comment: charles` override was dropped — Charles is conversation-only,
 * AI-1946).
 *
 * Liveness: /health exposes `routingFunctionary` so ac-validate can confirm the
 * roster loaded and the functionary is active in dispatch without waiting for a
 * webhook to arrive.
 */
import fs from "node:fs/promises";
import yaml from "js-yaml";
import { defaultDepartmentRosterPath } from "./instance-config.js";
import { componentLogger, createLogger } from "./logger.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "department-roster");
/**
 * Last roster loaded by `loadRoster()`. Tracked module-level so the live
 * dispatch path (`routeEventAll`) and `/health` can consult it synchronously
 * without re-reading the file on every event.
 */
let cachedRoster = null;
/** Resolve the roster file path: env override wins (tests), else instance config. */
export function departmentRosterPath() {
    return process.env.DEPARTMENT_ROSTER_PATH ?? defaultDepartmentRosterPath();
}
/** Test/bootstrap hook: clear the cached roster between loads. */
export function resetRosterCache() {
    cachedRoster = null;
}
/** The roster loaded at bootstrap, for the synchronous dispatch/liveness path. */
export function getCachedRoster() {
    return cachedRoster;
}
/**
 * Load the department roster from disk (fail-open).
 *
 * On success caches and returns the roster. On a missing/empty/unparseable
 * file logs WARN and returns null — the functionary then behaves as a no-op
 * (mechanical routing and existing no-route paging are untouched), so a missing
 * roster never breaks dispatch.
 */
export async function loadRoster() {
    const filePath = departmentRosterPath();
    try {
        const content = await fs.readFile(filePath, "utf8");
        const parsed = yaml.load(content);
        if (!parsed || typeof parsed !== "object" || !parsed.steward || !parsed.departments) {
            log.warn(`department-roster: roster at ${filePath} is missing steward/departments — functionary inactive`);
            cachedRoster = null;
            return null;
        }
        cachedRoster = {
            version: parsed.version,
            steward: parsed.steward,
            departments: parsed.departments,
        };
        log.debug(`department-roster: loaded steward='${cachedRoster.steward}' departments=[${Object.keys(cachedRoster.departments).join(", ")}] from ${filePath}`);
        return cachedRoster;
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn(`department-roster: could not load roster at ${filePath} — functionary inactive. Reason: ${reason}`);
        cachedRoster = null;
        return null;
    }
}
/**
 * Resolve a routing decision — the pure, deterministic core of the functionary.
 *
 * Mechanical-first: an explicit delegate/assignee/mention always wins and is
 * never overridden by a department-prefix match. Department-prefix is a fallback
 * for requests nothing explicitly routed. An unroutable request escalates to the
 * roster steward (never null, never hardcoded).
 */
export function resolveRoute(identifier, _eventType, roster, mechanical) {
    // 1. Mechanical-first — an explicit human-set target always wins.
    if (mechanical && mechanical.name) {
        return { target: mechanical.name, reason: mechanical.reason, escalated: false };
    }
    // 2. Department-prefix fallback — clean match routes with no person in the loop.
    if (roster && identifier) {
        const prefix = identifier.split("-")[0]?.trim().toUpperCase();
        if (prefix) {
            for (const [key, dept] of Object.entries(roster.departments ?? {})) {
                if (key.toUpperCase() === prefix && dept?.defaultTarget) {
                    return {
                        target: dept.defaultTarget,
                        reason: "department-prefix",
                        escalated: false,
                        matchedPrefix: key,
                    };
                }
            }
        }
    }
    // 3. Steward escalation — the match failed; a person (the steward) takes over.
    const steward = roster?.steward ?? "astrid";
    return { target: steward, reason: "steward-escalation", escalated: true };
}
/**
 * Liveness snapshot for /health. `active` reflects a roster loaded at bootstrap
 * (the functionary resolves department routes only when a roster is present),
 * and the roster block lets ac-validate confirm the steward + departments loaded
 * without waiting for a webhook.
 */
export function getRoutingFunctionaryLiveness() {
    const roster = cachedRoster;
    return {
        active: roster !== null,
        roster: {
            loaded: roster !== null,
            steward: roster?.steward ?? null,
            departments: roster ? Object.keys(roster.departments ?? {}) : [],
        },
        path: departmentRosterPath(),
    };
}
//# sourceMappingURL=department-roster.js.map