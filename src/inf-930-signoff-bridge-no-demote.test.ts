/**
 * INF-930: xfn sign-off bridges must not auto-demote into dispatch-skipped Backlog.
 *
 * Cross-functional / `xfn:workflow` bridge tickets the sprint-spawner mints as
 * **designated-approver sign-off bridges** (delegated to Ai, who holds
 * `sprint:signoff`) were being run through the same cross-functional demotion
 * path as ad-hoc board injections (INF-880). That stripped the delegate and
 * parked the ticket in Backlog, which is dispatch-skipped — so the approver was
 * never woken and the parent spawner stalled at its launch/sign-off gate
 * (live incident: INF-929 → INF-196 Cycle 15).
 *
 * AC mapping:
 * - AC1: a mint/update delegated to a designated approver (a body holding
 *   `sprint:signoff`) is NOT demoted; it lands in its requested active state and
 *   dispatches to the approver, delegate preserved.
 * - AC3: behavioral proof — the sign-off bridge reaches To Do with the approver
 *   still delegated (no manual promote), and no steward-triage comment is posted.
 * - AC4: idempotent intake — replaying the demote against a ticket a steward has
 *   already promoted out of Backlog does not re-demote it.
 *
 * A plain (non-approver) cross-functional injection must still be demoted
 * (INF-880 regression guard), so the exemption is scoped to approver delegates.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";

// `ai` holds `sprint:signoff` (the designated-approver capability, per INF-629);
// `igor` (dev) does not. `laren` (design) originates ad-hoc injections.
const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: sprint:signoff

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: ai
    grants: [linear:transition, sprint:signoff]
  - id: design
    grants: [linear:transition]
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: design
    requires: [linear:transition]
  - id: dev
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: ai
    container: ai
    fills_roles: []
  - id: laren
    container: design
    fills_roles: [design]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const WORKFLOW_YAML = `
id: dev-impl
version: 1
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
        to: implementation
  - id: implementation
    owner_role: dev
    native_state: doing
    transitions:
      - command: submit
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

type GraphQLCall = {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
};

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "ai", linearUserId: "u-ai", openclawAgent: "ai", accessToken: "tok-ai", host: "local" },
        { name: "laren", linearUserId: "u-laren", openclawAgent: "laren", accessToken: "tok-laren", host: "local" },
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

function writePolicyFile(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(file, POLICY_YAML, "utf8");
  return file;
}

function writeWorkflowFile(dir: string): string {
  const file = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(file, WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = file;
  return file;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function inputOf(call: GraphQLCall): Record<string, unknown> {
  const fromInput = call.variables.input;
  if (fromInput && typeof fromInput === "object" && !Array.isArray(fromInput)) {
    return fromInput as Record<string, unknown>;
  }
  return call.variables;
}

/**
 * `promotedIssue` controls the IssueContext response for the update path:
 *  - false: issue sits in Backlog with no xfn labels (fresh injection)
 *  - true:  issue is an already-demoted xfn request a steward promoted to To Do
 */
function makeLinearFetch(opts: { promotedIssue?: boolean } = {}): { fetch: typeof globalThis.fetch; calls: GraphQLCall[] } {
  const calls: GraphQLCall[] = [];

  const fetchMock: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphQLCall;
    calls.push(parsed);
    const query = parsed.query ?? "";

    if (query.includes("IssueContext") || (query.includes("labels") && query.includes("delegate"))) {
      return json({
        data: {
          issue: {
            id: "issue-uuid",
            identifier: "INF-XFN",
            team: { id: "team-inf", key: "INF", name: "Infrastructure" },
            creator: { id: "u-laren", name: "Laren (CDO)" },
            state: opts.promotedIssue
              ? { id: "s-todo", name: "To Do", type: "unstarted" }
              : { id: "s-backlog", name: "Backlog", type: "backlog" },
            labels: {
              nodes: opts.promotedIssue
                ? [{ id: "lbl-cross-functional", name: "cross-functional-request" }, { id: "lbl-xfn-design", name: "xfn:design" }]
                : [],
            },
            delegate: null,
          },
        },
      });
    }

    if (query.includes("team") && query.includes("states")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "s-backlog", name: "Backlog", type: "backlog" },
                { id: "s-todo", name: "To Do", type: "unstarted" },
                { id: "s-doing", name: "Doing", type: "started" },
                { id: "s-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("team") && query.includes("labels")) {
      return json({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "lbl-cross-functional", name: "cross-functional-request" },
                { id: "lbl-xfn-ai", name: "xfn:ai" },
                { id: "lbl-xfn-design", name: "xfn:design" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("issueCreate")) {
      return json({ data: { issueCreate: { success: true, issue: { id: "issue-uuid", identifier: "INF-XFN" } } } });
    }

    if (query.includes("issueUpdate")) {
      return json({ data: { issueUpdate: { success: true, issue: { id: "issue-uuid", identifier: "INF-XFN" } } } });
    }

    if (query.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-1", url: "https://linear.app/comment-1" } } } });
    }

    return json({ data: {} });
  };

  return { fetch: fetchMock, calls };
}

describe("INF-930 sign-off bridge is exempt from cross-functional demotion", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  function boot(fetchImpl: typeof globalThis.fetch): void {
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-930-xfn-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    writeWorkflowFile(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      mutationAuditDbPath: path.join(dir, "audit.db"),
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.mutationAuditStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
  });

  it("AC1/AC3: an issueCreate delegated to a designated approver (sprint:signoff) is not demoted", async () => {
    const mock = makeLinearFetch();
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-laren")
      .set("X-Openclaw-Agent", "laren")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation CreateSignoffBridge($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }`,
        variables: {
          input: {
            teamId: "team-inf",
            title: "Ai sign-off bridge: launch Helm Cycle 15 dev-sprint",
            stateId: "s-todo",
            delegateId: "u-ai",
            labelIds: [],
          },
        },
        operationName: "CreateSignoffBridge",
      });

    expect(res.body.errors).toBeUndefined();

    const create = mock.calls.find((c) => c.query.includes("issueCreate"));
    expect(create).toBeDefined();
    const createInput = inputOf(create!);
    // Not demoted: stays in the requested active state with the approver delegated.
    expect(createInput.stateId).toBe("s-todo");
    expect(createInput.delegateId).toBe("u-ai");
    expect(createInput.labelIds ?? []).not.toEqual(
      expect.arrayContaining(["lbl-cross-functional"]),
    );
    // No steward-triage comment (the path that collides with the 3/300s limit).
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });

  it("AC1: an issueUpdate delegating to a designated approver is not demoted", async () => {
    const mock = makeLinearFetch();
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-laren")
      .set("X-Openclaw-Agent", "laren")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation MoveBridge($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-uuid",
          input: { stateId: "s-todo", delegateId: "u-ai" },
        },
        operationName: "MoveBridge",
      });

    expect(res.body.errors).toBeUndefined();
    const forwarded = mock.calls.filter((c) => c.query.includes("issueUpdate") && !c.query.includes("IssueContext"));
    expect(forwarded.some((c) => inputOf(c).stateId === "s-backlog")).toBe(false);
    expect(forwarded.some((c) => inputOf(c).stateId === "s-todo")).toBe(true);
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });

  it("regression (INF-880): a non-approver delegate injection is still demoted", async () => {
    const mock = makeLinearFetch();
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-laren")
      .set("X-Openclaw-Agent", "laren")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation InjectWork($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-uuid",
          input: { stateId: "s-todo", assigneeId: "u-igor", delegateId: "u-igor" },
        },
        operationName: "InjectWork",
      });

    expect(res.body.errors).toBeUndefined();
    const forwarded = mock.calls.filter((c) => c.query.includes("issueUpdate") && !c.query.includes("IssueContext"));
    const demotion = forwarded.find((c) => inputOf(c).stateId === "s-backlog");
    expect(demotion).toBeDefined();
    expect(inputOf(demotion!).delegateId).toBeNull();
    expect(mock.calls.filter((c) => c.query.includes("commentCreate"))).toHaveLength(1);
  });

  it("AC4: replaying the demote against a steward-promoted xfn ticket does not re-demote", async () => {
    const mock = makeLinearFetch({ promotedIssue: true });
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-laren")
      .set("X-Openclaw-Agent", "laren")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation ReplayInject($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-uuid",
          input: { stateId: "s-todo", assigneeId: "u-igor", delegateId: "u-igor" },
        },
        operationName: "ReplayInject",
      });

    expect(res.body.errors).toBeUndefined();
    const forwarded = mock.calls.filter((c) => c.query.includes("issueUpdate") && !c.query.includes("IssueContext"));
    // The steward's promotion stands: no re-demote to Backlog, no fresh triage comment.
    expect(forwarded.some((c) => inputOf(c).stateId === "s-backlog")).toBe(false);
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });
});
