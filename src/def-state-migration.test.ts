/**
 * INF-1286 — Unit tests for def-state-migration.ts (AI-1914): the
 * workflow-def state-removal migration path.
 *
 * Covers:
 *   - planDefStateMigration: the forward (auto-migrate) decision and its
 *     no-op cases (still-valid state, ungoverned, no state label, unmapped
 *     removed state / strand).
 *   - validateDefStateRemovals: refuses activation of a def that silently
 *     strands a removed state.
 *   - runDefStateMigrationSweep: the forward path end-to-end (label swap +
 *     re-dispatch + operational event) and the already-migrated / no-op case,
 *     with the Linear API boundary mocked via a global fetch stub.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  planDefStateMigration,
  validateDefStateRemovals,
  runDefStateMigrationSweep,
  type DefStateMigrationSweepOptions,
} from "./def-state-migration.js";
import type { WorkflowDef } from "./workflow-gate.js";

const DEF: WorkflowDef = {
  id: "dev-impl",
  states: [
    { id: "write-tests", owner_role: "test-author" },
    { id: "code-review", owner_role: "cra" },
  ],
  migrations: { "old-intake": "write-tests" },
};

// ════════════════════════════════════════════════════════════════════════════
// planDefStateMigration — forward path + no-op cases
// ════════════════════════════════════════════════════════════════════════════

describe("planDefStateMigration", () => {
  it("returns a plan when the current state was removed and has a migrations mapping", () => {
    const plan = planDefStateMigration(["wf:dev-impl", "state:old-intake"], DEF);
    expect(plan).toEqual({ fromState: "old-intake", toState: "write-tests", ownerRole: "test-author" });
  });

  it("no-op: returns null for a ticket still at a live (non-removed) state", () => {
    expect(planDefStateMigration(["wf:dev-impl", "state:write-tests"], DEF)).toBeNull();
  });

  it("no-op (strand): returns null for a removed state with NO migrations mapping", () => {
    const defNoMapping: WorkflowDef = { ...DEF, migrations: {} };
    expect(planDefStateMigration(["wf:dev-impl", "state:old-intake"], defNoMapping)).toBeNull();
  });

  it("no-op: returns null for an ungoverned ticket (no wf:* label)", () => {
    expect(planDefStateMigration(["state:old-intake"], DEF)).toBeNull();
  });

  it("no-op: returns null for a governed ticket with no state:* label", () => {
    expect(planDefStateMigration(["wf:dev-impl"], DEF)).toBeNull();
  });

  it("omits ownerRole when the target state declares none", () => {
    const defNoOwner: WorkflowDef = {
      id: "dev-impl",
      states: [{ id: "write-tests" }],
      migrations: { "old-intake": "write-tests" },
    };
    const plan = planDefStateMigration(["wf:dev-impl", "state:old-intake"], defNoOwner);
    expect(plan).toEqual({ fromState: "old-intake", toState: "write-tests", ownerRole: undefined });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// validateDefStateRemovals — refuse silent stranding
// ════════════════════════════════════════════════════════════════════════════

describe("validateDefStateRemovals", () => {
  it("errors when a removed state has neither a mapping nor a strand acknowledgment", () => {
    const errors = validateDefStateRemovals(["old-intake"], { id: "dev-impl", states: [], migrations: {} });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/old-intake/);
  });

  it("is silent when the removed state has a migrations mapping", () => {
    const errors = validateDefStateRemovals(["old-intake"], DEF);
    expect(errors).toHaveLength(0);
  });

  it("is silent when the removed state is explicitly strand_acknowledged", () => {
    const def: WorkflowDef = { id: "dev-impl", states: [], strand_acknowledged: ["old-intake"] };
    const errors = validateDefStateRemovals(["old-intake"], def);
    expect(errors).toHaveLength(0);
  });

  it("is silent when the state is still present in the next def", () => {
    const errors = validateDefStateRemovals(["write-tests"], DEF);
    expect(errors).toHaveLength(0);
  });

  it("returns one error per unmapped/unacked removed state", () => {
    const def: WorkflowDef = { id: "dev-impl", states: [], migrations: { a: "x" }, strand_acknowledged: ["b"] };
    const errors = validateDefStateRemovals(["a", "b", "c", "d"], def);
    expect(errors).toHaveLength(2); // c and d are neither mapped nor acked
  });
});

// ════════════════════════════════════════════════════════════════════════════
// runDefStateMigrationSweep — forward path + already-migrated no-op, mocking
// the Linear API boundary via a global fetch stub.
// ════════════════════════════════════════════════════════════════════════════

interface MockTicket {
  id: string;
  identifier: string;
  labels: string[];
  teamId: string;
}

function makeFetch(tickets: MockTicket[]) {
  const labelUpdates: Array<{ id: string; labelIds: string[] }> = [];
  const labelIdByName = new Map<string, string>([
    ["wf:dev-impl", "lbl-wf"],
    ["state:old-intake", "lbl-old-intake"],
    ["state:write-tests", "lbl-write-tests"],
    ["state:code-review", "lbl-code-review"],
  ]);

  const fetchFn = jest.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(body) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";

    if (query.includes("WorkflowIssues")) {
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: tickets.map((t) => ({
                id: t.id,
                identifier: t.identifier,
                state: { name: "irrelevant" },
                labels: { nodes: t.labels.map((name) => ({ id: labelIdByName.get(name) ?? `lbl-${name}`, name })) },
                team: { id: t.teamId },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: { nodes: [...labelIdByName.entries()].map(([name, id]) => ({ id, name })) },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("UpdateLabels")) {
      const id = (parsed.variables?.id as string) ?? "";
      const labelIds = (parsed.variables?.labelIds as string[]) ?? [];
      labelUpdates.push({ id, labelIds });
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  });

  return { fetchFn, labelUpdates, labelIdByName };
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

function makeSweepOpts(
  fetchFn: typeof globalThis.fetch,
  overrides: Partial<DefStateMigrationSweepOptions> = {},
): { opts: DefStateMigrationSweepOptions; wakeFn: jest.Mock; events: unknown[] } {
  globalThis.fetch = fetchFn;
  const wakeFn = jest.fn(async (_agent: string, _identifier: string) => undefined);
  const events: unknown[] = [];
  const opts: DefStateMigrationSweepOptions = {
    authToken: "Bearer test",
    workflowRegistry: new Map([["dev-impl", DEF]]),
    wakeFn,
    operationalEventStore: { record: (e: unknown) => events.push(e) },
    ...overrides,
  };
  return { opts, wakeFn, events };
}

describe("runDefStateMigrationSweep — forward path", () => {
  it("migrates a ticket stranded at a removed state: swaps the label, re-dispatches, and emits an event", async () => {
    const { fetchFn, labelUpdates } = makeFetch([
      { id: "issue-1", identifier: "INF-OLD-1", labels: ["wf:dev-impl", "state:old-intake"], teamId: "team-a" },
    ]);
    const { opts, wakeFn, events } = makeSweepOpts(fetchFn as unknown as typeof globalThis.fetch);

    const result = await runDefStateMigrationSweep(opts);

    expect(result.migrated).toEqual([
      { ticketId: "issue-1", identifier: "INF-OLD-1", fromState: "old-intake", toState: "write-tests" },
    ]);
    expect(result.errors).toHaveLength(0);
    expect(labelUpdates).toHaveLength(1);
    expect(labelUpdates[0].id).toBe("issue-1");
    expect(labelUpdates[0].labelIds).toContain("lbl-write-tests");
    expect(labelUpdates[0].labelIds).not.toContain("lbl-old-intake");
    expect(wakeFn).toHaveBeenCalledTimes(1);
    expect(wakeFn.mock.calls[0][1]).toBe("INF-OLD-1");
    expect(events).toEqual([
      expect.objectContaining({ outcome: "def-state-migrated", key: "issue-1" }),
    ]);
  });
});

describe("runDefStateMigrationSweep — already-migrated / no-op case", () => {
  it("leaves a ticket already at a live (non-removed) state untouched", async () => {
    const { fetchFn, labelUpdates } = makeFetch([
      { id: "issue-2", identifier: "INF-LIVE-1", labels: ["wf:dev-impl", "state:write-tests"], teamId: "team-a" },
    ]);
    const { opts, wakeFn, events } = makeSweepOpts(fetchFn as unknown as typeof globalThis.fetch);

    const result = await runDefStateMigrationSweep(opts);

    expect(result.migrated).toHaveLength(0);
    expect(result.scanned).toBe(1);
    expect(labelUpdates).toHaveLength(0);
    expect(wakeFn).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("short-circuits with zero fetches when no registered def declares a migrations mapping", async () => {
    const { fetchFn } = makeFetch([]);
    const { opts } = makeSweepOpts(fetchFn as unknown as typeof globalThis.fetch, {
      workflowRegistry: new Map([["dev-impl", { id: "dev-impl", states: [] }]]),
    });

    const result = await runDefStateMigrationSweep(opts);

    expect(result.scanned).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("leaves an unmapped removed-state strand untouched (no auto-migration for a strand)", async () => {
    const defWithStrand: WorkflowDef = {
      id: "dev-impl",
      states: [{ id: "write-tests", owner_role: "test-author" }],
      migrations: { "some-other-removed-state": "write-tests" },
    };
    const { fetchFn, labelUpdates } = makeFetch([
      { id: "issue-3", identifier: "INF-STRAND-1", labels: ["wf:dev-impl", "state:unmapped-removed"], teamId: "team-a" },
    ]);
    const { opts, wakeFn } = makeSweepOpts(fetchFn as unknown as typeof globalThis.fetch, {
      workflowRegistry: new Map([["dev-impl", defWithStrand]]),
    });

    const result = await runDefStateMigrationSweep(opts);

    expect(result.migrated).toHaveLength(0);
    expect(labelUpdates).toHaveLength(0);
    expect(wakeFn).not.toHaveBeenCalled();
  });
});

describe("runDefStateMigrationSweep — failure paths", () => {
  it("records an error and a failure event when the target label cannot be resolved", async () => {
    const { fetchFn, labelUpdates } = makeFetch([
      { id: "issue-4", identifier: "INF-OLD-2", labels: ["wf:dev-impl", "state:old-intake"], teamId: "team-a" },
    ]);
    const { opts, wakeFn, events } = makeSweepOpts(fetchFn as unknown as typeof globalThis.fetch, {
      labelNameToId: () => null,
    });

    const result = await runDefStateMigrationSweep(opts);

    expect(result.migrated).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/could not resolve label UUID/i);
    expect(labelUpdates).toHaveLength(0);
    expect(wakeFn).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ outcome: "def-state-migration-failed" }),
    ]);
  });

  it("emits a failure event (no thrown error) when the label-swap mutation returns success:false", async () => {
    const fetchFn = jest.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(body) as { query?: string };
      const query = parsed.query ?? "";
      if (query.includes("WorkflowIssues")) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: "issue-5",
                    identifier: "INF-OLD-3",
                    state: { name: "x" },
                    labels: { nodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-old", name: "state:old-intake" }] },
                    team: { id: "team-a" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("UpdateLabels")) {
        return new Response(JSON.stringify({ data: { issueUpdate: { success: false } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected query: ${query}`);
    });
    const { opts, wakeFn, events } = makeSweepOpts(fetchFn as unknown as typeof globalThis.fetch, {
      labelNameToId: (name: string) => (name === "state:write-tests" ? "lbl-write-tests" : null),
    });

    const result = await runDefStateMigrationSweep(opts);

    expect(result.migrated).toHaveLength(0);
    expect(result.errors).toHaveLength(0); // no thrown error — applyLabelIds resolved false, not a throw
    expect(wakeFn).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ outcome: "def-state-migration-failed" }),
    ]);
  });
});
