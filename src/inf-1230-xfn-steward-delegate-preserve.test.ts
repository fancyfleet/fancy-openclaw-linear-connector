/**
 * INF-1230: the xfn cross-functional-request demote guard
 * (`maybeDemoteCrossFunctionalRequest`, proxy.ts) auto-Backlogs and
 * un-delegates a steward-authored recovery request even when the mutation
 * carries an explicit `delegateId`, defeating cross-agent routing.
 *
 * Root cause (astrid, intake comment on INF-1230): the guard's existing
 * exemptions are `human:escalate` holders, designated-approver
 * (`sprint:signoff`) delegates, and already-workflow-enrolled tickets. NONE
 * covers the steward-as-author case. Astrid holds `workflow:break-glass`, NOT
 * `human:escalate` — so an astrid-authored recovery `issueCreate` carrying an
 * explicit `delegateId` and no `wf:*` label falls through every exemption and
 * gets `input.delegateId = null` + demoted to Backlog. That is the live
 * INF-1220 symptom: astrid's recovery-dispatch ticket landed in
 * dispatch-skipped Backlog with its delegate cleared, and had to be manually
 * re-promoted and re-dispatched by hand.
 *
 * AC mapping (verbatim ACs on INF-1230):
 * - AC1: a steward-authored cross-functional request that already carries an
 *   explicit delegate is NOT auto-demoted to Backlog and does NOT have its
 *   delegate cleared. Tested here as the primary, required behavior: per
 *   Astrid's intake comment, "the ticket is dispatchable" (AC3) only holds if
 *   the request lands in its requested active state, not parked in Backlog —
 *   Backlog is dispatch-skipped by definition in this fleet's routing.
 * - AC2 (fallback, not exercised here): if demotion must stay, the
 *   author-set delegate would need to survive the demotion instead. AC3's
 *   "dispatchable" language selects AC1 as the actual required behavior, so
 *   these tests hold the guard to AC1: no demotion at all in the exempted case.
 * - AC3: regression test reproducing the INF-1220 scenario verbatim — astrid
 *   creates an xfn recovery ticket with delegate=Charles → delegate is
 *   retained and the ticket is dispatchable (stays in its requested active
 *   state).
 * - AC4: asserted at the HTTP behavior level via `createApp()` + supertest
 *   against the live `/proxy/graphql` webhook dispatch path — not by calling
 *   `maybeDemoteCrossFunctionalRequest` as a bare unit import.
 *
 * The exemption must be scoped narrowly:
 * - It requires BOTH the acting body being the steward (or a
 *   `workflow:break-glass` holder) AND the mutation carrying an explicit
 *   `delegateId`. A steward action with no explicit delegate must still
 *   demote normally (control below) — otherwise the fix silently exempts
 *   every steward write, which is broader than the AC asks for.
 * - A non-steward, non-break-glass agent setting an explicit `delegateId`
 *   must still be demoted with the delegate cleared (INF-880 regression
 *   guard) — otherwise the fix would blanket-exempt any explicit delegate,
 *   regardless of who set it, which reopens the ad-hoc-injection hole INF-880
 *   closed.
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

// Mirrors the real production gap described on INF-1230: `astrid` (steward)
// holds `workflow:break-glass`, NOT `human:escalate` — so she does NOT hit the
// existing `human:escalate` short-circuit at the top of
// `maybeDemoteCrossFunctionalRequest` (proxy.ts:490) and must instead be
// exempted by the new steward/break-glass + explicit-delegate check.
//
// `ops-recovery` holds `workflow:break-glass` via its container but does NOT
// fill the `steward` role — isolates the "(or holds workflow:break-glass)"
// half of Astrid's proposed condition from the "acting body is the steward"
// half.
//
// `igor` and `charles` hold plain `linear:transition` only — neither steward
// nor break-glass — and are the non-exempt control actors / delegate target.
const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass

containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
  - id: ops
    grants: [linear:transition, workflow:break-glass]
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: dev
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: ops-recovery
    container: ops
    fills_roles: [dev]
  - id: charles
    container: dev
    fills_roles: [dev]
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
        { name: "ops-recovery", linearUserId: "u-ops-recovery", openclawAgent: "ops-recovery", accessToken: "tok-ops-recovery", host: "local" },
        { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
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
 * `existingLabels`/`existingState` model the pre-write IssueContext for the
 * issueUpdate path (unused by issueCreate, which resolves teamId directly
 * from the mutation input).
 */
function makeLinearFetch(
  opts: { existingLabels?: string[]; existingState?: { id: string; name: string; type: string } } = {},
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
            creator: { id: "u-astrid", name: "Astrid (CPO)" },
            state,
            labels: {
              nodes: (opts.existingLabels ?? []).map((name, i) => ({ id: `lbl-${i}`, name })),
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
              // Covers every requester dimension (body.container) exercised by
              // this suite's bodies — steward (astrid), ops (ops-recovery),
              // dev (igor/charles) — so findOrCreateLabel always resolves via
              // lookup and no test accidentally short-circuits through an
              // unmocked issueLabelCreate round-trip.
              nodes: [
                { id: "lbl-cross-functional", name: "cross-functional-request" },
                { id: "lbl-xfn-steward", name: "xfn:steward" },
                { id: "lbl-xfn-ops", name: "xfn:ops" },
                { id: "lbl-xfn-dev", name: "xfn:dev" },
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

describe("INF-1230 — xfn-demote must not clobber a steward-authored explicit delegate", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  function boot(fetchImpl: typeof globalThis.fetch): void {
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1230-xfn-"));
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

  it("AC1/AC3 (INF-1220 regression): astrid's issueCreate with explicit delegate=Charles is NOT demoted — delegate retained, ticket dispatchable", async () => {
    const mock = makeLinearFetch();
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation CreateRecoveryDispatch($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }`,
        variables: {
          input: {
            teamId: "team-inf",
            title: "CRA review + break-glass merge/deploy of PR #665",
            stateId: "s-todo",
            delegateId: "u-charles",
            labelIds: [],
          },
        },
        operationName: "CreateRecoveryDispatch",
      });

    expect(res.body.errors).toBeUndefined();

    const create = mock.calls.find((c) => c.query.includes("issueCreate"));
    expect(create).toBeDefined();
    const createInput = inputOf(create!);
    // Dispatchable: stays in the requested active state, NOT parked in Backlog.
    expect(createInput.stateId).toBe("s-todo");
    // Delegate retained — the exact clobber INF-1220 hit.
    expect(createInput.delegateId).toBe("u-charles");
    expect((createInput.labelIds as string[] | undefined) ?? []).not.toEqual(
      expect.arrayContaining(["lbl-cross-functional"]),
    );
    // No steward-triage demotion comment.
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });

  it("AC1: astrid's issueUpdate re-delegating an existing ticket with an explicit delegateId is NOT demoted", async () => {
    const mock = makeLinearFetch({ existingState: { id: "s-backlog", name: "Backlog", type: "backlog" }, existingLabels: [] });
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation RedispatchRecovery($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id identifier } }
        }`,
        variables: {
          id: "issue-uuid",
          input: { stateId: "s-todo", delegateId: "u-charles" },
        },
        operationName: "RedispatchRecovery",
      });

    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    expect(update).toBeDefined();
    const updateInput = inputOf(update!);
    expect(updateInput.stateId).toBe("s-todo");
    expect(updateInput.delegateId).toBe("u-charles");
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });

  it("AC1 (break-glass, non-steward-role): a workflow:break-glass holder's issueCreate with an explicit delegateId is NOT demoted", async () => {
    const mock = makeLinearFetch();
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-ops-recovery")
      .set("X-Openclaw-Agent", "ops-recovery")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation CreateRecoveryDispatch($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }`,
        variables: {
          input: {
            teamId: "team-inf",
            title: "Break-glass recovery dispatch",
            stateId: "s-todo",
            delegateId: "u-charles",
            labelIds: [],
          },
        },
        operationName: "CreateRecoveryDispatch",
      });

    expect(res.body.errors).toBeUndefined();

    const create = mock.calls.find((c) => c.query.includes("issueCreate"));
    expect(create).toBeDefined();
    const createInput = inputOf(create!);
    expect(createInput.stateId).toBe("s-todo");
    expect(createInput.delegateId).toBe("u-charles");
  });

  it("CONTROL: astrid's issueCreate WITHOUT an explicit delegateId is still demoted normally (exemption is scoped to explicit delegate, not blanket steward pass-through)", async () => {
    const mock = makeLinearFetch();
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation CreateAdHocRequest($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }`,
        variables: {
          input: {
            teamId: "team-inf",
            title: "Ad-hoc board injection, no delegate set",
            stateId: "s-todo",
            labelIds: [],
          },
        },
        operationName: "CreateAdHocRequest",
      });

    expect(res.body.errors).toBeUndefined();

    const create = mock.calls.find((c) => c.query.includes("issueCreate"));
    expect(create).toBeDefined();
    const createInput = inputOf(create!);
    // No explicit delegate on the mutation -> still demoted to Backlog, xfn-stamped.
    expect(createInput.stateId).toBe("s-backlog");
    expect(createInput.delegateId).toBeNull();
    expect(createInput.labelIds as string[]).toEqual(
      expect.arrayContaining(["lbl-cross-functional"]),
    );
  });

  it("CONTROL (INF-880 regression guard): a non-steward, non-break-glass agent's issueCreate with an explicit delegateId IS still demoted and the delegate IS still cleared", async () => {
    const mock = makeLinearFetch();
    boot(mock.fetch);

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation CreateAdHocRequest($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }`,
        variables: {
          input: {
            teamId: "team-inf",
            title: "Ad-hoc board injection with a hand-set delegate",
            stateId: "s-todo",
            delegateId: "u-charles",
            labelIds: [],
          },
        },
        operationName: "CreateAdHocRequest",
      });

    expect(res.body.errors).toBeUndefined();

    const create = mock.calls.find((c) => c.query.includes("issueCreate"));
    expect(create).toBeDefined();
    const createInput = inputOf(create!);
    // A non-steward, non-break-glass agent cannot launder an ad-hoc injection
    // through an explicit delegateId — INF-880 behavior must hold.
    expect(createInput.stateId).toBe("s-backlog");
    expect(createInput.delegateId).toBeNull();
    expect(createInput.labelIds as string[]).toEqual(
      expect.arrayContaining(["lbl-cross-functional"]),
    );
  });
});
