/**
 * INF-1101 — Post-review re-dispatch no-activity park.
 *
 * Root cause (see INF-1101): a ticket that exhausts its GlobalRedispatchBudget
 * pre-review seals the budget permanently (keyed on ticketId alone) AND leaves
 * an `escalated` ack row. When the ticket later re-enters a worker state via a
 * legitimate post-review re-dispatch (a genuinely new work phase), NOTHING
 * cleared either the sealed budget or the escalated ack row:
 *   - budget says "exhausted, don't re-dispatch"
 *   - ack says "already escalated, don't re-alert"
 * Net: no re-dispatch, no escalation, no comment — a SILENT PARK.
 *
 * Fix: wire the two already-intended resets to the fresh-work-phase boundary
 * (a genuine new dispatch = `recordDispatch`, which the internal no-activity /
 * watchdog / stale retry loops do NOT call — they use markResignaled+consume):
 *   1. `globalRedispatchBudget.reset(ticketId)` fires on every genuine dispatch.
 *   2. the escalated ack row re-arms to `pending` on the same boundary.
 * Both must clear TOGETHER — clearing only one still silent-parks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { DispatchAckTracker } from "./dispatch-ack-tracker.js";
import { GlobalRedispatchBudget } from "./global-redispatch-budget.js";
import { normalizeSessionKey } from "../session-key.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1101-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const AGENT = "igor";
const TICKET = "INF-862";
// The ack tracker stores — and every budget consumer (no-activity detector,
// watchdog, stale-session forensics) keys the budget by — the normalized
// "linear-<TEAM>-<N>" form (session-key.ts). Model the world: direct budget ops
// and ack-entry lookups use KEY, and recordDispatch/clearEscalated fire the
// hook with KEY.
const KEY = normalizeSessionKey(TICKET);

describe("INF-1101 AC2 — clearEscalated / re-arm on the ack tracker", () => {
  it("re-arms an escalated row to pending, resets counters, and fires the fresh-dispatch hook", () => {
    const hook = jest.fn();
    const tracker = new DispatchAckTracker(path.join(tmpDir, "acks.db"), undefined, hook);
    tracker.recordDispatch(AGENT, TICKET);
    tracker.markResignaled(AGENT, TICKET); // attempt_count now 2
    tracker.markEscalated(AGENT, TICKET);
    hook.mockClear();

    // Escalated rows are invisible to the no-activity ladder — the silent park.
    expect(tracker.getPendingTimedOut(0).map((e) => e.ticketId)).not.toContain(KEY);

    const rearmed = tracker.clearEscalated(AGENT, TICKET);
    expect(rearmed).toBe(true);

    const pending = tracker.getPendingTimedOut(0).find((e) => e.ticketId === KEY);
    expect(pending).toBeDefined();
    expect(pending!.ackStatus).toBe("pending");
    expect(pending!.attemptCount).toBe(1); // fresh phase gets a full budget
    expect(pending!.failureCount).toBe(0);
    // The budget seal must clear on the SAME boundary as the escalated ack row.
    expect(hook).toHaveBeenCalledWith(KEY);

    tracker.close();
  });

  it("is a no-op (returns false, no hook) when the row is not escalated", () => {
    const hook = jest.fn();
    const tracker = new DispatchAckTracker(path.join(tmpDir, "acks.db"), undefined, hook);
    tracker.recordDispatch(AGENT, TICKET);
    hook.mockClear();

    expect(tracker.clearEscalated(AGENT, TICKET)).toBe(false);
    expect(hook).not.toHaveBeenCalled();
    // Still a normal pending row, untouched.
    const pending = tracker.getPendingTimedOut(0).find((e) => e.ticketId === KEY);
    expect(pending?.ackStatus).toBe("pending");

    tracker.close();
  });

  it("recordDispatch on an escalated row re-arms it to pending (genuine post-review re-dispatch)", () => {
    const hook = jest.fn();
    const tracker = new DispatchAckTracker(path.join(tmpDir, "acks.db"), undefined, hook);
    tracker.recordDispatch(AGENT, TICKET);
    tracker.markResignaled(AGENT, TICKET);
    tracker.markEscalated(AGENT, TICKET);
    hook.mockClear();

    // A legitimate new dispatch arrives (review→doing fires the delivery seam).
    tracker.recordDispatch(AGENT, TICKET);

    const pending = tracker.getPendingTimedOut(0).find((e) => e.ticketId === KEY);
    expect(pending).toBeDefined();
    expect(pending!.ackStatus).toBe("pending");
    expect(pending!.attemptCount).toBe(1);
    expect(pending!.failureCount).toBe(0);
    expect(hook).toHaveBeenCalledWith(KEY);

    tracker.close();
  });
});

describe("INF-1101 AC1 — budget reset wired to the genuine-dispatch boundary", () => {
  it("recordDispatch fires the fresh-dispatch hook with the ticket id", () => {
    const hook = jest.fn();
    const tracker = new DispatchAckTracker(path.join(tmpDir, "acks.db"), undefined, hook);

    tracker.recordDispatch(AGENT, TICKET);
    expect(hook).toHaveBeenCalledWith(KEY);

    tracker.close();
  });
});

describe("INF-1101 AC3 — post-review re-dispatch after exhaustion never silent-parks", () => {
  it("resets the sealed budget AND re-arms the escalated ack on a genuine re-dispatch", () => {
    const budget = new GlobalRedispatchBudget({ dbDir: tmpDir, maxAttempts: 3 });
    // Wire the budget reset to the ack tracker's fresh-dispatch boundary — this
    // is the never-wired reset() the fix installs.
    const tracker = new DispatchAckTracker(
      path.join(tmpDir, "acks.db"),
      undefined,
      (ticketId) => budget.reset(ticketId),
    );

    // ── Pre-review: the INF-862/INF-761 looper exhausts its budget and escalates.
    tracker.recordDispatch(AGENT, TICKET);
    budget.consume(KEY); // 1
    budget.consume(KEY); // 2
    budget.consume(KEY); // 3
    expect(budget.isCapped(KEY)).toBe(true);
    tracker.markEscalated(AGENT, TICKET);

    // The silent-park state: budget sealed AND ack escalated (invisible to detector).
    expect(tracker.getPendingTimedOut(0).map((e) => e.ticketId)).not.toContain(KEY);

    // ── Post-review: a legitimate new work phase re-dispatches the ticket.
    tracker.recordDispatch(AGENT, TICKET);

    // Budget seal cleared…
    expect(budget.isCapped(KEY)).toBe(false);
    expect(budget.get(KEY)).toBe(0);
    // …AND the ack row is visible again, so the detector re-dispatches or
    // re-escalates with a comment instead of silently parking.
    expect(tracker.getPendingTimedOut(0).map((e) => e.ticketId)).toContain(KEY);

    budget.close();
    tracker.close();
  });
});

describe("INF-1101 AC4 — genuine loop without a new work phase still seals once", () => {
  it("does not reset the budget on internal retries (consume), only on recordDispatch", () => {
    const hook = jest.fn();
    const budget = new GlobalRedispatchBudget({ dbDir: tmpDir, maxAttempts: 3 });
    const tracker = new DispatchAckTracker(
      path.join(tmpDir, "acks.db"),
      undefined,
      (ticketId) => {
        hook(ticketId);
        budget.reset(ticketId);
      },
    );

    // One genuine dispatch opens the phase (fires the hook → resets budget once).
    tracker.recordDispatch(AGENT, TICKET);
    expect(hook).toHaveBeenCalledTimes(1);

    // The no-activity loop consumes the budget WITHOUT recordDispatch (it uses
    // markResignaled + budget.consume). The seal must still be reached.
    budget.consume(KEY); // 1
    budget.consume(KEY); // 2
    budget.consume(KEY); // 3
    expect(budget.isCapped(KEY)).toBe(true);
    // The re-arm keyed on a real dispatch, not on every wake — hook fired once.
    expect(hook).toHaveBeenCalledTimes(1);

    budget.close();
    tracker.close();
  });
});
