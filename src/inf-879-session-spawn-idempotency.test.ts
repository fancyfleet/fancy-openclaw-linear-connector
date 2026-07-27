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
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  SessionSpawnIdempotencyStore,
  type SessionSpawnRunState,
} from "./store/session-spawn-idempotency-store.js";

describe("INF-879 sessions_spawn task-key idempotency", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createStore(): SessionSpawnIdempotencyStore {
    const dir = mkdtempSync(path.join(tmpdir(), "inf-879-session-spawn-"));
    tempDirs.push(dir);
    return new SessionSpawnIdempotencyStore(path.join(dir, "session-spawn-idempotency.db"));
  }

  it("AC1: duplicate replay for the same ticket/task key returns the existing live run", () => {
    const store = createStore();
    const first = store.beginOrGetExisting({
      ticketId: "INF-879",
      taskKey: "write-tests",
      runtime: "codex",
      agentId: "tdd",
      sessionKey: "agent:tdd:linear-INF-879",
      requestedAt: "2026-07-27T16:40:00.000Z",
    });
    expect(first).toMatchObject({ action: "start-new", existing: null });

    store.markSpawned(first.record.id, {
      runId: "run-native-1",
      sessionId: "session-native-1",
      state: "live" satisfies SessionSpawnRunState,
      observedAt: "2026-07-27T16:40:01.000Z",
    });

    const replay = store.beginOrGetExisting({
      ticketId: "INF-879",
      taskKey: "write-tests",
      runtime: "codex",
      agentId: "tdd",
      sessionKey: "agent:tdd:linear-INF-879",
      requestedAt: "2026-07-27T16:40:02.000Z",
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
});
