/**
 * AI-1479 (Phase 6.5 / H-4) — Routing-functionary: live dispatch-path
 * registration + /health liveness.
 *
 * FAILING integration suite (TDD, write-tests state). These two ACs are the
 * ones a pure resolveRoute() unit test explicitly does NOT satisfy — they must
 * be proven through the live dispatch path and the production entry point.
 *
 * AC coverage map (AC of record captured by astrid 2026-07-09T23:04:51):
 *   AC4 — "The routing functionary is registered in the live dispatch path
 *          (routeEventAll(), reachable from the production entry point), proven
 *          by an integration test that exercises the production dispatch path
 *          and asserts the functionary resolved the route. A module-level unit
 *          test of resolveRoute() alone does NOT satisfy this."
 *          → describe("AC4 …") drives routeEventAll() — the exact symbol the
 *            production webhook handler invokes (src/webhook/index.ts) — and
 *            asserts a department-only event is resolved to the department route.
 *   AC5 — "Liveness is observable at ac-validate without waiting for a webhook
 *          to arrive: a /health field, startup log line, or registry entry
 *          showing the roster is loaded and the functionary is active in
 *          dispatch."
 *          → describe("AC5 …") boots createApp() (the production entry-point app
 *            factory) and asserts /health surfaces a routing-functionary liveness
 *            field showing the roster loaded + the functionary active.
 *
 * References the not-yet-existing ./department-roster.js, so the suite is RED
 * until the functionary is implemented and wired in.
 */

import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { routeEventAll } from "./router.js";
import { loadRoster, resetRosterCache } from "./department-roster.js";
import type { LinearEvent } from "./webhook/schema.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "routing-functionary-test-"));
}

function writeAgentsFile(dir: string, agents: unknown[]): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ agents }), "utf8");
  return file;
}

function writeRosterFile(dir: string): string {
  const file = path.join(dir, "department-roster.yaml");
  fs.writeFileSync(
    file,
    [
      "version: 1",
      "steward: astrid",
      "departments:",
      "  AI:",
      "    name: AI Team",
      "    defaultTarget: igor",
      "  ILL:",
      "    name: ILL Team",
      "    defaultTarget: sage",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

function mkAgent(name: string) {
  return {
    name,
    linearUserId: `user-${name}-12345678`,
    openclawAgent: name,
    clientId: `client-${name}`,
    clientSecret: `secret-${name}`,
    accessToken: `access-${name}`,
    refreshToken: `refresh-${name}`,
    host: "local" as const,
  };
}

// A department-only Issue event: an AI-prefixed ticket touched by a human, with
// NO delegate / assignee / mention. On main this produces zero routes; once the
// functionary is wired into routeEventAll it must route to the AI department
// default (igor).
function departmentOnlyEvent(): LinearEvent {
  return {
    type: "Issue",
    action: "update",
    actor: { id: "actor-human-matt", name: "Matt Henry" },
    createdAt: "2026-07-09T00:00:00.000Z",
    data: {
      id: "issue-ai-1234",
      identifier: "AI-1234",
      title: "Some backend ticket with no explicit owner",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 0,
      priorityLabel: "No priority",
      teamId: "team-ai",
      teamKey: "AI",
      labelIds: [],
      url: "https://linear.app/fancymatt/issue/AI-1234",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    },
    raw: {},
  } as unknown as LinearEvent;
}

const ROSTER_AGENTS = [
  mkAgent("igor"),
  mkAgent("sage"),
  mkAgent("charles"),
  mkAgent("astrid"),
];

// ── AC4 — functionary registered in the live dispatch path (routeEventAll) ────

describe("AC4 — the functionary is wired into the live dispatch path (routeEventAll)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir, ROSTER_AGENTS);
    process.env.DEPARTMENT_ROSTER_PATH = writeRosterFile(dir);
    reloadAgents();
    resetRosterCache();
    await loadRoster();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.DEPARTMENT_ROSTER_PATH;
    resetRosterCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("routeEventAll (the production dispatch function) resolves a department-only event to the department default (igor)", async () => {
    // routeEventAll is the exact symbol src/webhook/index.ts imports and calls
    // on every inbound webhook. Driving it here exercises the live dispatch path
    // — not a standalone resolveRoute() call.
    const routes = await routeEventAll(departmentOnlyEvent());
    expect(routes.length).toBeGreaterThanOrEqual(1);
    const primary = routes[0];
    expect(primary.agentId).toBe("igor");
    expect(primary.routingReason).toBe("department-prefix");
  });

  test("an explicit delegate is still honored through the live dispatch path (AC3 regression guard)", async () => {
    // Live-path proof that a mechanical route is not overridden by the
    // department-prefix match once the functionary is wired in.
    const event = departmentOnlyEvent();
    (event as unknown as { data: Record<string, unknown> }).data.delegateId =
      "user-charles-12345678";
    (event as unknown as { data: Record<string, unknown> }).data.delegate = {
      id: "user-charles-12345678",
      name: "Charles",
    };
    const routes = await routeEventAll(event);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes[0].agentId).toBe("charles");
    expect(routes[0].routingReason).toBe("delegate");
  });
});

// ── AC5 — liveness observable at /health (production entry point) ─────────────

describe("AC5 — routing-functionary liveness is observable at /health", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir, ROSTER_AGENTS);
    process.env.DEPARTMENT_ROSTER_PATH = writeRosterFile(dir);
    reloadAgents();
    resetRosterCache();
    // Simulate the bootstrap load that main() performs before createApp(),
    // mirroring the canon-bootstrap-health.test.ts pattern.
    await loadRoster();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });
  });

  afterEach(() => {
    appState?.bag?.close();
    appState?.sessionTracker?.close();
    appState?.agentQueue?.close();
    appState?.operationalEventStore?.close();
    delete process.env.AGENTS_FILE;
    delete process.env.DEPARTMENT_ROSTER_PATH;
    resetRosterCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("/health exposes a routingFunctionary field showing the functionary active in dispatch", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.routingFunctionary).toBeDefined();
    // The functionary is live in the dispatch path (not merely present as code).
    expect(res.body.routingFunctionary.active).toBe(true);
  });

  test("/health routingFunctionary shows the roster loaded, with steward + departments (no webhook needed)", async () => {
    const res = await request(appState.app).get("/health");
    const rf = res.body.routingFunctionary;
    expect(rf.roster.loaded).toBe(true);
    expect(rf.roster.steward).toBe("astrid");
    // Departments are observable so ac-validate can confirm the roster loaded
    // without waiting for a webhook to arrive.
    expect(rf.roster.departments).toEqual(expect.arrayContaining(["AI", "ILL"]));
  });
});
