/**
 * INF-1286 — Unit tests for native-state-reconciler.ts, distinct from the
 * existing inf-993-native-state-reconciler.test.ts suite.
 *
 * The inf-993 suite already exercises runNativeStateReconcilerSweep's AC1-AC4
 * decision logic via injected opts (listTickets/resolveNativeStateId/
 * writeNativeState). This file covers what that suite does not:
 *   - the production data plane (createLinearReconcilerDataPlane), mocking the
 *     Linear API boundary directly at the fetch level rather than via opts,
 *   - already-correct no-op paths (native state already matches the target),
 *   - listTickets/resolveNativeStateId throwing (uncaught exceptions, not just
 *     a failed write),
 *   - the liveness surface (getNativeStateReconcilerLiveness / reset /
 *     registerNativeStateReconcilerCron).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  runNativeStateReconcilerSweep,
  createLinearReconcilerDataPlane,
  getNativeStateReconcilerLiveness,
  resetNativeStateReconcilerForTest,
  registerNativeStateReconcilerCron,
  type ReconcileTicket,
  type NativeStateReconcilerOpts,
} from "./native-state-reconciler.js";

function ticket(overrides: Partial<ReconcileTicket> = {}): ReconcileTicket {
  return {
    identifier: "INF-1286",
    issueId: "issue-inf-1286",
    workflow: "dev-impl",
    connectorState: "write-tests",
    nativeStateId: "state-thinking-uuid",
    nativeStateName: "Thinking",
    delegateId: "u-tdd",
    assigneeId: null,
    liveness: { kind: "SESSION_DEAD" },
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// No-op paths — already-correct native state is never rewritten
// ════════════════════════════════════════════════════════════════════════════

describe("no-op when native state already matches the target", () => {
  it("SESSION_DEAD with native state already 'To Do' performs no write", async () => {
    const writeNativeState = jest.fn(async () => ({ success: true }));
    const opts: NativeStateReconcilerOpts = {
      listTickets: async () => [ticket({ nativeStateName: "To Do", liveness: { kind: "SESSION_DEAD" } })],
      resolveNativeStateId: async () => "state-todo-uuid",
      writeNativeState,
    };

    const result = await runNativeStateReconcilerSweep(opts);

    expect(result.corrected).toBe(0);
    expect(result.failed).toBe(0);
    expect(writeNativeState).not.toHaveBeenCalled();
  });

  it("connector-ahead with a completion receipt and native already 'Done' performs no write", async () => {
    const writeNativeState = jest.fn(async () => ({ success: true }));
    const opts: NativeStateReconcilerOpts = {
      listTickets: async () => [
        ticket({
          nativeStateName: "Done",
          liveness: { kind: "LIVE" },
          completionReceipt: "merged-pr",
        }),
      ],
      resolveNativeStateId: async () => "state-done-uuid",
      writeNativeState,
    };

    const result = await runNativeStateReconcilerSweep(opts);

    expect(result.corrected).toBe(0);
    expect(writeNativeState).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Thrown exceptions (not just a failed write) are captured, not propagated
// ════════════════════════════════════════════════════════════════════════════

describe("exception handling", () => {
  it("listTickets throwing is captured as a failed sweep, not thrown", async () => {
    const opts: NativeStateReconcilerOpts = {
      listTickets: async () => { throw new Error("linear down"); },
      resolveNativeStateId: async () => "x",
      writeNativeState: async () => ({ success: true }),
    };

    const result = await runNativeStateReconcilerSweep(opts);

    expect(result.failed).toBe(1);
    expect(result.corrected).toBe(0);
    expect(result.errors[0].message).toMatch(/listTickets failed/i);
  });

  it("resolveNativeStateId throwing for one ticket is captured without aborting the sweep", async () => {
    const writeNativeState = jest.fn(async () => ({ success: true, issue: { state: { id: "ok" } } }));
    const opts: NativeStateReconcilerOpts = {
      listTickets: async () => [ticket({ identifier: "A" }), ticket({ identifier: "B" })],
      resolveNativeStateId: jest.fn(async (name: string) => {
        if (name === "To Do") throw new Error("no id for To Do");
        return "ok";
      }) as never,
      writeNativeState,
    };

    const result = await runNativeStateReconcilerSweep(opts);

    expect(result.failed).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((e) => e.ticket === "A" || e.ticket === "B")).toBe(true);
  });

  it("writeNativeState throwing is captured as a failed correction with the ticket identifier", async () => {
    const opts: NativeStateReconcilerOpts = {
      listTickets: async () => [ticket()],
      resolveNativeStateId: async () => "state-todo-uuid",
      writeNativeState: async () => { throw new Error("network timeout"); },
    };

    const result = await runNativeStateReconcilerSweep(opts);

    expect(result.failed).toBe(1);
    expect(result.errors[0].ticket).toBe("INF-1286");
    expect(result.errors[0].message).toMatch(/did not land/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Production data plane — mocking the Linear API boundary directly (fetch)
// ════════════════════════════════════════════════════════════════════════════

describe("createLinearReconcilerDataPlane — Linear API boundary via fetch", () => {
  function makeFetch() {
    const mutations: Array<{ id: string; input: Record<string, unknown> }> = [];
    const fetchFn = jest.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(body) as { query?: string; variables?: Record<string, unknown> };
      const query = parsed.query ?? "";

      if (query.includes("ReconcileIssueFacts")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "issue-inf-1286",
                state: { id: "state-thinking-uuid", name: "Thinking" },
                delegate: { id: "u-tdd" },
                assignee: null,
                team: {
                  states: {
                    nodes: [
                      { id: "state-todo-uuid", name: "To Do" },
                      { id: "state-thinking-uuid", name: "Thinking" },
                      { id: "state-done-uuid", name: "Done" },
                    ],
                  },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (query.includes("ReconcileNativeState")) {
        const id = (parsed.variables?.id as string) ?? "";
        const input = (parsed.variables?.input as Record<string, unknown>) ?? {};
        mutations.push({ id, input });
        return new Response(
          JSON.stringify({
            data: {
              issueUpdate: {
                success: true,
                issue: {
                  id,
                  state: { id: input.stateId },
                  delegate: input.delegateId ? { id: input.delegateId } : null,
                  assignee: input.assigneeId ? { id: input.assigneeId } : null,
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    });

    return { fetchFn, mutations };
  }

  it("resolves dead candidates via the injected listDeadCandidates and writes the corrective native state through raw fetch", async () => {
    const { fetchFn, mutations } = makeFetch();
    const dataPlane = createLinearReconcilerDataPlane({
      authToken: "Bearer test",
      fetchFn: fetchFn as unknown as typeof fetch,
      listDeadCandidates: () => [{ identifier: "INF-1286", connectorState: "write-tests" }],
    });

    const result = await runNativeStateReconcilerSweep(dataPlane);

    expect(result.corrected).toBe(1);
    expect(mutations).toHaveLength(1);
    expect(mutations[0].id).toBe("issue-inf-1286");
    expect(mutations[0].input).toEqual(
      expect.objectContaining({ stateId: "state-todo-uuid", delegateId: "u-tdd", assigneeId: null }),
    );
  });

  it("returns an empty ticket list — and issues no fetch calls — when there are no dead candidates", async () => {
    const { fetchFn } = makeFetch();
    const dataPlane = createLinearReconcilerDataPlane({
      authToken: "Bearer test",
      fetchFn: fetchFn as unknown as typeof fetch,
      listDeadCandidates: () => [],
    });

    const result = await runNativeStateReconcilerSweep(dataPlane);

    expect(result.corrected).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("skips a candidate whose issue facts cannot be read (null issue/state) without throwing", async () => {
    const fetchFn = jest.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(body) as { query?: string };
      if ((parsed.query ?? "").includes("ReconcileIssueFacts")) {
        return new Response(JSON.stringify({ data: { issue: null } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("unexpected query");
    });
    const dataPlane = createLinearReconcilerDataPlane({
      authToken: "Bearer test",
      fetchFn: fetchFn as unknown as typeof fetch,
      listDeadCandidates: () => [{ identifier: "GHOST-1", connectorState: "write-tests" }],
    });

    const result = await runNativeStateReconcilerSweep(dataPlane);

    expect(result.corrected).toBe(0);
    expect(result.failed).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Liveness surface
// ════════════════════════════════════════════════════════════════════════════

describe("liveness surface", () => {
  afterEach(() => {
    resetNativeStateReconcilerForTest();
  });

  it("defaults to not-scheduled with no prior result before registration", () => {
    resetNativeStateReconcilerForTest();
    const liveness = getNativeStateReconcilerLiveness();
    expect(liveness.scheduled).toBe(false);
    expect(liveness.lastResult).toBeNull();
  });

  it("registerNativeStateReconcilerCron marks scheduled=true immediately, before any tick fires", () => {
    resetNativeStateReconcilerForTest();
    const timer = registerNativeStateReconcilerCron({
      listTickets: async () => [],
      resolveNativeStateId: async () => "x",
      writeNativeState: async () => ({ success: true }),
      cadenceMs: 60_000,
    });

    const liveness = getNativeStateReconcilerLiveness();
    expect(liveness.scheduled).toBe(true);
    // lastRunAt is stamped at registration, not left at the epoch default.
    expect(new Date(liveness.lastRunAt).getTime()).toBeGreaterThan(0);

    clearInterval(timer);
  });

  it("resetNativeStateReconcilerForTest clears scheduled + lastResult back to defaults", () => {
    registerNativeStateReconcilerCron({
      listTickets: async () => [],
      resolveNativeStateId: async () => "x",
      writeNativeState: async () => ({ success: true }),
      cadenceMs: 60_000,
    }).unref?.();

    resetNativeStateReconcilerForTest();
    const liveness = getNativeStateReconcilerLiveness();
    expect(liveness.scheduled).toBe(false);
    expect(liveness.lastResult).toBeNull();
  });
});
