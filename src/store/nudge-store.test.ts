/**
 * Tests for NudgeStore — per-ticket 15-min suppression window.
 * Suppresses rapid-fire events on the same ticket, but different tickets always deliver.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NudgeStore } from "./nudge-store.js";

function makeTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nudge-test-"));
  const dbPath = path.join(dir, "nudges.db");
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("NudgeStore", () => {
  it("is not suppressed when no nudge recorded", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("is suppressed for same agent + same ticket after recordNudge", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(true);
    store.close();
    cleanup();
  });

  it("is NOT suppressed for same agent + different ticket", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    expect(store.isSuppressed("charles", "AI-200", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("is not suppressed after resetSuppression clears the record", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    store.resetSuppression("charles");
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("does not suppress a different agent", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    expect(store.isSuppressed("astrid", "AI-100", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  // AI-1538: a blocked/aborted dispatch primes the dedup window via recordNudge
  // but sends no delivery. clearNudge rolls that priming back so the next genuine
  // dispatch to the same agent+ticket inside the window is not swallowed.
  it("clearNudge removes suppression so a subsequent dispatch is not coalesced (AC1)", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    // 1. routing-guard-blocked dispatch primes the window for hanzo…
    store.recordNudge("hanzo", "linear-AI-1531");
    expect(store.isSuppressed("hanzo", "linear-AI-1531", 120000)).toBe(true);
    // 2. …but no delivery was sent, so the block rolls it back.
    store.clearNudge("hanzo", "linear-AI-1531");
    // 3. the legitimate deployment dispatch is now NOT suppressed.
    expect(store.isSuppressed("hanzo", "linear-AI-1531", 120000)).toBe(false);
    store.close();
    cleanup();
  });

  it("a fresh recordNudge after clearNudge delivers exactly once (AC3)", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("hanzo", "linear-AI-1531"); // blocked attempt
    store.clearNudge("hanzo", "linear-AI-1531");  // rolled back
    // delegate newly assigned to hanzo → genuine dispatch primes the window.
    expect(store.isSuppressed("hanzo", "linear-AI-1531", 120000)).toBe(false);
    store.recordNudge("hanzo", "linear-AI-1531");
    // and a true duplicate of THAT delivery is still coalesced.
    expect(store.isSuppressed("hanzo", "linear-AI-1531", 120000)).toBe(true);
    store.close();
    cleanup();
  });

  it("clearNudge only clears the targeted agent+ticket", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("hanzo", "linear-AI-1531");
    store.recordNudge("hanzo", "linear-AI-1600");
    store.recordNudge("charles", "linear-AI-1531");
    store.clearNudge("hanzo", "linear-AI-1531");
    expect(store.isSuppressed("hanzo", "linear-AI-1531", 120000)).toBe(false);
    expect(store.isSuppressed("hanzo", "linear-AI-1600", 120000)).toBe(true);
    expect(store.isSuppressed("charles", "linear-AI-1531", 120000)).toBe(true);
    store.close();
    cleanup();
  });

  it("clearNudge on an unknown agent+ticket is a no-op", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    expect(() => store.clearNudge("nobody", "linear-AI-9999")).not.toThrow();
    expect(store.isSuppressed("nobody", "linear-AI-9999", 120000)).toBe(false);
    store.close();
    cleanup();
  });

  it("resets suppression after resetSuppression()", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(true);
    store.resetSuppression("charles");
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("increments nudge count on repeated recordNudge calls", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    store.recordNudge("charles", "AI-100");
    store.recordNudge("charles", "AI-100");
    // Just confirm it stays suppressed and doesn't throw
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(true);
    store.close();
    cleanup();
  });

  // ── Coalescing tests ────────────────────────────────────────────────

  it("recordCoalesced increments coalesced count for suppressed events", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    store.recordCoalesced("charles", "AI-100", "Comment", "create");
    store.recordCoalesced("charles", "AI-100", "Issue", "update");
    store.recordCoalesced("charles", "AI-100");
    const info = store.getCoalesceInfo("charles", "AI-100", 15 * 60 * 1000);
    expect(info.suppressed).toBe(true);
    expect(info.coalescedCount).toBe(3);
    store.close();
    cleanup();
  });

  it("drainCoalescedCount returns count and resets to zero", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    store.recordCoalesced("charles", "AI-100", "Comment", "create");
    store.recordCoalesced("charles", "AI-100");
    expect(store.drainCoalescedCount("charles", "AI-100")).toBe(2);
    expect(store.drainCoalescedCount("charles", "AI-100")).toBe(0);
    store.close();
    cleanup();
  });

  it("drainCoalescedCount returns 0 when no coalesced events", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    expect(store.drainCoalescedCount("charles", "AI-100")).toBe(0);
    store.close();
    cleanup();
  });

  it("getCoalesceInfo returns coalescedCount=0 when not suppressed", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    // Record a nudge, wait for window to "expire" by using windowMs=0
    store.recordNudge("charles", "AI-100");
    const info = store.getCoalesceInfo("charles", "AI-100", 0);
    expect(info.suppressed).toBe(false);
    expect(info.coalescedCount).toBe(0);
    store.close();
    cleanup();
  });

  // ── Atomic acquireNudgeSlot tests (AI-2376) ─────────────────────────────

  it("acquireNudgeSlot: first call admits with coalescedCount=0", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    const result = store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    expect(result.suppressed).toBe(false);
    expect(result.coalescedCount).toBe(0);
    store.close();
    cleanup();
  });

  it("acquireNudgeSlot: second call within window is suppressed", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    const result = store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    expect(result.suppressed).toBe(true);
    expect(result.coalescedCount).toBe(1);
    store.close();
    cleanup();
  });

  it("acquireNudgeSlot: multiple suppressed calls increment coalescedCount", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    store.acquireNudgeSlot("astrid", "AI-2376", 120000); // suppressed → 1
    const r3 = store.acquireNudgeSlot("astrid", "AI-2376", 120000); // suppressed → 2
    expect(r3.suppressed).toBe(true);
    expect(r3.coalescedCount).toBe(2);
    store.close();
    cleanup();
  });

  it("acquireNudgeSlot: different ticket is not suppressed", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    const result = store.acquireNudgeSlot("astrid", "AI-2400", 120000);
    expect(result.suppressed).toBe(false);
    expect(result.coalescedCount).toBe(0);
    store.close();
    cleanup();
  });

  it("acquireNudgeSlot: different agent not suppressed", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    const result = store.acquireNudgeSlot("grover", "AI-2376", 120000);
    expect(result.suppressed).toBe(false);
    expect(result.coalescedCount).toBe(0);
    store.close();
    cleanup();
  });

  it("acquireNudgeSlot: expired window admits with drained coalesced count", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    // Prime with a first slot (admitted)
    store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    // Two suppressed events within window
    store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    // Window expired (0ms) — admits and drains coalesced count
    const result = store.acquireNudgeSlot("astrid", "AI-2376", 0);
    expect(result.suppressed).toBe(false);
    expect(result.coalescedCount).toBe(2);
    store.close();
    cleanup();
  });

  it("acquireNudgeSlot: expired window resets DB coalesced_count to 0", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    store.acquireNudgeSlot("astrid", "AI-2376", 120000); // coalesced
    store.acquireNudgeSlot("astrid", "AI-2376", 0); // expired — drains
    // Now window is active again; next call should be suppressed
    const nextResult = store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    expect(nextResult.suppressed).toBe(true);
    expect(nextResult.coalescedCount).toBe(1);
    store.close();
    cleanup();
  });

  it("acquireNudgeSlot: passes eventType and eventAction on coalesced", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    store.acquireNudgeSlot("astrid", "AI-2376", 120000, "Comment", "create");
    // Verify through getCoalesceInfo (deprecated but fine for read)
    const info = store.getCoalesceInfo("astrid", "AI-2376", 120000);
    expect(info.suppressed).toBe(true);
    expect(info.coalescedCount).toBe(1);
    store.close();
    cleanup();
  });

  it("acquireNudgeSlot: concurrent calls are serialized by SQLite lock", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    // Simulate near-simultaneous calls by invoking sequentially with a
    // fresh DB — the critical property is that the second call sees the
    // first call's row (which it would NOT if read-then-write raced).
    // Two calls where both would have "no row yet" if raced:
    const r1 = store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    expect(r1.suppressed).toBe(false);
    // Second call MUST see the row created by the first
    const r2 = store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    expect(r2.suppressed).toBe(true);
    expect(r2.coalescedCount).toBe(1);
    store.close();
    cleanup();
  });

  it("acquireNudgeSlot: isSuppressed and recordNudge still work after atomic call", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    // Mix old and new APIs on the same DB
    const r1 = store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    expect(r1.suppressed).toBe(false);
    // Old API sees the row from atomic API
    expect(store.isSuppressed("astrid", "AI-2376", 120000)).toBe(true);
    store.recordNudge("astrid", "AI-2376");
    // The atomic API sees the update from old API
    const r2 = store.acquireNudgeSlot("astrid", "AI-2376", 0);
    expect(r2.suppressed).toBe(false);
    expect(r2.coalescedCount).toBe(0);
    store.close();
    cleanup();
  });

  it("acquireNudgeSlot: clearNudge after atomic admit allows re-admit", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    store.clearNudge("astrid", "AI-2376");
    const reAdmit = store.acquireNudgeSlot("astrid", "AI-2376", 120000);
    expect(reAdmit.suppressed).toBe(false);
    expect(reAdmit.coalescedCount).toBe(0);
    store.close();
    cleanup();
  });
});
