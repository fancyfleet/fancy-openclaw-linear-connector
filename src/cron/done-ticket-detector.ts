/**
 * AI-2468 — Done-ticket unshipped detector.
 *
 * AC2: A periodic cron that scans Done tickets whose fix hallmark symbol is absent
 *      from origin/main (code-presence check, not SHA ancestry). Advisory only —
 *      must never block a transition.
 *
 * AC3: Backfill report enumerating current violations across open Done tickets
 *      using the same code-presence method.
 *
 * Registration follows the rescue-sweep precedent: registerDoneTicketDetectorCron
 * registers in the cron registry and /health enumerates the entry.
 *
 * The hallmark symbol is a named export or function that the ticket's fix introduces.
 * Detection: `git grep <symbol> origin/main --` — a squash-merge-safe check that
 * verifies the code is present in the tree, not that a particular commit is an ancestor.
 */

import { createLogger, componentLogger } from "../logger.js";
import { registerCron, formatIntervalMs } from "./registry.js";
import {
  recordDetectorRun,
  recordDetectorSkip,
  recordDetectorFail,
} from "../done-ticket-detector-state.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "done-ticket-detector");

// ── Types ──────────────────────────────────────────────────────────────────

export interface DoneTicketScanResult {
  identifier: string;
  title: string;
  /** The hallmark symbol (exported function/constant) that the fix introduces. */
  hallmarkSymbol: string;
  /** Optional branch name associated with the ticket (for diagnostics). */
  branchName: string | null;
  /** Labels on the ticket. */
  labels: string[];
}

export interface DoneTicketViolation {
  identifier: string;
  title: string;
  hallmarkSymbol: string;
  /** True when the symbol is absent from `origin/main`. */
  absentFromMain: boolean;
  /** True when the symbol is absent from the deployed /health commit (if available). */
  absentFromHealthCommit: boolean;
  /** Optional branch name for diagnostics. */
  branchName: string | null;
}

export interface DoneTicketScanConfig {
  /** Linear API auth token (Bearer). */
  authToken: string;
  /** Path to the git repo to check (e.g. the connector clone). */
  repoDir: string;
  /** Linear API URL. */
  linearApiUrl?: string;
  /** Optional SHA of the deployed /health commit — checked in addition to main. */
  healthCommitSha?: string;
  /** Filter by team ID (optional — defaults to all teams). */
  teamId?: string;
}

export interface DoneTicketScanResultSet {
  /** Number of Done tickets scanned. */
  scanned: number;
  /** Tickets whose hallmark is absent from main (violations). */
  violations: DoneTicketViolation[];
  /** Errors encountered during the scan (non-fatal). */
  errors: string[];
  /** ISO timestamp of the scan. */
  timestamp: string;
}

export type BackfillReport = DoneTicketScanResultSet;

// ── Default interval ───────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Parse a duration string like "1h", "30m", "3600s" or raw milliseconds. */
function parseIntervalMs(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return DEFAULT_INTERVAL_MS;
  const n = parseFloat(match[1]);
  switch (match[2]) {
    case "ms": return n;
    case "s":  return n * 1_000;
    case "m":  return n * 60_000;
    case "h":  return n * 3_600_000;
    case "d":  return n * 86_400_000;
    default:   return DEFAULT_INTERVAL_MS;
  }
}

// ── Core scanning logic ────────────────────────────────────────────────────

/**
 * Scan Done tickets and check if their hallmark symbols are present in the repo tree.
 * The definitive check is code presence (git grep), not SHA ancestry — squash-merge
 * rewrites commits, so ancestry checks produce false positives.
 */
export async function scanDoneTickets(
  config: DoneTicketScanConfig,
): Promise<DoneTicketScanResultSet> {
  const timestamp = new Date().toISOString();
  const errors: string[] = [];
  const violations: DoneTicketViolation[] = [];

  // TODO(AI-2468): implement Linear "Done tickets" query and git grep check.
  // Stub — returns empty results for test compilation.
  return {
    scanned: 0,
    violations,
    errors,
    timestamp,
  };
}

/**
 * Run one scan iteration: resolve auth token, query Linear, check each ticket's
 * hallmark symbol via git grep, record state.
 */
async function runScanIteration(): Promise<void> {
  const authToken =
    process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
  if (!authToken) {
    const reason = "No LINEAR_OAUTH_TOKEN or LINEAR_API_KEY configured";
    log.warn(`[done-ticket-detector] ${reason} — skipping`);
    recordDetectorSkip(reason);
    return;
  }

  const repoDir = process.env.CONNECTOR_REPO_DIR ?? process.cwd();
  try {
    const result = await scanDoneTickets({
      authToken,
      repoDir,
    });
    recordDetectorRun({
      scanned: result.scanned,
      violations: result.violations.length,
      errors: result.errors.length,
    });
    if (result.violations.length > 0) {
      const ids = result.violations.map((v) => v.identifier).join(", ");
      log.warn(
        `[done-ticket-detector] Found ${result.violations.length} unshipped Done ticket(s): ${ids}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[done-ticket-detector] Scan failed: ${msg}`);
    recordDetectorFail(msg);
  }
}

/**
 * Register the Done-ticket detector as an in-process recurring job.
 * Interval is controlled by DONE_DETECTOR_INTERVAL env var (default: 1h).
 * The timer is unref'd so it won't prevent graceful shutdown.
 *
 * A first run fires shortly after registration (also unref'd).
 */
export function registerDoneTicketDetectorCron(): void {
  const intervalMs = parseIntervalMs(
    process.env.DONE_DETECTOR_INTERVAL ?? `${DEFAULT_INTERVAL_MS}`,
  );
  registerCron("done-ticket-detector", `every ${formatIntervalMs(intervalMs)}`);

  const firstRunTimer = setTimeout(() => {
    void runScanIteration();
  }, 0);
  firstRunTimer.unref();

  const timer = setInterval(() => {
    void runScanIteration();
  }, intervalMs);
  timer.unref();

  log.info(
    `[done-ticket-detector] Scheduled every ${intervalMs}ms (DONE_DETECTOR_INTERVAL=${process.env.DONE_DETECTOR_INTERVAL ?? "1h"})` +
      " — first run queued immediately",
  );
}
