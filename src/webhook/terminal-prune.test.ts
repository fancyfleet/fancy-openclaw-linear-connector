import crypto from "crypto";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { PendingWorkBag } from "../bag/pending-work-bag.js";
import { SessionTracker } from "../bag/session-tracker.js";
import { reloadAgents } from "../agents.js";
import { createWebhookRouter } from "./index.js";

const SECRET = "test-terminal-prune-secret";
const IGOR_LINEAR_ID = "linear-user-igor-terminal";
const HOOKS_URL = "https://hooks.test/terminal-prune";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-prune-test-"));
  return path.join(dir, "test.db");
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createTestApp(
  bag: PendingWorkBag,
  sessionTracker: SessionTracker,
  onDispatched?: (agentId: string, ticketId: string) => void,
) {
  const app = express();
  app.use(
    express.raw({ type: "application/json", limit: "1mb" }),
    (req, _res, next) => {
      if (Buffer.isBuffer(req.body)) {
        (req as any).rawBody = req.body;
      }
      next();
    },
  );
  app.use("/", createWebhookRouter(undefined, undefined, undefined, bag, sessionTracker, undefined, undefined, undefined, onDispatched));
  return app;
}

describe("terminal issue dispatch pruning", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let dbPath: string;
  let bag: PendingWorkBag;
  let sessionTracker: SessionTracker;
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalEnv = process.env;
    originalFetch = globalThis.fetch;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-prune-agents-"));
    const agentsFile = path.join(tmpDir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [{
          name: "igor",
          openclawAgent: "igor",
          linearUserId: IGOR_LINEAR_ID,
          hooksUrl: HOOKS_URL,
          hooksToken: "hook-token",
        }],
      }),
      "utf8",
    );
    process.env = {
      ...originalEnv,
      AGENTS_FILE: agentsFile,
      LINEAR_WEBHOOK_SECRET: SECRET,
      LINEAR_API_KEY: "linear-test-token",
      REQUIRE_GATEWAY_DELIVERY: "false",
    };
    reloadAgents();
    dbPath = tempDb();
    bag = new PendingWorkBag(dbPath, 60_000);
    sessionTracker = new SessionTracker(30_000);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    reloadAgents();
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("Done issue update drops stale pending bag and queued signals before agent dispatch", async () => {
    bag.add("igor", "AI-501", "Issue");
    bag.add("charles", "AI-501", "Issue");
    bag.add("igor", "AI-597", "Issue");
    sessionTracker.startSession("igor", "linear-AI-500");
    sessionTracker.queueSignal("igor", ["linear-AI-501", "linear-AI-597"]);

    const body = JSON.stringify({
      type: "Issue",
      action: "update",
      createdAt: "2026-04-30T23:40:00.000Z",
      actor: { id: "reviewer", name: "Charles" },
      data: {
        id: "issue-501",
        identifier: "AI-501",
        title: "Already completed work",
        state: { id: "done", name: "Done", type: "completed" },
        priority: 0,
        priorityLabel: "No priority",
        team: { id: "team-ai", key: "AI" },
        labelIds: [],
        url: "https://linear.app/fancymatt/issue/AI-501",
        delegate: { id: "igor-id", name: "Igor" },
        createdAt: "2026-04-27T19:00:00.000Z",
        updatedAt: "2026-04-30T23:40:00.000Z",
      },
    });

    const res = await request(createTestApp(bag, sessionTracker))
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "terminal-ai-501")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(bag.getPendingTickets("igor").map((entry) => entry.ticketId)).toEqual(["linear-AI-597"]);
    expect(bag.getPendingTickets("charles")).toHaveLength(0);
    expect(sessionTracker.endSession("igor")).toEqual(["linear-AI-597"]);
    expect(bag.getStats().signalsSent).toBe(0);
  });

  test("open inverseRelations blocker suppresses target dispatch before it can loop", async () => {
    const deliveries: unknown[] = [];
    globalThis.fetch = async (url, init) => {
      if (String(url) === HOOKS_URL) {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (!body.ping) deliveries.push(body);
        return new Response(JSON.stringify({ ok: true, runId: "run-open-blocker" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = init?.body ? JSON.parse(String(init.body)) as { query?: string } : {};
      if (body.query?.includes("IssueRouting")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: "issue-inf-777",
              identifier: "INF-777",
              delegate: { id: IGOR_LINEAR_ID, name: "Igor", app: true },
              assignee: null,
              state: { name: "Verification", type: "started" },
              trashed: false,
              archivedAt: null,
              relations: { nodes: [] },
              inverseRelations: {
                nodes: [{
                  type: "blocks",
                  issue: { id: "issue-inf-773", identifier: "INF-773", state: { name: "To Do", type: "unstarted" } },
                  relatedIssue: { id: "issue-inf-777", identifier: "INF-777", state: { name: "Verification", type: "started" } },
                }],
              },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: { issue: { identifier: "INF-777", labels: { nodes: [] } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const body = JSON.stringify({
      type: "Issue",
      action: "update",
      createdAt: "2026-07-27T02:00:00.000Z",
      actor: { id: "human", name: "Astrid" },
      data: {
        id: "issue-inf-777",
        identifier: "INF-777",
        title: "Integration verify",
        state: { id: "state-verification", name: "Verification", type: "started" },
        priority: 0,
        priorityLabel: "No priority",
        team: { id: "team-inf", key: "INF" },
        labelIds: [],
        delegate: { id: IGOR_LINEAR_ID, name: "Igor" },
        createdAt: "2026-07-27T01:00:00.000Z",
        updatedAt: "2026-07-27T02:00:00.000Z",
      },
      updatedFrom: { stateId: "state-previous" },
    });

    await request(createTestApp(bag, sessionTracker))
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "blocked-inf-777")
      .send(body)
      .expect(200);

    expect(deliveries).toHaveLength(0);
    expect(bag.getPendingTickets("igor")).toHaveLength(0);
  });

  test("Done blocker wakes its formerly blocked target exactly once", async () => {
    const deliveries: Array<Record<string, unknown>> = [];
    const dispatched: Array<{ agentId: string; ticketId: string }> = [];
    globalThis.fetch = async (url, init) => {
      if (String(url) === HOOKS_URL) {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (!body.ping) deliveries.push(body);
        return new Response(JSON.stringify({ ok: true, runId: `run-${deliveries.length}` }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = init?.body ? JSON.parse(String(init.body)) as { query?: string } : {};
      const query = body.query ?? "";
      if (query.includes("BlockedTargets")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: "issue-inf-773",
              identifier: "INF-773",
              relations: {
                nodes: [{
                  type: "blocks",
                  issue: { id: "issue-inf-773", identifier: "INF-773" },
                  relatedIssue: {
                    id: "issue-inf-777",
                    identifier: "INF-777",
                    title: "Integration verify",
                    url: "https://linear.app/fancymatt/issue/INF-777",
                    priority: 0,
                    priorityLabel: "No priority",
                    createdAt: "2026-07-27T01:00:00.000Z",
                    updatedAt: "2026-07-27T02:30:00.000Z",
                    state: { id: "state-verification", name: "Verification", type: "started" },
                    team: { id: "team-inf", key: "INF" },
                    labelIds: [],
                    delegate: { id: IGOR_LINEAR_ID, name: "Igor", app: true },
                    assignee: null,
                  },
                }],
              },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (query.includes("IssueRouting")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: "issue-inf-777",
              identifier: "INF-777",
              delegate: { id: IGOR_LINEAR_ID, name: "Igor", app: true },
              assignee: null,
              state: { name: "Verification", type: "started" },
              trashed: false,
              archivedAt: null,
              relations: { nodes: [] },
              inverseRelations: {
                nodes: [{
                  type: "blocks",
                  issue: { id: "issue-inf-773", identifier: "INF-773", state: { name: "Done", type: "completed" } },
                  relatedIssue: { id: "issue-inf-777", identifier: "INF-777", state: { name: "Verification", type: "started" } },
                }],
              },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (query.includes("ResolveIdentifier")) {
        return new Response(JSON.stringify({ data: { issue: { identifier: "INF-777" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { issue: { identifier: "INF-777", labels: { nodes: [] } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const payload = {
      type: "Issue",
      action: "update",
      createdAt: "2026-07-27T02:30:00.000Z",
      actor: { id: "igor-actor", name: "Igor" },
      data: {
        id: "issue-inf-773",
        identifier: "INF-773",
        title: "Gate: refuse-serving drifted workflow defs",
        state: { id: "state-done", name: "Done", type: "completed" },
        priority: 0,
        priorityLabel: "No priority",
        team: { id: "team-inf", key: "INF" },
        labelIds: [],
        createdAt: "2026-07-27T01:00:00.000Z",
        updatedAt: "2026-07-27T02:30:00.000Z",
      },
      updatedFrom: { stateId: "state-todo" },
    };

    const app = createTestApp(bag, sessionTracker, (agentId, ticketId) => dispatched.push({ agentId, ticketId }));
    for (const deliveryId of ["blocker-done-first", "blocker-done-duplicate"]) {
      const body = JSON.stringify(payload);
      await request(app)
        .post("/")
        .set("Content-Type", "application/json")
        .set("x-linear-signature", sign(body))
        .set("x-linear-delivery", deliveryId)
        .send(body)
        .expect(200);
    }

    await waitFor(() => dispatched.length > 0, "unblock dispatch callback");

    expect(dispatched).toEqual([{ agentId: "igor", ticketId: "linear-INF-777" }]);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].agentId).toBe("igor");
    expect(deliveries[0].sessionKey).toBe("linear-INF-777");
    expect(String(deliveries[0].message)).toContain("INF-777");
  });
});
