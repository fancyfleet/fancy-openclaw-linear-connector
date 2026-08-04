/**
 * INF-1170 — multi-body requester role resolution must never wedge recovery.
 *
 * AC mapping:
 * - AC1: escape never fail-closes on role ambiguity; break-glass succeeds for
 *   the invoking body and lands the ticket in a recoverable intake state.
 * - AC2: forward/sign-off into a multi-body role deterministically pins the
 *   instance-bound requester, accepts --target, and otherwise declines loudly
 *   without partial writes.
 * - AC3: INF-1135 repro, escape on a multi-body requester, advances without
 *   admin intervention.
 * - AC4: INF-1150 repro, merge -> sign-off with requester in {astrid, ai},
 *   advances without admin intervention.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";

const WORKFLOW_YAML = `
id: task
version: 1170
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: intake
  owner_role: steward

states:
  - id: intake
    owner_role: requester
    kind: normal
    native_state: todo
    transitions:
      - command: request
        to: merge
        generic: continue

  - id: merge
    owner_role: merger
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: sign-off
        generic: continue
      - command: reject
        to: intake

  - id: sign-off
    owner_role: requester
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: done
        generic: continue

  - id: done
    kind: terminal
    native_state: done
`;

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass

containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
  - id: deployment
    grants: [linear:transition]

roles:
  - id: requester
    requires: [linear:transition]
  - id: steward
    requires: [workflow:break-glass]
  - id: merger
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [requester, steward]
  - id: ai
    container: steward
    fills_roles: [requester]
  - id: hanzo
    container: deployment
    fills_roles: [merger]
`;

const AGENTS_JSON = {
  agents: [
    { name: "astrid", linearUserId: "user-astrid", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" },
    { name: "ai", linearUserId: "user-ai", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" },
    { name: "hanzo", linearUserId: "user-hanzo", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" },
  ],
};

const ISSUE_UUID = "11111111-2222-3333-4444-555555551170";
const TICKET_IDENTIFIER = "INF-1170";
const TEAM_ID = "team-inf-1170";
const TEAM_LABELS = [
  { id: "wf-task-label", name: "wf:task" },
  { id: "state-intake-label", name: "state:intake" },
  { id: "state-merge-label", name: "state:merge" },
  { id: "state:sign-off-label", name: "state:sign-off" },
  { id: "state-done-label", name: "state:done" },
];

interface Captured {
  comments: Array<{ issueId: string; body: string }>;
  writes: Array<{ query: string; variables: Record<string, unknown> }>;
}

let captured: Captured;

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function makeFetch(opts: {
  labelNames: string[];
  instanceRequesterUserId?: "user-astrid" | "user-ai";
}): typeof globalThis.fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch call: ${String(url)}`);
    }

    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};

    if (query.includes("commentCreate")) {
      captured.comments.push({ issueId: String(variables.issueId ?? ""), body: String(variables.body ?? "") });
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } });
    }

    if (query.includes("IssueWithLabels") || query.includes("IssueContext")) {
      const requester = opts.instanceRequesterUserId
        ? { id: opts.instanceRequesterUserId }
        : null;
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: TICKET_IDENTIFIER,
            team: { id: TEAM_ID },
            labels: { nodes: opts.labelNames.map((name) => ({ id: `${name}-id`, name })) },
            delegate: null,
            // Forward-compatible fixture fields for the implementation: any of
            // these can be the instance-bound requester source, but role roster
            // cardinality alone is not enough to choose astrid vs ai.
            requester,
            creator: requester,
            createdBy: requester,
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
                { id: "linear-todo-state", name: "Todo", type: "unstarted" },
                { id: "linear-done-state", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("issueLabelCreate")) {
      return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } } });
    }

    if (query.includes("IssueBranchAndPR")) {
      return json({
        data: {
          issue: {
            attachments: {
              nodes: [
                {
                  url: "https://github.com/fancyfleet/fancy-openclaw-linear-connector/pull/1170",
                  sourceType: "github",
                  metadata: { status: "merged", state: "merged" },
                },
              ],
            },
          },
        },
      });
    }

    if (query.includes("issueUpdate") || query.includes("ApplyAtomicTransition") || query.includes("UpdateDelegate")) {
      captured.writes.push({ query, variables });
      return json({ data: { issueUpdate: { success: true } } });
    }

    throw new Error(`unexpected Linear query: ${query.slice(0, 100)}`);
  }) as unknown as typeof globalThis.fetch;
}

describe("INF-1170 — multi-body requester role resolution", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalDefPath: string | undefined;
  let originalDefsDir: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;

  beforeAll(() => {
    originalDefPath = process.env.WORKFLOW_DEF_PATH;
    originalDefsDir = process.env.WORKFLOW_DEFS_DIR;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1170-"));
    const workflowFile = path.join(tmpDir, "task.yaml");
    fs.writeFileSync(workflowFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    delete process.env.WORKFLOW_DEFS_DIR;

    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const agentsFile = path.join(tmpDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify(AGENTS_JSON), "utf8");
    process.env.AGENTS_FILE = agentsFile;
  });

  afterAll(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("WORKFLOW_DEF_PATH", originalDefPath);
    restore("WORKFLOW_DEFS_DIR", originalDefsDir);
    restore("CAPABILITY_POLICY_PATH", originalPolicyPath);
    restore("AGENTS_FILE", originalAgentsFile);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    captured = { comments: [], writes: [] };
    originalFetch = globalThis.fetch;
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    _resetAppliedStateStore();
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("AC1: escape never fail-closes on requester role ambiguity; invoking body lands in recoverable intake", async () => {
    for (const sourceState of ["merge", "sign-off"]) {
      captured = { comments: [], writes: [] };
      globalThis.fetch = makeFetch({
        labelNames: ["wf:task", `state:${sourceState}`],
        instanceRequesterUserId: "user-ai",
      });

      const result = await applyStateTransition("escape", TICKET_IDENTIFIER, "Bearer tok", {
        bodyId: "ai",
        sourceStateOverride: sourceState,
      });

      expect(result).toMatchObject({ status: "applied", from: sourceState, to: "intake" });
      const write = captured.writes.find((call) => call.query.includes("ApplyAtomicTransition"));
      expect(write).toBeDefined();
      expect(write!.variables.labelIds).toEqual(expect.arrayContaining(["state-intake-label"]));
      expect(write!.variables.delegateId).toBe("user-ai");
      expect(captured.comments).toEqual([]);
    }
  });

  it("AC2 + INF-1150: merge -> sign-off pins the instance-bound requester when requester is astrid or ai", async () => {
    for (const requester of ["user-astrid", "user-ai"] as const) {
      captured = { comments: [], writes: [] };
      globalThis.fetch = makeFetch({
        labelNames: ["wf:task", "state:merge"],
        instanceRequesterUserId: requester,
      });

      const result = await applyStateTransition("continue", TICKET_IDENTIFIER, "Bearer tok", {
        bodyId: "hanzo",
        sourceStateOverride: "merge",
      });

      expect(result).toMatchObject({ status: "applied", from: "merge", to: "sign-off" });
      const write = captured.writes.find((call) => call.query.includes("ApplyAtomicTransition"));
      expect(write).toBeDefined();
      expect(write!.variables.labelIds).toEqual(expect.arrayContaining(["state:sign-off-label"]));
      expect(write!.variables.delegateId).toBe(requester);
      expect(captured.comments).toEqual([]);
    }
  });

  it("AC2: explicit --target is still accepted for a multi-body requester destination", async () => {
    globalThis.fetch = makeFetch({
      labelNames: ["wf:task", "state:merge"],
      instanceRequesterUserId: "user-ai",
    });

    const result = await applyStateTransition("continue", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "hanzo",
      sourceStateOverride: "merge",
      cliTarget: "astrid",
    });

    expect(result).toMatchObject({ status: "applied", from: "merge", to: "sign-off" });
    const write = captured.writes.find((call) => call.query.includes("ApplyAtomicTransition"));
    expect(write).toBeDefined();
    expect(write!.variables.delegateId).toBe("user-astrid");
  });

  it("AC2: unresolved requester ambiguity declines explicitly and recoverably, with no partial transition write", async () => {
    globalThis.fetch = makeFetch({
      labelNames: ["wf:task", "state:merge"],
      instanceRequesterUserId: undefined,
    });

    const result = await applyStateTransition("continue", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "hanzo",
      sourceStateOverride: "merge",
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "delegate-unresolved",
      from: "merge",
      to: "sign-off",
    });
    expect(captured.writes).toEqual([]);
    expect(captured.comments).toHaveLength(1);
    expect(captured.comments[0].issueId).toBe(ISSUE_UUID);
    expect(captured.comments[0].body).toMatch(/--target/);
    expect(captured.comments[0].body).toMatch(/astrid/);
    expect(captured.comments[0].body).toMatch(/ai/);
  });

  it("AC3 INF-1135: escape on legacy state:escape with multi-body requester recovers to intake without admin intervention", async () => {
    globalThis.fetch = makeFetch({
      labelNames: ["wf:task", "state:escape"],
      instanceRequesterUserId: "user-astrid",
    });

    const result = await applyStateTransition("escape", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "astrid",
      sourceStateOverride: "escape",
    });

    expect(result).toMatchObject({ status: "applied", from: "escape", to: "intake" });
    const write = captured.writes.find((call) => call.query.includes("ApplyAtomicTransition"));
    expect(write).toBeDefined();
    expect(write!.variables.labelIds).toEqual(expect.arrayContaining(["state-intake-label"]));
    expect(write!.variables.delegateId).toBe("user-astrid");
    expect(captured.comments).toEqual([]);
  });
});
