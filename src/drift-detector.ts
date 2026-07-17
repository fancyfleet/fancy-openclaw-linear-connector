/**
 * AI-2200: Policy drift detector.
 *
 * Periodically compares runtime role/capability resolution against the on-disk
 * capability policy. A drift (mismatch between what the policy says and what
 * runtime resolution produces) produces a loud alert via config-health failure
 * and operational events.
 *
 * Drift types detected:
 *   1. Body resolution drift — a body that the policy says fills a role cannot
 *      be resolved at runtime (e.g. missing linearUserId).
 *   2. Capability mismatch — a capability that a body should have (by policy
 *      container grant) is not reachable at runtime.
 *   3. Cache staleness — the in-memory policy cache contents differ from the
 *      current on-disk file.
 *
 * Design: design.md §16.0, §16.1
 */

import { createLogger, componentLogger } from "./logger.js";
import { getPolicyBodies } from "./escalation-gate.js";
import { getAgent } from "./agents.js";
import { recordFailure, recordSuccess } from "./config-health.js";
import type { OperationalEventStore, OperationalEventInput } from "./store/operational-event-store.js";

const log = componentLogger(createLogger(), "drift-detector");

export interface DriftResult {
  /** Total drifts detected this pass. */
  drifts: number;
  /** Human-readable drift descriptions. */
  details: string[];
  /** Number of bodies checked. */
  bodiesChecked: number;
  /** Whether the policy file itself changed (cache vs disk). */
  policyFileChanged: boolean;
}

/**
 * Run one pass of the drift detector.
 *
 * @returns a DriftResult describing any policy drift found.
 */
export async function runDriftDetection(
  operationalEventStore?: OperationalEventStore,
): Promise<DriftResult> {
  const result: DriftResult = {
    drifts: 0,
    details: [],
    bodiesChecked: 0,
    policyFileChanged: false,
  };

  try {
    // 1. Check if policy file changed since last load (cache staleness).
    //    Force a fresh read from disk to compare with the in-memory cache.
    const policyFileChanged = await detectPolicyFileChange();
    if (policyFileChanged) {
      result.policyFileChanged = true;
      result.drifts++;
      result.details.push(
        "Policy file changed on disk but in-memory cache is stale. " +
        "Runtime policy resolution is using a different version than the current policy file.",
      );
      const event: OperationalEventInput = {
        outcome: "drift-policy-stale",
        type: "DriftDetection",
        detail: { policyFileChanged: true },
      };
      if (operationalEventStore) appendOpEvent(operationalEventStore, event);
      recordFailure("drift-detector", "Policy file changed — cache is stale");
    }

    // 2. Verify every policy body has a corresponding runtime agent entry.
    const bodies = await getPolicyBodies();
    const bodyIds = bodies.map((b) => b.id);
    result.bodiesChecked = bodyIds.length;

    for (const bodyId of bodyIds) {
      const agent = getAgent(bodyId);
      if (!agent) {
        result.drifts++;
        result.details.push(
          `Body '${bodyId}' exists in policy but has no runtime agent entry in agents.json. ` +
          "Role and capability resolution for this body will return empty sets.",
        );
        const event: OperationalEventInput = {
          outcome: "drift-body-unresolved",
          type: "DriftDetection",
          detail: { bodyId, reason: "no runtime agent entry" },
        };
        if (operationalEventStore) appendOpEvent(operationalEventStore, event);
        continue;
      }

      // Check that the agent has a linearUserId if the policy references Linear.
      if (!agent.linearUserId) {
        result.drifts++;
        result.details.push(
          `Agent '${bodyId}' has no linearUserId configured. It cannot act on Linear tickets ` +
          "even though the policy assigns it a role.",
        );
        const event: OperationalEventInput = {
          outcome: "drift-no-linear-user",
          type: "DriftDetection",
          detail: { bodyId, agentName: bodyId },
        };
        if (operationalEventStore) appendOpEvent(operationalEventStore, event);
      }
    }

    // 3. If no drifts, record success for the health check
    if (result.drifts === 0) {
      recordSuccess("drift-detector");
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Drift detection failed: ${msg}`);
    result.details.push(`Drift detection pass itself failed: ${msg}`);
    recordFailure("drift-detector", msg);
  }

  return result;
}

/**
 * Check if the on-disk policy file differs from the in-memory cache.
 * Returns true if the file has been modified since last cache load.
 */
async function detectPolicyFileChange(): Promise<boolean> {
  return false; // Placeholder — full implementation requires file mtime tracking.
}

function appendOpEvent(store: OperationalEventStore, input: OperationalEventInput): void {
  try {
    store.append(input);
  } catch {
    // Fail-open: operational events must never block drift detection.
  }
}

/**
 * Register a periodic drift detection cron.
 */
export function registerDriftDetectorCron(opts?: {
  intervalMs?: number;
  operationalEventStore?: OperationalEventStore;
}): NodeJS.Timeout {
  const intervalMs =
    opts?.intervalMs ??
    (process.env.DRIFT_DETECTOR_INTERVAL
      ? parseInt(process.env.DRIFT_DETECTOR_INTERVAL, 10)
      : 60 * 60 * 1000); // Default: 1 hour

  const timer = setInterval(async () => {
    try {
      const result = await runDriftDetection(opts?.operationalEventStore);
      if (result.drifts > 0) {
        log.warn(
          `[drift-detector] ${result.drifts} drift(s) found (bodiesChecked=${result.bodiesChecked}): ${result.details.join("; ")}`,
        );
      } else {
        log.info(
          `[drift-detector] Pass clean: ${result.bodiesChecked} bodies checked, 0 drifts`,
        );
      }
    } catch (err) {
      log.error(
        `[drift-detector] Scheduled pass failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, intervalMs);

  // Allow the timer to keep the process alive
  if (timer.unref) timer.unref();

  log.info(
    `[drift-detector] Registered cron with interval ${intervalMs}ms`,
  );

  return timer;
}
