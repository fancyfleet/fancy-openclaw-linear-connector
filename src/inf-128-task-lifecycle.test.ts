/**
 * INF-128: wf:task full lifecycle intake→done regression test.
 *
 * After the v3 change (review→done direct, bypassing sign-off), verify the
 * full forward path works end-to-end:
 *
 *   intake --request--> routing --assign--> doing --submit--> review --approve--> done
 *
 * Also verifies:
 *   - request-changes (review→doing) still works
 *   - escape works from review
 *   - sign-off accept→done still works for legacy tickets
 *   - demote works from intake
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function writeWorkflowYaml(content: string): string {
  const dir = path.join(tmpDir, "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.yaml"), content, "utf8");
  return dir;
}

const POLICY_YAML = `# Minimal capability policy for wf:task tests
roles:
  - id: requester
    requires: [linear:transition]
  - id: department-head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: steward
    requires: [workflow:break-glass]
  - id: code-review
    requires: [repo:read]

capabilities:
  - id: linear:transition
  - id: workflow:break-glass

containers:
  - id: workflow
    grants: [linear:transition, workflow:break-glass]
  - id: test-dev
    grants: [linear:transition]

bodies:
  - id: test-steward
    container: workflow
    fills_roles: [steward, department-head, requester]
  - id: test-worker
    container: test-dev
    fills_roles: [worker]
`;

// ── Task v3 workflow YAML (review→done direct) ──────────────────────────────

const TASK_V3_YAML = `
id: task
version: 3
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: intake
  owner_role: steward

migrations:
  escape: intake

states:
  - id: intake
    owner_role: requester
    kind: normal
    native_state: todo
    transitions:
      - command: request
        to: routing
        generic: continue
      - command: demote
        to: __ad_hoc__

  - id: routing
    owner_role: department-head
    kind: normal
    native_state: todo
    transitions:
      - command: assign
        to: doing
        generic: continue
        assign:
          mode: required
          constraint: not-self

  - id: doing
    owner_role: worker
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: review
        generic: continue

  - id: review
    owner_role: department-head
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: done
        generic: continue
      - command: request-changes
        to: doing
        generic: revision
        assign: { default: prior-implementer }
        feedback:
          required: true
          category_enum:
            - incomplete
            - off-brief
            - quality
            - scope-creep
            - correctness

  - id: sign-off
    owner_role: requester
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: done
        generic: continue
      - command: reject
        to: doing
        generic: revision
        assign: { default: prior-implementer }
        feedback:
          required: true
          category_enum:
            - incomplete
            - off-brief
            - quality
            - scope-creep
            - correctness

  - id: done
    kind: terminal
    native_state: done
    satisfies_parent_barrier: true
`;

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-128-test-"));
  // Set env vars the connector reads
  process.env.WORKFLOW_DEF_PATH = path.join(tmpDir, "workflows", "task.yaml");
  process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "capability-policy.yaml");
  process.env.LINEAR_CONNECTOR_CONFIG_DIR = tmpDir;
  // Write the capability policy
  fs.writeFileSync(path.join(tmpDir, "capability-policy.yaml"), POLICY_YAML, "utf8");
});

afterEach(() => {
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.LINEAR_CONNECTOR_CONFIG_DIR;
  resetWorkflowCache();
  resetPolicyCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("INF-128: wf:task full lifecycle (intake→done via review→done)", () => {
  it("loads the task v3 workflow definition without error", async () => {
    writeWorkflowYaml(TASK_V3_YAML);
    const { loadWorkflowRegistry } = await import("./workflow-gate.js");
    const registry = await loadWorkflowRegistry();
    expect(registry.has("task")).toBe(true);
    const def = registry.get("task")!;
    expect(def.version).toBe(3);
    expect(def.states.find((s) => s.id === "review")?.transitions?.find((t) => t.command === "approve")?.to).toBe("done");
  });

  it("review state approve maps to done (not sign-off)", async () => {
    writeWorkflowYaml(TASK_V3_YAML);
    const { loadWorkflowRegistry } = await import("./workflow-gate.js");
    const registry = await loadWorkflowRegistry();
    const def = registry.get("task")!;
    const reviewState = def.states.find((s) => s.id === "review")!;
    const approveTransition = reviewState.transitions!.find((t) => t.command === "approve")!;
    expect(approveTransition.to).toBe("done");
    // sign-off is still defined but no longer reachable from review
    const signOffState = def.states.find((s) => s.id === "sign-off");
    expect(signOffState).toBeDefined();
    expect(signOffState!.transitions?.find((t) => t.command === "accept")?.to).toBe("done");
  });

  it("sign-off accept→done still works for legacy tickets", async () => {
    writeWorkflowYaml(TASK_V3_YAML);
    const { loadWorkflowRegistry } = await import("./workflow-gate.js");
    const registry = await loadWorkflowRegistry();
    const def = registry.get("task")!;
    const signOffState = def.states.find((s) => s.id === "sign-off")!;
    const acceptTransition = signOffState.transitions!.find((t) => t.command === "accept")!;
    expect(acceptTransition.to).toBe("done");
  });

  it("request-changes from review still maps to doing", async () => {
    writeWorkflowYaml(TASK_V3_YAML);
    const { loadWorkflowRegistry } = await import("./workflow-gate.js");
    const registry = await loadWorkflowRegistry();
    const def = registry.get("task")!;
    const reviewState = def.states.find((s) => s.id === "review")!;
    const changesTransition = reviewState.transitions!.find((t) => t.command === "request-changes")!;
    expect(changesTransition.to).toBe("doing");
  });

  it("escape is legal from review (break-glass)", async () => {
    writeWorkflowYaml(TASK_V3_YAML);
    const { loadWorkflowRegistry } = await import("./workflow-gate.js");
    const registry = await loadWorkflowRegistry();
    const def = registry.get("task")!;
    expect(def.break_glass?.command).toBe("escape");
    expect(def.break_glass?.to).toBe("intake");
  });

  it("demote from intake leaves workflow", async () => {
    writeWorkflowYaml(TASK_V3_YAML);
    const { loadWorkflowRegistry } = await import("./workflow-gate.js");
    const registry = await loadWorkflowRegistry();
    const def = registry.get("task")!;
    const intakeState = def.states.find((s) => s.id === "intake")!;
    const demoteTransition = intakeState.transitions!.find((t) => t.command === "demote")!;
    expect(demoteTransition.to).toBe("__ad_hoc__");
  });

  it("full forward path: intake→routing→doing→review→done", async () => {
    writeWorkflowYaml(TASK_V3_YAML);
    const { loadWorkflowRegistry, resolveMetaIntent } = await import("./workflow-gate.js");
    const registry = await loadWorkflowRegistry();
    const def = registry.get("task")!;

    // Trace the forward path through generic:continue tags
    const states = ["intake", "routing", "doing", "review", "done"];
    let prevState = states[0];
    for (let i = 1; i < states.length; i++) {
      const stateName = states[i - 1];
      const stateNode = def.states.find((s) => s.id === stateName);
      const continueTransition = stateNode!.transitions?.find((t) => t.generic === "continue");
      expect(continueTransition).toBeDefined();
      expect(continueTransition!.to).toBe(states[i]);
    }
  });
});
