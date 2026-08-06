/**
 * INF-1295: Redispatch loop suppression tests.
 *
 * Verifies that:
 * 1. DispatchAckTracker.isEscalated() correctly identifies escalated entries.
 * 2. resignalPendingTickets skips dispatch for escalated (agent, ticket) pairs.
 * 3. Escalated entries are NOT re-dispatched even when otherwise actionable.
 * 4. Non-escalated entries still dispatch normally.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import { resignalPendingTickets, type ResignalOptions } from "./bag/resignal.js";
import { PendingWorkBag } from "./bag/pending-work-bag.js";
import { SessionTracker } from "./bag/session-tracker.js";
import type { WakeUpConfig } from "./bag/wake-up.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1295-test-"));
  return path.join(dir, "test.db");
}

function makeWakeConfig(): WakeUpConfig {
  return {
    hooksUrl: "http://localhost:9999/hooks",
    hooksToken: "test-token",
    signalTemplate: "test {{ticketIds}}",
  };
}

// ── DispatchAckTracker.isEscalated ──────────────────────────────────────────

describe("DispatchAckTracker.isEscalated", () => {
  let dbPath: string;
  let tracker: DispatchAckTracker;

  beforeEach(() => {
    dbPath = tmpDb();
    tracker = new DispatchAckTracker(dbPath);
  });

  afterEach(() => {
    tracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("returns false for a pending dispatch", () => {
    tracker.recordDispatch("agent-a", "linear-INF-100");
    expect(tracker.isEscalated("agent-a", "linear-INF-100")).toBe(false);
  });

  it("returns true after markEscalated", () => {
    tracker.recordDispatch("agent-a", "linear-INF-100");
    tracker.markEscalated("agent-a", "linear-INF-100");
    expect(tracker.isEscalated("agent-a", "linear-INF-100")).toBe(true);
  });

  it("returns false for a different agent", () => {
    tracker.recordDispatch("agent-a", "linear-INF-100");
    tracker.markEscalated("agent-a", "linear-INF-100");
    expect(tracker.isEscalated("agent-b", "linear-INF-100")).toBe(false);
  });

  it("returns false for a different ticket", () => {
    tracker.recordDispatch("agent-a", "linear-INF-100");
    tracker.markEscalated("agent-a", "linear-INF-100");
    expect(tracker.isEscalated("agent-a", "linear-INF-200")).toBe(false);
  });

  it("returns false for unknown entries", () => {
    expect(tracker.isEscalated("agent-x", "linear-UNK-1")).toBe(false);
  });

  it("normalizes session keys before checking", () => {
    tracker.recordDispatch("agent-a", "INF-100");
    tracker.markEscalated("agent-a", "INF-100");
    // linear-INF-100 and INF-100 should normalize to the same key
    expect(tracker.isEscalated("agent-a", "linear-INF-100")).toBe(true);
  });
});

// ── resignalPendingTickets escalation suppression ───────────────────────────

describe("resignalPendingTickets — escalation suppression (INF-1295)", () => {
  let dbPath: string;
  let ackTracker: DispatchAckTracker;
  let bag: PendingWorkBag;
  let sessionTracker: SessionTracker;
  let dispatchedTickets: string[];

  const wakeConfig = makeWakeConfig();

  beforeEach(() => {
    dbPath = tmpDb();
    ackTracker = new DispatchAckTracker(dbPath);
    bag = new PendingWorkBag(":memory:");
    sessionTracker = new SessionTracker({ staleTimeoutMs: 60_000 });
    dispatchedTickets = [];
  });

  afterEach(() => {
    ackTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  function makeOptions(overrides: Partial<ResignalOptions> = {}): ResignalOptions {
    return {
      markActive: true,
      ackTracker,
      isTicketActionable: () => true,
      sendWakeUp: async (agentId, ticketIds) => {
        dispatchedTickets.push(...ticketIds);
      },
      ...overrides,
    };
  }

  it("suppresses dispatch for escalated (agent, ticket)", async () => {
    // Record and escalate a dispatch
    ackTracker.recordDispatch("agent-a", "linear-INF-100");
    ackTracker.markEscalated("agent-a", "linear-INF-100");

    bag.add("agent-a", "linear-INF-100", "Issue");
    const results = await resignalPendingTickets(
      "agent-a",
      ["linear-INF-100"],
      bag,
      sessionTracker,
      wakeConfig,
      makeOptions(),
    );

    expect(results).toHaveLength(1);
    expect(results[0].dispatched).toBe(false);
    expect(dispatchedTickets).toHaveLength(0);
  });

  it("dispatches non-escalated tickets normally", async () => {
    ackTracker.recordDispatch("agent-a", "linear-INF-100");
    // NOT escalated — still pending

    bag.add("agent-a", "linear-INF-100", "Issue");
    const results = await resignalPendingTickets(
      "agent-a",
      ["linear-INF-100"],
      bag,
      sessionTracker,
      wakeConfig,
      makeOptions(),
    );

    expect(results).toHaveLength(1);
    expect(results[0].dispatched).toBe(true);
    expect(dispatchedTickets).toContain("linear-INF-100");
  });

  it("suppresses only the escalated ticket in a mixed batch", async () => {
    ackTracker.recordDispatch("agent-a", "linear-INF-100");
    ackTracker.markEscalated("agent-a", "linear-INF-100");
    ackTracker.recordDispatch("agent-a", "linear-INF-200");
    // INF-200 is NOT escalated

    bag.add("agent-a", "linear-INF-100", "Issue");
    bag.add("agent-a", "linear-INF-200", "Issue");

    const results = await resignalPendingTickets(
      "agent-a",
      ["linear-INF-100", "linear-INF-200"],
      bag,
      sessionTracker,
      wakeConfig,
      makeOptions(),
    );

    expect(results).toHaveLength(2);
    const escalated = results.find((r) => r.ticketId === "linear-INF-100");
    const normal = results.find((r) => r.ticketId === "linear-INF-200");
    expect(escalated?.dispatched).toBe(false);
    expect(normal?.dispatched).toBe(true);
    expect(dispatchedTickets).toContain("linear-INF-200");
    expect(dispatchedTickets).not.toContain("linear-INF-100");
  });

  it("works without ackTracker (backward compatible)", async () => {
    bag.add("agent-a", "linear-INF-100", "Issue");
    const results = await resignalPendingTickets(
      "agent-a",
      ["linear-INF-100"],
      bag,
      sessionTracker,
      wakeConfig,
      makeOptions({ ackTracker: undefined }),
    );

    expect(results).toHaveLength(1);
    expect(results[0].dispatched).toBe(true);
  });

  it("does not claim a session slot for suppressed dispatches", async () => {
    ackTracker.recordDispatch("agent-a", "linear-INF-100");
    ackTracker.markEscalated("agent-a", "linear-INF-100");

    bag.add("agent-a", "linear-INF-100", "Issue");
    await resignalPendingTickets(
      "agent-a",
      ["linear-INF-100"],
      bag,
      sessionTracker,
      wakeConfig,
      makeOptions(),
    );

    // Session should NOT be active — the dispatch was suppressed before claiming
    expect(sessionTracker.isActiveForTicket("agent-a", "linear-INF-100")).toBe(false);
  });
});
