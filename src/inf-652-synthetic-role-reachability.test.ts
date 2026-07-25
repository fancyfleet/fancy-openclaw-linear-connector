/**
 * INF-652 — reloadWorkflowDefs synthetic owner-role reachability.
 *
 * These tests pin the distinction between deliberately bodyless synthetic roles
 * and genuinely unstaffed human roles at registration time. The exemption must
 * come from an explicit role marker in capability-policy.yaml.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  reloadWorkflowDefs,
  resetNativeStateCache,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";

const STAFFED_HUMAN_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward-container
    grants: [linear:transition, human:escalate]
  - id: ux-container
    grants: [linear:transition]
  - id: sprint-owner-container
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: ux-researcher
    requires: [linear:transition]
  - id: sprint-owner
    requires: [linear:transition]
  - id: engine
    requires: [linear:transition]
    declared_synthetic: true

bodies:
  - id: astrid
    container: steward-container
    fills_roles: [steward]
  - id: signe
    container: ux-container
    fills_roles: [ux-researcher]
  - id: soren
    container: sprint-owner-container
    fills_roles: [sprint-owner]
`;

const HUMAN_ZERO_CANDIDATE_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward-container
    grants: [linear:transition, human:escalate]

roles:
  - id: steward
    requires: [human:escalate]
  - id: design
    requires: [linear:transition]
  - id: ui-audit
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward-container
    fills_roles: [steward]
`;

const MARKER_DRIVEN_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward-container
    grants: [linear:transition, human:escalate]

roles:
  - id: steward
    requires: [human:escalate]
  - id: engine
    requires: [linear:transition]
  - id: virtual-runtime
    requires: [linear:transition]
    declared_synthetic: true

bodies:
  - id: astrid
    container: steward-container
    fills_roles: [steward]
`;

const AGENTS_JSON = {
  agents: [
    { name: "astrid", linearUserId: "u-astrid", accessToken: "tok-astrid", host: "local" },
    { name: "signe", linearUserId: "u-signe", accessToken: "tok-signe", host: "local" },
    { name: "soren", linearUserId: "u-soren", accessToken: "tok-soren", host: "local" },
  ],
};

const LIVE_FLAGGED_SYNTHETIC_WORKFLOWS: Record<string, string> = {
  "sprint.yaml": `
id: sprint
version: 1
entry_state: ux-shaping
break_glass: { command: escape, to: done, owner_role: steward }
states:
  - id: ux-shaping
    owner_role: ux-researcher
    kind: normal
    native_state: doing
    transitions:
      - command: complete-audit
        to: spawning
  - id: spawning
    owner_role: engine
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: managing
  - id: managing
    owner_role: sprint-owner
    kind: normal
    native_state: managing
    transitions:
      - command: complete
        to: done
  - id: done
    kind: terminal
    native_state: done
`,
  "dev-sprint.yaml": `
id: dev-sprint
version: 1
entry_state: product-definition
break_glass: { command: escape, to: done, owner_role: steward }
states:
  - id: product-definition
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: continue
        to: spawn-arms
  - id: spawn-arms
    owner_role: engine
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: spawn-impl
  - id: spawn-impl
    owner_role: engine
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: done
  - id: done
    kind: terminal
    native_state: done
`,
  "sprint-spawner.yaml": `
id: sprint-spawner
version: 1
entry_state: determining-scope
break_glass: { command: escape, to: done, owner_role: steward }
states:
  - id: determining-scope
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: propose-brief
        to: spawning-scope
  - id: spawning-scope
    owner_role: engine
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: done
  - id: done
    kind: terminal
    native_state: done
`,
  "ux-audit.yaml": `
id: ux-audit
version: 1
entry_state: auditing
break_glass: { command: escape, to: done, owner_role: steward }
states:
  - id: auditing
    owner_role: ux-researcher
    kind: normal
    native_state: doing
    transitions:
      - command: complete-audit
        to: spawning
  - id: spawning
    owner_role: engine
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: done
  - id: done
    kind: terminal
    native_state: done
`,
};

const HUMAN_ZERO_CANDIDATE_WORKFLOW = `
id: human-zero-candidates
version: 1
entry_state: intake
break_glass: { command: escape, to: done, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: start-design
        to: design-review
      - command: start-ui-audit
        to: ui-audit-review
  - id: design-review
    owner_role: design
    kind: normal
    native_state: doing
    transitions:
      - command: complete
        to: done
  - id: ui-audit-review
    owner_role: ui-audit
    kind: normal
    native_state: doing
    transitions:
      - command: complete
        to: done
  - id: done
    kind: terminal
    native_state: done
`;

const MARKER_DRIVEN_WORKFLOWS: Record<string, string> = {
  "bodyless-virtual-runtime.yaml": `
id: bodyless-virtual-runtime
version: 1
entry_state: intake
break_glass: { command: escape, to: done, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: enter
        to: synthetic-work
  - id: synthetic-work
    owner_role: virtual-runtime
    kind: normal
    native_state: doing
    transitions:
      - command: finish
        to: done
  - id: done
    kind: terminal
    native_state: done
`,
  "unmarked-engine.yaml": `
id: unmarked-engine
version: 1
entry_state: intake
break_glass: { command: escape, to: done, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: enter
        to: engine-work
  - id: engine-work
    owner_role: engine
    kind: normal
    native_state: doing
    transitions:
      - command: finish
        to: done
  - id: done
    kind: terminal
    native_state: done
`,
};

let dir: string;
let defsDir: string;

function writeRuntimeFiles(policyYaml: string, workflows: Record<string, string>): void {
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), policyYaml, "utf8");
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(AGENTS_JSON, null, 2), "utf8");
  for (const [name, yaml] of Object.entries(workflows)) {
    fs.writeFileSync(path.join(defsDir, name), yaml, "utf8");
  }

  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.WORKFLOW_DEF_PATH = path.join(defsDir, Object.keys(workflows)[0]);
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  process.env.DATA_DIR = path.join(dir, "data");
  process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "workflow-def-state-snapshot.json");
  reloadAgents();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-652-"));
  defsDir = path.join(dir, "defs");
  fs.mkdirSync(defsDir);
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetConfigHealth();
});

afterEach(() => {
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEFS_DIR;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.AGENTS_FILE;
  delete process.env.DATA_DIR;
  delete process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH;
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetConfigHealth();
  reloadAgents();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("INF-652 AC1: declared-synthetic live engine states are reachable by design", () => {
  it("does not reject the five live bodyless engine fanout states during reload", async () => {
    writeRuntimeFiles(STAFFED_HUMAN_POLICY_YAML, LIVE_FLAGGED_SYNTHETIC_WORKFLOWS);

    const result = await reloadWorkflowDefs();
    const diagnostics = result.ok ? [] : result.diagnostics;
    const diagnosticText = diagnostics.join("\n");

    expect(result).toMatchObject({ ok: true });
    expect(diagnosticText).not.toMatch(/candidate set of 0/i);
    expect(diagnosticText).not.toContain("sprint: state 'spawning'");
    expect(diagnosticText).not.toContain("dev-sprint: state 'spawn-arms'");
    expect(diagnosticText).not.toContain("dev-sprint: state 'spawn-impl'");
    expect(diagnosticText).not.toContain("sprint-spawner: state 'spawning-scope'");
    expect(diagnosticText).not.toContain("ux-audit: state 'spawning'");
  });
});

describe("INF-652 AC2: unstaffed human roles still fail INF-524 reachability", () => {
  it("still rejects non-synthetic design and ui-audit owner roles with |C|=0", async () => {
    writeRuntimeFiles(HUMAN_ZERO_CANDIDATE_POLICY_YAML, {
      "human-zero-candidates.yaml": HUMAN_ZERO_CANDIDATE_WORKFLOW,
    });

    const result = await reloadWorkflowDefs();
    const diagnostics = result.ok ? [] : result.diagnostics;
    const diagnosticText = diagnostics.join("\n");

    expect(result.ok).toBe(false);
    expect(diagnosticText).toMatch(/design-review/i);
    expect(diagnosticText).toMatch(/owner_role 'design'/i);
    expect(diagnosticText).toMatch(/ui-audit-review/i);
    expect(diagnosticText).toMatch(/owner_role 'ui-audit'/i);
    expect(diagnosticText).toMatch(/candidate set.*0|0.*candidate/i);
    expect(diagnosticText).toMatch(/unreachable|no available agent/i);
  });
});

describe("INF-652 AC3: synthetic exemption is marker-driven", () => {
  it("exempts any declared-synthetic role and still rejects an unmarked role named engine", async () => {
    writeRuntimeFiles(MARKER_DRIVEN_POLICY_YAML, MARKER_DRIVEN_WORKFLOWS);

    const result = await reloadWorkflowDefs();
    const diagnostics = result.ok ? [] : result.diagnostics;
    const diagnosticText = diagnostics.join("\n");

    expect(result.ok).toBe(false);
    expect(diagnosticText).not.toContain("bodyless-virtual-runtime: state 'synthetic-work'");
    expect(diagnosticText).not.toMatch(/owner_role 'virtual-runtime'.*candidate set of 0/i);
    expect(diagnosticText).toContain("unmarked-engine: state 'engine-work'");
    expect(diagnosticText).toMatch(/owner_role 'engine'/i);
    expect(diagnosticText).toMatch(/candidate set.*0|0.*candidate/i);
  });
});
