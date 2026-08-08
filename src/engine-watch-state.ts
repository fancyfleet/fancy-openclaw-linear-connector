/**
 * INF-1302 — In-process engine-watch run liveness state.
 *
 * Modeled on src/rescue-sweep-state.ts. Surfaced in /health so liveness is
 * observable at ac-validate without waiting for the cron trigger (AC7, AI-1810).
 */

export type EngineWatchOutcome = "success" | "skip" | "fail";

export interface EngineWatchState {
  lastRunAt: string | null;
  lastOutcomeType: EngineWatchOutcome | null;
  lastOutcome: { signals: number; dispositions: number };
  lastSummary: string | null;
  lastError: string | null;
  /** True once the cron has been registered (proves bootstrap wiring, AC6/AC7). */
  scheduled: boolean;
  /** ISO timestamp when the cron was registered. */
  registeredAt: string | null;
}

let state: EngineWatchState = {
  lastRunAt: null,
  lastOutcomeType: null,
  lastOutcome: { signals: 0, dispositions: 0 },
  lastSummary: null,
  lastError: null,
  scheduled: false,
  registeredAt: null,
};

export function markEngineWatchScheduled(): void {
  state.scheduled = true;
  state.registeredAt = new Date().toISOString();
}

export function recordEngineWatchRun(result: { signals: number; dispositions: number; summary?: string }): void {
  state = {
    ...state,
    lastRunAt: new Date().toISOString(),
    lastOutcomeType: "success",
    lastOutcome: { signals: result.signals, dispositions: result.dispositions },
    lastSummary: result.summary ?? null,
    lastError: null,
  };
}

export function recordEngineWatchSkip(reason: string): void {
  state = {
    ...state,
    lastRunAt: new Date().toISOString(),
    lastOutcomeType: "skip",
    lastError: reason,
  };
}

export function recordEngineWatchFail(error: string): void {
  state = {
    ...state,
    lastRunAt: new Date().toISOString(),
    lastOutcomeType: "fail",
    lastError: error,
  };
}

export function getEngineWatchState(): EngineWatchState {
  return { ...state, lastOutcome: { ...state.lastOutcome } };
}

export function resetEngineWatchStateForTest(): void {
  state = {
    lastRunAt: null,
    lastOutcomeType: null,
    lastOutcome: { signals: 0, dispositions: 0 },
    lastSummary: null,
    lastError: null,
    scheduled: false,
    registeredAt: null,
  };
}
