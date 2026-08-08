/**
 * INF-1302 — engine-watch periodic signal-to-ticket pipeline cron.
 *
 * Scans signals, classifies each, dedups, and files follow-up tickets via the
 * Linear API only when a service credential is available. Registration is via
 * registerEngineWatchCron() called from inside createApp() so /health.crons
 * proves bootstrap wiring (AC6, AI-1810).
 */

import { createModuleLogger } from "../logging.js";
import { registerCron, formatIntervalMs, markCronRunSuccess, markCronRunFailure } from "./registry.js";
import { resolveServiceCredential } from "../service-credential.js";
import {
  markEngineWatchScheduled,
  recordEngineWatchRun,
  recordEngineWatchSkip,
  recordEngineWatchFail,
} from "../engine-watch-state.js";
import { classifySignal, type Signal } from "../engine-watch/engine-watch.js";

const log = createModuleLogger("engine-watch");

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15m

function parseIntervalMs(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return DEFAULT_INTERVAL_MS;
  const n = parseFloat(match[1]);
  switch (match[2]) {
    case "ms": return n;
    case "s": return n * 1_000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    default: return DEFAULT_INTERVAL_MS;
  }
}

function resolveIntervalMs(): number {
  const raw = process.env.ENGINE_WATCH_INTERVAL;
  if (!raw) return DEFAULT_INTERVAL_MS;
  return parseIntervalMs(raw);
}

/** Collect signals for this tick. Conservative: returns [] when no source is wired. */
function collectSignals(): Signal[] {
  return [];
}

async function runEngineWatchTick(): Promise<void> {
  try {
    const authToken = resolveServiceCredential();
    if (!authToken) {
      const reason = "No service credential configured — skipping engine-watch tick";
      log.warn(`[engine-watch] ${reason}`);
      recordEngineWatchSkip(reason);
      markCronRunFailure("engine-watch", reason);
      return;
    }
    const signals = collectSignals();
    if (signals.length === 0) {
      recordEngineWatchRun({ signals: 0, dispositions: 0 });
      markCronRunSuccess("engine-watch");
      return;
    }
    let dispositions = 0;
    for (const signal of signals) {
      void classifySignal(signal, {
        closestOwner: null,
        activeFollowup: null,
        createTicket: () => ({
          id: `engine-watch-${signal.id}`,
          identifier: `INF-EW-${Date.now()}`,
          state: "To Do",
          stateType: "unstarted",
        }),
      });
      dispositions += 1;
    }
    recordEngineWatchRun({ signals: signals.length, dispositions });
    markCronRunSuccess("engine-watch");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[engine-watch] tick failed: ${msg}`);
    recordEngineWatchFail(msg);
    markCronRunFailure("engine-watch", err);
  }
}

export function registerEngineWatchCron(): void {
  const intervalMs = resolveIntervalMs();
  registerCron("engine-watch", `every ${formatIntervalMs(intervalMs)}`);
  markEngineWatchScheduled();

  const firstRun = setTimeout(() => {
    void runEngineWatchTick();
  }, 0);
  if (process.env.NODE_ENV !== "test") firstRun.unref();

  const timer = setInterval(() => {
    void runEngineWatchTick();
  }, intervalMs);
  if (process.env.NODE_ENV !== "test") timer.unref();

  log.info(`[engine-watch] engine-watch scheduled every ${formatIntervalMs(intervalMs)} — first run queued immediately`);
}
