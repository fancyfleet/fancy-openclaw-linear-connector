/**
 * INF-558 — Out-of-band terminal close leaves dev-sprint parent redispatching
 * forever.
 *
 * A ticket that reaches a native terminal state (Done/Canceled) via a
 * NON-governed path — a manual Linear column flip, or any edge that forgets to
 * sync facets — never runs the governed terminal that syncs the `state:*`
 * mirror label and clears the delegate. Every dispatch poller keys off the
 * mirror label + delegate (or the enrolled mirror), NOT the native state, so
 * such a zombie re-dispatches forever (live victim: LSO-1).
 *
 * The delegation-reconciliation sweep is the periodic subsystem that sees every
 * wf-labeled ticket, so it is where the durable heal lives: when it encounters a
 * natively-terminal ticket whose facets are still active, it runs the same
 * facet-sync the governed complete/converge terminal performs instead of
 * re-dispatching the delegate.
 *
 * AC-to-test mapping:
 *   AC1 (primary): a natively-`completed` ticket with a stale non-terminal
 *        `state:*` mirror label + pinned delegate is facet-synced
 *        (setStateAtomic → terminal label, delegate cleared, enrolled mirror
 *        marked terminal) and is NOT re-dispatched. On unfixed code this ticket
 *        falls through to the AC1 redispatch path and wakes the delegate — so
 *        the "no wake + facet-sync" assertions are RED before the fix.
 *   AC2: an already-clean native-terminal ticket (terminal label, no delegate,
 *        enrolled row already terminal) triggers NO Linear write and NO wake —
 *        the heal is idempotent across sweeps.
 *   AC3 (defense-in-depth safety): a natively-`canceled` ticket has its enrolled
 *        mirror healed (stops the loop) but is NOT auto-written to Linear,
 *        because every governed terminal state maps `native_state: done` and a
 *        write would resurrect the native state from Canceled to Done. Surfaced
 *        via an operator alert instead.
 *   AC4 (regression): a non-terminal governed ticket with a stranded delegation
 *        still re-dispatches through the normal path — the new guard does not
 *        swallow healthy redispatches.
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  runDelegationReconciliationSweep,
  type DelegationReconciliationOptions,
} from "./delegation-reconciliation-sweep.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import type { EnrolledTicketsStore, EnrolledTicketRow } from "./store/enrolled-tickets-store.js";
import type { SetStateAtomicResult } from "./workflow-gate.js";

const AUTH = "Bearer test-token";
const TEAM_ID = "team-uuid";
const OLD = new Date(Date.now() - 30 * 60 * 1000).toISOString();

interface MockTicket {
  id: string;
  identifier: string;
  labels: Array<{ id: string; name: string }>;
  delegateId: string | null;
  delegateName: string | null;
  stateType: string | null;
}

/**
 * Minimal Linear fetch mock. Answers the governed-tickets query with `state {
 * type }` populated, returns an empty ad-hoc set, and returns empty/no-op
 * responses for the delegate-set-history and any other queries (the sweep
 * falls back gracefully).
 */
function makeFetch(governed: MockTicket[]): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("AdhocDelegationReconciliation")) {
      return new Response(
        JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (body.includes("DelegationReconciliation")) {
      const nodes = governed.map((t) => ({
        id: t.id,
        identifier: t.identifier,
        updatedAt: OLD,
        title: `Ticket ${t.identifier}`,
        state: t.stateType ? { type: t.stateType } : null,
        labels: { nodes: t.labels },
        delegate: t.delegateId ? { id: t.delegateId, name: t.delegateName } : null,
        team: { id: TEAM_ID },
      }));
      return new Response(
        JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Delegate-set-history and everything else: empty (sweep falls back).
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/** Fake enrolled-tickets mirror: only getByTicketId + markTerminal are exercised. */
function makeEnrolledStore(rows: Record<string, Partial<EnrolledTicketRow>>): {
  store: EnrolledTicketsStore;
  markTerminal: jest.Mock;
} {
  const markTerminal = jest.fn();
  const store = {
    getByTicketId: (id: string): EnrolledTicketRow | null =>
      (rows[id] ? ({ ticket_id: id, terminal: 0, ...rows[id] } as EnrolledTicketRow) : null),
    markTerminal,
  } as unknown as EnrolledTicketsStore;
  return { store, markTerminal };
}

function baseOpts(overrides: Partial<DelegationReconciliationOptions>): DelegationReconciliationOptions {
  const wakeFn = jest.fn(async () => {});
  const notify = jest.fn();
  return {
    authToken: AUTH,
    operationalEventStore: new OperationalEventStore(":memory:"),
    alertBus: { notify } as any,
    wakeFn: wakeFn as any,
    ...overrides,
  } as DelegationReconciliationOptions;
}

describe("INF-558: out-of-band terminal facet reconciliation", () => {
  it("AC1: facet-syncs a natively-completed ticket with stale mirror + delegate; does NOT redispatch", async () => {
    const ticket: MockTicket = {
      id: "issue-lso-1",
      identifier: "LSO-1",
      labels: [
        { id: "l-wf", name: "wf:dev-sprint" },
        { id: "l-state", name: "state:product-definition" },
      ],
      delegateId: "astrid-uuid",
      delegateName: "astrid",
      stateType: "completed",
    };
    const setStateFn = jest.fn(
      async (): Promise<SetStateAtomicResult> => ({ ok: true, ticketId: "LSO-1", from: "product-definition", to: "done" }),
    );
    const { store, markTerminal } = makeEnrolledStore({ "LSO-1": { terminal: 0 } });
    const wakeFn = jest.fn(async () => {});

    const result = await runDelegationReconciliationSweep(
      baseOpts({
        fetchFn: makeFetch([ticket]),
        setStateFn: setStateFn as any,
        enrolledTicketsStore: store,
        wakeFn: wakeFn as any,
      }),
    );

    // Facet-synced through the governed atomic primitive: terminal label,
    // delegate cleared, native-idempotent target "done", force:true.
    expect(setStateFn).toHaveBeenCalledTimes(1);
    const [id, target, delegate, , options] = setStateFn.mock.calls[0] as any[];
    expect(id).toBe("LSO-1");
    expect(target).toBe("done");
    expect(delegate).toBeNull();
    expect(options).toMatchObject({ force: true });

    // Enrolled mirror healed → stops every poller that keys off it.
    expect(markTerminal).toHaveBeenCalledWith("LSO-1", "out-of-band-terminal");

    // The whole point: the zombie is NOT re-dispatched to its delegate.
    expect(wakeFn).not.toHaveBeenCalled();
    expect(result.facetHealed).toBe(1);
    expect(result.healed).toBe(0);
  });

  it("AC2: an already-clean native-terminal ticket triggers no Linear write and no wake (idempotent)", async () => {
    const ticket: MockTicket = {
      id: "issue-clean",
      identifier: "LSO-9",
      labels: [
        { id: "l-wf", name: "wf:dev-sprint" },
        { id: "l-state", name: "state:done" },
      ],
      delegateId: null,
      delegateName: null,
      stateType: "completed",
    };
    const setStateFn = jest.fn(
      async (): Promise<SetStateAtomicResult> => ({ ok: true, ticketId: "LSO-9", from: "done", to: "done" }),
    );
    const { store, markTerminal } = makeEnrolledStore({ "LSO-9": { terminal: 1 } });
    const wakeFn = jest.fn(async () => {});

    const result = await runDelegationReconciliationSweep(
      baseOpts({
        fetchFn: makeFetch([ticket]),
        setStateFn: setStateFn as any,
        enrolledTicketsStore: store,
        wakeFn: wakeFn as any,
      }),
    );

    expect(setStateFn).not.toHaveBeenCalled();
    expect(markTerminal).not.toHaveBeenCalled();
    expect(wakeFn).not.toHaveBeenCalled();
    expect(result.facetHealed).toBe(0);
  });

  it("AC3: a natively-canceled ticket heals the enrolled mirror + alerts, but does NOT write Linear (no native flip)", async () => {
    const ticket: MockTicket = {
      id: "issue-canceled",
      identifier: "LSO-7",
      labels: [
        { id: "l-wf", name: "wf:dev-sprint" },
        { id: "l-state", name: "state:product-definition" },
      ],
      delegateId: "astrid-uuid",
      delegateName: "astrid",
      stateType: "canceled",
    };
    const setStateFn = jest.fn(
      async (): Promise<SetStateAtomicResult> => ({ ok: true, ticketId: "LSO-7", from: "product-definition", to: "done" }),
    );
    const { store, markTerminal } = makeEnrolledStore({ "LSO-7": { terminal: 0 } });
    const wakeFn = jest.fn(async () => {});
    const notify = jest.fn();

    const result = await runDelegationReconciliationSweep(
      baseOpts({
        fetchFn: makeFetch([ticket]),
        setStateFn: setStateFn as any,
        enrolledTicketsStore: store,
        wakeFn: wakeFn as any,
        alertBus: { notify } as any,
      }),
    );

    // Local mirror heal stops the loop for every terminal flavor …
    expect(markTerminal).toHaveBeenCalledWith("LSO-7", "out-of-band-terminal");
    // … but we deliberately do NOT auto-write Linear (would flip Canceled→Done).
    expect(setStateFn).not.toHaveBeenCalled();
    // Operator is alerted that the Linear facets still need a sync.
    expect(notify).toHaveBeenCalled();
    const alertTitles = notify.mock.calls.map((c: any[]) => String((c[0] as any).title));
    expect(alertTitles.some((t) => t.includes("operator sync"))).toBe(true);
    expect(wakeFn).not.toHaveBeenCalled();
    expect(result.facetHealed).toBe(1);
  });

  it("AC4 (regression): a non-terminal governed ticket with a stranded delegation still re-dispatches", async () => {
    const ticket: MockTicket = {
      id: "issue-live",
      identifier: "AI-1000",
      labels: [
        { id: "l-wf", name: "wf:dev-sprint" },
        { id: "l-state", name: "state:product-definition" },
      ],
      delegateId: "astrid-uuid",
      delegateName: "astrid",
      stateType: "started",
    };
    const setStateFn = jest.fn(
      async (): Promise<SetStateAtomicResult> => ({ ok: true, ticketId: "AI-1000", from: null, to: "done" }),
    );
    const wakeFn = jest.fn(async () => {});

    const result = await runDelegationReconciliationSweep(
      baseOpts({
        fetchFn: makeFetch([ticket]),
        setStateFn: setStateFn as any,
        wakeFn: wakeFn as any,
      }),
    );

    // Healthy stranded-delegation redispatch is untouched by the new guard.
    expect(wakeFn).toHaveBeenCalledWith("astrid", "AI-1000");
    expect(setStateFn).not.toHaveBeenCalled();
    expect(result.facetHealed).toBe(0);
    expect(result.healed).toBe(1);
  });
});
