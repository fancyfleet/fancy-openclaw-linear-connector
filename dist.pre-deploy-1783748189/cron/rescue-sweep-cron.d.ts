/**
 * AI-1566 — Periodic rescue sweep cron registration.
 *
 * Schedules runRescueSweep() on a configurable interval (RESCUE_SWEEP_INTERVAL env,
 * default 1h). Detects and repairs dormant/malformed/drifted wf:* tickets — a safety
 * net that fires independently of the auto-entry hook.
 *
 * Pattern mirrors src/cron/p4-metrics-distillation.ts.
 *
 * AI-1970 fix:
 *   - Auth now uses getAccessToken("ai") ?? env (matching every sibling caller),
 *     fixing the bug where the deployment's encrypted token was never read.
 *   - Skip and fail outcomes are recorded to /health state so a dead safety net
 *     no longer looks identical to a never-due one.
 *   - A first run fires immediately after registration (timer.unref'd) rather than
 *     waiting a full interval.
 */
/**
 * Register the rescue sweep as an in-process recurring job.
 * Interval is controlled by RESCUE_SWEEP_INTERVAL env var (default: 1h).
 * The timer is unref'd so it won't prevent graceful shutdown.
 *
 * A first run fires via setImmediate-style setTimeout after registration
 * (also unref'd) so the sweep doesn't wait a full interval before initial
 * execution.
 */
export declare function registerRescueSweepCron(): void;
//# sourceMappingURL=rescue-sweep-cron.d.ts.map