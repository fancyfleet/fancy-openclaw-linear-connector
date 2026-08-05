/**
 * INF-1219 — `maybeDemoteCrossFunctionalRequest` (proxy.ts) can eject an
 * actively-enrolled ticket from its workflow with no fail-closed guard when
 * enrollment can't be verified, no alert-bus/operational-event signal on an
 * actual demotion, and no kill-switch. This hardens the failure modes without
 * changing the intended ad-hoc-request-demotion behavior (INF-880/INF-996).
 *
 * AC (verbatim, captured at intake by astrid 2026-08-05):
 *  1. Never demotes when enrollment status could not be confidently verified
 *     (fetch failure / partial result -> no demotion).
 *  2. Every actual demotion emits an operationalEventStore entry AND an
 *     alertBus.notify warning, in addition to the existing Linear comment.
 *  3. An env-gated kill-switch disables the check fleet-wide without a deploy.
 *  4. A genuinely-enrolled ticket (wf:*) is never demoted regardless of
 *     intent-header presence or absence.
 *  5. No behavioral change to the legitimate ad-hoc-request-demotion path.
 *
 * Contract this suite pins for the implementer (igor):
 *  - Kill-switch env var: QUIESCE_XFN_DEMOTE=1 (mirrors QUIESCE_RECONCILIATION_SWEEPS /
 *    QUIESCE_DISPATCH_WATCHDOG naming), read per-call so a live toggle takes effect
 *    without a redeploy/restart of this suite's already-running process.
 *  - operationalEventStore.append({ outcome: "xfn-demoted", key: <issueId> ... }) on
 *    every actual demotion (add "xfn-demoted" to OPERATIONAL_EVENT_OUTCOMES).
 *  - alertBus (getAlertBus()) .notify({ severity: "warning", ticket: <issueId>, ... })
 *    on every actual demotion.
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
import { getAlertBus, _resetAlertBusForTests } from "./alerts/alert-bus.js";

// `igor` holds linear:transition but NOT human:escalate — a non-steward agent
// whose active-state writes the xfn-demote governs (matches INF-996's fixture).
const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: dev
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]

bodies:
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

type FetchOpts = {
  /** Ticket carries `wf:chore` — already enrolled, must never be demoted. */
  enrolled?: boolean;
  /** IssueContext query rejects (simulated network failure) instead of resolving. */
  throwOnIssueContext?: boolean;
  /**
   * IssueContext query resolves 200 OK but with the `labels` field entirely
   * absent from the response — a partial upstream result indistinguishable,
   * under the pre-fix code, from "confirmed zero labels".
   */
  partialIssueContext?: boolean;
};

function makeLinearFetch(opts: FetchOpts = {}): { fetch: typeof globalThis.fetch; calls: GraphQLCall[] } {
  const calls: GraphQLCall[] = [];

  const fetchMock: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphQLCall;
    const query = parsed.query ?? "";

    if (query.includes("IssueContext") || (query.includes("labels") && query.includes("delegate"))) {
      calls.push(parsed);
      if (opts.throwOnIssueContext) {
        throw new Error("simulated network failure fetching IssueContext");
      }
      if (opts.partialIssueContext) {
        // Realistic partial-data GraphQL shape: `issue` resolves, but the
        // `labels` sub-field errored and was dropped rather than nulled.
        return json({
          data: {
            issue: {
              id: "issue-uuid",
              identifier: "INF-XFN",
              team: { id: "team-inf", key: "INF", name: "Infrastructure" },
              state: { id: "s-doing", name: "Doing", type: "started" },
              delegate: { id: "u-igor", name: "Igor (dev)" },
            },
          },
          errors: [{ message: "Cannot resolve field \"labels\" on type Issue" }],
        });
      }
      return json({
        data: {
          issue: {
            id: "issue-uuid",
            identifier: "INF-XFN",
            team: { id: "team-inf", key: "INF", name: "Infrastructure" },
            creator: { id: "u-igor", name: "Igor (dev)" },
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

    calls.push(parsed);

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

describe("INF-1219 — xfn-demote fail-closed, alerting, kill-switch", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  function boot(fetchImpl: typeof globalThis.fetch): void {
    globalThis.fetch = fetchImpl;
  }

  function sendActiveStateInjection(extraHeaders: Record<string, string> = {}) {
    const req = request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("Content-Type", "application/json");
    for (const [k, v] of Object.entries(extraHeaders)) req.set(k, v);
    return req.send({
      query: `mutation MoveX($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier } }
      }`,
      variables: { id: "issue-uuid", input: { stateId: "s-doing" } },
      operationName: "MoveX",
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1219-xfn-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = writePolicyFile(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    _resetAlertBusForTests();

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
    delete process.env.QUIESCE_XFN_DEMOTE;
    _resetAlertBusForTests();
  });

  it("AC2/AC5: a healthy ad-hoc active-state injection is still demoted, AND now emits an operationalEventStore entry + alertBus warning alongside the existing comment", async () => {
    const mock = makeLinearFetch({ enrolled: false });
    boot(mock.fetch);

    const res = await sendActiveStateInjection();
    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    expect(update).toBeDefined();
    const updateInput = inputOf(update!);
    // AC5: behavior unchanged — still demoted to Backlog, delegate cleared, xfn labels merged.
    expect(updateInput.stateId).toBe("s-backlog");
    expect(updateInput.delegateId).toBeNull();
    expect(updateInput.labelIds as string[]).toEqual(
      expect.arrayContaining(["lbl-cross-functional", "lbl-xfn-dev"]),
    );
    // AC5: the existing Linear comment signal is preserved.
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(true);

    // AC2: operational event recorded for the actual demotion.
    const events = appState.operationalEventStore.query({ key: "issue-uuid", outcome: "xfn-demoted" as never });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].agent).toBe("igor");

    // AC2: alert-bus warning recorded for the actual demotion.
    const alerts = getAlertBus().getStore()?.query({ severity: "warning" }) ?? [];
    const xfnAlert = alerts.find((a) => a.ticket === "issue-uuid");
    expect(xfnAlert).toBeDefined();
    expect(xfnAlert!.severity).toBe("warning");
  });

  it("AC1: fetchIssueContext failing outright (simulated network error) never demotes", async () => {
    const mock = makeLinearFetch({ throwOnIssueContext: true });
    boot(mock.fetch);

    const res = await sendActiveStateInjection();
    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    // Either the mutation never forwards, or it forwards unmodified — either
    // way the demotion side effects (backlog rewrite, xfn labels, comment)
    // must never occur.
    if (update) {
      const updateInput = inputOf(update!);
      expect(updateInput.stateId).not.toBe("s-backlog");
      expect(updateInput.labelIds).toBeUndefined();
    }
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);

    const events = appState.operationalEventStore.query({ key: "issue-uuid", outcome: "xfn-demoted" as never });
    expect(events.length).toBe(0);
  }, 15000);

  it("AC1: a partial IssueContext response (labels field missing, not just empty) never demotes", async () => {
    const mock = makeLinearFetch({ partialIssueContext: true });
    boot(mock.fetch);

    const res = await sendActiveStateInjection();
    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    if (update) {
      const updateInput = inputOf(update!);
      expect(updateInput.stateId).not.toBe("s-backlog");
      expect(updateInput.labelIds).toBeUndefined();
    }
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);

    const events = appState.operationalEventStore.query({ key: "issue-uuid", outcome: "xfn-demoted" as never });
    expect(events.length).toBe(0);
  });

  it("AC3: QUIESCE_XFN_DEMOTE=1 disables the check fleet-wide — no state/label/delegate/comment/event/alert change", async () => {
    process.env.QUIESCE_XFN_DEMOTE = "1";
    const mock = makeLinearFetch({ enrolled: false });
    boot(mock.fetch);

    const res = await sendActiveStateInjection();
    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    expect(update).toBeDefined();
    const updateInput = inputOf(update!);
    expect(updateInput.stateId).toBe("s-doing");
    expect(updateInput.delegateId).toBeUndefined();
    expect(updateInput.labelIds).toBeUndefined();
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);

    const events = appState.operationalEventStore.query({ key: "issue-uuid", outcome: "xfn-demoted" as never });
    expect(events.length).toBe(0);
    const alerts = getAlertBus().getStore()?.query({ severity: "warning" }) ?? [];
    expect(alerts.find((a) => a.ticket === "issue-uuid")).toBeUndefined();
  });

  it("AC3 control: without the kill-switch set, the same request is still demoted", async () => {
    delete process.env.QUIESCE_XFN_DEMOTE;
    const mock = makeLinearFetch({ enrolled: false });
    boot(mock.fetch);

    const res = await sendActiveStateInjection();
    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    expect(update).toBeDefined();
    expect(inputOf(update!).stateId).toBe("s-backlog");
  });

  it("AC4: an enrolled (wf:chore) ticket is NOT demoted with no intent header, and the new event/alert do not spuriously fire on the skip path", async () => {
    const mock = makeLinearFetch({ enrolled: true });
    boot(mock.fetch);

    const res = await sendActiveStateInjection();
    expect(res.body.errors).toBeUndefined();

    const update = mock.calls.find((c) => c.query.includes("issueUpdate"));
    expect(update).toBeDefined();
    const updateInput = inputOf(update!);
    expect(updateInput.stateId).toBe("s-doing");
    expect(updateInput.delegateId).toBeUndefined();
    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);

    const events = appState.operationalEventStore.query({ key: "issue-uuid", outcome: "xfn-demoted" as never });
    expect(events.length).toBe(0);
    const alerts = getAlertBus().getStore()?.query({ severity: "warning" }) ?? [];
    expect(alerts.find((a) => a.ticket === "issue-uuid")).toBeUndefined();
  });

  it("AC4: an enrolled ticket is NOT demoted when an intent header IS present (demote check is not on the intent-bearing path)", async () => {
    const mock = makeLinearFetch({ enrolled: true });
    boot(mock.fetch);

    // Any intent header routes the mutation through the governed-command path,
    // not the raw-mutation `!intent` xfn-demote gate — the demotion notification
    // (Linear comment) must never fire either way, whatever else happens to the command.
    await sendActiveStateInjection({ "X-Openclaw-Linear-Intent": "begin-work" });

    expect(mock.calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
    const events = appState.operationalEventStore.query({ key: "issue-uuid", outcome: "xfn-demoted" as never });
    expect(events.length).toBe(0);
  });
});
