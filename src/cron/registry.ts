/**
 * AI-1810 — Connector-level cron/background-driver registry.
 *
 * Twice (AI-1773, AI-1775) a periodic driver shipped fully tested and
 * deployed while never registered at bootstrap — dead code in prod with all
 * ACs green. This registry makes scheduling state observable: every periodic
 * or background driver records itself here at the moment its timer is
 * actually created, and /health enumerates the entries.
 *
 * Contract:
 *  - Drivers call registerCron() from inside their register*Cron() function,
 *    NOT at module load. An entry therefore exists if and only if the
 *    production bootstrap really invoked the registrar — importing the module
 *    (as unit tests do) is not enough to appear in /health.
 *  - Conditional registrars (e.g. the G-20 canary, which skips when its env
 *    is missing) must only call registerCron() on the path that schedules
 *    the timer, so /health reflects live scheduling state, not intent.
 *
 * Verification loop this closes (AI-1808): at ac-validate the steward curls
 * /health and looks for the component by name — mechanical and generic,
 * instead of per-feature grep archaeology in index.ts.
 */
import fs from "node:fs";
import path from "node:path";

export interface CronRegistryEntry {
  /** Stable driver name, kebab-case (e.g. "sla-sweep"). */
  id: string;
  /** Stable driver name, kebab-case (e.g. "sla-sweep"). Alias of id. */
  name: string;
  /** Human-readable trigger description (e.g. "every 5m"). */
  schedule: string;
  /** ISO timestamp of when the driver registered in this process. */
  registeredAt: string;
  /**
   * ISO timestamp of the driver's most recent run, or null if it has not run
   * yet in this process. `registeredAt` proves the timer was armed; only this
   * proves the job actually fires (AI-2037 / AC2.4).
   */
  lastRunAt: string | null;
  /**
   * Outcome of the most recent run, or null if the driver has never reported
   * one (INF-1263). Drivers that only call the legacy liveness-only
   * `markCronRun` never set this — that is expected, not a bug.
   */
  lastOutcome: "success" | "fail" | null;
  /** Human-readable error from the most recent failed run, or null. */
  lastError: string | null;
  /** Consecutive failed runs in a row; reset to 0 on the next success. */
  failureStreak: number;
}

export interface StaleCronEntry {
  name: string;
  schedule: string;
  lastRunAt: string | null;
  overdueBy: string;
  overdueByMs: number;
}

export interface GetStaleCronsOptions {
  now?: Date;
  stalenessMultiplier?: number;
}

const entries = new Map<string, CronRegistryEntry>();
const DEFAULT_STALENESS_MULTIPLIER = 3;
const STAMP_STORE_VERSION = 1;
let loadedStampPath: string | null = null;
let persistedLastRunAt = new Map<string, string>();

function resolveRunStampPath(): string {
  return process.env.CRON_RUN_STAMP_PATH ?? path.join(process.env.DATA_DIR ?? "data", "cron-run-stamps.json");
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function loadPersistedRunStamps(): void {
  const stampPath = resolveRunStampPath();
  if (loadedStampPath === stampPath) return;

  loadedStampPath = stampPath;
  persistedLastRunAt = new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(stampPath, "utf8"));
  } catch {
    return;
  }

  if (!parsed || typeof parsed !== "object") return;
  const stamps = (parsed as { stamps?: unknown }).stamps;
  if (!stamps || typeof stamps !== "object" || Array.isArray(stamps)) return;

  for (const [name, lastRunAt] of Object.entries(stamps)) {
    if (isValidIsoTimestamp(lastRunAt)) {
      persistedLastRunAt.set(name, lastRunAt);
    }
  }
}

function persistRunStamps(): void {
  const stampPath = resolveRunStampPath();
  loadedStampPath = stampPath;
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  const tmpPath = `${stampPath}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmpPath,
    `${JSON.stringify({
      version: STAMP_STORE_VERSION,
      stamps: Object.fromEntries([...persistedLastRunAt.entries()].sort(([a], [b]) => a.localeCompare(b))),
    }, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(tmpPath, stampPath);
}

/** Format a millisecond interval as a compact human-readable duration. */
export function formatIntervalMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/**
 * Record a periodic/background driver as scheduled in this process.
 * Call from inside the registrar, on the same code path that creates the
 * timer. Re-registering the same name overwrites (last write wins) so a
 * hot-reload path can refresh its schedule without duplicating entries.
 */
export function registerCron(name: string, schedule: string): void {
  loadPersistedRunStamps();
  const existing = entries.get(name);
  entries.set(name, {
    id: name,
    name,
    schedule,
    registeredAt: new Date().toISOString(),
    // A hot-reload re-registers the driver but does not un-run it.
    lastRunAt: existing?.lastRunAt ?? persistedLastRunAt.get(name) ?? null,
    // Same rationale as lastRunAt above: a hot-reload must not erase outcome
    // history the driver already accumulated this process.
    lastOutcome: existing?.lastOutcome ?? null,
    lastError: existing?.lastError ?? null,
    failureStreak: existing?.failureStreak ?? 0,
  });
}

function stampRunAt(entry: CronRegistryEntry, now: Date): void {
  const lastRunAt = now.toISOString();
  entry.lastRunAt = lastRunAt;
  persistedLastRunAt.set(entry.name, lastRunAt);
  persistRunStamps();
}

/**
 * Stamp a driver as having just run. Call at the END of each invocation, from
 * the same code path that does the work — a driver that throws before reaching
 * this call has not run, and its stale lastRunAt is the signal.
 * No-op for an unregistered name: liveness cannot precede scheduling.
 */
export function markCronRun(name: string, now = new Date()): void {
  loadPersistedRunStamps();
  const entry = entries.get(name);
  if (!entry) return;
  stampRunAt(entry, now);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * Stamp a driver as having just run successfully (INF-1263): clears any prior
 * error, resets the failure streak, and updates lastRunAt. No-op for an
 * unregistered name, mirroring markCronRun.
 */
export function markCronRunSuccess(name: string, now = new Date()): void {
  loadPersistedRunStamps();
  const entry = entries.get(name);
  if (!entry) return;
  entry.lastOutcome = "success";
  entry.lastError = null;
  entry.failureStreak = 0;
  stampRunAt(entry, now);
}

/**
 * Stamp a driver as having just failed (INF-1263): records the error message
 * and increments the consecutive-failure streak. No-op for an unregistered
 * name, mirroring markCronRun.
 */
export function markCronRunFailure(name: string, error: unknown, now = new Date()): void {
  loadPersistedRunStamps();
  const entry = entries.get(name);
  if (!entry) return;
  entry.lastOutcome = "fail";
  entry.lastError = errorMessage(error);
  entry.failureStreak += 1;
  stampRunAt(entry, now);
}

export interface CriticalCronFailure {
  name: string;
  schedule: string;
  lastOutcome: "fail";
  lastError: string;
  failureStreak: number;
  severity: "critical";
}

export interface GetCriticalCronFailuresOptions {
  failureThreshold: number;
}

/**
 * Registered crons whose consecutive failure streak has reached the
 * configured threshold (INF-1263 AC2) — the escalation signal for a cron
 * that is failing N-in-a-row rather than just having failed once.
 */
export function getCriticalCronFailures(options: GetCriticalCronFailuresOptions): CriticalCronFailure[] {
  const failures: CriticalCronFailure[] = [];
  for (const entry of getRegisteredCrons()) {
    if (entry.lastOutcome === "fail" && entry.failureStreak >= options.failureThreshold) {
      failures.push({
        name: entry.name,
        schedule: entry.schedule,
        lastOutcome: "fail",
        lastError: entry.lastError as string,
        failureStreak: entry.failureStreak,
        severity: "critical",
      });
    }
  }
  return failures;
}

/** All drivers registered in this process, sorted by name. */
export function getRegisteredCrons(): CronRegistryEntry[] {
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function positiveNumberOrDefault(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Config-driven stale threshold multiplier for /health.staleCrons. */
export function getCronStalenessMultiplierFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumberOrDefault(env.CRON_STALENESS_MULTIPLIER, DEFAULT_STALENESS_MULTIPLIER);
}

function parseIntervalMs(schedule: string): number | null {
  const normalized = schedule
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/^every\s+/, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(ms|msec|millisecond|milliseconds|s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)$/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = match[2];
  if (unit === "ms" || unit === "msec" || unit.startsWith("millisecond")) return value;
  if (unit === "s" || unit === "sec" || unit.startsWith("second")) return value * 1_000;
  if (unit === "m" || unit === "min" || unit.startsWith("minute")) return value * 60_000;
  if (unit === "h" || unit === "hr" || unit.startsWith("hour")) return value * 3_600_000;
  if (unit === "d" || unit.startsWith("day")) return value * 86_400_000;
  return null;
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) return null;

    const [rangePart, stepPart] = trimmed.split("/");
    const step = stepPart == null ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) return null;

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [startRaw, endRaw] = rangePart.split("-");
      start = Number(startRaw);
      end = Number(endRaw);
    } else {
      start = Number(rangePart);
      end = stepPart == null ? start : max;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      return null;
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return values;
}

interface ParsedCronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
}

function parseCronFields(fields: string[]): ParsedCronFields | null {
  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = fields;
  const minutes = parseCronField(minuteRaw, 0, 59);
  const hours = parseCronField(hourRaw, 0, 23);
  const days = parseCronField(dayRaw, 1, 31);
  const months = parseCronField(monthRaw, 1, 12);
  const weekdays = parseCronField(weekdayRaw, 0, 7);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  return { minutes, hours, days, months, weekdays };
}

function dateMatchesCron(date: Date, fields: ParsedCronFields): boolean {
  const weekday = date.getUTCDay();
  return (
    fields.minutes.has(date.getUTCMinutes()) &&
    fields.hours.has(date.getUTCHours()) &&
    fields.days.has(date.getUTCDate()) &&
    fields.months.has(date.getUTCMonth() + 1) &&
    (fields.weekdays.has(weekday) || (weekday === 0 && fields.weekdays.has(7)))
  );
}

function cronIntervalMs(schedule: string, base: Date): number | null {
  const parts = schedule.trim().split(/\s+/);
  const rawFields = parts.length === 5 ? parts : parts.length === 6 ? parts.slice(1) : null;
  if (!rawFields) return null;
  const fields = parseCronFields(rawFields);
  if (!fields) return null;

  const startMs = base.getTime();
  if (!Number.isFinite(startMs)) return null;

  let cursor = new Date(startMs + 60_000);
  cursor.setUTCSeconds(0, 0);
  const maxChecks = 366 * 24 * 60;
  for (let i = 0; i < maxChecks; i += 1) {
    if (dateMatchesCron(cursor, fields)) {
      return cursor.getTime() - startMs;
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }

  return null;
}

function scheduleIntervalMs(schedule: string, base: Date): number | null {
  return parseIntervalMs(schedule) ?? cronIntervalMs(schedule, base);
}

/** Stale drivers computed from registered schedule state only; no I/O. */
export function getStaleCrons(options: GetStaleCronsOptions = {}): StaleCronEntry[] {
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) return [];

  const stalenessMultiplier = positiveNumberOrDefault(
    options.stalenessMultiplier,
    DEFAULT_STALENESS_MULTIPLIER,
  );
  const stale: StaleCronEntry[] = [];

  for (const entry of getRegisteredCrons()) {
    const baseIso = entry.lastRunAt ?? entry.registeredAt;
    const baseMs = Date.parse(baseIso);
    if (!Number.isFinite(baseMs)) continue;

    const intervalMs = scheduleIntervalMs(entry.schedule, new Date(baseMs));
    if (intervalMs == null || !Number.isFinite(intervalMs) || intervalMs <= 0) continue;

    const dueMs = entry.lastRunAt == null
      ? baseMs + intervalMs
      : baseMs + intervalMs * stalenessMultiplier;

    if (nowMs > dueMs) {
      const overdueByMs = nowMs - dueMs;
      stale.push({
        name: entry.name,
        schedule: entry.schedule,
        lastRunAt: entry.lastRunAt,
        overdueBy: formatIntervalMs(overdueByMs),
        overdueByMs,
      });
    }
  }

  return stale;
}

/** Test-only: clear the registry between cases. */
export function resetCronRegistryForTest(): void {
  entries.clear();
  loadedStampPath = null;
  persistedLastRunAt = new Map();
}

/**
 * Test-only (INF-1263): clear only the failure-tracking fields, leaving
 * registeredAt/lastRunAt/schedule intact. Many test files call createApp()
 * repeatedly across it()/beforeEach blocks without ever resetting the
 * registry (harmless before this ticket, since markCronRun was
 * liveness-only). Now that registered crons report real outcome, a cron
 * whose startup kick genuinely fails in a given file's env/mocks
 * accumulates failureStreak across that file's app instances and can trip
 * the /health critical-failure gate for later, unrelated test cases — this
 * clears that accumulation globally without disturbing tests that assert
 * registeredAt/schedule across a shared beforeAll registration.
 */
export function resetCronFailureStreaksForTest(): void {
  for (const entry of entries.values()) {
    entry.lastOutcome = null;
    entry.lastError = null;
    entry.failureStreak = 0;
  }
}
