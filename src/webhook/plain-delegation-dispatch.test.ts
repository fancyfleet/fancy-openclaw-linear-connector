import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { reloadAgents } from "../agents.js";
import { createWebhookRouter } from "./index.js";

const SECRET = "inf-334-plain-delegation-secret";
const IGOR_LINEAR_ID = "linear-user-igor";
const SAGE_LINEAR_ID = "linear-user-sage";
const HOOKS_URL = "https://hooks.test/openclaw";

type HookDelivery = {
  agentId: string;
  sessionKey: string;
  message: string;
};

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function createTestApp(onDispatched?: (agentId: string, ticketId: string) => void): express.Express {
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
  app.use(
    "/",
    createWebhookRouter(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onDispatched,
    ),
  );
  return app;
}

async function postWebhook(app: express.Express, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  await request(app)
    .post("/")
    .set("linear-signature", sign(body))
    .set("content-type", "application/json")
    .send(body)
    .expect(200);
}

async function waitFor(condition: () => boolean): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function issueUpdate(delegate: { id: string; name: string } | null, updatedFrom: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "Issue",
    action: "update",
    createdAt: "2026-07-22T21:20:00.000Z",
    actor: { id: "human-user", name: "Matt Henry" },
    data: {
      id: "issue-dsn-334",
      identifier: "DSN-334",
      title: "Plain delegated design ticket",
      team: { id: "team-dsn", key: "DSN" },
      labelIds: [],
      delegate,
      updatedAt: "2026-07-22T21:20:00.000Z",
    },
    updatedFrom,
  };
}

describe("INF-334 plain delegation webhook dispatch", () => {
  let dir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let originalFetch: typeof globalThis.fetch;
  let deliveries: HookDelivery[];

  beforeEach(() => {
    originalEnv = process.env;
    originalFetch = globalThis.fetch;
    deliveries = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-334-plain-dispatch-"));
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          {
            name: "igor",
            linearUserId: IGOR_LINEAR_ID,
            openclawAgent: "igor",
            hooksUrl: HOOKS_URL,
            hooksToken: "hook-token",
          },
          {
            name: "sage",
            linearUserId: SAGE_LINEAR_ID,
            openclawAgent: "sage",
            hooksUrl: HOOKS_URL,
            hooksToken: "hook-token",
          },
        ],
      }),
      "utf8",
    );
    process.env = {
      ...originalEnv,
      AGENTS_FILE: agentsFile,
      LINEAR_WEBHOOK_SECRET: SECRET,
      REQUIRE_GATEWAY_DELIVERY: "false",
    };
    reloadAgents();
    globalThis.fetch = async (url, init) => {
      if (String(url) !== HOOKS_URL) {
        throw new Error(`unexpected fetch in plain-delegation webhook test: ${String(url)}`);
      }
      const body = init?.body ? JSON.parse(String(init.body)) as Partial<HookDelivery> : {};
      if (body.message) {
        deliveries.push(body as HookDelivery);
      }
      return new Response(JSON.stringify({ ok: true, runId: `run-${deliveries.length}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("AC1/AC5: delegate set on a no-wf ticket dispatches a plain wake to that delegate", async () => {
    const dispatched: Array<{ agentId: string; ticketId: string }> = [];
    const app = createTestApp((agentId, ticketId) => dispatched.push({ agentId, ticketId }));

    await postWebhook(app, issueUpdate({ id: IGOR_LINEAR_ID, name: "Igor" }, { delegateId: null }));
    await waitFor(() => deliveries.length === 1);

    expect(dispatched).toEqual([{ agentId: "igor", ticketId: "linear-DSN-334" }]);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].agentId).toBe("igor");
    expect(deliveries[0].sessionKey).toBe("linear-DSN-334");
    expect(deliveries[0].message).toContain("You were delegated DSN-334");
    expect(deliveries[0].message).toContain("linear consider-work DSN-334");
    expect(deliveries[0].message).not.toContain("This is a [");
    expect(deliveries[0].message).not.toContain("Your legal action(s)");
    expect(deliveries[0].message).not.toContain("state: **");
  });

  test("AC4: delegate clear is quiet, and re-delegation dispatches the new delegate", async () => {
    const app = createTestApp();

    await postWebhook(app, issueUpdate(null, { delegateId: IGOR_LINEAR_ID }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deliveries).toHaveLength(0);

    await postWebhook(app, issueUpdate({ id: SAGE_LINEAR_ID, name: "Sage" }, { delegateId: null }));
    await waitFor(() => deliveries.length === 1);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].agentId).toBe("sage");
    expect(deliveries[0].sessionKey).toBe("linear-DSN-334");
  });
});
