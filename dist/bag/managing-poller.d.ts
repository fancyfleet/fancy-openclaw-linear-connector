/**
 * ManagingPoller — periodic stewardship-wake driver for Managing-state tickets.
 *
 * Every cycle, for each configured agent, queries Linear for issues delegated
 * to that agent in the `Managing` workflow state. For each such issue, decides
 * whether the agent is "due" for a stewardship wake based on:
 *
 *   - `lastDispatchedAt` (persisted in ManagingStateStore)
 *   - `Managing-interval: <duration>` parsed from the issue description body
 *     (defaults to 30m when absent or unparseable)
 *
 * All due tickets for a given agent are bundled into a single wake message
 * (so 4 due tickets become 1 stewardship prompt, not 4 separate ones).
 *
 * Configuration (env vars, all optional):
 *   MANAGING_POLLER_CYCLE_MS     — how often the poller runs (default: 60_000)
 *   MANAGING_POLLER_DEFAULT_MS   — default per-ticket interval (default: 1_800_000 = 30m)
 *
 * The first-wake-after-entering-Managing is always immediate (well: on the
 * next poller tick) because `lastDispatchedAt` is null until the first dispatch.
 */
import { type AgentConfig } from "../agents.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import type { ManagingStateStore } from "../store/managing-state-store.js";
import type { DeliveryConfig } from "../delivery/index.js";
import { sendManagingWakeSignal } from "./managing-wake.js";
export interface ManagingPollerConfig {
    cycleMs: number;
    defaultIntervalMs: number;
}
export interface ManagingPollerDeps {
    store: ManagingStateStore;
    operationalEventStore: OperationalEventStore;
    deliveryConfig: DeliveryConfig;
    /** Overridable for testing — returns the agents to consider. */
    listAgents?: () => AgentConfig[];
    /** Overridable for testing — returns Managing-state tickets for an agent. */
    fetchManagingTickets?: (agent: AgentConfig) => Promise<LinearManagingIssue[]>;
    /** Overridable for testing — sends the bundled stewardship wake. */
    sendWake?: typeof sendManagingWakeSignal;
    /** Overridable for testing — clock source. */
    now?: () => number;
}
export interface LinearManagingIssue {
    identifier: string;
    title: string;
    description: string | null;
}
export interface PollerCycleResult {
    agentsChecked: number;
    ticketsSeen: number;
    ticketsDispatched: number;
    agentsWaked: number;
    errors: number;
}
export declare function parseManagingInterval(body: string | null | undefined): number | null;
/**
 * Decide whether a ticket is due for a stewardship wake.
 *
 * - If never dispatched: due immediately.
 * - Otherwise: due when (now - lastDispatchedAt) >= intervalMs.
 */
export declare function isDue(now: number, lastDispatchedAt: number | null, intervalMs: number): boolean;
export declare class ManagingPoller {
    private timer?;
    private config;
    private deps;
    constructor(deps: ManagingPollerDeps, config?: Partial<ManagingPollerConfig>);
    start(): void;
    stop(): void;
    /**
     * Run one poll cycle. Returns a summary of what happened — useful for tests
     * and operator visibility.
     */
    runCycle(): Promise<PollerCycleResult>;
}
//# sourceMappingURL=managing-poller.d.ts.map