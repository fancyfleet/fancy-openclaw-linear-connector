import type { CronRegistryEntry, StaleCronEntry } from "./registry.js";

export const REQUIRED_CRON_NAMES = [
  "validation-watchdog",
  "merged-evidence-reconciler",
] as const;

export type RequiredCronName = (typeof REQUIRED_CRON_NAMES)[number];

export interface RequiredCronRetirement {
  name: RequiredCronName;
  reason: string;
  ticket?: string;
}

export interface RequiredCronHealth {
  name: RequiredCronName;
  required: true;
  retired: boolean;
  source: "/health";
  status: "fresh" | "stale" | "missing" | "retired";
  schedule: string | null;
  registeredAt: string | null;
  lastRunAt: string | null;
  retirement?: RequiredCronRetirement;
}

export interface RequiredStaleCronEntry extends StaleCronEntry {
  required?: true;
}

function isRequiredCronName(value: string): value is RequiredCronName {
  return (REQUIRED_CRON_NAMES as readonly string[]).includes(value);
}

function parseRequiredCronRetirements(
  value: string | undefined,
): Map<RequiredCronName, RequiredCronRetirement> {
  const retirements = new Map<RequiredCronName, RequiredCronRetirement>();
  if (!value) return retirements;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return retirements;
  }
  if (!Array.isArray(parsed)) return retirements;

  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== "string" || !isRequiredCronName(raw.name)) continue;
    if (typeof raw.reason !== "string" || raw.reason.trim().length === 0) continue;

    retirements.set(raw.name, {
      name: raw.name,
      reason: raw.reason,
      ...(typeof raw.ticket === "string" && raw.ticket.trim().length > 0 ? { ticket: raw.ticket } : {}),
    });
  }

  return retirements;
}

export function getRequiredCronRetirements(
  env: NodeJS.ProcessEnv = process.env,
): Map<RequiredCronName, RequiredCronRetirement> {
  return parseRequiredCronRetirements(env.REQUIRED_CRON_RETIREMENTS_JSON);
}

export function buildRequiredCronHealth(options: {
  crons: CronRegistryEntry[];
  staleCrons: StaleCronEntry[];
  retirements?: Map<RequiredCronName, RequiredCronRetirement>;
}): RequiredCronHealth[] {
  const entries = new Map(options.crons.map((cron) => [cron.name, cron]));
  const staleNames = new Set(options.staleCrons.map((cron) => cron.name));
  const retirements = options.retirements ?? getRequiredCronRetirements();

  return REQUIRED_CRON_NAMES.map((name) => {
    const entry = entries.get(name);
    const retirement = retirements.get(name);
    const retired = retirement !== undefined;
    return {
      name,
      required: true,
      retired,
      source: "/health",
      status: retired ? "retired" : entry == null ? "missing" : staleNames.has(name) ? "stale" : "fresh",
      schedule: entry?.schedule ?? null,
      registeredAt: entry?.registeredAt ?? null,
      lastRunAt: entry?.lastRunAt ?? null,
      ...(retirement ? { retirement } : {}),
    };
  });
}

export function isRequiredCron(name: string): name is RequiredCronName {
  return isRequiredCronName(name);
}
