/**
 * INF-524 — delegate/role-resolution cardinality + registration-time reachability.
 *
 * These tests pin the contract that role-to-delegate resolution is decided from
 * an explicit candidate set:
 *   - |C| = 1 auto-resolves.
 *   - |C| > 1 needs an explicit valid target and diagnostic candidate list.
 *   - |C| = 0 is rejected at registration and still held at runtime if config
 *     drifts after registration.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  applyStateTransition,
  checkWorkflowRules,
  reloadWorkflowDefs,
  resetNativeStateCache,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";

const VALID_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward-container
    grants: [linear:transition, human:escalate]
  - id: dev-container
    grants: [linear:transition]
  - id: reviewer-container
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: dev
    requires: [linear:transition]
  - id: reviewer
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward-container
    fills_roles: [steward]
  - id: igor
    container: dev-container
    fills_roles: [dev]
  - id: felix
    container: dev-container
    fills_roles: [dev]
  - id: charles
    container: reviewer-container
    fills_roles: [reviewer]
`;

const ZERO_BODY_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward-container
    grants: [linear:transition, human:escalate]

roles:
  - id: steward
    requires: [human:escalate]
  - id: orphan
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward-container
    fills_roles: [steward]
`;

const MULTI_VERB_WORKFLOW_YAML = `
id: inf524
version: 1
entry_state: intake
break_glass:
  command: escape
  to: done
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
        assign: { mode: required }
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: implementation
        assign: { mode: required }
  - id: review
    owner_role: reviewer
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: implementation
        assign: { mode: required }
  - id: done
    kind: terminal
    native_state: done
`;

const MULTI_NO_SELECTION_WORKFLOW_YAML = MULTI_VERB_WORKFLOW_YAML.replaceAll(
  "\n        assign: { mode: required }",
  "",
);

const SINGLETON_WORKFLOW_YAML = `
id: inf524
version: 1
entry_state: intake
break_glass:
  command: escape
  to: done
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: review
  - id: review
    owner_role: reviewer
    kind: normal
    native_state: doing
    transitions: []
  - id: done
    kind: terminal
    native_state: done
`;

const ZERO_BODY_WORKFLOW_YAML = `
id: inf524
version: 1
entry_state: intake
break_glass:
  command: escape
  to: done
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: orphaned
  - id: orphaned
    owner_role: orphan
    kind: normal
    native_state: doing
    transitions: []
  - id: done
    kind: terminal
    native_state: done
`;

const INF649_SYNTHETIC_ENGINE_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward-container
    grants: [linear:transition, human:escalate]
  - id: requester-container
    grants: [linear:transition]
  - id: worker-container
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: engine
    requires: [linear:transition]
    synthetic: true
    no_body: true
  - id: no-body-engine
    requires: [linear:transition]
    synthetic: true
    no_body: true
  - id: requester
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: design
    requires: [linear:transition]
  - id: ui-audit
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward-container
    fills_roles: [steward, requester]
  - id: ai
    container: requester-container
    fills_roles: [requester]
  - id: igor
    container: worker-container
    fills_roles: [worker]
`;

const INF649_ENGINE_SPAWN_WORKFLOW_YAML = `
id: inf649-engine-spawn
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: submit
        to: spawning
  - id: spawning
    owner_role: engine
    native_state: doing
    transitions:
      - command: spawned
        to: custom-engine-step
  - id: custom-engine-step
    owner_role: no-body-engine
    native_state: doing
    transitions:
      - command: finish
        to: done
  - id: done
    kind: terminal
    native_state: done
`;

const INF649_TASK_SIGNOFF_WITH_REQUESTER_CRITERIA_YAML = `
id: inf649-task
version: 1
entry_state: doing
states:
  - id: doing
    owner_role: worker
    native_state: todo
    transitions:
      - command: submit
        to: review
  - id: review
    owner_role: steward
    native_state: todo
    transitions:
      - command: approve
        to: sign-off
        assign:
          mode: required
          selection_criteria: original-requester
  - id: sign-off
    owner_role: requester
    native_state: todo
    transitions:
      - command: accept
        to: done
  - id: done
    kind: terminal
    native_state: done
`;

const INF649_TASK_SIGNOFF_WITHOUT_REQUESTER_CRITERIA_YAML = INF649_TASK_SIGNOFF_WITH_REQUESTER_CRITERIA_YAML.replace(
  "        assign:\n          mode: required\n          selection_criteria: original-requester",
  "        assign: { mode: auto }",
);

const INF649_REAL_UNSTAFFED_WORKFLOW_YAML = `
id: inf649-real-unstaffed
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: route-design
        to: design-review
      - command: route-ui-audit
        to: ui-audit-review
  - id: design-review
    owner_role: design
    native_state: doing
    transitions: []
  - id: ui-audit-review
    owner_role: ui-audit
    native_state: doing
    transitions: []
`;

const AGENTS_JSON = {
  agents: [
    { name: "astrid", linearUserId: "u-astrid", accessToken: "tok-astrid", host: "local" },
    { name: "igor", linearUserId: "u-igor", accessToken: "tok-igor", host: "local" },
    { name: "felix", linearUserId: "u-felix", accessToken: "tok-felix", host: "local" },
    { name: "charles", linearUserId: "u-charles", accessToken: "tok-charles", host: "local" },
    { name: "ai", linearUserId: "u-ai", accessToken: "tok-ai", host: "local" },
  ],
};

const ISSUE_ID = "issue-inf-524";
const TEAM_ID = "team-inf-524";

let dir: string;
let defsDir: string;
let originalFetch: typeof globalThis.fetch;

function writeFixtureFiles(policyYaml: string, workflowYaml: string): void {
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), policyYaml, "utf8");
  fs.writeFileSync(path.join(defsDir, "inf524.yaml"), workflowYaml, "utf8");
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(AGENTS_JSON, null, 2), "utf8");
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.WORKFLOW_DEF_PATH = path.join(defsDir, "inf524.yaml");
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  process.env.DATA_DIR = path.join(dir, "data");
  process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "workflow-def-state-snapshot.json");
  reloadAgents();
}

function writeFixtureSet(policyYaml: string, workflows: Record<string, string>): void {
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), policyYaml, "utf8");
  for (const [fileName, workflowYaml] of Object.entries(workflows)) {
    fs.writeFileSync(path.join(defsDir, fileName), workflowYaml, "utf8");
  }
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(AGENTS_JSON, null, 2), "utf8");
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  process.env.DATA_DIR = path.join(dir, "data");
  process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "workflow-def-state-snapshot.json");
  reloadAgents();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-524-"));
  defsDir = path.join(dir, "defs");
  fs.mkdirSync(defsDir);
  originalFetch = globalThis.fetch;
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetConfigHealth();
  _resetAppliedStateStore();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRulesFetch(labels: string[], delegateId: string | null): typeof globalThis.fetch {
  return async () => json({
    data: {
      issue: {
        identifier: "INF-524",
        labels: { nodes: labels.map((name) => ({ name })) },
        delegate: delegateId ? { id: delegateId } : null,
      },
    },
  });
}

function makeTransitionFetch(labels: Array<{ id: string; name: string }>): {
  fetch: typeof globalThis.fetch;
  writes: Array<{ query: string; variables: Record<string, unknown> }>;
  comments: string[];
} {
  const writes: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const comments: string[] = [];
  const allLabels = [
    { id: "wf-inf524", name: "wf:inf524" },
    { id: "state-intake", name: "state:intake" },
    { id: "state-review", name: "state:review" },
    { id: "state-orphaned", name: "state:orphaned" },
  ];

  return {
    writes,
    comments,
    fetch: async (_url, init) => {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = parsed.query ?? "";
      const variables = parsed.variables ?? {};

      if (query.includes("commentCreate")) {
        comments.push(String(variables.body ?? ""));
        return json({ data: { commentCreate: { success: true } } });
      }

      if (query.includes("IssueWithLabels")) {
        return json({
          data: {
            issue: {
              id: ISSUE_ID,
              identifier: "INF-524",
              team: { id: TEAM_ID },
              labels: { nodes: labels },
            },
          },
        });
      }

      if (query.includes("TeamLabels")) {
        return json({ data: { team: { labels: { nodes: allLabels } } } });
      }

      if (query.includes("TeamStates")) {
        return json({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "native-todo", name: "Todo", type: "unstarted" },
                  { id: "native-doing", name: "Doing", type: "started" },
                  { id: "native-done", name: "Done", type: "completed" },
                ],
              },
            },
          },
        });
      }

      if (query.includes("ApplyAtomicTransition") || query.includes("issueUpdate")) {
        writes.push({ query, variables });
        return json({ data: { issueUpdate: { success: true } } });
      }

      if (query.includes("IssueBranchAndPR")) {
        return json({ data: { issue: { attachments: { nodes: [] } } } });
      }

      throw new Error(`unexpected query: ${query.slice(0, 100)}`);
    },
  };
}

describe("INF-524 AC2/AC3: registration-time delegate reachability validation", () => {
  it("rejects a workflow whose non-terminal state has no reachable delegate candidates", async () => {
    writeFixtureFiles(ZERO_BODY_POLICY_YAML, ZERO_BODY_WORKFLOW_YAML);

    const result = await reloadWorkflowDefs();
    const diagnostics = result.ok ? [] : result.diagnostics;

    expect(result.ok).toBe(false);
    expect(diagnostics.join("\n")).toMatch(/orphaned/i);
    expect(diagnostics.join("\n")).toMatch(/owner_role 'orphan'/i);
    expect(diagnostics.join("\n")).toMatch(/candidate set.*0|0.*candidate/i);
    expect(diagnostics.join("\n")).toMatch(/unreachable|no available agent/i);
  });

  it("rejects a multi-candidate destination state that declares no selection criteria", async () => {
    writeFixtureFiles(VALID_POLICY_YAML, MULTI_NO_SELECTION_WORKFLOW_YAML);

    const result = await reloadWorkflowDefs();
    const diagnostics = result.ok ? [] : result.diagnostics;

    expect(result.ok).toBe(false);
    expect(diagnostics.join("\n")).toMatch(/implementation/i);
    expect(diagnostics.join("\n")).toMatch(/owner_role 'dev'/i);
    expect(diagnostics.join("\n")).toMatch(/igor.*felix|felix.*igor/i);
    expect(diagnostics.join("\n")).toMatch(/selection criteria|--target|assign/i);
  });
});

describe("INF-649: synthetic engine reachability exemption + requester selection criteria", () => {
  it("accepts synthetic engine-driven states and task requester criteria while still failing real unstaffed roles", async () => {
    writeFixtureSet(INF649_SYNTHETIC_ENGINE_POLICY_YAML, {
      "engine-spawn.yaml": INF649_ENGINE_SPAWN_WORKFLOW_YAML,
      "task-signoff.yaml": INF649_TASK_SIGNOFF_WITH_REQUESTER_CRITERIA_YAML,
      "real-unstaffed.yaml": INF649_REAL_UNSTAFFED_WORKFLOW_YAML,
    });

    const result = await reloadWorkflowDefs();
    const diagnostics = result.ok ? [] : result.diagnostics;
    const text = diagnostics.join("\n");

    expect(result.ok).toBe(false);
    expect(text).toMatch(/real-unstaffed.*design-review.*owner_role 'design'/i);
    expect(text).toMatch(/real-unstaffed.*ui-audit-review.*owner_role 'ui-audit'/i);
    expect(text).not.toMatch(/engine-spawn.*owner_role 'engine'.*candidate set of 0/i);
    expect(text).not.toMatch(/engine-spawn.*owner_role 'no-body-engine'.*candidate set of 0/i);
    expect(text).not.toMatch(/task-signoff.*owner_role 'requester'.*multiple candidates/i);
  });

  it("rejects wf:task sign-off when multi-candidate requester routing has no explicit selection criteria", async () => {
    writeFixtureSet(INF649_SYNTHETIC_ENGINE_POLICY_YAML, {
      "task-signoff.yaml": INF649_TASK_SIGNOFF_WITHOUT_REQUESTER_CRITERIA_YAML,
    });

    const result = await reloadWorkflowDefs();
    const diagnostics = result.ok ? [] : result.diagnostics;

    expect(result.ok).toBe(false);
    expect(diagnostics.join("\n")).toMatch(/task-signoff.*sign-off.*owner_role 'requester'/i);
    expect(diagnostics.join("\n")).toMatch(/selection criteria|original-requester|assign/i);
  });
});

describe("INF-524 AC1/AC5: natural verbs enforce candidate-set cardinality", () => {
  it.each([
    { verb: "accept", state: "intake", caller: "astrid", delegateId: "u-astrid" },
    { verb: "submit", state: "implementation", caller: "igor", delegateId: "u-igor" },
    { verb: "approve", state: "review", caller: "charles", delegateId: "u-charles" },
  ])("$verb rejects omitted target when destination owner role has multiple candidates", async ({ verb, state, caller, delegateId }) => {
    writeFixtureFiles(VALID_POLICY_YAML, MULTI_VERB_WORKFLOW_YAML);
    globalThis.fetch = makeRulesFetch(["wf:inf524", `state:${state}`], delegateId);

    const result = await checkWorkflowRules(verb, ISSUE_ID, "Bearer tok", caller, null, delegateId);

    expect(result).not.toBeNull();
    expect(result).toContain(verb);
    expect(result).toContain("dev");
    expect(result).toContain("igor");
    expect(result).toContain("felix");
    expect(result).toMatch(/--target|explicit target/i);
    expect(result).toMatch(/selection criteria|candidate/i);
  });

  it("rejects a non-member target with the candidate list and selection criteria", async () => {
    writeFixtureFiles(VALID_POLICY_YAML, MULTI_VERB_WORKFLOW_YAML);
    globalThis.fetch = makeRulesFetch(["wf:inf524", "state:implementation"], "u-igor");

    const result = await checkWorkflowRules("submit", ISSUE_ID, "Bearer tok", "igor", "astrid", "u-igor");

    expect(result).not.toBeNull();
    expect(result).toContain("astrid");
    expect(result).toContain("igor");
    expect(result).toContain("felix");
    expect(result).toMatch(/not.*candidate|not.*legal assignment target/i);
    expect(result).toMatch(/selection criteria|candidate/i);
  });

  it("accepts an explicit valid target on a named verb that routes to a multi-candidate role", async () => {
    writeFixtureFiles(VALID_POLICY_YAML, MULTI_VERB_WORKFLOW_YAML);
    globalThis.fetch = makeRulesFetch(["wf:inf524", "state:implementation"], "u-igor");

    await expect(checkWorkflowRules("submit", ISSUE_ID, "Bearer tok", "igor", "felix", "u-igor")).resolves.toBeNull();
  });

  it("auto-resolves a singleton destination without an explicit target", async () => {
    writeFixtureFiles(VALID_POLICY_YAML, SINGLETON_WORKFLOW_YAML);
    const mock = makeTransitionFetch([
      { id: "wf-inf524", name: "wf:inf524" },
      { id: "state-intake", name: "state:intake" },
    ]);
    globalThis.fetch = mock.fetch;

    const result = await applyStateTransition("accept", ISSUE_ID, "Bearer tok", { bodyId: "astrid" });

    expect(result.status).toBe("applied");
    const atomic = mock.writes.find((w) => w.query.includes("ApplyAtomicTransition"));
    expect(atomic).toBeDefined();
    expect(atomic!.variables.delegateId).toBe("u-charles");
  });
});

describe("INF-524 AC4: runtime guard still holds unresolved delegate cases", () => {
  it("does not advance when a once-valid destination role has zero candidates at runtime", async () => {
    writeFixtureFiles(VALID_POLICY_YAML, ZERO_BODY_WORKFLOW_YAML.replace("owner_role: orphan", "owner_role: reviewer"));
    await expect(reloadWorkflowDefs()).resolves.toMatchObject({ ok: true });

    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), ZERO_BODY_POLICY_YAML, "utf8");
    resetPolicyCache();

    const mock = makeTransitionFetch([
      { id: "wf-inf524", name: "wf:inf524" },
      { id: "state-intake", name: "state:intake" },
    ]);
    globalThis.fetch = mock.fetch;

    const result = await applyStateTransition("submit", ISSUE_ID, "Bearer tok", { bodyId: "astrid" });

    expect(result).toMatchObject({
      status: "failed",
      code: "delegate-unresolved",
      from: "intake",
      to: "orphaned",
    });
    expect(result.detail).toMatch(/candidate set.*0|0.*candidate|no bodies/i);
    expect(mock.writes).toEqual([]);
    expect(mock.comments.join("\n")).toMatch(/reviewer|candidate|no body/i);
  });
});
