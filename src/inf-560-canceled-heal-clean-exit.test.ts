/**
 * INF-560 — Reconcile-sweep tail of INF-558. Two residuals INF-558 deferred:
 *
 *   Residual 1 — Canceled-path Linear facet heal.
 *     INF-558 healed only the native-`completed` zombie's Linear facets; a
 *     natively-Canceled/duplicate zombie got the local mirror heal + an
 *     operator alert but NO Linear write, because every governed dev-sprint
 *     terminal maps `native_state: done` and set-state'ing it to `done` would
 *     resurrect its native state Canceled → Done. INF-560 gives `setStateAtomic`
 *     a `nativeStateOverride` so the sweep can strip the stale `state:*` label +
 *     clear the delegate while keeping the ticket natively Canceled/Invalid.
 *
 *   Residual 2 — clean-exit governed edge (Grover ask #3).
 *     An agent woken onto a native-terminal zombie had only re-activating edges
 *     (`continue`/`escape`). INF-560 makes `complete` legal from ANY state when
 *     the native state is already terminal, routing (in B2) to a `__terminal_sync__`
 *     that syncs facets to `done` while preserving the native flavor.
 *
 * AC-to-test mapping:
 *   A1 (sweep, canceled): setStateFn called with target `done` + nativeStateOverride
 *      `"invalid"`, no operator-sync alert. RED on INF-558 (canceled path skipped
 *      the write and raised the alert).
 *   A2 (sweep, duplicate): same override path as canceled.
 *   A3 (sweep, completed): unchanged — no override (native `done`, idempotent).
 *   B  (primitive): setStateAtomic with nativeStateOverride writes the OVERRIDE
 *      native stateId, not the target state's native_state. RED on INF-558
 *      (option ignored → writes target's native_state = Done).
 *   C  (B1 legality): `complete` from an active state is allowed when native is
 *      terminal, and still rejected when it is not. RED on INF-558 (always
 *      rejected — the AI-1835 invariant).
 *   D  (B2 apply): `complete` on a native-canceled zombie routes to terminal-sync
 *      and writes the CANCELED native stateId (flavor preserved); on a native-done
 *      zombie it writes the DONE stateId (idempotent).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  runDelegationReconciliationSweep,
  type DelegationReconciliationOptions,
} from "./delegation-reconciliation-sweep.js";
import {
  setStateAtomic,
  checkWorkflowRules,
  applyStateTransition,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { clearAppliedState } from "./store/applied-state-store.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import type { EnrolledTicketsStore, EnrolledTicketRow } from "./store/enrolled-tickets-store.js";
import type { SetStateAtomicResult } from "./workflow-gate.js";

const AUTH = "Bearer test-token";
const TEAM_ID = "team-uuid";
const OLD = new Date(Date.now() - 30 * 60 * 1000).toISOString();

// ── Part A: sweep Residual-1 heal (injected setStateFn) ──────────────────────

interface MockTicket {
  id: string;
  identifier: string;
  labels: Array<{ id: string; name: string }>;
  delegateId: string | null;
  delegateName: string | null;
  stateType: string | null;
}

function makeSweepFetch(governed: MockTicket[]): typeof fetch {
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
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

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

function sweepOpts(overrides: Partial<DelegationReconciliationOptions>): DelegationReconciliationOptions {
  return {
    authToken: AUTH,
    operationalEventStore: new OperationalEventStore(":memory:"),
    alertBus: { notify: jest.fn() } as any,
    wakeFn: jest.fn(async () => {}) as any,
    ...overrides,
  } as DelegationReconciliationOptions;
}

describe("INF-560 A — sweep heals Canceled/duplicate zombies with native flavor preserved", () => {
  for (const flavor of ["canceled", "cancelled", "duplicate"]) {
    it(`A1/A2: a natively-${flavor} zombie is facet-synced with nativeStateOverride 'invalid'`, async () => {
      const ticket: MockTicket = {
        id: `issue-${flavor}`,
        identifier: `LSO-${flavor}`,
        labels: [
          { id: "l-wf", name: "wf:dev-sprint" },
          { id: "l-state", name: "state:product-definition" },
        ],
        delegateId: "astrid-uuid",
        delegateName: "astrid",
        stateType: flavor,
      };
      const setStateFn = jest.fn(
        async (): Promise<SetStateAtomicResult> => ({ ok: true, ticketId: ticket.identifier, from: "product-definition", to: "done" }),
      );
      const { store, markTerminal } = makeEnrolledStore({ [ticket.identifier]: { terminal: 0 } });
      const notify = jest.fn();
      const wakeFn = jest.fn(async () => {});

      const result = await runDelegationReconciliationSweep(
        sweepOpts({
          fetchFn: makeSweepFetch([ticket]),
          setStateFn: setStateFn as any,
          enrolledTicketsStore: store,
          alertBus: { notify } as any,
          wakeFn: wakeFn as any,
        }),
      );

      expect(setStateFn).toHaveBeenCalledTimes(1);
      const [id, target, delegate, , options] = setStateFn.mock.calls[0] as any[];
      expect(id).toBe(ticket.identifier);
      expect(target).toBe("done");
      expect(delegate).toBeNull();
      expect(options).toMatchObject({ force: true, nativeStateOverride: "invalid" });
      expect(markTerminal).toHaveBeenCalledWith(ticket.identifier, "out-of-band-terminal");
      // No operator-sync deferral alert anymore — the path self-heals.
      const titles = notify.mock.calls.map((c: any[]) => String((c[0] as any).title));
      expect(titles.some((t) => t.includes("operator sync"))).toBe(false);
      expect(wakeFn).not.toHaveBeenCalled();
      expect(result.facetHealed).toBe(1);
    });
  }

  it("A3: a natively-completed zombie is still healed WITHOUT an override (native done, idempotent)", async () => {
    const ticket: MockTicket = {
      id: "issue-completed",
      identifier: "LSO-done",
      labels: [
        { id: "l-wf", name: "wf:dev-sprint" },
        { id: "l-state", name: "state:product-definition" },
      ],
      delegateId: "astrid-uuid",
      delegateName: "astrid",
      stateType: "completed",
    };
    const setStateFn = jest.fn(
      async (): Promise<SetStateAtomicResult> => ({ ok: true, ticketId: "LSO-done", from: "product-definition", to: "done" }),
    );
    const { store } = makeEnrolledStore({ "LSO-done": { terminal: 0 } });

    await runDelegationReconciliationSweep(
      sweepOpts({
        fetchFn: makeSweepFetch([ticket]),
        setStateFn: setStateFn as any,
        enrolledTicketsStore: store,
      }),
    );

    expect(setStateFn).toHaveBeenCalledTimes(1);
    const [, target, , , options] = setStateFn.mock.calls[0] as any[];
    expect(target).toBe("done");
    expect((options as any).nativeStateOverride).toBeUndefined();
  });
});

// ── Parts B/C/D: primitive + gate (real fetch mock over a temp workflow def) ──

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, workflow:break-glass]
roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [linear:transition]
bodies:
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

const DEV_IMPL_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: code-review
  - id: code-review
    owner_role: dev
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const DONE_UUID = "state-done-uuid";
const CANCELED_UUID = "state-invalid-uuid";
const TEAM_STATES = [
  { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
  { id: "state-doing-uuid", name: "Doing", type: "started" },
  { id: "state-thinking-uuid", name: "Thinking", type: "started" },
  { id: DONE_UUID, name: "Done", type: "completed" },
  { id: CANCELED_UUID, name: "Canceled", type: "canceled" },
];
const TEAM_LABELS = [
  { id: "lbl-wf-dev-impl", name: "wf:dev-impl" },
  { id: "lbl-state-implementation", name: "state:implementation" },
  { id: "lbl-state-done", name: "state:done" },
];

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-560-test-"));
  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  const defFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(defFile, DEV_IMPL_YAML, "utf8");
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [
      { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c", clientSecret: "c", accessToken: "c", refreshToken: "c" },
      { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a", clientSecret: "a", accessToken: "a", refreshToken: "a" },
    ],
  }, null, 2), "utf8");

  for (const k of ["CAPABILITY_POLICY_PATH", "WORKFLOW_DEF_PATH", "WORKFLOW_DEFS_DIR", "AGENTS_FILE"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.CAPABILITY_POLICY_PATH = policyFile;
  process.env.WORKFLOW_DEF_PATH = defFile;
  process.env.WORKFLOW_DEFS_DIR = dir;
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Stateful Linear fetch mock covering every query the gate/primitive touch, and
 * capturing the ApplyAtomicTransition mutation so tests can assert the native
 * stateId that was written. `nativeType`/`labels` describe the issue's current
 * facets for read queries; the verify read echoes back the last written facets.
 */
function makeGateFetch(opts: {
  nativeType: string;
  labels: string[];
  delegateId?: string | null;
  identifier?: string;
}): { fetch: typeof globalThis.fetch; captured: { stateId?: string | null; delegateId?: unknown; labelIds?: unknown } } {
  const captured: { stateId?: string | null; delegateId?: unknown; labelIds?: unknown } = {};
  const identifier = opts.identifier ?? "AI-560";
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });

    if (body.includes("NativeState")) {
      return json({ data: { issue: { state: { type: opts.nativeType, name: opts.nativeType } } } });
    }
    if (body.includes("TeamStates")) {
      return json({ data: { team: { states: { nodes: TEAM_STATES } } } });
    }
    if (body.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: TEAM_LABELS } } } });
    }
    if (body.includes("IssueWithLabels")) {
      return json({ data: { issue: {
        id: "issue-internal-uuid",
        identifier,
        team: { id: TEAM_ID },
        labels: { nodes: opts.labels.map((name) => ({ id: `lbl-${name}`, name })) },
      } } });
    }
    if (body.includes("IssueContext")) {
      return json({ data: { issue: {
        identifier,
        labels: { nodes: opts.labels.map((name) => ({ name })) },
        delegate: opts.delegateId != null ? { id: opts.delegateId } : null,
      } } });
    }
    if (body.includes("VerifyTransitionWrite")) {
      // Echo the just-written facets so read-after-write verification passes.
      return json({ data: { issue: {
        labels: { nodes: [{ name: "state:done" }] },
        delegate: captured.delegateId != null ? { id: captured.delegateId } : null,
        state: { id: captured.stateId ?? null },
      } } });
    }
    if (body.includes("ApplyAtomicTransition")) {
      const vars = (JSON.parse(body).variables ?? {}) as Record<string, unknown>;
      captured.stateId = (vars.stateId as string | null) ?? null;
      captured.delegateId = vars.delegateId;
      captured.labelIds = vars.labelIds;
      return json({ data: { issueUpdate: { success: true } } });
    }
    // Default: label-only context.
    return json({ data: { issue: { labels: { nodes: opts.labels.map((name) => ({ name })) } } } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchFn, captured };
}

describe("INF-560 B — setStateAtomic nativeStateOverride writes the override native state", () => {
  let original: typeof globalThis.fetch;
  beforeEach(() => { resetWorkflowCache(); resetPolicyCache(); resetConfigHealth(); original = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = original; });

  it("writes the OVERRIDE native stateId (Canceled), not the target state's native_state (Done)", async () => {
    const { fetch: f, captured } = makeGateFetch({
      nativeType: "canceled",
      labels: ["wf:dev-impl", "state:implementation"],
      identifier: "AI-560B",
    });
    globalThis.fetch = f;

    const res = await setStateAtomic("AI-560B", "done", null, AUTH, {
      force: true,
      nativeStateOverride: "invalid",
    });

    expect(res.ok).toBe(true);
    // The decisive assertion: native flavor preserved — Canceled uuid, not Done.
    expect(captured.stateId).toBe(CANCELED_UUID);
    expect(captured.stateId).not.toBe(DONE_UUID);
    expect(captured.delegateId).toBeNull();
  });

  it("without an override, writes the target state's native_state (Done)", async () => {
    const { fetch: f, captured } = makeGateFetch({
      nativeType: "completed",
      labels: ["wf:dev-impl", "state:implementation"],
      identifier: "AI-560B2",
    });
    globalThis.fetch = f;

    const res = await setStateAtomic("AI-560B2", "done", null, AUTH, { force: true });

    expect(res.ok).toBe(true);
    expect(captured.stateId).toBe(DONE_UUID);
  });
});

describe("INF-560 C — checkWorkflowRules: `complete` clean-exit gated on native-terminal", () => {
  let original: typeof globalThis.fetch;
  beforeEach(() => { resetWorkflowCache(); resetPolicyCache(); resetConfigHealth(); original = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = original; });

  it("ALLOWS `complete` from an active state when the native state is terminal (Canceled)", async () => {
    const { fetch: f } = makeGateFetch({
      nativeType: "canceled",
      labels: ["wf:dev-impl", "state:implementation"],
      delegateId: null,
    });
    globalThis.fetch = f;

    const result = await checkWorkflowRules("complete", "issue-internal-uuid", AUTH, "charles");
    expect(result).toBeNull(); // allowed
  });

  it("still REJECTS `complete` from an active state when the native state is NOT terminal", async () => {
    const { fetch: f } = makeGateFetch({
      nativeType: "started",
      labels: ["wf:dev-impl", "state:implementation"],
      delegateId: null,
    });
    globalThis.fetch = f;

    const result = await checkWorkflowRules("complete", "issue-internal-uuid", AUTH, "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("complete");
  });
});

describe("INF-560 D — applyStateTransition: `complete` terminal-sync preserves native flavor", () => {
  let original: typeof globalThis.fetch;
  beforeEach(() => { resetWorkflowCache(); resetPolicyCache(); resetConfigHealth(); original = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = original; });

  it("native-Canceled zombie → terminal-sync writes the Canceled stateId (never Done)", async () => {
    clearAppliedState("AI-560D1");
    const markTerminal = jest.fn();
    const mirror = { getByTicketId: () => null, markTerminal, recordTransition: jest.fn() } as unknown as EnrolledTicketsStore;
    const { fetch: f, captured } = makeGateFetch({
      nativeType: "canceled",
      labels: ["wf:dev-impl", "state:implementation"],
      identifier: "AI-560D1",
    });
    globalThis.fetch = f;

    const result = await applyStateTransition("complete", "issue-internal-uuid", AUTH, {
      enrolledTicketsStore: mirror,
      operationalEventStore: new OperationalEventStore(":memory:"),
      bodyId: "charles",
    } as any);

    expect(result.status).toBe("applied");
    expect(result.code).toBe("terminal-sync");
    expect(captured.stateId).toBe(CANCELED_UUID);
    expect(captured.delegateId).toBeNull();
  });

  it("native-Done zombie → terminal-sync writes the Done stateId (idempotent)", async () => {
    clearAppliedState("AI-560D2");
    const mirror = { getByTicketId: () => null, markTerminal: jest.fn(), recordTransition: jest.fn() } as unknown as EnrolledTicketsStore;
    const { fetch: f, captured } = makeGateFetch({
      nativeType: "completed",
      labels: ["wf:dev-impl", "state:implementation"],
      identifier: "AI-560D2",
    });
    globalThis.fetch = f;

    const result = await applyStateTransition("complete", "issue-internal-uuid", AUTH, {
      enrolledTicketsStore: mirror,
      operationalEventStore: new OperationalEventStore(":memory:"),
      bodyId: "charles",
    } as any);

    expect(result.status).toBe("applied");
    expect(result.code).toBe("terminal-sync");
    expect(captured.stateId).toBe(DONE_UUID);
  });

  it("native-NOT-terminal → terminal-sync is refused (self-sufficient native re-verify, no write)", async () => {
    clearAppliedState("AI-560D3");
    const markTerminal = jest.fn();
    const mirror = { getByTicketId: () => null, markTerminal, recordTransition: jest.fn() } as unknown as EnrolledTicketsStore;
    const { fetch: f, captured } = makeGateFetch({
      nativeType: "started",
      labels: ["wf:dev-impl", "state:implementation"],
      identifier: "AI-560D3",
    });
    globalThis.fetch = f;

    const result = await applyStateTransition("complete", "issue-internal-uuid", AUTH, {
      enrolledTicketsStore: mirror,
      operationalEventStore: new OperationalEventStore(":memory:"),
      bodyId: "charles",
    } as any);

    // B2 re-verifies native-terminal in the handler (never trusts B1); a
    // non-terminal ticket is refused with no write and no terminal mark.
    expect(result.status).toBe("blocked");
    expect(result.code).toBe("native-state-not-terminal");
    expect(captured.stateId).toBeUndefined();
    expect(markTerminal).not.toHaveBeenCalled();
  });
});
