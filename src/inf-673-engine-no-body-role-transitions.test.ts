/**
 * INF-673 — synthetic no_body owner_role transitions are engine-owned, not
 * delegate-unresolved failures.
 *
 * AC mapping:
 * - Synthetic no_body destination succeeds with no delegate and is not refused
 *   with "no body is registered."
 * - A genuinely understaffed declared non-synthetic role still fails closed with
 *   the existing INF-12 wording.
 * - The shipped defs cover all five owner_role: engine states.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
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

const POLICY_WITH_SYNTHETIC_ENGINE_AND_REAL_ORPHAN = `
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
    synthetic: true
    no_body: true
  - id: orphan
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward-container
    fills_roles: [steward]
`;

const SYNTHETIC_ENGINE_WORKFLOW = `
id: inf673
version: 1
entry_state: determining-scope
break_glass:
  command: escape
  to: done
  owner_role: steward
states:
  - id: determining-scope
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: propose-brief
        to: spawning-scope
  - id: spawning-scope
    owner_role: engine
    kind: normal
    native_state: doing
    transitions: []
  - id: done
    kind: terminal
    native_state: done
`;

const REAL_UNSTAFFED_WORKFLOW = `
id: inf673
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
      - command: route
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

const AGENTS_JSON = {
  agents: [
    { name: "astrid", linearUserId: "u-astrid", accessToken: "tok-astrid", host: "local" },
  ],
};

const ISSUE_ID = "issue-inf-673";
const TEAM_ID = "team-inf-673";

let dir: string;
let defsDir: string;
let originalFetch: typeof globalThis.fetch;

function writeFixtureFiles(workflowYaml: string): void {
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_WITH_SYNTHETIC_ENGINE_AND_REAL_ORPHAN, "utf8");
  fs.writeFileSync(path.join(defsDir, "inf673.yaml"), workflowYaml, "utf8");
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(AGENTS_JSON, null, 2), "utf8");
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.WORKFLOW_DEF_PATH = path.join(defsDir, "inf673.yaml");
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  process.env.DATA_DIR = path.join(dir, "data");
  process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "workflow-def-state-snapshot.json");
  reloadAgents();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-673-"));
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
  const liveLabelsByName = new Map(labels.map((label) => [label.name, label]));
  const teamLabels = [
    { id: "wf-inf673", name: "wf:inf673" },
    { id: "state-determining-scope", name: "state:determining-scope" },
    { id: "state-spawning-scope", name: "state:spawning-scope" },
    { id: "state-intake", name: "state:intake" },
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
              identifier: "INF-673",
              team: { id: TEAM_ID },
              delegate: null,
              assignee: null,
              state: { id: "native-todo", type: "unstarted", name: "Todo" },
              labels: { nodes: labels },
            },
          },
        });
      }

      if (query.includes("TeamLabels")) {
        return json({ data: { team: { labels: { nodes: teamLabels } } } });
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
        const nextLabels = (variables.labelIds as string[] | undefined) ?? [];
        for (const candidate of teamLabels) {
          if (nextLabels.includes(candidate.id)) liveLabelsByName.set(candidate.name, candidate);
          else if (candidate.name.startsWith("state:")) liveLabelsByName.delete(candidate.name);
        }
        return json({ data: { issueUpdate: { success: true } } });
      }

      if (query.includes("VerifyTransitionWrite")) {
        return json({
          data: {
            issue: {
              labels: { nodes: Array.from(liveLabelsByName.values()).map(({ name }) => ({ name })) },
              delegate: null,
              assignee: null,
              state: { id: "native-doing" },
            },
          },
        });
      }

      if (query.includes("IssueBranchAndPR")) {
        return json({ data: { issue: { attachments: { nodes: [] } } } });
      }

      throw new Error(`unexpected query: ${query.slice(0, 100)}`);
    },
  };
}

describe("INF-673 AC1: synthetic no_body transition runtime behavior", () => {
  it("applies a transition into synthetic owner_role: engine without setting a delegate or posting the INF-12 no-body refusal", async () => {
    writeFixtureFiles(SYNTHETIC_ENGINE_WORKFLOW);
    await expect(reloadWorkflowDefs()).resolves.toMatchObject({ ok: true });

    const mock = makeTransitionFetch([
      { id: "wf-inf673", name: "wf:inf673" },
      { id: "state-determining-scope", name: "state:determining-scope" },
    ]);
    globalThis.fetch = mock.fetch;

    const result = await applyStateTransition("propose-brief", ISSUE_ID, "Bearer tok", { bodyId: "astrid" });

    expect(result).toMatchObject({
      status: "applied",
      from: "determining-scope",
      to: "spawning-scope",
    });

    const atomic = mock.writes.find((write) => write.query.includes("ApplyAtomicTransition"));
    expect(atomic).toBeDefined();
    expect(atomic!.variables.delegateId ?? null).toBeNull();
    expect(atomic!.variables.assigneeId ?? null).toBeNull();
    expect(mock.comments.join("\n")).not.toMatch(/no body is registered|nobody to delegate/i);
  });
});

describe("INF-673 AC2: non-synthetic declared zero-body roles still fail closed", () => {
  it("preserves INF-12 no-body wording for a genuinely understaffed declared destination owner_role", async () => {
    writeFixtureFiles(REAL_UNSTAFFED_WORKFLOW);
    const mock = makeTransitionFetch([
      { id: "wf-inf673", name: "wf:inf673" },
      { id: "state-intake", name: "state:intake" },
    ]);
    globalThis.fetch = mock.fetch;

    const result = await applyStateTransition("route", ISSUE_ID, "Bearer tok", { bodyId: "astrid" });

    expect(result).toMatchObject({
      status: "failed",
      code: "delegate-unresolved",
      from: "intake",
      to: "orphaned",
    });
    expect(result.detail).toContain("no bodies found for role 'orphan'");
    expect(mock.writes).toEqual([]);
    expect(mock.comments.join("\n")).toContain(
      "'route' routes to role 'orphan', but no body is registered as filling that role",
    );
  });
});

describe("INF-673 AC4: shipped definitions keep every engine-owned state covered", () => {
  it("accounts for all five owner_role: engine states in registered workflow defs", () => {
    const expected = [
      "dev-sprint:spawn-arms",
      "dev-sprint:spawn-impl",
      "sprint-spawner:spawning-scope",
      "sprint:spawning",
      "ux-audit:spawning",
    ];

    const actual: string[] = [];
    for (const fileName of ["dev-sprint.yaml", "sprint-spawner.yaml", "sprint.yaml", "ux-audit.yaml"]) {
      const raw = fs.readFileSync(path.join(process.cwd(), "src", "registered-defs", fileName), "utf8");
      const def = yaml.load(raw) as { id: string; states?: Array<{ id: string; owner_role?: string }> };
      for (const state of def.states ?? []) {
        if (state.owner_role === "engine") actual.push(`${def.id}:${state.id}`);
      }
    }

    expect(actual.sort()).toEqual(expected.sort());
  });
});
