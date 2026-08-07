/**
 * INF-1300 — store/session-spawn-idempotency-store.ts
 *
 * AC: idempotency keys, re-entry, persistence.
 * Mocks: better-sqlite3 via :memory: dbPath, mocked clock via Date.now.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { SessionSpawnIdempotencyStore } from "./session-spawn-idempotency-store.js";

function freshStore(): SessionSpawnIdempotencyStore {
  return new SessionSpawnIdempotencyStore(":memory:");
}

describe("SessionSpawnIdempotencyStore", () => {
  let store: SessionSpawnIdempotencyStore;

  beforeEach(() => {
    store = freshStore();
  });

  afterEach(() => {
    store.close();
  });

  describe("idempotency keys", () => {
    it("first beginOrGetExisting for (ticket, task) creates pending and returns start-new", () => {
      const res = store.beginOrGetExisting({
        ticketId: "INF-1",
        taskKey: "spawn",
        runtime: "codex",
        agentId: "alice",
        sessionKey: "sk-1",
      });
      expect(res.action).toBe("start-new");
      expect(res.record.state).toBe("pending");
      expect(res.record.ticket_id).toBe("INF-1");
      expect(res.record.task_key).toBe("spawn");
      expect(res.existing).toBeNull();
    });

    it("second beginOrGetExisting for same key returns return-existing (replayable pending)", () => {
      store.beginOrGetExisting({ ticketId: "INF-2", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      const second = store.beginOrGetExisting({ ticketId: "INF-2", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      expect(second.action).toBe("return-existing");
      expect(second.existing).not.toBeNull();
    });

    it("different taskKey for same ticket creates distinct rows", () => {
      store.beginOrGetExisting({ ticketId: "INF-3", taskKey: "a", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      store.beginOrGetExisting({ ticketId: "INF-3", taskKey: "b", runtime: "codex", agentId: "alice", sessionKey: "sk-2" });
      expect(store.listByTicket("INF-3")).toHaveLength(2);
    });

    it("different ticket for same taskKey creates distinct rows", () => {
      store.beginOrGetExisting({ ticketId: "INF-4", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      store.beginOrGetExisting({ ticketId: "INF-5", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      expect(store.inspect("INF-4", "spawn")).not.toBeNull();
      expect(store.inspect("INF-5", "spawn")).not.toBeNull();
    });
  });

  describe("re-entry", () => {
    it("terminal (completed) claim is reset and re-spawned as start-new", () => {
      const first = store.beginOrGetExisting({ ticketId: "INF-10", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      store.markSpawned(first.record.id, { runId: "r1", sessionId: "s1", state: "live" });
      store.release("INF-10", "spawn", { state: "completed" });
      const replay = store.beginOrGetExisting({ ticketId: "INF-10", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-2" });
      expect(replay.action).toBe("start-new");
      expect(replay.record.state).toBe("pending");
    });

    it("stale pending (older than STALE_INFLIGHT_MS) is treated as not replayable and re-spawned", () => {
      const staleIso = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      store.beginOrGetExisting({
        ticketId: "INF-11",
        taskKey: "spawn",
        runtime: "codex",
        agentId: "alice",
        sessionKey: "sk-old",
        requestedAt: staleIso,
      });
      const second = store.beginOrGetExisting({ ticketId: "INF-11", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-new" });
      expect(second.action).toBe("start-new");
    });

    it("live without binding older than TTL is not replayable (already covered above — pending variant)", () => {
      const staleIso = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      const r = store.beginOrGetExisting({
        ticketId: "INF-12",
        taskKey: "spawn",
        runtime: "codex",
        agentId: "alice",
        sessionKey: "sk-1",
        requestedAt: staleIso,
      });
      // state=pending with stale age → not replayable → second begin re-spawns
      const second = store.beginOrGetExisting({ ticketId: "INF-12", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-2" });
      expect(second.action).toBe("start-new");
      expect(r).toBeDefined();
    });

    it("live with binding older than LIVE_CLAIM_TTL_MS is expired and re-spawned", () => {
      const staleIso = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      const r = store.beginOrGetExisting({
        ticketId: "INF-13",
        taskKey: "spawn",
        runtime: "codex",
        agentId: "alice",
        sessionKey: "sk-1",
        requestedAt: staleIso,
      });
      store.markSpawned(r.record.id, { runId: "r1", sessionId: "s1", state: "live", observedAt: staleIso });
      const replay = store.beginOrGetExisting({ ticketId: "INF-13", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-2" });
      expect(replay.action).toBe("start-new");
    });

    it("markSpawned updates run_id/session_id/state/spawned_at", () => {
      const r = store.beginOrGetExisting({ ticketId: "INF-14", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      const updated = store.markSpawned(r.record.id, { runId: "r2", sessionId: "s2", state: "live" });
      expect(updated.run_id).toBe("r2");
      expect(updated.session_id).toBe("s2");
      expect(updated.state).toBe("live");
      expect(updated.spawned_at).not.toBeNull();
    });

    it("markSpawned records rotation_from_session_id and rotation_reason when provided", () => {
      const r = store.beginOrGetExisting({ ticketId: "INF-15", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      const updated = store.markSpawned(r.record.id, { runId: "r1", sessionId: "s1", state: "live", rotationFromSessionId: "old-sess", rotationReason: "terminal-stop" });
      expect(updated.rotation_from_session_id).toBe("old-sess");
      expect(updated.rotation_reason).toBe("terminal-stop");
    });
  });

  describe("persistence", () => {
    it("inspect returns the record, null when absent", () => {
      expect(store.inspect("INF-20", "spawn")).toBeNull();
      store.beginOrGetExisting({ ticketId: "INF-20", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      expect(store.inspect("INF-20", "spawn")).not.toBeNull();
    });

    it("listByTicket returns ordered records for that ticket only", () => {
      store.beginOrGetExisting({ ticketId: "INF-21", taskKey: "a", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      store.beginOrGetExisting({ ticketId: "INF-21", taskKey: "b", runtime: "codex", agentId: "alice", sessionKey: "sk-2" });
      store.beginOrGetExisting({ ticketId: "INF-22", taskKey: "a", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      expect(store.listByTicket("INF-21")).toHaveLength(2);
      expect(store.listByTicket("INF-22")).toHaveLength(1);
      expect(store.listByTicket("INF-NONE")).toHaveLength(0);
    });

    it("release terminalizes (completed by default) and returns the updated record; null when no row", () => {
      store.beginOrGetExisting({ ticketId: "INF-23", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      const rel = store.release("INF-23", "spawn");
      expect(rel).not.toBeNull();
      expect(rel!.state).toBe("completed");
      expect(store.release("INF-NONE", "spawn")).toBeNull();
    });

    it("release respects explicit state override", () => {
      store.beginOrGetExisting({ ticketId: "INF-24", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-1" });
      const rel = store.release("INF-24", "spawn", { state: "failed" });
      expect(rel!.state).toBe("failed");
    });

    it("sweepExpiredClaims releases stale pending/live rows", () => {
      const staleIso = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      store.beginOrGetExisting({ ticketId: "INF-25", taskKey: "spawn", runtime: "codex", agentId: "alice", sessionKey: "sk-1", requestedAt: staleIso });
      const { released } = store.sweepExpiredClaims();
      expect(released).toBeGreaterThanOrEqual(1);
      expect(store.inspect("INF-25", "spawn")!.state).toBe("completed");
    });

    it("markSpawned throws on unknown id", () => {
      expect(() => store.markSpawned(999999, { runId: "r", sessionId: "s", state: "live" })).toThrow();
    });
  });

  describe("negative case", () => {
    it("inspect for non-existent key returns null (not an error)", () => {
      expect(store.inspect("INF-90", "ghost")).toBeNull();
    });
  });
});
