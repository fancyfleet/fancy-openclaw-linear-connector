/**
 * INF-1276 — a comment-carried governed forward transition that BLOCKS (not
 * merely FAILS) must decline loudly with the blocker code/detail, never a
 * GraphQL success payload with only `_workflowTransition.status: "blocked"`
 * attached.
 *
 * AC map (verbatim from the ticket):
 * 1. Comment-carried governed forward transitions that are blocked by a gate
 *    return a loud caller-visible failure, not a GraphQL success payload with
 *    only `_workflowTransition.status: "blocked"` attached.
 * 2. The loud failure includes the blocker code/detail, including the
 *    `push-before-claim` no-artifact / no-origin-repository-context reason.
 * 3. The existing successful-comment behavior is preserved: when the comment
 *    has already posted, the surfaced failure says so instead of implying the
 *    whole operation rolled back.
 * 4. (CLI-side, covered in the skill repo test suite) The Linear skill CLI
 *    treats `_workflowTransition.status === "blocked"` as a thrown error and
 *    surfaces `detail` to the caller.
 * 5. Regression coverage proves the no-`repo:*` / no-GitHub-attachment /
 *    no `X-Openclaw-Code-Artifact` submit path fails loudly instead of
 *    silently leaving the ticket in implementation.
 * 6. Existing issueUpdate-carried blocked-forward behavior from INF-1228
 *    remains covered and unchanged.
 *
 * The defect (confirmed by Grover's live repro on origin/main @ 41e720bb):
 * the normal CLI submit path posts the comment FIRST and the comment carries
 * the intent (`commentTriggersProxy`). The mutation the proxy gates is a
 * `commentCreate`, so `genericContinueForward` (computed only inside the
 * `isIssueUpdateMutation(body)` branch) and `loudPeerFail` (requires
 * `isIssueUpdateMutation(body)`) both stay false, and the push-before-claim
 * `status: "blocked"` result falls through to the `attachTransition`
 * branch — a success payload (`commentCreate.success: true`) with the decline
 * buried in `_workflowTransition`. The INF-1228 generalization covered
 * blocked forwards only on the issueUpdate-carried path.
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
import { _setTransitionWritePolicyForTests, resetWorkflowCache } from "./workflow-gate.js";

const ADMIN_SECRET = "inf-1276-admin-secret";
const AUTH = "Bearer inf-1276-token";
const TEAM_ID = "team-ai";
const IGOR_LINEAR_ID = "user-igor";
const CHARLES_LINEAR_ID = "user-charles";

// ── fixtures ────────────────────────────────────────────────────────────────

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
// evidence check. version < 10 so the AI-2476 merge/deploy gate-anchor drift
// guard (unrelated to this ticket) doesn't require those states in this
// fixture.
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

type TicketState = "implementation" | "code-review";
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
        { name: "tdd", linearUserId: "user-tdd", openclawAgent: "tdd", accessToken: "tok-tdd", host: "local" },
        { name: "astrid", linearUserId: "user-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
      ],
    }),
    "utf8",
  );
}

/**
 * Minimal Linear fetch mock for the commentCreate-carried submit path.
 *
 * The ticket has NO `repo:*` label and ZERO GitHub attachments — the exact
 * no-repository-context shape AC5 names. `includeRepoLabel` toggles the
 * control (when true, a `repo:*` label is present so an artifact-supplied
 * submit could in principle resolve origin context; used by the AC6
 * issueUpdate-carried regression test).
 */
function makeLinearFetch(opts: { ticket: string; issueId: string; includeRepoLabel?: boolean }) {
  const calls: GraphqlCall[] = [];
  const includeRepoLabel = opts.includeRepoLabel ?? false;

  const labelsFor = (state: TicketState) => [
    { id: "label-wf-dev-impl", name: "wf:dev-impl", team: { id: TEAM_ID } },
    { id: `label-state-${state}`, name: `state:${state}`, team: { id: TEAM_ID } },
    ...(includeRepoLabel
      ? [{ id: "label-repo-connector", name: "repo:fancy-openclaw-linear-connector", team: { id: TEAM_ID } }]
      : []),
  ];
  const labelNamesFor = (state: TicketState) => labelsFor(state).map((l) => l.name);

  const fetch = (async (url: unknown, init?: RequestInit) => {
    const urlText = String(url);
    if (!urlText.includes("api.linear.app")) {
      return json({ status: "identical", reachable: true });
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphqlCall;
    calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
    const query = parsed.query ?? "";

    if (query.includes("commentCreate")) {
      // The comment posts successfully upstream — this is the success the AC3
      // "comment has already posted" preservation clause refers to.
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    }
    if (query.includes("IssueDescription")) {
      return json({ data: { issue: { description: "## Problem\nRegression fixture.\n" } } });
    }
    if (query.includes("IssueContext")) {
      return json({
        data: {
          issue: {
            identifier: opts.ticket,
            labels: { nodes: labelsFor("implementation").map((label) => ({ name: label.name })) },
            delegate: { id: IGOR_LINEAR_ID },
            state: { type: "started", name: "To Do" },
          },
        },
      });
    }
    if (query.includes("IssueLabels")) {
      return json({ data: { issue: { labels: { nodes: labelsFor("implementation").map((label) => ({ name: label.name })) } } } });
    }
    if (query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: opts.issueId,
            identifier: opts.ticket,
            team: { id: TEAM_ID, key: "AI", name: "AI" },
            labels: { nodes: labelsFor("implementation") },
            delegate: { id: IGOR_LINEAR_ID },
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
                id: `label-state-${state}`,
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
      // AC5: zero GitHub attachments — no origin repository context.
      return json({ data: { issue: { attachments: { nodes: [] } } } });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }

    return json({ data: { issueUpdate: { success: true, issue: { id: opts.issueId } } } });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    labelNamesAt: (state: TicketState) => labelNamesFor(state),
  };
}

/** The CLI's normal submit path: a commentCreate that carries the intent. */
function commentSubmitBody(issueId: string): Record<string, unknown> {
  return {
    operationName: "SubmitImplementationComment",
    query:
      "mutation SubmitImplementationComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id url } } }",
    variables: { issueId, body: "implementation submitted for review" },
  };
}

/** The legacy issueUpdate-carried path (INF-1228 shape) — for the AC6 regression test. */
function issueUpdateSubmitBody(issueId: string): Record<string, unknown> {
  return {
    operationName: "SubmitImplementation",
    query: "mutation SubmitImplementation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }",
    variables: { id: issueId, input: { description: "implementation submitted" } },
  };
}

const SUBMIT_INTENT_HEADERS = {
  "X-Openclaw-Agent": "igor",
  "X-Openclaw-Linear-Intent": "submit",
  "X-Openclaw-Linear-Cli-Version": "999.0.0",
  "X-Openclaw-Command-Id": "cmd-inf-1276-comment-submit",
};

describe("INF-1276 AC1/AC2/AC3 — commentCreate-carried submit blocked by push-before-claim declines loudly", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1276-"));
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
    clearAppliedState("INF-1276");
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC1+AC2+AC3: no-artifact commentCreate submit returns an errors[] envelope carrying push-before-claim + comment-posted note, never a success payload", async () => {
    const transport = makeLinearFetch({ ticket: "INF-1276", issueId: "issue-inf-1276" });
    globalThis.fetch = transport.fetch;

    // Deliberately omit X-Openclaw-Code-Artifact (and there is no repo:* label,
    // no GitHub attachment) so the push-before-claim gate blocks.
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("Authorization", AUTH)
      .set(SUBMIT_INTENT_HEADERS)
      .send(commentSubmitBody("issue-inf-1276"));

    expect(res.status).toBe(200);
    // AC1: explicit GraphQL error envelope — no success `data` at all. Pre-fix
    // this body is `{ data: { commentCreate: { success: true } },
    // _workflowTransition: { status: "blocked", ... } }` — the masked success.
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors?.[0]).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain('"success":true');
    // AC2: the loud failure carries the blocker code and detail.
    expect(res.body._workflowTransition).toMatchObject({
      status: "blocked",
      code: "push-before-claim",
      from: "implementation",
      to: "code-review",
    });
    expect(res.body.errors?.[0]?.extensions?.code).toBe("push-before-claim");
    expect(res.body.errors?.[0]?.message).toMatch(/push-before-claim/);
    expect(res.body.errors?.[0]?.message).toMatch(/published artifact|no origin repository context/i);
    // AC3: the comment HAD already posted upstream — the surfaced failure must
    // say so, not imply the whole operation rolled back.
    expect(res.body.errors?.[0]?.message).toMatch(/comment.*(post|preserv|creat)|(post|preserv|creat).*comment/i);
    expect(res.body.errors?.[0]?.message).not.toMatch(/rolled back|reverted|did not post|was not posted/i);
    // No atomic transition write should have landed for a blocked gate.
    expect(transport.calls.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
  });

  it("AC2+AC5: artifact supplied but no repo:* label / no GitHub attachment blocks with the no-origin-repository-context reason, loudly", async () => {
    const transport = makeLinearFetch({ ticket: "INF-1276", issueId: "issue-inf-1276" });
    globalThis.fetch = transport.fetch;

    // Artifact IS supplied, but the ticket has no repo:* label and zero GitHub
    // attachments → the gate blocks at the no-origin-repository-context path.
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("Authorization", AUTH)
      .set({
        ...SUBMIT_INTENT_HEADERS,
        "X-Openclaw-Command-Id": "cmd-inf-1276-comment-submit-with-artifact",
        "X-Openclaw-Code-Artifact": "feature/INF-1276-test@0123456789abcdef0123456789abcdef01234567",
      })
      .send(commentSubmitBody("issue-inf-1276"));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors?.[0]).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain('"success":true');
    expect(res.body._workflowTransition).toMatchObject({
      status: "blocked",
      code: "push-before-claim",
      from: "implementation",
      to: "code-review",
    });
    expect(res.body.errors?.[0]?.message).toMatch(/no origin repository context/i);
    expect(res.body.errors?.[0]?.message).toMatch(/repo\*|GitHub attachment/i);
  });

  it("AC6 regression: issueUpdate-carried blocked forward still declines loudly (INF-1228 behavior unchanged)", async () => {
    const transport = makeLinearFetch({ ticket: "INF-1276", issueId: "issue-inf-1276" });
    globalThis.fetch = transport.fetch;

    // Legacy issueUpdate-carried submit (INF-1228 path) — no artifact.
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("Authorization", AUTH)
      .set({ ...SUBMIT_INTENT_HEADERS, "X-Openclaw-Command-Id": "cmd-inf-1276-issueupdate-submit" })
      .send(issueUpdateSubmitBody("issue-inf-1276"));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors?.[0]).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain('"success":true');
    expect(res.body._workflowTransition).toMatchObject({
      status: "blocked",
      code: "push-before-claim",
      from: "implementation",
      to: "code-review",
    });
  });

  it("AC6 regression (control): with repo context + valid artifact the same commentCreate submit is NOT loudly declined", async () => {
    const transport = makeLinearFetch({ ticket: "INF-1276", issueId: "issue-inf-1276", includeRepoLabel: true });
    globalThis.fetch = transport.fetch;

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Content-Type", "application/json")
      .set("Authorization", AUTH)
      .set({
        ...SUBMIT_INTENT_HEADERS,
        "X-Openclaw-Command-Id": "cmd-inf-1276-control-pass",
        "X-Openclaw-Code-Artifact": "feature/INF-1276-test@0123456789abcdef0123456789abcdef01234567",
      })
      .send(commentSubmitBody("issue-inf-1276"));

    // The control: no loud decline. The verifyCommitReachableOnOrigin call for
    // origin repo `fancyfleet/fancy-openclaw-linear-connector` hits the mock's
    // non-Linear branch ({"status":"identical"}) — treat reachable, so the gate
    // passes and the response is a normal payload (with `data` present).
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.errors).toBeUndefined();
  });
});
