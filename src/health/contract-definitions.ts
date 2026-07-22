/**
 * Typed contract definitions for per-lifecycle-edge contracts.
 *
 * STUB — implementation pending.
 *
 * Child of INF-317 (Contract Engine).
 */

import type { GateId, SignalType } from "./health-types.js";

export interface SuppressionRule {
  condition: "queued" | "working" | "blocked";
  maxDepth?: number;
  maxAgeMs?: number;
}

export interface LifecycleContract {
  label: string;
  gateId: GateId;
  expectedSignal: SignalType;
  deadlineMs: number;
  suppression: SuppressionRule[];
}

export interface ContractConfig {
  contracts: LifecycleContract[];
}

/** Default contract definitions — placeholder values for type checking. */
export const DEFAULT_CONTRACTS: LifecycleContract[] = [
  {
    label: "Gate 1 — dispatched → Thinking",
    gateId: "dispatched",
    expectedSignal: "Thinking",
    deadlineMs: 60_000,
    suppression: [
      { condition: "queued", maxDepth: 5, maxAgeMs: 30_000 },
      { condition: "blocked" },
    ],
  },
  {
    label: "Gate 2 — picked-up → activity",
    gateId: "picked-up",
    expectedSignal: "verb",
    deadlineMs: 300_000,
    suppression: [
      { condition: "working" },
      { condition: "blocked" },
    ],
  },
];

/**
 * STUB — throws Not Implemented.
 */
export function loadContractDefinitions(
  _overrides?: LifecycleContract[],
): LifecycleContract[] {
  throw new Error("Not implemented: loadContractDefinitions");
}
