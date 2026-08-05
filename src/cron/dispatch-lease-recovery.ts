/**
 * INF-1260 AC9: dispatch-lease-recovery sweep.
 *
 * Scans the dispatch lease store for expired ("zombie") leases left behind by
 * crashed or orphaned sessions. Expired leases that were never explicitly
 * released can leave tickets in a fail-open state for submit/continue-workflow
 * (AC1+AC2 fix in proxy-cas-check.ts now refuses on zombie leases, but this
 * sweep cleans them proactively rather than waiting for the next submit attempt).
 *
 * Registered at bootstrap via registerDispatchLeaseRecoveryCron() — visible in
 * /health.crons per AI-1808.
 */

import { registerCron, markCronRun, formatIntervalMs } from "./registry.js";
import { componentLogger, createLogger } from "../logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "lease-recovery");

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface DispatchLeaseRecoveryOptions {
  intervalMs?: number;
  /** Returns the current expired lease count (for health reporting). */
  sweepFn: () => Promise<{ expired: number; recovered: number }>;
}

/**
 * Register the dispatch-lease-recovery sweep as a cron entry so it appears
 * in /health.crons (AI-1808 bootstrap-wiring requirement).
 */
export function registerDispatchLeaseRecoveryCron(options: DispatchLeaseRecoveryOptions): void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  // The actual sweep runs inside the existing dispatch system's tick;
  // here we register the liveness signal so /health proves the driver exists.
  registerCron("dispatch-lease-recovery", `every ${formatIntervalMs(intervalMs)}`);

  // Trigger an immediate sweep on startup, then on interval.
  const run = async () => {
    try {
      const result = await options.sweepFn();
      markCronRun("dispatch-lease-recovery");
      if (result.expired > 0 || result.recovered > 0) {
        log.info(`lease-recovery sweep: ${result.expired} expired, ${result.recovered} recovered`);
      }
    } catch (err) {
      log.warn(`lease-recovery sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Run once on registration (startup), then on interval.
  run().catch(() => {/* logged above */});
  setInterval(() => run().catch(() => {/* logged above */}), intervalMs).unref();
}
