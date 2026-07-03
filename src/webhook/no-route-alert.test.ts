import crypto from "crypto";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { reloadAgents } from "../agents.js";
import { getAlertBus, initAlertBus, _resetAlertBusForTests } from "../alerts/alert-bus.js";
import { createWebhookRouter } from "./index.js";

const SECRET = "test-no-route-alert-secret";
const ASTRID_ID = "7a946365-bdf0-4e06-b31a-b90f0cc9fb22";
const UNKNOWN_ID = "00000000-0000-0000-0000-00000000dead";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function createTestApp() {
  const app = express();
  app.use(
    express.raw({ type: "application/json", limit: "1mb" }),
    (req, _res, next) => {
      if (Buffer.isBuffer(req.body)) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = req.body;
      }
      next();
    },
  );
  app.use("/", createWebhookRouter());
  return app;
}

async function post(app: express.Express, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  await request(app)
    .post("/")
    .set("linear-signature", sign(body))
    .set("content-type", "application/json")
    .send(body)
    .expect(200);
}

function routingAlerts(): unknown[] {
  return getAlertBus().getStore()!.query({}).filter((row) => row.source === "routing");
}

// Audit #1 follow-up: the no-route warning must page only when the event
// actually named a delegate/assignee/mention we couldn't resolve. Entity
// events with no routing candidates (e.g. IssueLabel create, 2026-07-03
// 2 AM noise) no-route by construction and must stay log+store only.
describe("no-route alert scoping", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-route-alert-test-"));
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          {
            name: "astrid",
            linearUserId: ASTRID_ID,
            openclawAgent: "astrid",
            clientId: "c1",
            clientSecret: "s1",
            accessToken: "tok1",
            refreshToken: "ref1",
          },
        ],
      }),
    );
    process.env.AGENTS_FILE = agentsFile;
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    reloadAgents();
    initAlertBus({ pushEnabled: false });
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    reloadAgents();
    _resetAlertBusForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("IssueLabel create (no routing candidates) does NOT raise a routing alert", async () => {
    const app = createTestApp();
    await post(app, {
      type: "IssueLabel",
      action: "create",
      actor: { id: "some-human", name: "Matt" },
      data: { id: "lbl-1", name: "new-label", color: "#aabbcc" },
    });
    expect(routingAlerts()).toHaveLength(0);
  });

  test("unassigned Issue create (no routing candidates) does NOT raise a routing alert", async () => {
    const app = createTestApp();
    await post(app, {
      type: "Issue",
      action: "create",
      actor: { id: "some-human", name: "Matt" },
      data: { id: "iss-1", identifier: "AI-9999", title: "unassigned" },
    });
    expect(routingAlerts()).toHaveLength(0);
  });

  test("Issue delegated to an id unknown to agents.json DOES raise a routing alert", async () => {
    const app = createTestApp();
    await post(app, {
      type: "Issue",
      action: "update",
      actor: { id: "some-human", name: "Matt" },
      data: { id: "iss-2", identifier: "AI-9998", title: "misrouted", delegate: { id: UNKNOWN_ID } },
      updatedFrom: { delegateId: null },
    });
    const alerts = routingAlerts();
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as { detail?: string }).detail).toContain(UNKNOWN_ID);
  });

  test("self-triggered no-route with a resolvable delegate does NOT raise a routing alert", async () => {
    const app = createTestApp();
    await post(app, {
      type: "Comment",
      action: "create",
      actor: { id: ASTRID_ID, name: "astrid" },
      data: { id: "cmt-1", body: "progress note", issue: { identifier: "AI-9997" }, delegate: { id: ASTRID_ID } },
    });
    expect(routingAlerts()).toHaveLength(0);
  });
});
