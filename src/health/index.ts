/**
 * ContractEngine — composes contract definitions, classifier, and store.
 *
 * STUB — implementation pending.
 *
 * Child of INF-317 (Contract Engine).
 */

import type { GateId } from "./health-types.js";
import type { LifecycleContract } from "./contract-definitions.js";
import type { SignalInput, ClassifyResult } from "./health-classifier.js";
import type { ContractStore } from "./contract-store.js";

export interface ContractEngineConfig {
  contractOverrides?: LifecycleContract[];
  store?: ContractStore;
  defaultWorkflowKey?: string;
}

export class ContractEngine {
  constructor(_config?: ContractEngineConfig) {
    throw new Error("Not implemented: ContractEngine");
  }

  getContract(_gateId: GateId): LifecycleContract | undefined {
    throw new Error("Not implemented: ContractEngine.getContract");
  }

  evaluate(_gateId: GateId, _input: SignalInput): ClassifyResult {
    throw new Error("Not implemented: ContractEngine.evaluate");
  }

  evaluateAll(_inputGetter: (gateId: GateId) => SignalInput): ClassifyResult[] {
    throw new Error("Not implemented: ContractEngine.evaluateAll");
  }

  async persistContracts(_key: string, _contracts: LifecycleContract[]): Promise<void> {
    throw new Error("Not implemented: ContractEngine.persistContracts");
  }

  async loadContracts(_key: string): Promise<LifecycleContract[]> {
    throw new Error("Not implemented: ContractEngine.loadContracts");
  }
}
