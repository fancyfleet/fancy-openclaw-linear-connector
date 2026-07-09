/**
 * AI-1479 (Phase 6.5 / H-4) — Routing-functionary extraction.
 *
 * FAILING tests (TDD, write-tests state). These cover the *decision logic* of
 * the deterministic routing functionary — the pure `resolveRoute()` contract
 * plus roster loading. They intentionally reference the not-yet-existing
 * `./department-roster.js` module, so the whole suite is RED until the
 * functionary is implemented.
 *
 * AC coverage map (AC of record captured by astrid 2026-07-09T23:04:51):
 *   AC1  — "A clean department match routes with no person in the loop."
 *          → describe("AC1 …")
 *   AC2  — "An unroutable request escalates to Astrid."
 *          → describe("AC2 …")
 *   AC3  — "An explicit mechanical route (delegate, assignee, or mention) is
 *          never overridden by a department-prefix match."
 *          → describe("AC3 …")
 *
 * AC4 (live-dispatch-path registration) and AC5 (/health liveness) are covered
 * by the sibling integration suite `ai-1479-routing-functionary-bootstrap.test.ts`.
 * A module-level unit test of resolveRoute() alone does NOT satisfy AC4 — that
 * is deliberately proven separately through the production entry point.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveRoute,
  loadRoster,
  resetRosterCache,
} from "./department-roster.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// A minimal roster used for the pure-contract tests. Steward is Astrid, per the
// AC of record ("An unroutable request escalates to Astrid"). "AI" tickets
// default to igor (backend/connector); "ILL" tickets default to sage.
// No per-event-type overrides: the `Comment: charles` override was explicitly
// dropped at intake (charles is conversation-only, AI-1946). The functionary
// resolves purely on department prefix → mechanical target → steward.
const ROSTER = {
  version: 1,
  steward: "astrid",
  departments: {
    AI: { name: "AI Team", defaultTarget: "igor" },
    ILL: { name: "ILL Team", defaultTarget: "sage" },
  },
};

function writeRosterYaml(dir: string): string {
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

// ── AC1 — clean department match routes with no person in the loop ────────────

describe("AC1 — a clean department match routes with no person in the loop", () => {
  test("an AI-prefixed identifier with no mechanical target resolves to the AI department default (igor), no escalation", () => {
    const result = resolveRoute("AI-1234", "Issue", ROSTER, null);
    // Routed automatically to the department worker — NOT the steward.
    expect(result.target).toBe("igor");
    expect(result.escalated).toBe(false);
    expect(result.target).not.toBe(ROSTER.steward);
    // The routing reason must name the department match, not a person/steward.
    expect(result.reason).toBe("department-prefix");
  });

  test("a different department prefix (ILL) resolves to that department's default (sage)", () => {
    const result = resolveRoute("ILL-42", "Issue", ROSTER, null);
    expect(result.target).toBe("sage");
    expect(result.escalated).toBe(false);
    expect(result.reason).toBe("department-prefix");
  });

  test("prefix matching is case-insensitive on the identifier", () => {
    const result = resolveRoute("ai-9", "Issue", ROSTER, null);
    expect(result.target).toBe("igor");
    expect(result.escalated).toBe(false);
  });
});

// ── AC2 — an unroutable request escalates to Astrid ───────────────────────────

describe("AC2 — an unroutable request escalates to Astrid (the steward)", () => {
  test("an identifier whose prefix matches no department and has no mechanical target escalates to the steward", () => {
    const result = resolveRoute("ZZ-99", "Issue", ROSTER, null);
    expect(result.target).toBe("astrid");
    expect(result.escalated).toBe(true);
    expect(result.reason).toBe("steward-escalation");
  });

  test("a null identifier with no mechanical target escalates to the steward (never returns null)", () => {
    const result = resolveRoute(null, "Issue", ROSTER, null);
    expect(result.target).toBe("astrid");
    expect(result.escalated).toBe(true);
  });

  test("escalation target follows the roster's configured steward, not a hardcoded name", () => {
    const custom = { ...ROSTER, steward: "some-other-steward" };
    const result = resolveRoute("ZZ-1", "Issue", custom, null);
    expect(result.target).toBe("some-other-steward");
    expect(result.escalated).toBe(true);
  });
});

// ── AC3 — mechanical routes are never overridden by a department-prefix match ──

describe("AC3 — an explicit mechanical route is never overridden by a department-prefix match", () => {
  test("an explicit delegate on an AI-prefixed ticket routes to the delegate, NOT the AI department default", () => {
    // The ticket prefix "AI" would, on its own, route to igor. An explicit
    // delegate (charles) must win — the department-prefix must not override it.
    const result = resolveRoute("AI-1234", "Issue", ROSTER, {
      name: "charles",
      reason: "delegate",
    });
    expect(result.target).toBe("charles");
    expect(result.reason).toBe("delegate");
    // Guard against the regression this AC exists to prevent:
    expect(result.target).not.toBe("igor");
    expect(result.reason).not.toBe("department-prefix");
  });

  test("an explicit assignee on a department-prefixed ticket routes to the assignee", () => {
    const result = resolveRoute("AI-1234", "Issue", ROSTER, {
      name: "charles",
      reason: "assignee",
    });
    expect(result.target).toBe("charles");
    expect(result.reason).toBe("assignee");
    expect(result.target).not.toBe("igor");
  });

  test("an explicit mention on a department-prefixed ticket routes to the mentioned agent", () => {
    const result = resolveRoute("ILL-42", "Issue", ROSTER, {
      name: "charles",
      reason: "mention",
    });
    expect(result.target).toBe("charles");
    expect(result.reason).toBe("mention");
    expect(result.target).not.toBe("sage");
  });
});

// ── Roster loading (supporting AC1/AC2: the functionary must be roster-driven) ─

describe("roster loading — the functionary is driven by department-roster.yaml", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-load-test-"));
    resetRosterCache();
  });

  afterEach(() => {
    delete process.env.DEPARTMENT_ROSTER_PATH;
    resetRosterCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("loadRoster() reads the yaml at DEPARTMENT_ROSTER_PATH and exposes departments + steward", async () => {
    process.env.DEPARTMENT_ROSTER_PATH = writeRosterYaml(dir);
    const roster = await loadRoster();
    expect(roster).not.toBeNull();
    expect(roster?.steward).toBe("astrid");
    expect(roster?.departments?.AI?.defaultTarget).toBe("igor");
    expect(roster?.departments?.ILL?.defaultTarget).toBe("sage");
  });

  test("a loaded roster drives resolveRoute end-to-end (clean AI match → igor)", async () => {
    process.env.DEPARTMENT_ROSTER_PATH = writeRosterYaml(dir);
    const roster = await loadRoster();
    const result = resolveRoute("AI-7", "Issue", roster, null);
    expect(result.target).toBe("igor");
    expect(result.escalated).toBe(false);
  });
});
