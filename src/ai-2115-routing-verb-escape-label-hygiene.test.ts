/**
 * AI-2115: two connector bugs surfaced on GEN-33 (2026-07-10 → 2026-07-11) that
 * together wedged a wf:task ticket for ~36h and blocked routing to any
 * non-astrid worker.
 *
 * ── Bug 1 — routing continue-workflow mis-resolves to intake's `request` ──────
 * The per-command authorization snapshot (AI-1860) is keyed only by
 * agent+issue+RAW-intent. Every forward step of a wf:task ticket is the same raw
 * intent, `continue-workflow`, so two SEPARATE commands run by the same agent on
 * the same issue within the 10-min TTL collide on the key. On GEN-33 astrid ran
 * `continue-workflow` at intake (request → routing) which stored
 * snapshotState="intake", then ran `continue-workflow <worker>` at routing — and
 * that HIT the stale snapshot, re-resolving to intake's singleton `request` verb,
 * which force-assigns astrid and rejects the real (delegate-only) worker. So
 * routing→doing could never delegate to a non-head worker.
 *
 * Fix (proxy.ts): the snapshot exists to protect the FOLLOW-UP mutations of ONE
 * command (comment/delegate re-gated against the command's own post-transition
 * state — the AI-1848/1872/1924 repros); those carry NO state:* label delta. A
 * request that DOES carry a transition label delta is the first mutation of a
 * NEW command and must resolve/gate against LIVE state. So only reuse the
 * snapshot for label-delta-free follow-ups.
 *
 * ── Bug 2 — escape leaves a stale state:* label (silent no-op) ────────────────
 * applyStateTransition's idempotency branch no-op'd whenever the target state
 * label was present, without checking for coexisting stale state:* labels. escape
 * — whose whole job is to purge a corrupt/stale state and re-enter at intake —
 * therefore left a stale state:routing label in place and the ticket stayed
 * wedged.
 *
 * Fix (workflow-gate.ts): no-op ONLY when the labels are already clean (exactly
 * the single target label); on ANY drift (missing target OR coexisting stale
 * state:* labels) re-stamp to exactly one clean state:<target> label.
 *
 * AC mapping (verbatim AC of record):
 *   AC1 → "Bug 1: routing continue-workflow delegates to the worker (…)"
 *   AC2 → "Bug 2: escape never silently no-ops (…)"
 *   AC3 → this file reproduces the GEN-33 routing → delegate-only worker → escape
 *         sequence.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

// ── Shared fixtures ───────────────────────────────────────────────────────────

// astrid is the catch-all head + requester + steward (singleton head — the
// source of the force-assign). signe and poe are delegate-only workers (the
// multi-body worker role that routing's `assign` targets).
const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
  - id: dev
    grants: [linear:transition]
roles:
  - id: requester
    requires: [linear:transition]
  - id: head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: steward
    requires: [workflow:break-glass]
bodies:
  - id: astrid
    container: steward
    fills_roles: [requester, head, steward]
  - id: signe
    container: dev
    fills_roles: [worker]
  - id: poe
    container: dev
    fills_roles: [worker]
`;

// wf:task-shaped: intake(request→routing, singleton head) then
// routing(assign→doing, multi-body worker, not-self). Mirrors canonical-task.yaml
// for the two states that wedged on GEN-33.
const TASK_WORKFLOW_YAML = `
id: task
version: 2
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
migrations:
  escape: intake
states:
  - id: intake
    owner_role: requester
    kind: normal
    native_state: todo
    transitions:
      - command: request
        to: routing
        generic: continue
      - command: demote
        to: __ad_hoc__
  - id: routing
    owner_role: head
    kind: normal
    native_state: todo
    transitions:
      - command: assign
        to: doing
        generic: continue
        assign:
          mode: required
          constraint: not-self
  - id: doing
    owner_role: worker
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: done
        generic: continue
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const ISSUE_UUID = "issue-internal-uuid";
const ISSUE_IDENTIFIER = "GEN-33";

function contextFor(state: string, delegateUserId: string | null): object {
  return {
    data: {
      issue: {
        labels: { nodes: [{ name: "wf:task" }, { name: `state:${state}` }] },
        delegate: delegateUserId ? { id: delegateUserId } : null,
      },
    },
  };
}

function withIdsFor(state: string): object {
  return {
    data: {
      issue: {
        id: ISSUE_UUID,
        identifier: ISSUE_IDENTIFIER,
        team: { id: "team-uuid" },
        labels: {
          nodes: [
            { id: "wf-lbl", name: "wf:task" },
            { id: `${state}-lbl`, name: `state:${state}` },
          ],
        },
      },
    },
  };
}

const TEAM_STATE_LABELS = [
  { id: "intake-lbl", name: "state:intake" },
  { id: "routing-lbl", name: "state:routing" },
  { id: "doing-lbl", name: "state:doing" },
  { id: "done-lbl", name: "state:done" },
];

const TEAM_STATES = {
  data: {
    team: {
      states: {
        nodes: [
          { id: "s-todo", name: "Todo", type: "unstarted" },
          { id: "s-doing", name: "Doing", type: "started" },
          { id: "s-done", name: "Done", type: "completed" },
        ],
      },
    },
  },
};

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "signe", linearUserId: "u-signe", openclawAgent: "signe", accessToken: "tok-signe", host: "local" },
        { name: "poe", linearUserId: "u-poe", openclawAgent: "poe", accessToken: "tok-poe", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

/**
 * Stateful Linear fetch mock. `setState` flips both the delegate/legality
 * context (IssueContext/IssueLabels) and the applyStateTransition label-id
 * context (IssueWithLabels) so a command run at a NEW state sees that state
 * live — exactly the GEN-33 sequence of two separate continue-workflow commands.
 */
function makeTaskFetch(initial: { state: string; delegate: string | null }): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
  setState: (state: string, delegate: string | null) => void;
} {
  let currentContext = contextFor(initial.state, initial.delegate);
  let withIdsState = initial.state;
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
    const q = parsed.query ?? "";
    const json = (payload: object) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

    if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
      return json(currentContext);
    }
    if (q.includes("IssueWithLabels")) {
      return json(withIdsFor(withIdsState));
    }
    if (q.includes("TeamStateLabels")) {
      return json({ data: { issue: { team: { labels: { nodes: TEAM_STATE_LABELS } } } } });
    }
    if (q.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: TEAM_STATE_LABELS } } } });
    }
    if (q.includes("TeamStates")) {
      return json(TEAM_STATES);
    }
    if (q.includes("VerifyTransitionWrite")) {
      const ctx = currentContext as { data: { issue: { labels: unknown; delegate: unknown } } };
      return json({ data: { issue: { labels: ctx.data.issue.labels, delegate: ctx.data.issue.delegate, state: { id: "s-todo" } } } });
    }
    if (q.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    // Any forwarded mutation / delegate update / comment.
    return json({ data: { issueUpdate: { success: true }, commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-07-11T00:00:00Z", url: "u" } } } });
  };

  return {
    fetch: mockFetch,
    calls,
    setState: (state, delegate) => {
      currentContext = contextFor(state, delegate);
      withIdsState = state;
    },
  };
}

/** A forward transition trigger that carries the state:* label delta (as the
 *  real CLI sends — the proxy strips it and applyStateTransition is sole writer).
 *  Carrying the delta is what marks this as a command-initiating transition. */
function transitionBody(fromLbl: string, toLbl: string) {
  return {
    operationName: "TriggerTransition",
    query: `mutation TriggerTransition($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    variables: { id: ISSUE_UUID, input: { removedLabelIds: [fromLbl], addedLabelIds: [toLbl] } },
  };
}

/** A comment mutation — a follow-up with NO label delta. */
function commentBody(body: string) {
  return {
    operationName: "AddComment",
    query: `mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id createdAt url } }
    }`,
    variables: { issueId: ISSUE_UUID, body },
  };
}

// ── Bug 1 — proxy integration ──────────────────────────────────────────────────

describe("AI-2115 Bug 1: routing continue-workflow after a prior intake continue-workflow (stale-snapshot bleed)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2115-b1-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "task.yaml");
    fs.writeFileSync(wfFile, TASK_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;
    delete process.env.WORKFLOW_DEFS_DIR;

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
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  const errText = (res: request.Response): string =>
    (res.body?.errors?.[0]?.message as string | undefined) ?? "";

  function send(mf: ReturnType<typeof makeTaskFetch>, opts: { intent: string; target?: string; body: object }) {
    globalThis.fetch = mf.fetch;
    let r = request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", opts.intent);
    if (opts.target) r = r.set("X-Openclaw-Linear-Target", opts.target);
    return r.send(opts.body);
  }

  it("GEN-33 repro: routing continue-workflow delegates to a delegate-only worker (not force-assigned to astrid)", async () => {
    // astrid is delegate throughout (catch-all head + requester).
    const mf = makeTaskFetch({ state: "intake", delegate: "u-astrid" });

    // Command 1: astrid continue-workflow at intake → request → routing.
    // Stores the AI-1860 auth snapshot with snapshotState="intake".
    const res1 = await send(mf, { intent: "continue-workflow", body: transitionBody("intake-lbl", "routing-lbl") });
    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    // The command's transition applied — the ticket is now at routing.
    mf.setState("routing", "u-astrid");

    // Command 2: astrid continue-workflow signe at routing → assign → doing.
    // This is the exact step that wedged GEN-33.
    const res2 = await send(mf, { intent: "continue-workflow", target: "signe", body: transitionBody("routing-lbl", "doing-lbl") });

    // Regression: BEFORE the fix, command 2 reused command 1's stale snapshot
    // (state=intake), re-resolved to the singleton `request`, and rejected signe:
    //   "'continue-workflow' auto-assigns to 'astrid' (singleton role); target 'signe' rejected."
    expect(res2.status).toBe(200);
    expect(errText(res2)).not.toMatch(/singleton|auto-assigns|rejected/i);
    expect(res2.body.errors).toBeUndefined();

    // The routing→doing transition applied and delegated to signe.
    const applied = mf.calls.find(
      (c) => c.query.includes("ApplyAtomicTransition") && (c.variables.labelIds as string[] | undefined)?.includes("doing-lbl"),
    );
    expect(applied).toBeDefined();
  });

  it("boundary (AI-1848 preserved): a follow-up comment with NO label delta still reuses the snapshot", async () => {
    // One command: a transition trigger stores the snapshot, then a trailing
    // comment (no label delta) must NOT be re-gated against the post-transition
    // state — it reuses the snapshot and passes.
    const mf = makeTaskFetch({ state: "intake", delegate: "u-astrid" });

    const res1 = await send(mf, { intent: "continue-workflow", body: transitionBody("intake-lbl", "routing-lbl") });
    expect(res1.body.errors).toBeUndefined();

    // The command's own transition landed the ticket at routing (live state moved),
    // but the trailing comment belongs to the SAME command and must still pass.
    mf.setState("routing", "u-astrid");
    const res2 = await send(mf, { intent: "continue-workflow", body: commentBody("intake brief — appendix chunk.") });

    expect(res2.status).toBe(200);
    expect(res2.body.errors).toBeUndefined();
  });
});

// ── Bug 2 — applyStateTransition escape strips stale state:* labels ─────────────

describe("AI-2115 Bug 2: escape strips a stale state:* label (never a silent no-op)", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  interface FetchCall { body: { query?: string; variables?: Record<string, unknown> } }

  function makeTransitionFetch(issueLabels: Array<{ id: string; name: string }>): {
    fetch: typeof globalThis.fetch;
    calls: FetchCall[];
  } {
    const calls: FetchCall[] = [];
    const mockFetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) throw new Error("unexpected fetch");
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      calls.push({ body: parsed });
      const q = parsed.query ?? "";
      const json = (p: object) => new Response(JSON.stringify(p), { status: 200, headers: { "Content-Type": "application/json" } });
      if (q.includes("IssueWithLabels")) {
        return json({ data: { issue: { id: ISSUE_UUID, identifier: ISSUE_IDENTIFIER, team: { id: "team-uuid" }, labels: { nodes: issueLabels } } } });
      }
      if (q.includes("TeamLabels")) return json({ data: { team: { labels: { nodes: TEAM_STATE_LABELS } } } });
      if (q.includes("TeamStates")) return json(TEAM_STATES);
      if (q.includes("ApplyAtomicTransition")) return json({ data: { issueUpdate: { success: true } } });
      if (q.includes("UpdateDelegate")) return json({ data: { issueUpdate: { success: true } } });
      throw new Error(`unexpected Linear query: ${q.slice(0, 80)}`);
    };
    return { fetch: mockFetch, calls };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2115-b2-"));
    const wfFile = path.join(dir, "task.yaml");
    fs.writeFileSync(wfFile, TASK_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("escape re-stamps a single clean state:intake when a stale state:routing coexists (idempotency branch)", async () => {
    // The ticket carries BOTH the escape-target label (state:intake) AND a stale
    // state:routing — and the captured source resolves to intake (as the proxy
    // feeds sourceStateOverride). BEFORE the fix this hit the `already-in-state`
    // no-op and the stale state:routing survived, wedging the ticket.
    const { fetch: mock, calls } = makeTransitionFetch([
      { id: "wf-lbl", name: "wf:task" },
      { id: "intake-lbl", name: "state:intake" },
      { id: "routing-lbl", name: "state:routing" },
    ]);
    globalThis.fetch = mock;

    const result = await applyStateTransition("escape", ISSUE_IDENTIFIER, "Bearer tok", { sourceStateOverride: "intake" });

    // Not a silent no-op — the transition re-stamped.
    expect(result.status).toBe("applied");
    expect(result.code).toBe("re-stamped");
    expect(result.to).toBe("intake");

    // A mutation fired that leaves exactly one clean state label: state:intake,
    // with the stale state:routing stripped.
    const applied = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(applied).toBeDefined();
    const labelIds = applied!.body.variables!.labelIds as string[];
    expect(labelIds).toContain("intake-lbl");
    expect(labelIds).not.toContain("routing-lbl");
    // Exactly one state:* label id remains (state:intake); wf:task is preserved.
    const stateLabelIds = labelIds.filter((id) => id !== "wf-lbl");
    expect(stateLabelIds).toEqual(["intake-lbl"]);
  });

  it("escape from the live drifted state (state:routing on physical Doing) lands a single clean state:intake", async () => {
    // The real GEN-33 label config: a stale state:routing is the only state
    // label; escape must swap it out and land exactly state:intake (no stale
    // label left behind), never a no-op.
    const { fetch: mock, calls } = makeTransitionFetch([
      { id: "wf-lbl", name: "wf:task" },
      { id: "routing-lbl", name: "state:routing" },
    ]);
    globalThis.fetch = mock;

    const result = await applyStateTransition("escape", ISSUE_IDENTIFIER, "Bearer tok");

    expect(result.status).toBe("applied");
    expect(result.to).toBe("intake");
    const applied = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(applied).toBeDefined();
    const labelIds = applied!.body.variables!.labelIds as string[];
    expect(labelIds).toContain("intake-lbl");
    expect(labelIds).not.toContain("routing-lbl");
  });

  it("genuine no-op preserved: escape on a clean single state:intake stays a no-op", async () => {
    const { fetch: mock, calls } = makeTransitionFetch([
      { id: "wf-lbl", name: "wf:task" },
      { id: "intake-lbl", name: "state:intake" },
    ]);
    globalThis.fetch = mock;

    const result = await applyStateTransition("escape", ISSUE_IDENTIFIER, "Bearer tok", { sourceStateOverride: "intake" });

    expect(result.status).toBe("noop");
    expect(result.code).toBe("already-in-state");
    // No mutation fired — nothing to clean.
    expect(calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"))).toBeUndefined();
  });
});
