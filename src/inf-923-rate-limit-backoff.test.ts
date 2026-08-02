/**
 * INF-923 - Linear API rate-limit-aware re-dispatch backoff + 429 breaker.
 *
 * AC mapping:
 *   AC1: false-C4 re-dispatch storms back off as Linear remaining-budget
 *        headers approach the configured floor.
 *   AC2: sustained 429s trip one breaker escalation and suppress further
 *        reconciliation query attempts until budget recovery.
 *   AC3: 429-throttled no-op sessions do not increment the C4 re-dispatch cap.
 *   AC4: /admin/api/ratelimit reports the current remaining Linear API budget.
 *   AC5: production entrypoint bootstrap wires the rate-limit-aware client +
 *        breaker into the re-dispatch/reconciliation query path and crons.
 *   AC6: /health and/or /admin/api/ratelimit exposes breaker state and budget
 *        without waiting for a real 429.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { runStalePlainDelegateSweep } from "./stale-plain-delegate-sweep.js";
import { runDelegationReconciliationSweep } from "./delegation-reconciliation-sweep.js";
import { createApp } from "./index.js";
import { AlertBus } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import { LinearRateLimitClient, RateLimitBreakerOpenError } from "./linear-rate-limit-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");
const ADMIN_SECRET = "inf-923-admin-secret";

type LooseRecord = Record<string, any>;

function makeLinearResponse(body: unknown, init?: { status?: number; remaining?: string; reset?: string }): Response {
  const status = init?.status ?? 200;
  const headers = new Headers();
  if (init?.remaining !== undefined) {
    headers.set("x-ratelimit-remaining", init.remaining);
    headers.set("ratelimit-remaining", init.remaining);
  }
  if (init?.reset !== undefined) {
    headers.set("x-ratelimit-reset", init.reset);
    headers.set("ratelimit-reset", init.reset);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function staleTicket(n: number) {
  return {
    id: `issue-inf-923-${n}`,
    identifier: `INF-${9000 + n}`,
    updatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    state: { name: "Doing" },
    labels: { nodes: [] },
    delegate: { id: "igor-linear-id", name: "igor" },
  };
}

function governedTicket(n: number) {
  return {
    id: `issue-governed-${n}`,
    identifier: `INF-923-G${n}`,
    updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    labels: [
      { id: "wf", name: "wf:dev-impl" },
      { id: "state", name: "state:implementation" },
    ],
    delegateId: "igor-linear-id",
    delegateName: "igor",
    assigneeId: "igor-linear-id",
    nativeState: { name: "Doing", type: "started" },
    blockingRelations: [],
  };
}

function stalePlainTicketsBody(nodes: unknown[]) {
  return {
    data: {
      issues: {
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

function governedTicketsBody(nodes: unknown[]) {
  return {
    data: {
      issues: {
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

async function pollJson(url: string, timeoutMs: number, init?: RequestInit): Promise<LooseRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, init);
      const body = (await res.json()) as LooseRecord;
      if (body && typeof body === "object") return body;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastErr;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.on("exit", () => {
      clearTimeout(force);
      resolve();
    });
  });
}

function tmpDb(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

describe("INF-923 AC1/AC3: rate-limit-aware false-C4 re-dispatch backoff", () => {
  let eventStore: OperationalEventStore;
  let ackTracker: DispatchAckTracker;
  let alertStore: AlertStore;
  let alertBus: AlertBus;

  beforeEach(() => {
    eventStore = new OperationalEventStore(":memory:");
    ackTracker = new DispatchAckTracker(":memory:");
    alertStore = new AlertStore(":memory:");
    alertBus = new AlertBus({ store: alertStore, pushEnabled: false });
  });

  afterEach(() => {
    eventStore.close();
    ackTracker.close();
    alertStore.close();
  });

  it("AC1: false-C4 storm backs off re-dispatch volume as remaining budget approaches the floor", async () => {
    const wakeFn = jest.fn<() => Promise<void>>(async () => {});
    const fetchFn = jest.fn<typeof fetch>(async () =>
      makeLinearResponse(stalePlainTicketsBody(Array.from({ length: 12 }, (_, i) => staleTicket(i + 1))), {
        remaining: "7",
        reset: "60",
      }),
    );

    const result = await runStalePlainDelegateSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: async () => {
        await wakeFn();
      },
      fetchFn,
      staleTimeoutMs: 4 * 60 * 60 * 1000,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(12);
    expect(result.staleDetected).toBe(12);
    expect(result.redispatched).toBeLessThanOrEqual(2);
    expect(wakeFn).toHaveBeenCalledTimes(result.redispatched);
    expect(result.redispatched).toBeLessThan(12);
  });

  it("AC3: a 429-throttled no-op does not increment the C4 re-dispatch attempt cap", async () => {
    const throttledTicket = staleTicket(429);
    const oldDispatch = new Date(Date.now() - 30 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const db = (ackTracker as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.prepare(`
      INSERT INTO dispatch_acks
        (agent_id, ticket_id, dispatched_at, last_signal_at, ack_status, attempt_count)
      VALUES (?, ?, ?, ?, 'unconfirmed', 1)
    `).run("igor", `linear-${throttledTicket.identifier}`, oldDispatch, oldDispatch);

    const fetchFn = jest.fn<typeof fetch>(async () =>
      makeLinearResponse(stalePlainTicketsBody([throttledTicket]), {
        status: 429,
        remaining: "0",
        reset: "120",
      }),
    );
    const wakeFn = jest.fn<() => Promise<void>>(async () => {});

    const result = await runStalePlainDelegateSweep({
      authToken: "Bearer test-token",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: async () => {
        await wakeFn();
      },
      fetchFn,
      staleTimeoutMs: 4 * 60 * 60 * 1000,
    });

    const entry = ackTracker
      .listFiltered({ agentId: "igor" })
      .find((row) => row.ticketId.toLowerCase() === `linear-${throttledTicket.identifier}`.toLowerCase());

    expect(result.redispatched).toBe(0);
    expect(wakeFn).not.toHaveBeenCalled();
    expect(entry?.attemptCount).toBe(1);
  });
});

describe("INF-923 AC2: 429 breaker suppresses reconciliation query storms", () => {
  let eventStore: OperationalEventStore;
  let enrolledTicketsStore: EnrolledTicketsStore;
  let alertStore: AlertStore;
  let alertBus: AlertBus;

  beforeEach(() => {
    eventStore = new OperationalEventStore(":memory:");
    enrolledTicketsStore = new EnrolledTicketsStore(":memory:");
    alertStore = new AlertStore(":memory:");
    alertBus = new AlertBus({ store: alertStore, pushEnabled: false });
  });

  afterEach(() => {
    eventStore.close();
    enrolledTicketsStore.close();
    alertStore.close();
  });

  it("AC2: sustained 429s trip one escalation and no further re-dispatch queries fire until budget recovers", async () => {
    const fetchFn = jest.fn<typeof fetch>(async () =>
      makeLinearResponse(governedTicketsBody([governedTicket(1)]), {
        status: 429,
        remaining: "0",
        reset: "300",
      }),
    );
    const wakeFn = jest.fn<(agent: string, ticket: string) => Promise<void>>(async () => {});

    for (let i = 0; i < 3; i += 1) {
      await runDelegationReconciliationSweep({
        authToken: "Bearer test-token",
        operationalEventStore: eventStore,
        enrolledTicketsStore,
        alertBus,
        wakeFn,
        fetchFn,
      });
    }

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(wakeFn).not.toHaveBeenCalled();

    const breakerAlerts = alertStore
      .query({ source: "linear-api-rate-limit", limit: 20 })
      .filter((row) => /breaker|429|rate.?limit/i.test(`${row.title} ${JSON.stringify(row.detail)}`));
    expect(breakerAlerts).toHaveLength(1);
    expect(breakerAlerts[0].count).toBe(1);
  });

  it("INF-981: a headerless 429 still marks budget depleted and trips the breaker", async () => {
    const client = new LinearRateLimitClient({
      alertBus,
      budgetTotal: 10_000,
      floor: 500,
    });
    const fetchFn = jest.fn<typeof fetch>(async () =>
      makeLinearResponse({ errors: [{ message: "rate limit exceeded" }] }, { status: 429 }),
    );

    await expect(client.wrap(fetchFn)("https://api.linear.app/graphql", { method: "POST" }))
      .rejects.toBeInstanceOf(RateLimitBreakerOpenError);

    expect(client.liveness()).toEqual(expect.objectContaining({
      remaining: 0,
      source: "live",
      breaker: expect.objectContaining({ state: "open", tripped: true }),
    }));
    expect(client.redispatchBudget()).toBe(0);
  });

  it("INF-981: source unknown is unsafe and grants no redispatch budget", () => {
    const client = new LinearRateLimitClient({
      alertBus,
      budgetTotal: 10_000,
      floor: 500,
    });

    expect(client.liveness()).toEqual(expect.objectContaining({
      remaining: 10_000,
      source: "unknown",
    }));
    expect(client.redispatchBudget()).toBe(0);
  });
});

describe("INF-923 AC4/AC6: admin and health rate-limit liveness surfaces", () => {
  let appState: ReturnType<typeof createApp>;
  let dbDirs: string[] = [];

  beforeEach(() => {
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    const operationalEventsDbPath = tmpDb("inf-923-events");
    const enrolledTicketsDbPath = tmpDb("inf-923-enrolled");
    dbDirs = [path.dirname(operationalEventsDbPath), path.dirname(enrolledTicketsDbPath)];
    appState = createApp({ operationalEventsDbPath, enrolledTicketsDbPath });
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    for (const value of Object.values(appState)) {
      const close = (value as { close?: unknown })?.close;
      if (typeof close === "function") close();
    }
    for (const dir of dbDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC4: /admin/api/ratelimit reports current remaining Linear API budget", async () => {
    const res = await request(appState.app)
      .get("/admin/api/ratelimit")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      linearApi: expect.objectContaining({
        remaining: expect.any(Number),
        floor: expect.any(Number),
        source: expect.stringMatching(/header|live|unknown/i),
      }),
    }));
  });

  it("AC6: /health exposes registered rate-limit client and breaker state without waiting for a real 429", async () => {
    const res = await request(appState.app).get("/health");

    expect(res.body.linearApiRateLimit).toEqual(expect.objectContaining({
      registered: true,
      remaining: expect.any(Number),
      floor: expect.any(Number),
      breaker: expect.objectContaining({
        state: expect.stringMatching(/closed|open|half-open/i),
        tripped: expect.any(Boolean),
      }),
      gatedConsumers: expect.arrayContaining([
        "proxy-graphql-passthrough",
        "webhook-linear-enrichment",
        "stale-c4-repoke",
        "delegation-reconciliation-sweep",
        "bootstrap-reconciliation-sweep",
        "stale-plain-delegate-sweep",
      ]),
    }));
  });
});

describe("INF-923 AC5/AC6: production entrypoint wiring", () => {
  let tmpDir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeEach(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(`dist/index.js not found at ${DIST_ENTRY}; run npm run build before this focused test`);
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-923-bootstrap-"));
    fs.writeFileSync(
      path.join(tmpDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            name: "igor",
            linearUserId: "igor-linear-id",
            openclawAgent: "igor",
            clientId: "client-id",
            clientSecret: "client-secret",
            accessToken: "access-token",
            refreshToken: "refresh-token",
            host: "local",
          },
        ],
      }),
      "utf8",
    );

    const port = 4900 + (process.pid % 200);
    process.env.INF923_BOOT_PORT = String(port);
    child = spawn(process.execPath, [DIST_ENTRY], {
      cwd: tmpDir,
      env: {
        ...process.env,
        ADMIN_SECRET,
        AGENTS_FILE: path.join(tmpDir, "agents.json"),
        DATA_DIR: path.join(tmpDir, "data"),
        PORT: String(port),
        LOG_LEVEL: "error",
        LINEAR_WEBHOOK_SECRET: "test-secret",
        LINEAR_OAUTH_TOKEN: "test-linear-token",
        OPENCLAW_HOOKS_URL: `http://127.0.0.1:${port}/nonexistent-hooks`,
        OPENCLAW_HOOKS_TOKEN: "test-hooks-token",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      childStderr += chunk.toString("utf8");
    });
  });

  afterEach(async () => {
    await stopChild(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.INF923_BOOT_PORT;
  });

  it("AC5/AC6: dist/index.js boots with reconciliation paths gated by the rate-limit-aware client and breaker", async () => {
    const baseUrl = `http://127.0.0.1:${process.env.INF923_BOOT_PORT}`;
    let health: LooseRecord;
    try {
      health = await pollJson(`${baseUrl}/health`, 30_000);
    } catch (err) {
      throw new Error(
        `entrypoint never responded on /health: ${err instanceof Error ? err.message : String(err)}\nchild stderr:\n${childStderr}`,
      );
    }

    expect(health.linearApiRateLimit).toEqual(expect.objectContaining({
      registered: true,
      remaining: expect.any(Number),
      breaker: expect.objectContaining({
        state: expect.stringMatching(/closed|open|half-open/i),
      }),
      gatedConsumers: expect.arrayContaining([
        "proxy-graphql-passthrough",
        "webhook-linear-enrichment",
        "delegation-reconciliation-sweep",
        "bootstrap-reconciliation-sweep",
        "stale-plain-delegate-sweep",
      ]),
      cronConsumers: expect.arrayContaining([
        "delegation-reconciliation-sweep",
        "bootstrap-reconciliation-sweep",
      ]),
    }));

    const admin = await pollJson(`${baseUrl}/admin/api/ratelimit`, 10_000, {
      headers: { "x-admin-secret": ADMIN_SECRET },
    });
    expect(admin.linearApi.breaker.state).toMatch(/closed|open|half-open/i);
    expect(admin.linearApi.remaining).toEqual(health.linearApiRateLimit.remaining);
  }, 45_000);
});
