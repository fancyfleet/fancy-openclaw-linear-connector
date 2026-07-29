/**
 * INF-996 / INF-925-class — the xfn auto-demote must NOT swallow a ticket that is
 * already enrolled in a concrete workflow (carries a `wf:*` label).
 *
 * The live 2026-07-28 failure: a `wf:chore` ticket, on any active-state write by a
 * non-steward agent (cache-flush / begin-work / assign / a chained re-label), fell
 * through `maybeDemoteCrossFunctionalRequest` — which stripped its delegate, merged
 * `cross-functional-request` + `xfn:<dim>`, and re-parked it in dispatch-skipped
 * Backlog. That is the INF-910/888/916/925 demote-clobber class: a ticket with a real
 * workflow home has its own intake/park/demote verbs and must never be treated as an
 * un-triaged cross-functional injection.
 *
 * Astrid directive (option a): a ticket carrying a concrete `wf:*` workflow label is
 * skipped by the xfn-demote. Steward enrollment writes were already exempt (they hold
 * `human:escalate`); the real trigger is a NON-steward agent writing on an
 * already-enrolled ticket, which the `wf:*` label on IssueContext catches.
 *
 * AC:
 * - ENROLLED: an active-state issueUpdate on a `wf:chore` ticket by a non-steward
 *   agent is NOT demoted — stateId preserved, no `cross-functional-request` stamped,
 *   delegate untouched.
 * - CONTROL (INF-880 regression guard): a plain (no `wf:*`) active-state injection by
 *   the same non-steward agent IS still demoted to Backlog with the xfn labels.
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

// `laren` (design) and `igor` (dev) hold `linear:transition` but NOT `human:escalate`
// — they are the non-steward agents whose active-state writes the xfn-demote governs.
// `astrid` (steward) holds `human:escalate` and is already exempt.
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
 * `enrolled` controls the IssueContext labels:
 *  - true:  the ticket carries `wf:chore` (already enrolled in a workflow)
 *  - false: a plain cross-functional injection, no `wf:*` label
 * The issue sits in an active state (`Doing`) in both cases — the write target is also
 * active, so the demote would fire if not exempted.
 */
function makeLinearFetch(opts: { enrolled?: boolean } = {}): { fetch: typeof globalThis.fetch; calls: GraphQLCall[] } {
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
            state: { id: "s-doing", name: "Doing", type: "started" },
            labels: {
              nodes: opts.enrolled
                ? [{ id: "lbl-wf-chore", name: "wf:chore" }, { id: "lbl-state-impl", name: "state:implementation" }]
                : [],
            },
            delegate: { id: "u-igor", name: "Igor (dev)" },
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
                { id: "lbl-xfn-dev", name: "xfn:dev" },
                { id: "lbl-wf-chore", name: "wf:chore" },
              ],
            },
          },
        },
      });
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

describe("INF-996 — xfn-demote skips tickets already enrolled in a workflow", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  function boot(fetchImpl: typeof globalThis.fetch): void {
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-996-xfn-"));
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

  it("ENROLLED: an active-state issueUpdate on a wf:chore ticket by a non-steward agent is NOT demoted", async () => {
    const mock = makeLinearFetch({ enrolled: true });
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation MoveChore($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-uuid",
          input: { stateId: "s-doing" },
        },
        operationName: "MoveChore",
      });

    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    expect(update).toBeDefined();
    const updateInput = inputOf(update!);
    // Not demoted: stays in the requested active state, delegate untouched, no xfn stamp.
    expect(updateInput.stateId).toBe("s-doing");
    expect(updateInput.delegateId).toBeUndefined();
    expect((updateInput.labelIds as string[] | undefined) ?? []).not.toEqual(
      expect.arrayContaining(["lbl-cross-functional"]),
    );
    // No steward-triage demotion comment.
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });

  it("CONTROL (INF-880 guard): a plain (no wf:*) active-state injection by the same agent IS still demoted", async () => {
    const mock = makeLinearFetch({ enrolled: false });
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation MoveInjection($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-uuid",
          input: { stateId: "s-doing" },
        },
        operationName: "MoveInjection",
      });

    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    expect(update).toBeDefined();
    const updateInput = inputOf(update!);
    // Demoted to Backlog with the cross-functional labels merged and delegate cleared.
    expect(updateInput.stateId).toBe("s-backlog");
    expect(updateInput.delegateId).toBeNull();
    expect(updateInput.labelIds as string[]).toEqual(
      expect.arrayContaining(["lbl-cross-functional", "lbl-xfn-dev"]),
    );
  });
});
