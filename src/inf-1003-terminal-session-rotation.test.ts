/**
 * INF-1003 — terminal-session rotation guard on re-dispatch.
 *
 * The terminal precondition is established the way PRODUCTION establishes it —
 * a real per-ticket session transcript whose last assistant turn ended with
 * `stopReason: stop` (the codex-mirror-frozen tail from the INF-958 incident),
 * discoverable through OpenClaw's `sessions.json` index. The guard reads that
 * live signal via `probeBoundSessionTerminal`, so these tests drive the actual
 * re-dispatch entry points and prove the guard is reachable from them
 * (AC5 / AI-1808) — NOT by injecting a `state: "stop"` value no production path
 * ever writes onto the idempotency record.
 *
 * AC map:
 * - AC1/AC5: a terminal bound session is not replayed; the production delivery
 *   and pending-bag re-dispatch paths mint a fresh session and record the
 *   observable old->new session-id rotation.
 * - AC2: the fresh session receives the normal full dispatch message.
 * - AC3: non-terminal bindings (no transcript, or a still-working `tool_use`
 *   tail) keep the existing idempotent replay behavior — no over-rotation.
 * - AC4: the LIF-338 class of terminal codex-mirror replay does not silently
 *   complete as C3; the terminal binding is rotated before replay.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { deliverToAgent, type DeliveryConfig } from "./delivery/deliver.js";
import { PendingWorkBag, SessionTracker, resignalPendingTickets } from "./bag/index.js";
import type { WakeUpConfig } from "./bag/wake-up.js";
import { SessionSpawnIdempotencyStore } from "./store/session-spawn-idempotency-store.js";
import type { RouteResult } from "./types.js";
import type { LinearEvent } from "./webhook/schema.js";

const TERMINAL_SESSION_ID = "lif-338-terminal-session";

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

  /** A temp OpenClaw home the rotation guard will resolve the bound session from. */
  function createOpenclawHome(): string {
    const home = mkdtempSync(path.join(tmpdir(), "inf-1003-openclaw-home-"));
    tempDirs.push(home);
    return home;
  }

  /**
   * Write a session transcript exactly the way OpenClaw does — a `sessions.json`
   * index entry keyed `agent:<agent>:<sessionKey>` pointing at a `.jsonl` whose
   * last assistant turn carries `stopReason`. This is the production shape
   * `probeBoundSessionTerminal` reads; `stopReason: "stop"` is the frozen tail.
   */
  function writeSessionTranscript(
    openclawHome: string,
    stopReason: string,
    { agent = "igor", sessionKey = "linear-INF-1003", sessionId = TERMINAL_SESSION_ID } = {},
  ): void {
    const sessionsDir = path.join(openclawHome, "agents", agent, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const index = {
      [`agent:${agent}:${sessionKey}`]: { sessionId, sessionFile: `${sessionId}.jsonl` },
    };
    writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify(index));
    const transcript = [
      JSON.stringify({
        type: "message",
        timestamp: "2026-07-28T23:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "approved and handed to Hanzo" }],
          stopReason,
        },
      }),
    ].join("\n");
    writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), transcript);
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

  function makeConfig(runId: string, openclawHome: string): { config: DeliveryConfig; calls: RequestInit[] } {
    const { calls } = installHooksFetch(runId);
    return {
      calls,
      config: {
        nodeBin: process.execPath,
        hooksUrl: "http://openclaw.test/hooks",
        hooksToken: "token",
        timeoutMs: 50,
        runtimeStatePath: "/tmp/openclaw/sessions.json",
        openclawHome,
      },
    };
  }

  /**
   * Seed a realistic EXISTING idempotency record so re-dispatch takes the
   * `return-existing` branch. Its `state` is `"live"` — the value production
   * actually writes; terminal-ness is decided from the transcript, not here.
   */
  function bindExistingLiveSession(store: SessionSpawnIdempotencyStore, taskKey = "implementation"): void {
    const bound = store.beginOrGetExisting({
      ticketId: "INF-1003",
      taskKey,
      runtime: "openclaw-acp",
      agentId: "igor",
      sessionKey: "agent:igor:linear-INF-1003",
      requestedAt: "2026-07-28T23:00:00.000Z",
    });
    store.markSpawned(bound.record.id, {
      runId: "prior-live-run",
      sessionId: TERMINAL_SESSION_ID,
      state: "live",
      observedAt: "2026-07-28T23:01:00.000Z",
      runtimeStatePath: "/tmp/openclaw/sessions.json",
    });
  }

  it("AC3: non-terminal live bindings (no transcript) are unaffected and still replay idempotently", async () => {
    const store = createStore();
    const home = createOpenclawHome(); // empty — the guard resolves no bound session
    const { config, calls } = makeConfig("live-run", home);

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
      rotation_from_session_id: null,
      rotation_reason: null,
    });
  });

  it("AC3: a still-working (`tool_use`) bound session is NOT rotated — no over-rotation", async () => {
    const store = createStore();
    bindExistingLiveSession(store);
    const home = createOpenclawHome();
    writeSessionTranscript(home, "tool_use"); // mid-turn, resumable — not terminal
    const { config, calls } = makeConfig("should-not-run", home);

    const result = await deliverToAgent(makeRoute(), config, undefined, undefined, store);

    expect(result.idempotentReplay).toBe(true);
    expect(calls).toHaveLength(0); // no fresh dispatch
    expect(store.inspect("INF-1003", "implementation")).toMatchObject({
      rotation_from_session_id: null,
      rotation_reason: null,
    });
  });

  it("AC1/AC2/AC4: terminal `stopReason: stop` binding rotates before re-dispatch instead of replaying the C3-prone LIF-338 session", async () => {
    const store = createStore();
    bindExistingLiveSession(store);
    const home = createOpenclawHome();
    writeSessionTranscript(home, "stop"); // codex-mirror-frozen tail
    const { config, calls } = makeConfig("fresh-run-after-stop", home);

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
      rotation_from_session_id: TERMINAL_SESSION_ID,
      rotation_reason: "terminal-stop",
    });
  });

  it("AC5: pending-bag re-dispatch path rotates terminal bound sessions and exposes old->new binding evidence", async () => {
    const store = createStore();
    bindExistingLiveSession(store);
    const home = createOpenclawHome();
    writeSessionTranscript(home, "stop");
    const bag = new PendingWorkBag();
    const sessionTracker = new SessionTracker();
    const { calls } = installHooksFetch("fresh-bag-wake-run");
    const wakeConfig: WakeUpConfig = {
      nodeBin: process.execPath,
      hooksUrl: "http://openclaw.test/hooks",
      hooksToken: "token",
      timeoutMs: 50,
      runtimeStatePath: "/tmp/openclaw/sessions.json",
      openclawHome: home,
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
      rotation_from_session_id: TERMINAL_SESSION_ID,
      rotation_reason: "terminal-stop",
    });
  });
});
