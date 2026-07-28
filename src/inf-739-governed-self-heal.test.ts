/**
 * INF-739 — Governed self-heal for null-delegate & terminal-desync tickets.
 *
 * Two correction modes on the bootstrap reconciliation sweep, exercised end to
 * end so a human flagging one of these becomes the exception, not the mechanism:
 *
 *   Mode 1 (Pass 5, NEW): an actionable `wf:*` + non-terminal `state:*` ticket
 *     with native-active state and a NULL delegate (the INF-735 shape) →
 *     auto-seat the current state's role owner via `resolveBodiesForRole`.
 *     Writes only the delegate; never touches labels or native state.
 *
 *   Mode 2 (Pass 4, EXISTING — regression guard): a terminal-labeled
 *     (`state:done`) ticket whose native state is still active (the INF-496 /
 *     LSO-20 shape) → reconcile native → Done and clear the delegate. Mode 1
 *     must NEVER seat a delegate on this shape (re-seating is the LSO-20 bug,
 *     INF-717 fix A).
 *
 * These tests MUST be RED until Pass 5 lands in bootstrap-reconciliation-sweep.ts.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { runBootstrapReconciliationSweep } from "./bootstrap-reconciliation-sweep.js";
import { AlertBus } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";

const TEAM_ID = "team-uuid-inf739";
const DONE_STATE_ID = "team-done-state-uuid";
const OLD_TIMESTAMP = new Date(Date.now() - 10 * 60 * 1000).toISOString();

// Minimal dev-impl workflow def: `implementation` is an actionable state owned
// by the `dev` role; `done` is terminal (no owner_role).
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
  labelNodes: Array<{ id: string; name: string }>;
  delegateId?: string | null;
  /** Native state returned by BOTH the batch query and the IssueContextSweep re-fetch. */
  native: { id: string; name: string; type: string };
  /** Delegate seen by the live IssueContextSweep re-fetch (defaults to `delegateId`). */
  liveDelegateId?: string | null;
}

/** Records every mutation body so tests can assert which pass fired. */
function makeFetch(tickets: TicketShape[], mutationCalls: string[]): typeof fetch {
  return async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";

    // Live re-fetch (Pass 3/4 native state + Pass 5 idempotency).
    if (body.includes("IssueContextSweep")) {
      const idMatch = body.match(/"id":"([^"]+)"/);
      const t = tickets.find((x) => x.id === idMatch?.[1]) ?? tickets[0];
      const liveDelegate = t.liveDelegateId !== undefined ? t.liveDelegateId : t.delegateId ?? null;
      return json({ issue: { id: t.id, state: t.native, delegate: liveDelegate ? { id: liveDelegate } : null } });
    }

    // Team completed-state resolution (Pass 4).
    if (body.includes("TeamCompletedState")) {
      return json({ team: { states: { nodes: [{ id: DONE_STATE_ID, name: "Done", type: "completed", position: 3 }] } } });
    }

    if (body.includes("issueUpdate") || body.includes("IssueUpdate")) {
      mutationCalls.push(body);
      return json({ issueUpdate: { success: true } });
    }

    // Batch candidate sweep query.
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

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

const ACTIVE_STATE = { id: "todo-state-uuid", name: "To Do", type: "unstarted" };

afterEach(() => jest.restoreAllMocks());

describe("INF-739 Mode 1: auto-seat role owner on actionable null-delegate tickets", () => {
  const seatOpts = () => ({
    resolveBodiesForRole: jest.fn(async (role: string) => (role === "dev" ? ["igor"] : [])),
    linearUserIdForBody: jest.fn((body: string) => (body === "igor" ? "igor-linear-uuid" : undefined)),
    openclawNameForBody: jest.fn((body: string) => body),
  });

  it("seats the current state's role owner, writes only the delegate, alerts, and wakes", async () => {
    const mutationCalls: string[] = [];
    const wakeDispatches: Array<{ agent: string; id: string }> = [];
    const { bus, alerts } = makeTestAlertBus();
    globalThis.fetch = makeFetch(
      [{
        id: "issue-inf735",
        identifier: "INF-735",
        labelNodes: [{ id: "l-wf", name: "wf:dev-impl" }, { id: "l-state", name: "state:implementation" }],
        delegateId: null,
        native: ACTIVE_STATE,
      }],
      mutationCalls,
    );
    const opts = seatOpts();

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY,
      alertBus: bus,
      wakeFn: async (agent, id) => { wakeDispatches.push({ agent, id }); },
      ...opts,
    });

    expect(result.seated).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(opts.resolveBodiesForRole).toHaveBeenCalledWith("dev");

    // Exactly one seat mutation, setting the resolved delegate and nothing else.
    const seatMutations = mutationCalls.filter((b) => b.includes("WriteDelegate"));
    expect(seatMutations).toHaveLength(1);
    expect(seatMutations[0]).toContain("igor-linear-uuid");
    expect(seatMutations[0]).not.toContain("stateId");
    expect(seatMutations[0]).not.toContain("labelIds");

    // Audit trail: one alert-bus record naming the ticket + the seated body.
    const seatAlerts = alerts.filter((a) => a.title.includes("seated role owner"));
    expect(seatAlerts).toHaveLength(1);
    expect(seatAlerts[0].ticket).toBe("INF-735");
    expect(JSON.stringify(seatAlerts[0].detail)).toContain("igor");

    // The newly-seated owner is woken (otherwise seated-but-dark).
    expect(wakeDispatches).toEqual([{ agent: "igor", id: "INF-735" }]);
  });

  it("is idempotent: a ticket that already has a delegate is never re-seated", async () => {
    const mutationCalls: string[] = [];
    const { bus } = makeTestAlertBus();
    globalThis.fetch = makeFetch(
      [{
        id: "issue-seated",
        identifier: "INF-740",
        labelNodes: [{ id: "l-wf", name: "wf:dev-impl" }, { id: "l-state", name: "state:implementation" }],
        delegateId: "already-seated-uuid",
        native: ACTIVE_STATE,
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
    expect(opts.resolveBodiesForRole).not.toHaveBeenCalled();
  });

  it("race-safe: skips the seat when a delegate appears between the batch query and the live re-fetch", async () => {
    const mutationCalls: string[] = [];
    const { bus } = makeTestAlertBus();
    // Batch query sees null delegate; the live IssueContextSweep re-fetch sees a
    // delegate that landed via a racing webhook.
    globalThis.fetch = makeFetch(
      [{
        id: "issue-race",
        identifier: "INF-741",
        labelNodes: [{ id: "l-wf", name: "wf:dev-impl" }, { id: "l-state", name: "state:implementation" }],
        delegateId: null,
        liveDelegateId: "raced-in-uuid",
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

    expect(result.seated).toBe(0);
    expect(mutationCalls.filter((b) => b.includes("WriteDelegate"))).toHaveLength(0);
  });

  it("NEVER seats a delegate on a terminal-labeled ticket (the LSO-20 bug / INF-717 fix A)", async () => {
    const mutationCalls: string[] = [];
    const { bus } = makeTestAlertBus();
    // state:done label but native still active + null delegate — Mode 2's shape.
    globalThis.fetch = makeFetch(
      [{
        id: "issue-inf733",
        identifier: "INF-733",
        labelNodes: [{ id: "l-wf", name: "wf:dev-impl" }, { id: "l-done", name: "state:done" }],
        delegateId: null,
        native: ACTIVE_STATE,
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

    // Mode 1 must not fire at all — not even resolve the role.
    expect(result.seated).toBe(0);
    expect(opts.resolveBodiesForRole).not.toHaveBeenCalled();
    expect(mutationCalls.filter((b) => b.includes("WriteDelegate"))).toHaveLength(0);
  });
});

describe("INF-739 Mode 2 regression: terminal-label desync reconciles native→Done, seats nothing", () => {
  it("reconciles native state to Done and clears the delegate without seating an owner", async () => {
    const mutationCalls: string[] = [];
    const { bus, alerts } = makeTestAlertBus();
    globalThis.fetch = makeFetch(
      [{
        id: "issue-inf733",
        identifier: "INF-733",
        labelNodes: [{ id: "l-wf", name: "wf:dev-impl" }, { id: "l-done", name: "state:done" }],
        delegateId: null,
        native: ACTIVE_STATE,
      }],
      mutationCalls,
    );
    const opts = {
      resolveBodiesForRole: jest.fn(async () => ["igor"]),
      linearUserIdForBody: jest.fn(() => "igor-linear-uuid"),
      openclawNameForBody: jest.fn((b: string) => b),
    };

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY,
      alertBus: bus,
      ...opts,
    });

    // Pass 4 reconciled the native state to Done…
    expect(result.healed).toBe(1);
    // …and Mode 1 seated nothing (a done ticket correctly owns no agent).
    expect(result.seated).toBe(0);
    expect(opts.resolveBodiesForRole).not.toHaveBeenCalled();

    const reconcile = mutationCalls.filter((b) => b.includes("ReconcileTerminalNativeState"));
    expect(reconcile).toHaveLength(1);
    expect(reconcile[0]).toContain(DONE_STATE_ID);
    expect(mutationCalls.filter((b) => b.includes("WriteDelegate"))).toHaveLength(0);

    const reconcileAlerts = alerts.filter((a) => a.title.includes("reconciled terminal-label"));
    expect(reconcileAlerts).toHaveLength(1);
  });
});
