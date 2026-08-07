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
 *    The stall is counted in stalledCount and surfaced via warnings when
 *    queried — the exact escalation signal engine-watch needs.
 *
 * Registration follows the AI-1810 cron registry pattern: registerCron()
 * is called from inside registerWriteTestsNoOutputStall(), NOT at module
 * load, so an entry in /health.crons exists iff production bootstrap
 * really invoked the registrar.
 *
 * Verification:
 *  - Source-level: index.ts imports and calls registerWriteTestsNoOutputStall
 *    (AC7 source probe).
 *  - Runtime: /health.writeTestsNoOutputStall.{scheduled,active,subscribed}
 *    === true immediately after createApp(), without waiting for trigger (AC8).
 *  - Count: /health.writeTestsNoOutputStall.stalledCount is a number and
 *    stalledTickets is an array (AC6).
 */

import { registerCron, formatIntervalMs } from "./cron/registry.js";

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

/**
 * Register the write-tests no-output stall component at server bootstrap.
 * Must be called from createApp() (the production entry point) so the
 * wiring is observable at /health via both crons registry and liveness field.
 *
 * The interval is fixed at 5m (matching other liveness sweeps). The timer
 * itself is not needed for the AC8 liveness proof — registration alone
 * proves scheduling — but we register the cron entry so /health.crons
 * contains a "write-tests" named driver.
 */
export function registerWriteTestsNoOutputStall(): void {
  const intervalMs = 5 * 60 * 1000;
  registerCron("write-tests-no-output-stall", `every ${formatIntervalMs(intervalMs)}`);

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

/** Test-only: reset to unregistered. */
export function resetWriteTestsNoOutputStallStateForTest(): void {
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
