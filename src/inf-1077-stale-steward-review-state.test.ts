/**
 * INF-1077 — Connector redispatch steward state can stay stale after delegate/state changes.
 *
 * Regression coverage only. These tests intentionally require behavior the
 * current connector does not expose yet:
 *
 * AC1: requester/doing -> reviewer/review handoff dispatches against the
 *      reviewer workflow state, not the native Linear Doing column.
 * AC2: fixture-backed dispatch ledger shows an INF-like review ticket's
 *      authoritative dispatch belongs to Charles/review; an older
 *      Astrid/doing dispatch remains historical only.
 * AC3: admin evidence exposes enough current-vs-historical dispatch state that
 *      an operator can detect the stale class without manually comparing the
 *      Linear timeline to steward lookup.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetCronRegistryForTest } from "./cron/registry.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import type { OperationalEvent, OperationalEventStore } from "./store/operational-event-store.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";

const SECRET = "inf-1077-webhook-secret";
const ADMIN_SECRET = "inf-1077-admin-secret";

const ASTRID_ID = "inf-1077-astrid-linear-id";
const CHARLES_ID = "inf-1077-charles-linear-id";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-1077-"));
}

function writeAgentsFile(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "astrid",
          linearUserId: ASTRID_ID,
          openclawAgent: "astrid",
          clientId: "astrid-client",
          clientSecret: "astrid-secret",
          accessToken: "",
          refreshToken: "",
          host: "local",
        },
        {
          name: "charles",
          linearUserId: CHARLES_ID,
          openclawAgent: "charles",
          clientId: "charles-client",
          clientSecret: "charles-secret",
          accessToken: "",
          refreshToken: "",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function makeReviewHandoffPayload(): string {
  return JSON.stringify({
    type: "Issue",
    action: "update",
    createdAt: "2026-08-01T12:00:00.000Z",
    actor: { id: ASTRID_ID, name: "Astrid" },
    updatedFrom: {
      delegateId: ASTRID_ID,
      labelIds: ["state-doing-label-id"],
    },
    data: {
      id: "issue-inf-1077",
      identifier: "INF-1077",
      title: "Connector redispatch steward state can stay stale after delegate/state changes",
      state: { id: "native-doing-id", name: "Doing", type: "started" },
      priority: 0,
      priorityLabel: "No priority",
      team: { id: "team-inf", key: "INF" },
      delegate: { id: CHARLES_ID, name: "Charles" },
      assignee: { id: CHARLES_ID, name: "Charles" },
      labels: {
        nodes: [
          { id: "wf-task-label-id", name: "wf:task" },
          { id: "state-review-label-id", name: "state:review" },
        ],
      },
      labelIds: ["wf-task-label-id", "state-review-label-id"],
      url: "https://linear.app/fancyfleet/issue/INF-1077",
      createdAt: "2026-08-01T11:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    },
  });
}

async function postWebhook(app: import("express").Express, body: string): Promise<void> {
  const res = await request(app)
    .post("/")
    .set("Content-Type", "application/json")
    .set("x-linear-signature", sign(body))
    .set("x-linear-delivery", "inf-1077-review-handoff")
    .send(body);
  expect(res.status).toBe(200);
}

async function waitForRouted(store: OperationalEventStore, key: string): Promise<OperationalEvent> {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    const event = store.query({ key, outcome: "routed" as never, limit: 20 })[0];
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for routed event for ${key}`);
}

function getMirror(app: ReturnType<typeof createApp>): EnrolledTicketsStore {
  const mirror = (app as unknown as { enrolledTicketsStore?: EnrolledTicketsStore }).enrolledTicketsStore;
  if (!mirror) throw new Error("enrolledTicketsStore not exposed on createApp return");
  return mirror;
}

function closeApp(app: ReturnType<typeof createApp> | undefined): void {
  app?.bag?.close();
  app?.sessionTracker?.close();
  app?.agentQueue?.close();
  app?.operationalEventStore?.close();
}

describe("INF-1077 AC1/AC2 — review handoff dispatch authority", () => {
  const originalEnv = process.env;
  let dir: string;
  let app: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    delete process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_DEVELOPER_TOKEN;
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir);
    reloadAgents();
    resetConfigHealth();
    resetCronRegistryForTest();
    resetWorkflowCache();
    app = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled-tickets.db"),
      idempotencyDbPath: path.join(dir, "dispatch-idempotency.db"),
    });
  });

  afterEach(() => {
    closeApp(app);
    app = undefined;
    delete process.env.AGENTS_FILE;
    resetWorkflowCache();
    resetConfigHealth();
    resetCronRegistryForTest();
    reloadAgents();
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC1: requester/doing -> reviewer/review records routed dispatch against reviewer state", async () => {
    const store = app!.operationalEventStore as OperationalEventStore;

    store.append({
      outcome: "dispatch-accepted",
      agent: "astrid",
      key: "linear-INF-1077",
      sessionKey: "linear-INF-1077",
      workflowState: "doing",
      plane: "connector",
      occurredAt: "2026-08-01T11:30:00.000Z",
      detail: { role: "requester", source: "historical-dispatch" },
    });

    await postWebhook(app!.app, makeReviewHandoffPayload());

    const routed = await waitForRouted(store, "linear-INF-1077");
    expect(routed.agent).toBe("charles");
    expect(routed.workflowState).toBe("review");
    expect(routed.detail).toMatchObject({
      authoritativeWorkflowStateSource: "state-label",
      staleNativeState: "Doing",
    });
  });

  it("AC2/AC3: admin ticket detail marks Charles/review authoritative and Astrid/doing historical", async () => {
    const mirror = getMirror(app!);
    const store = app!.operationalEventStore as OperationalEventStore;

    mirror.enroll({
      ticketId: "INF-1077",
      workflow: "task",
      state: "doing",
      delegate: "astrid",
    });
    mirror.recordTransition({
      ticketId: "INF-1077",
      toState: "review",
      delegate: "charles",
      eventKind: "continue-workflow",
    });

    store.append({
      outcome: "dispatch-accepted",
      agent: "astrid",
      key: "linear-INF-1077",
      sessionKey: "linear-INF-1077",
      workflowState: "doing",
      wakeId: "wake-astrid-doing",
      occurredAt: "2026-08-01T11:30:00.000Z",
    });
    store.append({
      outcome: "dispatch-accepted",
      agent: "charles",
      key: "linear-INF-1077",
      sessionKey: "linear-INF-1077",
      workflowState: "review",
      wakeId: "wake-charles-review",
      occurredAt: "2026-08-01T12:00:00.000Z",
    });

    const res = await request(app!.app)
      .get("/admin/api/board/ticket/INF-1077")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ticket_id: "INF-1077",
      workflow: "task",
      state: "review",
      delegate: "charles",
      current_dispatch_authority: {
        delegate: "charles",
        workflow_state: "review",
        dispatch_id: "wake-charles-review",
        supersedes: ["wake-astrid-doing"],
      },
    });

    const astridDoing = (res.body.dispatch_timeline as Array<Record<string, unknown>>)
      .find((entry) => entry.dispatch_id === "wake-astrid-doing");
    expect(astridDoing).toMatchObject({
      delegate: "astrid",
      workflow_state: "doing",
      authoritative: false,
      stale_reason: "superseded-by-current-ticket-state",
    });

    const charlesReview = (res.body.dispatch_timeline as Array<Record<string, unknown>>)
      .find((entry) => entry.dispatch_id === "wake-charles-review");
    expect(charlesReview).toMatchObject({
      delegate: "charles",
      workflow_state: "review",
      authoritative: true,
      stale_reason: null,
    });
  });
});

describe("INF-1077 AC4/AC5 — steward-state redispatch bootstrap liveness", () => {
  const originalEnv = process.env;
  let dir: string;
  let app: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir);
    reloadAgents();
    resetConfigHealth();
    resetCronRegistryForTest();
    resetWorkflowCache();
    app = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled-tickets.db"),
      idempotencyDbPath: path.join(dir, "dispatch-idempotency.db"),
    });
  });

  afterEach(() => {
    closeApp(app);
    app = undefined;
    delete process.env.AGENTS_FILE;
    resetWorkflowCache();
    resetConfigHealth();
    resetCronRegistryForTest();
    reloadAgents();
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC4/AC5: production app boot exposes steward-state redispatch registration on /health", async () => {
    const res = await request(app!.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("stewardStateRedispatch");

    const liveness = res.body.stewardStateRedispatch as Record<string, unknown>;
    expect(liveness).toMatchObject({
      registered: true,
      active: true,
    });
    expect(liveness.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: expect.stringMatching(/health|registry|startup/i),
          component: "steward-state-redispatch",
        }),
      ]),
    );
  });
});
