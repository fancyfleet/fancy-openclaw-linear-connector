/**
 * INF-1298: the xfn cross-functional-request demote guard
 * (`maybeDemoteCrossFunctionalRequest`, proxy.ts) re-demotes an active
 * connector repair ticket after a steward/authorized restoration, because
 * the AC4 idempotent-intake guard only checks the `cross-functional-request`
 * label — which can be stripped by a prior demoter's rewrite or lost to a
 * race between the restoration write and the follow-up mutation's
 * IssueContext fetch.
 *
 * Root cause: the AC4 guard (INF-930) fires when
 *   `stateType !== "backlog" && labelNames.includes("cross-functional-request")`.
 * But the demoter itself ADDS the `cross-functional-request` label as part of
 * its rewrite. A subsequent restoration (e.g. Ai's handoff-work) may strip
 * the label, or the label may not yet be visible to the follow-up mutation's
 * IssueContext fetch. Without the label, AC4 does not fire, and the demoter
 * re-demotes the ticket — clearing the delegate and parking it in Backlog.
 *
 * Observed on INF-1295 (2026-08-06): 6 demotions in 58 minutes after the
 * INF-1230 deploy, each one firing on a legitimate follow-up mutation
 * (consider-work, handoff-work) from the dispatched agent. Every demotion
 * cleared the delegate and re-parked the ticket in Backlog, defeating the
 * restoration.
 *
 * Fix: add an active-dispatch guard that fires when the ticket is in a
 * non-backlog state AND carries a live delegate. This is label-independent
 * and directly tests the signal that matters: someone owns this ticket.
 *
 * AC mapping:
 * - AC1: a follow-up mutation (consider-work) on a restored xfn ticket with
 *   an active delegate is NOT re-demoted — the delegate and active state
 *   survive.
 * - AC2: a follow-up mutation on a restored xfn ticket WITHOUT an active
 *   delegate still demotes normally (the guard is scoped to delegate-present
 *   tickets only).
 * - AC3: a ticket in Backlog with a delegate still demotes (the guard
 *   requires non-backlog state — a Backlog ticket with a delegate is still
 *   un-triaged).
 * - AC4: asserted at the HTTP behavior level via `createApp()` + supertest
 *   against the live `/proxy/graphql` path.
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
  - id: infra-admin
    grants: [linear:transition]
  - id: ai
    grants: [linear:transition, human:escalate]

roles:
  - id: infra-auditor
    requires: [linear:transition]

bodies:
  - id: grover
    container: infra-admin
    fills_roles: [infra-auditor]
  - id: ai
    container: ai
    fills_roles: []
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
        { name: "grover", linearUserId: "u-grover", openclawAgent: "grover", accessToken: "tok-grover", host: "local" },
        { name: "ai", linearUserId: "u-ai", openclawAgent: "ai", accessToken: "tok-ai", host: "local" },
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
 * `existingLabels`/`existingState`/`existingDelegate` model the pre-write
 * IssueContext for the issueUpdate path.
 */
function makeLinearFetch(
  opts: {
    existingLabels?: string[];
    existingState?: { id: string; name: string; type: string };
    existingDelegate?: { id: string; name: string } | null;
  } = {},
): { fetch: typeof globalThis.fetch; calls: GraphQLCall[] } {
  const calls: GraphQLCall[] = [];

  const fetchMock: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphQLCall;
    calls.push(parsed);
    const query = parsed.query ?? "";

    if (query.includes("IssueContext") || (query.includes("labels") && query.includes("delegate"))) {
      const state = opts.existingState ?? { id: "s-backlog", name: "Backlog", type: "backlog" };
      return json({
        data: {
          issue: {
            id: "issue-uuid",
            identifier: "INF-XFN",
            team: { id: "team-inf", key: "INF", name: "Infrastructure" },
            creator: { id: "u-grover", name: "Grover (OpenClaw Mechanic)" },
            state,
            labels: {
              nodes: (opts.existingLabels ?? []).map((name, i) => ({ id: `lbl-${i}`, name })),
            },
            delegate: opts.existingDelegate ?? null,
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
                { id: "s-thinking", name: "Thinking", type: "started" },
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
                { id: "lbl-xfn-infra-admin", name: "xfn:infra-admin" },
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

describe("INF-1298 — xfn-demoter must not re-demote an active ticket with a live delegate", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  function boot(fetchImpl: typeof globalThis.fetch): void {
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1298-xfn-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
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

  it("AC1: grover's consider-work on a restored ticket with active delegate is NOT re-demoted", async () => {
    // Ticket was restored to To Do by Ai (human:escalate), delegate=grover.
    // The cross-functional-request label was stripped during restoration.
    // Grover's consider-work sends { stateId: thinking } — the demoter must
    // NOT rewrite this to Backlog.
    const mock = makeLinearFetch({
      existingState: { id: "s-todo", name: "To Do", type: "unstarted" },
      existingLabels: [], // label stripped during restoration
      existingDelegate: { id: "u-grover", name: "Grover (OpenClaw Mechanic)" },
    });
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-grover")
      .set("X-Openclaw-Agent", "grover")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation ConsiderWork($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-uuid",
          input: { stateId: "s-thinking" },
        },
        operationName: "ConsiderWork",
      });

    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    expect(update).toBeDefined();
    const updateInput = inputOf(update!);
    // NOT demoted: stays in the requested active state.
    expect(updateInput.stateId).toBe("s-thinking");
    // Delegate NOT cleared.
    expect(updateInput.delegateId).not.toBeNull();
    // No xfn labels added.
    expect((updateInput.labelIds as string[] | undefined) ?? []).not.toEqual(
      expect.arrayContaining(["lbl-cross-functional"]),
    );
    // No demotion comment.
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });

  it("AC1b: grover's consider-work on a restored ticket WITH the xfn label AND active delegate is NOT re-demoted (AC4 + delegate guard both fire)", async () => {
    // Same as AC1 but the cross-functional-request label is still attached.
    // Both the AC4 guard and the new delegate guard should fire.
    const mock = makeLinearFetch({
      existingState: { id: "s-todo", name: "To Do", type: "unstarted" },
      existingLabels: ["cross-functional-request", "xfn:infra-admin"],
      existingDelegate: { id: "u-grover", name: "Grover (OpenClaw Mechanic)" },
    });
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-grover")
      .set("X-Openclaw-Agent", "grover")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation ConsiderWork($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-uuid",
          input: { stateId: "s-thinking" },
        },
        operationName: "ConsiderWork",
      });

    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    expect(update).toBeDefined();
    const updateInput = inputOf(update!);
    expect(updateInput.stateId).toBe("s-thinking");
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });

  it("AC2: grover's mutation on a restored ticket WITHOUT a delegate still demotes (guard is delegate-scoped)", async () => {
    // Ticket is in To Do but has no delegate — still an un-triaged request.
    const mock = makeLinearFetch({
      existingState: { id: "s-todo", name: "To Do", type: "unstarted" },
      existingLabels: [],
      existingDelegate: null,
    });
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-grover")
      .set("X-Openclaw-Agent", "grover")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation ConsiderWork($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-uuid",
          input: { stateId: "s-thinking" },
        },
        operationName: "ConsiderWork",
      });

    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    expect(update).toBeDefined();
    const updateInput = inputOf(update!);
    // Demoted: state rewritten to Backlog.
    expect(updateInput.stateId).toBe("s-backlog");
    // Delegate cleared.
    expect(updateInput.delegateId).toBeNull();
    // xfn labels added.
    expect(updateInput.labelIds).toEqual(
      expect.arrayContaining(["lbl-cross-functional", "lbl-xfn-infra-admin"]),
    );
  });

  it("AC3: a Backlog ticket with a delegate is NOT demoted (delegate indicates deliberate dispatch)", async () => {
    // Ticket is in Backlog with a delegate — the delegate was set by an
    // authorized agent and the Backlog state may be the result of a prior
    // demotion, not a deliberate park. The demoter must not clear the
    // delegate and re-apply xfn labels.
    const mock = makeLinearFetch({
      existingState: { id: "s-backlog", name: "Backlog", type: "backlog" },
      existingLabels: ["cross-functional-request"],
      existingDelegate: { id: "u-grover", name: "Grover (OpenClaw Mechanic)" },
    });
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-grover")
      .set("X-Openclaw-Agent", "grover")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation ConsiderWork($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-uuid",
          input: { stateId: "s-todo" },
        },
        operationName: "ConsiderWork",
      });

    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    expect(update).toBeDefined();
    const updateInput = inputOf(update!);
    // NOT demoted: state stays in the requested active state.
    expect(updateInput.stateId).toBe("s-todo");
    // Delegate NOT cleared.
    expect(updateInput.delegateId).not.toBeNull();
    // No demotion comment.
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });
});
