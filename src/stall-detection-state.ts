/**
 * INF-314 — In-process state for stall detection liveness.
 *
 * Exposed on /health so ac-validate can confirm the stall detection
 * component is active and see the effective thresholds without waiting
 * for a stall to occur (AC9).
 *
 * Pattern mirrors src/rescue-sweep-state.ts.
 */

/** Default ACK timeout: 3 minutes. */
export const DEFAULT_ACK_TIMEOUT_MS = 180_000;

/** Default progress timeout: 12 minutes. */
export const DEFAULT_PROGRESS_TIMEOUT_MS = 720_000;

/** Default config assembled from the constants above. */
export const DEFAULT_STALL_CONFIG = {
  ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
  progressTimeoutMs: DEFAULT_PROGRESS_TIMEOUT_MS,
} as const;

export interface StallDetectionState {
  /** True once registerStallSweepCron() has been called at bootstrap. */
  active: boolean;
  /** Effective ACK timeout in ms. */
  ackTimeoutMs: number;
  /** Effective progress timeout in ms. */
  progressTimeoutMs: number;
  /** INF-1333: lane breakdown observable at /health without waiting for a stall. */
  lanes: string[];
  /** INF-1333: lane-distinct acknowledged-silence block. */
  acknowledgedSilence: { active: boolean };
}

let state: StallDetectionState = {
  active: false,
  ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
  progressTimeoutMs: DEFAULT_PROGRESS_TIMEOUT_MS,
  lanes: ["idle-lease", "acknowledged-silence"],
  acknowledgedSilence: { active: true },
};

/**
 * Record that stall detection is active with the given thresholds.
 * Called by registerStallSweepCron() when the cron is armed.
 */
export function recordStallDetectionActive(config: {
  ackTimeoutMs: number;
  progressTimeoutMs: number;
}): void {
  state = {
    active: true,
    ackTimeoutMs: config.ackTimeoutMs,
    progressTimeoutMs: config.progressTimeoutMs,
    lanes: ["idle-lease", "acknowledged-silence"],
    acknowledgedSilence: { active: true },
  };
}

/** Read the current stall detection liveness state (for /health). */
export function getStallDetectionState(): StallDetectionState {
  return { ...state };
}

/** Test-only: reset state to defaults. */
export function resetStallDetectionStateForTest(): void {
  state = {
    active: false,
    ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
    progressTimeoutMs: DEFAULT_PROGRESS_TIMEOUT_MS,
    lanes: ["idle-lease", "acknowledged-silence"],
    acknowledgedSilence: { active: true },
  };
}

// INF-1333: promotion gate helpers (also reachable via stall-detection-state import)
export function isPromotionBlockedByStall(args: { stalledCount: number; stalledTickets?: string[] } | number): boolean {
  const count = typeof args === "number" ? args : (args?.stalledCount ?? 0);
  return count > 0;
}

export function getPromotionGateHealth(args: { stalledCount: number; stalledTickets?: string[] }): { blocked: boolean; blockedByStall: boolean; stalledCount: number; stalledTickets: string[] } {
  const count = typeof args === "number" ? args : (args?.stalledCount ?? 0);
  const tickets = typeof args === "number" ? [] : (args?.stalledTickets ?? []);
  const blocked = count > 0;
  return { blocked, blockedByStall: blocked, stalledCount: count, stalledTickets: tickets };
}

export const getStallPromotionGateHealth = getPromotionGateHealth;
export const isStallBlockingPromotion = isPromotionBlockedByStall;

