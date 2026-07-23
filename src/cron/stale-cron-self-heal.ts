export interface StaleCronForSelfHeal {
  name: string;
  schedule: string;
  lastRunAt: string | null;
  overdueByMs: number;
}

export interface StaleCronSelfHealResult {
  attempted: Array<{ name: string; attempt: number }>;
  capped: Array<{ name: string; attempts: number }>;
  staleCrons: StaleCronForSelfHeal[];
}

const attemptsByWindow = new Map<string, Map<string, number>>();
const reinitializers = new Map<string, (cron: StaleCronForSelfHeal) => Promise<unknown> | unknown>();
const DEFAULT_SELF_HEAL_RETRY_CAP = 1;

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getStaleCronSelfHealRetryCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerOrDefault(env.STALE_CRON_SELF_HEAL_RETRY_CAP, DEFAULT_SELF_HEAL_RETRY_CAP);
}

export function registerStaleCronReinitializer(
  name: string,
  reinitializeCron: (cron: StaleCronForSelfHeal) => Promise<unknown> | unknown,
): void {
  reinitializers.set(name, reinitializeCron);
}

export async function handleStaleCronsOnce(options: {
  staleCrons: StaleCronForSelfHeal[];
  detectionWindowId: string;
  now: Date;
  maxAttempts?: number;
  reinitializeCron: (cron: StaleCronForSelfHeal) => Promise<void> | void;
}): Promise<StaleCronSelfHealResult> {
  const attempted: Array<{ name: string; attempt: number }> = [];
  const capped: Array<{ name: string; attempts: number }> = [];
  const maxAttempts = positiveIntegerOrDefault(options.maxAttempts, DEFAULT_SELF_HEAL_RETRY_CAP);
  let attemptsForWindow = attemptsByWindow.get(options.detectionWindowId);
  if (!attemptsForWindow) {
    attemptsForWindow = new Map<string, number>();
    attemptsByWindow.set(options.detectionWindowId, attemptsForWindow);
  }

  for (const cron of options.staleCrons) {
    const attempts = attemptsForWindow.get(cron.name) ?? 0;
    if (attempts >= maxAttempts) {
      capped.push({ name: cron.name, attempts });
      continue;
    }

    const nextAttempt = attempts + 1;
    attemptsForWindow.set(cron.name, nextAttempt);
    await options.reinitializeCron(cron);
    attempted.push({ name: cron.name, attempt: nextAttempt });
  }

  return { attempted, capped, staleCrons: options.staleCrons };
}

function detectionWindowIdForCron(cron: StaleCronForSelfHeal): string {
  return `${cron.name}|${cron.lastRunAt ?? "never-fired"}`;
}

export async function handleRegisteredStaleCronsOnce(options: {
  staleCrons: StaleCronForSelfHeal[];
  now: Date;
  maxAttempts?: number;
  log?: { warn: (message: string) => void };
}): Promise<StaleCronSelfHealResult> {
  const attempted: StaleCronSelfHealResult["attempted"] = [];
  const capped: StaleCronSelfHealResult["capped"] = [];

  for (const cron of options.staleCrons) {
    const result = await handleStaleCronsOnce({
      staleCrons: [cron],
      detectionWindowId: detectionWindowIdForCron(cron),
      now: options.now,
      maxAttempts: options.maxAttempts,
      reinitializeCron: async (staleCron) => {
        const reinitializer = reinitializers.get(staleCron.name);
        if (!reinitializer) {
          options.log?.warn(`stale-cron self-heal has no reinitializer for ${staleCron.name}`);
          return;
        }
        try {
          await reinitializer(staleCron);
        } catch (err) {
          options.log?.warn(
            `stale-cron self-heal reinitializer failed for ${staleCron.name}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    });
    attempted.push(...result.attempted);
    capped.push(...result.capped);
  }

  return { attempted, capped, staleCrons: options.staleCrons };
}

export function resetStaleCronSelfHealForTest(): void {
  attemptsByWindow.clear();
  reinitializers.clear();
}
