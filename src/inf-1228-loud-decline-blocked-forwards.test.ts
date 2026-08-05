/**
 * INF-1228 — a governed forward transition that BLOCKS (not just FAILS) must
 * decline loudly, transition-audit's post-transition comparison must not emit
 * false-positive LABEL MISMATCH warnings, and dispatch guidance must never be
 * able to name a workflow state that doesn't exist.
 *
 * AC map (verbatim from the ticket):
 * 1. Loud-decline covers non-applied governed forwards. A `generic:continue`
 *    governed forward (submit/continue-workflow) whose transition returns
 *    status: "blocked" (not only "failed") returns an explicit GraphQL error
 *    envelope with no success `data` — never a masked `issueUpdate.success:
 *    true`. Generalized so ANY non-applied governed forward (generic:continue
 *    OR the capture_ac accept forward) whose transition returned "failed" or
 *    "blocked" returns the error envelope.
 * 2. transition-audit comparison fixed: a healthy applied transition logs no
 *    post-transition LABEL MISMATCH (fetchStateLabel returns the full label
 *    `state:X`; the comparison must not compare that raw against a bare state
 *    id and always miss).
 * 3. No dispatch guidance can be built that references a workflow state which
 *    doesn't exist in the def's `states` list (the `accept (→ doing)` class
 *    of defect, generalized to a load-time invariant instead of an incidental
 *    fact of how the legal-actions list happens to be rendered today).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { clearAcRecordStore } from "./ac-record-store.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { clearAppliedState } from "./store/applied-state-store.js";
import { _setTransitionWritePolicyForTests, resetWorkflowCache, loadWorkflowRegistry } from "./workflow-gate.js";
import { verifyPostTransition } from "./transition-audit.js";

const ADMIN_SECRET = "inf-1228-admin-secret";
const AUTH = "Bearer inf-1228-token";
const TEAM_ID = "team-ai";
const IGOR_LINEAR_ID = "user-igor";
const CHARLES_LINEAR_ID = "user-charles";
const ASTRID_LINEAR_ID = "user-astrid";
const TDD_LINEAR_ID = "user-tdd";

// ── AC1 fixtures ────────────────────────────────────────────────────────────

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass
containers:
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition]
  - id: test-author
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
roles:
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
  - id: test-author
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: code-review
    fills_roles: [code-review]
  - id: tdd
    container: test-author
    fills_roles: [test-author]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// Same shape as production dev-impl: `submit` (implementation -> code-review)
// is a generic:continue forward gated by the INF-1060 push-before-claim
// evidence check; `accept` (intake -> write-tests) is the capture_ac forward
// gated by the AC-of-record check.
// version < 10 so the AI-2476 merge/deploy gate-anchor drift guard (unrelated
// to this ticket) doesn't require those states to be present in this fixture.
const DEV_IMPL_YAML = `
id: dev-impl
version: 9
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: write-tests
        capture_ac: true
        assign: { mode: auto }
  - id: write-tests
    owner_role: test-author
    native_state: todo
    transitions:
      - command: tests-ready
        to: implementation
        assign: { mode: required }
  - id: implementation
    owner_role: dev
    native_state: todo
    transitions:
      - command: submit
        to: code-review
        generic: continue
        assign:
          mode: required
          constraint: not-implementer
  - id: code-review
    owner_role: code-review
    native_state: todo
    transitions: []
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const DESCR_WITH_AC = `## Problem
Regression fixture.

## Acceptance Criteria

- Governed transitions are atomic.
- Blocked forwards decline as loudly as failed ones.
`;

type TicketState = "intake" | "implementation" | "code-review";
type GraphqlCall = { query: string; variables: Record<string, unknown> };

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function writeConfig(dir: string): void {
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
  fs.writeFileSync(path.join(dir, "dev-impl.yaml"), DEV_IMPL_YAML, "utf8");
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({
      agents: [
        { name: "igor", linearUserId: IGOR_LINEAR_ID, openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
        { name: "charles", linearUserId: CHARLES_LINEAR_ID, openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
        { name: "tdd", linearUserId: TDD_LINEAR_ID, openclawAgent: "tdd", accessToken: "tok-tdd", host: "local" },
        { name: "astrid", linearUserId: ASTRID_LINEAR_ID, openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
      ],
    }),
    "utf8",
  );
}

function makeLinearFetch(opts: {
  ticket: string;
  issueId: string;
  sourceState: TicketState;
  delegateId?: string | null;
  description?: string;
  atomicSuccess?: boolean;
}) {
  const calls: GraphqlCall[] = [];
  let transitionApplied = false;
  const description = opts.description ?? DESCR_WITH_AC;
  const delegateAtStart = opts.delegateId === undefined
    ? opts.sourceState === "intake"
      ? ASTRID_LINEAR_ID
      : IGOR_LINEAR_ID
    : opts.delegateId;

  const stateLabelId = (state: string) => `label-state-${state}`;
  const labelsFor = (state: TicketState) => [
    { id: "label-wf-dev-impl", name: "wf:dev-impl", team: { id: TEAM_ID } },
    { id: stateLabelId(state), name: `state:${state}`, team: { id: TEAM_ID } },
    { id: "label-repo-connector", name: "repo:fancy-openclaw-linear-connector", team: { id: TEAM_ID } },
  ];
  const destinationFor = (state: TicketState) =>
    state === "intake" ? "write-tests" : "code-review";
  const destination = destinationFor(opts.sourceState);
  const destinationDelegate =
    destination === "write-tests" ? TDD_LINEAR_ID : destination === "code-review" ? CHARLES_LINEAR_ID : null;

  const fetch = (async (url: unknown, init?: RequestInit) => {
    const urlText = String(url);
    if (!urlText.includes("api.linear.app")) {
      return json({ status: "identical", reachable: true });
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphqlCall;
    calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
    const query = parsed.query ?? "";

    if (query.includes("IssueDescription")) {
      return json({ data: { issue: { description } } });
    }
    if (query.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    }
    if (query.includes("IssueContext")) {
      return json({
        data: {
          issue: {
            identifier: opts.ticket,
            labels: { nodes: labelsFor(opts.sourceState).map((label) => ({ name: label.name })) },
            delegate: delegateAtStart ? { id: delegateAtStart } : null,
            state: { type: "started", name: "To Do" },
          },
        },
      });
    }
    if (query.includes("IssueLabels")) {
      return json({ data: { issue: { labels: { nodes: labelsFor(opts.sourceState).map((label) => ({ name: label.name })) } } } });
    }
    if (query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: opts.issueId,
            identifier: opts.ticket,
            team: { id: TEAM_ID, key: "AI", name: "AI" },
            labels: { nodes: labelsFor(opts.sourceState) },
            delegate: delegateAtStart ? { id: delegateAtStart } : null,
            assignee: null,
            state: { id: "state-todo" },
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return json({
        data: {
          team: {
            labels: {
              nodes: ["intake", "write-tests", "implementation", "code-review"].map((state) => ({
                id: stateLabelId(state),
                name: `state:${state}`,
                team: { id: TEAM_ID },
              })),
            },
          },
        },
      });
    }
    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-todo", name: "To Do", type: "unstarted" },
                { id: "state-doing", name: "Doing", type: "started" },
                { id: "state-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("IssueRepoAttachments")) {
      return json({ data: { issue: { attachments: { nodes: [] } } } });
    }
    if (query.includes("ApplyAtomicTransition")) {
      transitionApplied = opts.atomicSuccess !== false;
      return json({ data: { issueUpdate: { success: opts.atomicSuccess !== false } } });
    }
    if (query.includes("VerifyTransitionWrite")) {
      const state = transitionApplied ? (destination as TicketState) : opts.sourceState;
      return json({
        data: {
          issue: {
            labels: { nodes: labelsFor(state).map((label) => ({ name: label.name })) },
            delegate: transitionApplied
              ? destinationDelegate === null ? null : { id: destinationDelegate }
              : delegateAtStart ? { id: delegateAtStart } : null,
            assignee: null,
            state: { id: "state-todo" },
          },
        },
      });
    }

    return json({ data: { issueUpdate: { success: true, issue: { id: opts.issueId } } } });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    upstreamIssueUpdates: () =>
      calls.filter((call) => call.query.includes("issueUpdate") && !call.query.includes("ApplyAtomicTransition")),
    transitionWrites: () => calls.filter((call) => call.query.includes("ApplyAtomicTransition")),
  };
}

function submitBody(issueId: string): Record<string, unknown> {
  return {
    operationName: "SubmitImplementation",
    query: "mutation SubmitImplementation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }",
    variables: { id: issueId, input: { description: "implementation submitted" } },
  };
}

function acceptBody(issueId: string): Record<string, unknown> {
  return {
    operationName: "AcceptIntake",
    query: "mutation AcceptIntake($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }",
    variables: { id: issueId, input: { description: "intake accepted" } },
  };
}

describe("INF-1228 AC1 — loud-decline generalizes to blocked (and failed) governed forwards", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1228-"));
    for (const key of [
      "ADMIN_SECRET",
      "AGENTS_FILE",
      "CAPABILITY_POLICY_PATH",
      "WORKFLOW_DEF_PATH",
      "WORKFLOW_DEFS_DIR",
      "WORKFLOW_DEF_STATE_SNAPSHOT_PATH",
      "AC_RECORDS_PATH",
      "ALLOW_WORKFLOW_DEF_FIXTURE_DRIFT",
      "LINEAR_API_KEY",
      "LINEAR_OAUTH_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ]) {
      savedEnv.set(key, process.env[key]);
    }
    writeConfig(dir);
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "workflow-def-state-snapshot.json");
    process.env.AC_RECORDS_PATH = path.join(dir, "ac-records.json");
    process.env.ALLOW_WORKFLOW_DEF_FIXTURE_DRIFT = "1";
    process.env.LINEAR_API_KEY = AUTH;
    delete process.env.WORKFLOW_DEFS_DIR;
    delete process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    clearAcRecordStore();
    reloadAgents();
    _setTransitionWritePolicyForTests({ maxAttempts: 1, retryDelayMs: 0 });
    originalFetch = globalThis.fetch;
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      mutationAuditDbPath: path.join(dir, "mutation-audit.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      dispatchLeaseDbPath: path.join(dir, "lease.db"),
      dispatchInFlightDbPath: path.join(dir, "inflight.db"),
      livenessDispatchDbPath: path.join(dir, "liveness.db"),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.mutationAuditStore.close();
    appState.idempotencyStore.close();
    appState.dispatchLeaseStore.close();
    appState.dispatchInFlightStore.close();
    appState.livenessDispatchStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
    _setTransitionWritePolicyForTests();
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    clearAcRecordStore();
    clearAppliedState("INF-1228");
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC1a: submit blocked by push-before-claim (no code artifact) declines loudly — no masked success", async () => {
    const transport = makeLinearFetch({ ticket: "INF-1228", issueId: "issue-inf-1228", sourceState: "implementation" });
    globalThis.fetch = transport.fetch;

    // Deliberately omit X-Openclaw-Code-Artifact so the push-before-claim gate blocks.
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("Authorization", AUTH)
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "continue-workflow")
      .set("X-Openclaw-Linear-Target", "charles")
      .set("X-Openclaw-Linear-Cli-Version", "999.0.0")
      .set("X-Openclaw-Command-Id", "cmd-inf-1228-push-before-claim")
      .send(submitBody("issue-inf-1228"));

    expect(res.status).toBe(200);
    // AC1: explicit GraphQL error envelope, no success `data`.
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors?.[0]?.message).toMatch(/declined|blocked|could not be applied/i);
    expect(res.body._workflowTransition).toMatchObject({
      status: "blocked",
      code: "push-before-claim",
      from: "implementation",
      to: "code-review",
    });
    // The pre-fix masked-success path: the forwarded placeholder mutation
    // returns issueUpdate.success:true — that must never surface as `data`.
    expect(JSON.stringify(res.body)).not.toContain('"success":true');
    // No atomic transition write should have landed for a blocked gate.
    expect(transport.transitionWrites()).toHaveLength(0);
  });

  it("AC1b: capture_ac accept forward whose ATOMIC WRITE fails (not just the AC gate) declines loudly too", async () => {
    // AC is present (gate passes) but the atomic transition write itself fails —
    // status:"failed", not "blocked". Before the generalization, loudAcceptGate
    // only fired on status:"blocked" + code:"ac-of-record-missing", so this
    // failure mode fell through to the masked-success path exactly like the
    // genericContinueForward "failed" case did pre-INF-1147.
    const transport = makeLinearFetch({
      ticket: "INF-1228",
      issueId: "issue-inf-1228-accept",
      sourceState: "intake",
      atomicSuccess: false,
    });
    globalThis.fetch = transport.fetch;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("Authorization", AUTH)
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "begin-workflow")
      .set("X-Openclaw-Linear-Cli-Version", "999.0.0")
      .set("X-Openclaw-Command-Id", "cmd-inf-1228-accept-atomic-fail")
      .send(acceptBody("issue-inf-1228-accept"));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors?.[0]?.message).toMatch(/declined|could not be applied|failed/i);
    expect(res.body._workflowTransition).toMatchObject({
      status: "failed",
      from: "intake",
      to: "write-tests",
    });
    expect(JSON.stringify(res.body)).not.toContain('"success":true');
  });
});

// ── AC2: transition-audit post-transition comparison ────────────────────────

describe("INF-1228 AC2 — verifyPostTransition compares like-for-like (full label vs bare state id)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("a healthy applied transition (Linear label == expected state) reports match:true, not a mismatch", async () => {
    // fetchStateLabel returns the FULL label name, e.g. "state:write-tests".
    // The caller (proxy.ts) passes transitionResult.to, a BARE state id, e.g.
    // "write-tests". Pre-fix these can never be string-equal, so every single
    // applied transition — including this healthy one — reports a false mismatch.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: { issue: { labels: { nodes: [{ name: "state:write-tests" }, { name: "wf:dev-impl" }] } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;

    const result = await verifyPostTransition("issue-1", "write-tests", "Bearer tok");

    expect(result).not.toBeNull();
    expect(result?.match).toBe(true);
    expect(result?.expectedState).toBe("write-tests");
  });

  it("a genuine divergence (Linear label != expected state) still reports match:false", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: { issue: { labels: { nodes: [{ name: "state:code-review" }, { name: "wf:dev-impl" }] } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;

    const result = await verifyPostTransition("issue-1", "write-tests", "Bearer tok");

    expect(result).not.toBeNull();
    expect(result?.match).toBe(false);
    expect(result?.actualState).toBe("state:code-review");
  });
});

// ── AC3: dispatch guidance can never reference a state that doesn't exist ──

describe("INF-1228 AC3 — a workflow def with a transition target that isn't a real state fails to load", () => {
  let dir: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1228-ac3-"));
    for (const key of ["WORKFLOW_DEF_PATH", "WORKFLOW_DEFS_DIR", "WORKFLOW_DEF_STATE_SNAPSHOT_PATH", "ALLOW_WORKFLOW_DEF_FIXTURE_DRIFT"]) {
      savedEnv.set(key, process.env[key]);
    }
    process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "workflow-def-state-snapshot.json");
    process.env.ALLOW_WORKFLOW_DEF_FIXTURE_DRIFT = "1";
    delete process.env.WORKFLOW_DEFS_DIR;
    resetWorkflowCache();
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetWorkflowCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a def whose 'implementation' state has an accept transition to a removed 'doing' state (the original Defect A shape)", async () => {
    // This is the exact shape the ticket describes: `implementation`'s legal
    // actions would list `linear accept <ID> (→ doing)`, but `doing` is not a
    // defined state anywhere in this def — dispatch guidance built from it
    // would reference a state that does not exist.
    const badYaml = `
id: dev-impl-ac3-fixture
version: 99
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: write-tests
        assign: { mode: auto }
  - id: write-tests
    owner_role: test-author
    native_state: todo
    transitions:
      - command: tests-ready
        to: implementation
        assign: { mode: required }
  - id: implementation
    owner_role: dev
    native_state: todo
    transitions:
      - command: accept
        to: doing
      - command: submit
        to: code-review
        generic: continue
        assign: { mode: required }
  - id: code-review
    owner_role: code-review
    native_state: todo
    transitions: []
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, badYaml, "utf8");

    await expect(loadWorkflowRegistry()).rejects.toThrow(/doing/i);
  });

  it("accepts a def whose transitions target only real states (sanity control)", async () => {
    const goodYaml = `
id: dev-impl-ac3-fixture
version: 99
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: write-tests
        assign: { mode: auto }
  - id: write-tests
    owner_role: test-author
    native_state: todo
    transitions:
      - command: tests-ready
        to: implementation
        assign: { mode: required }
  - id: implementation
    owner_role: dev
    native_state: todo
    transitions:
      - command: submit
        to: code-review
        generic: continue
        assign: { mode: required }
  - id: code-review
    owner_role: code-review
    native_state: todo
    transitions: []
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, goodYaml, "utf8");

    const registry = await loadWorkflowRegistry();
    expect(registry.has("dev-impl-ac3-fixture")).toBe(true);
  });

  it("the live registered dev-impl.yaml has no transition targeting the removed 'doing' state, and 'implementation' offers no accept verb", () => {
    const raw = fs.readFileSync(path.resolve(process.cwd(), "src/registered-defs/dev-impl.yaml"), "utf8");
    const def = yaml.load(raw) as { states: Array<{ id: string; transitions?: Array<{ command: string; to: string }> }> };

    const stateIds = new Set(def.states.map((s) => s.id));
    expect(stateIds.has("doing")).toBe(false);

    const implementation = def.states.find((s) => s.id === "implementation");
    expect(implementation?.transitions?.some((t) => t.command === "accept")).toBe(false);

    for (const state of def.states) {
      for (const t of state.transitions ?? []) {
        if (typeof t.to === "string" && !t.to.startsWith("__")) {
          expect(stateIds.has(t.to)).toBe(true);
        }
      }
    }
  });
});
