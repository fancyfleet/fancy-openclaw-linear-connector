/**
 * INF-1260: dev-impl transition + recovery engine — zombie/stale dispatch
 * lease must never let `submit`/`continue-workflow` fail-open.
 *
 * Bug: `checkStaleSnapshotForTerminal` (src/proxy-cas-check.ts:148) is the
 * ONLY place a dispatch lease is consulted before a governed write, and it
 * gates on a hardcoded `TERMINAL_INTS` set (handoff-work, complete-work,
 * needs-human, refuse-work — proxy-cas-check.ts:24-29). `submit` and
 * `continue-workflow` are not in that set, so the very first line of the
 * function (`if (!TERMINAL_INTS.has(effectiveIntent)) return null;`) passes
 * them through unconditionally — a stale/expired lease for the acting agent
 * is never even read for these intents.
 *
 * AC mapping:
 *   AC1 — every governed transition (submit included) must be all-or-nothing
 *         and verified; a zombie dispatch must not silently drop/duplicate it.
 *   AC2 — fail-closed under a zombie/stale dispatch lease: a stale lease must
 *         never make `submit` fail-open and drop the write.
 *   AC7 — regression test reproducing "zombie-lease submit".
 *
 * These tests assert the DESIRED fail-closed behavior, so they are RED against
 * today's code (which fail-opens `submit`/`continue-workflow` unconditionally).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { checkStaleSnapshotForTerminal } from "./proxy-cas-check.js";
import { DispatchLeaseStore } from "./store/dispatch-lease-store.js";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";

// ── AC1+AC2+AC7: checkStaleSnapshotForTerminal ignores submit/continue-workflow ──

describe("INF-1260 AC1+AC2 (zombie-lease submit): checkStaleSnapshotForTerminal must not fail-open on submit/continue-workflow", () => {
  let dir: string;
  let leaseStore: DispatchLeaseStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1260-lease-"));
    leaseStore = new DispatchLeaseStore(path.join(dir, "lease.db"));
    // Seed a long-expired ("zombie") lease for this agent+ticket — the
    // exact shape of a stale dispatch a crashed/orphaned session left behind.
    leaseStore.acquire("charles", "INF-1260-ZOMBIE", {
      nowMs: Date.parse("2020-01-01T00:00:00.000Z"),
      ttlOverrideMs: 1000,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    leaseStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["submit", "continue-workflow"])(
    "AC7(zombie-lease submit): '%s' with a zombie lease present must be checked, not silently passed through",
    async (intent) => {
      const result = await checkStaleSnapshotForTerminal(
        intent,
        "INF-1260-ZOMBIE",
        "charles",
        "Bearer tok",
        "charles-linear-uid",
        leaseStore,
      );
      // Desired: a zombie lease for this agent+ticket must be detected and
      // either recovered or refused loudly (non-null rejection). Today the
      // function returns null unconditionally for non-TERMINAL_INTS intents,
      // never even reading the lease store.
      expect(result).not.toBeNull();
    },
  );
});

// ── AC1+AC2+AC7: end-to-end proxy submit with a zombie lease present ──────

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: workflow:break-glass
containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
roles:
  - id: steward
    requires: [workflow:break-glass]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

const WORKFLOW_YAML = `
id: dev-impl
version: 9
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: __ad_hoc__
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
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const ISSUE_UUID = "issue-inf-1260-internal-uuid";
const ISSUE_IDENTIFIER = "INF-1260";
const TEAM_ID = "team-inf";

interface FetchCall {
  query: string;
  variables: Record<string, unknown>;
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeMockFetch(): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let currentLabels = [
    { id: "wf-lbl", name: "wf:dev-impl" },
    { id: "implementation-lbl", name: "state:implementation" },
  ];

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch url: ${url}`);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};
    calls.push({ query, variables });

    if (query.includes("IssueContext")) {
      return jsonResponse({
        data: {
          issue: {
            identifier: ISSUE_IDENTIFIER,
            labels: { nodes: currentLabels },
            delegate: { id: "u-astrid" },
            assignee: { id: "u-astrid" },
          },
        },
      });
    }

    if (query.includes("IssueWithLabels")) {
      return jsonResponse({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: ISSUE_IDENTIFIER,
            title: "INF-1260 test issue",
            team: { id: TEAM_ID },
            labels: { nodes: currentLabels },
            delegate: { id: "u-astrid" },
            assignee: { id: "u-astrid" },
          },
        },
      });
    }

    // Used by checkStaleSnapshotForTerminal's identifier/updatedAt resolution
    // and by the read-after-write verification path.
    if (query.includes("issue(id:") && query.includes("updatedAt")) {
      return jsonResponse({ data: { issue: { identifier: ISSUE_IDENTIFIER, updatedAt: new Date().toISOString() } } });
    }

    if (query.includes("TeamLabels")) {
      return jsonResponse({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "wf-lbl", name: "wf:dev-impl" },
                { id: "implementation-lbl", name: "state:implementation" },
                { id: "done-lbl", name: "state:done" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("TeamStates")) {
      return jsonResponse({
        data: {
          team: {
            states: {
              nodes: [
                { id: "s-todo", name: "Todo", type: "unstarted" },
                { id: "s-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("ApplyAtomicTransition")) {
      currentLabels = ((variables.labelIds as string[] | undefined) ?? []).map((id) => {
        if (id === "wf-lbl") return { id, name: "wf:dev-impl" };
        if (id === "done-lbl") return { id, name: "state:done" };
        if (id === "implementation-lbl") return { id, name: "state:implementation" };
        return { id, name: `label:${id}` };
      });
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }

    if (query.includes("VerifyTransitionWrite") || (query.includes("issue(id:") && query.includes("labels"))) {
      return jsonResponse({
        data: {
          issue: {
            labels: { nodes: currentLabels },
            delegate: null,
            assignee: null,
            state: { id: "s-done" },
          },
        },
      });
    }

    if (query.includes("commentCreate")) {
      return jsonResponse({ data: { commentCreate: { success: true, comment: { id: "c-1" } } } });
    }

    // The CLI's own forwarded mutation (proxied verbatim upstream).
    if (query.includes("issueUpdate")) {
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }

    return jsonResponse({ errors: [{ message: `unexpected query: ${query.slice(0, 120)}` }] }, 400);
  };

  return { fetch: mockFetch, calls };
}

describe("INF-1260 AC1+AC2 (zombie-lease submit): proxy submit is not fail-closed under a zombie lease", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let originalAgentsFile: string | undefined;
  let originalCapabilityPolicyPath: string | undefined;
  let originalWorkflowDefPath: string | undefined;

  beforeEach(() => {
    originalAgentsFile = process.env.AGENTS_FILE;
    originalCapabilityPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1260-proxy-lease-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
    fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, WORKFLOW_YAML, "utf8");

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();

    originalFetch = globalThis.fetch;
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
      managingStateDbPath: path.join(dir, "managing-state.db"),
      mutationAuditDbPath: path.join(dir, "audit.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      dispatchLeaseDbPath: path.join(dir, "dispatch-leases.db"),
      dispatchInFlightDbPath: path.join(dir, "dispatch-inflight.db"),
      proposalsDbPath: path.join(dir, "proposals.db"),
      livenessDispatchDbPath: path.join(dir, "liveness-dispatches.db"),
      deadLetterQueueDbPath: path.join(dir, "dead-letter-queue.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled.db"),
    });

    // Seed a long-expired ("zombie") dispatch lease for astrid on this
    // ticket, with a stale snapshot updatedAt far in the past — modeling a
    // crashed/orphaned prior session that never released its lease.
    appState.dispatchLeaseStore.acquire("astrid", ISSUE_IDENTIFIER, {
      nowMs: Date.parse("2020-01-01T00:00:00.000Z"),
      ttlOverrideMs: 1000,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.observationStore.close();
    appState.deadLetterQueue.close();
    appState.managingStateStore.close();
    appState.mutationAuditStore.close();
    appState.enrolledTicketsStore.close();
    appState.idempotencyStore.close();
    appState.dispatchLeaseStore.close();
    appState.dispatchInFlightStore.close();
    appState.livenessDispatchStore.close();
    appState.proposalStore.close();
    appState.dispatchDeliveryScheduler.stop();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
    fs.rmSync(dir, { recursive: true, force: true });

    if (originalAgentsFile !== undefined) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
    if (originalCapabilityPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalCapabilityPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    if (originalWorkflowDefPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowDefPath;
    else delete process.env.WORKFLOW_DEF_PATH;
  });

  it("AC7(zombie-lease submit): submit through the live proxy with a zombie lease present is refused, not silently applied", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: ISSUE_IDENTIFIER },
      });

    expect(res.status).toBe(200);
    // Desired: a zombie lease for the dispatching agent must cause the
    // connector to detect + recover, or refuse the write loudly. Today
    // `submit` is not in TERMINAL_INTS, so checkStaleSnapshotForTerminal
    // never inspects the lease at all and the transition applies cleanly —
    // this assertion is RED against that fail-open behavior.
    expect(res.body.errors).toBeDefined();
  });
});
