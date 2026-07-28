/**
 * INF-975: admission-time capacity gate for Charles/code-review.
 *
 * AC1-AC5 are covered here. AC6 is the dev-impl process contract, not a code
 * behavior, so this suite intentionally does not test it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { PendingWorkBag } from "./bag/pending-work-bag.js";
import { SessionTracker } from "./bag/session-tracker.js";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import { NoActivityDetector } from "./bag/no-activity-detector.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import type { WakeUpConfig } from "./bag/wake-up.js";

const WEBHOOK_SECRET = "inf-975-webhook-secret";
const SESSION_END_SECRET = "inf-975-session-end-secret";
const CHARLES_LINEAR_ID = "linear-user-charles";
const HOOKS_URL = "https://hooks.test/charles";
const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src", "registered-defs");

type Delivery = {
  agentId: string;
  sessionKey: string;
  message: string;
};

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-975-capacity-"));
}

function sign(body: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(Buffer.from(body)).digest("hex");
}

function writeAgentsFile(dir: string, maxConcurrent?: number): string {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        {
          name: "charles",
          linearUserId: CHARLES_LINEAR_ID,
          openclawAgent: "charles",
          accessToken: "charles-linear-token",
          refreshToken: "charles-refresh",
          hooksUrl: HOOKS_URL,
          hooksToken: "hooks-token",
          ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
        },
      ],
    }),
    "utf8",
  );
  return agentsFile;
}

function writeCapabilityPolicy(dir: string): string {
  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(
    policyFile,
    [
      "capabilities:",
      "  - id: linear:transition",
      "containers:",
      "  - id: code-review",
      "    grants: [linear:transition]",
      "roles:",
      "  - id: code-review",
      "    requires: [linear:transition]",
      "bodies:",
      "  - id: charles",
      "    container: code-review",
      "    fills_roles: [code-review]",
      "",
    ].join("\n"),
    "utf8",
  );
  return policyFile;
}

function codeReviewIssueUpdate(identifier: string): Record<string, unknown> {
  return {
    type: "Issue",
    action: "update",
    createdAt: "2026-07-28T09:00:00.000Z",
    actor: { id: "human-user", name: "Matt Henry" },
    data: {
      id: `issue-${identifier.toLowerCase()}`,
      identifier,
      title: `Review ${identifier}`,
      team: { id: "team-inf", key: "INF" },
      labelIds: ["lbl-wf-dev-impl", "lbl-state-code-review"],
      labels: ["wf:dev-impl", "state:code-review"],
      delegate: { id: CHARLES_LINEAR_ID, name: "Charles", app: true },
      state: { id: "state-todo", name: "To Do", type: "unstarted" },
      updatedAt: `2026-07-28T09:${identifier.endsWith("1") ? "01" : "02"}:00.000Z`,
    },
    updatedFrom: { delegateId: null },
  };
}

async function postWebhook(app: ReturnType<typeof createApp>["app"], payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  await request(app)
    .post("/")
    .set("content-type", "application/json")
    .set("x-linear-signature", sign(body))
    .send(body)
    .expect(200);
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!condition()) {
    throw new Error(`condition was not met within ${timeoutMs}ms`);
  }
}

function installFetchStub(deliveries: Delivery[]): typeof globalThis.fetch {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === HOOKS_URL) {
      const payload = init?.body ? JSON.parse(String(init.body)) as Partial<Delivery> & { ping?: boolean } : {};
      if (payload.ping) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (payload.message) {
        deliveries.push({
          agentId: payload.agentId ?? "",
          sessionKey: payload.sessionKey ?? "",
          message: payload.message,
        });
      }
      return new Response(JSON.stringify({ ok: true, runId: `run-${deliveries.length}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (target === "https://api.linear.app/graphql") {
      const body = init?.body ? JSON.parse(String(init.body)) as {
        query?: string;
        variables?: Record<string, unknown>;
      } : {};
      const query = body.query ?? "";
      const identifier = String(body.variables?.id ?? body.variables?.issueId ?? "INF-975");
      const labels = [
        { id: "lbl-wf-dev-impl", name: "wf:dev-impl", team: { id: "team-inf" } },
        { id: "lbl-state-code-review", name: "state:code-review", team: { id: "team-inf" } },
      ];

      if (query.includes("IssueRouting")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: `issue-${identifier.toLowerCase()}`,
              identifier,
              delegate: { id: CHARLES_LINEAR_ID, name: "Charles", app: true },
              assignee: null,
              state: { name: "To Do", type: "unstarted" },
              trashed: false,
              archivedAt: null,
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (query.includes("IssueLabels") || query.includes("IssueWithLabels") || query.includes("IssueContext")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: `issue-${identifier.toLowerCase()}`,
              identifier,
              team: { id: "team-inf", key: "INF" },
              labels: { nodes: labels },
              delegate: { id: CHARLES_LINEAR_ID, name: "Charles", app: true },
              state: { name: "To Do", type: "unstarted" },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (query.includes("TeamLabels")) {
        return new Response(JSON.stringify({
          data: { team: { labels: { nodes: labels } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (query.includes("issueUpdate")) {
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`unexpected fetch in INF-975 test: ${target}`);
  };
  return originalFetch;
}

function closeApp(ctx: ReturnType<typeof createApp>): void {
  ctx.watchdog.stop();
  ctx.noActivityDetector.stop();
  ctx.stuckDelegateDetector.stop();
  ctx.managingPoller.stop();
  ctx.bag.close();
  ctx.sessionTracker.close();
  ctx.ackTracker.close();
  ctx.operationalEventStore.close();
  ctx.enrolledTicketsStore.close();
  ctx.observationStore.close();
  ctx.managingStateStore.close();
  ctx.mutationAuditStore.close();
  ctx.idempotencyStore.close();
  ctx.proposalStore.close();
  ctx.dispatchLeaseStore.close();
  ctx.dispatchInFlightStore.close();
  ctx.sessionSpawnStore.close();
  ctx.livenessDispatchStore.close();
}

describe("INF-975 Charles/code-review admission-time capacity gate", () => {
  let dir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let originalFetch: typeof globalThis.fetch;
  let deliveries: Delivery[];

  beforeEach(() => {
    dir = tempDir();
    originalEnv = process.env;
    deliveries = [];
    originalFetch = installFetchStub(deliveries);
    process.env = {
      ...originalEnv,
      AGENTS_FILE: writeAgentsFile(dir, 1),
      CAPABILITY_POLICY_PATH: writeCapabilityPolicy(dir),
      LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
      LINEAR_API_KEY: "linear-test-token",
      SESSION_END_SECRET,
      REQUIRE_GATEWAY_DELIVERY: "false",
      WATCHDOG_ACK_TIMEOUT_MS: "600000",
      NO_ACTIVITY_WARN_MS: "600000",
      NO_ACTIVITY_FAIL_MS: "600000",
      WORKFLOW_DEFS_DIR: REGISTERED_DEFS_DIR,
    };
    delete process.env.WORKFLOW_DEF_PATH;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("AC1/AC3: when Charles is at config maxConcurrent=1, a second code-review dispatch is deferred before gateway dispatch", async () => {
    const ctx = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      dispatchLeaseDbPath: path.join(dir, "dispatch-leases.db"),
      dispatchInFlightDbPath: path.join(dir, "inflight.db"),
      sessionSpawnIdempotencyDbPath: path.join(dir, "spawn.db"),
      livenessDispatchDbPath: path.join(dir, "liveness.db"),
    });
    try {
      await postWebhook(ctx.app, codeReviewIssueUpdate("INF-9751"));
      await waitFor(() => deliveries.length === 1);
      await postWebhook(ctx.app, codeReviewIssueUpdate("INF-9752"));

      expect(deliveries.map((d) => d.sessionKey)).toEqual(["linear-INF-9751"]);
      expect(ctx.sessionTracker.getActiveSessionKeys("charles")).toEqual(["linear-INF-9751"]);
      expect(ctx.bag.getPendingTickets("charles").map((e) => e.ticketId).sort()).toEqual([
        "linear-INF-9751",
        "linear-INF-9752",
      ]);

      const ackRows = ctx.ackTracker.listFiltered({ agentId: "charles" });
      expect(ackRows.map((row) => row.ticketId).sort()).toEqual(["linear-INF-9751"]);

      const deferred = ctx.operationalEventStore.query({ outcome: "deferred-at-capacity" });
      expect(deferred).toHaveLength(1);
      expect(deferred[0]).toMatchObject({
        agent: "charles",
        key: "linear-INF-9752",
        sessionKey: "linear-INF-9752",
      });
      expect(deferred[0].detail).toMatchObject({ activeCount: 1, maxConcurrent: 1 });
    } finally {
      closeApp(ctx);
    }
  });

  test("AC2: deferred code-review work is re-armed after the active Charles session completes", async () => {
    const ctx = createApp({
      bagDbPath: path.join(dir, "bag-rearm.db"),
      operationalEventsDbPath: path.join(dir, "events-rearm.db"),
      idempotencyDbPath: path.join(dir, "idempotency-rearm.db"),
      dispatchLeaseDbPath: path.join(dir, "dispatch-leases-rearm.db"),
      dispatchInFlightDbPath: path.join(dir, "inflight-rearm.db"),
      sessionSpawnIdempotencyDbPath: path.join(dir, "spawn-rearm.db"),
      livenessDispatchDbPath: path.join(dir, "liveness-rearm.db"),
    });
    try {
      await postWebhook(ctx.app, codeReviewIssueUpdate("INF-9761"));
      await waitFor(() => deliveries.length === 1);
      await postWebhook(ctx.app, codeReviewIssueUpdate("INF-9762"));
      expect(deliveries.map((d) => d.sessionKey)).toEqual(["linear-INF-9761"]);

      const res = await request(ctx.app)
        .post("/session-end")
        .set("x-session-end-secret", SESSION_END_SECRET)
        .set("content-type", "application/json")
        .send(JSON.stringify({ agentId: "charles" }));

      expect(res.status).toBe(200);
      await waitFor(() => deliveries.length === 2);
      expect(deliveries.map((d) => d.sessionKey)).toEqual(["linear-INF-9761", "linear-INF-9762"]);
      expect(ctx.sessionTracker.getActiveSessionKeys("charles")).toEqual(["linear-INF-9762"]);
      expect(ctx.operationalEventStore.query({ outcome: "deferred-capacity-rearm" })).toHaveLength(1);
    } finally {
      closeApp(ctx);
    }
  });
});

describe("INF-975 no-activity regression boundary", () => {
  const wakeConfig: WakeUpConfig = { nodeBin: process.execPath, timeoutMs: 10, maxRetries: 0 };
  let dir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = tempDir();
    originalEnv = process.env;
    process.env = { ...originalEnv, WATCHDOG_MAX_RESIGNALS: "1" };
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("AC4: a true never-start Charles session that was actually dispatched still escalates instead of being treated as capacity-deferred", async () => {
    const bag = new PendingWorkBag(path.join(dir, "bag.db"), 60_000);
    const sessionTracker = new SessionTracker(30_000);
    const ackTracker = new DispatchAckTracker(path.join(dir, "acks.db"));
    const operationalEventStore = new OperationalEventStore(path.join(dir, "events.db"));
    const comments: string[] = [];
    try {
      bag.add("charles", "linear-INF-9753", "Issue", "delegate");
      sessionTracker.startSession("charles", "linear-INF-9753");
      ackTracker.recordDispatch("charles", "linear-INF-9753");
      ackTracker.markResignaled("charles", "linear-INF-9753");

      const detector = new NoActivityDetector(
        {
          sessionTracker,
          ackTracker,
          bag,
          operationalEventStore,
          wakeConfig,
          resignalOptions: { isTicketActionable: () => true },
          getAgentConfig: () => ({ name: "charles", linearUserId: CHARLES_LINEAR_ID, accessToken: "tok", refreshToken: "ref", clientId: "c", clientSecret: "s", maxConcurrent: 1 }),
          postLinearComment: async (_agentId, _ticketId, message) => {
            comments.push(message);
            return true;
          },
        },
        { warnMs: 0, failMs: 0, pollMs: 60_000 },
      );

      const result = await detector.runCycle();

      expect(result.deferredAtCapacity).toBe(0);
      expect(result.failed).toBe(1);
      expect(ackTracker.listFiltered({ agentId: "charles", ackStatus: "escalated" })).toHaveLength(1);
      expect(operationalEventStore.query({ outcome: "deferred-at-capacity" })).toHaveLength(0);
      expect(comments.join("\n")).toContain("Manual intervention required");

      detector.stop();
    } finally {
      bag.close();
      sessionTracker.close();
      ackTracker.close();
      operationalEventStore.close();
    }
  });
});

describe("INF-975 initial Charles capacity configuration", () => {
  function walk(value: unknown): Array<Record<string, unknown>> {
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value)) {
      return value.flatMap((entry) => walk(entry));
    }
    const obj = value as Record<string, unknown>;
    const self = (
      obj.name === "charles" ||
      obj.agentId === "charles" ||
      obj.openclawAgent === "charles"
    ) ? [obj] : [];
    return [...self, ...Object.values(obj).flatMap((entry) => walk(entry))];
  }

  test("AC5: checked-in initial agent config sets Charles/code-review maxConcurrent to 1", () => {
    const configRoots = ["config", "config-templates"];
    const parsedConfigs = configRoots
      .flatMap((root) => fs.existsSync(root)
        ? fs.readdirSync(root, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.(json|ya?ml)$/i.test(entry.name))
          .map((entry) => path.join(entry.parentPath, entry.name))
        : [])
      .map((filePath) => {
        const raw = fs.readFileSync(filePath, "utf8");
        return filePath.endsWith(".json") ? JSON.parse(raw) as unknown : yaml.load(raw);
      });

    const charlesEntries = parsedConfigs.flatMap((config) => walk(config));
    expect(charlesEntries.some((entry) => entry.maxConcurrent === 1)).toBe(true);
  });
});
