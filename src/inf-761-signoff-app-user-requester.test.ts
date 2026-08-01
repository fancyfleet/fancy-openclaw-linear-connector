/**
 * INF-761 — governed sign-off auto-assign of an app-user requester must persist.
 *
 * AC mapping:
 *   AC1: merge→sign-off assignment of an app-user requester persists, or is
 *        explicitly rerouted through the raw delegate issueUpdate path.
 *   AC2: the proof models the live Linear app-user failure mode: bundled
 *        state+label+delegate issueUpdate reports success but the app-user
 *        delegate reads back as null; the raw WriteDelegate path persists.
 *   AC3: AI-1762 call-count contract remains covered by
 *        ai-1762-transition-write-verification.test.ts; this test only covers
 *        the sign-off app-user carve-out and must not relax that suite.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { applyStateTransition, resetWorkflowCache, _setTransitionWritePolicyForTests } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";

const CANONICAL_TASK_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-task.yaml");

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: deploy:execute
containers:
  - id: steward
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
roles:
  - id: requester
    requires: [linear:transition]
  - id: department-head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
bodies:
  - id: astrid
    container: steward
    fills_roles: [department-head, requester]
  - id: ai
    container: steward
    fills_roles: [requester]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
`;

const AGENTS_JSON = {
  agents: [
    { name: "astrid", linearUserId: "user-astrid", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
    { name: "ai", linearUserId: "user-ai", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
    { name: "hanzo", linearUserId: "user-hanzo", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
  ],
};

const ISSUE_UUID = "11111111-2222-3333-4444-555555555555";
const ISSUE_IDENTIFIER = "INF-761-LIVE-SHAPE";
const TEAM_ID = "team-inf-761";
const USER_AI = "user-ai";

const TEAM_LABELS = [
  { id: "wf-task-id", name: "wf:task" },
  { id: "state-merge-id", name: "state:merge" },
  { id: "state-signoff-id", name: "state:sign-off" },
];

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function makeLiveAppUserShapeFetch() {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let workflowState = "merge";
  let delegateId: string | null = "user-hanzo";
  let nativeStateId = "state-todo-uuid";

  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch call: ${String(url)}`);
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};
    calls.push({ query, variables });

    if (query.includes("IssueWithLabels") || query.includes("IssueContext")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: ISSUE_IDENTIFIER,
            team: { id: TEAM_ID, key: "INF", name: "Infra" },
            labels: { nodes: [{ id: "wf-task-id", name: "wf:task" }, { id: `state-${workflowState}-id`, name: `state:${workflowState}` }] },
            delegate: delegateId ? { id: delegateId, app: delegateId === USER_AI } : null,
            assignee: null,
            state: { id: nativeStateId },
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: TEAM_LABELS } } } });
    }

    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                { id: "state-done-uuid", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("ApplyAtomicTransition")) {
      workflowState = "sign-off";
      nativeStateId = String(variables.stateId ?? nativeStateId);
      if (variables.delegateId !== USER_AI) {
        delegateId = variables.delegateId === null ? null : delegateId;
      }
      return json({ data: { issueUpdate: { success: true } } });
    }

    if (query.includes("VerifyTransitionWrite")) {
      return json({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:task" }, { name: `state:${workflowState}` }] },
            delegate: delegateId ? { id: delegateId, app: delegateId === USER_AI } : null,
            assignee: null,
            state: { id: nativeStateId },
          },
        },
      });
    }

    if (query.includes("WriteDelegate")) {
      expect(variables).toMatchObject({ issueId: ISSUE_UUID, delegateId: USER_AI, assigneeId: null });
      delegateId = USER_AI;
      return json({ data: { issueUpdate: { success: true } } });
    }

    if (query.includes("VerifyDelegate")) {
      return json({ data: { issue: { delegate: delegateId ? { id: delegateId, app: delegateId === USER_AI } : null } } });
    }

    throw new Error(`unexpected Linear query: ${query.slice(0, 100)}`);
  }) as unknown as typeof globalThis.fetch;

  return { fetchFn, calls };
}

describe("INF-761 — sign-off assignment to app-user requester", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalDefPath: string | undefined;
  let originalDefsDir: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;
  let tmpDir: string;

  beforeAll(() => {
    originalDefPath = process.env.WORKFLOW_DEF_PATH;
    originalDefsDir = process.env.WORKFLOW_DEFS_DIR;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf761-signoff-"));
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const agentsFile = path.join(tmpDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify(AGENTS_JSON), "utf8");
    process.env.AGENTS_FILE = agentsFile;

    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_TASK_FIXTURE;
  });

  afterAll(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value !== undefined) process.env[key] = value;
      else delete process.env[key];
    };
    restore("WORKFLOW_DEF_PATH", originalDefPath);
    restore("WORKFLOW_DEFS_DIR", originalDefsDir);
    restore("CAPABILITY_POLICY_PATH", originalPolicyPath);
    restore("AGENTS_FILE", originalAgentsFile);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    _resetAppliedStateStore();
    reloadAgents();
    _setTransitionWritePolicyForTests({ retryDelayMs: 0 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTransitionWritePolicyForTests();
  });

  it("AC1/AC2: merge→sign-off uses the raw verified delegate path for an app-user requester", async () => {
    const { fetchFn, calls } = makeLiveAppUserShapeFetch();
    globalThis.fetch = fetchFn;

    const result = await applyStateTransition("continue", ISSUE_IDENTIFIER, "Bearer token", {
      bodyId: "hanzo",
      sourceStateOverride: "merge",
      cliTarget: "ai",
    });

    expect(result).toMatchObject({ status: "applied", from: "merge", to: "sign-off" });

    const atomicCalls = calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
    expect(atomicCalls).toHaveLength(1);
    expect(atomicCalls[0].variables).not.toHaveProperty("delegateId");

    const rawDelegateCalls = calls.filter((c) => c.query.includes("WriteDelegate"));
    expect(rawDelegateCalls).toHaveLength(1);
    expect(rawDelegateCalls[0].variables).toMatchObject({ issueId: ISSUE_UUID, delegateId: USER_AI, assigneeId: null });
    expect(calls.some((c) => c.query.includes("VerifyDelegate"))).toBe(true);
  });
});
