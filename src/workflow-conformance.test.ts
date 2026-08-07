/**
 * INF-1300 — workflow-conformance.ts
 *
 * AC: conformance-check logic (positive + failing cases).
 * Mocks: fs/tmp fixtures for validateAllRegisteredDefs, in-memory WorkflowDef objects for validateWorkflowDef.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateWorkflowDef, validateAllRegisteredDefs, ACCEPTED_WAIVER_KEYS } from "./workflow-conformance.js";
import type { WorkflowDef } from "./workflow-gate.js";

function baseDef(overrides: Partial<WorkflowDef> = {}): WorkflowDef {
  return {
    id: "test-wf",
    states: [],
    ...overrides,
  } as unknown as WorkflowDef;
}

function state(id: string, transitions?: WorkflowDef["states"][number]["transitions"], extra: Record<string, unknown> = {}): WorkflowDef["states"][number] {
  return { id, transitions, ...extra } as WorkflowDef["states"][number];
}

describe("workflow-conformance", () => {
  describe("validateWorkflowDef — positive", () => {
    it("valid single-state def with no edges passes", () => {
      const def = baseDef({ states: [state("a")] });
      const res = validateWorkflowDef(def);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("barrier fanout pattern passes when fanout state targets a barrier:true state", () => {
      const def = baseDef({
        states: [
          state("spawn", [{ to: "collect", command: "spawn" }], { fanout: { child_workflow: "wf:dev-impl" } }),
          state("collect", undefined, { barrier: true }),
        ],
      });
      const res = validateWorkflowDef(def);
      // child resolution may fail if registry empty; barrier/fanout invariants should still pass given no terminal target
      const invariants = new Set(res.errors.map((e) => e.invariant));
      expect(invariants.has("barrier-before-managing")).toBe(false);
      expect(invariants.has("fanout-before-barrier")).toBe(false);
    });

    it("waiver suppresses only the waived invariant", () => {
      // Use an unrecognized waiver to also assert it is known; choose fanout-before-barrier.
      const def = baseDef({
        // trigger fanout-before-barrier if not waived: state without fanout -> barrier
        states: [
          state("a", [{ to: "b", command: "go" }]),
          state("b", undefined, { barrier: true }),
        ],
      }) as unknown as Record<string, unknown>;
      (def as Record<string, unknown>).invariant_skip = ["fanout-before-barrier"];
      const res = validateWorkflowDef(def as unknown as WorkflowDef);
      expect(res.errors.some((e) => e.invariant === "fanout-before-barrier")).toBe(false);
      // barrier invariant should still trip if its condition holds (but it needs a fanout source; there is none here, so no)
    });

    it("terminal barrier target does not require predecessor fanout", () => {
      const def = baseDef({
        states: [
          state("a", [{ to: "done", command: "converge" }]),
          state("done", undefined, { barrier: true, kind: "terminal" } as unknown as Record<string, unknown>),
        ],
      });
      const res = validateWorkflowDef(def);
      expect(res.errors.some((e) => e.invariant === "fanout-before-barrier")).toBe(false);
    });
  });

  describe("validateWorkflowDef — failing cases", () => {
    it("fanout state targeting non-barrier state → barrier-before-managing error (failing case)", () => {
      const def = baseDef({
        states: [
          state("spawn", [{ to: "collect", command: "spawn" }], { fanout: { child_workflow: "wf:dev-impl" } }),
          state("collect"),
        ],
      });
      const res = validateWorkflowDef(def);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.invariant === "barrier-before-managing")).toBe(true);
    });

    it("non-fanout predecessor of a barrier state → fanout-before-barrier error", () => {
      const def = baseDef({
        states: [
          state("a", [{ to: "b", command: "go" }]),
          state("b", undefined, { barrier: true }),
        ],
      });
      const res = validateWorkflowDef(def);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.invariant === "fanout-before-barrier")).toBe(true);
    });

    it("unrecognized invariant_skip key → invariant_skip failure", () => {
      const def = baseDef({ states: [state("a")] }) as unknown as Record<string, unknown>;
      (def as Record<string, unknown>).invariant_skip = ["not-a-real-key"];
      const res = validateWorkflowDef(def as unknown as WorkflowDef);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.invariant === "invariant_skip")).toBe(true);
    });

    it("child_workflow without wf: prefix → child-workflow-resolution failure", () => {
      const def = baseDef({
        states: [
          state("spawn", [{ to: "collect" }], { fanout: { child_workflow: "dev-impl" } }),
          state("collect", undefined, { barrier: true }),
        ],
      });
      const res = validateWorkflowDef(def);
      expect(res.errors.some((e) => e.invariant === "child-workflow-resolution")).toBe(true);
    });
  });

  describe("validateAllRegisteredDefs", () => {
    let tmp: string;
    const origDir = process.env.WORKFLOW_DEFS_DIR;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-conf-"));
    });

    afterEach(() => {
      process.env.WORKFLOW_DEFS_DIR = origDir;
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("empty dir → empty results", () => {
      const res = validateAllRegisteredDefs(tmp);
      expect(res).toEqual([]);
    });

    it("nonexistent dir → empty results (never crashes)", () => {
      const res = validateAllRegisteredDefs(path.join(tmp, "no-such-dir"));
      expect(res).toEqual([]);
    });

    it("yaml file without id field → parse error", () => {
      fs.writeFileSync(path.join(tmp, "bad.yaml"), "states: []\n", "utf8");
      const res = validateAllRegisteredDefs(tmp);
      expect(res).toHaveLength(1);
      expect(res[0].valid).toBe(false);
      expect(res[0].errors.some((e) => e.invariant === "parse")).toBe(true);
    });

    it("valid yaml file loads and is validated", () => {
      fs.writeFileSync(path.join(tmp, "ok.yaml"), "id: ok\nstates:\n  - id: a\n", "utf8");
      const res = validateAllRegisteredDefs(tmp);
      expect(res).toHaveLength(1);
      expect(res[0].defId).toBe("ok");
    });

    it("unparsable yaml → load error", () => {
      fs.writeFileSync(path.join(tmp, "broken.yaml"), ":\n  - [\n", "utf8");
      const res = validateAllRegisteredDefs(tmp);
      expect(res).toHaveLength(1);
      expect(res[0].valid).toBe(false);
      expect(res[0].errors.some((e) => e.invariant === "load")).toBe(true);
    });

    it("dir env fallback: when WORKFLOW_DEFS_DIR set, validateAllRegisteredDefs() uses it", () => {
      fs.writeFileSync(path.join(tmp, "env.yaml"), "id: env-wf\nstates:\n  - id: a\n", "utf8");
      process.env.WORKFLOW_DEFS_DIR = tmp;
      const res = validateAllRegisteredDefs();
      expect(res).toHaveLength(1);
      expect(res[0].defId).toBe("env-wf");
    });
  });
});
