/**
 * INF-579: governed-status must have one source of truth.
 *
 * Repro shape from INF-573: the state-role gate treated a ticket as governed
 * from engine/native workflow engagement, while the demote path treated the
 * same ticket as ad-hoc because the `wf:*` projection label was absent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { checkRoleGuardEnforced } from "./routing-guard.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { recordAppliedState, _resetAppliedStateStore } from "./store/applied-state-store.js";
import { checkWorkflowRules, resetNativeStateCache, resetWorkflowCache } from "./workflow-gate.js";

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: workflow:break-glass
  - id: linear:transition
  - id: deploy:execute
  - id: workflow:force-deploy
containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass, workflow:force-deploy]
  - id: dev
    grants: [linear:transition]
  - id: review
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute, workflow:force-deploy]
roles:
  - id: steward
    requires: [human:escalate]
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: review
    fills_roles: [code-review]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
`;

const DEV_IMPL_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: write-tests
      - command: demote
        to: __ad_hoc__
  - id: write-tests
    owner_role: test-author
    native_state: todo
    transitions:
      - command: submit-tests
        to: implementation
  - id: implementation
    owner_role: dev
    native_state: todo
    transitions:
      - command: submit
        to: code-review
      - command: demote
        to: __ad_hoc__
  - id: code-review
    owner_role: code-review
    native_state: todo
    transitions:
      - command: approve
        to: merge
  - id: merge
    owner_role: deployment
    native_state: todo
    transitions:
      - command: continue
        to: deploy
  - id: deploy
    owner_role: deployment
    native_state: todo
    transitions:
      - command: continue
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const ISSUE_IDENTIFIER = "INF-573";
const ISSUE_UUID = "issue-inf-573-uuid";
const TOKEN = "Bearer test-token";

function makeInf573DesyncFetch(): typeof globalThis.fetch {
  return async (_url, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = body.query ?? "";

    if (query.includes("IssueContext")) {
      return new Response(JSON.stringify({
        data: {
          issue: {
            identifier: ISSUE_IDENTIFIER,
            labels: { nodes: [{ name: "state:implementation" }] },
            delegate: null,
            state: { type: "unstarted", name: "To Do" },
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (query.includes("IssueBranchAndPR")) {
      return new Response(JSON.stringify({
        data: {
          issue: {
            description: "",
            comments: { nodes: [] },
            attachments: { nodes: [] },
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("INF-579 governed-status source reconciliation", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  const originalEnv = {
    CAPABILITY_POLICY_PATH: process.env.CAPABILITY_POLICY_PATH,
    WORKFLOW_DEF_PATH: process.env.WORKFLOW_DEF_PATH,
    WORKFLOW_DEFS_DIR: process.env.WORKFLOW_DEFS_DIR,
    WORKFLOW_DEF_DIR: process.env.WORKFLOW_DEF_DIR,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-579-"));
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), TEST_POLICY_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "dev-impl.yaml"), DEV_IMPL_WORKFLOW_YAML, "utf8");

    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    delete process.env.WORKFLOW_DEFS_DIR;
    delete process.env.WORKFLOW_DEF_DIR;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    originalFetch = globalThis.fetch;
    globalThis.fetch = makeInf573DesyncFetch();

    resetConfigHealth();
    resetNativeStateCache();
    resetPolicyCache();
    resetWorkflowCache();
    _resetAppliedStateStore();
    recordAppliedState(ISSUE_IDENTIFIER, "implementation");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key as keyof typeof originalEnv];
      } else {
        process.env[key as keyof typeof originalEnv] = value;
      }
    }
    resetConfigHealth();
    resetNativeStateCache();
    resetPolicyCache();
    resetWorkflowCache();
    _resetAppliedStateStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC1/AC3: demote accepts an INF-573-shaped governed ticket even when the wf:* projection label is missing", async () => {
    const result = await checkWorkflowRules("demote", ISSUE_UUID, TOKEN, "astrid");

    expect(result).toBeNull();
  });

  it("AC1/AC3: the state-role gate enforces the same INF-573-shaped ticket as governed", async () => {
    const result = await checkRoleGuardEnforced("hanzo", ["state:implementation"]);

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("role 'dev'");
    expect(result.legalBodies).toEqual(["igor"]);
  });

  it("AC2 invariant: role enforcement and demote never split governed/ad-hoc classification", async () => {
    const roleGate = await checkRoleGuardEnforced("hanzo", ["state:implementation"]);
    const demoteRejection = await checkWorkflowRules("demote", ISSUE_UUID, TOKEN, "astrid");

    const roleGateTreatsAsGoverned = roleGate.blocked;
    const demoteTreatsAsGoverned = demoteRejection === null;

    expect(roleGateTreatsAsGoverned).toBe(true);
    expect(demoteTreatsAsGoverned).toBe(true);
    expect({ roleGateTreatsAsGoverned, demoteTreatsAsGoverned }).toEqual({
      roleGateTreatsAsGoverned: true,
      demoteTreatsAsGoverned: true,
    });
  });
});
