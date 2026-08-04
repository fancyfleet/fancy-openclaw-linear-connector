import type { CronRegistryEntry } from "./registry.js";

export interface CronStartupReadiness {
  status: "ok" | "degraded";
  neverVerifiedCrons: Array<{ name: string; lastRunAt: string | null; overdueByMs: number }>;
}

const DURATION_RE = /(\d+(?:\.\d+)?)(ms|s|m|h|d)\b/;

function parseScheduleIntervalMs(schedule: string): number | null {
  const match = schedule.match(DURATION_RE);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2]) {
    case "ms": return value;
    case "s": return value * 1_000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    case "d": return value * 86_400_000;
    default: return null;
  }
}

function timestampMs(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseCronStartupGraceMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Boot grace for a cron whose staleness is measured against a *persisted*,
 * pre-boot `lastRunAt` (INF-1091).
 *
 * `evaluateCronStartupReadiness` only graces crons that have *never* run
 * (`lastRunAt === null`) — it short-circuits on the first line of its loop. A
 * cron with a `lastRunAt` restored from the run-stamp file before a restart is
 * skipped by that grace and falls straight into the critical-stale 503 gate.
 * The sharp case: a process that was down > ~24h boots with a >24h-old
 * persisted stamp and cannot run its first sweep until +interval, so /health
 * serves 503 from boot until then — the exact long-outage scenario where the
 * health gate should let the fleet recover instead of crashlooping it.
 *
 * This mirrors the never-run grace for the persisted-stale case: a cron whose
 * last run predates this boot has not had a chance to run since `bootedAt`, so
 * it must not count toward the critical-stale gate until `max(intervalMs,
 * bootGraceMs)` has elapsed since boot. A cron that has run since boot is
 * legitimately stale if overdue and is *not* graced.
 */
export function isCronWithinBootGrace(options: {
  lastRunAt: string | null;
  intervalMs: number;
  bootedAt: Date;
  now: Date;
  bootGraceMs: number;
}): boolean {
  // Never-run crons are the domain of evaluateCronStartupReadiness, not this.
  if (options.lastRunAt === null) return false;

  const bootedAtMs = options.bootedAt.getTime();
  const nowMs = options.now.getTime();
  const lastRunMs = Date.parse(options.lastRunAt);
  if (!Number.isFinite(bootedAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(lastRunMs)) {
    return false;
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) return false;

  // Only grace crons whose last run predates this boot (bootedAt more recent
  // than lastRunAt). A cron that ran since boot is genuinely live-or-stale.
  if (lastRunMs >= bootedAtMs) return false;

  const graceMs = Math.max(options.intervalMs, options.bootGraceMs);
  return nowMs - bootedAtMs < graceMs;
}

export function evaluateCronStartupReadiness(options: {
  crons: CronRegistryEntry[];
  bootedAt: Date;
  now: Date;
  bootGraceMs: number;
  log?: { error: (message: string) => void };
}): CronStartupReadiness {
  const neverVerifiedCrons: CronStartupReadiness["neverVerifiedCrons"] = [];
  const fallbackStartedAt = options.bootedAt.getTime();
  const nowMs = options.now.getTime();

  for (const cron of options.crons) {
    if (cron.lastRunAt !== null) continue;

    const startedAtMs = timestampMs(cron.registeredAt, fallbackStartedAt);
    const intervalMs = parseScheduleIntervalMs(cron.schedule);
    if (intervalMs === null) continue;

    const graceMs = Math.max(intervalMs, options.bootGraceMs);
    const overdueByMs = Math.max(0, nowMs - startedAtMs - graceMs);

    if (overdueByMs > 0) {
      neverVerifiedCrons.push({
        name: cron.name,
        lastRunAt: cron.lastRunAt,
        overdueByMs,
      });
    }
  }

  if (neverVerifiedCrons.length > 0) {
    options.log?.error(
      `cron startup readiness degraded: never verified ${neverVerifiedCrons.map((cron) => cron.name).join(", ")}`,
    );
  }

  return {
    status: neverVerifiedCrons.length > 0 ? "degraded" : "ok",
    neverVerifiedCrons,
  };
}
