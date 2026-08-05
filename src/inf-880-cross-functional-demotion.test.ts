/**
 * INF-880 / INF-326: cross-functional request demotion policy.
 *
 * AC mapping:
 * - AC1: invalid non-owner To Do / active-state injections are demoted to Backlog.
 * - AC2: demoted requests carry both discoverability signals:
 *   `cross-functional-request` and `xfn:<requester-dimension>`.
 * - AC3: requester/source context is preserved on the ticket.
 * - AC4: assignee and delegate are cleared so the ticket remains a request.
 * - AC5: the owning steward is notified/routed once.
 * - AC6: owner-originated active injections are untouched.
 * - AC7: governed workflow transitions remain allowed.
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

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
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

function makeLinearFetch(): { fetch: typeof globalThis.fetch; calls: GraphQLCall[] } {
  const calls: GraphQLCall[] = [];

  const fetchMock: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphQLCall;
    calls.push(parsed);
    const query = parsed.query ?? "";

    if (query.includes("IssueContext") || (query.includes("labels") && query.includes("delegate"))) {
      const isWorkflowTicket = parsed.variables.id === "workflow-uuid";
      return json({
        data: {
          issue: {
            id: isWorkflowTicket ? "workflow-uuid" : "issue-uuid",
            identifier: isWorkflowTicket ? "INF-WF" : "INF-XFN",
            team: { id: "team-inf", key: "INF", name: "Infrastructure" },
            creator: { id: "u-laren", name: "Laren (CDO)" },
            state: { id: "s-triage", name: "Triage", type: "triage" },
            labels: {
              nodes: isWorkflowTicket
                ? [{ id: "lbl-wf-dev-impl", name: "wf:dev-impl" }, { id: "lbl-state-intake", name: "state:intake" }]
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
                { id: "lbl-xfn-design", name: "xfn:design" },
                { id: "lbl-wf-dev-impl", name: "wf:dev-impl" },
                { id: "lbl-state-intake", name: "state:intake" },
                { id: "lbl-state-implementation", name: "state:implementation" },
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

describe("INF-880 cross-functional request demotion", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let calls: GraphQLCall[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-880-xfn-"));
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
    const mock = makeLinearFetch();
    globalThis.fetch = mock.fetch;
    calls = mock.calls;
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

  it("AC1-AC5: demotes a non-owner issue moved into To Do and records requester/source metadata", async () => {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-laren")
      .set("X-Openclaw-Agent", "laren")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation MoveToActive($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-uuid",
          input: {
            stateId: "s-todo",
            assigneeId: "u-igor",
            delegateId: "u-igor",
          },
        },
        operationName: "MoveToActive",
      });

    expect(res.body.errors).toBeUndefined();

    const forwardedUpdates = calls.filter((c) => c.query.includes("issueUpdate") && !c.query.includes("IssueContext"));
    expect(forwardedUpdates.some((c) => inputOf(c).stateId === "s-todo")).toBe(false);

    const demotion = forwardedUpdates.find((c) => inputOf(c).stateId === "s-backlog");
    expect(demotion).toBeDefined();
    const demotionInput = inputOf(demotion!);
    expect(demotionInput.labelIds).toEqual(expect.arrayContaining(["lbl-cross-functional", "lbl-xfn-design"]));
    expect(demotionInput.assigneeId).toBeNull();
    expect(demotionInput.delegateId).toBeNull();
    expect(JSON.stringify(demotionInput)).toMatch(/laren|u-laren|source|requester|cross.functional/i);

    const stewardComments = calls.filter((c) => c.query.includes("commentCreate"));
    expect(stewardComments).toHaveLength(1);
    expect(JSON.stringify(stewardComments[0].variables)).toMatch(/astrid|steward|cross.functional|triage/i);
  });

  it("AC1-AC5: rewrites a non-owner issueCreate targeting To Do into a Backlog request", async () => {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-laren")
      .set("X-Openclaw-Agent", "laren")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation CreateActiveRequest($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }`,
        variables: {
          input: {
            teamId: "team-inf",
            title: "Design request for an INF-owned surface",
            stateId: "s-todo",
            assigneeId: "u-igor",
            delegateId: "u-igor",
            labelIds: [],
            description: "Requester context must survive demotion.",
          },
        },
        operationName: "CreateActiveRequest",
      });

    expect(res.body.errors).toBeUndefined();

    const create = calls.find((c) => c.query.includes("issueCreate"));
    expect(create).toBeDefined();
    const createInput = inputOf(create!);
    expect(createInput.stateId).toBe("s-backlog");
    expect(createInput.labelIds).toEqual(expect.arrayContaining(["lbl-cross-functional", "lbl-xfn-design"]));
    expect(createInput.assigneeId).toBeNull();
    expect(createInput.delegateId).toBeNull();
    expect(createInput.description).toMatch(/requester.*laren|source.*laren|cross-functional request/i);

    const stewardComments = calls.filter((c) => c.query.includes("commentCreate"));
    expect(stewardComments).toHaveLength(1);
  });

  it("AC6: leaves the product steward's own To Do creation untouched", async () => {
    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation CreateOwnerTodo($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }`,
        variables: {
          input: {
            teamId: "team-inf",
            title: "Owner-created active work",
            stateId: "s-todo",
            assigneeId: "u-igor",
            delegateId: "u-igor",
            labelIds: [],
          },
        },
        operationName: "CreateOwnerTodo",
      });

    const create = calls.find((c) => c.query.includes("issueCreate"));
    expect(create).toBeDefined();
    const createInput = inputOf(create!);
    expect(createInput.stateId).toBe("s-todo");
    expect(createInput.labelIds).not.toEqual(expect.arrayContaining(["lbl-cross-functional", "lbl-xfn-design"]));
    expect(calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });

  it("AC7: does not demote governed workflow transitions", async () => {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "accept")
      .set("X-Openclaw-Linear-Target", "igor")
      .set("X-Openclaw-Linear-Cli-Version", "999.0.0")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation AcceptWorkflow($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "workflow-uuid",
          input: {
            stateId: "s-todo",
            labelIds: ["lbl-wf-dev-impl", "lbl-state-intake"],
          },
        },
        operationName: "AcceptWorkflow",
      });

    // AC7 is about demotion NOT firing on a governed transition, not about the
    // transition's own write-verification outcome — this fixture's static
    // mock never reflects a post-write state, so the transition's atomic
    // write is always reported unverified (INF-1222 now surfaces that loudly
    // instead of a silent false-success, independent of this AC).
    const updates = calls.filter((c) => c.query.includes("issueUpdate") && !c.query.includes("IssueContext"));
    expect(updates.some((c) => inputOf(c).stateId === "s-backlog")).toBe(false);
    expect(calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });
});
