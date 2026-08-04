/**
 * INF-1074 — completed-status session rotation on production re-dispatch.
 *
 * AC map:
 * - AC1: a bound OpenClaw session with `sessions.json.status: "completed"`
 *   rotates on re-dispatch regardless of the transcript tail stopReason.
 * - AC2: existing INF-1003 terminal-tail rotation is preserved.
 * - AC3: in-flight bindings (`tool_use` tail, or no assistant turn yet) still
 *   replay idempotently when the OpenClaw index does NOT mark them completed.
 * - AC4: ENG-5 zero-output C3 husk shape (completed index status with a
 *   non-`end_turn` tail) mints a productive fresh run instead of replaying the
 *   silent completed session.
 * - AC5: these assertions drive `deliverToAgent` from `delivery/deliver.ts`,
 *   the production delivery/re-dispatch entry point, not the probe directly.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { deliverToAgent, type DeliveryConfig } from "./delivery/deliver.js";
import { SessionSpawnIdempotencyStore } from "./store/session-spawn-idempotency-store.js";
import type { RouteResult } from "./types.js";
import type { LinearEvent } from "./webhook/schema.js";

const TICKET = "INF-1074";
const TASK_KEY = "implementation";
const AGENT = "igor";
const SESSION_KEY = `linear-${TICKET}`;
const BOUND_COMPLETED_SESSION_ID = "eng-5-zero-output-completed-session";

describe("INF-1074 completed-status session rotation at deliver.ts re-dispatch entry point", () => {
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
    const dir = mkdtempSync(path.join(tmpdir(), "inf-1074-session-spawn-"));
    tempDirs.push(dir);
    return new SessionSpawnIdempotencyStore(path.join(dir, "session-spawn-idempotency.db"));
  }

  function createOpenclawHome(): string {
    const home = mkdtempSync(path.join(tmpdir(), "inf-1074-openclaw-home-"));
    tempDirs.push(home);
    return home;
  }

  function makeRoute(): RouteResult {
    return {
      agentId: AGENT,
      sessionKey: SESSION_KEY,
      taskKey: TASK_KEY,
      priority: 0,
      event: {
        type: "Issue",
        action: "update",
        actor: { id: "actor", name: "Astrid" },
        createdAt: "2026-08-02T12:00:00.000Z",
        data: {
          id: "issue-inf-1074",
          identifier: TICKET,
          title: "Connector re-dispatch resumes stale completed session file",
          state: { id: "state-doing", name: "Doing", type: "started" },
          priority: 3,
          priorityLabel: "Normal",
          teamId: "team-inf",
          teamKey: "INF",
          labelIds: [],
          url: `https://linear.app/fancymatt/issue/${TICKET}`,
          createdAt: "2026-08-02T11:55:00.000Z",
          updatedAt: "2026-08-02T12:00:00.000Z",
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

  function bindExistingLiveSession(
    store: SessionSpawnIdempotencyStore,
    sessionId = BOUND_COMPLETED_SESSION_ID,
  ): void {
    // INF-1088 interaction: the bound claim must be FRESH (inside
    // LIVE_CLAIM_TTL_MS) so it stays replayable and the re-dispatch reaches the
    // INF-1074 `return-existing` rotation probe. A hardcoded past timestamp is
    // older than the 30-min live-claim TTL, so beginOrGetExisting treats it as
    // an expired corpse and force-respawns (`start-new`) before the probe ever
    // runs — bypassing rotation entirely and dropping the rotation metadata.
    // Fresh timestamps model a genuinely in-flight session, which is what every
    // AC here exercises: AC1/AC2/AC4 rotate a live-but-dead binding via the
    // probe; AC3 replays a live-and-productive one.
    const bound = store.beginOrGetExisting({
      ticketId: TICKET,
      taskKey: TASK_KEY,
      runtime: "openclaw-acp",
      agentId: AGENT,
      sessionKey: SESSION_KEY,
    });
    store.markSpawned(bound.record.id, {
      runId: "prior-completed-run",
      sessionId,
      state: "live",
      runtimeStatePath: "/tmp/openclaw/sessions.json",
    });
  }

  function writeIndexedSession(
    openclawHome: string,
    opts: {
      status?: "completed" | "working";
      stopReason?: "stop" | "end_turn" | "tool_use";
      assistantText?: string;
      sessionId?: string;
      includeAssistant?: boolean;
    },
  ): void {
    const sessionId = opts.sessionId ?? BOUND_COMPLETED_SESSION_ID;
    const sessionsDir = path.join(openclawHome, "agents", AGENT, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:${AGENT}:${SESSION_KEY}`]: {
          sessionId,
          sessionFile: `${sessionId}.jsonl`,
          ...(opts.status ? { status: opts.status } : {}),
        },
      }),
      "utf8",
    );

    const events = opts.includeAssistant === false ? [
      {
        type: "message",
        timestamp: "2026-08-02T11:59:35.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "resume the ticket" }],
        },
      },
    ] : [
      {
        type: "message",
        timestamp: "2026-08-02T11:59:35.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: opts.assistantText ?? "still working" }],
          stopReason: opts.stopReason ?? "tool_use",
        },
      },
    ];
    writeFileSync(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );
  }

  async function redeliverWithBoundSession(
    opts: Parameters<typeof writeIndexedSession>[1],
    runId: string,
  ): Promise<{ store: SessionSpawnIdempotencyStore; calls: RequestInit[]; result: Awaited<ReturnType<typeof deliverToAgent>> }> {
    const store = createStore();
    bindExistingLiveSession(store, opts.sessionId);
    const openclawHome = createOpenclawHome();
    writeIndexedSession(openclawHome, opts);
    const { config, calls } = makeConfig(runId, openclawHome);

    const result = await deliverToAgent(makeRoute(), config, undefined, undefined, store);

    return { store, calls, result };
  }

  it("AC1/AC5: completed-status bound session with a `tool_use` tail rotates through deliverToAgent instead of idempotent replay", async () => {
    const { store, calls, result } = await redeliverWithBoundSession(
      { status: "completed", stopReason: "tool_use", assistantText: "" },
      "fresh-run-after-completed-tool-use",
    );

    expect(result).toMatchObject({
      dispatched: true,
      runId: "fresh-run-after-completed-tool-use",
    });
    expect(result.idempotentReplay).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(store.inspect(TICKET, TASK_KEY)).toMatchObject({
      run_id: "fresh-run-after-completed-tool-use",
      state: "live",
      rotation_from_session_id: BOUND_COMPLETED_SESSION_ID,
      rotation_reason: "completed-status",
    });
  });

  it("AC1: completed-status bound session rotates even when there is no assistant tail to classify", async () => {
    const { store, calls, result } = await redeliverWithBoundSession(
      { status: "completed", includeAssistant: false, sessionId: "completed-no-assistant-session" },
      "fresh-run-after-completed-no-assistant",
    );

    expect(result).toMatchObject({
      dispatched: true,
      runId: "fresh-run-after-completed-no-assistant",
    });
    expect(result.idempotentReplay).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(store.inspect(TICKET, TASK_KEY)).toMatchObject({
      run_id: "fresh-run-after-completed-no-assistant",
      rotation_from_session_id: "completed-no-assistant-session",
      rotation_reason: "completed-status",
    });
  });

  it("AC2: terminal-tail rotation remains unchanged for non-completed indexed sessions", async () => {
    const { store, calls, result } = await redeliverWithBoundSession(
      { status: "working", stopReason: "stop", sessionId: "terminal-stop-session" },
      "fresh-run-after-terminal-stop",
    );

    expect(result).toMatchObject({
      dispatched: true,
      runId: "fresh-run-after-terminal-stop",
    });
    expect(result.idempotentReplay).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(store.inspect(TICKET, TASK_KEY)).toMatchObject({
      run_id: "fresh-run-after-terminal-stop",
      rotation_from_session_id: "terminal-stop-session",
      rotation_reason: "terminal-stop",
    });
  });

  it("AC3/AC5: live `tool_use` bound session still returns the same-key idempotent replay", async () => {
    const { store, calls, result } = await redeliverWithBoundSession(
      { status: "working", stopReason: "tool_use", sessionId: "live-tool-use-session" },
      "should-not-dispatch-live-tool-use",
    );

    expect(result).toMatchObject({
      dispatched: true,
      runId: "prior-completed-run",
      idempotentReplay: true,
    });
    expect(calls).toHaveLength(0);
    expect(store.inspect(TICKET, TASK_KEY)).toMatchObject({
      run_id: "prior-completed-run",
      rotation_from_session_id: null,
      rotation_reason: null,
    });
  });

  it("AC3: live bound session with no assistant turn yet still returns the same-key idempotent replay", async () => {
    const { store, calls, result } = await redeliverWithBoundSession(
      { status: "working", includeAssistant: false, sessionId: "live-no-assistant-session" },
      "should-not-dispatch-live-no-assistant",
    );

    expect(result).toMatchObject({
      dispatched: true,
      runId: "prior-completed-run",
      idempotentReplay: true,
    });
    expect(calls).toHaveLength(0);
    expect(store.inspect(TICKET, TASK_KEY)).toMatchObject({
      rotation_from_session_id: null,
      rotation_reason: null,
    });
  });

  it("AC4: ENG-5 zero-output C3 completed-session husk becomes a fresh productive delivery, not a silent zero-output replay", async () => {
    const { store, calls, result } = await redeliverWithBoundSession(
      {
        status: "completed",
        stopReason: "tool_use",
        assistantText: "",
        sessionId: "eng-5-c3-zero-output-husk",
      },
      "fresh-productive-eng-5-run",
    );

    expect(result).toMatchObject({
      dispatched: true,
      runId: "fresh-productive-eng-5-run",
    });
    expect(result.idempotentReplay).toBeUndefined();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].body)) as { sessionKey: string; message: string };
    expect(body.sessionKey).toBe(SESSION_KEY);
    expect(body.message).toContain(TICKET);
    expect(body.message).toContain("Connector re-dispatch resumes stale completed session file");
    expect(store.inspect(TICKET, TASK_KEY)).toMatchObject({
      run_id: "fresh-productive-eng-5-run",
      rotation_from_session_id: "eng-5-c3-zero-output-husk",
      rotation_reason: "completed-status",
    });
  });
});
