/**
 * INF-1280 — validated/ac-validate → done must write native Done atomically.
 *
 * AC map:
 * - AC1: `validated` on a dev-impl ticket applies native state (Done/completed),
 *   `state:done` label, and delegate-clear ATOMICALLY. Never returns `state: Done`
 *   while native is `unstarted`.
 * - AC2: Regression test — a `validated` transition on a dev-impl ticket leaves
 *   native = team `completed` state, `state:done` label, delegate null, asserted
 *   together.
 * - AC3: `linear migrate-state` must not throw `Cannot read properties of undefined
 *   (reading 'success')` on a successful write — the proxy must return a response
 *   shape compatible with the CLI's `data.issueUpdate.success` reader.
 * - AC4: Sibling terminal transitions (`refuse`, `cancel`, `duplicate`) must not
 *   drop the native facet.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { clearAcRecordStore } from "./ac-record-store.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { clearAppliedState } from "./store/applied-state-store.js";
import { _setTransitionWritePolicyForTests, resetWorkflowCache } from "./workflow-gate.js";

const ADMIN_SECRET = "inf-1280-admin-secret";
const AUTH = "Bearer inf-1280-token";
const TEAM_ID = "team-ai";
const ASTRID_LINEAR_ID = "user-astrid";
const VALID_BRANCH = "feature/INF-1280-validated-native-done";
const VALID_SHA = "0123456789abcdef0123456789abcdef01234567";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass
containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
roles:
  - id: steward
    requires: [human:escalate]
bodies:
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
    transitions:
      - command: submit
        to: code-review
        assign: { mode: required }
  - id: code-review
    owner_role: code-review
    native_state: todo
    transitions:
      - command: approve
        to: merge
        assign: { mode: auto }
  - id: merge
    owner_role: deployment
    native_state: todo
    transitions:
      - command: continue
        to: deploy
        assign: { mode: auto }
  - id: deploy
    owner_role: host-deploy
    native_state: todo
    transitions:
      - command: continue
        to: ac-validate
        assign: { mode: auto }
  - id: ac-validate
    owner_role: steward
    native_state: todo
    transitions:
      - command: validated
        to: done
        requires_deploy_probe: true
      - command: refuse
        to: refused
      - command: cancel
        to: cancelled
      - command: duplicate
        to: duplicate
      - command: reject
        to: implementation
        assign: { mode: none }
        feedback:
          required: true
          category_enum:
            - missing-tests
            - style
            - scope-creep
            - correctness
            - ac-mismatch
  - id: done
    kind: terminal
    native_state: done
    satisfies_parent_barrier: true
  - id: refused
    kind: terminal
    native_state: invalid
  - id: cancelled
    kind: terminal
    native_state: invalid
  - id: duplicate
    kind: terminal
    native_state: invalid
`;

const DESCR_WITH_AC = `## Problem
Regression fixture.

## Acceptance Criteria

- Governed transitions are atomic.
`;

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
        { name: "astrid", linearUserId: ASTRID_LINEAR_ID, openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
      ],
    }),
    "utf8",
  );
}

function makeLinearFetch(opts: {
  ticket: string;
  issueId: string;
  sourceState: string;
  delegateId?: string | null;
  description?: string;
  atomicSuccess?: boolean;
  /** When true, the VerifyTransitionWrite read-back returns native=unstarted (the bug). */
  verifyReturnsUnstarted?: boolean;
  /** When true, the VerifyTransitionWrite read-back is unreadable (returns null issue). */
  verifyUnreadable?: boolean;
  /** Destination state for governed transitions; defaults to done for validated. */
  targetState?: string;
  /** When set, the mock simulates a migrate-state to this target (not a validated→done). */
  migrateTarget?: string;
}) {
  const calls: GraphqlCall[] = [];
  let transitionApplied = false;
  const description = opts.description ?? DESCR_WITH_AC;
  const delegateAtStart = opts.delegateId === undefined ? ASTRID_LINEAR_ID : opts.delegateId;

  const stateLabelId = (state: string) => `label-state-${state}`;
  const nativeStateIdFor = (state: string) => state === "done" ? "state-done" : ["refused", "cancelled", "duplicate"].includes(state) ? "state-invalid" : "state-todo";
  // NOTE: deliberately NO repo:fancy-openclaw-linear-connector label — the
  // deploy-probe gate (requires_deploy_probe) only fires for connector-family
  // repos. Omitting it skips the probe so the transition reaches the write path.
  const labelsFor = (state: string) => [
    { id: "label-wf-dev-impl", name: "wf:dev-impl", team: { id: TEAM_ID } },
    { id: stateLabelId(state), name: `state:${state}`, team: { id: TEAM_ID } },
  ];

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
            state: { type: "unstarted", name: "To Do" },
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
              nodes: ["intake", "write-tests", "implementation", "code-review", "merge", "deploy", "ac-validate", "done", "refused", "cancelled", "duplicate"].map((state) => ({
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
                { id: "state-invalid", name: "Invalid", type: "canceled" },
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
      // BUG REPRO: an unreadable read-back (null issue) — Linear read replica error.
      if (opts.verifyUnreadable) {
        return json({ data: { issue: null } });
      }
      // Migrate-state path: the write lands on the migrate target, not "done".
      const landedState = opts.migrateTarget ?? opts.targetState ?? "done";
      const state = transitionApplied ? landedState : opts.sourceState;
      // BUG REPRO: when verifyReturnsUnstarted, the read-back shows native=unstarted
      // even though the mutation reported success — the partial write.
      const nativeId = opts.verifyReturnsUnstarted
        ? "state-todo"
        : transitionApplied ? nativeStateIdFor(landedState) : "state-todo";
      return json({
        data: {
          issue: {
            labels: { nodes: labelsFor(state).map((label) => ({ name: label.name })) },
            delegate: transitionApplied ? null : delegateAtStart ? { id: delegateAtStart } : null,
            assignee: null,
            state: { id: nativeId },
          },
        },
      });
    }
    return json({ data: { issueUpdate: { success: true, issue: { id: opts.issueId } } } });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    transitionWrites: () => calls.filter((call) => call.query.includes("ApplyAtomicTransition")),
    verifyReads: () => calls.filter((call) => call.query.includes("VerifyTransitionWrite")),
  };
}

function transitionBody(issueId: string, operationName = "Transition"): Record<string, unknown> {
  return {
    operationName,
    query: `mutation ${operationName}($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }`,
    variables: { id: issueId, input: { description: "terminal transition" } },
  };
}

describe("INF-1280 validated → done native state atomicity", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1280-"));
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
    clearAppliedState("INF-1280");
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function submitTransition(intent: string, issueId: string, commandId: string) {
    return request(appState.app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("Authorization", AUTH)
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", intent)
      .set("X-Openclaw-Linear-Cli-Version", "999.0.0")
      .set("X-Openclaw-Command-Id", commandId)
      .set("X-Openclaw-Code-Artifact", `${VALID_BRANCH}@${VALID_SHA}`)
      .send(transitionBody(issueId, intent.replace(/[^a-zA-Z0-9_]/g, "_")));
  }

  function submitValidated(issueId: string, commandId: string) {
    return submitTransition("validated", issueId, commandId);
  }

  it("AC2: validated transition writes native Done + state:done label + delegate null atomically", async () => {
    const transport = makeLinearFetch({ ticket: "INF-1280", issueId: "issue-inf-1280", sourceState: "ac-validate" });
    globalThis.fetch = transport.fetch;

    const res = await submitValidated("issue-inf-1280", "cmd-inf-1280-ac2");

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition).toMatchObject({
      status: "applied",
      from: "ac-validate",
      to: "done",
    });

    // The atomic write must include native stateId = Done (completed).
    expect(transport.transitionWrites()).toHaveLength(1);
    expect(transport.transitionWrites()[0].variables).toMatchObject({
      labelIds: expect.arrayContaining(["label-state-done"]),
      delegateId: null,
      stateId: "state-done",
    });
  });

  it("AC1: never returns state:Done while native is unstarted — verification catches the desync", async () => {
    const transport = makeLinearFetch({
      ticket: "INF-1280",
      issueId: "issue-inf-1280",
      sourceState: "ac-validate",
      verifyReturnsUnstarted: true, // BUG: native stays To Do after "successful" write
    });
    globalThis.fetch = transport.fetch;

    const res = await submitValidated("issue-inf-1280", "cmd-inf-1280-ac1");

    // The transition must NOT report applied when native verification fails.
    expect(res.body._workflowTransition.status).not.toBe("applied");
  });

  it("AC1 (fail-loud gap): a terminal validated write whose read-back is UNREADABLE must not return applied-unverified", async () => {
    const transport = makeLinearFetch({
      ticket: "INF-1280",
      issueId: "issue-inf-1280",
      sourceState: "ac-validate",
      verifyUnreadable: true, // Linear read replica error — verification returns null
    });
    globalThis.fetch = transport.fetch;

    const res = await submitValidated("issue-inf-1280", "cmd-inf-1280-ac1-unreadable");

    // The production bug: dev-impl terminal transitions accept an unreadable
    // verification as "unverified" (fail-open), returning state:Done while the
    // native facet may be To Do. The strict requireReadableVerification gate is
    // scoped to workflowId === "task" only. A terminal done transition on ANY
    // workflow must require a readable native==completed read-back before
    // returning success.
    expect(res.body._workflowTransition.status).not.toBe("applied");
  });

  it("AC3: migrate-state returns an issueUpdate.success-compatible shape so the break-glass CLI does not throw", async () => {
    const transport = makeLinearFetch({ ticket: "INF-1280", issueId: "issue-inf-1280", sourceState: "intake", migrateTarget: "ac-validate" });
    globalThis.fetch = transport.fetch;

    // The CLI's break-glass migrate-state sends an `issueUpdate ... { success }`
    // mutation and reads `data.issueUpdate.success`. Pre-fix the proxy returned ONLY
    // `data.migrateState`, so `data.issueUpdate` was undefined and the CLI threw
    // `Cannot read properties of undefined (reading 'success')` on a successful write.
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("Authorization", AUTH)
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      .set("X-Openclaw-Migrate-Target", "ac-validate")
      .set("X-Openclaw-Linear-Cli-Version", "999.0.0")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: { labelIds: [\"label-state-ac-validate\"] }) { success } }",
        variables: { id: "issue-inf-1280" },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    // The CLI reader must find data.issueUpdate.success — no spurious throw.
    expect(res.body.data?.issueUpdate?.success).toBe(true);
    // The structured migrateState payload is preserved for machine readers.
    expect(res.body.data?.migrateState?.to).toBe("ac-validate");
  });

  it.each([
    ["refuse", "refused"],
    ["cancel", "cancelled"],
    ["duplicate", "duplicate"],
  ])("AC4: %s terminal transition writes native invalid/canceled atomically", async (intent, targetState) => {
    const transport = makeLinearFetch({
      ticket: "INF-1280",
      issueId: "issue-inf-1280",
      sourceState: "ac-validate",
      targetState,
    });
    globalThis.fetch = transport.fetch;

    const res = await submitTransition(intent, "issue-inf-1280", `cmd-inf-1280-${intent}`);

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition).toMatchObject({
      status: "applied",
      from: "ac-validate",
      to: targetState,
    });
    expect(transport.transitionWrites()).toHaveLength(1);
    expect(transport.transitionWrites()[0].variables).toMatchObject({
      labelIds: expect.arrayContaining([`label-state-${targetState}`]),
      delegateId: null,
      stateId: "state-invalid",
    });
  });
});
