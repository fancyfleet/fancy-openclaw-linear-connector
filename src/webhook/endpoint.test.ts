import crypto from "crypto";
import request from "supertest";
import { createApp } from "../index.js";

const SECRET = "test-endpoint-secret";

function sign(body: string): string {
  return crypto
    .createHmac("sha256", SECRET)
    .update(Buffer.from(body))
    .digest("hex");
}

const validIssueBody = JSON.stringify({
  type: "Issue",
  action: "create",
  createdAt: "2026-04-10T12:00:00.000Z",
  actor: { id: "a1", name: "Alice" },
  data: {
    id: "i1",
    identifier: "ENG-1",
    title: "Test issue",
    state: { id: "s1", name: "Todo", type: "unstarted" },
    priority: 0,
    priorityLabel: "No priority",
    team: { id: "t1", key: "ENG" },
    labelIds: [],
    url: "https://.app/test/issue/ENG-1",
    createdAt: "2026-04-10T12:00:00.000Z",
    updatedAt: "2026-04-10T12:00:00.000Z",
  },
});

describe("POST /", () => {
  let app: ReturnType<typeof createApp>["app"];

  let savedWebhookSecrets: string | undefined;

  beforeEach(() => {
    savedWebhookSecrets = process.env.LINEAR_WEBHOOK_SECRETS;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    ({ app } = createApp());
  });

  afterEach(() => {
    delete process.env.LINEAR_WEBHOOK_SECRET;
    if (savedWebhookSecrets !== undefined) {
      process.env.LINEAR_WEBHOOK_SECRETS = savedWebhookSecrets;
    }
  });

  it("returns 200 for a valid signed request", async () => {
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(validIssueBody))
      .send(validIssueBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 401 for an invalid signature", async () => {
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", "deadbeef".repeat(8))
      .send(validIssueBody);

    expect(res.status).toBe(401);
  });

  it("returns 400 when signature header is missing", async () => {
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .send(validIssueBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  it("returns 400 for malformed JSON", async () => {
    const badBody = "not-json{{{";
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(badBody))
      .send(badBody);

    expect(res.status).toBe(400);
  });

  it("returns 400 for a payload missing required fields", async () => {
    const badPayload = JSON.stringify({ foo: "bar" });
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(badPayload))
      .send(badPayload);

    expect(res.status).toBe(400);
  });

  it("skips signature validation when no webhook secrets are configured", async () => {
    delete process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(validIssueBody))
      .send(validIssueBody);

    // When no secret is configured, signature validation is skipped
    expect(res.status).toBe(200);
  });

  // INF-1330 AC1 endpoint-level regressions: staging must fail-closed, not
  // skip validation, when its secret is absent — and must ignore prod secrets.
  it("INF-1330: CONNECTOR_ENV=staging rejects unsigned webhooks when staging secret is absent (fail-closed)", async () => {
    const savedStaging = process.env.LINEAR_WEBHOOK_SECRET_STAGING;
    const savedConn = process.env.CONNECTOR_ENV;
    const savedMulti = process.env.LINEAR_WEBHOOK_SECRETS;
    const savedSingle = process.env.LINEAR_WEBHOOK_SECRET;
    try {
      process.env.CONNECTOR_ENV = "staging";
      delete process.env.LINEAR_WEBHOOK_SECRET_STAGING;
      delete process.env.LINEAR_WEBHOOK_SECRETS_STAGING;
      // Prod secrets also present on the host — staging must NOT consume them
      process.env.LINEAR_WEBHOOK_SECRET = SECRET;
      process.env.LINEAR_WEBHOOK_SECRETS = "prod-a, prod-b";
      const stagingApp = createApp().app;
      const resNoSig = await request(stagingApp)
        .post("/")
        .set("Content-Type", "application/json")
        .send(validIssueBody);
      // No bypass — staging with no staging secret rejects instead of 200-skipping validation
      expect(resNoSig.status).toBe(401);
      expect(resNoSig.body.error).toMatch(/Staging webhook secret not configured/i);
      // Prod-signed payload also rejected — no shared ingress
      const prodSig = sign(validIssueBody);
      const resProdSig = await request(stagingApp)
        .post("/")
        .set("Content-Type", "application/json")
        .set("x-linear-signature", prodSig)
        .send(validIssueBody);
      expect(resProdSig.status).toBe(401);
    } finally {
      if (savedStaging === undefined) delete process.env.LINEAR_WEBHOOK_SECRET_STAGING;
      else process.env.LINEAR_WEBHOOK_SECRET_STAGING = savedStaging;
      const sv2 = savedMulti;
      if (sv2 === undefined) delete process.env.LINEAR_WEBHOOK_SECRETS;
      else process.env.LINEAR_WEBHOOK_SECRETS = sv2;
      const sv3 = savedSingle;
      if (sv3 === undefined) delete process.env.LINEAR_WEBHOOK_SECRET;
      else process.env.LINEAR_WEBHOOK_SECRET = sv3;
      const sv4 = savedConn;
      if (sv4 === undefined) delete process.env.CONNECTOR_ENV;
      else process.env.CONNECTOR_ENV = sv4;
      // clean up new var
      delete (process.env as Record<string, string | undefined>).LINEAR_WEBHOOK_SECRETS_STAGING;
    }
  });

  it("INF-1330: CONNECTOR_ENV=staging with LINEAR_WEBHOOK_SECRETS set to prod secrets still rejects prod-signed payloads", async () => {
    const savedStaging = process.env.LINEAR_WEBHOOK_SECRET_STAGING;
    const savedConn = process.env.CONNECTOR_ENV;
    const savedMulti = process.env.LINEAR_WEBHOOK_SECRETS;
    try {
      process.env.CONNECTOR_ENV = "staging";
      delete process.env.LINEAR_WEBHOOK_SECRET_STAGING;
      delete process.env.LINEAR_WEBHOOK_SECRETS_STAGING;
      delete process.env.LINEAR_WEBHOOK_SECRET;
      process.env.LINEAR_WEBHOOK_SECRETS = "prod-a, prod-b";
      const stagingApp = createApp().app;
      const prodMultiSig = crypto.createHmac("sha256", "prod-a").update(Buffer.from(validIssueBody)).digest("hex");
      const res = await request(stagingApp)
        .post("/")
        .set("Content-Type", "application/json")
        .set("x-linear-signature", prodMultiSig)
        .send(validIssueBody);
      // Staging ignores prod multi — still fail-closed (no staging secret)
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Staging webhook secret not configured/i);
    } finally {
      if (savedStaging === undefined) delete process.env.LINEAR_WEBHOOK_SECRET_STAGING;
      else process.env.LINEAR_WEBHOOK_SECRET_STAGING = savedStaging;
      if (savedMulti === undefined) delete process.env.LINEAR_WEBHOOK_SECRETS;
      else process.env.LINEAR_WEBHOOK_SECRETS = savedMulti;
      if (savedConn === undefined) delete process.env.CONNECTOR_ENV;
      else process.env.CONNECTOR_ENV = savedConn;
      delete (process.env as Record<string, string | undefined>).LINEAR_WEBHOOK_SECRETS_STAGING;
      delete process.env.LINEAR_WEBHOOK_SECRET;
      process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    }
  });
});
