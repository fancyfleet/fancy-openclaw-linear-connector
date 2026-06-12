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
});
