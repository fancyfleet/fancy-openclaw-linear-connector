import crypto from "crypto";
import express from "express";
import request from "supertest";
import { initAlertBus, _resetAlertBusForTests, getAlertBus } from "../alerts/alert-bus.js";
import { OperationalEventStore } from "../store/operational-event-store.js";
import { createWebhookRouter } from "./index.js";

const SECRET = "configured-secret";
const MISSING_TEAM_SECRET = "missing-team-secret";

function createTestApp(operationalEventStore: OperationalEventStore) {
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
  app.use("/", createWebhookRouter(undefined, undefined, undefined, undefined, undefined, undefined, operationalEventStore));
  return app;
}

describe("signature rejection diagnostics", () => {
  let savedSecret: string | undefined;
  let savedSecrets: string | undefined;
  let savedThreshold: string | undefined;
  let store: OperationalEventStore;

  beforeEach(() => {
    savedSecret = process.env.LINEAR_WEBHOOK_SECRET;
    savedSecrets = process.env.LINEAR_WEBHOOK_SECRETS;
    savedThreshold = process.env.LINEAR_WEBHOOK_DRIFT_ALERT_THRESHOLD;
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    process.env.LINEAR_WEBHOOK_DRIFT_ALERT_THRESHOLD = "2";
    store = new OperationalEventStore(":memory:");
    initAlertBus({ pushEnabled: false });
  });

  afterEach(() => {
    store.close();
    if (savedSecret === undefined) delete process.env.LINEAR_WEBHOOK_SECRET;
    else process.env.LINEAR_WEBHOOK_SECRET = savedSecret;
    if (savedSecrets === undefined) delete process.env.LINEAR_WEBHOOK_SECRETS;
    else process.env.LINEAR_WEBHOOK_SECRETS = savedSecrets;
    if (savedThreshold === undefined) delete process.env.LINEAR_WEBHOOK_DRIFT_ALERT_THRESHOLD;
    else process.env.LINEAR_WEBHOOK_DRIFT_ALERT_THRESHOLD = savedThreshold;
    _resetAlertBusForTests();
  });

  test("invalid signatures still reject while recording webhookId and teamKey", async () => {
    const app = createTestApp(store);
    const body = JSON.stringify({
      webhookId: "wh_missing",
      organizationId: "org_1",
      type: "Issue",
      action: "update",
      data: {
        id: "issue_1",
        identifier: "ENG-1",
        team: { id: "team_1", key: "ENG" },
      },
    });

    await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", crypto.createHmac("sha256", "wrong-secret").update(Buffer.from(body)).digest("hex"))
      .send(body)
      .expect(401);

    const rejected = store.query({ outcome: "signature-rejected", limit: 1 })[0];
    expect(rejected.errorSummary).toBe("Invalid signature");
    expect(rejected.type).toBe("Issue");
    expect(rejected.key).toBe("ENG:wh_missing");
    expect(rejected.detail).toMatchObject({
      webhookId: "wh_missing",
      organizationId: "org_1",
      teamKey: "ENG",
      action: "update",
      parseStatus: "parsed",
      loadedHmacCount: 1,
    });
  });

  test("malformed rejected bodies do not throw or alert as identified drift", async () => {
    const app = createTestApp(store);

    await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", "deadbeef".repeat(8))
      .send("not-json{{")
      .expect(401);

    const rejected = store.query({ outcome: "signature-rejected", limit: 1 })[0];
    expect(rejected.detail).toMatchObject({ parseStatus: "malformed" });
    expect(getAlertBus().getStore()!.query({ source: "webhook-secret-drift" })).toHaveLength(0);
  });

  test("repeated identified rejects fire a named webhook drift alert", async () => {
    const app = createTestApp(store);
    const body = JSON.stringify({
      webhookId: "wh_lso",
      type: "Issue",
      action: "create",
      data: { team: { key: "LSO" } },
    });
    const invalidSignature = crypto.createHmac("sha256", "missing-secret").update(Buffer.from(body)).digest("hex");

    await request(app).post("/").set("Content-Type", "application/json").set("x-linear-signature", invalidSignature).send(body).expect(401);
    await request(app).post("/").set("Content-Type", "application/json").set("x-linear-signature", invalidSignature).send(body).expect(401);

    const alerts = getAlertBus().getStore()!.query({ source: "webhook-secret-drift" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("team LSO / webhook wh_lso");
  });

  test("a hot-added team secret turns the identified reject stream to zero for the same webhook", async () => {
    const app = createTestApp(store);
    const body = JSON.stringify({
      webhookId: "wh_hot_add",
      organizationId: "org_1",
      type: "Issue",
      action: "create",
      actor: { id: "actor_1", name: "Alice" },
      data: {
        id: "issue_hot_add",
        identifier: "LSO-15",
        title: "Residual rejected team webhook",
        state: { id: "state_1", name: "Todo", type: "unstarted" },
        priority: 0,
        priorityLabel: "No priority",
        team: { id: "team_lso", key: "LSO" },
        labelIds: [],
        url: "https://linear.app/fancymatt/issue/LSO-15",
        createdAt: "2026-07-25T12:00:00.000Z",
        updatedAt: "2026-07-25T12:00:00.000Z",
      },
    });
    const missingTeamSignature = crypto.createHmac("sha256", MISSING_TEAM_SECRET).update(Buffer.from(body)).digest("hex");

    await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", missingTeamSignature)
      .send(body)
      .expect(401);
    expect(store.query({ outcome: "signature-rejected" })).toHaveLength(1);

    process.env.LINEAR_WEBHOOK_SECRETS = `${SECRET},${MISSING_TEAM_SECRET}`;

    await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", missingTeamSignature)
      .send(body)
      .expect(200);

    expect(store.query({ outcome: "signature-rejected" })).toHaveLength(1);
    expect(store.query({ outcome: "normalized", type: "Issue" })).toHaveLength(1);
  });
});
