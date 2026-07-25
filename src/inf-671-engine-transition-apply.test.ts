/**
 * INF-671 — sprint-spawner `propose-brief` blocks on unresolved engine role.
 *
 * INF-649 taught the registration-time reachability gates (reloadWorkflowDefs +
 * checkDelegateResolution) to exempt synthetic `no_body` engine roles from the
 * |C|=0 unreachable-state check, so a def whose fanout state is `owner_role:
 * engine` registers cleanly. It did NOT reach the runtime delegate-resolution in
 * applyStateTransition's B2 apply path, which still fail-closed with
 * `delegate-unresolved` the instant a governed transition ROUTED INTO the
 * engine-owned state (the `isRoleDeclared` branch fires because `engine` is a
 * declared role — it is just synthetic + bodyless).
 *
 * On INF-196 this surfaced as the exact production failure: Ai, holding
 * `sprint:signoff`, drove `determining-scope -> spawning-scope` via
 * `propose-brief` and the proxy refused with
 *   `delegate-unresolved — no bodies found for role 'engine'`.
 *
 * These tests pin the runtime contract: a transition into a synthetic no-body
 * engine role APPLIES delegate-less (delegate untouched so the steward retains
 * it to fire the follow-on `spawn`), while a genuinely unstaffed declared role
 * still fail-closes. This is the twin of INF-524 AC4's runtime guard.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  applyStateTransition,
  reloadWorkflowDefs,
  resetNativeStateCache,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";

// Mirrors the live policy shape after INF-649: `engine` is a declared role but
// carries `synthetic: true` + `no_body: true`, and no body fills it.
const SYNTHETIC_ENGINE_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: sprint:signoff

containers:
  - id: steward-container
    grants: [linear:transition, human:escalate, sprint:signoff]

roles:
  - id: steward
    requires: [human:escalate]
  - id: engine
    requires: [linear:transition]
    synthetic: true
    no_body: true

bodies:
  - id: astrid
    container: steward-container
    fills_roles: [steward]
`;

// A genuinely unstaffed declared role (NOT synthetic) — must still fail-close.
const REAL_UNSTAFFED_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: sprint:signoff

containers:
  - id: steward-container
    grants: [linear:transition, human:escalate, sprint:signoff]

roles:
  - id: steward
    requires: [human:escalate]
  - id: engine
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward-container
    fills_roles: [steward]
`;

// Models the sprint-spawner shape: a steward-owned scoping state that routes into
// an engine-owned fanout state via a signoff-gated `propose-brief` transition.
const SPRINT_SPAWNER_SHAPE_YAML = `
id: inf671
version: 1
entry_state: determining-scope
break_glass:
  command: escape
  to: determining-scope
  owner_role: steward
states:
  - id: determining-scope
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: propose-brief
        to: spawning-scope
        requires_capability: sprint:signoff
  - id: spawning-scope
    owner_role: engine
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: scoping
  - id: scoping
    owner_role: steward
    kind: normal
    native_state: managing
    transitions: []
`;

const AGENTS_JSON = {
  agents: [
    { name: "astrid", linearUserId: "u-astrid", accessToken: "tok-astrid", host: "local" },
  ],
};

const ISSUE_ID = "issue-inf-671";
const TEAM_ID = "team-inf-671";
const AI_DELEGATE_ID = "u-astrid";

let dir: string;
let defsDir: string;
let originalFetch: typeof globalThis.fetch;

function writeFixtureFiles(policyYaml: string, workflowYaml: string): void {
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), policyYaml, "utf8");
  fs.writeFileSync(path.join(defsDir, "inf671.yaml"), workflowYaml, "utf8");
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(AGENTS_JSON, null, 2), "utf8");
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.WORKFLOW_DEF_PATH = path.join(defsDir, "inf671.yaml");
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  process.env.DATA_DIR = path.join(dir, "data");
  process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "workflow-def-state-snapshot.json");
  reloadAgents();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-671-"));
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

function makeTransitionFetch(labels: Array<{ id: string; name: string }>): {
  fetch: typeof globalThis.fetch;
  writes: Array<{ query: string; variables: Record<string, unknown> }>;
  comments: string[];
} {
  const writes: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const comments: string[] = [];
  const allLabels = [
    { id: "wf-inf671", name: "wf:inf671" },
    { id: "state-determining-scope", name: "state:determining-scope" },
    { id: "state-spawning-scope", name: "state:spawning-scope" },
    { id: "state-scoping", name: "state:scoping" },
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
              identifier: "INF-671",
              team: { id: TEAM_ID },
              delegate: { id: AI_DELEGATE_ID },
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
                  { id: "native-managing", name: "Managing", type: "started" },
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

      // Strongly-consistent read-after-write verification (issueUpdateAtomicVerified).
      // Reflects the applied write: state:spawning-scope label + native doing, with
      // the delegate LEFT UNCHANGED (the transition never touched it).
      if (query.includes("VerifyTransitionWrite")) {
        return json({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:inf671" }, { name: "state:spawning-scope" }] },
              delegate: { id: AI_DELEGATE_ID },
              assignee: null,
              state: { id: "native-doing" },
            },
          },
        });
      }

      throw new Error(`unexpected query: ${query.slice(0, 100)}`);
    },
  };
}

describe("INF-671: propose-brief into a synthetic engine-owned state", () => {
  it("registers the sprint-spawner-shaped def whose fanout state is owner_role 'engine'", async () => {
    writeFixtureFiles(SYNTHETIC_ENGINE_POLICY_YAML, SPRINT_SPAWNER_SHAPE_YAML);
    await expect(reloadWorkflowDefs()).resolves.toMatchObject({ ok: true });
  });

  it("applies the transition delegate-less instead of fail-closing on 'engine'", async () => {
    writeFixtureFiles(SYNTHETIC_ENGINE_POLICY_YAML, SPRINT_SPAWNER_SHAPE_YAML);
    await expect(reloadWorkflowDefs()).resolves.toMatchObject({ ok: true });

    const mock = makeTransitionFetch([
      { id: "wf-inf671", name: "wf:inf671" },
      { id: "state-determining-scope", name: "state:determining-scope" },
    ]);
    globalThis.fetch = mock.fetch;

    const result = await applyStateTransition("propose-brief", ISSUE_ID, "Bearer tok", {
      bodyId: "astrid",
    });

    expect(result.status).toBe("applied");
    expect(result.from).toBe("determining-scope");
    expect(result.to).toBe("spawning-scope");

    // The atomic write must NOT touch the delegate — the steward retains it to
    // fire the follow-on `spawn`. `hasDelegate` is false ⇒ no delegateId key.
    const atomic = mock.writes.find((w) => w.query.includes("ApplyAtomicTransition"));
    expect(atomic).toBeDefined();
    expect(atomic!.query).not.toContain("delegateId");
    expect(atomic!.variables).not.toHaveProperty("delegateId");
  });

  it("still fail-closes when the engine-owned state's role is declared but NOT synthetic", async () => {
    writeFixtureFiles(REAL_UNSTAFFED_POLICY_YAML, SPRINT_SPAWNER_SHAPE_YAML);
    // A real unstaffed role fails registration reachability, so drive the apply
    // path directly against a registry that accepted the def under a synthetic
    // policy, then swap the policy to the non-synthetic one (config drift) —
    // mirroring INF-524 AC4's runtime-drift guard.
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), SYNTHETIC_ENGINE_POLICY_YAML, "utf8");
    resetPolicyCache();
    await expect(reloadWorkflowDefs()).resolves.toMatchObject({ ok: true });

    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), REAL_UNSTAFFED_POLICY_YAML, "utf8");
    resetPolicyCache();

    const mock = makeTransitionFetch([
      { id: "wf-inf671", name: "wf:inf671" },
      { id: "state-determining-scope", name: "state:determining-scope" },
    ]);
    globalThis.fetch = mock.fetch;

    const result = await applyStateTransition("propose-brief", ISSUE_ID, "Bearer tok", {
      bodyId: "astrid",
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "delegate-unresolved",
      from: "determining-scope",
      to: "spawning-scope",
    });
    expect(result.detail).toMatch(/no bodies found for role 'engine'/i);
    expect(mock.writes).toEqual([]);
  });
});
