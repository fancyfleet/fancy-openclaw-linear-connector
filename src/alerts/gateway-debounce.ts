/**
 * AI-2413 — Gateway restart debounce for pit-crew alert suppression.
 *
 * ## Problem
 *
 * During a gateway crash-loop (observed 2026-07-15 01:48-01:52 MDT, AI-2411),
 * pit-crew correctly detected 76 consecutive probe failures but generated a
 * CRITICAL alert for every failure before the gateway recovered on its own.
 * The watchdog cannot distinguish between "gateway is down for a real reason"
 * and "gateway is crash-looping and will recover via systemd."
 *
 * ## Design
 *
 * A lightweight in-memory debounce that tracks gateway restart timestamps.
 * When a CRITICAL alert from a configured source (pit-crew, gateway-probe)
 * arrives within the debounce window of the most recent restart, the alert
 * is suppressed entirely. After the window elapses, alerts fire normally.
 *
 * The debounce is bounded: a genuinely down gateway will start alerting once
 * the window expires. Restart-systemd recovery cycles are typically <30s,
 * so the 90s default window is generous enough to cover multiple restart
 * attempts while still escalating within ~2 minutes of a real outage.
 *
 * ## Integration
 *
 * - `recordRestart()` called on connector startup (startup-replay path) and
 *   whenever the gateway signals a recovery/restart (admin health endpoint).
 * - `checkAlert()` called from the alert bus `notifyInner()` before any store
 *   write or push — if suppressed, the alert is silently dropped with a log.
 *
 * ## Config (env)
 *
 * | Env | Default | Meaning |
 * |---|---|---|
 * | `GATEWAY_DEBOUNCE_WINDOW_MS` | `90000` | Milliseconds after restart to suppress configured CRITICAL alerts |
 * | `GATEWAY_DEBOUNCE_SOURCES` | `pit-crew,pitcrew,gateway-probe` | Comma-separated alert sources subject to debounce |
 */

import { componentLogger, createLogger } from "../logger.js";

const log = componentLogger(createLogger(), "gateway-debounce");

export interface GatewayDebounceOptions {
  /** Debounce window in ms. Default: 90s */
  windowMs?: number;
  /** Comma-separated alert sources to debounce. */
  sourceList?: string;
  now?: () => Date;
}

export interface DebounceVerdict {
  /** True if the alert should be suppressed (debounced). */
  suppressed: boolean;
  /** Human-readable reason for logging/alert enrichment. */
  reason: string;
}

/**
 * In-memory gateway restart debounce.
 *
 * Thread-safety: not required — called synchronously from the single-threaded
 * Node.js event loop.
 */
export class GatewayDebounce {
  private lastRestartAt: number | null = null;
  private windowMs: number;
  private debouncedSources: Set<string>;
  private now: () => Date;

  constructor(options: GatewayDebounceOptions = {}) {
    this.windowMs = options.windowMs ?? parseInt(process.env.GATEWAY_DEBOUNCE_WINDOW_MS ?? "90000", 10);
    this.now = options.now ?? (() => new Date());

    const rawSources = options.sourceList ?? process.env.GATEWAY_DEBOUNCE_SOURCES ?? "pit-crew,pitcrew,gateway-probe";
    this.debouncedSources = new Set(rawSources.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

    log.info(`Initialized: window=${this.windowMs}ms sources=[${[...this.debouncedSources].join(", ")}]`);
  }

  /**
   * Record a gateway restart. Called from the startup-replay path and from
   * any restart-signal webhook or health endpoint.
   */
  recordRestart(at?: Date): void {
    const timestamp = (at ?? this.now()).getTime();
    this.lastRestartAt = timestamp;
    log.info(`Gateway restart recorded at ${new Date(timestamp).toISOString()}`);
  }

  /**
   * Check whether an alert should be suppressed.
   *
   * @param source  Alert source slug (e.g. "pit-crew", "gateway-probe")
   * @param at      Alert timestamp (defaults to now)
   * @returns       Verdict: suppressed + reason
   */
  checkAlert(source: string, at?: Date): DebounceVerdict {
    const nowMs = (at ?? this.now()).getTime();
    const sourceLower = source.toLowerCase();

    // Only debounce configured sources.
    if (!this.debouncedSources.has(sourceLower)) {
      return { suppressed: false, reason: `source "${source}" not in debounce list` };
    }

    // No restart recorded → no debounce.
    if (this.lastRestartAt === null) {
      return { suppressed: false, reason: "no gateway restart recorded" };
    }

    const elapsed = nowMs - this.lastRestartAt;

    // Outside the debounce window → allow.
    if (elapsed > this.windowMs) {
      return { suppressed: false, reason: `debounce window elapsed (${Math.round(elapsed / 1000)}s > ${Math.round(this.windowMs / 1000)}s)` };
    }

    // Within the debounce window → suppress.
    log.warn(`Alert suppressed: source=${source} elapsed=${Math.round(elapsed / 1000)}s within debounce window=${Math.round(this.windowMs / 1000)}s`);
    return {
      suppressed: true,
      reason: `gateway restarted ${Math.round(elapsed / 1000)}s ago (debounce window ${Math.round(this.windowMs / 1000)}s)`,
    };
  }

  /**
   * Reset the debounce state (primarily for tests).
   */
  reset(): void {
    this.lastRestartAt = null;
  }
}

// ── Module-level default instance ────────────────────────────────────────────

let _defaultDebounce: GatewayDebounce | null = null;

export function initGatewayDebounce(options: GatewayDebounceOptions = {}): GatewayDebounce {
  _defaultDebounce = new GatewayDebounce(options);
  return _defaultDebounce;
}

export function getGatewayDebounce(): GatewayDebounce {
  if (!_defaultDebounce) _defaultDebounce = new GatewayDebounce();
  return _defaultDebounce;
}

/** Test hook. */
export function _resetGatewayDebounceForTests(): void {
  _defaultDebounce = null;
}
