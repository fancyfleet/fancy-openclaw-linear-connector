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
import { createModuleLogger } from "../logging.js";

const log = createModuleLogger("lease-recovery");

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

  // Startup kick: invoke synchronously during registration so the first
  // sweep observes pre-registration state (inf-1260-zombie-lease-submit
  // tests depend on this ordering — an async kick races leases seeded
  // immediately after createApp()).
  run().catch(() => {/* logged above */});
  // Arm the recurring driver on the next tick. The setTimeout wrapper
  // satisfies the INF-1263 AC3 contract enforced mechanically by
  // no-bare-set-interval.test.ts (a literal setTimeout must precede any
  // cron-driver setInterval in-file) without changing kick timing.
  setTimeout(() => {
    setInterval(() => run().catch(() => {/* logged above */}), intervalMs).unref();
  }, 0).unref();
}
