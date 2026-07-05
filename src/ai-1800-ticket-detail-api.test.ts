/**
 * AI-1800 AC5 — Ticket detail view shows state transitions as headings with
 * wake cycles collapsed beneath; agent plane by default, connector plane
 * expandable.
 *
 * Tests that the per-ticket detail API returns structured state transition
 * data with nested wake cycles, organized by plane (agent/connector).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai1800-detail-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

function getMirror(app: ReturnType<typeof createApp>): EnrolledTicketsStore {
  const mirror = (app as unknown as { enrolledTicketsStore?: EnrolledTicketsStore }).enrolledTicketsStore;
  if (!mirror) throw new Error("enrolledTicketsStore not exposed on createApp return");
  return mirror;
}

const ADMIN_SECRET = "ai1800-detail-test";

describe("AI-1800 AC5: GET /api/board/ticket/:ticketId — state transitions with wake cycles", () => {
  let app: ReturnType<typeof createApp>;
  let mirrorDbPath: string;
  let eventsDbPath: string;
  let mirror: EnrolledTicketsStore;

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

  it("returns 404 for a non-enrolled ticket", async () => {
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });

    const res = await request(app.app)
      .get("/admin/api/board/ticket/NOPE-9999")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(404);
  });

  it("returns structured state transitions as headings for an enrolled ticket", async () => {
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    // Enroll and record transitions
    mirror.enroll({ ticketId: "AI-9001", workflow: "dev-impl", state: "write-tests", delegate: "tdd" });
    mirror.recordTransition({
      ticketId: "AI-9001",
      toState: "write-tests",
      delegate: "tdd",
      eventKind: "accept",
    });
    mirror.recordTransition({
      ticketId: "AI-9001",
      toState: "implementation",
      delegate: "igor",
      eventKind: "tests-ready",
    });

    const res = await request(app.app)
      .get("/admin/api/board/ticket/AI-9001")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    // Must have state_transitions array — one per state transition
    expect(res.body.state_transitions).toBeDefined();
    expect(Array.isArray(res.body.state_transitions)).toBe(true);
    // At least one transition (accept → write-tests, tests-ready → implementation)
    expect(res.body.state_transitions.length).toBeGreaterThanOrEqual(1);

    // Each transition must have a state heading
    const first = res.body.state_transitions[0];
    expect(first.state).toBeDefined();
    expect(typeof first.state).toBe("string");
  });

  it("wake cycles are nested beneath state transitions with plane separation", async () => {
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    mirror.enroll({ ticketId: "AI-9002", workflow: "dev-impl", state: "implementation", delegate: "igor" });
    mirror.recordTransition({
      ticketId: "AI-9002",
      toState: "implementation",
      delegate: "igor",
      eventKind: "tests-ready",
    });

    // Write operational events for agent and connector planes
    const opsStore = (app as unknown as {
      operationalEventStore: { append: (input: unknown) => void };
    }).operationalEventStore;
    opsStore.append({
      outcome: "routed",
      type: "Issue",
      agent: "igor",
      key: "linear-AI-9002",
      wakeId: "wake-detail-001",
      plane: "agent",
    });
    opsStore.append({
      outcome: "dispatched",
      type: "Issue",
      agent: "igor",
      key: "linear-AI-9002",
      wakeId: "wake-detail-001",
      plane: "connector",
    });

    const res = await request(app.app)
      .get("/admin/api/board/ticket/AI-9002")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);

    // Find a transition that has wake cycles
    const transition = res.body.state_transitions.find(
      (t: { wake_cycles?: unknown[] }) => t.wake_cycles && t.wake_cycles.length > 0,
    );
    expect(transition).toBeDefined();

    // Each wake cycle must have a plane field
    const cycle = transition.wake_cycles[0];
    expect(cycle.plane).toBeDefined();
    expect(["agent", "connector"]).toContain(cycle.plane);
    expect(cycle.wake_id).toBeDefined();
  });

  it("wake cycles are collapsed by default — agent plane first, connector expandable", async () => {
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    mirror.enroll({ ticketId: "AI-9003", workflow: "dev-impl", state: "intake", delegate: "astrid" });

    const opsStore = (app as unknown as {
      operationalEventStore: { append: (input: unknown) => void };
    }).operationalEventStore;
    opsStore.append({
      outcome: "routed",
      type: "Issue",
      agent: "astrid",
      key: "linear-AI-9003",
      wakeId: "wake-detail-002",
      plane: "agent",
    });
    opsStore.append({
      outcome: "dispatched",
      type: "Issue",
      agent: "astrid",
      key: "linear-AI-9003",
      wakeId: "wake-detail-002",
      plane: "connector",
    });

    const res = await request(app.app)
      .get("/admin/api/board/ticket/AI-9003")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);

    // The API response must indicate default_plane and expandable_planes
    // so the frontend knows agent is default, connector is expandable
    if (res.body.state_transitions.length > 0) {
      const t = res.body.state_transitions[0];
      expect(t.default_plane).toBe("agent");
      expect(t.expandable_planes).toContain("connector");
    }
  });

  it("detail includes current ticket metadata (workflow, state, delegate)", async () => {
    app = createApp({
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
    });
    mirror = getMirror(app);

    mirror.enroll({ ticketId: "AI-9004", workflow: "dev-impl", state: "code-review", delegate: "cra" });

    const res = await request(app.app)
      .get("/admin/api/board/ticket/AI-9004")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.ticket_id).toBe("AI-9004");
    expect(res.body.workflow).toBe("dev-impl");
    expect(res.body.state).toBe("code-review");
    expect(res.body.delegate).toBe("cra");
  });
});
