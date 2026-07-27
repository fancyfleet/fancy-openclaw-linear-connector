/**
 * INF-719 — Paginate reconciliation/SLA sweep queries.
 *
 * The reconciliation/SLA safety-net sweeps ran unpaginated `issues()` GraphQL
 * queries, so Linear's default 50-node page cap silently truncated the candidate
 * set. With 250+ wf:*-enrolled tickets live, every affected sweep was blind to
 * ~80% of the board and any desync on an off-page ticket was never healed
 * (root-caused on INF-717 / LSO-20).
 *
 * AC-to-test mapping:
 *   AC3: the bootstrap sweep scans a candidate set larger than one page —
 *        this mocks 60 wf:* nodes across TWO pages and asserts all 60 are
 *        scanned (against the unfixed single-page code, only 50 are seen).
 *   Guard (A): the rescue sweep's classifier must treat state:canceled as
 *        terminal so a canceled, null-delegate ticket is never re-seated with a
 *        fresh delegate.
 *
 * These tests are RED against the pre-INF-719 code:
 *   - AC3 sees scanned === 50 (page 2 never requested).
 *   - Guard (A) classifies a canceled null-delegate ticket as "dormant".
 */

import { describe, it, expect } from "@jest/globals";
import { runBootstrapReconciliationSweep } from "./bootstrap-reconciliation-sweep.js";
import { AlertBus } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";
import { classifyTicket } from "./rescue-sweep.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const TEAM_ID = "team-uuid-inf719";
const WF_LABEL_ID = "label-wf-dev-impl";
const WF_LABEL_NAME = "wf:dev-impl";
const PAGE_1_CURSOR = "CURSOR_PAGE_1_END";

function silentAlertBus(): AlertBus {
  return new AlertBus({
    store: new AlertStore(":memory:"),
    pushEnabled: false,
    now: () => new Date(),
  });
}

/** Build a page of wf:*-labeled issue nodes in the shape queryUnenrolledTickets reads. */
function makePage(prefix: string, count: number, updatedAt: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-id-${i}`,
    identifier: `${prefix}-${i}`,
    updatedAt,
    labels: { nodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }] },
    delegate: null,
    team: { id: TEAM_ID },
    state: null,
    title: `Ticket ${prefix}-${i}`,
  }));
}

// ── AC3: bootstrap sweep pages through >50 nodes across ≥2 pages ────────────

describe("INF-719 AC3: bootstrap reconciliation sweep paginates the full wf:* set", () => {
  it("scans all 60 candidates spread across two pages (not just the first 50)", async () => {
    const nowMs = Date.UTC(2026, 6, 26, 13, 8, 0);
    // Keep every ticket inside the grace window so the sweep counts them as
    // scanned but does not attempt a heal — this isolates pagination behavior.
    const freshTs = new Date(nowMs).toISOString();

    const page1 = makePage("INF-P1", 50, freshTs);
    const page2 = makePage("INF-P2", 10, freshTs);

    const requestedCursors: Array<string | null> = [];

    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("BootstrapReconciliation")) {
        const secondPage = body.includes(PAGE_1_CURSOR);
        requestedCursors.push(secondPage ? PAGE_1_CURSOR : null);
        const payload = secondPage
          ? { issues: { nodes: page2, pageInfo: { hasNextPage: false, endCursor: null } } }
          : { issues: { nodes: page1, pageInfo: { hasNextPage: true, endCursor: PAGE_1_CURSOR } } };
        return new Response(JSON.stringify({ data: payload }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map(),
      alertBus: silentAlertBus(),
      wakeFn: async () => {},
      fetchFn,
      nowMs,
    });

    // All 60 tickets across both pages were scanned — the whole point of INF-719.
    expect(result.scanned).toBe(60);
    // The second page was actually requested, threading the page-1 end cursor.
    expect(requestedCursors).toContain(PAGE_1_CURSOR);
    expect(requestedCursors.filter((c) => c === PAGE_1_CURSOR)).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("fails loud when the query returns a GraphQL error instead of silently scanning 0", async () => {
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("BootstrapReconciliation")) {
        return new Response(
          JSON.stringify({ errors: [{ message: "GRAPHQL_VALIDATION_FAILED" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof fetch;

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map(),
      alertBus: silentAlertBus(),
      wakeFn: async () => {},
      fetchFn,
    });

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.join("\n")).toContain("GRAPHQL_VALIDATION_FAILED");
  });
});

// ── Guard (A): rescue classifier treats state:canceled as terminal ─────────

describe("INF-719 guard (A): rescue sweep never re-seats a delegate on a terminal ticket", () => {
  const emptyDef = { entry_state: "intake", states: [] as Array<{ id: string; owner_role?: string }> };
  const noBodies = () => [] as string[];

  it("classifies a canceled ticket with a null delegate as terminal (not dormant)", () => {
    const classification = classifyTicket(
      ["wf:dev-impl", "state:canceled"],
      null,
      emptyDef,
      noBodies,
    );
    expect(classification).toBe("terminal");
  });

  it("still classifies done and escape tickets as terminal", () => {
    expect(classifyTicket(["wf:dev-impl", "state:done"], null, emptyDef, noBodies)).toBe("terminal");
    expect(classifyTicket(["wf:dev-impl", "state:escape"], null, emptyDef, noBodies)).toBe("terminal");
  });

  it("still classifies a non-terminal null-delegate ticket as dormant", () => {
    expect(
      classifyTicket(["wf:dev-impl", "state:implementation"], null, emptyDef, noBodies),
    ).toBe("dormant");
  });
});
