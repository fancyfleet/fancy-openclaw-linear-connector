/**
 * INF-42 — Workflow def conformance validator.
 *
 * Validates registered workflow definitions against structural invariants:
 *   - barrier states must declare barrier: true
 *   - every path into a barrier state must be preceded by a fanout
 *   - invariant_skip waiver keys must be recognized
 *   - fanout.child_workflow must resolve to a registered def
 *
 * ── Topology (Astrid-approved 2026-07-17) ─────────────────────────────────
 *   (c) + partial (a): validator ships in-repo, reads from src/registered-defs/
 *   in CI and WORKFLOW_DEFS_DIR on the host. Deploy gate = diff check.
 *
 * ── Invariants enforced ───────────────────────────────────────────────────
 *   barrier-before-managing:  every state in a def that has a transition to a
 *     barrier state must itself declare barrier: true on that destination.
 *   fanout-before-barrier:    every direct predecessor of a barrier:true state
 *     must declare a fanout: section.
 *   invariant_skip:           unrecognized waiver keys cause hard failure.
 *   child-workflow-resolution: every fanout.child_workflow must resolve to a
 *     registered workflow def (wf: prefix + existence in the registry).
 */

import fs from "node:fs";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import type { WorkflowDef, WorkflowState } from "./workflow-gate.js";
import { getCachedRegistrySync } from "./workflow-gate.js";

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

const FROZEN_ENGINE_PRIMITIVES = [
  "workflow-registration",
  "governed-transitions",
  "guards",
  "fan-out",
  "barrier-join",
  "terminal-reachability",
  "dispatch-wake",
  "idempotency-mutex",
  "parenting-reparenting",
  "role-delegate-resolution",
  "escape-break-glass",
] as const;

interface CapabilityPolicyBody {
  id: string;
  fills_roles?: string[];
}

interface CapabilityPolicy {
  bodies?: CapabilityPolicyBody[];
  roles?: Array<{ id: string; synthetic?: boolean; no_body?: boolean }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build index of state by id for quick lookup. */
function indexStates(states: WorkflowState[]): Map<string, WorkflowState> {
  const map = new Map<string, WorkflowState>();
  for (const s of states) {
    map.set(s.id, s);
  }
  return map;
}

/** Check whether a waiver is declared for a given invariant on a def. */
function hasWaiver(def: WorkflowDef, invariantKey: string): boolean {
  const skips = (def as unknown as Record<string, unknown>).invariant_skip as string[] | undefined;
  return Array.isArray(skips) && skips.includes(invariantKey);
}

/** Get the set of waiver keys from a def. */
function getWaiverKeys(def: WorkflowDef): string[] {
  return Array.isArray((def as unknown as Record<string, unknown>).invariant_skip)
    ? ((def as unknown as Record<string, unknown>).invariant_skip as string[])
    : [];
}

/** Determine if a state effectively declares barrier: true (truthy only, not just present). */
function isBarrier(state: WorkflowState): boolean {
  return (state as unknown as Record<string, unknown>).barrier === true;
}

/** Check if a state has a fanout section. */
function hasFanout(state: WorkflowState): boolean {
  return state.fanout !== undefined && state.fanout !== null;
}

/**
 * A transition INTO a terminal state is a governed exit, not a fanout barrier
 * edge. The fanout-before-barrier / barrier-before-managing invariants exist to
 * protect *managing* barriers — a state that waits on children its immediate
 * predecessor spawned. A terminal state is an endpoint: it never waits on
 * children, so entering one never requires a predecessor fanout, regardless of
 * the command that gets there (cancel/abandon → cancelled, INF-453; converge →
 * done, INF-504). The `barrier: true` flag on a terminal state means
 * `satisfies_parent_barrier`, not "waits on children" — a distinct concept the
 * fanout invariants must not conflate. Keying on the target's terminal kind
 * (not an allowlist of command names) keeps a new governed terminal edge from
 * tripping the invariant while it is exactly what the edge is designed to do.
 */
function isTerminalTransition(
  transition: { command?: string; generic?: string; to?: string },
  targetState?: WorkflowState,
): boolean {
  const targetKind = (targetState as unknown as Record<string, unknown> | undefined)?.kind;
  return targetKind === "terminal";
}

/**
 * Get the set of registered def IDs from the gateway's cached registry.
 * Returns undefined if the registry hasn't been loaded yet this process lifetime.
 */
function getRegisteredDefIdsSync(): Set<string> | undefined {
  const cache = getCachedRegistrySync();
  if (cache === null || cache === undefined) return undefined;
  return new Set(cache.keys());
}

function loadCapabilityPolicySync(): CapabilityPolicy | null {
  const policyPath = process.env.CAPABILITY_POLICY_PATH;
  if (!policyPath) return null;

  try {
    const raw = fs.readFileSync(policyPath, "utf8");
    const parsed = yamlLoad(raw) as CapabilityPolicy;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function bodiesForRole(policy: CapabilityPolicy | null, roleId: string): string[] | undefined {
  if (!policy) return undefined;
  return (policy.bodies ?? [])
    .filter((body) => Array.isArray(body.fills_roles) && body.fills_roles.includes(roleId))
    .map((body) => body.id);
}

function roleIsDeclared(policy: CapabilityPolicy, roleId: string): boolean {
  return (policy.roles ?? []).some((role) => role.id === roleId);
}

function roleIsSyntheticNoBody(policy: CapabilityPolicy, roleId: string): boolean {
  const role = (policy.roles ?? []).find((candidate) => candidate.id === roleId);
  return Boolean(role && role.synthetic === true && role.no_body === true);
}

function transitionDeclaresSelectionCriteria(transition: NonNullable<WorkflowState["transitions"]>[number]): boolean {
  return Boolean(
    transition.assign &&
      (
        Boolean(transition.assign.default) ||
        Boolean(transition.assign.constraint) ||
        (typeof transition.assign.selection_criteria === "string" && transition.assign.selection_criteria.trim().length > 0)
      ),
  );
}

// ── Invariant checks ──────────────────────────────────────────────────────

/**
 * AC3: Check that every barrier state declares barrier: true explicitly.
 * The engine reads barrier: true directly, never deriving from native_state.
 */
function checkBarrierInvariant(
  def: WorkflowDef,
  errors: ConformanceError[],
): void {
  if (hasWaiver(def, "barrier-before-managing")) return;

  // Build a set of target states that are reached from a fanout state
  const targetsFromFanout = new Set<string>();
  const stateIndex = indexStates(def.states);

  for (const state of def.states) {
    if (!state.transitions || !hasFanout(state)) continue;
    for (const t of state.transitions) {
      if (!t.to) continue;
      const targetState = stateIndex.get(t.to);
      if (isTerminalTransition(t, targetState)) continue;
      targetsFromFanout.add(t.to);
    }
  }

  // Any state that is a target from a fanout state must declare barrier: true
  for (const targetId of targetsFromFanout) {
    const targetState = stateIndex.get(targetId);
    if (!targetState) continue; // skip unresolvable targets
    if (!isBarrier(targetState)) {
      errors.push({
        invariant: "barrier-before-managing",
        message: `State '${targetId}' is reached from a fanout state but does not declare barrier: true. ` +
          `Add 'barrier: true' to state '${targetId}'.`,
        state: targetId,
      });
    }
  }
}

/**
 * AC4: Check that every path into a barrier:true state is preceded by a fanout
 * on the immediate predecessor.
 */
function checkFanoutBeforeBarrier(
  def: WorkflowDef,
  errors: ConformanceError[],
): void {
  if (hasWaiver(def, "fanout-before-barrier")) return;

  // Find all barrier states
  const barrierStateIds = new Set(
    def.states.filter((s) => isBarrier(s)).map((s) => s.id),
  );
  const stateIndex = indexStates(def.states);

  if (barrierStateIds.size === 0) return;

  // For each state that has a transition to a barrier, check it has a fanout
  for (const state of def.states) {
    if (!state.transitions) continue;
    for (const t of state.transitions) {
      if (!t.to) continue;
      if (barrierStateIds.has(t.to)) {
        if (isTerminalTransition(t, stateIndex.get(t.to))) continue;
        if (!hasFanout(state)) {
          errors.push({
            invariant: "fanout-before-barrier",
            message: `State '${state.id}' transitions to barrier state '${t.to}' but has no 'fanout:' section. ` +
              `Every direct predecessor of a barrier:true state must declare a fanout.`,
            state: state.id,
          });
        }
      }
    }
  }
}

/**
 * AC5: Check that all invariant_skip waiver keys are recognized.
 * Unrecognized keys cause hard failure — no silent misspellings.
 */
function checkWaiverKeys(
  def: WorkflowDef,
  errors: ConformanceError[],
): void {
  const waiverKeys = getWaiverKeys(def);
  if (waiverKeys.length === 0) return;

  const acceptedSet = new Set(ACCEPTED_WAIVER_KEYS);
  const unrecognized = waiverKeys.filter((k) => !acceptedSet.has(k));

  if (unrecognized.length > 0) {
    errors.push({
      invariant: "invariant_skip",
      message: `Unrecognized invariant_skip key(s): ${unrecognized.join(", ")}. ` +
        `Accepted keys: ${ACCEPTED_WAIVER_KEYS.join(", ")}.`,
    });
  }
}

/**
 * AC7: Check child_workflow wf: prefix + resolve against cached registry.
 * Works both synchronously (if registry is cached) and as prefix-only fallback.
 */
function checkChildWorkflowSync(
  def: WorkflowDef,
  errors: ConformanceError[],
): void {
  const wfLabelPattern = /^wf:.+/;
  const registeredIds = getRegisteredDefIdsSync();

  for (const state of def.states) {
    if (!state.fanout) continue;
    const childWf = state.fanout.child_workflow;
    if (!childWf) continue;

    // Must have wf: prefix
    if (typeof childWf !== "string" || !wfLabelPattern.test(childWf)) {
      errors.push({
        invariant: "child-workflow-resolution",
        message: `State '${state.id}' fanout.child_workflow '${String(childWf)}' is not a valid wf:* label.`,
        state: state.id,
      });
      continue;
    }

    // If we have a cached registry, check resolution
    if (registeredIds) {
      const defId = childWf.slice(3); // "wf:dev-impl" → "dev-impl"
      if (!registeredIds.has(defId)) {
        errors.push({
          invariant: "child-workflow-resolution",
          message: `State '${state.id}' fanout.child_workflow '${childWf}' resolves to '${defId}' which is not a registered workflow def.`,
          state: state.id,
        });
      }
    }
  }
}

function checkEnginePrimitiveMatrix(
  def: WorkflowDef,
  errors: ConformanceError[],
): void {
  const rawPrimitives = (def as unknown as Record<string, unknown>).x_engine_primitives;
  if (def.archetype !== "engine-primitive-matrix" && rawPrimitives === undefined) return;

  if (!Array.isArray(rawPrimitives)) {
    errors.push({
      invariant: "engine-primitive-matrix",
      message: `Workflow '${def.id}' must declare x_engine_primitives with the frozen primitive matrix.`,
    });
    return;
  }

  const primitives = rawPrimitives.filter((value): value is string => typeof value === "string");
  const frozenPrimitiveSet = new Set<string>(FROZEN_ENGINE_PRIMITIVES);
  const missing = FROZEN_ENGINE_PRIMITIVES.filter((primitive) => !primitives.includes(primitive));
  const unknown = primitives.filter((primitive) => !frozenPrimitiveSet.has(primitive));
  if (missing.length > 0 || unknown.length > 0 || primitives.length !== rawPrimitives.length) {
    errors.push({
      invariant: "engine-primitive-matrix",
      message:
        `Workflow '${def.id}' must declare exactly the frozen engine primitive matrix. ` +
        `Missing: ${missing.length ? missing.join(", ") : "none"}. ` +
        `Unknown/non-string: ${unknown.length ? unknown.join(", ") : "none"}.`,
    });
  }
}

function checkDelegateResolution(
  def: WorkflowDef,
  errors: ConformanceError[],
): void {
  const policy = loadCapabilityPolicySync();
  if (!policy) return;

  const incoming = new Map<string, NonNullable<WorkflowState["transitions"]>>();
  for (const state of def.states) {
    for (const transition of state.transitions ?? []) {
      const list = incoming.get(transition.to) ?? [];
      list.push(transition);
      incoming.set(transition.to, list);
    }
  }

  for (const state of def.states) {
    if (!state.owner_role || state.kind === "terminal") continue;

    const candidates = bodiesForRole(policy, state.owner_role) ?? [];
    if (candidates.length === 0) {
      if (!roleIsDeclared(policy, state.owner_role)) continue;
      if (roleIsSyntheticNoBody(policy, state.owner_role)) continue;
      errors.push({
        invariant: "delegate-resolution",
        message: `State '${state.id}' owner_role '${state.owner_role}' resolves to no bodies.`,
        state: state.id,
      });
      continue;
    }

    if (candidates.length > 1) {
      const entries = incoming.get(state.id) ?? [];
      for (const transition of entries) {
        if (!transitionDeclaresSelectionCriteria(transition)) {
          errors.push({
            invariant: "delegate-resolution",
            message:
              `State '${state.id}' owner_role '${state.owner_role}' resolves to multiple bodies ` +
              `(${candidates.join(", ")}); incoming transition '${transition.command}' must declare selection criteria.`,
            state: state.id,
          });
        }
      }
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate a single workflow def against structural invariants (sync).
 *
 * Checks:
 *   - Waiver keys (AC5)
 *   - barrier:true declaration (AC3)
 *   - fanout before barrier (AC4)
 *   - child_workflow wf: prefix + cached registry resolution (AC7)
 */
export function validateWorkflowDef(def: WorkflowDef, _file?: string): ConformanceResult {
  const errors: ConformanceError[] = [];
  const file = _file ?? def.id;

  // Waiver key validation first
  checkWaiverKeys(def, errors);

  // Structural invariants
  checkBarrierInvariant(def, errors);
  checkFanoutBeforeBarrier(def, errors);
  checkEnginePrimitiveMatrix(def, errors);
  checkDelegateResolution(def, errors);

  // Child_workflow sync check (wf: prefix + cached registry)
  checkChildWorkflowSync(def, errors);

  return {
    defId: def.id,
    file,
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate all registered defs in a directory against all structural invariants.
 *
 * Iterates every .yaml in the directory, loads it through the engine's YAML
 * parser, and runs validateWorkflowDef on each. Returns a ConformanceResult for
 * each def found.
 *
 * Handles nonexistent directories gracefully — returns an empty result array
 * (never crashes).
 */
export function validateAllRegisteredDefs(dir?: string): ConformanceResult[] {
  const defsDir = dir ?? process.env.WORKFLOW_DEFS_DIR ?? "";

  if (!defsDir) {
    return [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(defsDir);
  } catch {
    // Directory doesn't exist or is unreadable — graceful
    return [];
  }

  const yamlFiles = entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const results: ConformanceResult[] = [];

  for (const file of yamlFiles) {
    const fullPath = path.join(defsDir, file);
    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = yamlLoad(raw) as WorkflowDef;
      if (!parsed || typeof parsed !== "object" || !parsed.id) {
        results.push({
          defId: path.basename(file, path.extname(file)),
          file,
          valid: false,
          errors: [{
            invariant: "parse",
            message: `File '${file}' does not contain a valid workflow def (missing 'id' field).`,
          }],
        });
        continue;
      }

      const vResult = validateWorkflowDef(parsed, file);
      results.push(vResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        defId: path.basename(file, path.extname(file)),
        file,
        valid: false,
        errors: [{
          invariant: "load",
          message: `Failed to load '${file}': ${msg}`,
        }],
      });
    }
  }

  return results;
}
