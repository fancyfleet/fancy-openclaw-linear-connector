/**
 * AI-1775 — Failing tests for the bootstrap reconciliation sweep.
 *
 * Problem this solves: a dropped IssueLabel webhook leaves a ticket with a wf:*
 * label but no state:* label forever, with no recovery signal. The sweep is a
 * periodic safety net that finds and heals such tickets.
 *
 * AC-to-test mapping:
 *   AC1: wf-labeled ticket with no state:* label, past grace window →
 *        entry state applied + delegate set + wake dispatched (identical to
 *        the webhook bootstrap path)
 *   AC2: each heal emits exactly one deduped warning alert naming the ticket;
 *        a second sweep of the same ticket does not re-fire the alert
 *   AC3: ticket already enrolled (state:* present) is never touched;
 *        concurrent race — late-arriving Issue-update webhook fires bootstrap
 *        first, sweep finds state:* and skips → no double-bootstrap
 *   AC4: Linear API error during sweep → alert emitted rather than a crash;
 *        result is returned with errors populated
 *
 * These tests MUST be RED until the implementation lands in
 * src/bootstrap-reconciliation-sweep.ts.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import {
  runBootstrapReconciliationSweep,
  registerBootstrapReconciliationCron,
  type ReconciliationSweepOptions,
  type ReconciliationSweepResult,
} from "./bootstrap-reconciliation-sweep.js";
import { AlertBus } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";
import { resetWorkflowCache } from "./workflow-gate.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const TEAM_ID = "team-uuid-test";
const ISSUE_ID_UNENROLLED = "issue-uuid-unenrolled";
const ISSUE_ID_ENROLLED = "issue-uuid-enrolled";
const WF_LABEL_ID = "label-wf-dev-impl";
const WF_LABEL_NAME = "wf:dev-impl";
const STATE_INTAKE_LABEL_ID = "label-state-intake";
const DELEGATE_LINEAR_ID = "astrid-linear-uuid";

/** Minimal dev-impl workflow def for tests. */
const TEST_WORKFLOW_DEF = {
  id: "dev-impl",
  entry_state: "intake",
  states: [
    { id: "intake",         owner_role: "steward" },
    { id: "write-tests",    owner_role: "test-author" },
    { id: "implementation", owner_role: "dev" },
    { id: "done",           owner_role: undefined },
    { id: "escape",         owner_role: undefined },
  ],
};

const WORKFLOW_REGISTRY: Map<string, typeof TEST_WORKFLOW_DEF> = new Map([
  ["dev-impl", TEST_WORKFLOW_DEF],
]);

/** ISO timestamp older than the default 2 min grace window. */
const OLD_TIMESTAMP = new Date(Date.now() - 10 * 60 * 1000).toISOString();

/** ISO timestamp within the default 2 min grace window (just updated). */
const FRESH_TIMESTAMP = new Date(Date.now() - 30 * 1000).toISOString();

// ── AlertBus spy helper ────────────────────────────────────────────────────

function makeTestAlertBus(): { bus: AlertBus; alerts: Array<import("./alerts/alert-store.js").AlertInput> } {
  const collected: Array<import("./alerts/alert-store.js").AlertInput> = [];
  const store = new AlertStore(":memory:");
  const bus = new AlertBus({
    store,
    pushEnabled: false,
    now: () => new Date(),
  });
  // Wrap notify to record calls
  const originalNotify = bus.notify.bind(bus);
  jest.spyOn(bus, "notify").mockImplementation((alert) => {
    collected.push(alert);
    originalNotify(alert);
  });
  return { bus, alerts: collected };
}

// ── Fetch mock helpers ─────────────────────────────────────────────────────

interface FetchScenario {
  /** Tickets returned by the unenrolled-search query. */
  unenrolledTickets?: Array<{
    id: string;
    identifier: string;
    updatedAt: string;
    labelNodes: Array<{ id: string; name: string }>;
    delegateId?: string | null;
    teamId: string;
  }>;
  /** Whether the issueUpdate mutation returns success. */
  mutationSuccess?: boolean;
  /** If true, the query fetch throws a network error. */
  networkError?: boolean;
}

function makeReconciliationFetch(scenario: FetchScenario): typeof fetch {
  const {
    unenrolledTickets = [],
    mutationSuccess = true,
    networkError = false,
  } = scenario;

  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (networkError) {
      throw new Error("simulated network error");
    }

    const body = typeof init?.body === "string" ? init.body : "";

    // ── Unenrolled-ticket search query ─────────────────────────────────────
    // The sweep queries for wf:* tickets with no state:* label.
    if (
      body.includes("wf:") ||
      body.includes("WorkflowIssues") ||
      body.includes("UnenrolledTickets") ||
      body.includes("BootstrapReconciliation")
    ) {
      const nodes = unenrolledTickets.map((t) => ({
        id: t.id,
        identifier: t.identifier,
        updatedAt: t.updatedAt,
        labels: { nodes: t.labelNodes },
        delegate: t.delegateId ? { id: t.delegateId } : null,
        team: { id: t.teamId },
        title: `Ticket ${t.identifier}`,
      }));
      return new Response(
        JSON.stringify({ data: { issues: { nodes } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Team labels lookup (to resolve state:intake → UUID) ───────────────
    if (body.includes("TeamLabels") || (body.includes("labels") && body.includes(TEAM_ID))) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: STATE_INTAKE_LABEL_ID, name: "state:intake" },
                  { id: WF_LABEL_ID, name: WF_LABEL_NAME },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── issueUpdate mutation ───────────────────────────────────────────────
    if (body.includes("issueUpdate") || body.includes("IssueUpdate")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: mutationSuccess } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── IssueWithLabels re-fetch (maybeBootstrapWorkflow reads issue context) ─
    if (body.includes("IssueWithLabels") || body.includes("IssueContext")) {
      // Return the first matching unenrolled ticket's context
      const ticket = unenrolledTickets[0];
      if (ticket) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: ticket.id,
                identifier: ticket.identifier,
                title: `Ticket ${ticket.identifier}`,
                team: { id: ticket.teamId },
                labels: { nodes: ticket.labelNodes },
                delegate: ticket.delegateId ? { id: ticket.delegateId } : null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────

let tmpDir: string;
let savedFetch: typeof globalThis.fetch;
let savedWorkflowDefsDir: string | undefined;

/** Minimal dev-impl workflow YAML for file-based registry load (cron tests). */
const DEV_IMPL_YAML = `id: dev-impl
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: thinking
  - id: write-tests
    owner_role: test-author
    native_state: thinking
  - id: implementation
    owner_role: dev
    native_state: doing
  - id: done
    native_state: done
  - id: escape
    native_state: invalid
`;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-reconciliation-test-"));
  fs.writeFileSync(path.join(tmpDir, "dev-impl.yaml"), DEV_IMPL_YAML);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedWorkflowDefsDir = process.env.WORKFLOW_DEFS_DIR;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedWorkflowDefsDir === undefined) delete process.env.WORKFLOW_DEFS_DIR;
  else process.env.WORKFLOW_DEFS_DIR = savedWorkflowDefsDir;
  resetWorkflowCache();
  jest.restoreAllMocks();
});

// ── AC1: unenrolled ticket past grace window → bootstrapped ───────────────

describe("AC1: wf-labeled ticket with no state:* past grace window → bootstrapped", () => {
  it("applies entry state label + sets delegate for an unenrolled ticket", async () => {
    const mutationCalls: string[] = [];
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("issueUpdate") || body.includes("IssueUpdate")) {
        mutationCalls.push(body);
      }
      return makeReconciliationFetch({
        unenrolledTickets: [
          {
            id: ISSUE_ID_UNENROLLED,
            identifier: "AI-1773",
            updatedAt: OLD_TIMESTAMP,
            labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
            delegateId: null,
            teamId: TEAM_ID,
          },
        ],
      })(url, init);
    };

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as Map<string, Parameters<typeof runBootstrapReconciliationSweep>[0]["workflowRegistry"] extends Map<string, infer V> ? V : never>,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    expect(result.healed).toBe(1);
    expect(result.errors).toHaveLength(0);

    // At least one issueUpdate mutation was issued (to add state:intake label + delegate)
    expect(mutationCalls.length).toBeGreaterThanOrEqual(1);
    const combinedMutations = mutationCalls.join("\n");
    // The state:intake label ID should appear in the mutation payload
    expect(combinedMutations).toContain(STATE_INTAKE_LABEL_ID);

    // A wake was dispatched to the first-owner delegate
    expect(wakeDispatches).toHaveLength(1);
    expect(wakeDispatches[0].ticketIdentifier).toBe("AI-1773");
  });

  it("counts the ticket as scanned", async () => {
    globalThis.fetch = makeReconciliationFetch({
      unenrolledTickets: [
        {
          id: ISSUE_ID_UNENROLLED,
          identifier: "AI-1773",
          updatedAt: OLD_TIMESTAMP,
          labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
          delegateId: null,
          teamId: TEAM_ID,
        },
      ],
    });

    const { bus } = makeTestAlertBus();
    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
      wakeFn: async () => {},
    });

    expect(result.scanned).toBe(1);
  });

  it("skips a ticket within the grace window", async () => {
    const mutationCalls: string[] = [];
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("issueUpdate") || body.includes("IssueUpdate")) {
        mutationCalls.push(body);
      }
      return makeReconciliationFetch({
        unenrolledTickets: [
          {
            id: ISSUE_ID_UNENROLLED,
            identifier: "AI-1773",
            updatedAt: FRESH_TIMESTAMP,   // <— within grace window
            labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
            delegateId: null,
            teamId: TEAM_ID,
          },
        ],
      })(url, init);
    };

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      graceWindowMs: 2 * 60 * 1000,   // 2 min
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.healed).toBe(0);
    expect(result.withinGrace).toBe(1);
    expect(mutationCalls).toHaveLength(0);
    expect(wakeDispatches).toHaveLength(0);
  });

  it("respects a configurable grace window", async () => {
    // A ticket 90 seconds old, grace = 60 s → should heal
    const now = Date.now();
    const updatedAt = new Date(now - 90_000).toISOString();
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      unenrolledTickets: [
        {
          id: ISSUE_ID_UNENROLLED,
          identifier: "AI-1773",
          updatedAt,
          labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
          delegateId: null,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      graceWindowMs: 60_000,           // 60 s
      nowMs: now,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    expect(result.healed).toBe(1);
    expect(wakeDispatches).toHaveLength(1);
  });
});

// ── AC2: each heal emits exactly one deduped warning alert ────────────────

describe("AC2: each heal emits exactly one deduped warning alert naming the ticket", () => {
  it("emits a warning alert with kind bootstrap-reconciled after healing", async () => {
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      unenrolledTickets: [
        {
          id: ISSUE_ID_UNENROLLED,
          identifier: "AI-1773",
          updatedAt: OLD_TIMESTAMP,
          labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
          delegateId: null,
          teamId: TEAM_ID,
        },
      ],
    });

    await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
      wakeFn: async () => {},
    });

    const reconcileAlerts = alerts.filter((a) => a.source === "bootstrap-reconciled");
    expect(reconcileAlerts.length).toBeGreaterThanOrEqual(1);
    expect(reconcileAlerts[0].severity).toBe("warning");
    // Alert must name the ticket
    const titleOrDetail = reconcileAlerts[0].title + JSON.stringify(reconcileAlerts[0].detail ?? "");
    expect(titleOrDetail).toContain("AI-1773");
  });

  it("emits separate alerts for separate healed tickets", async () => {
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({
      unenrolledTickets: [
        {
          id: "issue-uuid-a",
          identifier: "AI-0001",
          updatedAt: OLD_TIMESTAMP,
          labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
          delegateId: null,
          teamId: TEAM_ID,
        },
        {
          id: "issue-uuid-b",
          identifier: "AI-0002",
          updatedAt: OLD_TIMESTAMP,
          labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
          delegateId: null,
          teamId: TEAM_ID,
        },
      ],
    });

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
      wakeFn: async () => {},
    });

    expect(result.healed).toBe(2);
    const reconcileAlerts = alerts.filter((a) => a.source === "bootstrap-reconciled");
    // One alert per ticket healed (dedup key is per-ticket, so two distinct tickets → two alerts)
    expect(reconcileAlerts.length).toBeGreaterThanOrEqual(2);
    const identifiers = reconcileAlerts.map((a) => a.ticket ?? a.title).join(" ");
    expect(identifiers).toContain("AI-0001");
    expect(identifiers).toContain("AI-0002");
  });

  it("deduplicates repeated alerts for the same ticket across sweep runs", async () => {
    const store = new AlertStore(":memory:");
    const { bus, alerts } = makeTestAlertBus();
    const sharedBus = new AlertBus({ store, pushEnabled: false });

    const opts: ReconciliationSweepOptions = {
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: sharedBus,
      wakeFn: async () => {},
    };

    globalThis.fetch = makeReconciliationFetch({
      unenrolledTickets: [
        {
          id: ISSUE_ID_UNENROLLED,
          identifier: "AI-1773",
          updatedAt: OLD_TIMESTAMP,
          labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
          delegateId: null,
          teamId: TEAM_ID,
        },
      ],
    });

    // First sweep
    await runBootstrapReconciliationSweep(opts);
    const firstStore = store.query({ source: "bootstrap-reconciled" });
    expect(firstStore.length).toBe(1);

    // Second sweep — same ticket still returned (simulates sweep before webhook lands)
    await runBootstrapReconciliationSweep(opts);
    const secondStore = store.query({ source: "bootstrap-reconciled" });
    // Still 1 row, count incremented (suppressed = folded into burst, NOT a new row)
    expect(secondStore.length).toBe(1);
    expect(secondStore[0].count).toBeGreaterThanOrEqual(2);

    void alerts; // used to ensure ts does not tree-shake the import
    store.close();
  });
});

// ── AC3: enrolled tickets are never touched; race-safe double-bootstrap ───

describe("AC3: enrolled ticket (state:* present) never touched; no double-bootstrap", () => {
  it("skips a ticket that already has a state:* label", async () => {
    const mutationCalls: string[] = [];
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("issueUpdate") || body.includes("IssueUpdate")) {
        mutationCalls.push(body);
      }
      // The sweep query only returns unenrolled tickets — return empty set
      return makeReconciliationFetch({ unenrolledTickets: [] })(url, init);
    };

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    // Nothing to heal — enrolled ticket not surfaced by sweep query
    expect(result.healed).toBe(0);
    expect(mutationCalls).toHaveLength(0);
    expect(wakeDispatches).toHaveLength(0);
  });

  it("does not double-bootstrap when the ticket gains state:* between query and heal", async () => {
    // Scenario: query returns unenrolled ticket, but by the time we issue
    // the issueUpdate, the ticket already has state:intake (webhook landed
    // while sweep was running). The issueUpdateAtomic in maybeBootstrapWorkflow's
    // core checks the idempotency guard — the existing state:* label prevents
    // double-bootstrap.
    const mutationCalls: string[] = [];
    const wakeDispatches: string[] = [];
    const { bus } = makeTestAlertBus();

    let callCount = 0;
    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      callCount++;

      // First call (sweep query): return ticket as unenrolled
      if (callCount === 1 || body.includes("wf:") || body.includes("UnenrolledTickets") || body.includes("BootstrapReconciliation")) {
        if (!body.includes("issueUpdate") && !body.includes("IssueUpdate") && !body.includes("IssueWithLabels")) {
          return makeReconciliationFetch({
            unenrolledTickets: [
              {
                id: ISSUE_ID_UNENROLLED,
                identifier: "AI-1773",
                updatedAt: OLD_TIMESTAMP,
                labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
                delegateId: null,
                teamId: TEAM_ID,
              },
            ],
          })(url, init);
        }
      }

      // IssueWithLabels re-fetch (during bootstrap): return ticket NOW with state:intake
      // (simulates webhook racing ahead and adding the label)
      if (body.includes("IssueWithLabels") || body.includes("IssueContext")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: ISSUE_ID_UNENROLLED,
                identifier: "AI-1773",
                title: "AI-1773 ticket",
                team: { id: TEAM_ID },
                labels: {
                  nodes: [
                    { id: WF_LABEL_ID, name: WF_LABEL_NAME },
                    { id: STATE_INTAKE_LABEL_ID, name: "state:intake" },  // already enrolled!
                  ],
                },
                delegate: { id: DELEGATE_LINEAR_ID },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (body.includes("issueUpdate") || body.includes("IssueUpdate")) {
        mutationCalls.push(body);
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    // state:* idempotency check in maybeBootstrapWorkflow core must prevent
    // the issueUpdate mutation from firing when state:intake is already present
    const stateMutations = mutationCalls.filter((b) => b.includes(STATE_INTAKE_LABEL_ID));
    expect(stateMutations).toHaveLength(0);

    // No wake for an already-enrolled ticket
    expect(wakeDispatches).toHaveLength(0);
  });
});

// ── INF-497: terminal workflow label + active native state → reconciled ──────

describe("INF-497: Pass 3 reconciles terminal-label / active-native-state mismatch", () => {
  const ISSUE_ID_MISMATCH = "issue-uuid-inf496-shape";
  const DONE_STATE_ID = "team-done-state-uuid";

  /**
   * Fetch mock for the INF-496 shape: a `wf:task` + `state:done` ticket whose
   * native Linear state is still `To Do` (type unstarted) with a null delegate.
   * `nativeType` lets a test override the native state type to exercise the
   * skip guards (already-completed / canceled).
   */
  function makeMismatchFetch(opts: {
    mutationCalls: string[];
    nativeType?: string;
    nativeName?: string;
    completedStates?: Array<{ id: string; name: string; type: string; position: number }>;
    mutationSuccess?: boolean;
  }): typeof fetch {
    const {
      mutationCalls,
      nativeType = "unstarted",
      nativeName = "To Do",
      completedStates = [{ id: DONE_STATE_ID, name: "Done", type: "completed", position: 3 }],
      mutationSuccess = true,
    } = opts;

    return async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";

      // Native state + delegate lookup (queryEnrolledTicketState)
      if (body.includes("IssueContextSweep")) {
        return new Response(
          JSON.stringify({
            data: { issue: { id: ISSUE_ID_MISMATCH, state: { id: "todo-state-uuid", name: nativeName, type: nativeType }, delegate: null } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Team completed-state resolution (queryTeamCompletedStateId)
      if (body.includes("TeamCompletedState")) {
        return new Response(
          JSON.stringify({ data: { team: { states: { nodes: completedStates } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Reconcile mutation
      if (body.includes("issueUpdate") || body.includes("IssueUpdate")) {
        mutationCalls.push(body);
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: mutationSuccess } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Candidate sweep query
      if (body.includes("BootstrapReconciliation") || body.includes("wf:")) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: ISSUE_ID_MISMATCH,
                    identifier: "INF-496",
                    updatedAt: OLD_TIMESTAMP,
                    labels: { nodes: [{ id: "label-wf-task", name: "wf:task" }, { id: "label-state-done", name: "state:done" }] },
                    delegate: null,
                    team: { id: TEAM_ID },
                    title: "Ticket INF-496",
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
  }

  it("pushes native state to the team completed state, clears delegate, and leaves labels untouched", async () => {
    const mutationCalls: string[] = [];
    const { bus, alerts } = makeTestAlertBus();
    globalThis.fetch = makeMismatchFetch({ mutationCalls });

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
    });

    expect(result.healed).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Exactly one reconcile mutation, targeting the completed state + clearing delegate.
    expect(mutationCalls).toHaveLength(1);
    const mutation = mutationCalls[0];
    expect(mutation).toContain(DONE_STATE_ID);
    expect(mutation).toContain("delegateId");
    // Must NOT touch labels — the workflow record is already terminal and correct.
    expect(mutation).not.toContain("labelIds");

    // Audited via the alert bus, not a ticket comment.
    const reconcileAlerts = alerts.filter((a) => a.title.includes("reconciled terminal-label"));
    expect(reconcileAlerts).toHaveLength(1);
    expect(reconcileAlerts[0].ticket).toBe("INF-496");
  });

  it("does NOT force-complete a ticket whose native state is already canceled", async () => {
    const mutationCalls: string[] = [];
    const { bus } = makeTestAlertBus();
    globalThis.fetch = makeMismatchFetch({ mutationCalls, nativeType: "canceled", nativeName: "Canceled" });

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
    });

    expect(result.healed).toBe(0);
    expect(mutationCalls).toHaveLength(0);
  });

  it("does nothing when the native state is already completed (Pass 2's domain)", async () => {
    const mutationCalls: string[] = [];
    const { bus } = makeTestAlertBus();
    // native already completed + no merged PR → Pass 2 skips, Pass 3 skips.
    globalThis.fetch = makeMismatchFetch({ mutationCalls, nativeType: "completed", nativeName: "Done" });

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
    });

    expect(result.healed).toBe(0);
    expect(mutationCalls).toHaveLength(0);
  });

  it("records an error and does not heal when the team has no completed state", async () => {
    const mutationCalls: string[] = [];
    const { bus } = makeTestAlertBus();
    globalThis.fetch = makeMismatchFetch({ mutationCalls, completedStates: [] });

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
    });

    expect(result.healed).toBe(0);
    expect(mutationCalls).toHaveLength(0);
    expect(result.errors.some((e) => e.includes("no completed state"))).toBe(true);
  });
});

// ── INF-588: Pass 3 close of a natively-terminal ENROLLED ticket ──────────────
//
// The mirror-image gap Astrid gated on. Pass 3's `closeEnrolledTicket` strips
// the stale wf:*/state:* facets off a ticket a human dragged to a native
// terminal state (canceled/duplicate) while it still carries a non-terminal
// state:* label + delegate. But Linear RETIRES such an entity and refuses every
// mutation ("Entity is retired: issue ↳ Could not modify retired issue"). INF-588
// teaches `closeEnrolledTicket` to return a three-way outcome so Pass 3 can:
//   - "retired": recognize the refusal as terminal-acknowledged — no error, no
//                alert, no retry (the facets are un-healable via API and inert).
//   - "failed":  keep surfacing a genuine (non-retired) mutation failure as a
//                retryable error, so an over-broad /retired/ match cannot silently
//                swallow it.
describe("INF-588: Pass 3 close of a natively-terminal enrolled ticket", () => {
  const STATE_IMPL_LABEL_ID = "label-state-implementation";

  /**
   * Fetch mock for an ENROLLED ticket (wf:dev-impl + state:implementation +
   * delegate) whose native Linear state is terminal (canceled/duplicate). Only
   * Pass 3 acts on it: Pass 1 skips (has state:*), Pass 2 skips (no wakeFn),
   * Pass 4 skips (no state:done). `closeMutationResponse` is what the
   * CloseEnrolledTicket mutation returns, letting a test drive the retired vs.
   * failed outcome.
   */
  function makeEnrolledTerminalFetch(opts: {
    closeMutationResponse: unknown;
    closeMutationCalls: string[];
    nativeType?: string;
    nativeName?: string;
  }): typeof fetch {
    const {
      closeMutationResponse,
      closeMutationCalls,
      nativeType = "canceled",
      nativeName = "Invalid",
    } = opts;

    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    return async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";

      // Native state + delegate lookup (queryEnrolledTicketState)
      if (body.includes("IssueContextSweep")) {
        return json({
          data: {
            issue: {
              id: ISSUE_ID_ENROLLED,
              state: { id: "native-terminal-state-uuid", name: nativeName, type: nativeType },
              delegate: { id: DELEGATE_LINEAR_ID },
            },
          },
        });
      }

      // Label re-fetch for the facet strip (closeEnrolledTicket)
      if (body.includes("IssueWithLabelsForClose")) {
        return json({
          data: {
            issue: {
              id: ISSUE_ID_ENROLLED,
              identifier: "AI-2628",
              team: { id: TEAM_ID },
              labels: {
                nodes: [
                  { id: WF_LABEL_ID, name: WF_LABEL_NAME },
                  { id: STATE_IMPL_LABEL_ID, name: "state:implementation" },
                ],
              },
            },
          },
        });
      }

      // The facet-strip mutation — the point of the test. Matched by its named
      // operation so it never collides with the candidate query.
      if (body.includes("CloseEnrolledTicket")) {
        closeMutationCalls.push(body);
        return json(closeMutationResponse);
      }

      // Candidate sweep query
      if (body.includes("BootstrapReconciliation")) {
        return json({
          data: {
            issues: {
              nodes: [
                {
                  id: ISSUE_ID_ENROLLED,
                  identifier: "AI-2628",
                  updatedAt: OLD_TIMESTAMP,
                  labels: {
                    nodes: [
                      { id: WF_LABEL_ID, name: WF_LABEL_NAME },
                      { id: STATE_IMPL_LABEL_ID, name: "state:implementation" },
                    ],
                  },
                  delegate: { id: DELEGATE_LINEAR_ID },
                  team: { id: TEAM_ID },
                  title: "Ticket AI-2628",
                  state: { name: nativeName, type: nativeType },
                },
              ],
            },
          },
        });
      }

      return json({ data: {} });
    };
  }

  /** The documented Linear refusal on a retired entity (from the ticket logs). */
  const RETIRED_REFUSAL = {
    data: { issueUpdate: null },
    errors: [{ message: "Entity is retired: issue\nCould not modify retired issue." }],
  };

  it("treats the retired-entity refusal as terminal-acknowledged — no error, no alert, no heal", async () => {
    const closeMutationCalls: string[] = [];
    const { bus, alerts } = makeTestAlertBus();
    globalThis.fetch = makeEnrolledTerminalFetch({
      closeMutationResponse: RETIRED_REFUSAL,
      closeMutationCalls,
      nativeType: "canceled",
      nativeName: "Invalid",
    });

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
    });

    // The strip mutation WAS attempted (Pass 3 reached closeEnrolledTicket)...
    expect(closeMutationCalls).toHaveLength(1);
    // ...but the retired refusal is acknowledged, not treated as a failure:
    expect(result.healed).toBe(0);
    expect(result.errors).toHaveLength(0);
    // No alert of any kind — re-reporting an un-healable ticket every cadence is
    // exactly the noise INF-588 removes.
    expect(alerts).toHaveLength(0);
  });

  it("acknowledges a native DUPLICATE retirement the same way", async () => {
    const closeMutationCalls: string[] = [];
    const { bus, alerts } = makeTestAlertBus();
    globalThis.fetch = makeEnrolledTerminalFetch({
      closeMutationResponse: RETIRED_REFUSAL,
      closeMutationCalls,
      nativeType: "duplicate",
      nativeName: "Duplicate",
    });

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
    });

    expect(closeMutationCalls).toHaveLength(1);
    expect(result.healed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it("does NOT swallow an unrelated (non-retired) mutation failure — surfaces it as a retryable error", async () => {
    const closeMutationCalls: string[] = [];
    const { bus } = makeTestAlertBus();
    // A generic failure whose message does NOT match /retired/. If the guard's
    // regex were over-broad this would be silently swallowed as "retired" — the
    // precise failure class Astrid gated on. It must remain a surfaced error.
    globalThis.fetch = makeEnrolledTerminalFetch({
      closeMutationResponse: {
        data: { issueUpdate: null },
        errors: [{ message: "Rate limited: too many requests, please retry" }],
      },
      closeMutationCalls,
      nativeType: "canceled",
      nativeName: "Invalid",
    });

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
    });

    expect(closeMutationCalls).toHaveLength(1);
    expect(result.healed).toBe(0);
    // The failure is surfaced (retryable next cadence), not acknowledged away.
    expect(result.errors.some((e) => e.includes("close enrolled mutation failed") && e.includes("AI-2628"))).toBe(true);
  });

  it("also treats a plain success:false (no error payload) as a retryable failure, not retired", async () => {
    const closeMutationCalls: string[] = [];
    const { bus } = makeTestAlertBus();
    globalThis.fetch = makeEnrolledTerminalFetch({
      closeMutationResponse: { data: { issueUpdate: { success: false } } },
      closeMutationCalls,
      nativeType: "canceled",
      nativeName: "Invalid",
    });

    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
    });

    expect(closeMutationCalls).toHaveLength(1);
    expect(result.healed).toBe(0);
    expect(result.errors.some((e) => e.includes("close enrolled mutation failed"))).toBe(true);
  });
});

// ── AC4: Linear API failure → alert emitted, no crash ────────────────────

describe("AC4: Linear API error → alert rather than crash", () => {
  it("catches fetch errors and returns result with populated errors array", async () => {
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({ networkError: true });

    // The sweep must not throw on fetch errors — errors are captured in the result.
    const result = await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
      wakeFn: async () => {},
    });

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("emits an alert when the query fails", async () => {
    const { bus, alerts } = makeTestAlertBus();

    globalThis.fetch = makeReconciliationFetch({ networkError: true });

    await runBootstrapReconciliationSweep({
      authToken: "Bearer test-token",
      workflowRegistry: WORKFLOW_REGISTRY as never,
      alertBus: bus,
      wakeFn: async () => {},
    });

    // Sweep failure must emit at least one alert (warning or critical)
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const severities = alerts.map((a) => a.severity);
    expect(severities.some((s) => s === "warning" || s === "critical")).toBe(true);
  });
});

// ── registerBootstrapReconciliationCron: registration shape ──────────────

describe("registerBootstrapReconciliationCron", () => {
  it("returns a NodeJS.Timeout and does not throw on registration", () => {
    expect(() => {
      const timer = registerBootstrapReconciliationCron({ authToken: "test-token", intervalMs: 10_000 });
      clearInterval(timer);
    }).not.toThrow();
  });

  it("respects intervalMs override from options", () => {
    // Just verify registration doesn't explode with a short interval
    const timer = registerBootstrapReconciliationCron({ authToken: "test-token", intervalMs: 500 });
    expect(timer).toBeDefined();
    clearInterval(timer);
  });

  it("requires authToken — empty token logs a warning but still registers", () => {
    // The caller (index.ts) is responsible for resolving the token; the
    // function logs but does not throw so a misconfigured deploy still
    // starts and the warning is visible in logs.
    expect(() => {
      const timer = registerBootstrapReconciliationCron({ authToken: "", intervalMs: 10_000 });
      clearInterval(timer);
    }).not.toThrow();
  });
});

// ── Cron entry-point behavioral test (AC1 + AC2 through the prod path) ─────
//
// This is the test that closes the exact gap from AC-validation round 2:
// the unit tests above inject alertBus/wakeFn directly into
// runBootstrapReconciliationSweep, but nothing asserted the *cron entry*
// actually forwards those collaborators. A heal through the cron must produce
// exactly one alert AND one wake — string-matching index.ts is not enough.

describe("registerBootstrapReconciliationCron: behavioral — heal produces alert + wake", () => {
  beforeEach(() => {
    // Point the workflow registry at our test YAML so applyBootstrapToIssue
    // can resolve the dev-impl workflow without a caller-injected registry.
    process.env.WORKFLOW_DEFS_DIR = tmpDir;
    resetWorkflowCache();
  });

  it("a heal through the cron entry point produces at least one alert and one wake dispatch", async () => {
    const { bus, alerts } = makeTestAlertBus();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];

    // Stub the Linear API to return one unenrolled ticket past the grace window
    globalThis.fetch = makeReconciliationFetch({
      unenrolledTickets: [
        {
          id: ISSUE_ID_UNENROLLED,
          identifier: "AI-9999",
          updatedAt: OLD_TIMESTAMP,
          labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
          delegateId: null,
          teamId: TEAM_ID,
        },
      ],
    });

    // Register with a short interval + both collaborators wired
    const timer = registerBootstrapReconciliationCron({
      authToken: "Bearer test-token",
      intervalMs: 50,
      alertBus: bus,
      wakeFn: async (agentName, ticketIdentifier) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    });

    // Wait for the cron to tick at least once
    await new Promise((resolve) => setTimeout(resolve, 150));
    clearInterval(timer);

    // AC1: at least one wake dispatched — the cron forwarded wakeFn to the sweep
    expect(wakeDispatches.length).toBeGreaterThanOrEqual(1);
    expect(wakeDispatches[0].ticketIdentifier).toBe("AI-9999");

    // AC2: at least one bootstrap-reconciled alert — the cron forwarded alertBus
    const reconcileAlerts = alerts.filter((a) => a.source === "bootstrap-reconciled");
    expect(reconcileAlerts.length).toBeGreaterThanOrEqual(1);
    expect(reconcileAlerts[0].severity).toBe("warning");
  });

  it("does not dispatch a wake when no unenrolled tickets are found", async () => {
    const { bus } = makeTestAlertBus();
    const wakeDispatches: string[] = [];

    globalThis.fetch = makeReconciliationFetch({ unenrolledTickets: [] });

    const timer = registerBootstrapReconciliationCron({
      authToken: "Bearer test-token",
      intervalMs: 50,
      alertBus: bus,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    clearInterval(timer);

    expect(wakeDispatches).toHaveLength(0);
  });

  it("alerts via the global bus when alertBus is not explicitly passed", async () => {
    // The prod cron path in index.ts omits alertBus, relying on the global
    // singleton. This test verifies the default fires an alert.
    const wakeDispatches: string[] = [];
    const { getAlertBus, _resetAlertBusForTests } = await import("./alerts/alert-bus.js");
    _resetAlertBusForTests();
    const globalBus = getAlertBus();
    const alertSpy = jest.spyOn(globalBus, "notify");

    globalThis.fetch = makeReconciliationFetch({
      unenrolledTickets: [
        {
          id: ISSUE_ID_UNENROLLED,
          identifier: "AI-GLOBAL-BUS",
          updatedAt: OLD_TIMESTAMP,
          labelNodes: [{ id: WF_LABEL_ID, name: WF_LABEL_NAME }],
          delegateId: null,
          teamId: TEAM_ID,
        },
      ],
    });

    const timer = registerBootstrapReconciliationCron({
      authToken: "Bearer test-token",
      intervalMs: 50,
      wakeFn: async (_, id) => { wakeDispatches.push(id); },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    clearInterval(timer);

    // Should have alerted through the global bus
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ source: "bootstrap-reconciled" }),
    );
    expect(wakeDispatches.length).toBeGreaterThanOrEqual(1);

    alertSpy.mockRestore();
    _resetAlertBusForTests();
  });
});
