/**
 * AI-2474 — `delivery-pending-ack` dispatches must appear on the admin
 * console's per-ticket dispatch timeline.
 *
 * AI-2437 added the `delivery-pending-ack` outcome (connection established,
 * wake queued, ack expectation registered, response never confirmed). The
 * AI-2008 AC4 timeline in admin.ts filters on `e.outcome in DISPATCH_STATUS`,
 * so an outcome absent from that map is dropped *entirely* — an operator
 * debugging a mid-turn wake sees a gap where a real dispatch happened.
 *
 * This is the stale-matcher defect class: adding an enum value leaves readers
 * behind. Same shape as AI-2464, different subsystem.
 *
 * AC mapping:
 *   AC1 — pending-ack appears with a status distinct from delivered/failure.
 *   AC2 — regression: a timeline built from a store containing a
 *         `delivery-pending-ack` event includes that event.
 *   AC3 — presentation only: no delivery behavior change.
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";

const ADMIN_SECRET = "ai-2474-test-secret";

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-2474-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

interface TimelineEntry {
  status: string;
  outcome: string;
  attempt: number | null;
  dispatch_id: string | null;
  delegate: string | null;
  timestamp: string;
}

describe("AI-2474 — delivery-pending-ack on the per-ticket dispatch timeline", () => {
  let app: ReturnType<typeof createApp>;
  let eventsDbPath: string;
  let mirrorDbPath: string;

  beforeEach(() => {
    eventsDbPath = tmpDbPath("events");
    mirrorDbPath = tmpDbPath("mirror");
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    app = createApp({
      operationalEventsDbPath: eventsDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
    });
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    (app.operationalEventStore as unknown as { close?: () => void }).close?.();
    fs.rmSync(path.dirname(eventsDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(mirrorDbPath), { recursive: true, force: true });
  });

  async function timelineFor(ticketId: string): Promise<TimelineEntry[]> {
    const res = await request(app.app)
      .get(`/admin/api/board/ticket/${ticketId}`)
      .set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    return res.body.dispatch_timeline as TimelineEntry[];
  }

  it("AC1/AC2: a delivery-pending-ack event appears on the timeline", async () => {
    app.enrolledTicketsStore.enroll({
      ticketId: "AI-9400",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "igor",
    });
    const key = "linear-AI-9400";
    app.operationalEventStore.append({
      outcome: "delivery-pending-ack",
      agent: "igor",
      key,
      sessionKey: key,
      wakeId: "wake-9400-abc",
      attemptCount: 1,
    });

    const timeline = await timelineFor("AI-9400");
    const pending = timeline.filter((d) => d.outcome === "delivery-pending-ack");
    expect(pending).toHaveLength(1);
  });

  it("AC1: its status is distinct from delivered and from every failure status", async () => {
    app.enrolledTicketsStore.enroll({
      ticketId: "AI-9401",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "igor",
    });
    const key = "linear-AI-9401";
    app.operationalEventStore.append({
      outcome: "delivery-pending-ack",
      agent: "igor",
      key,
      sessionKey: key,
      wakeId: "wake-9401-abc",
      attemptCount: 1,
    });

    const [entry] = await timelineFor("AI-9401");
    expect(entry).toBeDefined();
    // Not folded into an existing bucket: the connection was established and an
    // ack expectation registered, but the response was never confirmed. It is
    // neither a success nor a failure, and calling it "retrying" would be a lie
    // (post-AI-2437 this path does not retry).
    expect(entry.status).not.toBe("delivered");
    expect(entry.status).not.toBe("failed");
    expect(entry.status).not.toBe("undeliverable");
    expect(entry.status).not.toBe("retrying");
    expect(entry.status).toBe("pending-ack");
  });

  it("AC2: pending-ack carries the same projected fields as any other dispatch", async () => {
    app.enrolledTicketsStore.enroll({
      ticketId: "AI-9402",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "igor",
    });
    const key = "linear-AI-9402";
    app.operationalEventStore.append({
      outcome: "delivery-pending-ack",
      agent: "igor",
      key,
      sessionKey: key,
      wakeId: "wake-9402-xyz",
      attemptCount: 2,
    });

    const [entry] = await timelineFor("AI-9402");
    expect(entry).toBeDefined();
    // The projection must not special-case pending-ack into a degraded shape —
    // an operator correlating a wake needs the dispatch id and attempt count.
    expect(entry.dispatch_id).toBe("wake-9402-xyz");
    expect(entry.attempt).toBe(2);
    expect(entry.delegate).toBe("igor");
    expect(typeof entry.timestamp).toBe("string");
  });

  it("AC1: pending-ack interleaves in dispatch order with other outcomes", async () => {
    app.enrolledTicketsStore.enroll({
      ticketId: "AI-9403",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "igor",
    });
    const key = "linear-AI-9403";
    const wakeId = "wake-9403-abc";
    // A realistic mid-turn wake: queued pending ack, watchdog never confirmed,
    // re-signal, then landed. The pending-ack must not be the missing first beat.
    app.operationalEventStore.append({ outcome: "delivery-pending-ack", agent: "igor", key, sessionKey: key, wakeId, attemptCount: 1, occurredAt: "2026-07-16T08:00:00.000Z" });
    app.operationalEventStore.append({ outcome: "delivery-unconfirmed", agent: "igor", key, sessionKey: key, wakeId, attemptCount: 2, occurredAt: "2026-07-16T08:00:10.000Z" });
    app.operationalEventStore.append({ outcome: "delivered", agent: "igor", key, sessionKey: key, wakeId, attemptCount: 3, occurredAt: "2026-07-16T08:00:20.000Z" });

    const timeline = await timelineFor("AI-9403");
    expect(timeline.map((d) => d.status)).toEqual(["pending-ack", "retrying", "delivered"]);
  });

  it("AC3: the existing AI-2008 statuses are unchanged", async () => {
    app.enrolledTicketsStore.enroll({
      ticketId: "AI-9404",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "igor",
    });
    const key = "linear-AI-9404";
    const wakeId = "wake-9404-abc";
    app.operationalEventStore.append({ outcome: "delivery-failed", agent: "igor", key, sessionKey: key, wakeId, attemptCount: 1, occurredAt: "2026-07-16T08:00:00.000Z" });
    app.operationalEventStore.append({ outcome: "delivery-unconfirmed", agent: "igor", key, sessionKey: key, wakeId, attemptCount: 2, occurredAt: "2026-07-16T08:00:10.000Z" });
    app.operationalEventStore.append({ outcome: "dispatch-undeliverable", agent: "igor", key, sessionKey: key, wakeId, attemptCount: 3, occurredAt: "2026-07-16T08:00:20.000Z" });
    app.operationalEventStore.append({ outcome: "delivered", agent: "igor", key, sessionKey: key, wakeId, attemptCount: 4, occurredAt: "2026-07-16T08:00:30.000Z" });

    const timeline = await timelineFor("AI-9404");
    expect(timeline.map((d) => d.status)).toEqual(["failed", "retrying", "undeliverable", "delivered"]);
  });

  it("AC3: non-dispatch outcomes are still excluded from the timeline", async () => {
    app.enrolledTicketsStore.enroll({
      ticketId: "AI-9405",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "igor",
    });
    const key = "linear-AI-9405";
    // Widening the map must not turn the timeline into a firehose of every
    // event on the ticket — it is a *dispatch* timeline.
    app.operationalEventStore.append({ outcome: "engagement-thinking", agent: "igor", key, sessionKey: key });
    app.operationalEventStore.append({ outcome: "routed", agent: "igor", key, sessionKey: key });
    app.operationalEventStore.append({ outcome: "delivery-pending-ack", agent: "igor", key, sessionKey: key, wakeId: "wake-9405", attemptCount: 1 });

    const timeline = await timelineFor("AI-9405");
    expect(timeline.map((d) => d.outcome)).toEqual(["delivery-pending-ack"]);
  });
});
