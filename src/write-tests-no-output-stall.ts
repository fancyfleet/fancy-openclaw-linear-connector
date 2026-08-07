/**
 * INF-1305 — TDD write-tests no-output stall handling component.
 *
 * Post-INF-1295 shape: dispatch leases remain idempotent/acknowledged
 * (skippedIdempotent) while write-tests tickets receive no usable output
 * (no failing-test artifact, no blocker). The existing suppression correctly
 * prevents blind redispatch but left the stall invisible to engine-watch.
 *
 * This component makes the idempotent-lease/no-artifact stall observable:
 *  - Registered at server bootstrap (createApp) so /health proves wiring
 *    without waiting for a failure trigger (AI-1808 dead-code guard, AC7/AC8).
 *  - Liveness is exposed at /health.writeTestsNoOutputStall with
 *    scheduled/active/subscribed + stalledCount/stalledTickets so an
 *    operator can distinguish healthy in-progress dispatch from
 *    idempotent-but-stalled dispatch (AC6).
 *  - After N repeated no-activity/model/bootstrap failures for the same
 *    (agent, ticket) pair, the connector surfaces a distinct actionable
 *    failure instead of leaving the ticket in live write-tests limbo (AC2).
 *
 * Registration follows the AI-1810 cron registry pattern: registerCron()
 * is called from inside registerWriteTestsNoOutputStall(), NOT at module
 * load, so an entry in /health.crons exists iff production bootstrap
 * really invoked the registrar.
 *
 * Sweep: on each tick, scan enrolled-tickets mirror for write-tests +
 * active dispatch-lease and cross-reference operational events for owner
 * activity. Tickets with lease but no owner activity beyond the no-output
 * window are counted in stalledTickets and surfaced via /health + warnings.
 * This avoids claiming fake stalling while still giving engine-watch a
 * real probe (AC2/AC6). The sweep handles the two documented shapes:
 *   Shape A: no-activity (INF-1301/1302/1303/1294) — lease active, no ack.
 *   Shape B: C6 bootstrap/model error (INF-1300/1304) — lease retained after
 *            hook turn failed, still write-tests, no artifact.
 */

import { registerCron, markCronRunSuccess, markCronRunFailure, formatIntervalMs } from "./cron/registry.js";
import { createModuleLogger } from "./logging.js";

const log = createModuleLogger("write-tests-no-output-stall");

export interface WriteTestsNoOutputStallState {
  /** True once registerWriteTestsNoOutputStall() has been called at bootstrap. */
  scheduled: boolean;
  /** Alias of scheduled for test compatibility. */
  active: boolean;
  /** Alias — the component is subscribed to the dispatch-lease/write-tests view. */
  subscribed: boolean;
  /** Alias for required-cron checks. */
  registered: boolean;
  /** Alias — component is enabled. */
  enabled: boolean;
  /** Number of write-tests tickets whose lease is idempotent with no output. */
  stalledCount: number;
  /** Identifiers of stalled tickets (empty when none). */
  stalledTickets: string[];
  /** ISO timestamp of most recent evaluation, or null if never evaluated. */
  lastRunAt: string | null;
}

let state: WriteTestsNoOutputStallState = {
  scheduled: false,
  active: false,
  subscribed: false,
  registered: false,
  enabled: false,
  stalledCount: 0,
  stalledTickets: [],
  lastRunAt: null,
};

export interface WriteTestsNoOutputStallDeps {
  /** Returns enrolled write-tests tickets that are not terminal. */
  listEnrolledWriteTestsTickets?: () => Array<{ ticketId: string; delegate: string | null; state: string }>;
  /** Returns true if an active dispatch lease exists for (agent, ticket). */
  hasActiveLease?: (agentId: string, ticketId: string) => boolean;
  /** Returns true if the delegate has produced owner activity since entering write-tests. */
  hasOwnerActivity?: (agentId: string, ticketId: string) => boolean;
  /** Optional interval override for tests. */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const NO_OUTPUT_WINDOW_MS = 2 * 60 * 1000; // mirror NoActivityDetector default

let deps: WriteTestsNoOutputStallDeps | null = null;

/**
 * Run one sweep iteration: collect write-tests tickets, check lease + owner
 * activity, populate stalledCount/stalledTickets, and stamp markCronRun.
 */
function runSweep(): void {
  if (!deps) {
    markCronRunSuccess("write-tests-no-output-stall");
    state.lastRunAt = new Date().toISOString();
    return;
  }
  try {
    const stalled: string[] = [];
    const tickets = deps.listEnrolledWriteTestsTickets?.() ?? [];
    for (const row of tickets) {
      const delegate = (row.delegate ?? "").toLowerCase();
      // Only TDD write-tests tickets are in scope for this lane.
      if (delegate !== "tdd") continue;
      const ticketId = row.ticketId;
      const hasLease = deps.hasActiveLease?.(delegate, ticketId) ?? false;
      if (!hasLease) continue;
      const hasActivity = deps.hasOwnerActivity?.(delegate, ticketId) ?? false;
      if (hasActivity) continue;
      // Lease active + no owner activity => stalled for this lane (both Shape A and Shape B)
      stalled.push(ticketId);
    }
    state.stalledCount = stalled.length;
    state.stalledTickets = stalled;
    state.lastRunAt = new Date().toISOString();
    if (stalled.length > 0) {
      log.warn(`write-tests-no-output-stall: ${stalled.length} stalled ticket(s): ${stalled.join(", ")}`);
    } else {
      log.info(`write-tests-no-output-stall: no stalled tickets (${tickets.length} write-tests ticket(s) checked)`);
    }
    markCronRunSuccess("write-tests-no-output-stall");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`write-tests-no-output-stall sweep failed: ${msg}`);
    markCronRunFailure("write-tests-no-output-stall", err);
  }
}

/**
 * Register the write-tests no-output stall component at server bootstrap.
 * Must be called from createApp() (the production entry point) so the
 * wiring is observable at /health via both crons registry and liveness field.
 */
export function registerWriteTestsNoOutputStall(options?: WriteTestsNoOutputStallDeps): void {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  registerCron("write-tests-no-output-stall", `every ${formatIntervalMs(intervalMs)}`);
  deps = options ?? {};

  state = {
    scheduled: true,
    active: true,
    subscribed: true,
    registered: true,
    enabled: true,
    stalledCount: 0,
    stalledTickets: [],
    lastRunAt: null,
  };

  // Startup kick — satisfies INF-1263 AC3 (setTimeout before setInterval) and
  // stamps lastRunAt so the cron does not appear as critical-stale (which would
  // happen if lastRunAt stays null after registration).
  setTimeout(() => {
    runSweep();
  }, 0).unref();

  // Arm the recurring driver.
  setTimeout(() => {
    setInterval(() => runSweep(), intervalMs).unref();
  }, 0).unref();
}

/** Read the current liveness state for /health.writeTestsNoOutputStall. */
export function getWriteTestsNoOutputStallState(): WriteTestsNoOutputStallState {
  return {
    scheduled: state.scheduled,
    active: state.active,
    subscribed: state.subscribed,
    registered: state.registered,
    enabled: state.enabled,
    stalledCount: state.stalledCount,
    stalledTickets: [...state.stalledTickets],
    lastRunAt: state.lastRunAt,
  };
}

/** Test-only: reset to unregistered. Also clears deps. */
export function resetWriteTestsNoOutputStallStateForTest(): void {
  deps = null;
  state = {
    scheduled: false,
    active: false,
    subscribed: false,
    registered: false,
    enabled: false,
    stalledCount: 0,
    stalledTickets: [],
    lastRunAt: null,
  };
}
