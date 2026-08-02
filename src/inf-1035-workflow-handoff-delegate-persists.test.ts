/**
 * INF-1035 — workflow-sourced handoff must persist the receiving delegate.
 *
 * Regression scope from INF-905:
 *   AC1: a workflow-sourced ticket handed off to an owner keeps the delegate set
 *        to the receiving agent; it is never cleared to null.
 *        -> AC1 test asserts the governed handoff write carries delegateId=u-igor.
 *
 *   AC2: the xfn:workflow demoter rail must not fire for internal workflow
 *        tickets; workflow handoff is not a cross-functional request.
 *        -> AC2 test keeps wf/state labels and forbids __ad_hoc__/Backlog/null.
 *
 *   AC3: incident/workflow-sourced handoff to a named owner leaves the ticket in
 *        its workflow state, delegated to that owner, not Backlog ownerless.
 *        -> AC3 test drives the production proxy path and grades the final
 *           transition payload plus read-back state.
 *
 * The registered workflow definitions use `handoff` self-loop transitions, while
 * the CLI/generic delegate-routing path reaches the proxy as `handoff-work`.
 * This suite pins that `handoff-work` on a wf:* ticket is normalized onto the
 * workflow handoff rail instead of being treated like an ad-hoc/xfn request.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache, _setTransitionWritePolicyForTests } from "./workflow-gate.js";

const ISSUE_UUID = "issue-inf-1035-uuid";
const ISSUE_IDENTIFIER = "INF-1035";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: ai
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const WORKFLOW_YAML = `
id: dev-impl
version: 1035
archetype: single-task
entry_state: implementation
break_glass:
  command: escape
  to: intake
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
      - command: demote
        to: __ad_hoc__
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: merge
      - command: handoff
        to: implementation
        assign:
          mode: required
  - id: merge
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: deploy
      - command: handoff
        to: merge
        assign:
          mode: required
  - id: deploy
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: done
      - command: handoff
        to: deploy
        assign:
          mode: required
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "ai", linearUserId: "u-ai", openclawAgent: "ai", accessToken: "tok-ai", host: "local" },
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local", app: true },
      ],
    }),
    "utf8",
  );
  return file;
}

type FetchCall = { query: string; variables: Record<string, unknown> };

function makeWorkflowHandoffFetch(): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
  atomicWrites: FetchCall[];
  finalIssue: () => { labelNames: string[]; delegateId: string | null; nativeStateId: string | null };
} {
  const calls: FetchCall[] = [];
  const atomicWrites: FetchCall[] = [];
  const labelNamesById = new Map<string, string>([
    ["wf-lbl", "wf:dev-impl"],
    ["impl-lbl", "state:implementation"],
    ["xfn-workflow-lbl", "xfn:workflow"],
    ["component-lbl", "component:connector"],
  ]);
  let issueLabelIds = ["wf-lbl", "impl-lbl", "xfn-workflow-lbl", "component-lbl"];
  let delegateId: string | null = "u-ai";
  let nativeStateId: string | null = "state-todo-uuid";

  const labelsByName = () => issueLabelIds.map((id) => ({ id, name: labelNamesById.get(id) ?? id }));
  const labelNames = () => labelsByName().map((l) => l.name);
  const json = (payload: object) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

  const fetchImpl: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch URL in INF-1035 test: ${String(url)}`);
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};
    calls.push({ query, variables });

    if (query.includes("IssueContext")) {
      return json({
        data: {
          issue: {
            identifier: ISSUE_IDENTIFIER,
            labels: { nodes: labelNames().map((name) => ({ name })) },
            delegate: delegateId ? { id: delegateId } : null,
          },
        },
      });
    }

    if (query.includes("IssueLabels") && !query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            labels: { nodes: labelNames().map((name) => ({ name })) },
            delegate: delegateId ? { id: delegateId } : null,
          },
        },
      });
    }

    if (query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: ISSUE_IDENTIFIER,
            team: { id: "team-uuid" },
            labels: { nodes: labelsByName() },
          },
        },
      });
    }

    if (query.includes("TeamLabels") || query.includes("TeamStateLabels")) {
      return json({
        data: {
          team: {
            labels: {
              nodes: Array.from(labelNamesById.entries()).map(([id, name]) => ({ id, name })),
            },
          },
          issue: {
            team: {
              labels: {
                nodes: Array.from(labelNamesById.entries()).map(([id, name]) => ({ id, name })),
              },
            },
          },
        },
      });
    }

    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-backlog-uuid", name: "Backlog", type: "backlog" },
                { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                { id: "state-doing-uuid", name: "Doing", type: "started" },
                { id: "state-done-uuid", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("ApplyAtomicTransition")) {
      atomicWrites.push({ query, variables });
      issueLabelIds = (variables.labelIds as string[]) ?? issueLabelIds;
      if ("delegateId" in variables) delegateId = variables.delegateId as string | null;
      if ("stateId" in variables) nativeStateId = variables.stateId as string | null;
      return json({ data: { issueUpdate: { success: true } } });
    }

    if (query.includes("VerifyTransitionWrite")) {
      return json({
        data: {
          issue: {
            labels: { nodes: labelNames().map((name) => ({ name })) },
            delegate: delegateId ? { id: delegateId } : null,
            state: nativeStateId ? { id: nativeStateId } : null,
          },
        },
      });
    }

    if (query.includes("issueUpdate")) {
      const input = (variables.input ?? {}) as Record<string, unknown>;
      if ("delegateId" in input) delegateId = input.delegateId as string | null;
      return json({
        data: {
          issueUpdate: {
            success: true,
            issue: { id: ISSUE_UUID, identifier: ISSUE_IDENTIFIER },
          },
        },
      });
    }

    return json({ data: { issue: { id: ISSUE_UUID, identifier: ISSUE_IDENTIFIER } } });
  };

  return {
    fetch: fetchImpl,
    calls,
    atomicWrites,
    finalIssue: () => ({ labelNames: labelNames(), delegateId, nativeStateId }),
  };
}

describe("INF-1035: workflow-sourced handoff delegate persists", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1035-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
    fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, WORKFLOW_YAML, "utf8");

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    _setTransitionWritePolicyForTests({ maxAttempts: 1, retryDelayMs: 0 });
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTransitionWritePolicyForTests();
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
  });

  it("AC1: workflow-sourced handoff writes the receiving owner as delegate, not null", async () => {
    const fakeLinear = makeWorkflowHandoffFetch();
    globalThis.fetch = fakeLinear.fetch;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-ai")
      .set("X-Openclaw-Agent", "ai")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "handoff-work")
      .set("X-Openclaw-Linear-Target", "igor")
      .send({
        query: `mutation WorkflowHandoff($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: { id: ISSUE_UUID, input: {} },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();

    const atomicWrite = fakeLinear.atomicWrites.at(-1);
    expect(atomicWrite).toBeDefined();
    expect(atomicWrite?.variables.delegateId).toBe("u-igor");
    expect(atomicWrite?.variables.delegateId).not.toBeNull();
    expect(fakeLinear.finalIssue().delegateId).toBe("u-igor");
  });

  it("AC2: xfn:workflow on an internal workflow ticket does not demote or clear delegate during handoff", async () => {
    const fakeLinear = makeWorkflowHandoffFetch();
    globalThis.fetch = fakeLinear.fetch;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-ai")
      .set("X-Openclaw-Agent", "ai")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "handoff-work")
      .set("X-Openclaw-Linear-Target", "igor")
      .send({
        query: `mutation WorkflowHandoff($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: { id: ISSUE_UUID, input: {} },
      });

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition).toMatchObject({
      status: "applied",
      from: "implementation",
      to: "implementation",
    });
    expect(res.body._workflowTransition?.code).not.toBe("demoted-ad-hoc");

    const final = fakeLinear.finalIssue();
    expect(final.labelNames).toEqual(expect.arrayContaining(["wf:dev-impl", "state:implementation", "xfn:workflow"]));
    expect(final.labelNames).not.toContain("state:backlog");
    expect(final.nativeStateId).toBe("state-todo-uuid");
    expect(final.nativeStateId).not.toBe("state-backlog-uuid");
    expect(final.delegateId).toBe("u-igor");
  });

  it("AC3: incident regression stays in workflow state delegated to named owner, not Backlog ownerless", async () => {
    const fakeLinear = makeWorkflowHandoffFetch();
    globalThis.fetch = fakeLinear.fetch;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-ai")
      .set("X-Openclaw-Agent", "ai")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "handoff-work")
      .set("X-Openclaw-Linear-Target", "igor")
      .send({
        query: `mutation WorkflowHandoff($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: { id: ISSUE_UUID, input: {} },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body._workflowTransition).toMatchObject({
      status: "applied",
      code: expect.not.stringMatching(/demoted|ad-hoc|backlog/i),
      from: "implementation",
      to: "implementation",
    });

    expect(fakeLinear.finalIssue()).toMatchObject({
      delegateId: "u-igor",
      nativeStateId: "state-todo-uuid",
    });
    expect(fakeLinear.atomicWrites.at(-1)?.variables).toMatchObject({
      delegateId: "u-igor",
      assigneeId: null,
      stateId: "state-todo-uuid",
    });
  });
});
