/**
 * AI-2017 — Routing functionary: emit steward-escalation in the live dispatch
 * path (AI-1479 AC2 follow-up).
 *
 * TDD write-tests suite. AI-1479 wired the functionary into `routeEventAll()`
 * but acted on its decision ONLY when `reason === "department-prefix"`; a
 * `steward-escalation` decision was computed and then discarded (`return []`),
 * so an unroutable request never reached the steward through the production
 * dispatch path. This suite proves the missing emission and guards the
 * composition boundaries the fix must not break.
 *
 * AC of record (captured by astrid, intake 2026-07-09T23:48:35):
 *
 *   AC1 (NEW behavior — RED until implemented) — "With a roster loaded, an
 *        event carrying an issue identifier whose prefix matches NO roster
 *        department dispatches exactly one route to the roster steward
 *        (astrid), reason `steward-escalation`, through the live dispatch path
 *        (routeEventAll(), reachable from the production entry point). A
 *        module-level resolveRoute() unit test alone does NOT satisfy this."
 *        → describe("AC1 …") drives routeEventAll() — the exact symbol the
 *          production webhook handler (src/webhook/index.ts) invokes — with an
 *          unmatched-prefix event and asserts exactly one route to astrid.
 *
 *   AC2 (composition preserved — GREEN now, must STAY green) — "identifier-less
 *        events, human-only candidates (AI-1900), AgentSessionEvent with no
 *        resolvable owner (audit #16), and no-roster deployments keep their
 *        existing no-route behavior; mention fan-out is untouched."
 *        → describe("AC2 …") pins the boundaries a naive escalation (one that
 *          keys only on reason === "steward-escalation") would break: it must
 *          NOT wake the steward for an identifier-less event, an
 *          AgentSessionEvent UI widget, or a no-roster deployment.
 *
 *   AC3 (mechanical route never overridden — GREEN now, must STAY green) — "An
 *        explicit mechanical route is never overridden."
 *        → describe("AC3 …") proves a delegate on an unmatched-prefix event
 *          still wins through the live path; escalation never displaces it.
 *
 * The AC2/AC3 guards pass on main today. They are here because the AC1 fix is
 * exactly the kind of change that can regress them (escalating events that must
 * no-route). They are labelled so ac-validate can trace coverage; the RED
 * signal for this ticket lives entirely in the AC1 block.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reloadAgents } from "./agents.js";
import { routeEventAll } from "./router.js";
import { loadRoster, resetRosterCache } from "./department-roster.js";
import type { LinearEvent } from "./webhook/schema.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai2017-steward-escalation-"));
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

const ROSTER_AGENTS = [
  mkAgent("igor"),
  mkAgent("sage"),
  mkAgent("charles"),
  mkAgent("astrid"),
];

// An Issue event carrying an issue identifier whose prefix (ZZ) matches NO
// roster department, with NO delegate / assignee / mention. This is the exact
// AC2-of-AI-1479 case: no mechanical target, no department match — the request
// is unroutable and must escalate to the steward. On main routeEventAll returns
// zero routes (the steward-escalation decision is computed then discarded).
function unmatchedPrefixEvent(): LinearEvent {
  return {
    type: "Issue",
    action: "update",
    actor: { id: "actor-human-matt", name: "Matt Henry" },
    createdAt: "2026-07-09T00:00:00.000Z",
    data: {
      id: "issue-zz-99",
      identifier: "ZZ-99",
      title: "A ticket in a team with no roster department",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 0,
      priorityLabel: "No priority",
      teamId: "team-zz",
      teamKey: "ZZ",
      labelIds: [],
      url: "https://linear.app/fancymatt/issue/ZZ-99",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    },
    raw: {},
  } as unknown as LinearEvent;
}

// An Issue event that carries NO issue identifier at all (and no mechanical
// candidate). resolveRoute() would still return steward-escalation for a null
// identifier — so a fix that escalates purely on the decision reason would
// wrongly wake the steward here. AC2 requires this to keep no-routing.
function identifierlessEvent(): LinearEvent {
  return {
    type: "Issue",
    action: "update",
    actor: { id: "actor-human-matt", name: "Matt Henry" },
    createdAt: "2026-07-09T00:00:00.000Z",
    data: {
      id: "issue-no-identifier",
      title: "Entity write carrying no issue identifier",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 0,
      labelIds: [],
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    },
    raw: {},
  } as unknown as LinearEvent;
}

// An AgentSessionEvent whose session owner is not a registered agent. It DOES
// carry an issue identifier (SAK-51, a prefix matching no department), so a
// naive escalation would wake the steward for a UI-widget event. Audit #16
// (wake-nobody) requires this to route to no one.
function orphanAgentSessionEvent(): LinearEvent {
  return {
    type: "AgentSessionEvent",
    action: "create",
    actor: { id: "actor-1", name: "System" },
    createdAt: "2026-07-09T00:00:00.000Z",
    data: {
      agentSession: {
        issue: { identifier: "SAK-51", id: "issue-sak-51" },
        appUser: { id: "not-a-registered-agent" },
      },
    },
    raw: {},
  } as unknown as LinearEvent;
}

// ── AC1 — NEW behavior: steward escalation reaches the live dispatch path ──────

describe("AC1 — an unmatched-prefix event escalates to the steward through routeEventAll (live dispatch path)", () => {
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

  test("routeEventAll dispatches exactly one route to the steward (astrid), reason steward-escalation", async () => {
    // routeEventAll is the exact symbol src/webhook/index.ts calls on every
    // inbound webhook — driving it here exercises the production dispatch path,
    // not a standalone resolveRoute() call (which AC1 explicitly excludes).
    const routes = await routeEventAll(unmatchedPrefixEvent());
    expect(routes).toHaveLength(1);
    expect(routes[0].agentId).toBe("astrid");
    expect(routes[0].routingReason).toBe("steward-escalation");
  });

  test("the escalation route targets the ZZ-99 session, so the steward lands on the unroutable ticket", async () => {
    const routes = await routeEventAll(unmatchedPrefixEvent());
    expect(routes).toHaveLength(1);
    // The steward must be woken *on the ticket that failed to route*, not on a
    // synthetic key — the session key carries the identifier.
    expect(routes[0].sessionKey).toBe("linear-ZZ-99");
  });
});

// ── AC2 — composition preserved (guards; green now, must stay green) ──────────

describe("AC2 — escalation composes with, and does not revert, existing no-route paths", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir, ROSTER_AGENTS);
    reloadAgents();
    resetRosterCache();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.DEPARTMENT_ROSTER_PATH;
    resetRosterCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("with a roster loaded, an identifier-less event still routes to nobody (no escalation without an identifier)", async () => {
    process.env.DEPARTMENT_ROSTER_PATH = writeRosterFile(dir);
    await loadRoster();
    const routes = await routeEventAll(identifierlessEvent());
    expect(routes).toEqual([]);
  });

  test("with a roster loaded, an AgentSessionEvent with no resolvable owner wakes nobody (audit #16)", async () => {
    process.env.DEPARTMENT_ROSTER_PATH = writeRosterFile(dir);
    await loadRoster();
    // SAK-51's prefix matches no department; audit #16 forbids waking the
    // steward for a session-owner-less UI widget event.
    const routes = await routeEventAll(orphanAgentSessionEvent());
    expect(routes).toEqual([]);
  });

  test("with NO roster loaded, an unmatched-prefix event keeps its existing no-route behavior", async () => {
    // No DEPARTMENT_ROSTER_PATH set → getCachedRoster() is null. A no-roster
    // deployment has no steward to escalate to, so the functionary stays a
    // no-op and the event no-routes exactly as before.
    resetRosterCache();
    const routes = await routeEventAll(unmatchedPrefixEvent());
    expect(routes).toEqual([]);
  });
});

// ── AC3 — an explicit mechanical route is never overridden (regression guard) ──

describe("AC3 — a mechanical route wins over steward escalation through the live path", () => {
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

  test("an explicit delegate on an unmatched-prefix event routes to the delegate, not the steward", async () => {
    const event = unmatchedPrefixEvent();
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
    // Escalation must not sneak in as an additional route.
    expect(routes.some((r) => r.routingReason === "steward-escalation")).toBe(false);
  });
});
