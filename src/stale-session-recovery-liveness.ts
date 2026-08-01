/**
 * INF-979 (AC4 / AI-1808) — Liveness for the stale-session recovery driver and
 * the governed-redispatch delegate re-seat guard.
 *
 * This ticket changes event-driven/background behavior (the stale-session
 * recovery driver that preserves owned delegates, and the setStateAtomic re-seat
 * guard that bootstrap-seats a null delegate). A module-level unit test cannot
 * prove those paths are wired at the production entry point, so the fields below
 * flip true ONLY at the real bootstrap wiring points inside createApp() — never
 * as detached literals — and are projected onto GET /health. ac-validate can then
 * confirm the wiring without waiting for a stale session to fire.
 */

export interface StaleSessionRecoveryLiveness {
  /** The stale-session recovery driver (SessionTracker) was constructed at bootstrap. */
  driverRegistered: boolean;
  /** The stale-session handler callback (processStaleSession) is subscribed to the driver. */
  staleSessionHandlerSubscribed: boolean;
  /** The governed-redispatch delegate re-seat guard (setStateAtomic bootstrap-seat) is active in this build. */
  governedRedispatchReseatActive: boolean;
}

const state: StaleSessionRecoveryLiveness = {
  driverRegistered: false,
  staleSessionHandlerSubscribed: false,
  governedRedispatchReseatActive: false,
};

/** Marked at SessionTracker construction — the recovery driver exists in prod. */
export function markStaleSessionRecoveryDriverRegistered(): void {
  state.driverRegistered = true;
}

/** Marked when the stale-session handler callback is subscribed to the driver. */
export function markStaleSessionHandlerSubscribed(): void {
  state.staleSessionHandlerSubscribed = true;
}

/** Marked when the governed-redispatch re-seat guard is wired onto the transition path. */
export function markGovernedRedispatchReseatActive(): void {
  state.governedRedispatchReseatActive = true;
}

export function getStaleSessionRecoveryLiveness(): StaleSessionRecoveryLiveness {
  return { ...state };
}

/** Test-isolation reset — clears the marks between synthetic boots. */
export function resetStaleSessionRecoveryLiveness(): void {
  state.driverRegistered = false;
  state.staleSessionHandlerSubscribed = false;
  state.governedRedispatchReseatActive = false;
}
