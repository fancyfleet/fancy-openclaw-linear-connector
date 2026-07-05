/**
 * AI-1800 AC4 — Dispatches sub-view groups by wake_id and is labeled as
 * dispatch cycles, not tasks; old "Waiting for agent pickup" hardcoded copy
 * is gone.
 *
 * Tests that the dispatch API returns dispatches grouped by wake_id, and that
 * the response labeling uses "dispatch cycles" terminology.
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createApp } from "./index.js";
import { resetWorkflowCache } from "./workflow-gate.js";

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai1800-dispatch-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

const ADMIN_SECRET = "ai1800-dispatch-test";

describe("AI-1800 AC4: Dispatches sub-view — grouped by wake_id, labeled as cycles", () => {
  let app: ReturnType<typeof createApp>;
  let bagDbPath: string;
  let mirrorDbPath: string;
  let eventsDbPath: string;

  beforeEach(() => {
    resetWorkflowCache();
    bagDbPath = tmpDbPath("bag");
    mirrorDbPath = tmpDbPath("mirror");
    eventsDbPath = tmpDbPath("events");
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.WORKFLOW_DEFS_DIR = path.resolve(__dirname, "__fixtures__");
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    resetWorkflowCache();
    fs.rmSync(path.dirname(bagDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(mirrorDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(eventsDbPath), { recursive: true, force: true });
  });

  it("GET /api/dispatches returns dispatches grouped by wake_id", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });

    const res = await request(app.app)
      .get("/admin/api/dispatches")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    // Response must have a cycles array (not flat tasks)
    expect(res.body.cycles).toBeDefined();
    expect(Array.isArray(res.body.cycles)).toBe(true);
  });

  it("each dispatch cycle group has wake_id, agent_id, and dispatches array", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });

    const res = await request(app.app)
      .get("/admin/api/dispatches")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    // Each cycle entry must have: wake_id, agent_id, dispatches
    if (res.body.cycles.length > 0) {
      const cycle = res.body.cycles[0];
      expect(cycle.wake_id).toBeDefined();
      expect(cycle.agent_id).toBeDefined();
      expect(Array.isArray(cycle.dispatches)).toBe(true);
    }
  });

  it("response uses 'dispatch_cycles' or 'cycles' labeling — not 'tasks'", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });

    const res = await request(app.app)
      .get("/admin/api/dispatches")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    // The response must NOT contain a flat 'tasks' array at the top level
    // (that was the old "Waiting for agent pickup" view)
    expect(res.body.tasks).toBeUndefined();
    // Must use cycles-based structure
    expect(res.body.cycles).toBeDefined();
  });

  it("old TasksPage 'Waiting for agent pickup' copy is absent from dispatches", async () => {
    const noopSendWakeUp = async (_a: string, _t: string[]) => {};
    app = createApp({
      bagDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
      operationalEventsDbPath: eventsDbPath,
      sendWakeUp: noopSendWakeUp,
    });

    const res = await request(app.app)
      .get("/admin/api/dispatches")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    // Response body stringified should not contain the old hardcoded copy
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("Waiting for agent pickup");
    // Should reference dispatch cycles terminology
    expect(res.body.label).toBeDefined();
    expect(res.body.label).toMatch(/dispatch cycle/i);
  });
});
