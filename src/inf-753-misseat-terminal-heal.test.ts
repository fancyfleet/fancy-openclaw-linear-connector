/**
 * INF-753 — Governed self-heal regressed its own AC: a delegate was auto-seated
 * onto a terminal-labeled (`state:done`) ticket, which then permanently wedged
 * Mode 2. Follow-up to INF-739 (PR #550). Live repro was INF-739 itself:
 *
 *   1. A governed sign-off flipped the label to `state:done` and cleared the
 *      delegate, but a role-seating sweep — working from a pre-sign-off batch
 *      snapshot — seated a delegate at write time WITHOUT re-checking the LIVE
 *      terminal label (its idempotency re-fetch read delegate + native state but
 *      not labels). Result: `native To Do | label state:done | delegate Felix`.
 *   2. Mode 2 (Pass 4) then heals only terminal-labeled tickets; a mis-seated
 *      one stayed wedged because the reconcile never fired / the stray delegate
 *      was never cleared, so the seated agent was woken forever on a done ticket.
 *
 * These tests MUST be RED against the unfixed sweep:
 *   - Pass 5 seats when the live label raced to `state:done` (no live label guard).
 *   - Pass 4 leaves a stray delegate on an already-terminal-native ticket.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { runBootstrapReconciliationSweep } from "./bootstrap-reconciliation-sweep.js";
import { AlertBus } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";

const TEAM_ID = "team-uuid-inf753";
const DONE_STATE_ID = "team-done-state-uuid";
const OLD_TIMESTAMP = new Date(Date.now() - 10 * 60 * 1000).toISOString();

const TEST_WORKFLOW_DEF = {
  id: "dev-impl",
  entry_state: "intake",
  states: [
    { id: "intake", owner_role: "steward" },
    { id: "implementation", owner_role: "dev" },
    { id: "done", owner_role: undefined, kind: "terminal" },
  ],
};
const WORKFLOW_REGISTRY = new Map([["dev-impl", TEST_WORKFLOW_DEF]]) as never;

const ACTIVE_STATE = { id: "todo-state-uuid", name: "To Do", type: "unstarted" };
const COMPLETED_STATE = { id: DONE_STATE_ID, name: "Done", type: "completed" };

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function makeTestAlertBus(): { bus: AlertBus; alerts: Array<import("./alerts/alert-store.js").AlertInput> } {
  const collected: Array<import("./alerts/alert-store.js").AlertInput> = [];
  const bus = new AlertBus({ store: new AlertStore(":memory:"), pushEnabled: false, now: () => new Date() });
  const original = bus.notify.bind(bus);
  jest.spyOn(bus, "notify").mockImplementation((alert) => {
    collected.push(alert);
    original(alert);
  });
  return { bus, alerts: collected };
}

interface TicketShape {
  id: string;
  identifier: string;
  /** Labels the BATCH sweep query sees (the snapshot). */
  labelNodes: Array<{ id: string; name: string }>;
  delegateId?: string | null;
  native: { id: string; name: string; type: string };
  /** Labels the LIVE IssueContextSweep re-fetch sees — defaults to `labelNodes`.
   *  Set DIFFERENT to simulate the ticket racing to a terminal label. */
  liveLabelNames?: string[];
  /** Native state the LIVE re-fetch sees — defaults to `native`. */
  liveNative?: { id: string; name: string; type: string };
  /** Delegate the LIVE re-fetch sees — defaults to `delegateId`. */
  liveDelegateId?: string | null;
}

/** Fetch mock whose IssueContextSweep re-fetch INCLUDES labels (unlike INF-739's,
 *  so the live terminal-label guard can be exercised). Records every mutation. */
function makeFetch(tickets: TicketShape[], mutationCalls: string[]): typeof fetch {
  return async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";

    if (body.includes("IssueContextSweep")) {
      const idMatch = body.match(/"id":"([^"]+)"/);
      const t = tickets.find((x) => x.id === idMatch?.[1]) ?? tickets[0];
      const liveDelegate = t.liveDelegateId !== undefined ? t.liveDelegateId : t.delegateId ?? null;
      const liveLabels = (t.liveLabelNames ?? t.labelNodes.map((l) => l.name)).map((name) => ({ name }));
      return json({
        issue: {
          id: t.id,
          state: t.liveNative ?? t.native,
          delegate: liveDelegate ? { id: liveDelegate } : null,
          labels: { nodes: liveLabels },
        },
      });
    }

    if (body.includes("TeamCompletedState")) {
      return json({ team: { states: { nodes: [{ id: DONE_STATE_ID, name: "Done", type: "completed", position: 3 }] } } });
    }

    // PR-status lookup (Pass 3) — no merged PR, so Pass 3 never closes these tickets.
    if (body.includes("IssueBranchAndPR")) {
      return json({ issue: { attachments: { nodes: [] } } });
    }

    if (body.includes("issueUpdate") || body.includes("IssueUpdate")) {
      mutationCalls.push(body);
      return json({ issueUpdate: { success: true } });
    }

    if (body.includes("BootstrapReconciliation") || body.includes("wf:")) {
      return json({
        issues: {
          nodes: tickets.map((t) => ({
            id: t.id,
            identifier: t.identifier,
            updatedAt: OLD_TIMESTAMP,
            labels: { nodes: t.labelNodes },
            delegate: t.delegateId ? { id: t.delegateId } : null,
            team: { id: TEAM_ID },
            state: t.native,
            title: `Ticket ${t.identifier}`,
          })),
        },
      });
    }

    return json({});
  };
}

const seatOpts = () => ({
  resolveBodiesForRole: jest.fn(async (role: string) => (role === "dev" ? ["felix"] : [])),
  linearUserIdForBody: jest.fn((body: string) => (body === "felix" ? "felix-linear-uuid" : undefined)),
  openclawNameForBody: jest.fn((body: string) => body),
});

afterEach(() => jest.restoreAllMocks());

describe("INF-753 D1: Pass 5 must NEVER seat when the LIVE label raced to terminal", () => {
  it("blocks the seat when state:done landed between the batch snapshot and the write", async () => {
    const mutationCalls: string[] = [];
    const { bus } = makeTestAlertBus();
    // Snapshot: actionable non-terminal state + null delegate → Pass 5 candidate.
    // Live re-fetch: the governed sign-off already flipped the label to state:done.
    globalThis.fetch = makeFetch(
      [{
        id: "issue-inf739",
        identifier: "INF-739",
        labelNodes: [{ id: "l-wf", name: "wf:dev-impl" }, { id: "l-state", name: "state:implementation" }],
        delegateId: null,
        native: ACTIVE_STATE,
        liveLabelNames: ["wf:dev-impl", "state:done"],
      }],
      mutationCalls,
    );
    const opts = seatOpts();

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY,
      alertBus: bus,
      ...opts,
    });

    expect(result.seated).toBe(0);
    expect(mutationCalls.filter((b) => b.includes("WriteDelegate"))).toHaveLength(0);
  });

  it("still seats normally when the live label is unchanged (guard is not over-broad)", async () => {
    const mutationCalls: string[] = [];
    const { bus } = makeTestAlertBus();
    globalThis.fetch = makeFetch(
      [{
        id: "issue-ok",
        identifier: "INF-742",
        labelNodes: [{ id: "l-wf", name: "wf:dev-impl" }, { id: "l-state", name: "state:implementation" }],
        delegateId: null,
        native: ACTIVE_STATE,
        // liveLabelNames omitted → live labels == snapshot (non-terminal)
      }],
      mutationCalls,
    );

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY,
      alertBus: bus,
      ...seatOpts(),
    });

    expect(result.seated).toBe(1);
    expect(mutationCalls.filter((b) => b.includes("WriteDelegate"))).toHaveLength(1);
  });
});

describe("INF-753 D2: Mode 2 heals a MIS-SEATED terminal ticket", () => {
  // Regression guard: the native-ACTIVE reconcile already clears the delegate on
  // origin/main (reconcileTerminalNativeState writes `delegateId: null` with the
  // state). INF-739 is wedged in prod only because prod is BEHIND main. This test
  // locks that behavior in and asserts the new mis-seat alert semantics.
  it("clears the mis-seated delegate AND reconciles native→Done (native still active — the INF-739 wedge)", async () => {
    const mutationCalls: string[] = [];
    const { bus, alerts } = makeTestAlertBus();
    // The exact live INF-739 shape: state:done label, native To Do, delegate Felix.
    globalThis.fetch = makeFetch(
      [{
        id: "issue-inf739",
        identifier: "INF-739",
        labelNodes: [{ id: "l-wf", name: "wf:dev-impl" }, { id: "l-done", name: "state:done" }],
        delegateId: "felix-linear-uuid",
        native: ACTIVE_STATE,
      }],
      mutationCalls,
    );

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY,
      alertBus: bus,
      ...seatOpts(),
    });

    // One reconcile that sets the completed state AND clears the delegate.
    const reconciles = mutationCalls.filter((b) => b.includes("ReconcileTerminalNativeState"));
    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]).toContain("delegateId");
    expect(reconciles[0]).toContain(DONE_STATE_ID);
    expect(result.healed).toBeGreaterThanOrEqual(1);

    // The mis-seat must NOT be re-created by Pass 5 in the same sweep.
    expect(mutationCalls.filter((b) => b.includes("WriteDelegate"))).toHaveLength(0);

    const healAlerts = alerts.filter((a) => JSON.stringify(a.detail ?? {}).includes("mode-2-misseat-heal"));
    expect(healAlerts.length).toBeGreaterThanOrEqual(1);
  });

  it("clears a stray delegate when native is ALREADY terminal (no native write to piggyback on)", async () => {
    const mutationCalls: string[] = [];
    const { bus, alerts } = makeTestAlertBus();
    // A mis-seat that survived a partial native heal: native Done + delegate Felix.
    globalThis.fetch = makeFetch(
      [{
        id: "issue-strays",
        identifier: "INF-744",
        labelNodes: [{ id: "l-wf", name: "wf:dev-impl" }, { id: "l-done", name: "state:done" }],
        delegateId: "felix-linear-uuid",
        native: COMPLETED_STATE,
      }],
      mutationCalls,
    );

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY,
      alertBus: bus,
      ...seatOpts(),
    });

    const clears = mutationCalls.filter((b) => b.includes("ClearStrayDelegate"));
    expect(clears).toHaveLength(1);
    expect(clears[0]).toContain("delegateId");
    // Native already terminal → must NOT force a state write.
    expect(mutationCalls.filter((b) => b.includes("ReconcileTerminalNativeState"))).toHaveLength(0);
    expect(result.healed).toBeGreaterThanOrEqual(1);

    const clearAlerts = alerts.filter((a) => JSON.stringify(a.detail ?? {}).includes("mode-2-misseat-clear"));
    expect(clearAlerts.length).toBeGreaterThanOrEqual(1);
  });

  it("leaves a correctly-terminal ticket (native Done, null delegate) untouched", async () => {
    const mutationCalls: string[] = [];
    const { bus } = makeTestAlertBus();
    globalThis.fetch = makeFetch(
      [{
        id: "issue-clean",
        identifier: "INF-745",
        labelNodes: [{ id: "l-wf", name: "wf:dev-impl" }, { id: "l-done", name: "state:done" }],
        delegateId: null,
        native: COMPLETED_STATE,
      }],
      mutationCalls,
    );

    await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY,
      alertBus: bus,
      ...seatOpts(),
    });

    expect(mutationCalls.filter((b) => b.includes("ClearStrayDelegate"))).toHaveLength(0);
    expect(mutationCalls.filter((b) => b.includes("ReconcileTerminalNativeState"))).toHaveLength(0);
  });
});
