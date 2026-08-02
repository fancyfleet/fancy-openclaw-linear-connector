/**
 * INF-993 — native Linear state reconciler for workflow-state + session liveness.
 *
 * FAILING tests written in the dev-impl write-tests state. Each test maps to the
 * ticket acceptance criteria captured in the visible AC section.
 *
 * Expected implementation surface:
 *   - runNativeStateReconcilerSweep(opts): Promise<NativeStateReconcilerResult>
 *
 * The reconciler is deliberately I/O-injected. It reads workflow state and
 * liveness facts from the connector, resolves native Linear state ids, performs
 * a single verified issueUpdate, and exposes liveness for /health.
 */

import { describe, it, expect, beforeAll, jest } from "@jest/globals";

/* eslint-disable @typescript-eslint/no-explicit-any */
let runNativeStateReconcilerSweep: any;

beforeAll(async () => {
  const mod = await import("./native-state-reconciler.js");
  ({ runNativeStateReconcilerSweep } = mod as any);
});

type ReconcileTicket = {
  identifier: string;
  issueId: string;
  workflow: "dev-impl";
  connectorState: string;
  nativeStateId: string;
  nativeStateName: string;
  delegateId: string | null;
  assigneeId: string | null;
  liveness:
    | { kind: "SESSION_DEAD" }
    | { kind: "LIVE_BUT_SLOW" }
    | { kind: "LIVE" };
  completionReceipt?: "merged-pr" | "deploy";
  nonEvidenceSignal?: "label-ahead" | "delegate-ahead" | "quiet-for-n-minutes";
};

const STATES = {
  todo: { id: "state-todo-uuid", name: "To Do" },
  thinking: { id: "state-thinking-uuid", name: "Thinking" },
  done: { id: "state-done-uuid", name: "Done" },
};

function ticket(overrides: Partial<ReconcileTicket> = {}): ReconcileTicket {
  return {
    identifier: "INF-993",
    issueId: "issue-inf-993",
    workflow: "dev-impl",
    connectorState: "write-tests",
    nativeStateId: STATES.thinking.id,
    nativeStateName: STATES.thinking.name,
    delegateId: "u-tdd",
    assigneeId: null,
    liveness: { kind: "SESSION_DEAD" },
    ...overrides,
  };
}

function makeOpts(tickets: ReconcileTicket[]) {
  const mutations: Array<{ issueId: string; input: Record<string, unknown> }> = [];
  const writeNativeState = jest.fn(async (issueId: string, input: Record<string, unknown>) => {
    mutations.push({ issueId, input });
    return {
      success: true,
      issue: {
        id: issueId,
        state: { id: input.stateId },
        delegate: input.delegateId === null ? null : { id: input.delegateId },
        assignee: input.assigneeId === null ? null : { id: input.assigneeId },
      },
    };
  });

  return {
    mutations,
    writeNativeState,
    opts: {
      listTickets: async () => tickets,
      resolveNativeStateId: async (stateName: string) => {
        const state = Object.values(STATES).find((s) => s.name === stateName);
        if (!state) throw new Error(`unknown state ${stateName}`);
        return state.id;
      },
      writeNativeState,
      now: () => 1_775_000_000_000,
    },
  };
}

describe("INF-993 AC1: SESSION_DEAD writes native state back to To Do and retains delegate", () => {
  it("writes stateId=To Do and preserves the existing delegate on confirmed-dead liveness", async () => {
    const { opts, mutations } = makeOpts([
      ticket({
        nativeStateId: STATES.thinking.id,
        nativeStateName: STATES.thinking.name,
        delegateId: "u-tdd",
        liveness: { kind: "SESSION_DEAD" },
      }),
    ]);

    const result = await runNativeStateReconcilerSweep(opts);

    expect(result.corrected).toBe(1);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toEqual({
      issueId: "issue-inf-993",
      input: expect.objectContaining({
        stateId: STATES.todo.id,
        delegateId: "u-tdd",
      }),
    });
  });
});

describe("INF-993 AC2: connector-ahead advances only on completion evidence", () => {
  it("does not advance native state from connector-ahead labels without a completion receipt", async () => {
    const { opts, mutations } = makeOpts([
      ticket({
        connectorState: "done",
        nativeStateId: STATES.todo.id,
        nativeStateName: STATES.todo.name,
        liveness: { kind: "LIVE" },
        nonEvidenceSignal: "label-ahead",
      }),
    ]);

    const result = await runNativeStateReconcilerSweep(opts);

    expect(result.corrected).toBe(0);
    expect(mutations).toHaveLength(0);
  });

  it("advances native state when connector-ahead has a merged PR or deploy receipt", async () => {
    const { opts, mutations } = makeOpts([
      ticket({
        connectorState: "done",
        nativeStateId: STATES.todo.id,
        nativeStateName: STATES.todo.name,
        liveness: { kind: "LIVE" },
        completionReceipt: "merged-pr",
      }),
    ]);

    const result = await runNativeStateReconcilerSweep(opts);

    expect(result.corrected).toBe(1);
    expect(mutations).toHaveLength(1);
    expect(mutations[0].input).toEqual(expect.objectContaining({ stateId: STATES.done.id }));
  });
});

describe("INF-993 AC3: live-but-slow is not a corrective trigger", () => {
  it("does not mutate native Linear state for live-but-slow sessions", async () => {
    const { opts, mutations } = makeOpts([
      ticket({
        nativeStateId: STATES.thinking.id,
        nativeStateName: STATES.thinking.name,
        liveness: { kind: "LIVE_BUT_SLOW" },
        nonEvidenceSignal: "quiet-for-n-minutes",
      }),
    ]);

    const result = await runNativeStateReconcilerSweep(opts);

    expect(result.corrected).toBe(0);
    expect(mutations).toHaveLength(0);
  });
});

describe("INF-993 AC4: native write is paired and verified so Linear cannot silently drop it", () => {
  it("pairs assigneeId in the same mutation and verifies the returned native state reflects the write", async () => {
    const { opts, mutations } = makeOpts([
      ticket({
        nativeStateId: STATES.thinking.id,
        nativeStateName: STATES.thinking.name,
        delegateId: "u-tdd",
        assigneeId: null,
        liveness: { kind: "SESSION_DEAD" },
      }),
    ]);

    await runNativeStateReconcilerSweep(opts);

    expect(mutations).toHaveLength(1);
    expect(mutations[0].input).toEqual(expect.objectContaining({
      stateId: STATES.todo.id,
      delegateId: "u-tdd",
      assigneeId: null,
    }));
  });

  it("reports a failed correction when Linear returns the pre-write native state", async () => {
    const writeNativeState = jest.fn(async (_issueId: string, input: Record<string, unknown>) => ({
      success: true,
      issue: {
        state: { id: STATES.thinking.id },
        delegate: { id: input.delegateId },
        assignee: null,
      },
    }));

    const result = await runNativeStateReconcilerSweep({
      ...makeOpts([ticket({ liveness: { kind: "SESSION_DEAD" } })]).opts,
      writeNativeState,
    });

    expect(writeNativeState).toHaveBeenCalled();
    expect(result.corrected).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].message).toMatch(/native state.*did not land/i);
  });
});
