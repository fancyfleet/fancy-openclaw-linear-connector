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
/** A single department entry in the roster. */
export interface Department {
    /** Human-readable department name (e.g. "AI Team"). */
    name?: string;
    /** OpenClaw agent id that receives an unowned department-prefixed request. */
    defaultTarget: string;
}
/** The department roster: steward + department map, driven by yaml on disk. */
export interface Roster {
    version?: number;
    /** Steward (person) an unroutable request escalates to. */
    steward: string;
    departments: Record<string, Department>;
}
/** Mechanical route reasons — an explicit, human-set target. */
export type MechanicalReason = "delegate" | "assignee" | "mention" | "body-mention";
/** All routing-decision reasons the functionary can emit. */
export type RoutingReason = MechanicalReason | "department-prefix" | "steward-escalation";
/** An explicit mechanical target extracted from the event (delegate/assignee/mention). */
export interface MechanicalTarget {
    name: string;
    reason: MechanicalReason;
}
/** The functionary's decision for a single routing question. */
export interface RouteDecision {
    /** Resolved target: a department worker, the mechanical target, or the steward. */
    target: string;
    reason: RoutingReason;
    /** True only when the request could not be dispositioned and went to the steward. */
    escalated: boolean;
    /** The roster prefix that matched, when reason is `department-prefix`. */
    matchedPrefix?: string;
}
/** Resolve the roster file path: env override wins (tests), else instance config. */
export declare function departmentRosterPath(): string;
/** Test/bootstrap hook: clear the cached roster between loads. */
export declare function resetRosterCache(): void;
/** The roster loaded at bootstrap, for the synchronous dispatch/liveness path. */
export declare function getCachedRoster(): Roster | null;
/**
 * Load the department roster from disk (fail-open).
 *
 * On success caches and returns the roster. On a missing/empty/unparseable
 * file logs WARN and returns null — the functionary then behaves as a no-op
 * (mechanical routing and existing no-route paging are untouched), so a missing
 * roster never breaks dispatch.
 */
export declare function loadRoster(): Promise<Roster | null>;
/**
 * Resolve a routing decision — the pure, deterministic core of the functionary.
 *
 * Mechanical-first: an explicit delegate/assignee/mention always wins and is
 * never overridden by a department-prefix match. Department-prefix is a fallback
 * for requests nothing explicitly routed. An unroutable request escalates to the
 * roster steward (never null, never hardcoded).
 */
export declare function resolveRoute(identifier: string | null | undefined, _eventType: string, roster: Roster | null | undefined, mechanical: MechanicalTarget | null | undefined): RouteDecision;
/**
 * Liveness snapshot for /health. `active` reflects a roster loaded at bootstrap
 * (the functionary resolves department routes only when a roster is present),
 * and the roster block lets ac-validate confirm the steward + departments loaded
 * without waiting for a webhook.
 */
export declare function getRoutingFunctionaryLiveness(): {
    active: boolean;
    roster: {
        loaded: boolean;
        steward: string | null;
        departments: string[];
    };
    path: string;
};
//# sourceMappingURL=department-roster.d.ts.map