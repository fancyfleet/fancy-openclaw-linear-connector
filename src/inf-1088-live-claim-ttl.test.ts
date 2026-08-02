/**
 * INF-1088 — session-spawn claim TTL / explicit release / lifecycle transitions.
 *
 * Root cause: a `live` claim carrying a concrete session binding is exempt from
 * INF-1026's `isStaleInFlight`, and nothing terminalizes it. When the bound
 * session ends and the INF-1003/INF-1074 terminal-rotation probe cannot read the
 * session as terminal, the `live` row persists forever and every re-dispatch for
 * that (ticket, task_key) short-circuits as an idempotent replay — the fleet-wide
 * dispatch-freeze (478 live rows, zero terminal). These tests exercise the
 * probe-independent backstop at the store layer.
 *
 * AC map:
 * - AC1: a live claim with a bound session but a stale (past-TTL) update is NOT a
 *   valid replay — beginOrGetExisting re-spawns (start-new) and resets to pending.
 * - AC2: a fresh live claim with a bound session IS still replayed — no
 *   regression to INF-879 / INF-1003 non-terminal replay.
 * - AC3: explicit release() terminalizes a claim; the next dispatch re-spawns even
 *   when the claim's update timestamp is recent.
 * - AC4: sweepExpiredClaims terminalizes past-TTL live/pending rows (returns the
 *   count), leaves fresh rows live, and a swept seat re-spawns on next dispatch.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { SessionSpawnIdempotencyStore } from "./store/session-spawn-idempotency-store.js";

const TTL_MS = 30 * 60 * 1000;

describe("INF-1088 session-spawn claim TTL and explicit release", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createStore(): SessionSpawnIdempotencyStore {
    const dir = mkdtempSync(path.join(tmpdir(), "inf-1088-live-claim-ttl-"));
    tempDirs.push(dir);
    return new SessionSpawnIdempotencyStore(path.join(dir, "session-spawn-idempotency.db"));
  }

  const beginInput = (overrides: Partial<Parameters<SessionSpawnIdempotencyStore["beginOrGetExisting"]>[0]> = {}) => ({
    ticketId: "INF-1088",
    taskKey: "doing",
    runtime: "openclaw-acp",
    agentId: "igor",
    sessionKey: "linear-INF-1088",
    ...overrides,
  });

  /** Reserve, then bind a live session with a controllable "last update" time. */
  function seatLiveClaim(store: SessionSpawnIdempotencyStore, at: string, sessionId = "sess-1"): number {
    const begin = store.beginOrGetExisting(beginInput({ requestedAt: at }));
    store.markSpawned(begin.record.id, {
      runId: "run-1",
      sessionId,
      state: "live",
      observedAt: at,
    });
    return begin.record.id;
  }

  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("AC1: a past-TTL live claim with a bound session is re-spawned, not replayed", () => {
    const store = createStore();
    const id = seatLiveClaim(store, iso(2 * TTL_MS), "dead-session");

    // Sanity: the seat is genuinely bound live before the re-dispatch.
    const bound = store.inspect("INF-1088", "doing");
    expect(bound?.state).toBe("live");
    expect(bound?.session_id).toBe("dead-session");

    const replay = store.beginOrGetExisting(beginInput());
    expect(replay.action).toBe("start-new");
    expect(replay.existing).toBeNull();
    // Same row, reset to pending with the dead binding cleared.
    expect(replay.record.id).toBe(id);
    expect(replay.record.state).toBe("pending");
    expect(replay.record.session_id).toBeNull();
  });

  it("AC2: a fresh live claim with a bound session is still replayed (no regression)", () => {
    const store = createStore();
    seatLiveClaim(store, iso(60 * 1000), "live-session"); // 1 min old

    const replay = store.beginOrGetExisting(beginInput());
    expect(replay.action).toBe("return-existing");
    expect(replay.existing).not.toBeNull();
    expect(replay.record.state).toBe("live");
    expect(replay.record.session_id).toBe("live-session");
  });

  it("AC3: explicit release terminalizes a fresh claim so the next dispatch re-spawns", () => {
    const store = createStore();
    seatLiveClaim(store, iso(60 * 1000), "live-session"); // fresh — would otherwise replay

    const released = store.release("INF-1088", "doing");
    expect(released?.state).toBe("completed");

    const next = store.beginOrGetExisting(beginInput());
    expect(next.action).toBe("start-new");
    expect(next.record.state).toBe("pending");

    // Releasing an unknown key is a no-op, not a throw.
    expect(store.release("INF-9999", "doing")).toBeNull();
  });

  it("AC4: sweepExpiredClaims releases past-TTL rows, spares fresh ones, and swept seats re-spawn", () => {
    const store = createStore();
    // Stale bound live claim (the corpse) on the `doing` task.
    seatLiveClaim(store, iso(2 * TTL_MS), "dead-session");
    // Stale pending reservation on a second task — never bound a session.
    store.beginOrGetExisting(beginInput({ taskKey: "review", requestedAt: iso(2 * TTL_MS) }));
    // A genuinely fresh live claim on a third task must survive the sweep.
    store.markSpawned(
      store.beginOrGetExisting(beginInput({ taskKey: "fresh", requestedAt: iso(30 * 1000) })).record.id,
      { runId: "run-new", sessionId: "fresh-session", state: "live", observedAt: iso(30 * 1000) },
    );

    const { released } = store.sweepExpiredClaims();
    expect(released).toBe(2); // stale live + stale pending

    expect(store.inspect("INF-1088", "doing")?.state).toBe("completed");
    expect(store.inspect("INF-1088", "review")?.state).toBe("completed");
    expect(store.inspect("INF-1088", "fresh")?.state).toBe("live"); // spared

    // A swept seat re-spawns on the next dispatch.
    const redispatch = store.beginOrGetExisting(beginInput({ taskKey: "doing" }));
    expect(redispatch.action).toBe("start-new");
    expect(redispatch.record.state).toBe("pending");
  });
});
