/**
 * INF-1147 — governed dev-impl forward transitions must be atomic.
 *
 * AC map:
 * - T1: dev -> reviewer through the normal `continue-workflow` verb with
 *   `--target` applies the full tuple (delegate + state:* + native state) in
 *   one verified transition write.
 * - T2: missing AC-of-record is a loud, repairable decline. The in-seat repair
 *   surface (`recapture-ac`) is exercised, then the same normal verb can proceed.
 * - T3: clean-state LIF-368-style `doing -> code-review` is proven distinct
 *   from older `implementation -> code-review` residuals.
 * - Atomicity regression: if the bundled transition write cannot land, the
 *   caller gets an explicit decline and no pre-atomic delegate/state split is
 *   written by the forwarded mutation.
 *
 * Live verification note: LIF-368 and LIF-359 still require post-implementation
 * manual live verification through the normal Linear verb.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { clearAcRecordStore, getAcRecord } from "./ac-record-store.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { clearAppliedState } from "./store/applied-state-store.js";
import { _setTransitionWritePolicyForTests, resetWorkflowCache } from "./workflow-gate.js";

const ADMIN_SECRET = "inf-1147-admin-secret";
const AUTH = "Bearer inf-1147-token";
const TEAM_ID = "team-ai";
const IGOR_LINEAR_ID = "user-igor";
const CHARLES_LINEAR_ID = "user-charles";
const ASTRID_LINEAR_ID = "user-astrid";
// INF-1147 T2: production fills the `test-author` (write-tests owner) role with the
// TDD singleton, which HAS a linearUserId — so the accept→write-tests forward resolves
// a real delegate. The original T2 fixture left this role unfilled, so nothing was ever
// injected and the split-brain on `accept` was invisible (Charles's PR #650 review).
const TDD_LINEAR_ID = "user-tdd";
const VALID_BRANCH = "feature/INF-1147-atomic-dev-impl-forward-transitions";
const VALID_SHA = "0123456789abcdef0123456789abcdef01234567";

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

const DEV_IMPL_YAML = `
id: dev-impl
version: 18
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
    commitment_gate:
      exits:
        accept: { to: doing }
        reject: { to: rejected }
        not-ready: { to: needs-info }
    transitions:
      - command: accept
        to: doing
      - command: reject
        to: rejected
        requires_comment: true
      - command: not-ready
        to: needs-info
        requires_comment: true
      - command: submit
        to: code-review
        generic: continue
        assign:
          mode: required
          constraint: not-implementer
  - id: doing
    owner_role: dev
    native_state: doing
    transitions:
      - command: submit
        to: code-review
        generic: continue
        assign:
          mode: required
          constraint: not-implementer
  - id: needs-info
    owner_role: dev
    native_state: todo
    transitions: []
  - id: rejected
    kind: terminal
    native_state: invalid
    transitions: []
  - id: code-review
    owner_role: code-review
    native_state: todo
    transitions: []
  - id: merge
    owner_role: deployment
    native_state: todo
    transitions: []
  - id: deploy
    owner_role: host-deploy
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
- Recapture repairs missing AC-of-record before forward progress.
`;

const DESCR_WITHOUT_AC = `## Problem
Regression fixture with no acceptance section.

## Notes
This is intentionally incomplete.
`;

type TicketState = "intake" | "doing" | "implementation" | "write-tests" | "code-review";
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
  let description = opts.description ?? DESCR_WITH_AC;
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
  const destination = opts.sourceState === "intake" ? "write-tests" : "code-review";
  // INF-1147 T2: write-tests is owned by `test-author`, filled by the TDD singleton
  // (production parity) — the accept forward advances the delegate to TDD, not null.
  const destinationDelegate = destination === "write-tests" ? TDD_LINEAR_ID : CHARLES_LINEAR_ID;

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
            state: { type: "started", name: opts.sourceState === "doing" ? "Doing" : "To Do" },
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
            state: { id: opts.sourceState === "doing" ? "state-doing" : "state-todo" },
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return json({
        data: {
          team: {
            labels: {
              nodes: ["intake", "write-tests", "implementation", "doing", "code-review"].map((state) => ({
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
      const state = transitionApplied ? destination : opts.sourceState;
      return json({
        data: {
          issue: {
            labels: { nodes: labelsFor(state).map((label) => ({ name: label.name })) },
            delegate: transitionApplied
              ? destinationDelegate === null ? null : { id: destinationDelegate }
              : delegateAtStart ? { id: delegateAtStart } : null,
            assignee: null,
            state: {
              id: transitionApplied
                ? "state-todo"
                : opts.sourceState === "doing"
                  ? "state-doing"
                  : "state-todo",
            },
          },
        },
      });
    }

    return json({ data: { issueUpdate: { success: true, issue: { id: opts.issueId } } } });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    setDescription(next: string) {
      description = next;
    },
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

describe("INF-1147 governed dev-impl atomic forward transitions", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1147-"));
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
    clearAppliedState("INF-1147");
    clearAppliedState("LIF-368");
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function continueSubmit(ticket: string, issueId: string, commandId: string) {
    appState.operationalEventStore.append({
      outcome: "commitment-exit-recorded",
      agent: "igor",
      key: ticket,
      detail: {
        workflow: "dev-impl",
        from: "implementation",
        exit: "accept",
        to: "doing",
        auto: false,
      },
    });
    return request(appState.app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("Authorization", AUTH)
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "continue-workflow")
      .set("X-Openclaw-Linear-Target", "charles")
      .set("X-Openclaw-Linear-Cli-Version", "999.0.0")
      .set("X-Openclaw-Command-Id", commandId)
      .set("X-Openclaw-Code-Artifact", `${VALID_BRANCH}@${VALID_SHA}`)
      .send(submitBody(issueId));
  }

  it("T1: dev -> reviewer continue-workflow with --target writes delegate + state label + native state only as one atomic tuple", async () => {
    const transport = makeLinearFetch({ ticket: "INF-1147", issueId: "issue-inf-1147", sourceState: "doing" });
    globalThis.fetch = transport.fetch;

    const res = await continueSubmit("INF-1147", "issue-inf-1147", "cmd-inf-1147-t1");

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition).toMatchObject({
      status: "applied",
      from: "doing",
      to: "code-review",
    });

    const forwardedInputs = transport.upstreamIssueUpdates().map((call) => call.variables.input as Record<string, unknown>);
    expect(forwardedInputs).not.toContainEqual(expect.objectContaining({
      delegateId: expect.anything(),
    }));
    expect(forwardedInputs).not.toContainEqual(expect.objectContaining({
      assigneeId: expect.anything(),
    }));

    expect(transport.transitionWrites()).toHaveLength(1);
    expect(transport.transitionWrites()[0].variables).toMatchObject({
      labelIds: expect.arrayContaining(["label-state-code-review"]),
      delegateId: CHARLES_LINEAR_ID,
      assigneeId: null,
      stateId: "state-todo",
    });
  });

  it("T3: LIF-368 clean-state doing -> code-review is resolved from doing, not the older implementation residual", async () => {
    const transport = makeLinearFetch({ ticket: "LIF-368", issueId: "issue-lif-368", sourceState: "doing" });
    globalThis.fetch = transport.fetch;

    const res = await continueSubmit("LIF-368", "issue-lif-368", "cmd-lif-368-clean-state");

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition).toMatchObject({
      status: "applied",
      from: "doing",
      to: "code-review",
    });
    expect(String(res.text)).not.toMatch(/implementation/);
    const forwardedInputs = transport.upstreamIssueUpdates().map((call) => call.variables.input as Record<string, unknown>);
    expect(forwardedInputs).not.toContainEqual(expect.objectContaining({
      delegateId: CHARLES_LINEAR_ID,
    }));
    expect(transport.transitionWrites()).toHaveLength(1);
    expect(transport.transitionWrites()[0].variables.labelIds).toEqual(
      expect.arrayContaining(["label-state-code-review"]),
    );
    expect(transport.transitionWrites()[0].variables.labelIds).toEqual(
      expect.not.arrayContaining(["label-state-implementation"]),
    );
    expect(transport.transitionWrites()[0].variables).toMatchObject({
      delegateId: CHARLES_LINEAR_ID,
      stateId: "state-todo",
    });
  });

  it("atomicity regression: failed bundled transition declines explicitly and never reports success beside a split-brain delegate write", async () => {
    const transport = makeLinearFetch({
      ticket: "INF-1147",
      issueId: "issue-inf-1147",
      sourceState: "doing",
      atomicSuccess: false,
    });
    globalThis.fetch = transport.fetch;

    const res = await continueSubmit("INF-1147", "issue-inf-1147", "cmd-inf-1147-fail");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      errors: [
        {
          message: expect.stringMatching(/transition|atomic|delegate|state|fully apply/i),
        },
      ],
    });
    expect(res.body.data).toBeUndefined();
    expect(res.body._workflowTransition).toMatchObject({
      status: "failed",
      code: expect.stringMatching(/transition-write|atomic|failed/i),
      from: "doing",
      to: "code-review",
    });
    expect(JSON.stringify(res.body)).not.toMatch(/No state was changed|no partial state was written/i);

    const forwardedInputs = transport.upstreamIssueUpdates().map((call) => call.variables.input as Record<string, unknown>);
    expect(forwardedInputs).not.toContainEqual(expect.objectContaining({
      delegateId: CHARLES_LINEAR_ID,
    }));
  });

  it("T2: missing AC-of-record blocks accept, then recapture-ac repairs the record and the normal verb can proceed", async () => {
    const transport = makeLinearFetch({
      ticket: "INF-1147",
      issueId: "issue-inf-1147",
      sourceState: "intake",
      description: DESCR_WITHOUT_AC,
    });
    globalThis.fetch = transport.fetch;

    const blocked = await request(appState.app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("Authorization", AUTH)
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "begin-workflow")
      .set("X-Openclaw-Linear-Cli-Version", "999.0.0")
      .set("X-Openclaw-Command-Id", "cmd-inf-1147-missing-ac")
      .send(acceptBody("issue-inf-1147"));

    expect(blocked.status).toBe(200);
    expect(blocked.body._workflowTransition).toMatchObject({
      status: "blocked",
      code: "ac-of-record-missing",
      from: "intake",
      to: "write-tests",
    });
    expect(blocked.body._workflowTransition.detail).toMatch(/recapture/i);
    expect(transport.transitionWrites()).toHaveLength(0);
    expect(await getAcRecord("INF-1147")).toBeNull();

    // INF-1147 T2 split-brain guard (the assertion the original fixture lacked —
    // Charles's PR #650 review). Production fills `test-author` with the TDD
    // singleton, so `accept` resolves a real delegate. The gate then declines the
    // state write. The forwarded upstream mutation MUST NOT carry that delegate,
    // or we get delegate-advanced-to-TDD / state-stuck-at-intake — the exact
    // split-brain this ticket kills. Assert the forward carries no delegate/assignee.
    const blockedForwardInputs = transport
      .upstreamIssueUpdates()
      .map((call) => call.variables.input as Record<string, unknown>);
    for (const input of blockedForwardInputs) {
      expect(input).not.toHaveProperty("delegateId");
      expect(input).not.toHaveProperty("assigneeId");
    }
    expect(blockedForwardInputs).not.toContainEqual(
      expect.objectContaining({ delegateId: TDD_LINEAR_ID }),
    );

    // AC #2 — the decline is LOUD: an explicit error envelope with the repair
    // reason, never a false success payload beside a non-applied transition.
    expect(blocked.body.data).toBeUndefined();
    expect(blocked.body.errors?.[0]?.message).toMatch(/declined|recapture|ac of record/i);
    expect(JSON.stringify(blocked.body)).not.toMatch(/no partial state was written/i);

    transport.setDescription(DESCR_WITH_AC);
    const repaired = await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({
        ticketId: "INF-1147",
        callerBodyId: "astrid",
        invoker: "astrid",
        reason: "INF-1147 repair missing AC of record before begin-workflow",
      });

    expect(repaired.status).toBe(200);
    expect(repaired.body).toMatchObject({ ok: true, ticketId: "INF-1147" });
    await expect(getAcRecord("INF-1147")).resolves.toMatchObject({
      verbatimAc: expect.stringContaining("Governed transitions are atomic."),
      capturedBy: "astrid",
    });

    const accepted = await request(appState.app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("Authorization", AUTH)
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "begin-workflow")
      .set("X-Openclaw-Linear-Cli-Version", "999.0.0")
      .set("X-Openclaw-Command-Id", "cmd-inf-1147-recaptured-ac")
      .send(acceptBody("issue-inf-1147"));

    expect(accepted.status).toBe(200);
    expect(accepted.body._workflowTransition).toMatchObject({
      status: "applied",
      from: "intake",
      to: "write-tests",
    });
  });
});
