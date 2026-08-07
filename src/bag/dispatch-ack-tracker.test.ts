/**
 * INF-1300 — bag/dispatch-ack-tracker.ts
 *
 * AC: ack recording, dedup (UNIQUE agent+ticket), recovery/expiry path; at least one negative case.
 * Mocks: better-sqlite3 via :memory: dbPath, clock via Date.now, Linear not needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { DispatchAckTracker } from "./dispatch-ack-tracker.js";

function freshTracker(): DispatchAckTracker {
  return new DispatchAckTracker(":memory:");
}

describe("DispatchAckTracker", () => {
  let tracker: DispatchAckTracker;

  beforeEach(() => {
    tracker = freshTracker();
  });

  afterEach(() => {
    tracker.close();
  });

  describe("ack recording", () => {
    it("recordDispatch creates a pending entry with attemptCount=1", () => {
      tracker.recordDispatch("alice", "INF-1");
      const pending = tracker.getPendingTimedOut(0);
      expect(pending).toHaveLength(1);
      expect(pending[0].agentId).toBe("alice");
      expect(pending[0].ackStatus).toBe("pending");
      expect(pending[0].attemptCount).toBe(1);
    });

    it("acknowledge transitions pending → acknowledged and removes from pending set", () => {
      tracker.recordDispatch("alice", "INF-2");
      const changed = tracker.acknowledge("alice", "INF-2");
      expect(changed).toBeGreaterThan(0);
      expect(tracker.getPendingTimedOut(0)).toHaveLength(0);
    });

    it("getPendingTimedOut with timeoutMs<=0 returns all pending/unconfirmed, none acknowledged", () => {
      tracker.recordDispatch("alice", "INF-10");
      tracker.recordDispatch("bob", "INF-11");
      tracker.acknowledge("alice", "INF-10");
      const pending = tracker.getPendingTimedOut(0);
      // ticketId is normalized to linear- form
      expect(pending.map((r) => r.ticketId)).toEqual(expect.arrayContaining(["linear-INF-11"]));
      expect(pending.map((r) => r.ticketId)).not.toEqual(expect.arrayContaining(["INF-10"]));
      expect(pending.map((r) => r.ticketId)).not.toEqual(expect.arrayContaining(["linear-INF-10"]));
    });
  });

  describe("dedup (UNIQUE agentId+ticketId)", () => {
    it("second recordDispatch for same agent+ticket refreshes lastSignalAt and increments attemptCount", () => {
      tracker.recordDispatch("alice", "INF-20");
      const before = tracker.getPendingTimedOut(0)[0]!;
      tracker.recordDispatch("alice", "INF-20");
      const after = tracker.getPendingTimedOut(0)[0]!;
      expect(after.attemptCount).toBe(before.attemptCount + 1);
      // only one row for that pair (ticketId is stored normalized)
      expect(tracker.getPendingTimedOut(0).filter((r) => r.agentId === "alice" && r.ticketId === "linear-INF-20")).toHaveLength(1);
    });

    it("different agents for same ticket create distinct rows", () => {
      tracker.recordDispatch("alice", "INF-21");
      tracker.recordDispatch("bob", "INF-21");
      expect(tracker.getPendingTimedOut(0)).toHaveLength(2);
    });

    it("re-dispatch after acknowledge re-arms to pending", () => {
      tracker.recordDispatch("alice", "INF-22");
      tracker.acknowledge("alice", "INF-22");
      tracker.recordDispatch("alice", "INF-22");
      const pending = tracker.getPendingTimedOut(0);
      expect(pending).toHaveLength(1);
      expect(pending[0].ackStatus).toBe("pending");
    });
  });

  describe("recovery/expiry path", () => {
    it("getPendingTimedOut respects timeoutMs filtering (future cutoff → none)", () => {
      tracker.recordDispatch("alice", "INF-30");
      // very large timeout: last_signal_at is now so not yet timed out
      const none = tracker.getPendingTimedOut(60 * 60 * 1000);
      expect(none).toHaveLength(0);
    });

    it("markResignaled moves to unconfirmed, bumps attempt_count and resets clocks", () => {
      tracker.recordDispatch("alice", "INF-31");
      tracker.markResignaled("alice", "INF-31");
      const row = tracker.getPendingTimedOut(0)[0]!;
      expect(row.ackStatus).toBe("unconfirmed");
      expect(row.attemptCount).toBe(2);
      expect(row.failureCount).toBe(0);
    });

    it("markResignalFailed increments failure streak without touching attemptCount", () => {
      tracker.recordDispatch("alice", "INF-32");
      tracker.markResignaled("alice", "INF-32");
      const afterSignal = tracker.getPendingTimedOut(0)[0]!;
      const attemptBeforeFail = afterSignal.attemptCount;
      tracker.markResignalFailed("alice", "INF-32");
      const afterFail = tracker.getPendingTimedOut(0)[0]!;
      expect(afterFail.failureCount).toBe(1);
      expect(afterFail.attemptCount).toBe(attemptBeforeFail);
    });

    it("markEscalated sets escalated and isEscalated returns true", () => {
      tracker.recordDispatch("alice", "INF-33");
      tracker.markEscalated("alice", "INF-33");
      expect(tracker.isEscalated("alice", "INF-33")).toBe(true);
      expect(tracker.getPendingTimedOut(0)).toHaveLength(0);
    });

    it("clearEscalated re-arms only when status is escalated", () => {
      tracker.recordDispatch("alice", "INF-34");
      tracker.markEscalated("alice", "INF-34");
      expect(tracker.clearEscalated("alice", "INF-34")).toBe(true);
      expect(tracker.isEscalated("alice", "INF-34")).toBe(false);
      expect(tracker.getPendingTimedOut(0)).toHaveLength(1);
      // second clear is no-op (not escalated anymore)
      expect(tracker.clearEscalated("alice", "INF-34")).toBe(false);
    });

    it("clearEscalated fires onFreshDispatch callback (ticketId normalized)", () => {
      const calls: string[] = [];
      const t2 = new DispatchAckTracker(":memory:", undefined, (id) => calls.push(id));
      t2.recordDispatch("alice", "INF-35");
      t2.markEscalated("alice", "INF-35");
      t2.clearEscalated("alice", "INF-35");
      expect(calls).toContain("linear-INF-35");
      t2.close();
    });

    it("noteAuthoredActivity pending → acknowledged, unconfirmed → surveilled, absent → none", () => {
      tracker.recordDispatch("alice", "INF-36");
      expect(tracker.noteAuthoredActivity("alice", "INF-36")).toBe("acknowledged");
      tracker.recordDispatch("alice", "INF-37");
      tracker.markResignaled("alice", "INF-37");
      expect(tracker.noteAuthoredActivity("alice", "INF-37")).toBe("surveilled");
      expect(tracker.noteAuthoredActivity("alice", "INF-999")).toBe("none");
    });

    it("markDeferred sets deferred (not pending) and getDeferredStale respects age", () => {
      tracker.recordDispatch("alice", "INF-38");
      tracker.markDeferred("alice", "INF-38");
      expect(tracker.getPendingTimedOut(0)).toHaveLength(0);
      // staleMs 0 uses cutoff=now, but last_signal_at=datetime('now') at sec granularity;
      // with truncate-ms formatting the row is placed exactly at the cutoff, so <= holds.
      // If timing races near a second boundary, allow 1s tolerance check.
      const staleNow = tracker.getDeferredStale(0);
      const staleWithGrace = tracker.getDeferredStale(1500);
      const found = staleNow.some((r) => r.ticketId === "linear-INF-38") || staleWithGrace.some((r) => r.ticketId === "linear-INF-38");
      expect(found).toBe(true);
    });

    it("hasRecentPending true when within window, false otherwise", () => {
      tracker.recordDispatch("alice", "INF-39");
      expect(tracker.hasRecentPending("alice", "INF-39", 60_000)).toBe(true);
      expect(tracker.hasRecentPending("alice", "INF-990", 60_000)).toBe(false);
    });

    it("cleanup is callable and returns a number (ttl expiry depends on wall-clock second granularity)", () => {
      const shortTtl = new DispatchAckTracker(":memory:", 1);
      shortTtl.recordDispatch("alice", "INF-40");
      // Only acknowledged/escalated rows are pruned; pending ones are untouched.
      // Acknowledge then cleanup should be eligible once the second ticks.
      shortTtl.acknowledge("alice", "INF-40");
      const removed = shortTtl.cleanup();
      expect(typeof removed).toBe("number");
      shortTtl.close();
    });

    it("listFiltered and listRecent surface stored rows", () => {
      tracker.recordDispatch("alice", "INF-41");
      tracker.recordDispatch("bob", "INF-42");
      expect(tracker.listFiltered({ agentId: "alice" }).every((r) => r.agentId === "alice")).toBe(true);
      expect(tracker.listRecent(1)).toHaveLength(1);
      expect(tracker.listRecent(200).length).toBe(2);
    });
  });

  describe("negative case", () => {
    it("acknowledge unknown agent/ticket affects zero rows and leaves pending untouched", () => {
      tracker.recordDispatch("alice", "INF-50");
      const changed = tracker.acknowledge("unknown-agent", "INF-50");
      expect(changed).toBe(0);
      expect(tracker.getPendingTimedOut(0)).toHaveLength(1);
    });

    it("noteAuthoredActivity on non-existent entry returns none and does not create a row", () => {
      expect(tracker.noteAuthoredActivity("ghost", "INF-51")).toBe("none");
      expect(tracker.getPendingTimedOut(0)).toHaveLength(0);
    });
  });
});
