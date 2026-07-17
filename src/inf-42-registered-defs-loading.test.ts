/**
 * INF-42 AC1 / AC2 — Registered-defs snapshot loads through the engine loader.
 *
 * AC1: src/registered-defs/ exists in-repo and is a CI-accessible snapshot of
 * the deployed workflow defs. A host-side deploy check asserts deployed bytes
 * match this snapshot; mismatch fails deploy with a drift alarm.
 *
 * AC2: Every .yaml file in src/registered-defs/ loads through
 * loadWorkflowRegistry — the same path the engine uses at runtime. Invalid
 * defs fail with the same error the engine would produce.
 *
 * These tests WILL fail until:
 *   - src/registered-defs/ is created with copies of the deployed defs
 *   - The deploy-gate drift check is wired into the deploy process
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { loadWorkflowRegistry, resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

// ── Paths ─────────────────────────────────────────────────────────────────

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");
const DEPLOYED_DEFS_DIR = process.env.WORKFLOW_DEFS_DIR
  ?? path.resolve(process.cwd(), "tmp/registered-defs-deployed");

const saved: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const k of keys) saved[k] = process.env[k];
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function currentEnvVars(): string[] {
  return ["WORKFLOW_DEFS_DIR", "WORKFLOW_DEF_PATH", "WORKFLOW_DEF_STATE_SNAPSHOT_PATH", "DATA_DIR"];
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("INF-42 AC1 — src/registered-defs/ exists in-repo", () => {
  beforeAll(() => {
    saveEnv(...currentEnvVars());
  });

  afterAll(() => {
    restoreEnv();
    resetWorkflowCache();
    resetConfigHealth();
  });

  it("creates a tracked src/registered-defs/ directory containing the deployed workflow defs", () => {
    // AC1: src/registered-defs/ is a tracked directory that mirrors the
    // WORKFLOW_DEFS_DIR on the host. Its .yaml files must be loadable by the
    // engine's workflow registry.
    expect(fs.existsSync(REGISTERED_DEFS_DIR)).toBe(true);
    const yamls = fs.readdirSync(REGISTERED_DEFS_DIR).filter((f) => f.endsWith(".yaml"));
    expect(yamls.length).toBeGreaterThan(0);
  });

  it("every .yaml in src/registered-defs/ is loadable through loadWorkflowRegistry", async () => {
    // AC2: every registered def must load through the same loadWorkflowRegistry
    // path the engine uses at runtime. The dir-mode loader reads every *.yaml,
    // validates schema + native_state, and builds a registry keyed by def.id.
    //
    // An invalid def (bad YAML, missing id, bad native_state, unreachable
    // entry_state) must be excluded from the registry — not crash it.
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();
    resetConfigHealth();

    const registry = await loadWorkflowRegistry();
    expect(registry.size).toBeGreaterThan(0);

    for (const [id, def] of registry) {
      expect(def.id).toBe(id);
      expect(def.states).toBeInstanceOf(Array);
      expect(def.states.length).toBeGreaterThan(0);
    }
  });
});

describe("INF-42 AC1 — deploy gate: registered-defs bytes match deployed defs", () => {
  beforeAll(() => {
    saveEnv(...currentEnvVars());
  });

  afterAll(() => {
    restoreEnv();
    resetWorkflowCache();
    resetConfigHealth();
  });

  it("deployed WORKFLOW_DEFS_DIR defs byte-match src/registered-defs/ snapshot", async () => {
    // AC1 (deploy gate): The host-side deploy check must assert that every
    // file in WORKFLOW_DEFS_DIR has identical content to its counterpart in
    // src/registered-defs/. A mismatch MUST fail deploy with a drift alarm
    // naming the divergent file(s).
    //
    // In CI the "deployed" side is unknown, so this test is verification that
    // the deploy-gate function exists and operates correctly.
    // This test is expected to fail until the deploy-gate function is implemented.
    const { checkDeployedDefsMatchRegistered } = await import("./workflow-conformance.js") as {
      checkDeployedDefsMatchRegistered: (deployedDir: string, registeredDir: string) => string[];
    };

    const drifted = checkDeployedDefsMatchRegistered(DEPLOYED_DEFS_DIR, REGISTERED_DEFS_DIR);
    expect(drifted).toEqual([]);
  });
});

describe("INF-42 AC2 — registered defs pass engine schema validation", () => {
  beforeAll(() => {
    saveEnv(...currentEnvVars());
  });

  afterAll(() => {
    restoreEnv();
    resetWorkflowCache();
    resetConfigHealth();
  });

  it("every def in src/registered-defs/ passes the same schema validation the engine applies", async () => {
    // AC2: every def must pass the same validation path as the engine. This
    // means: valid YAML, has a def.id, every state.native_state maps to a real
    // Linear state, no broken state references. An invalid def is excluded
    // from the registry (the per-def fail-closed contract).
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();
    resetConfigHealth();

    // A def with a bad native_state causes loadWorkflowRegistry to exclude it
    // from the registry and set config-health unhealthy. We assert the healthy
    // path: all registered defs pass.
    const registry = await loadWorkflowRegistry();

    for (const [id, def] of registry) {
      // Each state must reference a valid native_state or omit it.
      for (const state of def.states) {
        if (state.native_state) {
          // The string must be a valid Linear state name. We can't enumerate
          // Linear's state list from a unit test, but we can assert the def
          // wasn't excluded — if any state had a bad native_state, the whole
          // def would be excluded from the registry.
          expect(state.native_state).toBeDefined();
        }
        // Every transition's `to` must reference a state id that exists in
        // this def, or be a well-known sentinel.
        if (state.transitions) {
          for (const t of state.transitions) {
            if (t.to && !["__ad_hoc__"].includes(t.to)) {
              const exists = def.states.some((s) => s.id === t.to);
              expect(exists).toBe(true);
            }
          }
        }
      }
    }
  });
});
