/**
 * INF-1167 — dev-impl has no `doing` commitment gate.
 *
 * Failing tests for the AC of record. Implementation work belongs to Igor.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "@jest/globals";
import type { WorkflowDef, WorkflowState } from "./workflow-gate.js";
import { planDefStateMigration } from "./def-state-migration.js";

const DEV_IMPL_DEF_PATHS = [
  path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml"),
  path.resolve(process.cwd(), "src/registered-defs/dev-impl.yaml"),
];

function readDef(file: string): WorkflowDef {
  return yaml.load(fs.readFileSync(file, "utf8")) as WorkflowDef;
}

function implementationState(def: WorkflowDef): WorkflowState {
  const state = def.states.find((s) => s.id === "implementation");
  expect(state).toBeDefined();
  return state!;
}

function transitionTo(def: WorkflowDef, stateId: string, command: string): string | undefined {
  return def.states.find((s) => s.id === stateId)?.transitions?.find((t) => t.command === command)?.to;
}

describe("INF-1167 AC1: dev-impl definition removes the off-spec doing commitment gate", () => {
  it.each(DEV_IMPL_DEF_PATHS)("%s has no doing state and no commitment_gate", (file) => {
    const def = readDef(file);
    expect(def.id).toBe("dev-impl");

    expect(def.states.map((s) => s.id)).not.toContain("doing");
    expect((implementationState(def) as WorkflowState & { commitment_gate?: unknown }).commitment_gate).toBeUndefined();
  });
});

describe("INF-1167 AC2: implementation submits directly to code-review in one hop", () => {
  it.each(DEV_IMPL_DEF_PATHS)("%s has no accept gate between implementation and code-review", (file) => {
    const def = readDef(file);

    expect(transitionTo(def, "implementation", "submit")).toBe("code-review");
    expect(transitionTo(def, "implementation", "accept")).toBeUndefined();
    expect(def.states.flatMap((s) => s.transitions ?? []).filter((t) => t.to === "doing")).toEqual([]);
  });
});

describe("INF-1167 AC3: implementation still supports reject and not-ready", () => {
  it.each(DEV_IMPL_DEF_PATHS)("%s keeps implementation reject/not-ready exits", (file) => {
    const def = readDef(file);

    expect(transitionTo(def, "implementation", "reject")).toBe("rejected");
    expect(transitionTo(def, "implementation", "not-ready")).toBe("needs-info");
  });
});

describe("INF-1167 AC4: state:doing tickets migrate to implementation and can submit", () => {
  it.each(DEV_IMPL_DEF_PATHS)("%s maps removed doing state to implementation", (file) => {
    const def = readDef(file);

    expect(def.migrations).toMatchObject({ doing: "implementation" });
    const plan = planDefStateMigration(["wf:dev-impl", "state:doing"], def);
    expect(plan).toEqual({ fromState: "doing", toState: "implementation", ownerRole: "dev" });
    expect(transitionTo(def, plan!.toState, "submit")).toBe("code-review");
  });
});

describe("INF-1167 AC5: dev-impl workflow never writes state:doing after the migration", () => {
  it.each(DEV_IMPL_DEF_PATHS)("%s has no transition or migration target that can write state:doing", (file) => {
    const def = readDef(file);

    const transitionTargets = def.states.flatMap((s) => (s.transitions ?? []).map((t) => t.to));
    expect(transitionTargets).not.toContain("doing");
    expect(Object.values(def.migrations ?? {})).not.toContain("doing");
    expect(def.break_glass?.to).not.toBe("doing");
  });
});
