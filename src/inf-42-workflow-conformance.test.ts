/**
 * INF-42 AC3 / AC4 / AC5 / AC6 — Workflow-def conformance invariants.
 *
 * The conformance checker (workflow-conformance.ts) validates structural
 * invariants over registered workflow defs:
 *
 *   AC3 — barrier states declare barrier: true
 *   AC4 — every path to a barrier:true state is preceded by a fanout
 *   AC5 — invariant_skip waiver mechanism with recognized/invalid keys
 *   AC6 — external fixture tests (fast, CI-safe) covering all edge cases
 *
 * These tests WILL fail until workflow-conformance.ts exists and exports the
 * functions named below. The implementation belongs to the dev body (igor).
 *
 * @module inf-42-workflow-conformance.test
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { loadWorkflowRegistry, resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import type { WorkflowDef } from "./workflow-gate.js";

// ══════════════════════════════════════════════════════════════════════════
// Fixture workflow defs (inline YAML strings per AC6)
// ══════════════════════════════════════════════════════════════════════════

/**
 * A valid def that passes all invariants:
 *   - managing is a barrier state with barrier: true
 *   - spawning (predecessor of managing) has a fanout
 */
const VALID_DEF_YAML = `id: test-def
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: spawning
  - id: spawning
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: findings
      child_workflow: wf:dev-impl
    transitions:
      - command: spawn
        to: managing
  - id: managing
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - command: complete
        to: done
  - id: done
    native_state: done
`;

/**
 * A def with a waived barrier-before-managing invariant:
 *   - managing is barrier: true
 *   - intake transitions directly to managing with no fanout
 *   - invariant_skip: ["barrier-before-managing"] waives the check
 */
const WAIVED_BARRIER_DEF_YAML = `id: waived-barrier-def
version: 1
entry_state: intake
invariant_skip:
  - barrier-before-managing
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: managing
  - id: managing
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - command: complete
        to: done
  - id: done
    native_state: done
`;

/**
 * A def with a waived fanout-before-barrier invariant:
 *   - managing is barrier: true
 *   - intake transitions directly to managing with no fanout
 *   - invariant_skip: ["fanout-before-barrier"] waives the check
 */
const WAIVED_FANOUT_DEF_YAML = `id: waived-fanout-def
version: 1
entry_state: intake
invariant_skip:
  - fanout-before-barrier
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: managing
  - id: managing
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - command: complete
        to: done
  - id: done
    native_state: done
`;

/**
 * A def with an UNRECOGNIZED waiver key:
 *   - invariant_skip: ["nonexistent-key"]
 *   - MUST cause a hard validation failure (no silent misspellings)
 */
const UNRECOGNIZED_WAIVER_KEY_DEF_YAML = `id: unrecognized-waiver-def
version: 1
entry_state: intake
invariant_skip:
  - nonexistent-key
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: done
  - id: done
    native_state: done
`;

/**
 * A def with a barrier state (managing) that does NOT declare barrier: true
 * — the invariant must catch it.
 */
const MISSING_BARRIER_TRUE_DEF_YAML = `id: missing-barrier-true
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: managing
  - id: managing
    owner_role: engine
    native_state: managing
    # DOES NOT declare barrier: true — this is the Defect A class
    transitions:
      - command: complete
        to: done
  - id: done
    native_state: done
`;

/**
 * A def with a barrier state that has a predecessor without fanout, and no
 * waiver — the fanout-before-barrier invariant must catch it.
 */
const MISSING_FANOUT_BEFORE_BARRIER_DEF_YAML = `id: missing-fanout-before-barrier
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: managing
  - id: managing
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - command: complete
        to: done
  - id: done
    native_state: done
`;

/**
 * A def with an inline fixture that should pass all invariants when the
 * loaded def is syntactically valid but semantically empty (no barrier states).
 */
const NO_BARRIER_DEF_YAML = `id: no-barrier-def
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    native_state: doing
    transitions:
      - command: submit
        to: done
  - id: done
    native_state: done
`;

// ══════════════════════════════════════════════════════════════════════════
// Helper to write an inline YAML fixture to a temp dir
// ══════════════════════════════════════════════════════════════════════════

let tmpDir: string;
let defsDir: string;
const savedEnv: Record<string, string | undefined> = {};

function pushEnv(...keys: string[]): void {
  for (const k of keys) savedEnv[k] = process.env[k];
}
function popEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  pushEnv("WORKFLOW_DEFS_DIR", "WORKFLOW_DEF_PATH", "WORKFLOW_DEF_STATE_SNAPSHOT_PATH", "DATA_DIR");
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-42-conformance-"));
  defsDir = path.join(tmpDir, "defs");
  fs.mkdirSync(defsDir, { recursive: true });
  process.env.WORKFLOW_DEFS_DIR = defsDir;
  resetWorkflowCache();
  resetConfigHealth();
});

afterEach(() => {
  popEnv();
  resetWorkflowCache();
  resetConfigHealth();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a named YAML fixture to the temp defs directory.
 */
function writeDef(filename: string, yamlText: string): void {
  fs.writeFileSync(path.join(defsDir, filename), yamlText);
}

/**
 * Load all defs from the temp defs directory via the engine's registry loader.
 */
async function loadDefs(): Promise<Map<string, WorkflowDef>> {
  return loadWorkflowRegistry();
}

// ══════════════════════════════════════════════════════════════════════════
// AC5: Waiver mechanism — invariant_skip in def schema
// ══════════════════════════════════════════════════════════════════════════

describe("INF-42 AC5 — invariant_skip waiver mechanism parsing", () => {
  it("accepts known waiver keys: barrier-before-managing, fanout-before-barrier", async () => {
    // AC5: invariant_skip with recognized keys loads without error and the
    // corresponding invariants are skipped for that def.
    const { parseWaivers } = await import("./workflow-conformance.js") as {
      parseWaivers: (def: WorkflowDef) => { skip: Set<string>; errors: string[] };
    };

    writeDef("waived-barrier.yaml", WAIVED_BARRIER_DEF_YAML);
    writeDef("waived-fanout.yaml", WAIVED_FANOUT_DEF_YAML);
    const registry = await loadDefs();

    for (const [, def] of registry) {
      const { skip, errors } = parseWaivers(def);
      expect(errors).toEqual([]);
      if (def.invariant_skip?.includes("barrier-before-managing")) {
        expect(skip.has("barrier-before-managing")).toBe(true);
      }
      if (def.invariant_skip?.includes("fanout-before-barrier")) {
        expect(skip.has("fanout-before-barrier")).toBe(true);
      }
    }
  });

  it("rejects an unrecognized waiver key with a hard validation failure", async () => {
    // AC5: any unrecognized key in invariant_skip causes a hard failure —
    // no silent misspellings, no silent third category (INF-33 AC2).
    const { checkDefWaivers } = await import("./workflow-conformance.js") as {
      checkDefWaivers: (def: WorkflowDef) => string[];
    };

    writeDef("bad-waiver.yaml", UNRECOGNIZED_WAIVER_KEY_DEF_YAML);
    const registry = await loadDefs();

    // The def with a bad waiver key must either be excluded from the registry
    // OR produce an error when checked. Either is acceptable — what matters
    // is the hard failure, not the mechanism.
    if (registry.has("unrecognized-waiver-def")) {
      const def = registry.get("unrecognized-waiver-def")!;
      const errors = checkDefWaivers(def);
      expect(errors.length).toBeGreaterThan(0);
    } else {
      // Excluded from registry = hard failure (not soft/silent). Test passes.
      expect(true).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC3: Structural invariant — barrier states declare barrier: true
// ══════════════════════════════════════════════════════════════════════════

describe("INF-42 AC3 — barrier states declare barrier: true", () => {
  it("passes when every barrier-referencing state declares barrier: true", async () => {
    // A def that only has states without barrier references — vacuously passes.
    const { checkBarrierDeclaredInvariant } = await import("./workflow-conformance.js") as {
      checkBarrierDeclaredInvariant: (def: WorkflowDef, skip?: Set<string>) => string[];
    };

    writeDef("valid.yaml", VALID_DEF_YAML);
    const registry = await loadDefs();

    for (const [, def] of registry) {
      const errors = checkBarrierDeclaredInvariant(def);
      expect(errors).toEqual([]);
    }
  });

  it("fails when a managing state (barrier target) does NOT declare barrier: true", async () => {
    // Defect A class: a state whose transitions target a barrier-referencing
    // state, but the target state itself does not declare barrier: true.
    // The engine reads the field, never deriving from native_state: managing.
    const { checkBarrierDeclaredInvariant } = await import("./workflow-conformance.js") as {
      checkBarrierDeclaredInvariant: (def: WorkflowDef, skip?: Set<string>) => string[];
    };

    writeDef("missing-barrier-true.yaml", MISSING_BARRIER_TRUE_DEF_YAML);
    const registry = await loadDefs();

    // The def must either be excluded from the registry (if the validator runs
    // at load time) or produce an invariant error when checked.
    if (registry.has("missing-barrier-true")) {
      const def = registry.get("missing-barrier-true")!;
      const errors = checkBarrierDeclaredInvariant(def);
      expect(errors.length).toBeGreaterThan(0);
      // The error message should name the state that's missing barrier: true
      const allErrors = errors.join(" ");
      expect(allErrors).toMatch(/managing/);
    } else {
      // Excluded = fail-closed. Acceptable.
      expect(true).toBe(true);
    }
  });

  it("waived barrier-before-managing def does not produce errors", async () => {
    // When invariant_skip includes barrier-before-managing, the invariant
    // check should be skipped for that def.
    const { checkBarrierDeclaredInvariant, parseWaivers } = await import("./workflow-conformance.js") as {
      checkBarrierDeclaredInvariant: (def: WorkflowDef, skip?: Set<string>) => string[];
      parseWaivers: (def: WorkflowDef) => { skip: Set<string>; errors: string[] };
    };

    writeDef("waived-barrier.yaml", WAIVED_BARRIER_DEF_YAML);
    const registry = await loadDefs();

    for (const [, def] of registry) {
      const { skip } = parseWaivers(def);
      const errors = checkBarrierDeclaredInvariant(def, skip);
      expect(errors).toEqual([]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC4: Structural invariant — fanout before barrier
// ══════════════════════════════════════════════════════════════════════════

describe("INF-42 AC4 — fanout before barrier", () => {
  it("passes when every path to a barrier state has a fanout predecessor", async () => {
    const { checkFanoutBeforeBarrierInvariant } = await import("./workflow-conformance.js") as {
      checkFanoutBeforeBarrierInvariant: (def: WorkflowDef, skip?: Set<string>) => string[];
    };

    writeDef("valid.yaml", VALID_DEF_YAML);
    const registry = await loadDefs();

    for (const [, def] of registry) {
      const errors = checkFanoutBeforeBarrierInvariant(def);
      expect(errors).toEqual([]);
    }
  });

  it("fails when a barrier state has a predecessor without a fanout and no waiver", async () => {
    // intake → managing with no fanout on intake, and no waiver.
    const { checkFanoutBeforeBarrierInvariant } = await import("./workflow-conformance.js") as {
      checkFanoutBeforeBarrierInvariant: (def: WorkflowDef, skip?: Set<string>) => string[];
    };

    writeDef("missing-fanout.yaml", MISSING_FANOUT_BEFORE_BARRIER_DEF_YAML);
    const registry = await loadDefs();

    if (registry.has("missing-fanout-before-barrier")) {
      const def = registry.get("missing-fanout-before-barrier")!;
      const errors = checkFanoutBeforeBarrierInvariant(def);
      expect(errors.length).toBeGreaterThan(0);
      const allErrors = errors.join(" ");
      expect(allErrors).toMatch(/managing/);
      expect(allErrors).toMatch(/fanout/);
    } else {
      expect(true).toBe(true);
    }
  });

  it("passes when the fanout-before-barrier invariant is waived", async () => {
    const { checkFanoutBeforeBarrierInvariant, parseWaivers } = await import("./workflow-conformance.js") as {
      checkFanoutBeforeBarrierInvariant: (def: WorkflowDef, skip?: Set<string>) => string[];
      parseWaivers: (def: WorkflowDef) => { skip: Set<string>; errors: string[] };
    };

    writeDef("waived-fanout.yaml", WAIVED_FANOUT_DEF_YAML);
    const registry = await loadDefs();

    for (const [, def] of registry) {
      const { skip } = parseWaivers(def);
      const errors = checkFanoutBeforeBarrierInvariant(def, skip);
      expect(errors).toEqual([]);
    }
  });

  it("vacuously passes when a def has no barrier states", async () => {
    const { checkFanoutBeforeBarrierInvariant } = await import("./workflow-conformance.js") as {
      checkFanoutBeforeBarrierInvariant: (def: WorkflowDef, skip?: Set<string>) => string[];
    };

    writeDef("no-barrier.yaml", NO_BARRIER_DEF_YAML);
    const registry = await loadDefs();

    for (const [, def] of registry) {
      const errors = checkFanoutBeforeBarrierInvariant(def);
      expect(errors).toEqual([]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC6: External fixture tests — edge cases
// ══════════════════════════════════════════════════════════════════════════

describe("INF-42 AC6 — fixture-based edge case coverage", () => {
  it("runs all invariants across a valid def reporting zero failures", async () => {
    const { checkDefConformance } = await import("./workflow-conformance.js") as {
      checkDefConformance: (def: WorkflowDef) => { ok: boolean; errors: string[] };
    };

    writeDef("valid.yaml", VALID_DEF_YAML);
    const registry = await loadDefs();

    for (const [, def] of registry) {
      const result = checkDefConformance(def);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });

  it("reports errors for a def with multiple invariant violations", async () => {
    // A def that fails BOTH barrier-declared and fanout-before-barrier.
    const MULTI_VIOLATION_DEF = `id: multi-violation
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: managing
  - id: managing
    owner_role: engine
    native_state: managing
    # No barrier: true (violation 1)
    transitions:
      - command: complete
        to: review
  - id: review
    owner_role: reviewer
    native_state: review
    barrier: true
    transitions:
      - command: approve
        to: done
  - id: done
    native_state: done
`;

    const { checkDefConformance } = await import("./workflow-conformance.js") as {
      checkDefConformance: (def: WorkflowDef) => { ok: boolean; errors: string[] };
    };

    writeDef("multi-violation.yaml", MULTI_VIOLATION_DEF);
    const registry = await loadDefs();

    if (registry.has("multi-violation")) {
      const def = registry.get("multi-violation")!;
      const result = checkDefConformance(def);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    } else {
      // Excluded from registry because of the bad def. Acceptable.
      expect(true).toBe(true);
    }
  });

  it("loads from a nonexistent directory with a graceful error (not a crash)", async () => {
    // AC6: loading a nonexistent dir should not crash the process.
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = "/nonexistent/path/defs/workflow.yaml";

    resetWorkflowCache();
    resetConfigHealth();

    await expect(loadDefs()).rejects.toThrow();
    // The important thing is it throws rather than crashing or hanging.
  });
});
