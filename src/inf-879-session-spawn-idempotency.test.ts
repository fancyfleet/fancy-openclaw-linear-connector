/**
 * INF-879 — sessions_spawn task-key idempotency.
 *
 * AC map:
 * - AC1: duplicate replay for the same ticket/task key returns the existing live run.
 * - AC2: distinct task keys fan out independently.
 * - AC3: retry/race fixtures converge on one persisted run record.
 * - AC4: inspection exposes persisted live replay evidence against runtime/session state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  SessionSpawnIdempotencyStore,
  type SessionSpawnRunState,
} from "./store/session-spawn-idempotency-store.js";
import { deliverToAgent, type DeliveryConfig } from "./delivery/deliver.js";
import { PendingWorkBag, SessionTracker, resignalPendingTickets } from "./bag/index.js";
import type { WakeUpConfig } from "./bag/wake-up.js";
import type { RouteResult } from "./types.js";
import type { LinearEvent } from "./webhook/schema.js";

describe("INF-879 sessions_spawn task-key idempotency", () => {
  const tempDirs: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createStore(): SessionSpawnIdempotencyStore {
    const dir = mkdtempSync(path.join(tmpdir(), "inf-879-session-spawn-"));
    tempDirs.push(dir);
    return new SessionSpawnIdempotencyStore(path.join(dir, "session-spawn-idempotency.db"));
  }

  function installFetchMock(body: Record<string, unknown> = { ok: true, runId: "hook-run-1" }): { calls: RequestInit[] } {
    const calls: RequestInit[] = [];
    globalThis.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    return { calls };
  }

  function makeRoute(taskKey = "implementation", agentId = "igor"): RouteResult {
    return {
      agentId,
      sessionKey: "linear-INF-879",
      taskKey,
      priority: 0,
      event: {
        type: "Issue",
        action: "update",
        actor: { id: "actor", name: "Actor" },
        createdAt: "2026-07-27T16:40:00.000Z",
        data: {
          id: "issue-id",
          identifier: "INF-879",
          title: "Implement sessions_spawn task-key idempotency",
          state: { id: "state", name: "To Do", type: "unstarted" },
          priority: 2,
          priorityLabel: "High",
          teamId: "team",
          teamKey: "INF",
          labelIds: [],
          url: "https://linear.app/fancymatt/issue/INF-879",
          createdAt: "2026-07-27T16:31:06.523Z",
          updatedAt: "2026-07-27T16:40:00.000Z",
        },
        raw: {},
      } as LinearEvent,
    };
  }

  function makeConfig(runId = "hook-run-1"): DeliveryConfig {
    installFetchMock({ ok: true, runId });
    return {
      nodeBin: process.execPath,
      hooksUrl: "http://openclaw.test/hooks",
      hooksToken: "token",
      timeoutMs: 50,
      runtimeStatePath: "/tmp/openclaw/sessions.json",
    };
  }

  it("AC1: duplicate replay for the same ticket/task key returns the existing live run", () => {
    const store = createStore();
    const first = store.beginOrGetExisting({
      ticketId: "INF-879",
      taskKey: "write-tests",
      runtime: "codex",
      agentId: "tdd",
      sessionKey: "agent:tdd:linear-INF-879",
      // INF-1088: anchor the claim's timestamps to "now". This test asserts an
      // *immediate* replay returns the still-live run; under the INF-1088 live-claim
      // TTL a frozen (days-old) `updated_at` would correctly read as an expired
      // corpse and re-spawn, so a live/fresh fixture must be stamped recently.
      requestedAt: new Date(Date.now() - 2000).toISOString(),
    });
    expect(first).toMatchObject({ action: "start-new", existing: null });

    store.markSpawned(first.record.id, {
      runId: "run-native-1",
      sessionId: "session-native-1",
      state: "live" satisfies SessionSpawnRunState,
      observedAt: new Date(Date.now() - 1000).toISOString(),
    });

    const replay = store.beginOrGetExisting({
      ticketId: "INF-879",
      taskKey: "write-tests",
      runtime: "codex",
      agentId: "tdd",
      sessionKey: "agent:tdd:linear-INF-879",
      requestedAt: new Date().toISOString(),
    });

    expect(replay.action).toBe("return-existing");
    expect(replay.existing).toMatchObject({
      ticket_id: "INF-879",
      task_key: "write-tests",
      runtime: "codex",
      run_id: "run-native-1",
      session_id: "session-native-1",
      state: "live",
    });
    expect(store.listByTicket("INF-879")).toHaveLength(1);
  });

  it("AC2: distinct task keys for the same ticket fan out independently", () => {
    const store = createStore();

    const collect = store.beginOrGetExisting({
      ticketId: "INF-879",
      taskKey: "collect-context",
      runtime: "codex",
      agentId: "tdd",
      sessionKey: "agent:tdd:linear-INF-879:collect-context",
    });
    const inspect = store.beginOrGetExisting({
      ticketId: "INF-879",
      taskKey: "inspect-runtime",
      runtime: "openclaw-acp",
      agentId: "grover",
      sessionKey: "agent:grover:linear-INF-879:inspect-runtime",
    });

    expect(collect.action).toBe("start-new");
    expect(inspect.action).toBe("start-new");
    expect(collect.record.id).not.toBe(inspect.record.id);
    expect(store.listByTicket("INF-879").map((record) => record.task_key).sort()).toEqual([
      "collect-context",
      "inspect-runtime",
    ]);
  });

  it("AC3: concurrent retries for one ticket/task key converge on one persisted run record", async () => {
    const store = createStore();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        Promise.resolve().then(() =>
          store.beginOrGetExisting({
            ticketId: "INF-879",
            taskKey: "race-fixture",
            runtime: index % 2 === 0 ? "codex" : "openclaw-acp",
            agentId: "igor",
            sessionKey: "agent:igor:linear-INF-879:race-fixture",
          }),
        ),
      ),
    );

    expect(attempts.filter((attempt) => attempt.action === "start-new")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.action === "return-existing")).toHaveLength(7);
    expect(store.listByTicket("INF-879").filter((record) => record.task_key === "race-fixture")).toHaveLength(1);
  });

  it("AC4: inspection returns persisted live replay evidence for runtime/session validation", () => {
    const store = createStore();
    const started = store.beginOrGetExisting({
      ticketId: "INF-879",
      taskKey: "live-replay",
      runtime: "openclaw-acp",
      agentId: "grover",
      sessionKey: "agent:grover:linear-INF-879:live-replay",
    });
    store.markSpawned(started.record.id, {
      runId: "run-live-replay-1",
      sessionId: "session-live-replay-1",
      state: "live",
      observedAt: "2026-07-27T16:45:00.000Z",
      runtimeStatePath: "/home/fancymatt/.openclaw/sessions/sessions.json",
    });

    const evidence = store.inspect("INF-879", "live-replay");

    expect(evidence).toMatchObject({
      ticket_id: "INF-879",
      task_key: "live-replay",
      runtime: "openclaw-acp",
      run_id: "run-live-replay-1",
      session_id: "session-live-replay-1",
      session_key: "agent:grover:linear-INF-879:live-replay",
      state: "live",
      runtime_state_path: "/home/fancymatt/.openclaw/sessions/sessions.json",
    });
  });

  it("AC1/AC4: delivery path returns an existing live run without a second spawn", async () => {
    const store = createStore();
    const config = makeConfig("hook-run-live");
    const first = await deliverToAgent(makeRoute("implementation"), config, undefined, undefined, store);

    expect(first.dispatched).toBe(true);
    expect(first.idempotentReplay).toBeUndefined();
    expect(first.sessionSpawnRecord).toMatchObject({
      ticket_id: "INF-879",
      task_key: "implementation",
      runtime: "openclaw-acp",
      run_id: "hook-run-live",
      session_id: "linear-INF-879",
      state: "live",
      runtime_state_path: "/tmp/openclaw/sessions.json",
    });

    const replay = await deliverToAgent(makeRoute("implementation"), config, undefined, undefined, store);

    expect(replay).toMatchObject({
      dispatched: true,
      runId: "hook-run-live",
      idempotentReplay: true,
    });
    expect(store.listByTicket("INF-879")).toHaveLength(1);
    const evidence = store.inspect("INF-879", "implementation");
    expect(evidence).toMatchObject({
      run_id: "hook-run-live",
      runtime_state_path: "/tmp/openclaw/sessions.json",
    });
  });

  it("AC2: delivery path fans out distinct task keys for the same ticket", async () => {
    const store = createStore();

    await deliverToAgent(makeRoute("write-tests", "tdd"), makeConfig("run-tests"), undefined, undefined, store);
    await deliverToAgent(makeRoute("implementation", "igor"), makeConfig("run-impl"), undefined, undefined, store);

    expect(store.listByTicket("INF-879").map((record) => record.task_key).sort()).toEqual([
      "implementation",
      "write-tests",
    ]);
  });

  it("AC3: concurrent delivery retries converge before any second transport spawn", async () => {
    const store = createStore();
    const { calls } = installFetchMock({ ok: true, runId: "race-run" });
    const config: DeliveryConfig = {
      nodeBin: process.execPath,
      hooksUrl: "http://openclaw.test/hooks",
      hooksToken: "token",
      timeoutMs: 50,
      runtimeStatePath: "/tmp/openclaw/sessions.json",
    };

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        deliverToAgent(makeRoute("race-fixture"), config, undefined, undefined, store),
      ),
    );

    expect(attempts.filter((attempt) => attempt.idempotentReplay)).toHaveLength(7);
    expect(calls).toHaveLength(1);
    expect(store.listByTicket("INF-879").filter((record) => record.task_key === "race-fixture")).toHaveLength(1);
  });

  it("AC1/AC3/AC4: pending-bag wake replays converge before a second transport spawn", async () => {
    const store = createStore();
    const bag = new PendingWorkBag();
    const sessionTracker = new SessionTracker();
    const { calls } = installFetchMock({ ok: true, runId: "bag-wake-run" });
    const wakeConfig: WakeUpConfig = {
      nodeBin: process.execPath,
      hooksUrl: "http://openclaw.test/hooks",
      hooksToken: "token",
      timeoutMs: 50,
      runtimeStatePath: "/tmp/openclaw/sessions.json",
      sessionSpawnStore: store,
      sessionSpawnTaskKey: "implementation",
    };

    await Promise.all(
      Array.from({ length: 4 }, () =>
        resignalPendingTickets(
          "igor",
          ["INF-879"],
          bag,
          sessionTracker,
          wakeConfig,
          { isTicketActionable: () => true },
        ),
      ),
    );

    expect(calls).toHaveLength(1);
    expect(store.listByTicket("INF-879")).toHaveLength(1);
    expect(store.inspect("INF-879", "implementation")).toMatchObject({
      run_id: "bag-wake-run",
      session_id: "linear-INF-879",
      runtime_state_path: "/tmp/openclaw/sessions.json",
    });
  });
});
