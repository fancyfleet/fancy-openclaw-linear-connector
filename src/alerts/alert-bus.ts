import { componentLogger, createLogger, type Logger } from "../logger.js";
import { AlertStore, defaultDedupKey, type AlertInput, type AlertSeverity } from "./alert-store.js";
import { sendThroughChain } from "./push-transports.js";
import { emitStreamTopic } from "../admin-stream.js";

export type { AlertInput, AlertSeverity };

/**
 * Alert pipeline overhaul — AI-2190.
 *
 * == State-change alerting ==
 *   - A "resolve" signal clears an active dedup_key.
 *   - resolve() pushes a "✓ CLEARED" notification; no log/store for the
 *     resolve itself (the original violation row is the record).
 *   - An active dedup_key that re-fires within the cooldown is suppressed.
 *     An active key that fires AFTER being resolved creates a NEW push
 *     (non-suppressed new burst).
 *
 * == Escalating cooldown (replaces fixed severity windows) ==
 *   - Each dedup_key independently escalates through cooldown tiers:
 *       Tier 0: no recent fires → immediate push
 *       Tier 1: 5 min  (first re-fire)
 *       Tier 2: 30 min
 *       Tier 3: 120 min
 *       Tier 4: 360 min
 *   - Resolution resets the cooldown to Tier 0.
 *   - Within a cooldown, the row's `count` still increments.
 *
 * == Daily digest ==
 *   - Pushes are segmented: severity "critical" and "warning" alerts fire
 *     individually (subject to cooldown+storm). "info" alerts and any
 *     dedup_key that has been firing for >6h consolidate into a daily digest.
 *   - The digest fires once per calendar day (America/Denver), containing a
 *     summary of all digest-eligible alerts.
 *
 * == Severity-priority push guarantee ==
 *   - Buffer all critical alerts during a configurable startup window.
 *   - Flush after the first successful push or when `flushStartupBuffer()`
 *     is called explicitly.
 *   - "empty agent roster" and similar startup-critical alerts never get lost.
 */

// ── Cooldown tiers (per dedup_key) ──────────────────────────────────────
const COOLDOWN_TIERS = [
  { label: "immediate", ms: 0 },
  { label: "tier1",     ms: 5 * 60_000 },
  { label: "tier2",     ms: 30 * 60_000 },
  { label: "tier3",     ms: 120 * 60_000 },
  { label: "tier4",     ms: 360 * 60_000 },
];

const TIER_LABELS = ["first fire", "1st re-fire", "2nd re-fire", "3rd re-fire", "chronic (6h+)"];

interface CooldownEntry {
  /** Last time this dedup_key was pushed (or resolved). */
  lastPushMs: number;
  /** Current cooldown tier index. Increments each re-fire, resets on resolve. */
  tier: number;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

const PUSH_BUDGET_WINDOW_MS = 15 * 60_000;

export interface AlertBusOptions {
  store?: AlertStore;
  log?: Logger;
  /** Override push transport (tests). Default posts through the transport chain. */
  pushFn?: (message: string) => Promise<string | void>;
  pushEnabled?: boolean;
  pushMinSeverity?: AlertSeverity;
  pushBudget?: number;
  now?: () => Date;
  /** Startup-buffer window in ms (default 30s). Alerts queued during this window are held. */
  startupBufferMs?: number;
}

function envBool(name: string, defaultVal: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultVal;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function envSeverity(name: string, defaultVal: AlertSeverity): AlertSeverity {
  const raw = (process.env[name] ?? "").toLowerCase();
  return raw === "info" || raw === "warning" || raw === "critical" ? raw : defaultVal;
}

async function gatewayPush(message: string): Promise<string> {
  return await sendThroughChain(message);
}

interface BufferedAlert {
  alert: AlertInput;
  dedupKey: string;
  rowId: number | null;
  atMs: number;
}

/**
 * The single funnel for "a human should know about this" (docs/alert-bus.md).
 *
 * notify() never throws and never blocks the caller beyond synchronous
 * log+store writes — it is safe to call from any error path. Sinks:
 *   log   — always
 *   store — always (alerts.db, the console's future event feed)
 *   push  — severity ≥ pushMinSeverity, cooldown-regulated, digest-eligible
 */
export class AlertBus {
  private store: AlertStore | null;
  private log: Logger;
  private pushFn: (message: string) => Promise<string | void>;
  private pushEnabled: boolean;
  private pushMinSeverity: AlertSeverity;
  private pushBudget: number;
  private pushTimestamps: number[] = [];
  private stormDigestSent = false;
  private suppressedDuringStorm = 0;
  private now: () => Date;

  // ── Cooldown state per dedup_key ─────────────────────────────────────
  private cooldowns = new Map<string, CooldownEntry>();

  // ── Active dedup_keys (for resolve tracking) ──────────────────────────
  private activeKeys = new Set<string>();

  // ── Daily digest state ────────────────────────────────────────────────
  private digestAlerts: Array<{ dedupKey: string; severity: AlertSeverity; source: string; title: string; count: number; firstAtMs: number }> = [];
  private digestScheduled = false;
  private lastDigestDay: string | null = null; // "YYYY-MM-DD" in America/Denver

  // ── Startup buffer ────────────────────────────────────────────────────
  private startupBuffer: BufferedAlert[] = [];
  private startupBufferUntilMs: number;
  private startupBufferFlushed = false;

  constructor(options: AlertBusOptions = {}) {
    this.log = options.log ?? componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "alert");
    let store: AlertStore | null = options.store ?? null;
    if (!store) {
      try {
        store = new AlertStore(process.env.JEST_WORKER_ID ? ":memory:" : undefined);
      } catch (err) {
        this.log.error(`alert store unavailable, degrading to log-only: ${err instanceof Error ? err.message : String(err)}`);
        store = null;
      }
    }
    this.store = store;
    this.pushFn = options.pushFn ?? gatewayPush;
    const inTestRun = Boolean(process.env.JEST_WORKER_ID);
    this.pushEnabled = options.pushEnabled ?? (envBool("ALERT_PUSH_ENABLED", true) && !inTestRun);
    this.pushMinSeverity = options.pushMinSeverity ?? envSeverity("ALERT_PUSH_MIN_SEVERITY", "warning");
    this.pushBudget = options.pushBudget ?? parseInt(process.env.ALERT_PUSH_BUDGET ?? "20", 10);
    this.now = options.now ?? (() => new Date());
    this.startupBufferUntilMs = this.now().getTime() + (options.startupBufferMs ?? 30_000);

    // Schedule the next digest check. Use a 1h cadence; the actual digest
    // fires at most once per calendar day.
    this.scheduleDigestCheck();
  }

  /**
   * Notify about a violation. Suppressed within cooldown; re-pushes after
   * cooldown expires with escalating tier; digest-eligible alerts batch.
   */
  notify(alert: AlertInput): void {
    try {
      this.notifyInner(alert);
    } catch (err) {
      this.log.error(`notify() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Signal that a previously-notified condition has CLEARED. Pushes a
   * resolve notice and resets the cooldown tier for this dedup_key.
   */
  resolve(alert: Pick<AlertInput, "source" | "title" | "agent" | "ticket" | "severity"> & { dedupKey?: string }): void {
    try {
      this.resolveInner(alert);
    } catch (err) {
      this.log.error(`resolve() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Flush the startup buffer. Called after push channel init is confirmed.
   * Sends all buffered criticals immediately (subject to budget+storm).
   */
  flushStartupBuffer(): void {
    if (this.startupBufferFlushed) return;
    this.startupBufferFlushed = true;
    const buffered = this.startupBuffer;
    this.startupBuffer = [];
    this.log.info(`flushing startup buffer: ${buffered.length} buffered alert(s)`);
    for (const b of buffered) {
      this.emitPush(b.alert, b.dedupKey, b.rowId, b.atMs);
    }
  }

  getStore(): AlertStore | null {
    return this.store;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private getCooldownWindow(key: string, nowMs: number): { suppress: boolean; tier: number; lastPushMs: number } {
    const entry = this.cooldowns.get(key);
    if (!entry) return { suppress: false, tier: 0, lastPushMs: 0 };

    const tierMs = COOLDOWN_TIERS[entry.tier]?.ms ?? COOLDOWN_TIERS[COOLDOWN_TIERS.length - 1].ms;
    const elapsed = nowMs - entry.lastPushMs;
    if (elapsed < tierMs) {
      return { suppress: true, tier: entry.tier, lastPushMs: entry.lastPushMs };
    }
    // Cooldown expired — advance tier for next time.
    return { suppress: false, tier: entry.tier, lastPushMs: entry.lastPushMs };
  }

  /** Advance tier (cap at max), then update the entry timestamp. */
  private advanceCooldownTier(key: string, nowMs: number): number {
    const entry = this.cooldowns.get(key);
    if (entry) {
      entry.tier = Math.min(entry.tier + 1, COOLDOWN_TIERS.length - 1);
      entry.lastPushMs = nowMs;
      return entry.tier;
    }
    this.cooldowns.set(key, { lastPushMs: nowMs, tier: 0 });
    return 0;
  }

  /** Reset cooldown for a key (used on resolve + explicit clear). */
  private resetCooldown(key: string): void {
    this.cooldowns.delete(key);
  }

  private isDigestEligible(alert: AlertInput, dedupKey: string, nowMs: number): boolean {
    // Critical alerts always push individually.
    if (alert.severity === "critical") return false;

    // Info-level alerts always digest.
    if (alert.severity === "info") return true;

    // Warning-level: digest if it's been active for >6h.
    const entry = this.cooldowns.get(dedupKey);
    if (entry && (nowMs - entry.lastPushMs) > 6 * 60 * 60_000) return true;

    // First-time or recent warning → push individually.
    return false;
  }

  private collectDigestAlert(alert: AlertInput, dedupKey: string, rowId: number | null, nowMs: number): void {
    const existing = this.digestAlerts.find((da) => da.dedupKey === dedupKey);
    if (existing) {
      existing.count++;
    } else {
      this.digestAlerts.push({
        dedupKey,
        severity: alert.severity,
        source: alert.source,
        title: alert.title,
        count: 1,
        firstAtMs: nowMs,
      });
    }
  }

  private scheduleDigestCheck(): void {
    // Use setTimeout to check every hour whether we should emit the digest.
    // setTimeout is unref'd so it doesn't prevent process exit.
    const timer = setTimeout(() => this.considerDigestEmit(), 60 * 60_000);
    timer.unref();
    this.digestScheduled = true;
  }

  private getDayKey(ms: number): string {
    // Compute America/Denver date from ms timestamp.
    const d = new Date(ms);
    const df = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", dateStyle: "short" });
    return df.format(d); // YYYY-MM-DD in en-CA locale
  }

  private considerDigestEmit(): void {
    this.digestScheduled = false;
    if (this.digestAlerts.length === 0) {
      this.scheduleDigestCheck();
      return;
    }

    const today = this.getDayKey(this.now().getTime());
    if (this.lastDigestDay === today) {
      this.scheduleDigestCheck();
      return;
    }

    this.lastDigestDay = today;

    // Build digest message.
    const criticalCount = this.digestAlerts.filter((a) => a.severity === "critical").length;
    const warningCount = this.digestAlerts.filter((a) => a.severity === "warning").length;
    const infoCount = this.digestAlerts.filter((a) => a.severity === "info").length;

    let digestMessage = `[connector:daily-digest] Alert summary for ${today}\n`;
    digestMessage += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    if (criticalCount > 0) digestMessage += `🔴 Critical: ${criticalCount}\n`;
    if (warningCount > 0) digestMessage += `🟡 Warnings: ${warningCount}\n`;
    if (infoCount > 0) digestMessage += `🔵 Info: ${infoCount}\n`;

    // Top offenders by count.
    const sorted = [...this.digestAlerts].sort((a, b) => b.count - a.count).slice(0, 10);
    digestMessage += `\nTop chronic alerts:\n`;
    for (const a of sorted) {
      digestMessage += `  · [${a.severity}] [${a.source}] ${a.title} — x${a.count}\n`;
    }

    // Send the digest via push chain.
    this.sendPush(digestMessage, null);

    // Clear the digest collection for the next day.
    this.digestAlerts = [];

    // Re-schedule for tomorrow.
    this.scheduleDigestCheck();
  }

  private notifyInner(alert: AlertInput): void {
    const dedupKey = alert.dedupKey ?? defaultDedupKey(alert);
    const nowMs = this.now().getTime();

    // 1. Log the alert.
    const context = [alert.ticket, alert.agent].filter(Boolean).join(", ");
    const logLine = `[${alert.severity}] [${alert.source}] ${alert.title}${context ? ` (${context})` : ""}`;
    if (alert.severity === "critical") this.log.error(logLine);
    else if (alert.severity === "warning") this.log.warn(logLine);
    else this.log.info(logLine);

    // 2. Store the alert.
    let rowId: number | null = null;
    let burstCount = 1;
    if (this.store) {
      try {
        // Cooldown is now managed in-memory in this class, not in the store.
        // Use a generous store-internal window just for SQL dedup (aggregation).
        const result = this.store.record(alert, 5 * 60_000, this.now());
        burstCount = result.row.count;
        rowId = result.row.id;
      } catch (err) {
        this.log.error(`alert store write failed (log sink already fired): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Mark this dedup_key as active (for resolve tracking).
    this.activeKeys.add(dedupKey);

    emitStreamTopic("alerts");

    // 3. Check push eligibility.
    if (!this.pushEnabled) return;
    if (SEVERITY_RANK[alert.severity] < SEVERITY_RANK[this.pushMinSeverity]) return;

    // 4. Startup buffer: hold alerts during init window.
    if (!this.startupBufferFlushed && nowMs < this.startupBufferUntilMs) {
      this.startupBuffer.push({ alert, dedupKey, rowId, atMs: nowMs });
      this.log.info(`alert buffered (startup): ${dedupKey}`);
      return;
    }

    // 5. Flush startup buffer if not yet done (buffer window expired).
    if (!this.startupBufferFlushed) {
      this.startupBufferFlushed = true;
      const buffered = this.startupBuffer;
      this.startupBuffer = [];
      for (const b of buffered) {
        this.emitPush(b.alert, b.dedupKey, b.rowId, b.atMs);
      }
    }

    // 6. Digest eligibility check (only for non-critical, long-lived warnings+info).
    if (this.isDigestEligible(alert, dedupKey, nowMs)) {
      this.collectDigestAlert(alert, dedupKey, rowId, nowMs);
      return;
    }

    // 7. Cooldown check.
    const cd = this.getCooldownWindow(dedupKey, nowMs);
    if (cd.suppress) {
      // Suppressed by cooldown — still go to digest if chronic.
      if (alert.severity !== "critical") {
        this.collectDigestAlert(alert, dedupKey, rowId, nowMs);
      }
      return;
    }

    // 8. Emit the push.
    this.emitPush(alert, dedupKey, rowId, nowMs, burstCount);
  }

  private resolveInner(alert: Pick<AlertInput, "source" | "title" | "agent" | "ticket" | "severity"> & { dedupKey?: string }): void {
    const dedupKey = alert.dedupKey ?? defaultDedupKey(alert as AlertInput);

    // If this key is not actively tracked, nothing to resolve.
    if (!this.activeKeys.has(dedupKey)) return;

    this.activeKeys.delete(dedupKey);
    this.resetCooldown(dedupKey);

    // Log the resolution.
    this.log.info(`[${alert.severity}] [${alert.source}] ✓ CLEARED: ${alert.title}`);

    // Push a resolve notice (if push is enabled and at minimum severity).
    if (!this.pushEnabled) return;
    if (SEVERITY_RANK[alert.severity] < SEVERITY_RANK[this.pushMinSeverity]) return;

    // Resolve notices use the push mechanism but don't hit the store storm budget
    // or cooldown (they're one-off clear signals). Use a small token.
    const nowMs = this.now().getTime();
    this.pushTimestamps = this.pushTimestamps.filter((t) => nowMs - t < PUSH_BUDGET_WINDOW_MS);
    if (this.pushTimestamps.length >= this.pushBudget) return; // Still under storm — skip.

    const message = `[connector:${alert.severity}] [${alert.source}] ✓ CLEARED: ${alert.title}`;
    this.sendPush(message, null);
    this.pushTimestamps.push(nowMs);
  }

  private emitPush(alert: AlertInput, dedupKey: string, rowId: number | null, nowMs: number, burstCount?: number): void {
    // Storm budget.
    this.pushTimestamps = this.pushTimestamps.filter((t) => nowMs - t < PUSH_BUDGET_WINDOW_MS);
    if (this.pushTimestamps.length >= this.pushBudget) {
      this.suppressedDuringStorm += 1;
      if (!this.stormDigestSent) {
        this.stormDigestSent = true;
        this.sendPush(
          `[connector:critical] ALERT STORM — push budget (${this.pushBudget}/${PUSH_BUDGET_WINDOW_MS / 60_000}min) exhausted; ` +
            `further alerts suppressed from push. See alerts store / console for the full stream.`,
          null
        );
      }
      return;
    }
    if (this.stormDigestSent) {
      this.stormDigestSent = false;
      const swallowed = this.suppressedDuringStorm;
      this.suppressedDuringStorm = 0;
      if (swallowed > 0) {
        this.log.warn(`alert storm ended — ${swallowed} alert(s) were push-suppressed (all stored)`);
      }
    }

    // Advance cooldown tier for this dedup_key.
    const tier = this.advanceCooldownTier(dedupKey, nowMs);

    // Build push message.
    const context = [alert.ticket, alert.agent].filter(Boolean).join(", ");
    const tierLabel = TIER_LABELS[tier] ?? "chronic";
    const tierInfo = tier > 0 ? ` [${tierLabel}]` : "";
    const countInfo = (burstCount && burstCount > 1) ? ` (x${burstCount})` : "";
    const detailStr =
      typeof alert.detail === "string" ? alert.detail : alert.detail ? JSON.stringify(alert.detail) : "";
    const detailSnippet = detailStr ? `\n${detailStr.slice(0, 300)}` : "";
    const message = `[connector:${alert.severity}] [${alert.source}] ${alert.title}${context ? ` (${context})` : ""}${tierInfo}${countInfo}${detailSnippet}`;

    this.sendPush(message, rowId);
    this.pushTimestamps.push(nowMs);
  }

  private sendPush(message: string, rowId: number | null): void {
    this.pushFn(message)
      .then((via) => {
        if (rowId !== null && this.store) this.store.markPushed(rowId, this.now(), typeof via === "string" ? via : undefined);
      })
      .catch((err) => {
        this.log.error(`push sink failed (alert is stored+logged): ${err instanceof Error ? err.message : String(err)}`);
      });
  }
}

// ── Module-level default bus ────────────────────────────────────────────────
let _defaultBus: AlertBus | null = null;

export function initAlertBus(options: AlertBusOptions = {}): AlertBus {
  _defaultBus = new AlertBus(options);
  return _defaultBus;
}

export function getAlertBus(): AlertBus {
  if (!_defaultBus) _defaultBus = new AlertBus();
  return _defaultBus;
}

export function notify(alert: AlertInput): void {
  getAlertBus().notify(alert);
}

export function resolve(alert: Pick<AlertInput, "source" | "title" | "agent" | "ticket" | "severity"> & { dedupKey?: string }): void {
  getAlertBus().resolve(alert);
}

/** Test hook: reset the module singleton. */
export function _resetAlertBusForTests(): void {
  _defaultBus = null;
}
