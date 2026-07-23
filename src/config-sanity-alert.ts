/**
 * AI-2619 — Config-sanity watchdog alert consumer.
 *
 * Reads the latest `config-sanity-watchdog.json` (written by the
 * `config-sanity-watchdog.py` Python cron on Nakazawa), parses findings, and
 * routes each through the AlertBus with a stable dedup key.
 *
 * Dedup behavior:
 *  - `git-remote-liveness` PUSH-DEAD findings (severity=critical) are keyed on
 *    `git-remote-liveness:critical:AI-2189` — the root-cause ticket, not the
 *    per-repo finding set — so an unchanged root cause does not page repeatedly.
 *  - All other findings use `{check}:{severity}` as their dedup key.
 *  - INF-458 item 4: a finding whose content hash is unchanged from the
 *    previous cycle for the same dedup key always folds into the existing
 *    burst, so the 30-min cron cadence outrunning the 15-min critical
 *    suppression window no longer spawns a fresh alert row every cycle. A
 *    genuine content change still starts a fresh, visible burst.
 *
 * Category A suppression (INF-458 item 2, from INF-454 triage): checks that
 * are benign noise or check-authoring bugs rather than real signal —
 * `retrieval-canary` info findings and `gen-token` never reach the alert
 * bus; `heartbeat-model-override` is downgraded to info; `stale-sessions`
 * uses a weekly-digest suppression window instead of the 30-min cadence.
 *
 * Liveness: exported `getConfigSanityAlertLiveness()` returns the last-read
 * timestamp, finding count, and a top-10 findings summary, surfaced at
 * /health.configSanityAlert. `getConfigSanityFindings()` returns the full
 * current finding list (including category-A-suppressed ones) for the
 * `/admin/api/config-sanity` findings-detail route (INF-458 item 1).
 *
 * Design: docs/alert-bus.md, lifecycle-os/infra/config-sanity-watchdog.md
 * (Alert routing §).
 */

import { componentLogger, createLogger } from "./logger.js";
import { notify, type AlertSeverity } from "./alerts/alert-bus.js";
import { registerCron, formatIntervalMs, markCronRun } from "./cron/registry.js";
import fs from "node:fs";
import { createHash } from "node:crypto";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "config-sanity-alert");

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Path to the latest config-sanity-watchdog JSON output.
 * Default: ~/.openclaw/logs/config-sanity-watchdog.json
 * Override: CONFIG_SANITY_WATCHDOG_PATH env var.
 */
const DEFAULT_WATCHDOG_JSON_PATH = (
  process.env.HOME
    ? `${process.env.HOME}/.openclaw/logs/config-sanity-watchdog.json`
    : "/home/fancymatt/.openclaw/logs/config-sanity-watchdog.json"
);
export const WATCHDOG_JSON_PATH = process.env.CONFIG_SANITY_WATCHDOG_PATH ?? DEFAULT_WATCHDOG_JSON_PATH;

/** Dedup key for `git-remote-liveness` critical findings (all PUSH-DEAD → AI-2189). */
const GIT_REMOTE_LIVENESS_DEDUP_KEY = "git-remote-liveness:critical:AI-2189";

/**
 * AI-2335: secrets in history are persistent and tracked.
 * Deduping them together prevents noise when the blob list shifts.
 */
const PUSHED_HISTORY_SECRET_DEDUP_KEY = "pushed-history-secret:critical:AI-2335";

/** Dedup key for transcript secrets. */
const AGENT_TRANSCRIPT_SECRET_DEDUP_KEY = "agent-transcript-secret:critical";

/** Default sweep cadence: 30 minutes (matches the watchdog's own cadence). */
const DEFAULT_INTERVAL_MS = 30 * 60_000;

/**
 * INF-458 item 4: the severity-based suppression window (15m critical / 1h
 * warning / 6h info) is narrower than the 30-min cron cadence, so an
 * unchanged finding used to escape the window and spawn a fresh alert row
 * every cycle. When a finding's content hash is identical to the previous
 * cycle's for the same dedup key, we pass this effectively-unbounded window
 * so the occurrence always folds into the existing burst. A content change
 * resets the effective window to the normal severity default (or a
 * check-specific override below), so a genuinely new finding still starts
 * a fresh, visible burst.
 */
const CONTENT_UNCHANGED_SUPPRESS_WINDOW_MS = Number.MAX_SAFE_INTEGER;

/** INF-458 item 2: stale-sessions housekeeping moves to a weekly digest cadence. */
const STALE_SESSIONS_SUPPRESS_WINDOW_MS = 7 * 24 * 60 * 60_000;

// ── Types ───────────────────────────────────────────────────────────────

export interface WatchdogFinding {
  /** Check slug, e.g. "git-remote-liveness", "config-json". */
  check: string;
  /** Severity: "critical", "warning", "info". */
  severity: string;
  /** Human-readable finding message. */
  message: string;
  /** Dedup key from the JSON (not used — we compute our own). */
  dedupe?: string;
  /** Optional playbook slug. */
  playbook?: string;
  /** Optional root-cause ticket reference. */
  ticket?: string;
  /** Optional extra detail. */
  detail?: Record<string, unknown>;
}

export interface WatchdogOutput {
  /** True when no critical findings are present. */
  ok: boolean;
  /** Array of findings. */
  findings: WatchdogFinding[];
  /** ISO timestamp of the watchdog run. */
  timestamp?: string;
  /** Optional list of checks that ran. */
  checks_run?: string[];
}

export interface ConfigSanityAlertLiveness {
  /** True when the component is armed (timer scheduled). */
  scheduled: boolean;
  /** ISO timestamp of the last successful read of watchdog JSON, or null. */
  lastReadAt: string | null;
  /** Number of findings forwarded from the last read. */
  lastFindingCount: number | null;
  /** ISO timestamp of the last alert fired, or null. */
  lastAlertAt: string | null;
  /** Top findings for visibility (limit 10). */
  topFindings?: { check: string; severity: string; message: string }[];
}

// ── Singleton state ─────────────────────────────────────────────────────

let scheduled = false;
let lastReadAt: string | null = null;
let lastFindingCount: number | null = null;
let lastAlertAt: string | null = null;
let lastFindings: WatchdogFinding[] = [];

/** INF-458 item 4: previous cycle's content hash per dedup key. */
let lastContentHashByDedupKey = new Map<string, string>();

// ── Dedup key computation ───────────────────────────────────────────────

/**
 * Compute the dedup key for a watchdog finding.
 *
 * Special case: `git-remote-liveness` critical findings (PUSH-DEAD) are
 * keyed on `git-remote-liveness:critical:AI-2189` — the root-cause ticket,
 * not the per-repo finding set. This prevents the dedup signature from
 * shifting when the repo roster changes between runs.
 *
 * All other findings use `{check}:{severity}`.
 */
export function dedupKeyForFinding(finding: WatchdogFinding): string {
  if (finding.check === "git-remote-liveness" && finding.severity === "critical") {
    return GIT_REMOTE_LIVENESS_DEDUP_KEY;
  }
  if (finding.check === "pushed-history-secret") {
    return PUSHED_HISTORY_SECRET_DEDUP_KEY;
  }
  if (finding.check === "agent-transcript-secret") {
    return AGENT_TRANSCRIPT_SECRET_DEDUP_KEY;
  }

  // AI-2617: git-remote-https-host alerts are actionable per-repo.
  if (finding.check === "git-remote-https-host" && finding.detail?.repo) {
    return `git-remote-https-host:${finding.severity}:${finding.detail.repo}`;
  }

  return `${finding.check}:${finding.severity}`;
}

/**
 * INF-458 item 4: stable content hash for a finding, used to detect whether
 * a dedup key's occurrence is a genuine repeat (same content) or a change
 * (different message/detail) across cron cycles.
 */
export function contentHashForFinding(finding: WatchdogFinding): string {
  const stable = JSON.stringify({
    check: finding.check,
    severity: finding.severity,
    message: finding.message,
    detail: finding.detail ?? null,
  });
  return createHash("sha256").update(stable).digest("hex");
}

// ── JSON reader ─────────────────────────────────────────────────────────

/**
 * Read and parse the latest config-sanity-watchdog.json.
 * Returns null when the file doesn't exist or is unparseable.
 *
 * Separated for testability: tests can mock this to exercise alert routing.
 */
export function readWatchdogJson(path?: string): WatchdogOutput | null {
  const resolvedPath = path ?? WATCHDOG_JSON_PATH;
  try {
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as WatchdogOutput;

    // Normalise: ensure findings is an array.
    if (!Array.isArray(parsed.findings)) {
      parsed.findings = [];
    }
    return parsed;
  } catch (err) {
    // ENOENT is expected when the watchdog hasn't run yet on a fresh host.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    log.warn(`failed to parse watchdog JSON at ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Alert firing ───────────────────────────────────────────────────────

/**
 * Process a single watchdog output: fire alerts for each finding and update
 * liveness state.
 *
 * Each finding's dedup key is computed via `dedupKeyForFinding`. Only
 * critical and warning severity findings fire alerts (info findings are
 * logged but not alerted, consistent with the existing watchdog severity
 * contract).
 */
export function processWatchdogOutput(output: WatchdogOutput, now = new Date()): void {
  const findings = output.findings ?? [];
  const nowIso = now.toISOString();
  lastReadAt = nowIso;
  lastFindingCount = findings.length;
  lastFindings = findings;

  for (const finding of findings) {
    const dedupKey = dedupKeyForFinding(finding);
    let severity: AlertSeverity = finding.severity === "critical" || finding.severity === "warning"
      ? finding.severity
      : "info";

    // INF-458 item 2 / category A — benign, check-authoring-bug, or noisy
    // findings that shouldn't page at all or shouldn't page at full severity.
    // AI-2189/2335/2617-style dedup keys above are for findings that ARE
    // real and just need folding; these are suppressed/downgraded instead.

    // retrieval-canary's own sample title says "not a miss" — a
    // check-authoring bug, not a benign finding worth suppressing after
    // the fact. Don't call notify() at all.
    if (finding.check === "retrieval-canary" && severity === "info") {
      continue;
    }
    // gen-token: cross-container ptrace restriction artifact, not a signal.
    // Log-only, never hits the alert bus.
    if (finding.check === "gen-token") {
      log.info(`config-sanity: gen-token finding suppressed (log-only, expected ptrace restriction): ${finding.message}`);
      continue;
    }
    // heartbeat-model-override: agents intentionally on non-default
    // heartbeat models is expected, not a misconfig. Downgrade to info.
    if (finding.check === "heartbeat-model-override") {
      severity = "info";
    }

    // INF-458 item 4 — content-hash dedup. Compute this cycle's content hash
    // and compare against the previous cycle's hash for the same dedup key.
    // Unchanged content always folds into the existing burst (regardless of
    // how much cron-cadence time has elapsed); changed content falls back to
    // the normal severity-based window and can start a fresh, visible burst.
    const contentHash = contentHashForFinding(finding);
    const contentUnchanged = lastContentHashByDedupKey.get(dedupKey) === contentHash;
    lastContentHashByDedupKey.set(dedupKey, contentHash);

    let suppressWindowMs: number | undefined;
    if (finding.check === "git-remote-liveness" && severity === "critical") {
      // git-remote-liveness critical uses a 6h suppression window (AI-2620)
      // so the 30-min cron cadence doesn't create fresh pushes every cycle.
      suppressWindowMs = 6 * 60 * 60_000;
    } else if (finding.check === "stale-sessions") {
      // Routine housekeeping — weekly digest instead of a 30-min alert.
      suppressWindowMs = STALE_SESSIONS_SUPPRESS_WINDOW_MS;
    } else if (contentUnchanged) {
      suppressWindowMs = CONTENT_UNCHANGED_SUPPRESS_WINDOW_MS;
    }

    notify({
      severity,
      source: "config-sanity",
      title: `[${finding.check}] ${finding.message}`,
      detail: finding.detail ?? undefined,
      ticket: finding.ticket ?? undefined,
      dedupKey,
      suppressWindowMs,
    });

    if (severity === "critical" || severity === "warning") {
      lastAlertAt = nowIso;
    }
  }
}

/**
 * Full current finding list (not just the top-10 liveness summary),
 * for the /admin/api/config-sanity findings-detail route (INF-458 item 1).
 */
export function getConfigSanityFindings(): WatchdogFinding[] {
  return lastFindings;
}

/**
 * Run a single cycle: read the watchdog JSON and fire alerts.
 * Returns the number of findings processed (0 if no file or parse error).
 */
export function runCycle(path?: string): number {
  const output = readWatchdogJson(path);
  if (!output) {
    return 0;
  }
  processWatchdogOutput(output);
  return output.findings?.length ?? 0;
}

// ── Liveness ────────────────────────────────────────────────────────────

export function getConfigSanityAlertLiveness(): ConfigSanityAlertLiveness {
  return {
    scheduled,
    lastReadAt,
    lastFindingCount,
    lastAlertAt,
    topFindings: lastFindings.slice(0, 10).map(f => ({
      check: f.check,
      severity: f.severity,
      message: f.message,
    })),
  };
}

// ── Test-only reset ─────────────────────────────────────────────────────

export function _resetConfigSanityAlertForTests(): void {
  scheduled = false;
  lastReadAt = null;
  lastFindingCount = null;
  lastAlertAt = null;
  lastFindings = [];
  lastContentHashByDedupKey = new Map();
}

// ── Cron registration ───────────────────────────────────────────────────

/**
 * Register the config-sanity alert consumer as an in-process recurring job.
 *
 * Interval: 30 minutes (matching the 30-min watchdog cadence).
 * The timer is unref'd so it won't block graceful shutdown.
 *
 * Registration is unconditional (the component always runs when the
 * connector is alive). If the watchdog JSON file doesn't exist yet, the
 * cycle is a no-op.
 */
export function registerConfigSanityAlertCron(): void {
  if (scheduled) {
    log.warn("config-sanity-alert: already scheduled — ignoring duplicate register() call");
    return;
  }

  const intervalMs = DEFAULT_INTERVAL_MS;
  registerCron("config-sanity-alert", `every ${formatIntervalMs(intervalMs)}`);
  scheduled = true;

  // Run the first cycle immediately, then on the interval.
  setImmediate(() => {
    try {
      const count = runCycle();
      if (count > 0) {
        log.info(`config-sanity-alert: initial cycle processed ${count} finding(s)`);
      } else {
        log.info("config-sanity-alert: initial cycle — no findings (file not available or empty)");
      }
    } catch (err) {
      log.error(`config-sanity-alert: initial cycle threw: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      markCronRun("config-sanity-alert");
    }
  });

  const timer = setInterval(() => {
    try {
      runCycle();
    } catch (err) {
      log.error(`config-sanity-alert: cycle threw: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      markCronRun("config-sanity-alert");
    }
  }, intervalMs);
  timer.unref();

  log.info(`config-sanity-alert: scheduled every ${formatIntervalMs(intervalMs)} (path=${WATCHDOG_JSON_PATH})`);
}
