/**
 * INF-1043 — stale-session recovery must not replay a stale Charles review.
 *
 * AC mapping:
 * - AC1/AC3: reproduce the residual duplicate-review replay as a red regression
 *   test by simulating a stale code-review session with Charles' ticket already
 *   queued for recovery.
 * - AC2: recovered code-review dispatch must use a fresh `:rN` session key, not
 *   the pre-recovery `linear-INF-1043` key that can replay Charles' stale review.
 * - AC4/AC5: boot through createApp()/webhook registration and keep the existing
 *   stale-session recovery liveness surface observable on /health.
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
import { resetWorkflowCache } from "./workflow-gate.js";

type AppState = ReturnType<typeof createApp>;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "charles",
          linearUserId: "linear-user-charles",
          openclawAgent: "charles",
          accessToken: "token-charles",
          refreshToken: "refresh-charles",
          clientId: "client-charles",
          clientSecret: "secret-charles",
          hooksUrl: "http://127.0.0.1/hooks/charles",
          hooksToken: "hooks-token-charles",
          host: "local",
        },
        {
          name: "astrid",
          linearUserId: "linear-user-astrid",
          openclawAgent: "astrid",
          accessToken: "token-astrid",
          refreshToken: "refresh-astrid",
          clientId: "client-astrid",
          clientSecret: "secret-astrid",
          hooksUrl: "http://127.0.0.1/hooks/astrid",
          hooksToken: "hooks-token-astrid",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

function makeCodeReviewWebhook() {
  const now = new Date().toISOString();
  return {
    type: "Issue",
    action: "update",
    createdAt: now,
    actor: { id: "linear-user-astrid", name: "Astrid" },
    data: {
      id: "issue-inf-1043",
      identifier: "INF-1043",
      title: "Stale Charles review replay",
      state: { id: "state-todo", name: "To Do", type: "unstarted" },
      priority: 0,
      priorityLabel: "No priority",
      team: { id: "team-inf", key: "INF" },
      teamId: "team-inf",
      teamKey: "INF",
      delegate: { id: "linear-user-charles", name: "Charles" },
      labels: {
        nodes: [
          { id: "label-wf-dev-impl", name: "wf:dev-impl" },
          { id: "label-state-code-review", name: "state:code-review" },
        ],
      },
      labelIds: ["label-wf-dev-impl", "label-state-code-review"],
      url: "https://linear.app/fancymatt/issue/INF-1043",
      createdAt: now,
      updatedAt: now,
    },
    updatedFrom: { delegateId: "linear-user-igor" },
  };
}

function closeApp(appState: AppState): void {
  for (const key of [
    "agentQueue",
    "bag",
    "sessionTracker",
    "operationalEventStore",
    "deadLetterQueue",
    "enrolledTicketsStore",
    "observationStore",
    "dispatchDeliveryScheduler",
    "watchdog",
    "noActivityDetector",
    "stuckDelegateDetector",
    "managingPoller",
    "managingStateStore",
    "mutationAuditStore",
    "idempotencyStore",
    "proposalStore",
    "dispatchLeaseStore",
    "dispatchInFlightStore",
    "sessionSpawnStore",
    "livenessDispatchStore",
    "globalRedispatchBudget",
  ] as const) {
    const value = appState[key] as { close?: () => void; stop?: () => void } | undefined;
    value?.close?.();
    value?.stop?.();
  }
}

async function waitForSpawnRecord(appState: AppState): Promise<void> {
  const deadline = Date.now() + 750;
  while (Date.now() < deadline) {
    if (appState.sessionSpawnStore.listByTicket("INF-1043").length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("INF-1043: registered stale-session recovery extends fresh keys to Charles review replay", () => {
  let dir: string;
  let appState: AppState;
  let sent: Array<{ agentId: string; ticketIds: string[] }>;
  let originalFetch: typeof globalThis.fetch;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1043-"));
    sent = [];
    originalFetch = globalThis.fetch;
    for (const key of [
      "AGENTS_FILE",
      "DATA_DIR",
      "LINEAR_WEBHOOK_SECRET",
      "LINEAR_WEBHOOK_SECRETS",
      "LINEAR_OAUTH_TOKEN",
      "LINEAR_API_KEY",
      "OPENCLAW_HOME",
      "STALE_SESSION_DIAGNOSTICS_DIR",
      "WORKFLOW_DEF_PATH",
      "WORKFLOW_DEFS_DIR",
      "WORKFLOW_DEF_STATE_SNAPSHOT_PATH",
      "CAPABILITY_POLICY_PATH",
    ]) {
      originalEnv[key] = process.env[key];
    }

    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.DATA_DIR = path.join(dir, "data");
    process.env.OPENCLAW_HOME = path.join(dir, "openclaw");
    process.env.STALE_SESSION_DIAGNOSTICS_DIR = path.join(dir, "diagnostics");
    process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "def-state-snapshot.json");
    delete process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.WORKFLOW_DEFS_DIR;
    delete process.env.CAPABILITY_POLICY_PATH;

    resetConfigHealth();
    resetWorkflowCache();
    resetPolicyCache();
    reloadAgents();
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = url.includes("api.linear.app")
        ? {
            data: {
              issue: {
                id: "issue-inf-1043",
                identifier: "INF-1043",
                delegate: { id: "linear-user-charles", name: "Charles", app: true },
                assignee: null,
                state: { name: "To Do", type: "unstarted" },
                trashed: false,
                archivedAt: null,
                relations: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            },
          }
        : { ok: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    appState = createApp({
      agentQueueDbPath: path.join(dir, "queue.db"),
      bagDbPath: path.join(dir, "bag.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled.db"),
      livenessDispatchDbPath: path.join(dir, "liveness.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      dispatchLeaseDbPath: path.join(dir, "lease.db"),
      dispatchInFlightDbPath: path.join(dir, "inflight.db"),
      sessionSpawnIdempotencyDbPath: path.join(dir, "spawn.db"),
      sendWakeUp: async (agentId, ticketIds) => {
        sent.push({ agentId, ticketIds });
      },
    });
  });

  afterEach(() => {
    closeApp(appState);
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigHealth();
    resetWorkflowCache();
    resetPolicyCache();
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC2/AC3: webhook stale drain re-dispatches Charles code-review with a fresh :rN key and no stale base-key replay", async () => {
    appState.bag.add("charles", "INF-1043", "Issue", "delegate");
    appState.sessionTracker.startSession("charles", "linear-INF-1043");
    appState.sessionTracker.queueSignal("charles", ["linear-INF-1043"]);

    const activeSessions = (appState.sessionTracker as unknown as {
      activeSessions: Map<string, Map<string, number>>;
    }).activeSessions;
    activeSessions.get("charles")?.set("linear-INF-1043", Date.now() - 26 * 60 * 1000);

    const res = await request(appState.app)
      .post("/")
      .set("linear-event", "Issue")
      .send(makeCodeReviewWebhook());

    expect(res.status).toBe(200);
    await waitForSpawnRecord(appState);

    const charlesSessionKeys = appState.sessionSpawnStore
      .listByTicket("INF-1043")
      .filter((record) => record.agent_id === "charles")
      .map((record) => record.session_key);

    expect(charlesSessionKeys).toEqual(
      expect.arrayContaining([expect.stringMatching(/^linear-INF-1043:r\d+$/)]),
    );
    expect(charlesSessionKeys).not.toContain("linear-INF-1043");
  });

  it("AC5: recovery liveness stays observable from the production bootstrap health surface", async () => {
    const res = await request(appState.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.staleSessionRecovery).toMatchObject({
      driverRegistered: true,
      staleSessionHandlerSubscribed: true,
      governedRedispatchReseatActive: true,
    });
  });
});
