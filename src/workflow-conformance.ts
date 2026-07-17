/**
 * INF-42 — Workflow def conformance validator.
 *
 * STUB: This file is the implementer's target. It will be filled in by the
 * implementer (igor) to make the tests in inf-42-registered-defs-conformance.test.ts pass.
 *
 * ── Intended API contract (driven by tests) ───────────────────────────────
 *
 *   validateWorkflowDef(def, file?):
 *     Runs all structural invariants (barrier:true, fanout-before-barrier,
 *     invariant_skip, child_workflow resolution). Returns a ConformanceResult.
 *
 *   validateAllRegisteredDefs(dir?):
 *     Iterates every .yaml in the directory, calls validateWorkflowDef on each,
 *     returns results.
 *
 *   ACCEPTED_WAIVER_KEYS:
 *     ["barrier-before-managing", "fanout-before-barrier"]
 *
 * ── Invariants enforced ───────────────────────────────────────────────────
 *   barrier-before-managing:  every state whose transitions include a next
 *     state with barrier:true must carry barrier:true itself.
 *   fanout-before-barrier:    every direct predecessor of a barrier:true state
 *     must declare a fanout: section.
 *   invariant_skip:           unrecognized waiver keys cause hard failure.
 *   child-workflow-resolution: every fanout.child_workflow must resolve to a
 *     registered workflow def (wf: prefix + existence in the registry).
 */

import type { WorkflowDef } from "./workflow-gate.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConformanceError {
  invariant: string;
  message: string;
  state?: string;
}

export interface ConformanceResult {
  defId: string;
  file: string;
  valid: boolean;
  errors: ConformanceError[];
}

// ── Accepted waiver keys ───────────────────────────────────────────────────

export const ACCEPTED_WAIVER_KEYS: readonly string[] = [
  "barrier-before-managing",
  "fanout-before-barrier",
];

// ── Stub: implementer fills these in ───────────────────────────────────────

/**
 * Validate a single workflow def against all structural invariants.
 */
export function validateWorkflowDef(_def: WorkflowDef, _file?: string): ConformanceResult {
  // TODO: implement — this is the implementer's target
  throw new Error("NOT_IMPLEMENTED: validateWorkflowDef");
}

/**
 * Validate all registered defs in a directory against all structural invariants.
 */
export function validateAllRegisteredDefs(_dir?: string): ConformanceResult[] {
  // TODO: implement — this is the implementer's target
  throw new Error("NOT_IMPLEMENTED: validateAllRegisteredDefs");
}
