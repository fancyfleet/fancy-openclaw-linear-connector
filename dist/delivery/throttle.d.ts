/**
 * Per-agent delivery throttle.
 *
 * Prevents burst-spawned sessions by enforcing a minimum interval between
 * consecutive deliveries to the same agent. Each agent gets its own cooldown
 * tracked independently.
 *
 * Default interval: 2 seconds (configurable via DISPATCH_THROTTLE_MS env).
 */
export declare class DeliveryThrottle {
    private lastDelivery;
    private intervalMs;
    constructor(intervalMs?: number);
    /**
     * If the agent was delivered to within the throttle window, wait the
     * remaining duration before resolving. Otherwise resolves immediately.
     */
    wait(agentId: string): Promise<void>;
    /** Record a delivery for an agent (call after successful dispatch). */
    record(agentId: string): void;
    /** Return the configured interval in ms. */
    getInterval(): number;
}
//# sourceMappingURL=throttle.d.ts.map