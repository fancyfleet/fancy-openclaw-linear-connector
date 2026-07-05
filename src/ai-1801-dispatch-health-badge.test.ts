/**
 * AI-1801 AC1 — Dispatch-health badge: six states reachable and covered by
 * test fixtures. Backend integration test verifying the /api/board response
 * includes dispatch_health for each badge state.
 *
 * Also unit-tests computeDispatchHealth directly for each state.
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createApp } from "./index.js";
import { computeDispatchHealth } from "./dispatch-health.js";
import { OperationalEventStore, type OperationalEvent } from "./store/operational-event-store.js";
import type { DispatchAckEntry } from "./bag/dispatch-ack-tracker.js";
import { resetWorkflowCache } from "./workflow-gate.js";

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai1801-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

const ADMIN_SECRET = "ai1801-test";
const NOW = new Date("2026-07-05T21:00:00Z").getTime();
const FIXED_NOW = new Date("2026-07-05T21:00:00Z");

function makeEvent(overrides: Partial<OperationalEvent>): OperationalEvent {
  return {
    id: overrides.id ?? 1,
    occurredAt: overrides.occurredAt ?? FIXED_NOW.toISOString(),
    outcome: overrides.outcome ?? "dispatched",
    type: overrides.type ?? null,
    agent: overrides.agent ?? "sage",
    key: overrides.key ?? "linear-AI-9001",
    deliveryMode: overrides.deliveryMode ?? null,
    attemptCount: overrides.attemptCount ?? null,
    runId: overrides.runId ?? null,
    sessionKey: overrides.sessionKey ?? null,
    errorSummary: overrides.errorSummary ?? null,
    detail: overrides.detail ?? {},
    workflowState: overrides.workflowState ?? null,
    plane: overrides.plane ?? null,
    wakeId: overrides.wakeId ?? "wake-test-1",
  };
}

function makeAck(overrides: Partial<DispatchAckEntry>): DispatchAckEntry {
  return {
    id: overrides.id ?? 1,
    agentId: overrides.agentId ?? "sage",
    ticketId: overrides.ticketId ?? "linear-AI-9001",
    dispatchedAt: overrides.dispatchedAt ?? FIXED_NOW.toISOString(),
    lastSignalAt: overrides.lastSignalAt ?? FIXED_NOW.toISOString(),
    ackStatus: overrides.ackStatus ?? "pending",
    attemptCount: overrides.attemptCount ?? 1,
  };
}

describe("AI-1801 AC1: computeDispatchHealth — unit tests for all six badge states", () => {
  it("working: recent engagement event within threshold", () => {
    const events = [
      makeEvent({ outcome: "engagement-doing", occurredAt: new Date(NOW - 60_000).toISOString() }),
    ];
    const result = computeDispatchHealth(events, makeAck({}), { now: NOW });
    expect(result.badge).toBe("working");
    expect(result.attempt).toBeNull();
  });

  it("quiet: dispatch accepted, no engagement, within grace", () => {
    const events = [
      makeEvent({ outcome: "dispatch-accepted", occurredAt: new Date(NOW - 30_000).toISOString() }),
    ];
    const ack = makeAck({
      ackStatus: "pending",
      attemptCount: 1,
      lastSignalAt: new Date(NOW - 30_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""),
    });
    const result = computeDispatchHealth(events, ack, { now: NOW });
    expect(result.badge).toBe("quiet");
  });

  it("unconfirmed: delivery-unconfirmed event with attempt N/3", () => {
    const events = [
      makeEvent({
        outcome: "delivery-unconfirmed",
        occurredAt: new Date(NOW - 60_000).toISOString(),
        attemptCount: 2,
      }),
    ];
    const ack = makeAck({ ackStatus: "unconfirmed", attemptCount: 2 });
    const result = computeDispatchHealth(events, ack, { now: NOW });
    expect(result.badge).toBe("unconfirmed");
    expect(result.attempt).toBe(2);
    expect(result.maxAttempts).toBe(3);
  });

  it("exhausted: ack tracker escalated", () => {
    const events: OperationalEvent[] = [];
    const ack = makeAck({ ackStatus: "escalated", attemptCount: 4 });
    const result = computeDispatchHealth(events, ack, { now: NOW });
    expect(result.badge).toBe("exhausted");
    expect(result.attempt).toBe(4);
  });

  it("at-capacity: ack tracker deferred", () => {
    const events: OperationalEvent[] = [];
    const ack = makeAck({ ackStatus: "deferred", attemptCount: 1 });
    const result = computeDispatchHealth(events, ack, { now: NOW });
    expect(result.badge).toBe("at-capacity");
  });

  it("at-capacity: recent deferred-at-capacity event without rearm", () => {
    const events = [
      makeEvent({
        outcome: "deferred-at-capacity",
        occurredAt: new Date(NOW - 30_000).toISOString(),
        attemptCount: 1,
      }),
    ];
    const ack = makeAck({ ackStatus: "pending", attemptCount: 1 });
    const result = computeDispatchHealth(events, ack, { now: NOW });
    expect(result.badge).toBe("at-capacity");
  });

  it("idle: no events, no ack entry", () => {
    const result = computeDispatchHealth([], null, { now: NOW });
    expect(result.badge).toBe("idle");
    expect(result.attempt).toBeNull();
  });
});

describe("AI-1801 AC2: unconfirmed shows attempt N/3 from watchdog re-signal", () => {
  it("attempt 1 of 3", () => {
    const events = [
      makeEvent({
        outcome: "watchdog-resignal",
        occurredAt: new Date(NOW - 10_000).toISOString(),
        attemptCount: 1,
      }),
    ];
    const ack = makeAck({ ackStatus: "unconfirmed", attemptCount: 1 });
    const result = computeDispatchHealth(events, ack, { now: NOW });
    expect(result.badge).toBe("unconfirmed");
    expect(result.attempt).toBe(1);
    expect(result.maxAttempts).toBe(3);
  });

  it("attempt 3 of 3 — still unconfirmed, not yet exhausted", () => {
    const events = [
      makeEvent({
        outcome: "watchdog-resignal",
        occurredAt: new Date(NOW - 10_000).toISOString(),
        attemptCount: 3,
      }),
    ];
    const ack = makeAck({ ackStatus: "unconfirmed", attemptCount: 3 });
    const result = computeDispatchHealth(events, ack, { now: NOW });
    expect(result.badge).toBe("unconfirmed");
    expect(result.attempt).toBe(3);
  });

  it("attempt 4 of 3 → exhausted", () => {
    const events = [
      makeEvent({
        outcome: "delivery-unconfirmed",
        occurredAt: new Date(NOW - 10_000).toISOString(),
        attemptCount: 4,
      }),
    ];
    const ack = makeAck({ ackStatus: "unconfirmed", attemptCount: 4 });
    const result = computeDispatchHealth(events, ack, { now: NOW });
    expect(result.badge).toBe("exhausted");
  });
});

describe("AI-1801 AC1: GET /api/board — dispatch_health field integration", () => {
  let mirrorDbPath: string;
  let eventsDbPath: string;

  beforeEach(() => {
    resetWorkflowCache();
    mirrorDbPath = tmpDbPath("mirror");
    eventsDbPath = tmpDbPath("events");
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.WORKFLOW_DEFS_DIR = path.resolve(__dirname, "__fixtures__");
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    resetWorkflowCache();
    fs.rmSync(path.dirname(mirrorDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(eventsDbPath), { recursive: true, force: true });
  });

  it("board ticket includes dispatch_health object with badge field", async () => {
    const app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });

    // Access the mirror to enroll a ticket
    const mirror = (app as unknown as { enrolledTicketsStore: { enroll: (args: Record<string, string>) => void } }).enrolledTicketsStore;
    mirror.enroll({
      ticketId: "AI-9001",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "sage",
    });

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-9001");
    expect(ticket).toBeDefined();
    expect(ticket.dispatch_health).toBeDefined();
    expect(ticket.dispatch_health.badge).toBeDefined();
    // No ack entry and no events → idle
    expect(ticket.dispatch_health.badge).toBe("idle");
  });

  it("working badge appears when engagement event recorded", async () => {
    const app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });

    const mirror = (app as unknown as { enrolledTicketsStore: { enroll: (args: Record<string, string>) => void } }).enrolledTicketsStore;
    const opStore = app.operationalEventStore as OperationalEventStore;

    mirror.enroll({
      ticketId: "AI-9002",
      workflow: "dev-impl",
      state: "write-tests",
      delegate: "tdd",
    });
    opStore.append({
      outcome: "engagement-doing",
      agent: "tdd",
      key: "linear-AI-9002",
      sessionKey: "linear-AI-9002",
      wakeId: "wake-eng-1",
    });

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-9002");
    expect(ticket.dispatch_health.badge).toBe("working");
  });

  it("unconfirmed badge shows attempt N/3", async () => {
    const app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });

    const mirror = (app as unknown as { enrolledTicketsStore: { enroll: (args: Record<string, string>) => void } }).enrolledTicketsStore;
    const opStore = app.operationalEventStore as OperationalEventStore;

    mirror.enroll({
      ticketId: "AI-9003",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "igor",
    });
    // Record a dispatch + unconfirmed delivery
    opStore.append({
      outcome: "dispatched",
      agent: "igor",
      key: "linear-AI-9003",
      sessionKey: "linear-AI-9003",
      wakeId: "wake-unconf-1",
    });
    opStore.append({
      outcome: "delivery-unconfirmed",
      agent: "igor",
      key: "linear-AI-9003",
      sessionKey: "linear-AI-9003",
      attemptCount: 2,
      wakeId: "wake-unconf-1",
    });

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-9003");
    expect(ticket.dispatch_health.badge).toBe("unconfirmed");
    expect(ticket.dispatch_health.attempt).toBe(2);
    expect(ticket.dispatch_health.maxAttempts).toBe(3);
  });
});
