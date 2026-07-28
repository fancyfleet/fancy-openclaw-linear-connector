/**
 * INF-916: governed cross-functional requests must be re-seatable after
 * Linear silently drops an app-user delegate write.
 *
 * AC mapping:
 * - AC1: A steward/admin reseat of an existing `cross-functional-request`
 *   ticket persists the new delegate instead of re-demoting the ticket to
 *   Backlog and clearing ownership.
 * - AC2: A governed ticket with `delegate: null` can be re-seated to the
 *   current state's role owner, and a later sweep observes the persisted
 *   delegate instead of seating it again.
 * - AC3: The fake Linear server below models the live failure mode: app-user
 *   delegate writes are reported `success: true` but are silently dropped unless
 *   the same mutation carries `assigneeId: null`.
 * - AC4: The reseat endpoint and demote/xfn guard liveness are asserted through
 *   `createApp()` from `index.ts`, not a handler-only unit import.
 * - AC5: `/health` must expose liveness showing the reseat endpoint is mounted
 *   and the governed xfn demote guard is active on the live webhook dispatch path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { runBootstrapReconciliationSweep } from "./bootstrap-reconciliation-sweep.js";

const ADMIN_SECRET = "inf-916-admin-secret";
const ISSUE_ID = "issue-inf-916";
const ISSUE_IDENTIFIER = "INF-916";
const TEAM_ID = "team-inf";
const IGOR_LINEAR_ID = "u-igor-app";
const ASTRID_LINEAR_ID = "u-astrid";

const ACTIVE_STATE = { id: "s-todo", name: "To Do", type: "unstarted" };

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: dev
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const WORKFLOW_YAML = `
id: dev-impl
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
  - id: implementation
    owner_role: dev
    native_state: doing
  - id: done
    kind: terminal
    native_state: done
`;

const WORKFLOW_REGISTRY = new Map([
  [
    "dev-impl",
    {
      id: "dev-impl",
      entry_state: "intake",
      states: [
        { id: "intake", owner_role: "steward" },
        { id: "implementation", owner_role: "dev" },
        { id: "done", kind: "terminal" },
      ],
    },
  ],
]) as never;

type GraphQLCall = {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function writeAgents(dir: string): void {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "astrid",
          linearUserId: ASTRID_LINEAR_ID,
          openclawAgent: "astrid",
          accessToken: "tok-astrid",
          hooksUrl: "http://openclaw-hooks.test",
          hooksToken: "hook-token",
          host: "local",
        },
        {
          name: "igor",
          linearUserId: IGOR_LINEAR_ID,
          openclawAgent: "igor",
          accessToken: "tok-igor",
          hooksUrl: "http://openclaw-hooks.test",
          hooksToken: "hook-token",
          host: "local",
          app: true,
        },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = file;
}

function writePolicy(dir: string): void {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(file, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = file;
}

function writeWorkflow(dir: string): void {
  const defsDir = path.join(dir, "workflow-defs");
  fs.mkdirSync(defsDir, { recursive: true });
  const file = path.join(defsDir, "dev-impl.yaml");
  fs.writeFileSync(file, WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.WORKFLOW_DEF_PATH = file;
}

function closeAppState(appState: ReturnType<typeof createApp>): void {
  appState.dispatchDeliveryScheduler.stop();
  appState.watchdog.stop();
  appState.noActivityDetector.stop();
  appState.stuckDelegateDetector.stop();
  appState.managingPoller.stop();
  appState.bag.close();
  appState.sessionTracker.close();
  appState.agentQueue.close();
  appState.operationalEventStore.close();
  appState.mutationAuditStore.close();
}

function makeSilentDropLinear(initialDelegate: string | null = null): {
  fetch: typeof globalThis.fetch;
  calls: GraphQLCall[];
  currentDelegate: () => string | null;
} {
  const calls: GraphQLCall[] = [];
  let delegateId: string | null = initialDelegate;

  const fetchMock: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string") {
      throw new Error(`unexpected fetch url: ${String(url)}`);
    }
    if (url === "http://openclaw-hooks.test") {
      return json({ ok: true });
    }
    if (!url.includes("api.linear.app")) {
      throw new Error(`unexpected non-Linear fetch in INF-916 test: ${url}`);
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphQLCall;
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};
    calls.push({ query, variables, operationName: parsed.operationName });

    if (query.includes("BootstrapReconciliation") || query.includes("issues(")) {
      return json({
        data: {
          issues: {
            nodes: [
              {
                id: ISSUE_ID,
                identifier: ISSUE_IDENTIFIER,
                updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                labels: {
                  nodes: [
                    { id: "lbl-wf", name: "wf:dev-impl" },
                    { id: "lbl-state-implementation", name: "state:implementation" },
                    { id: "lbl-cross-functional", name: "cross-functional-request" },
                    { id: "lbl-xfn-design", name: "xfn:design" },
                  ],
                },
                delegate: delegateId ? { id: delegateId } : null,
                team: { id: TEAM_ID },
                state: ACTIVE_STATE,
                title: "Governed xfn ticket",
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }

    if (
      query.includes("IssueContextSweep") ||
      query.includes("IssueContext") ||
      query.includes("IssueRouting") ||
      query.includes("IssueWithLabels")
    ) {
      return json({
        data: {
          issue: {
            id: ISSUE_ID,
            identifier: ISSUE_IDENTIFIER,
            title: "Governed xfn ticket",
            team: { id: TEAM_ID, key: "INF", name: "Infrastructure" },
            creator: { id: ASTRID_LINEAR_ID, name: "Astrid" },
            state: ACTIVE_STATE,
            labels: {
              nodes: [
                { id: "lbl-wf", name: "wf:dev-impl" },
                { id: "lbl-state-implementation", name: "state:implementation" },
                { id: "lbl-cross-functional", name: "cross-functional-request" },
                { id: "lbl-xfn-design", name: "xfn:design" },
              ],
            },
            delegate: delegateId ? { id: delegateId } : null,
            assignee: null,
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
                { id: "s-backlog", name: "Backlog", type: "backlog" },
                ACTIVE_STATE,
                { id: "s-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return json({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "lbl-wf", name: "wf:dev-impl" },
                { id: "lbl-state-implementation", name: "state:implementation" },
                { id: "lbl-cross-functional", name: "cross-functional-request" },
                { id: "lbl-xfn-design", name: "xfn:design" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("issueUpdate")) {
      const asJson = JSON.stringify({ query, variables });
      const wantsIgor = asJson.includes(IGOR_LINEAR_ID);
      const carriesAssigneeNull =
        asJson.includes('"assigneeId":null') ||
        /assigneeId:\s*\$assigneeId/.test(query) && variables.assigneeId === null;
      if (wantsIgor && carriesAssigneeNull) {
        delegateId = IGOR_LINEAR_ID;
      }
      if (asJson.includes('"delegateId":null') || /delegateId:\s*null/.test(query)) {
        delegateId = null;
      }
      return json({ data: { issueUpdate: { success: true, issue: { id: ISSUE_ID, identifier: ISSUE_IDENTIFIER } } } });
    }

    if (query.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    }

    // INF-1002: writeDelegate read-back verification query.
    if (query.includes("VerifyDelegate")) {
      return json({ data: { issue: { delegate: delegateId ? { id: delegateId } : null } } });
    }

    return json({ data: {} });
  };

  return { fetch: fetchMock, calls, currentDelegate: () => delegateId };
}

describe("INF-916 governed xfn reseat regression", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-916-"));
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    writeAgents(dir);
    writePolicy(dir);
    writeWorkflow(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ADMIN_SECRET;
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEFS_DIR;
    delete process.env.WORKFLOW_DEF_PATH;
  });

  it("AC2+AC3: null-delegate governed xfn ticket re-seats with the app-user-persistent shape and stays seated across a sweep", async () => {
    const fakeLinear = makeSilentDropLinear(null);
    globalThis.fetch = fakeLinear.fetch;
    const wakeDispatches: Array<{ agent: string; ticket: string }> = [];

    const first = await runBootstrapReconciliationSweep({
      authToken: "Bearer tok-astrid",
      workflowRegistry: WORKFLOW_REGISTRY,
      resolveBodiesForRole: async (role) => (role === "dev" ? ["igor"] : []),
      linearUserIdForBody: (body) => (body === "igor" ? IGOR_LINEAR_ID : undefined),
      openclawNameForBody: (body) => body,
      wakeFn: async (agent, ticket) => {
        wakeDispatches.push({ agent, ticket });
      },
    });

    const second = await runBootstrapReconciliationSweep({
      authToken: "Bearer tok-astrid",
      workflowRegistry: WORKFLOW_REGISTRY,
      resolveBodiesForRole: async (role) => (role === "dev" ? ["igor"] : []),
      linearUserIdForBody: (body) => (body === "igor" ? IGOR_LINEAR_ID : undefined),
      openclawNameForBody: (body) => body,
      wakeFn: async (agent, ticket) => {
        wakeDispatches.push({ agent, ticket });
      },
    });

    const seatWrites = fakeLinear.calls.filter((call) => call.query.includes("WriteDelegate"));
    expect(first.seated).toBe(1);
    expect(fakeLinear.currentDelegate()).toBe(IGOR_LINEAR_ID);
    expect(seatWrites[0]?.query).toMatch(/assigneeId/);
    expect(JSON.stringify(seatWrites[0]?.variables ?? {})).toContain('"assigneeId":null');
    expect(second.seated).toBe(0);
    expect(seatWrites).toHaveLength(1);
    expect(wakeDispatches).toEqual([{ agent: "igor", ticket: ISSUE_IDENTIFIER }]);
  });

  it("AC1+AC4: production app mounts an admin/steward reseat endpoint that persists a governed cross-functional request delegate without demotion", async () => {
    const fakeLinear = makeSilentDropLinear(null);
    globalThis.fetch = fakeLinear.fetch;
    const appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      mutationAuditDbPath: path.join(dir, "audit.db"),
    });

    try {
      const res = await request(appState.app)
        .post("/admin/api/governed/reseat")
        .set("x-admin-secret", ADMIN_SECRET)
        .set("Content-Type", "application/json")
        .send({ issueId: ISSUE_ID, expectedWorkflow: "dev-impl", expectedState: "implementation" });

      const defaultExpress404 = res.status === 404 && /text\/html/.test(res.headers["content-type"] ?? "");
      expect(defaultExpress404).toBe(false);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        issue: ISSUE_IDENTIFIER,
        delegate: "igor",
        persisted: true,
      });

      const writes = fakeLinear.calls.filter((call) => call.query.includes("issueUpdate"));
      expect(writes.some((call) => JSON.stringify(call).includes('"stateId":"s-backlog"'))).toBe(false);
      expect(writes.some((call) => JSON.stringify(call).includes('"delegateId":null'))).toBe(false);
      expect(fakeLinear.currentDelegate()).toBe(IGOR_LINEAR_ID);
    } finally {
      closeAppState(appState);
    }
  });

  it("AC4+AC5: createApp health proves reseat is mounted and the governed xfn demote guard is active on the live webhook dispatch path", async () => {
    const fakeLinear = makeSilentDropLinear(IGOR_LINEAR_ID);
    globalThis.fetch = fakeLinear.fetch;
    const appState = createApp({
      bagDbPath: path.join(dir, "health-bag.db"),
      agentQueueDbPath: path.join(dir, "health-queue.db"),
      operationalEventsDbPath: path.join(dir, "health-events.db"),
      mutationAuditDbPath: path.join(dir, "health-audit.db"),
    });

    try {
      const health = await request(appState.app).get("/health");
      expect(health.body.governedXfnReseat).toMatchObject({
        reseatEndpointMounted: true,
        demoteGuardActive: true,
        dispatchPath: expect.stringMatching(/webhook|dispatch/i),
      });

      const webhook = await request(appState.app)
        .post("/")
        .set("Content-Type", "application/json")
        .send({
          type: "Issue",
          action: "update",
          actor: { id: ASTRID_LINEAR_ID, name: "Astrid" },
          createdAt: new Date().toISOString(),
          data: {
            id: ISSUE_ID,
            identifier: ISSUE_IDENTIFIER,
            title: "Governed xfn ticket",
            updatedAt: new Date().toISOString(),
            delegate: { id: IGOR_LINEAR_ID, name: "Igor", app: true },
            assignee: null,
            state: ACTIVE_STATE,
            labels: ["wf:dev-impl", "state:implementation", "cross-functional-request", "xfn:design"],
          },
          updatedFrom: { delegateId: null },
        });

      expect(webhook.status).toBe(200);
      expect(fakeLinear.calls.some((call) => JSON.stringify(call).includes('"stateId":"s-backlog"'))).toBe(false);
      expect(fakeLinear.calls.some((call) => JSON.stringify(call).includes('"delegateId":null'))).toBe(false);
      expect(appState.operationalEventStore.query({ outcome: "routed", limit: 10 })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agent: "igor", key: "linear-INF-916" }),
        ]),
      );
    } finally {
      closeAppState(appState);
    }
  });
});
