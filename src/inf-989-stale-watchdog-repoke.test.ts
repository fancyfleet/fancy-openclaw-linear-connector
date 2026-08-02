/**
 * INF-989 — stale-session watchdog comment-only recovery.
 *
 * A delegate ack/status comment after a stale-session poke is activity, but it
 * is not a workflow transition. The watchdog must keep that ticket under
 * surveillance on a slower acknowledged-without-transition cadence instead of
 * treating the comment as full recovery.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { reloadAgents } from "./agents.js";
import { createApp } from "./index.js";
import type { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import { DispatchWatchdog } from "./bag/dispatch-watchdog.js";
import type { WakeUpConfig } from "./bag/wake-up.js";

const SECRET = "inf-989-linear-webhook-secret";
const IGOR_LINEAR_ID = "9e896b7a-2bd7-401d-99f3-56b0ed25c890";
const TICKET_ID = "linear-INF-989";
const wakeConfig: WakeUpConfig = { nodeBin: process.execPath, timeoutMs: 10, maxRetries: 0 };

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-989-watchdog-"));
}

function writeAgentsFile(dir: string): string {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: IGOR_LINEAR_ID,
          openclawAgent: "igor",
          clientId: "client",
          clientSecret: "secret",
          accessToken: "",
          refreshToken: "",
        },
      ],
    }),
  );
  return agentsFile;
}

function statusCommentBody(body = "I saw the stale-session poke and am still checking this."): string {
  return JSON.stringify({
    type: "Comment",
    action: "create",
    createdAt: "2026-08-02T12:00:00.000Z",
    actor: { id: IGOR_LINEAR_ID, name: "Igor" },
    data: {
      id: "comment-inf-989-status",
      body,
      issue: {
        id: "issue-inf-989",
        identifier: "INF-989",
      },
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
    },
  });
}

async function postDelegateStatusComment(app: ReturnType<typeof createApp>["app"], deliveryId: string): Promise<void> {
  const body = statusCommentBody();
  const res = await request(app)
    .post("/")
    .set("Content-Type", "application/json")
    .set("x-linear-signature", sign(body))
    .set("x-linear-delivery", deliveryId)
    .send(body);
  expect(res.status).toBe(200);
}

function backdateAckEntry(ackTracker: DispatchAckTracker, ageHours: number): void {
  (ackTracker as unknown as { db: import("better-sqlite3").Database }).db
    .prepare(
      `UPDATE dispatch_acks
       SET dispatched_at = datetime('now', ?),
           last_signal_at = datetime('now', ?)
       WHERE agent_id = ? AND ticket_id = ?`,
    )
    .run(`-${ageHours} hours`, `-${ageHours} hours`, "igor", TICKET_ID);
}

function setupApp(dir: string, dispatched: Array<{ agentId: string; ticketIds: string[] }>) {
  process.env.AGENTS_FILE = writeAgentsFile(dir);
  process.env.LINEAR_WEBHOOK_SECRET = SECRET;
  process.env.DISPATCH_RETRY_MAX_ATTEMPTS = "10";
  reloadAgents();
  const appCtx = createApp({
    bagDbPath: path.join(dir, "bag.db"),
    operationalEventsDbPath: path.join(dir, "events.db"),
    observationsDbPath: path.join(dir, "observations.db"),
    agentQueueDbPath: path.join(dir, "queue.db"),
    sendWakeUp: async (agentId, ticketIds) => {
      dispatched.push({ agentId, ticketIds });
    },
  });
  return appCtx;
}

function seedStalePokedDispatch(appCtx: ReturnType<typeof createApp>): void {
  appCtx.bag.add("igor", TICKET_ID, "Issue");
  appCtx.sessionTracker.startSession("igor", TICKET_ID);
  appCtx.ackTracker.recordDispatch("igor", TICKET_ID);
  appCtx.ackTracker.markResignaled("igor", TICKET_ID);
}

function createCadenceWatchdog(
  appCtx: ReturnType<typeof createApp>,
  dispatched: Array<{ agentId: string; ticketIds: string[] }>,
): DispatchWatchdog {
  return new DispatchWatchdog(
    {
      bag: appCtx.bag,
      sessionTracker: appCtx.sessionTracker,
      ackTracker: appCtx.ackTracker,
      operationalEventStore: appCtx.operationalEventStore,
      wakeConfig,
      resignalOptions: {
        isTicketActionable: () => true,
        sendWakeUp: async (agentId, ticketIds) => {
          dispatched.push({ agentId, ticketIds });
        },
      },
    },
    { ackTimeoutMs: 0, maxResignals: 3, cycleIntervalMs: 60_000 },
  );
}

describe("INF-989 stale-session watchdog ack-without-transition cadence", () => {
  let dir: string;
  let dispatched: Array<{ agentId: string; ticketIds: string[] }>;
  let appCtx: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = tempDir();
    dispatched = [];
    appCtx = setupApp(dir, dispatched);
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.DISPATCH_RETRY_MAX_ATTEMPTS;
    reloadAgents();
    appCtx.dispatchDeliveryScheduler.stop();
    appCtx.watchdog.stop();
    appCtx.noActivityDetector.stop();
    appCtx.stuckDelegateDetector.stop();
    appCtx.managingPoller.stop();
    appCtx.bag.close();
    appCtx.sessionTracker.close();
    appCtx.operationalEventStore.close();
    appCtx.ackTracker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("delegate status comment after stale poke keeps watchdog surveillance open when no workflow transition occurs", async () => {
    seedStalePokedDispatch(appCtx);

    await postDelegateStatusComment(appCtx.app, "inf-989-status-comment-surveillance");

    const watchedEntries = appCtx.ackTracker.getPendingTimedOut(0);
    expect(watchedEntries).toHaveLength(1);
    expect(watchedEntries[0]).toMatchObject({
      agentId: "igor",
      ticketId: TICKET_ID,
    });
    expect(watchedEntries[0].ackStatus).not.toBe("acknowledged");
  });

  test("ack-without-transition reaches the next cadence and re-pokes the delegate after two hours", async () => {
    seedStalePokedDispatch(appCtx);
    await postDelegateStatusComment(appCtx.app, "inf-989-status-comment-repoke");
    backdateAckEntry(appCtx.ackTracker, 2);

    const watchdog = createCadenceWatchdog(appCtx, dispatched);
    const result = await watchdog.runCycle();

    expect(result.unconfirmed).toBe(1);
    expect(result.resignaled).toBe(1);
    expect(dispatched).toEqual([
      { agentId: "igor", ticketIds: [TICKET_ID] },
    ]);
    expect(appCtx.operationalEventStore.query({ outcome: "watchdog-resignal" })).toHaveLength(1);
  });

  test("continued ack-without-transition inactivity escalates to steward by the later four-hour cadence", async () => {
    seedStalePokedDispatch(appCtx);
    appCtx.ackTracker.markResignaled("igor", TICKET_ID);
    appCtx.ackTracker.markResignaled("igor", TICKET_ID);
    await postDelegateStatusComment(appCtx.app, "inf-989-status-comment-escalate");
    backdateAckEntry(appCtx.ackTracker, 4);

    const watchdog = createCadenceWatchdog(appCtx, dispatched);
    const result = await watchdog.runCycle();

    expect(result.escalated).toBe(1);
    expect(result.resignaled).toBe(0);
    expect(dispatched).toHaveLength(0);
    const escalations = appCtx.operationalEventStore.query({ outcome: "watchdog-escalation" });
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      agent: "igor",
      key: TICKET_ID,
    });
  });
});
