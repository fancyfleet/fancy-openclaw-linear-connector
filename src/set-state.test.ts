/**
 * Tests for the steward/human-only atomic set-state endpoint (AI-1546, G-6).
 *
 * set-state(ticket, target-state, delegate) re-establishes the label + native
 * Linear state + delegate triple atomically through the connector. It is the
 * only rewind path that can operate from a terminal source state (done/escape).
 *
 * Acceptance criteria under test:
 *   AC1: set-state atomically sets label+native+delegate; consistency asserted.
 *   AC2: caller-class gated to steward/human; non-steward caller rejected.
 *   AC3: works from a terminal source state (re-open).
 *   AC4: no half-applied state on failure.
 *
 * Design: POST /proxy/set-state with body { issueId, targetState, delegate }.
 * The connector performs the mutation directly — no upstream forwarding.
 */

import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache, resetNativeStateCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

// ── Capability policy fixtures ─────────────────────────────────────────────
// steward container grants human:escalate (required for set-state).
// dev container does not.

const STEWARD_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
roles:
  - id: steward
    requires: [human:escalate]
  - id: dev
    requires: [linear:transition]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: felix
    container: dev
    fills_roles: [dev]
`;

// ── Workflow fixture ───────────────────────────────────────────────────────
// Minimal dev-impl shape with terminal states (done, escape).

const WORKFLOW_YAML = `
id: dev-impl
version: 8
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: escape
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
        assign: { mode: required }
  - id: write-tests
    owner_role: test-author
    kind: normal
    native_state: todo
    transitions:
      - command: tests-ready
        to: implementation
        assign: { mode: required }
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review
        assign: { mode: required }
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: done
      - command: request-changes
        to: implementation
  - id: done
    kind: terminal
    native_state: done
  - id: escape
    kind: terminal
    native_state: invalid
`;

// ── Agents fixture ─────────────────────────────────────────────────────────
// astrid — steward (human:escalate); igor and felix — dev (linear:transition only).
// All have linearUserId so the endpoint can resolve delegate → Linear user ID.

const AGENTS_JSON = JSON.stringify({
  agents: [
    {
      name: "astrid",
      linearUserId: "astrid-linear-uuid",
      openclawAgent: "astrid",
      accessToken: "astrid-token",
      host: "local",
    },
    {
      name: "igor",
      linearUserId: "igor-linear-uuid",
      openclawAgent: "igor",
      accessToken: "igor-token",
      host: "local",
    },
    {
      name: "felix",
      linearUserId: "felix-linear-uuid",
      openclawAgent: "felix",
      accessToken: "felix-token",
      host: "local",
    },
  ],
});

// ── Linear API mock helpers ────────────────────────────────────────────────

interface FetchCall {
  url: string;
  body: { query?: string; variables?: Record<string, unknown> };
}

interface MockFetchOpts {
  /** Current labels on the ticket (for IssueLabels / IssueWithLabels). */
  issueLabels: Array<{ id: string; name: string }>;
  teamId?: string;
  /** Known team labels (for findOrCreateLabel). */
  teamLabels?: Array<{ id: string; name: string }>;
  /** Whether the atomic issueUpdate should succeed. */
  issueUpdateSuccess?: boolean;
  /** Simulate a throw on IssueWithLabels fetch. */
  issueError?: boolean;
  /** Simulate a throw on the ApplyAtomicTransition mutation. */
  updateError?: boolean;
}

/** Build a mock fetch that records calls and handles all Linear API queries. */
function makeLinearMock(opts: MockFetchOpts): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const teamId = opts.teamId ?? "team-uuid";
  const teamLabels = opts.teamLabels ?? [];
  const issueUpdateSuccess = opts.issueUpdateSuccess ?? true;

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch call to: ${String(url)}`);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ url, body: parsed });
    const query = parsed.query ?? "";

    // Label fetch for escalation-gate (IssueLabels) and workflow-gate (IssueContext).
    if (query.includes("IssueLabels") || (query.includes("issue(id:") && !query.includes("id\n") && !query.includes("team"))) {
      return new Response(
        JSON.stringify({
          data: {
            issue: { labels: { nodes: opts.issueLabels } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // IssueWithLabels — full fetch including internalId and teamId.
    if (query.includes("IssueWithLabels")) {
      if (opts.issueError) throw new Error("simulated issue fetch error");
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-uuid",
              team: { id: teamId },
              labels: { nodes: opts.issueLabels },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // IssueContext — for workflow-gate context fetch (delegate + labels).
    if (query.includes("IssueContext")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: opts.issueLabels },
              delegate: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Team workflow states — for resolving native stateId.
    if (query.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                  { id: "state-doing-uuid", name: "Doing", type: "started" },
                  { id: "state-thinking-uuid", name: "Thinking", type: "started" },
                  { id: "state-done-uuid", name: "Done", type: "completed" },
                  { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // TeamLabels — for findOrCreateLabel.
    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: teamLabels } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // issueLabelCreate — when the target state:* label doesn't exist yet.
    if (query.includes("issueLabelCreate")) {
      return new Response(
        JSON.stringify({
          data: {
            issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ApplyAtomicTransition — the actual atomic write.
    if (query.includes("ApplyAtomicTransition")) {
      if (opts.updateError) throw new Error("simulated atomic update error");
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: issueUpdateSuccess } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Fallback — should not be reached in well-written tests.
    throw new Error(`unhandled Linear query: ${query.slice(0, 80)}`);
  };

  return { fetch: mockFetch, calls };
}

// ── Test setup ─────────────────────────────────────────────────────────────

function setupEnv(dir: string): void {
  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, STEWARD_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const workflowFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, AGENTS_JSON, "utf8");
  process.env.AGENTS_FILE = agentsFile;

  reloadAgents();
  resetPolicyCache();
  resetWorkflowCache();
  resetNativeStateCache();
  resetConfigHealth();
}

// ── Labels shared across tests ─────────────────────────────────────────────

const LIVE_TICKET_LABELS = [
  { id: "label-wf-uuid", name: "wf:dev-impl" },
  { id: "label-state-impl-uuid", name: "state:implementation" },
];

const DONE_TICKET_LABELS = [
  { id: "label-wf-uuid", name: "wf:dev-impl" },
  { id: "label-state-done-uuid", name: "state:done" },
];

const ESCAPE_TICKET_LABELS = [
  { id: "label-wf-uuid", name: "wf:dev-impl" },
  { id: "label-state-escape-uuid", name: "state:escape" },
];

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — Steward/human gate
// ═══════════════════════════════════════════════════════════════════════════

describe("set-state AC2: steward/human gate", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-state-ac2-"));
    setupEnv(dir);
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  it("AC2-a: rejects request with no Authorization header (401)", async () => {
    const res = await request(appState.app)
      .post("/proxy/set-state")
      .send({ issueId: "issue-uuid", targetState: "implementation", delegate: "igor" });

    expect(res.status).toBe(401);
  });

  it("AC2-b: rejects non-steward caller (dev body without human:escalate) with 403", async () => {
    const { fetch: mockFetch } = makeLinearMock({ issueLabels: LIVE_TICKET_LABELS });
    globalThis.fetch = mockFetch;

    // igor is in the dev container — no human:escalate.
    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer igor-token")
      .set("x-openclaw-agent", "igor")
      .send({ issueId: "issue-uuid", targetState: "implementation", delegate: "igor" });

    expect(res.status).toBe(403);
    expect(res.body.error ?? res.body.message ?? "").toMatch(/steward|human|capability|escalate/i);
  });

  it("AC2-c: non-steward is rejected even for ad-hoc tickets (set-state is always steward-only)", async () => {
    // Ad-hoc ticket: no wf:* label. set-state is unconditionally steward-only.
    const { fetch: mockFetch } = makeLinearMock({
      issueLabels: [{ id: "label-bug-uuid", name: "bug" }],
    });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer igor-token")
      .set("x-openclaw-agent", "igor")
      .send({ issueId: "issue-uuid", targetState: "implementation", delegate: "igor" });

    expect(res.status).toBe(403);
  });

  it("AC2-d: steward caller (has human:escalate) is allowed through on a live ticket", async () => {
    const { fetch: mockFetch } = makeLinearMock({ issueLabels: LIVE_TICKET_LABELS });
    globalThis.fetch = mockFetch;

    // astrid is in the steward container — has human:escalate.
    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "implementation", delegate: "igor" });

    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — Atomic label + native + delegate
// ═══════════════════════════════════════════════════════════════════════════

describe("set-state AC1: atomic label+native+delegate write", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-state-ac1-"));
    setupEnv(dir);
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  it("AC1-a: issues exactly one issueUpdate mutation containing labelIds, stateId, and delegateId", async () => {
    const { fetch: mockFetch, calls } = makeLinearMock({
      issueLabels: LIVE_TICKET_LABELS,
    });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "code-review", delegate: "felix" });

    expect(res.status).toBe(200);

    // AC1 core: exactly one ApplyAtomicTransition mutation (not multiple partial calls).
    const atomicCalls = calls.filter((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(atomicCalls.length).toBe(1);

    const mutation = atomicCalls[0];
    const vars = mutation.body.variables ?? {};

    // All three facets must be present in the single mutation.
    expect(vars).toHaveProperty("labelIds");
    expect(vars).toHaveProperty("stateId");
    expect(vars).toHaveProperty("delegateId");

    // labelIds must include the target state:* label.
    expect(Array.isArray(vars.labelIds)).toBe(true);
    // The wf:* label must be preserved.
    // stateId must be the native Linear state UUID for "todo" (code-review maps to todo in this workflow).
    expect(vars.stateId).toBe("state-todo-uuid");
    // delegateId must be felix's Linear user ID.
    expect(vars.delegateId).toBe("felix-linear-uuid");
  });

  it("AC1-b: swaps the old state:* label for the new one (old label removed, new label added)", async () => {
    const { fetch: mockFetch, calls } = makeLinearMock({
      issueLabels: [
        { id: "label-wf-uuid", name: "wf:dev-impl" },
        { id: "label-state-impl-uuid", name: "state:implementation" },
        { id: "label-risk-uuid", name: "risk:medium" },
      ],
    });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "code-review", delegate: "felix" });

    expect(res.status).toBe(200);

    const atomicCalls = calls.filter((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(atomicCalls.length).toBe(1);
    const vars = atomicCalls[0].body.variables ?? {};
    const labelIds = vars.labelIds as string[];

    // wf:* label preserved, risk:* label preserved, state:implementation dropped.
    expect(labelIds).toContain("label-wf-uuid");
    expect(labelIds).toContain("label-risk-uuid");
    expect(labelIds).not.toContain("label-state-impl-uuid");
    // New state:code-review label must be in the set.
    // (It gets a new ID from findOrCreateLabel — "new-label-id" from our mock.)
    expect(labelIds).toContain("new-label-id");
  });

  it("AC1-c: response body includes confirmation of the target state and delegate", async () => {
    const { fetch: mockFetch } = makeLinearMock({ issueLabels: LIVE_TICKET_LABELS });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "implementation", delegate: "igor" });

    expect(res.status).toBe(200);
    // Caller can verify what was applied (consistency assertion).
    const body = res.body as Record<string, unknown>;
    expect(body.targetState ?? body.state ?? body.appliedState).toBe("implementation");
    expect(body.delegate ?? body.appliedDelegate).toBe("igor");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — Works from a terminal source state (re-open)
// ═══════════════════════════════════════════════════════════════════════════

describe("set-state AC3: terminal source state re-open", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-state-ac3-"));
    setupEnv(dir);
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  it("AC3-a: set-state succeeds from state:done terminal (re-open to implementation)", async () => {
    const { fetch: mockFetch, calls } = makeLinearMock({
      issueLabels: DONE_TICKET_LABELS,
    });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "implementation", delegate: "igor" });

    expect(res.status).toBe(200);

    // Must have issued the atomic mutation (not blocked).
    const atomicCalls = calls.filter((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(atomicCalls.length).toBe(1);
  });

  it("AC3-b: set-state succeeds from state:escape terminal (rescue to intake)", async () => {
    const { fetch: mockFetch, calls } = makeLinearMock({
      issueLabels: ESCAPE_TICKET_LABELS,
    });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "intake", delegate: "astrid" });

    expect(res.status).toBe(200);

    const atomicCalls = calls.filter((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(atomicCalls.length).toBe(1);
  });

  it("AC3-c: re-open from done sets native stateId to the target state's native_state (not done)", async () => {
    const { fetch: mockFetch, calls } = makeLinearMock({
      issueLabels: DONE_TICKET_LABELS,
    });
    globalThis.fetch = mockFetch;

    await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "implementation", delegate: "igor" });

    const atomicCalls = calls.filter((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(atomicCalls.length).toBe(1);
    const vars = atomicCalls[0].body.variables ?? {};
    // implementation has native_state: todo → must write "Todo" state UUID, not "Done".
    expect(vars.stateId).toBe("state-todo-uuid");
    expect(vars.stateId).not.toBe("state-done-uuid");
  });

  it("AC3-d: non-workflow ticket (no wf:* label) rejects set-state with 422 (unknown target context)", async () => {
    // A ticket with no wf:* label has no workflow definition to look up target state from.
    // set-state requires a workflow context to know what label to write.
    const { fetch: mockFetch } = makeLinearMock({
      issueLabels: [{ id: "label-bug-uuid", name: "bug" }],
    });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "implementation", delegate: "igor" });

    // Ad-hoc ticket: no workflow context. Cannot resolve state:* label or native stateId.
    expect(res.status).toBe(422);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 — No half-applied state on failure
// ═══════════════════════════════════════════════════════════════════════════

describe("set-state AC4: no half-applied state on failure", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-state-ac4-"));
    setupEnv(dir);
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  it("AC4-a: returns 502 (not 200) when the Linear API mutation returns success:false", async () => {
    const { fetch: mockFetch, calls } = makeLinearMock({
      issueLabels: LIVE_TICKET_LABELS,
      issueUpdateSuccess: false,
    });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "code-review", delegate: "felix" });

    // Failure must be surfaced — do not claim success when the mutation failed.
    expect(res.status).toBe(502);
    expect(res.body.error ?? res.body.message ?? "").toMatch(/fail|error|success/i);

    // There must have been exactly one mutation attempt (not multiple partials).
    const mutationCalls = calls.filter((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(mutationCalls.length).toBe(1);
  });

  it("AC4-b: returns 502 when the Linear API throws on the mutation", async () => {
    const { fetch: mockFetch, calls } = makeLinearMock({
      issueLabels: LIVE_TICKET_LABELS,
      updateError: true,
    });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "code-review", delegate: "felix" });

    expect(res.status).toBe(502);

    // Exactly one mutation attempt — no retry loop that could partially apply.
    const mutationCalls = calls.filter((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(mutationCalls.length).toBeLessThanOrEqual(1);
  });

  it("AC4-c: returns 502 when the issue fetch fails (cannot safely proceed)", async () => {
    const { fetch: mockFetch, calls } = makeLinearMock({
      issueLabels: LIVE_TICKET_LABELS,
      issueError: true,
    });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "code-review", delegate: "felix" });

    expect(res.status).toBe(502);

    // No mutation should have been attempted if the issue fetch failed.
    const mutationCalls = calls.filter((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(mutationCalls.length).toBe(0);
  });

  it("AC4-d: a single atomic mutation means label, stateId, and delegateId are written together or not at all", async () => {
    // AC4 is structurally guaranteed by using a single issueUpdateAtomic call.
    // This test verifies there are no separate "label-only" and "delegate-only" calls —
    // if we see more than one issueUpdate, the implementation is not atomic.
    const { fetch: mockFetch, calls } = makeLinearMock({
      issueLabels: LIVE_TICKET_LABELS,
    });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "implementation", delegate: "igor" });

    expect(res.status).toBe(200);

    // Count ALL issueUpdate mutations regardless of name.
    const allMutations = calls.filter((c) => (c.body.query ?? "").includes("issueUpdate"));
    expect(allMutations.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Input validation — guard the endpoint interface
// ═══════════════════════════════════════════════════════════════════════════

describe("set-state input validation", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-state-val-"));
    setupEnv(dir);
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  it("returns 400 when issueId is missing", async () => {
    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ targetState: "implementation", delegate: "igor" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when targetState is missing", async () => {
    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", delegate: "igor" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when delegate is missing", async () => {
    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "implementation" });

    expect(res.status).toBe(400);
  });

  it("returns 422 when delegate is an unknown agent name (no linearUserId to resolve)", async () => {
    const { fetch: mockFetch } = makeLinearMock({ issueLabels: LIVE_TICKET_LABELS });
    globalThis.fetch = mockFetch;

    const res = await request(appState.app)
      .post("/proxy/set-state")
      .set("Authorization", "Bearer astrid-token")
      .set("x-openclaw-agent", "astrid")
      .send({ issueId: "issue-uuid", targetState: "implementation", delegate: "unknown-agent" });

    expect(res.status).toBe(422);
  });
});
