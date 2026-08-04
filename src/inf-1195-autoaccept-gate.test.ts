/**
 * INF-1195 — autoAcceptCommitmentOnActivity state-gate + lag-safety.
 *
 * Regression: the webhook activity observer fired `applyStateTransition("accept")`
 * on ANY agent Comment/AgentSessionEvent with no state guard. On 2026-08-04 a
 * correctly-applied force-deploy on GEN-337 (intake → deploy) was clobbered ~7s
 * later when the force-deploy's own --comment-file comment event triggered the
 * observer; under Linear read-after-write lag the live label still read
 * `state:intake`, so the fired `accept` matched intake's `accept → write-tests`
 * edge and re-entered the finished ticket at the top of the dev cycle.
 *
 * These tests pin the fix:
 *   AC1 — the observer fires only when the ticket's authoritative state IS the
 *         workflow's commitment-gate state (never from intake or post-gate
 *         states like deploy).
 *   AC2 — the applied-state store wins over a stale state:* label: applied at/
 *         past the gate + stale intake label → no accept.
 *   AC3 — the genuine commitment-gate auto-accept path still fires.
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
import { _resetAppliedStateStore, recordAppliedState } from "./store/applied-state-store.js";
import {
  _setTransitionWritePolicyForTests,
  resetWorkflowCache,
} from "./workflow-gate.js";

const SECRET = "inf-1195-webhook-secret";
const ISSUE_UUID = "issue-inf-1195";
const ISSUE_IDENTIFIER = "GEN-337";
const TEAM_ID = "team-gen";
const GROVER_LINEAR_ID = "user-grover";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [linear:transition]
  - id: test-author
    requires: [linear:transition]
bodies:
  - id: grover
    container: dev
    fills_roles: [dev, steward]
`;

// Mirrors the dev-impl shape that bit GEN-337: `intake` carries BOTH an
// `accept → write-tests` edge and a `force-deploy → deploy` break-glass edge,
// while the commitment gate lives at `implementation`. An un gated auto-accept
// fired against a stale `state:intake` label matches the intake accept edge.
const WORKFLOW_YAML = `
id: dev-impl
version: 1
entry_state: intake
break_glass:
  command: escape
  to: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: write-tests
      - command: force-deploy
        to: deploy
  - id: write-tests
    owner_role: test-author
    native_state: todo
    transitions:
      - command: submit-tests
        to: implementation
  - id: implementation
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
  - id: doing
    owner_role: dev
    native_state: doing
    transitions:
      - command: submit
        to: code-review
  - id: needs-info
    owner_role: dev
    native_state: todo
    transitions: []
  - id: rejected
    kind: terminal
    native_state: invalid
    transitions: []
  - id: code-review
    owner_role: dev
    native_state: doing
    transitions:
      - command: approve
        to: merge
  - id: merge
    owner_role: dev
    native_state: doing
    transitions:
      - command: merged
        to: deploy
  - id: deploy
    owner_role: dev
    native_state: doing
    transitions:
      - command: deployed
        to: done
  - id: done
    kind: terminal
    native_state: done
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
          name: "grover",
          linearUserId: GROVER_LINEAR_ID,
          openclawAgent: "grover",
          accessToken: "tok-grover",
          refreshToken: "ref-grover",
          clientId: "client",
          clientSecret: "secret",
        },
      ],
    }),
    "utf8",
  );
}

function setupConfig(dir: string): void {
  writeAgents(dir);
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  process.env.WORKFLOW_DEF_PATH = path.join(dir, "workflow.yaml");
  process.env.LINEAR_WEBHOOK_SECRET = SECRET;
  fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
  fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, WORKFLOW_YAML, "utf8");
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

const STATE_LABEL_IDS: Record<string, string> = {
  intake: "intake-lbl",
  "write-tests": "write-tests-lbl",
  implementation: "implementation-lbl",
  doing: "doing-lbl",
  "needs-info": "needs-info-lbl",
  rejected: "rejected-lbl",
  "code-review": "code-review-lbl",
  merge: "merge-lbl",
  deploy: "deploy-lbl",
  done: "done-lbl",
};

/**
 * Build a Linear API mock whose issue projection carries the given live
 * state:* label. The applied-state store is the lag-proof counterweight and is
 * controlled separately by the test via recordAppliedState.
 */
function makeLinearFetch(liveStateLabel: string) {
  const calls: GraphqlCall[] = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch: ${String(url)}`);
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphqlCall;
    calls.push(parsed);
    const query = parsed.query ?? "";
    const labelNodes = [
      { id: "wf-lbl", name: "wf:dev-impl" },
      { id: STATE_LABEL_IDS[liveStateLabel], name: `state:${liveStateLabel}` },
    ];

    if (query.includes("IssueContext") || query.includes("IssueLabels")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: ISSUE_IDENTIFIER,
            labels: { nodes: labelNodes.map(({ name }) => ({ name })) },
            delegate: { id: GROVER_LINEAR_ID },
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
            delegate: { id: GROVER_LINEAR_ID },
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
            delegate: { id: GROVER_LINEAR_ID },
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
                { id: "wf-lbl", name: "wf:dev-impl" },
                ...Object.entries(STATE_LABEL_IDS).map(([state, id]) => ({ id, name: `state:${state}` })),
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
                { id: "state-review", name: "In Review", type: "started" },
                { id: "state-done", name: "Done", type: "completed" },
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
      const verifiedState =
        Object.entries(STATE_LABEL_IDS).find(([, id]) => expectedLabelIds.includes(id))?.[0] ?? liveStateLabel;
      return json({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: `state:${verifiedState}` }] },
            delegate: { id: GROVER_LINEAR_ID },
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
    createdAt: "2026-08-04T14:53:03.000Z",
    actor: { id: GROVER_LINEAR_ID, name: "Grover" },
    data: {
      id: commentId,
      body: "force-deploy applied: intake → deploy",
      issue: { id: ISSUE_UUID, identifier: ISSUE_IDENTIFIER },
      createdAt: "2026-08-04T14:53:03.000Z",
      updatedAt: "2026-08-04T14:53:03.000Z",
    },
  });
}

describe("INF-1195 — autoAcceptCommitmentOnActivity state-gate + lag-safety", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1195-"));
    originalFetch = globalThis.fetch;
    _resetAppliedStateStore();
    setupConfig(dir);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetAppliedStateStore();
    _setTransitionWritePolicyForTests();
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.WORKFLOW_DEFS_DIR;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function postComment(appState: ReturnType<typeof createApp>, id: string): Promise<void> {
    const body = commentWebhook(id);
    const res = await request(appState.app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", id)
      .send(body);
    expect(res.status).toBe(200);
    // The observer fires async after the 200; give it a beat to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  function closeApp(appState: ReturnType<typeof createApp>): void {
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.observationStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  }

  it("AC1: a Comment on a ticket in intake (pre-gate, carries an accept edge) does NOT fire accept", async () => {
    const { fetch, calls } = makeLinearFetch("intake");
    globalThis.fetch = fetch;
    const appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
    });

    try {
      await postComment(appState, "comment-intake-1");
      const transitionWrites = calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
      expect(transitionWrites).toHaveLength(0);
    } finally {
      closeApp(appState);
    }
  });

  it("AC1: a Comment on a ticket in deploy (post-gate) does NOT fire accept", async () => {
    const { fetch, calls } = makeLinearFetch("deploy");
    globalThis.fetch = fetch;
    const appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
    });

    try {
      await postComment(appState, "comment-deploy-1");
      const transitionWrites = calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
      expect(transitionWrites).toHaveLength(0);
    } finally {
      closeApp(appState);
    }
  });

  it("AC2 (the GEN-337 clobber): applied-state at deploy + stale intake label → no accept", async () => {
    // Exact incident shape: force-deploy just applied (authoritative applied-state
    // = deploy) but the live label projection still reads state:intake under
    // Linear read-after-write lag. The old code matched intake's accept edge and
    // re-entered the finished ticket at write-tests; the fix skips.
    const { fetch, calls } = makeLinearFetch("intake");
    globalThis.fetch = fetch;
    recordAppliedState(ISSUE_IDENTIFIER, "deploy");
    const appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
    });

    try {
      await postComment(appState, "comment-lag-1");
      const transitionWrites = calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
      expect(transitionWrites).toHaveLength(0);
    } finally {
      closeApp(appState);
    }
  });

  it("AC3: a Comment on a ticket sitting IN the commitment-gate state still auto-fires accept", async () => {
    const { fetch, calls } = makeLinearFetch("implementation");
    globalThis.fetch = fetch;
    const appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
    });

    try {
      await postComment(appState, "comment-gate-1");
      const commitmentWrites = calls.filter(
        (c) => c.query.includes("ApplyAtomicTransition") && (c.variables.labelIds as string[]).includes("doing-lbl"),
      );
      expect(commitmentWrites).toHaveLength(1);
    } finally {
      closeApp(appState);
    }
  });

  it("AC2: applied-state at doing (just past the gate) + stale gate label → no duplicate accept", async () => {
    // The genuine gate accept already applied (applied-state = doing) but the
    // label projection lags at implementation. A trailing comment in the lag
    // window must not re-fire — applied-state wins over the stale label.
    const { fetch, calls } = makeLinearFetch("implementation");
    globalThis.fetch = fetch;
    recordAppliedState(ISSUE_IDENTIFIER, "doing");
    const appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
    });

    try {
      await postComment(appState, "comment-gate-dup-1");
      const transitionWrites = calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
      expect(transitionWrites).toHaveLength(0);
    } finally {
      closeApp(appState);
    }
  });
});
