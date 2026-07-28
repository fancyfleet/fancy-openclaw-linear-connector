/**
 * INF-1003 — terminal-session rotation guard on re-dispatch.
 *
 * AC map:
 * - AC1/AC5: a terminal bound session (`stopReason: stop`) is not replayed;
 *   the production delivery/re-dispatch path mints a fresh session and records
 *   observable old->new rotation evidence.
 * - AC2: the fresh session receives the normal full dispatch message.
 * - AC3: non-terminal/live session bindings keep the existing idempotent replay
 *   behavior.
 * - AC4: the LIF-338 class of terminal codex-mirror replay does not silently
 *   complete as C3; the terminal binding is rotated before replay.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { deliverToAgent, type DeliveryConfig } from "./delivery/deliver.js";
import { PendingWorkBag, SessionTracker, resignalPendingTickets } from "./bag/index.js";
import type { WakeUpConfig } from "./bag/wake-up.js";
import { SessionSpawnIdempotencyStore } from "./store/session-spawn-idempotency-store.js";
import type { RouteResult } from "./types.js";
import type { LinearEvent } from "./webhook/schema.js";

describe("INF-1003 terminal-session rotation on re-dispatch", () => {
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
    const dir = mkdtempSync(path.join(tmpdir(), "inf-1003-terminal-rotation-"));
    tempDirs.push(dir);
    return new SessionSpawnIdempotencyStore(path.join(dir, "session-spawn-idempotency.db"));
  }

  function makeRoute(taskKey = "implementation", agentId = "igor"): RouteResult {
    return {
      agentId,
      sessionKey: "linear-INF-1003",
      taskKey,
      priority: 0,
      event: {
        type: "Issue",
        action: "update",
        actor: { id: "actor", name: "Astrid" },
        createdAt: "2026-07-28T23:24:21.080Z",
        data: {
          id: "issue-id",
          identifier: "INF-1003",
          title: "Connector: terminal-session rotation guard on re-dispatch",
          state: { id: "state", name: "Doing", type: "started" },
          priority: 3,
          priorityLabel: "Normal",
          teamId: "team",
          teamKey: "INF",
          labelIds: [],
          url: "https://linear.app/fancymatt/issue/INF-1003",
          createdAt: "2026-07-28T23:22:51.795Z",
          updatedAt: "2026-07-28T23:24:21.080Z",
        },
        raw: {},
      } as LinearEvent,
    };
  }

  function installHooksFetch(runId: string): { calls: RequestInit[] } {
    const calls: RequestInit[] = [];
    globalThis.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ ok: true, runId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    return { calls };
  }

  function makeConfig(runId: string): { config: DeliveryConfig; calls: RequestInit[] } {
    const { calls } = installHooksFetch(runId);
    return {
      calls,
      config: {
        nodeBin: process.execPath,
        hooksUrl: "http://openclaw.test/hooks",
        hooksToken: "token",
        timeoutMs: 50,
        runtimeStatePath: "/tmp/openclaw/sessions.json",
      },
    };
  }

  function bindTerminalStopSession(store: SessionSpawnIdempotencyStore, taskKey = "implementation"): void {
    const bound = store.beginOrGetExisting({
      ticketId: "INF-1003",
      taskKey,
      runtime: "openclaw-acp",
      agentId: "igor",
      sessionKey: "agent:igor:linear-INF-1003",
      requestedAt: "2026-07-28T23:00:00.000Z",
    });
    store.markSpawned(bound.record.id, {
      runId: "lif-338-terminal-run",
      sessionId: "lif-338-terminal-session",
      state: "stop",
      observedAt: "2026-07-28T23:01:00.000Z",
      runtimeStatePath: "/tmp/openclaw/sessions.json",
    });
  }

  it("AC3: non-terminal live bindings are unaffected and still replay idempotently", async () => {
    const store = createStore();
    const { config, calls } = makeConfig("live-run");

    const first = await deliverToAgent(makeRoute(), config, undefined, undefined, store);
    const replay = await deliverToAgent(makeRoute(), config, undefined, undefined, store);

    expect(first).toMatchObject({ dispatched: true, runId: "live-run" });
    expect(replay).toMatchObject({
      dispatched: true,
      runId: "live-run",
      idempotentReplay: true,
    });
    expect(calls).toHaveLength(1);
    expect(store.inspect("INF-1003", "implementation")).toMatchObject({
      state: "live",
      session_id: "linear-INF-1003",
    });
  });

  it("AC1/AC2/AC4: terminal stop binding rotates before re-dispatch instead of replaying the C3-prone LIF-338 session", async () => {
    const store = createStore();
    bindTerminalStopSession(store);
    const { config, calls } = makeConfig("fresh-run-after-stop");

    const result = await deliverToAgent(makeRoute(), config, undefined, undefined, store);

    expect(result.dispatched).toBe(true);
    expect(result.idempotentReplay).toBeUndefined();
    expect(result.runId).toBe("fresh-run-after-stop");
    expect(calls).toHaveLength(1);

    const body = JSON.parse(String(calls[0].body)) as { sessionKey: string; message: string };
    expect(body.sessionKey).toBe("linear-INF-1003");
    expect(body.message).toContain("INF-1003");
    expect(body.message).toContain("Connector: terminal-session rotation guard on re-dispatch");

    expect(store.inspect("INF-1003", "implementation")).toMatchObject({
      run_id: "fresh-run-after-stop",
      session_id: "linear-INF-1003",
      state: "live",
      rotation_from_session_id: "lif-338-terminal-session",
      rotation_reason: "terminal-stop",
    });
  });

  it("AC5: pending-bag re-dispatch path rotates terminal bound sessions and exposes old->new binding evidence", async () => {
    const store = createStore();
    bindTerminalStopSession(store);
    const bag = new PendingWorkBag();
    const sessionTracker = new SessionTracker();
    const { calls } = installHooksFetch("fresh-bag-wake-run");
    const wakeConfig: WakeUpConfig = {
      nodeBin: process.execPath,
      hooksUrl: "http://openclaw.test/hooks",
      hooksToken: "token",
      timeoutMs: 50,
      runtimeStatePath: "/tmp/openclaw/sessions.json",
      sessionSpawnStore: store,
      sessionSpawnTaskKey: "implementation",
    };

    const results = await resignalPendingTickets(
      "igor",
      ["INF-1003"],
      bag,
      sessionTracker,
      wakeConfig,
      { markActive: true, isTicketActionable: () => true },
    );

    expect(results).toEqual([
      expect.objectContaining({
        ticketId: "linear-INF-1003",
        dispatched: true,
        runId: "fresh-bag-wake-run",
      }),
    ]);
    expect(calls).toHaveLength(1);
    expect(store.inspect("INF-1003", "implementation")).toMatchObject({
      run_id: "fresh-bag-wake-run",
      session_id: "linear-INF-1003",
      state: "live",
      rotation_from_session_id: "lif-338-terminal-session",
      rotation_reason: "terminal-stop",
    });
  });
});
