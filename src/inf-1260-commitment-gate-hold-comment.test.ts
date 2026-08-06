/**
 * INF-1260: commitment gate must ignore holds/declines — only an explicit
 * accept may advance intake.
 *
 * Bug (AC6): `autoAcceptCommitmentOnActivity` (src/webhook/index.ts:475-537),
 * invoked on every webhook event (src/webhook/index.ts:842), fires
 * `applyStateTransition("accept", issueId, token, { commitmentAutoAccept: true })`
 * on ANY `Comment` or `AgentSessionEvent` from a recognized agent actor
 * (buildAgentMap()) — there is no check for an explicit "accept" keyword/
 * intent in the comment body, and no check that the comment represents
 * approval rather than a hold/decline. The only guards are: actor must be a
 * known agent, it's not the connector's own AC-capture-warning comment, and a
 * per-claimKey dedup Set. A hold/decline comment from a recognized agent on
 * an intake-state ticket silently drives intake -> write-tests.
 *
 * This test posts a clearly-not-an-accept comment ("Holding — needs more
 * scoping before I commit") from a recognized agent and asserts the ticket
 * does NOT transition. It is RED today because the gate fires accept on any
 * qualifying activity regardless of content.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { autoAcceptCommitmentOnActivity } from "./webhook/index.js";
import { reloadAgents } from "./agents.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import type { LinearEvent } from "./webhook/index.js";

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: test-author
    grants: [linear:transition]
roles:
  - id: test-author
    requires: [linear:transition]
bodies:
  - id: tdd
    container: test-author
    fills_roles: [test-author]
`;

const TEST_WORKFLOW_YAML = `
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
        to: write-tests
        assign: { mode: auto }
  - id: write-tests
    owner_role: test-author
    kind: normal
    native_state: todo
    transitions: []
`;

function writeAgents(dir: string): string {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        {
          name: "sage",
          linearUserId: "u-sage",
          openclawAgent: "sage",
          accessToken: "tok-sage",
          host: "local",
        },
        {
          name: "tdd",
          linearUserId: "u-tdd",
          openclawAgent: "tdd",
          accessToken: "tok-tdd",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return agentsFile;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ISSUE_UUID = "issue-inf-1260-hold-uuid";
const ISSUE_IDENTIFIER = "INF-1260-HOLD";

function makeMockFetch(): { fetch: typeof globalThis.fetch; applyAtomicCalls: number } {
  let calls = 0;
  let lastDelegateId: string | null = null;
  let lastAssigneeId: string | null = null;
  let lastStateId: string | null = null;
  const labels = [
    { id: "wf-lbl", name: "wf:dev-impl" },
    { id: "state-intake", name: "state:intake" },
  ];

  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = body.query ?? "";

    if (query.includes("IssueWithLabels")) {
      return jsonResponse({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: ISSUE_IDENTIFIER,
            team: { id: "team-inf" },
            labels: { nodes: labels },
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return jsonResponse({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "wf-lbl", name: "wf:dev-impl" },
                { id: "state-intake", name: "state:intake" },
                { id: "state-write-tests", name: "state:write-tests" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("TeamStates")) {
      return jsonResponse({ data: { team: { states: { nodes: [{ id: "native-todo", name: "Todo", type: "unstarted" }] } } } });
    }
    if (query.includes("ApplyAtomicTransition")) {
      calls++;
      const vars = body.variables ?? {};
      if ("delegateId" in vars) lastDelegateId = vars.delegateId as string | null;
      if ("assigneeId" in vars) lastAssigneeId = vars.assigneeId as string | null;
      if ("stateId" in vars) lastStateId = vars.stateId as string | null;
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("VerifyTransitionWrite")) {
      return jsonResponse({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:write-tests" }] },
            delegate: lastDelegateId ? { id: lastDelegateId } : null,
            assignee: lastAssigneeId ? { id: lastAssigneeId } : null,
            state: lastStateId ? { id: lastStateId } : null,
          },
        },
      });
    }
    if (query.includes("commentCreate")) {
      return jsonResponse({ data: { commentCreate: { success: true, comment: { id: "c-1" } } } });
    }
    throw new Error(`unexpected query: ${query.slice(0, 80)}`);
  };

  return { fetch, get applyAtomicCalls() { return calls; } };
}

describe("INF-1260 AC6 (hold-comment auto-accept): commitment gate must not auto-accept on a hold/decline comment", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowDefPath: string | undefined;
  let originalCapabilityPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;

  beforeEach(() => {
    originalWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;
    originalCapabilityPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1260-hold-comment-"));
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.AGENTS_FILE = writeAgents(dir);
    reloadAgents();
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });

    if (originalWorkflowDefPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowDefPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalCapabilityPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalCapabilityPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    if (originalAgentsFile !== undefined) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
  });

  it("AC7(hold-comment auto-accept): a 'holding, not ready to commit' comment from a recognized agent does NOT advance intake to write-tests", async () => {
    const mock = makeMockFetch();
    globalThis.fetch = mock.fetch;

    const event: LinearEvent = {
      type: "Comment",
      action: "create",
      actor: { id: "u-sage", name: "Sage" },
      createdAt: new Date().toISOString(),
      data: {
        identifier: ISSUE_IDENTIFIER,
        issueId: ISSUE_UUID,
        body: "Holding — needs more scoping before I commit to this ticket.",
      },
    } as unknown as LinearEvent;

    await autoAcceptCommitmentOnActivity(event);

    // Desired: a hold/decline comment must never trigger accept. Today the
    // gate fires `accept` on ANY Comment activity from a recognized agent
    // regardless of body content — RED.
    expect(mock.applyAtomicCalls).toBe(0);
  });

  it("AC7(hold-comment auto-accept): a 'declining, out of scope' comment from a recognized agent does NOT advance intake to write-tests", async () => {
    const mock = makeMockFetch();
    globalThis.fetch = mock.fetch;

    const event: LinearEvent = {
      type: "Comment",
      action: "create",
      actor: { id: "u-sage", name: "Sage" },
      createdAt: new Date().toISOString(),
      data: {
        identifier: `${ISSUE_IDENTIFIER}-2`,
        issueId: `${ISSUE_UUID}-2`,
        body: "Declining — this is out of scope for my container.",
      },
    } as unknown as LinearEvent;

    await autoAcceptCommitmentOnActivity(event);

    expect(mock.applyAtomicCalls).toBe(0);
  });
});
