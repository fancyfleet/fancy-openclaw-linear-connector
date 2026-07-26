/**
 * INF-695 S2 — Commitment / acceptance gate.
 *
 * These tests intentionally pin the contract at the transition boundary and the
 * production webhook registration point. They should fail until commitment exits
 * are explicit, persisted, and consulted by downstream transitions.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { createApp } from "./index.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import {
  _setTransitionWritePolicyForTests,
  applyStateTransition,
  checkWorkflowRules,
  loadWorkflowRegistry,
  resetWorkflowCache,
} from "./workflow-gate.js";

const SECRET = "inf-695-webhook-secret";
const ISSUE_UUID = "issue-inf-695";
const ISSUE_IDENTIFIER = "INF-695";
const TEAM_ID = "team-ai";
const IGOR_LINEAR_ID = "user-igor";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
roles:
  - id: dev
    requires: [linear:transition]
bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const WORKFLOW_YAML = `
id: commitment
version: 1
entry_state: investigation
break_glass:
  command: escape
  to: investigation
states:
  - id: investigation
    owner_role: dev
    native_state: todo
    commitment_gate:
      exits:
        accept:
          to: doing
        reject:
          to: rejected
        not-ready:
          to: needs-info
    transitions:
      - command: accept
        to: doing
      - command: reject
        to: rejected
      - command: not-ready
        to: needs-info
      - command: submit
        to: ac-validate
  - id: doing
    owner_role: dev
    native_state: doing
    transitions:
      - command: submit
        to: ac-validate
  - id: needs-info
    owner_role: dev
    native_state: todo
    transitions: []
  - id: rejected
    kind: terminal
    native_state: invalid
    transitions: []
  - id: ac-validate
    owner_role: dev
    native_state: todo
    transitions: []
`;

const INVALID_DEFAULT_EXIT_WORKFLOW_YAML = `
id: commitment
version: 1
entry_state: investigation
states:
  - id: investigation
    owner_role: dev
    native_state: todo
    transitions:
      - command: submit
        to: doing
  - id: doing
    owner_role: dev
    native_state: doing
    transitions: []
`;

type GraphqlCall = {
  query: string;
  variables: Record<string, unknown>;
};

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function writeAgents(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: IGOR_LINEAR_ID,
          openclawAgent: "igor",
          accessToken: "tok-igor",
          refreshToken: "ref-igor",
          clientId: "client",
          clientSecret: "secret",
        },
      ],
    }),
    "utf8",
  );
}

function setupConfig(dir: string, workflowYaml = WORKFLOW_YAML): void {
  writeAgents(dir);
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  process.env.WORKFLOW_DEF_PATH = path.join(dir, "workflow.yaml");
  process.env.LINEAR_WEBHOOK_SECRET = SECRET;
  fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
  fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, workflowYaml, "utf8");
  resetPolicyCache();
  resetWorkflowCache();
  resetConfigHealth();
  reloadAgents();
  _setTransitionWritePolicyForTests({ maxAttempts: 1, retryDelayMs: 0 });
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeLinearFetch(stateLabel: "investigation" | "doing" = "investigation") {
  const calls: GraphqlCall[] = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch: ${String(url)}`);
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphqlCall;
    calls.push(parsed);
    const query = parsed.query ?? "";
    const labelNodes = [
      { id: "wf-lbl", name: "wf:commitment" },
      { id: `${stateLabel}-lbl`, name: `state:${stateLabel}` },
    ];

    if (query.includes("IssueContext") || query.includes("IssueLabels")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: ISSUE_IDENTIFIER,
            labels: { nodes: labelNodes.map(({ name }) => ({ name })) },
            delegate: { id: IGOR_LINEAR_ID },
            state: { id: "state-todo", name: "To Do", type: "unstarted" },
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
            team: { id: TEAM_ID },
            labels: { nodes: labelNodes },
            delegate: { id: IGOR_LINEAR_ID },
            assignee: null,
            state: { id: "state-todo" },
          },
        },
      });
    }
    if (query.includes("EngagementIssue")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            team: { id: TEAM_ID },
            state: { id: "state-todo", name: "To Do" },
            labels: { nodes: labelNodes.map(({ name }) => ({ name })) },
            delegate: { id: IGOR_LINEAR_ID },
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
                { id: "investigation-lbl", name: "state:investigation" },
                { id: "doing-lbl", name: "state:doing" },
                { id: "ac-validate-lbl", name: "state:ac-validate" },
              ],
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
                { id: "state-todo", name: "To Do", type: "unstarted" },
                { id: "state-doing", name: "Doing", type: "started" },
                { id: "state-invalid", name: "Canceled", type: "canceled" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("VerifyTransitionWrite")) {
      const expectedLabelIds = (calls.find((c) => c.query.includes("ApplyAtomicTransition"))?.variables.labelIds ?? []) as string[];
      const verifiedState = expectedLabelIds.includes("ac-validate-lbl") ? "ac-validate" : "doing";
      return json({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:commitment" }, { name: `state:${verifiedState}` }] },
            delegate: { id: IGOR_LINEAR_ID },
            assignee: null,
            state: { id: verifiedState === "doing" ? "state-doing" : "state-todo" },
          },
        },
      });
    }
    if (query.includes("issueUpdate")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: {} });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function commentWebhook(commentId: string): string {
  return JSON.stringify({
    type: "Comment",
    action: "create",
    createdAt: "2026-07-25T12:00:00.000Z",
    actor: { id: IGOR_LINEAR_ID, name: "Igor" },
    data: {
      id: commentId,
      body: "I inspected the code and started the implementation path.",
      issue: { id: ISSUE_UUID, identifier: ISSUE_IDENTIFIER },
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    },
  });
}

describe("INF-695 S2 — Commitment / acceptance gate", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-695-"));
    originalFetch = globalThis.fetch;
    setupConfig(dir);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTransitionWritePolicyForTests();
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC2.1: investigation cannot rely on a default/implicit exit; the def must declare exactly accept, reject, and not-ready", async () => {
    setupConfig(dir, INVALID_DEFAULT_EXIT_WORKFLOW_YAML);

    await expect(loadWorkflowRegistry()).rejects.toThrow(/commitment.*exit.*accept.*reject.*not-ready/i);
  });

  it("AC2.1: accept out of investigation records exactly one commitment exit", async () => {
    const ops = new OperationalEventStore(path.join(dir, "ops-ac21.db"));
    const { fetch } = makeLinearFetch("investigation");
    globalThis.fetch = fetch;

    const result = await applyStateTransition("accept", ISSUE_UUID, "Bearer tok-igor", {
      bodyId: "igor",
      operationalEventStore: ops,
    });

    expect(result.status).toBe("applied");
    expect(ops.query({ key: ISSUE_IDENTIFIER, outcome: "commitment-exit-recorded" })).toHaveLength(1);
    expect(ops.query({ key: ISSUE_IDENTIFIER, outcome: "commitment-exit-recorded" })[0].detail).toMatchObject({
      workflow: "commitment",
      from: "investigation",
      exit: "accept",
      to: "doing",
    });
    ops.close();
  });

  it("AC2.2: submit/downstream before a recorded exit is refused with a missing-commitment-exit proxy error", async () => {
    const { fetch } = makeLinearFetch("investigation");
    globalThis.fetch = fetch;

    const error = await checkWorkflowRules(
      "submit",
      ISSUE_UUID,
      "Bearer tok-igor",
      "igor",
      null,
      IGOR_LINEAR_ID,
      null,
      false,
      false,
      true,
    );

    const proxyError = error ?? "";
    expect(proxyError).toMatch(/missing commitment exit/i);
    expect(proxyError).toMatch(/accept.*reject.*not-ready/i);
    expect(proxyError).not.toMatch(/not a legal command|Legal moves:/i);
  });

  it("AC2.3 + AC2.5: production webhook activity auto-fires accept once, sets doing once, and exposes liveness at /health", async () => {
    const { fetch, calls } = makeLinearFetch("investigation");
    globalThis.fetch = fetch;
    const appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
    });

    try {
      for (const id of ["comment-1", "comment-2"]) {
        const body = commentWebhook(id);
        const res = await request(appState.app)
          .post("/")
          .set("Content-Type", "application/json")
          .set("x-linear-signature", sign(body))
          .set("x-linear-delivery", id)
          .send(body);
        expect(res.status).toBe(200);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      const commitmentWrites = calls.filter(
        (c) => c.query.includes("ApplyAtomicTransition") && c.variables.stateId === "state-doing",
      );
      expect(commitmentWrites).toHaveLength(1);
      expect(commitmentWrites[0].variables.labelIds).toContain("doing-lbl");

      const health = await request(appState.app).get("/health");
      expect(health.status).toBe(200);
      expect(health.body.commitmentGate).toMatchObject({
        registered: true,
        activityObserverRegistered: true,
        lastAutoAccept: expect.objectContaining({
          ticket: ISSUE_IDENTIFIER,
          exit: "accept",
          to: "doing",
        }),
      });
    } finally {
      appState.bag.close();
      appState.sessionTracker.close();
      appState.agentQueue.close();
      appState.operationalEventStore.close();
      appState.observationStore.close();
      appState.watchdog.stop();
      appState.noActivityDetector.stop();
      appState.managingPoller.stop();
    }
  });

  it("AC2.4: a working-state ticket with no recorded exit is flagged as INF-508 doing-never-set, not silently accepted", async () => {
    const ops = new OperationalEventStore(path.join(dir, "ops-ac24.db"));
    const { fetch } = makeLinearFetch("doing");
    globalThis.fetch = fetch;

    const result = await applyStateTransition("submit", ISSUE_UUID, "Bearer tok-igor", {
      bodyId: "igor",
      operationalEventStore: ops,
      sourceStateOverride: "doing",
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "doing-never-set",
      from: "doing",
    });
    expect(ops.query({ key: ISSUE_IDENTIFIER, outcome: "failure-taxonomy" })[0].detail).toMatchObject({
      taxonomy: "INF-508",
      reason: "doing-never-set",
      workflow: "commitment",
      state: "doing",
    });
    ops.close();
  });
});
