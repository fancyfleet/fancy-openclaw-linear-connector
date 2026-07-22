/**
 * Contract store — durable persistence for contract definitions.
 *
 * STUB — implementation pending.
 *
 * Child of INF-317 (Contract Engine).
 */

import { type LifecycleContract } from "./contract-definitions.js";
import type { GateId } from "./health-types.js";

export interface ContractStore {
  get(key: string): Promise<LifecycleContract[]>;
  set(key: string, contracts: LifecycleContract[]): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * STUB — always throws Not Implemented.
 */
export class SqliteContractStore implements ContractStore {
  async get(_key: string): Promise<LifecycleContract[]> {
    throw new Error("Not implemented: SqliteContractStore.get");
  }
  async set(_key: string, _contracts: LifecycleContract[]): Promise<void> {
    throw new Error("Not implemented: SqliteContractStore.set");
  }
  async keys(): Promise<string[]> {
    throw new Error("Not implemented: SqliteContractStore.keys");
  }
}

/**
 * STUB — always throws Not Implemented.
 */
export class InMemoryContractStore implements ContractStore {
  async get(_key: string): Promise<LifecycleContract[]> {
    throw new Error("Not implemented: InMemoryContractStore.get");
  }
  async set(_key: string, _contracts: LifecycleContract[]): Promise<void> {
    throw new Error("Not implemented: InMemoryContractStore.set");
  }
  async keys(): Promise<string[]> {
    throw new Error("Not implemented: InMemoryContractStore.keys");
  }
  reset(): void {
    /* stub — no-op */
  }
}
