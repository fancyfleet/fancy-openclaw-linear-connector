/**
 * INF-1037 — dispatch recovery dead-session and C4 escalation loops.
 *
 * Red tests for the three INF-1025 recurrence classes:
 *  - dead zero-call session stubs must not satisfy dispatch idempotency;
 *  - proxy/steward redispatch-capable transitions must say which wake path fired;
 *  - production bootstrap must expose scheduled/subscribed recovery liveness.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { DispatchIdempotencyStore } from "./store/dispatch-idempotency-store.js";
import { setStateAtomic, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

function tempDir(prefix = "inf-1037-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: "user-igor-linear-id",
          openclawAgent: "igor",
          accessToken: "token-igor",
          refreshToken: "refresh-igor",
          clientId: "client-igor",
          clientSecret: "secret-igor",
          host: "local",
        },
        {
          name: "astrid",
          linearUserId: "user-astrid-linear-id",
          openclawAgent: "astrid",
          accessToken: "token-astrid",
          refreshToken: "refresh-astrid",
          clientId: "client-astrid",
          clientSecret: "secret-astrid",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

function writeWorkflowDef(dir: string): string {
  const file = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(
    file,
    yaml.dump({
      id: "dev-impl",
      version: 1037,
      entry_state: "intake",
      break_glass: { command: "escape", to: "escape", owner_role: "steward" },
      states: [
        { id: "intake", owner_role: "steward", kind: "normal", native_state: "todo", transitions: [{ command: "accept", to: "write-tests" }] },
        { id: "write-tests", owner_role: "test-author", kind: "normal", native_state: "todo", transitions: [{ command: "tests-ready", to: "implementation" }] },
        { id: "implementation", owner_role: "dev", kind: "normal", native_state: "todo", transitions: [{ command: "submit", to: "merge" }] },
        { id: "merge", owner_role: "dev", kind: "normal", native_state: "todo", transitions: [{ command: "merged", to: "deploy" }] },
        { id: "deploy", owner_role: "dev", kind: "normal", native_state: "todo", transitions: [{ command: "deployed", to: "ac-validate" }] },
        { id: "ac-validate", owner_role: "steward", kind: "normal", native_state: "todo", transitions: [{ command: "validated", to: "done" }] },
        { id: "done", kind: "terminal", native_state: "done" },
        { id: "escape", kind: "terminal", native_state: "invalid" },
      ],
    }),
    "utf8",
  );
  return file;
}

function writePolicy(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(
    file,
    yaml.dump({
      capabilities: [{ id: "linear:transition" }, { id: "workflow:break-glass" }],
      containers: [
        { id: "dev", grants: ["linear:transition"] },
        { id: "steward", grants: ["linear:transition", "workflow:break-glass"] },
        { id: "test-author", grants: ["linear:transition"] },
      ],
      roles: [
        { id: "dev", requires: ["linear:transition"] },
        { id: "steward", requires: ["workflow:break-glass"] },
        { id: "test-author", requires: ["linear:transition"] },
      ],
      bodies: [
        { id: "igor", container: "dev", fills_roles: ["dev"] },
        { id: "astrid", container: "steward", fills_roles: ["steward"] },
        { id: "tdd", container: "test-author", fills_roles: ["test-author"] },
      ],
    }),
    "utf8",
  );
  return file;
}

const TEAM_STATES = [
  { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
  { id: "state-done-uuid", name: "Done", type: "completed" },
  { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
];

function makeSetStateFetch(targetState: string): typeof globalThis.fetch {
  let issueReads = 0;
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (bodyText.includes("TeamStates")) {
      return new Response(JSON.stringify({ data: { team: { states: { nodes: TEAM_STATES } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (bodyText.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "label-state-write-tests", name: "state:write-tests" },
                  { id: "label-state-implementation", name: "state:implementation" },
                  { id: "label-state-ac-validate", name: "state:ac-validate" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (bodyText.includes("ApplyAtomicTransition") || (bodyText.includes("issueUpdate") && bodyText.includes("labelIds"))) {
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (bodyText.includes("VerifyTransitionWrite")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: `state:${targetState}` }] },
              delegate: targetState === "implementation" ? { id: "user-igor-linear-id" } : null,
              state: { id: "state-todo-uuid" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (bodyText.includes("IssueWithLabels")) {
      const labels = issueReads++ === 0
        ? [{ name: "wf:dev-impl", id: "label-wf", teamId: "team-1" }, { name: "state:write-tests", id: "label-state-write-tests", teamId: "team-1" }]
        : [{ name: "wf:dev-impl", id: "label-wf", teamId: "team-1" }, { name: `state:${targetState}`, id: `label-state-${targetState}`, teamId: "team-1" }];
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "issue-inf-1037",
              identifier: "INF-1037",
              team: { id: "team-1", key: "INF" },
              labels: { nodes: labels },
              delegate: targetState === "implementation" ? { id: "user-igor-linear-id" } : null,
              state: { id: "state-todo-uuid" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("INF-1037 AC1: dispatch idempotency rejects dead zero-call owners", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not suppress a redispatch when the only existing owner is an ended zero-call session stub", () => {
    const store = new DispatchIdempotencyStore(path.join(dir, "dispatch-idempotency.db"));
    const updatedAt = "2026-07-29T12:00:00.000Z";
    store.checkAndRecord("linear-INF-1025", "write-tests", "igor", updatedAt);

    const result = store.checkAndRecord("linear-INF-1025", "write-tests", "igor", updatedAt, {
      existingOwnerEvidence: {
        sessionId: "sess-dead-zero-call",
        status: "ended",
        toolCallCount: 0,
        lastObservedAt: "2026-07-29T12:01:00.000Z",
      },
      recoveryReason: "dead-zero-call-owner",
    } as never);

    expect(result).toMatchObject({
      suppressed: false,
      stale: false,
      reclaimedDeadOwner: true,
      respawned: true,
    });
    store.close();
  });
});

describe("INF-1037 AC3: redispatch-capable proxy transitions emit wake path", () => {
  let dir: string;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = tempDir();
    savedFetch = globalThis.fetch;
    process.env.WORKFLOW_DEF_PATH = writeWorkflowDef(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicy(dir);
    process.env.AGENTS_FILE = writeAgents(dir);
    resetWorkflowCache();
    resetPolicyCache();
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    resetWorkflowCache();
    resetPolicyCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("steward promotion to an implementation owner emits delegate wake-path metadata", async () => {
    globalThis.fetch = makeSetStateFetch("implementation");
    const wakeCalls: Array<{ agentId: string; ticketId: string }> = [];

    const result = await setStateAtomic("INF-1037", "implementation", "igor", "Bearer test-token", {
      sendWakeUp: async (agentId, ticketId) => {
        wakeCalls.push({ agentId, ticketId });
      },
      transitionSource: "steward-promote",
    } as never);

    expect(result.ok).toBe(true);
    expect(wakeCalls).toEqual([{ agentId: "igor", ticketId: "INF-1037" }]);
    expect(result).toMatchObject({
      redispatched: "igor",
      wakePath: "delegate-owner-role",
      transitionSource: "steward-promote",
    });
  });

  it("migrate-state to a steward-owned state emits migrate-state wake-path metadata", async () => {
    globalThis.fetch = makeSetStateFetch("ac-validate");
    const wakeCalls: Array<{ agentId: string; ticketId: string }> = [];

    const result = await setStateAtomic("INF-1037", "ac-validate", undefined, "Bearer test-token", {
      sendWakeUp: async (agentId, ticketId) => {
        wakeCalls.push({ agentId, ticketId });
      },
      transitionSource: "migrate-state",
    } as never);

    expect(result.ok).toBe(true);
    expect(wakeCalls).toEqual([{ agentId: "astrid", ticketId: "INF-1037" }]);
    expect(result).toMatchObject({
      redispatched: "astrid",
      wakePath: "migrate-state-owner-role",
      transitionSource: "migrate-state",
    });
  });
});

describe("INF-1037 AC6/AC7: production entry point exposes dispatch-recovery liveness", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = tempDir();
    savedFetch = globalThis.fetch;
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.WORKFLOW_DEF_PATH = writeWorkflowDef(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicy(dir);
    process.env.LINEAR_WEBHOOK_SECRET = "secret-inf-1037";
    process.env.LINEAR_CONNECTOR_SECRET = "connector-secret-inf-1037";
    process.env.LINEAR_API_KEY = "test-key";
    process.env.CRON_RUN_STAMP_PATH = path.join(dir, "cron-run-stamps.json");
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    reloadAgents();
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof globalThis.fetch;
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      dispatchLeaseDbPath: path.join(dir, "lease.db"),
      dispatchInFlightDbPath: path.join(dir, "inflight.db"),
    });
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.dispatchDeliveryScheduler.stop();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
    delete process.env.AGENTS_FILE;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.LINEAR_CONNECTOR_SECRET;
    delete process.env.LINEAR_API_KEY;
    delete process.env.CRON_RUN_STAMP_PATH;
    resetWorkflowCache();
    resetPolicyCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("boots the production app factory and exposes scheduled/subscribed recovery state on /health", async () => {
    const res = await request(appState.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.dispatchRecovery).toMatchObject({
      registeredAtBootstrap: true,
      staleSessionHandlerSubscribed: true,
      dispatchIdempotencyLivenessChecks: true,
    });
    expect(res.body.dispatchRecovery.scheduledDrivers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "dispatch-recovery" }),
      ]),
    );
  });
});
