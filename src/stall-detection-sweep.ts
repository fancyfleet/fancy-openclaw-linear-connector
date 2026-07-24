/**
 * INF-314 — Stall detection sweep cron.
 *
 * Registers a periodic cron ("stall-liveness-sweep") that:
 *   - Reads all tracked LivenessRecords from the store
 *   - Classifies each via classifyStall
 *   - For stalled tickets with redispatched=true (first stall): calls redispatch
 *   - For stalled tickets with escalated=true (second stall): fires an alert
 *   - Marks the cron run in the registry (AI-1808 liveness)
 *
 * Following the pattern of first-action-watchdog.ts:
 *   registerStallDetectionSweepCron({ authToken, listTickets, redispatch })
 *
 * I/O is injected so the sweep logic is unit-tested in isolation; index.ts
 * wires the real data plane.
 */

import { registerCron, formatIntervalMs, markCronRun } from "./cron/registry.js";
import {
  markStallDetectionScheduled,
  getAllLivenessRecords,
  markRedispatched,
  removeLivenessRecord,
  getAckTimeoutMs,
  getProgressTimeoutMs,
} from "./stall-detection-state.js";
import { classifyStall, type StallClassifierConfig } from "./stall-detection.js";

const CRON_NAME = "stall-liveness-sweep";
const DEFAULT_CADENCE_MS = 60_000; // every 1 minute

/** A stalled ticket notification payload (sent to the notify callback). */
export interface StallAlert {
  ticketId: string;
  reason: string;
  escalated: boolean;
  delegate: string | null;
  state: string;
}

/** Options for registering the stall detection sweep cron. */
export interface StallDetectionSweepOptions {
  /** Linear auth token (unused directly, but passed through for consistency). */
  authToken?: string;
  /** Optional: fetch liveness records from an external source. Defaults to the store. */
  listTickets?: () => Promise<Array<{
    ticketId: string;
    delegate: string | null;
    state: string;
    dispatchedAt: number;
    ackedAt?: number;
    lastProgressAt?: number;
    redispatched: boolean;
  }>>;
  /** Called when a stalled ticket should be redispatched (first stall). */
  redispatch?: (payload: { ticketId: string; reason: string }) => Promise<void>;
  /** Called when a stalled ticket should be escalated (second stall after redispatch). */
  notify?: (alert: StallAlert) => void;
  /** Override cadence (default: 60s). */
  cadenceMs?: number;
}

/** Result of a single stall detection sweep. */
export interface StallSweepResult {
  scanned: number;
  stalled: number;
  redispatched: number;
  escalated: number;
  errors: unknown[];
}

/**
 * Run a single stall detection sweep over all tracked liveness records.
 * Exported so it can be unit-tested or invoked manually.
 */
export async function runStallDetectionSweep(
  opts: StallDetectionSweepOptions,
): Promise<StallSweepResult> {
  const config: StallClassifierConfig = {
    ackTimeoutMs: getAckTimeoutMs(),
    progressTimeoutMs: getProgressTimeoutMs(),
  };

  const result: StallSweepResult = {
    scanned: 0,
    stalled: 0,
    redispatched: 0,
    escalated: 0,
    errors: [],
  };

  // Get records: either from injected listTickets or from the store.
  let records;
  if (opts.listTickets) {
    try {
      records = await opts.listTickets();
    } catch (err) {
      result.errors.push(err);
      return result;
    }
  } else {
    records = getAllLivenessRecords();
  }

  for (const record of records) {
    result.scanned += 1;
    try {
      const stallResult = classifyStall(record, config);

      if (!stallResult.stalled) continue;

      result.stalled += 1;

      if (stallResult.redispatched) {
        // First stall: auto-redispatch the ticket.
        markRedispatched(record.ticketId);
        result.redispatched += 1;
        if (opts.redispatch) {
          await opts.redispatch({
            ticketId: record.ticketId,
            reason: stallResult.reason ?? "unknown",
          });
        }
      } else if (stallResult.escalated) {
        // Second stall: escalate — don't loop silently.
        result.escalated += 1;
        if (opts.notify) {
          opts.notify({
            ticketId: record.ticketId,
            reason: stallResult.reason ?? "unknown",
            escalated: true,
            delegate: record.delegate,
            state: record.state,
          });
        }
      }
    } catch (err) {
      result.errors.push(err);
    }
  }

  return result;
}

/**
 * Register the stall detection sweep as a periodic cron.
 * Called from the production entry point (index.ts) so the sweep is armed
 * at server bootstrap — not merely importable dead code.
 *
 * Adds a 'stall-liveness-sweep' registry entry (feeds /health.crons) and
 * marks the stall detection scheduled for liveness.
 */
export function registerStallDetectionSweepCron(
  opts: StallDetectionSweepOptions,
): ReturnType<typeof setInterval> {
  const cadenceMs = opts.cadenceMs ?? DEFAULT_CADENCE_MS;
  registerCron(CRON_NAME, `every ${formatIntervalMs(cadenceMs)}`);
  markStallDetectionScheduled();

  const timer = setInterval(() => {
    runStallDetectionSweep(opts)
      .then((result) => {
        if (result.stalled > 0) {
          // Minimal logging — the notify callback handles alerting.
        }
        markCronRun(CRON_NAME);
      })
      .catch((err) => {
        console.error(`[${CRON_NAME}] sweep failed:`, err);
      });
  }, cadenceMs);

  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
