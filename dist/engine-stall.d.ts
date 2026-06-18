/**
 * Phase 6.5 / H-3 — Engine stall detection + agent response (+ at-capacity accounting).
 *
 * **Engine owns detection.** Each state carries a time-in-state SLA; when an outstanding
 * child breaches it, the engine detects the breach and emits a stall event against that
 * specific child and its ancestor chain. The parent does not poll for staleness.
 *
 * **Parent agent owns the qualitative response.** On a stall event, the `managing` owner
 * decides what the situation needs — nudge, guidance, or escalation of the specific stuck
 * child (barrier-level break-glass, §5.3).
 *
 * **At-capacity ≠ stall.** A legitimately deferred/at-capacity child (the AI-1339 case)
 * has its waiting time attributed up the ancestor SLA accounting as **known deferral**,
 * so an overloaded-but-healthy subtree does not trip stall escalation while a genuinely
 * stuck leaf still does.
 *
 * Design: design.md §5.5, §16.1.
 *
 * ACs:
 *   - A deliberately stalled leaf produces a stall event to its parent.
 *   - An at-capacity-but-healthy subtree does NOT trip stall escalation.
 *
 * Cross-ref AI-1339 (capacity-aware delivery recovery — the at-capacity classification this consumes).
 */
/** A stall event emitted by the engine when a child breaches its SLA. */
export interface StallEvent {
    /** The stalled child identifier. */
    childIdentifier: string;
    /** The parent identifier. */
    parentIdentifier: string;
    /** The child's current state. */
    currentState: string | null;
    /** Epoch ms of the child's last activity, or null if never active. */
    lastActivityAt: number | null;
    /** How long (ms) the child has been idle. */
    idleDurationMs: number;
    /** Whether the child is at-capacity/deferred (known deferral). */
    isAtCapacity: boolean;
    /** How many ancestors have been attributed with this known deferral. */
    knownDeferralAncestors: number;
    /** Root cause: the SLA that was breached. */
    slaBreached: string;
    /** Epoch ms when the child entered its current state (for breach dedup). */
    stateEnteredAt: number | null;
}
/** SLA configuration for a workflow state. */
export interface SLA {
    /** State identifier (e.g., 'thinking', 'doing'). */
    state: string;
    /** Maximum allowed time-in-state in milliseconds. */
    maxDurationMs: number;
    /** Priority level (used for escalation decisions). */
    priority: number;
}
/**
 * Parse SLA configuration from environment variables.
 * Format: STATE1:MAX_DURATION,STATE2:MAX_DURATION,...
 * Example: THINKING:3600000,DOING:14400000,MANAGING:86400000
 */
export declare function parseSLAs(): SLA[];
/**
 * Detect stalled children that have breached their SLA.
 *
 * Compares each child's idle duration against its state's SLA and filters out
 * at-capacity/deferred children (known deferrals) that should not trigger
 * stall escalation.
 *
 * @param parentIdentifier - Parent issue identifier
 * @param authToken - Linear API auth token
 * @param slas - SLA configuration for each state
 * @returns Array of StallEvent objects for children that breached their SLA
 */
export declare function detectStalledChildrenWithSLA(parentIdentifier: string, authToken: string, slas: SLA[]): Promise<StallEvent[]>;
export declare function emitStallEvents(stallEvents: StallEvent[], authToken: string): Promise<number>;
/**
 * Build a human-readable stall event message for the parent agent.
 *
 * Includes details about which children are stalled, their breach reason,
 * and actionable suggestions for the parent to respond.
 */
export declare function buildStallEventMessage(stallEvents: StallEvent[]): string;
/**
 * Main entry point for engine stall detection and emission.
 *
 * Call this when the engine wants to check for stalled children. It:
 *   1. Detects children that have breached their SLA
 *   2. Filters out at-capacity/deferred children (known deferrals)
 *   3. Emits stall events to the parent agent via a comment
 *
 * This is triggered periodically (e.g., during managing-wake) or when
 * a child event is received.
 *
 * @param parentIdentifier - Parent issue identifier
 * @param authToken - Linear API auth token
 * @returns Number of stall events emitted
 */
export declare function triggerStallDetection(parentIdentifier: string, authToken: string): Promise<number>;
/**
 * Classify a stall as dead or slow based on a delegate liveness probe result.
 *
 * dead → re-route (agent is unreachable)
 * slow → wait (agent is alive but behind, AI-1339 lesson)
 */
export declare function classifyStallLiveness(livenessResult: {
    available: boolean;
    reason?: string;
}): "dead" | "slow";
/**
 * Probe delegate liveness and annotate each stall event with livenessClassification.
 *
 * A single probe is performed per event (the stalled child's delegate). The probe
 * hits the OpenClaw hooks endpoint; a non-2xx or network error → "dead".
 */
export declare function emitStallEventsWithLiveness<T extends {
    childIdentifier: string;
    parentIdentifier: string;
    currentState: string;
    [k: string]: unknown;
}>(events: T[], _authToken: string, livenessConfig: {
    hooksUrl?: string;
    hooksToken?: string;
}): Promise<Array<T & {
    livenessClassification: "dead" | "slow";
}>>;
/**
 * Throttle a burst of simultaneous stall breaches (G-12 stall-storm prevention).
 *
 * Returns `dispatch` (up to batchSize events for immediate signaling) and
 * `deferred` (the remainder). batchSize=0 defers all events as a safety guard.
 */
export declare function throttleStallRollout<T extends object>(events: T[], batchSize: number): {
    dispatch: T[];
    deferred: T[];
};
/**
 * Trigger stall detection with once-per-breach dedup and rollout throttle.
 *
 * AC3: StallBreachStore ensures each (childId, stateEnteredAt) breach is
 * signaled exactly once, no matter how many cron ticks fire.
 * AC4: STALL_ROLLOUT_BATCH_SIZE caps simultaneous emissions on first deploy.
 *
 * @param parentIdentifier - Parent issue identifier
 * @param authToken - Linear API auth token
 * @param breachStorePath - Path to the SQLite breach dedup database
 * @returns counts of emitted, deduped, and deferred events
 */
export declare function triggerStallDetectionWithDedup(parentIdentifier: string, authToken: string, breachStorePath: string): Promise<{
    emitted: number;
    deduped: number;
    deferred?: number;
}>;
export { detectStalledChildren } from "./barrier.js";
//# sourceMappingURL=engine-stall.d.ts.map