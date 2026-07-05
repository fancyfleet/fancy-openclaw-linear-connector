/**
 * AI-1800 AC2 — Cards show delegate, time-in-state with SLA coloring,
 * and last event as prose; data sourced from the D1 read API only.
 *
 * Tests that the board API response includes per-ticket SLA threshold data
 * (sla_ms) so the frontend can compute coloring: neutral <50%, amber at 80%,
 * red past breach. Also verifies delegate, time_in_state_ms, and last event
 * prose fields are present and sourced from the read API (no direct store reads
 * from the frontend).
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createApp } from "./index.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";
import { resetWorkflowCache } from "./workflow-gate.js";

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai1800-card-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

function getMirror(app: ReturnType<typeof createApp>): EnrolledTicketsStore {
  const mirror = (app as unknown as { enrolledTicketsStore?: EnrolledTicketsStore }).enrolledTicketsStore;
  if (!mirror) throw new Error("enrolledTicketsStore not exposed on createApp return");
  return mirror;
}

const ADMIN_SECRET = "ai1800-card-test";

describe("AI-1800 AC2: GET /api/board — card data for SLA coloring and delegate display", () => {
  let app: ReturnType<typeof createApp>;
  let mirrorDbPath: string;
  let eventsDbPath: string;
  let mirror: EnrolledTicketsStore;

  beforeEach(() => {
    resetWorkflowCache();
    mirrorDbPath = tmpDbPath("mirror");
    eventsDbPath = tmpDbPath("events");
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    // Use canonical fixtures so SLA thresholds are available
    process.env.WORKFLOW_DEFS_DIR = path.resolve(__dirname, "__fixtures__");
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    resetWorkflowCache();
    fs.rmSync(path.dirname(mirrorDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(eventsDbPath), { recursive: true, force: true });
  });

  it("board ticket includes sla_ms for SLA threshold computation", async () => {
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    // write-tests has sla: 48h in dev-impl.yaml
    mirror.enroll({
      ticketId: "AI-7001",
      workflow: "dev-impl",
      state: "write-tests",
      delegate: "tdd",
    });

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-7001");
    expect(ticket).toBeDefined();
    expect(ticket.sla_ms).toBeDefined();
    // write-tests sla: 48h = 48 * 60 * 60 * 1000 = 172800000ms
    expect(ticket.sla_ms).toBe(172800000);
  });

  it("each ticket includes delegate for card display", async () => {
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    mirror.enroll({
      ticketId: "AI-7002",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "igor",
    });

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-7002");
    expect(ticket).toBeDefined();
    expect(ticket.delegate).toBe("igor");
  });

  it("ticket includes time_in_state_ms for SLA coloring computation", async () => {
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    mirror.enroll({
      ticketId: "AI-7003",
      workflow: "dev-impl",
      state: "code-review",
      delegate: "cra",
    });

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-7003");
    expect(ticket).toBeDefined();
    expect(typeof ticket.time_in_state_ms).toBe("number");
    expect(ticket.time_in_state_ms).toBeGreaterThanOrEqual(0);
  });

  it("last event is returned as rendered prose (last_event_prose field)", async () => {
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    mirror.enroll({
      ticketId: "AI-7004",
      workflow: "dev-impl",
      state: "write-tests",
      delegate: "tdd",
    });
    // Record a transition to generate a last event
    mirror.recordTransition({
      ticketId: "AI-7004",
      toState: "write-tests",
      delegate: "tdd",
      eventKind: "accept",
    });

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-7004");
    expect(ticket).toBeDefined();
    // Frontend needs a prose field for card rendering
    expect(ticket.last_event_prose).toBeDefined();
    // Must be a non-empty string — prose rendering, not a raw event kind
    expect(typeof ticket.last_event_prose).toBe("string");
    expect(ticket.last_event_prose.length).toBeGreaterThan(0);
  });

  it("sla_ms is undefined for states without an SLA declaration", async () => {
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    // intake state in dev-impl.yaml has no sla declaration
    mirror.enroll({
      ticketId: "AI-7005",
      workflow: "dev-impl",
      state: "intake",
      delegate: "astrid",
    });

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-7005");
    expect(ticket).toBeDefined();
    // States without SLA should have sla_ms as null or undefined
    expect(ticket.sla_ms).toBeFalsy();
  });

  it("all card data fields come from the read API — no additional fetches needed", async () => {
    // This is a structural test: the single GET /api/board response must
    // contain everything the frontend needs to render a card.
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    mirror.enroll({
      ticketId: "AI-7006",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "sage",
    });

    const res = await request(app.app)
      .get("/admin/api/board")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    const ticket = res.body.tickets.find((t: { ticket_id: string }) => t.ticket_id === "AI-7006");
    expect(ticket).toBeDefined();
    // All fields needed for card rendering must be present:
    expect(ticket.ticket_id).toBe("AI-7006");
    expect(ticket.workflow).toBe("dev-impl");
    expect(ticket.state).toBe("implementation");
    expect(ticket.delegate).toBe("sage");
    expect(ticket.time_in_state_ms).toBeDefined();
    expect(ticket.last_event_prose).toBeDefined();
    // sla_ms should be present (implementation has sla: 72h)
    expect(ticket.sla_ms).toBeDefined();
  });
});
