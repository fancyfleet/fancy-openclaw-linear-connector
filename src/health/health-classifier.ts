/**
 * Health classifier — maps gate actuals against contract definitions.
 *
 * STUB — implementation pending.
 *
 * Child of INF-317 (Contract Engine).
 */

import type { GateId, HealthStatus, HealthVerdict, LivenessSignal } from "./health-types.js";
import type { LifecycleContract } from "./contract-definitions.js";

export interface SignalInput {
  gateEnteredAt: number;
  signals: LivenessSignal[];
  queueDepth?: number;
  hasActiveTurn?: boolean;
  isBlocked?: boolean;
}

export interface ClassifyResult {
  gateId: GateId;
  verdict: HealthVerdict;
}

/**
 * STUB — throws Not Implemented.
 */
export function classifyGateHealth(
  _contract: LifecycleContract,
  _input: SignalInput,
): ClassifyResult {
  throw new Error("Not implemented: classifyGateHealth");
}
