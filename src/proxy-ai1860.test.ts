/**
 * AI-1860: Proxy governed transitions are non-atomic — authorization check
 * re-evaluated against post-mutation state causes self-blocking exit 1 with
 * comment dropped.
 *
 * Root cause: when a multi-step governed command (e.g. ac-fail with a chunked
 * comment) sends two or more mutations in sequence:
 *   1. First commentCreate (chunk 1) → passes B3 (caller is delegate), forwarded
 *      to Linear, applyStateTransition fires → delegate reassigned to new agent.
 *   2. Second commentCreate (chunk 2) → B3 re-fetches ticket context, sees NEW
 *      delegate, blocks the original caller → exit 1, remaining chunks dropped.
 *
 * The same pattern applies to any multi-step governed verb that (a) delegates
 * and (b) needs a separate comment call: refuse-work, handoff-work, needs-human,
 * escape.
 *
 * AC mapping (AI-1860 deliverables):
 *   AC1: Authorization snapshotted at command start — delegate check NOT
 *        re-evaluated after any mutation in the same command, so a
 *        self-blocking exit 1 after a successful transition cannot occur.
 *   AC2: Required comment for ac-fail (and any multi-step governed verb) is
 *        always delivered: subsequent comment mutations for the same intent
 *        are not blocked by a post-transition delegate change.
 *   AC3: Server-side audit — other multi-step governed verbs (refuse-work,
 *        handoff-work, needs-human, escape) share the same fix; each is
 *        covered by an analogous test here.
 *   AC4: AI-1809 extension — comment + transition ordering: full ac-fail flow
 *        (live commentCreate, not dedup satisfied-by) asserts comment is
 *        delivered even when the transition reassigns the delegate mid-command.
 *   AC5: No governed verb can exit 1 while leaving the ticket in a state
 *        inconsistent with the command's stated outcome.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp, clearAuthSnapshots } from "./index.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: dev
    fills_roles: [dev]
`;

// Workflow with ac-fail, refuse-work, handoff-work, needs-human, and escape
// — all multi-step verbs that can mutate delegation and then need a comment.
const WORKFLOW_YAML = `
id: dev-impl
version: 9
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
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: ac-validate
        requires_comment: true
      - command: refuse-work
        to: intake
        requires_comment: true
      - command: handoff-work
        to: implementation
        requires_comment: true
      - command: needs-human
        to: intake
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done
      - command: ac-fail
        to: implementation
        requires_comment: true
      - command: needs-human
        to: intake
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

// ── Response shapes ──────────────────────────────────────────────────────────

// B1 context: ticket in ac-validate, astrid is the current delegate.
const AC_VALIDATE_ASTRID = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
      delegate: { id: "u-astrid" },
    },
  },
};

// B1 context AFTER applyStateTransition fires: igor is now delegate.
const IMPLEMENTATION_IGOR = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: "u-igor" },
    },
  },
};

// B1 context: ticket in implementation, igor is current delegate.
const IMPLEMENTATION_IGOR_DELEGATE = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: "u-igor" },
    },
  },
};

// B1 context: ticket in implementation, charles is current delegate.
const IMPLEMENTATION_CHARLES_DELEGATE = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: "u-charles" },
    },
  },
};

// B2 label data for applyStateTransition.
const AC_VALIDATE_WITH_IDS = {
  data: {
    issue: {
      id: "issue-internal-uuid",
      identifier: "AI-1848",
      team: { id: "team-uuid" },
      labels: {
        nodes: [
          { id: "wf-lbl", name: "wf:dev-impl" },
          { id: "acv-lbl", name: "state:ac-validate" },
        ],
      },
    },
  },
};

const IMPLEMENTATION_WITH_IDS = {
  data: {
    issue: {
      id: "issue-internal-uuid",
      identifier: "AI-1848",
      team: { id: "team-uuid" },
      labels: {
        nodes: [
          { id: "wf-lbl", name: "wf:dev-impl" },
          { id: "impl-lbl", name: "state:implementation" },
        ],
      },
    },
  },
};

const TEAM_LABELS = {
  data: {
    team: {
      labels: {
        nodes: [
          { id: "acv-lbl", name: "state:ac-validate" },
          { id: "impl-lbl", name: "state:implementation" },
          { id: "intake-lbl", name: "state:intake" },
        ],
      },
    },
  },
};

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

// ── Test infrastructure ──────────────────────────────────────────────────────

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
      { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
    ],
  }), "utf8");
  return file;
}

/**
 * Build a stateful fetch mock. The `context` variable tracks which IssueContext
 * response to return; update it between requests to simulate post-transition
 * state (delegate changed). `calls` records every upstream call for assertions.
 */
function makeMutableFetch(opts: {
  initialContext: object;
  withIdsResponse?: object;
  atomicSuccess?: boolean;
}): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
  setContext: (ctx: object) => void;
} {
  let currentContext = opts.initialContext;
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
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    // B1 context fetch (delegate check)
    if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
      return json(currentContext);
    }
    // B2 label/team fetch (applyStateTransition)
    if (q.includes("IssueWithLabels")) {
      return json(opts.withIdsResponse ?? AC_VALIDATE_WITH_IDS);
    }
    if (q.includes("TeamLabels")) {
      return json(TEAM_LABELS);
    }
    if (q.includes("TeamStates")) {
      return json(TEAM_STATES);
    }
    // ApplyAtomicTransition — update context to reflect new delegate
    if (q.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: opts.atomicSuccess ?? true } } });
    }
    // Default: any other mutation (commentCreate, issueUpdate forward) succeeds
    return json({ data: { commentCreate: { success: true }, issueUpdate: { success: true } } });
  };

  return {
    fetch: mockFetch,
    calls,
    setContext: (ctx) => { currentContext = ctx; },
  };
}

/** commentCreate mutation body — the shape the CLI sends for a comment chunk. */
function commentCreateBody(issueId: string, body: string) {
  return {
    query: `mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success comment { id createdAt url }
      }
    }`,
    variables: { issueId, body },
  };
}

/** issueUpdate mutation body — the shape the CLI sends for a bare trigger (dedup path). */
function issueUpdateBody(issueId: string) {
  return {
    query: `mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }`,
    variables: { id: issueId },
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("proxy — AI-1860: non-atomic governed transitions (authorization snapshot)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai1860-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearAuthSnapshots();
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── AC1 + AC2 + AC4: ac-fail repro ─────────────────────────────────────

  it("AC1/AC4 repro: second commentCreate (chunk 2) is not blocked after first triggered delegate change", async () => {
    // This is the exact AI-1848 incident sequence:
    //   Chunk 1 commentCreate → passes B3 (astrid is delegate), proxy forwards it,
    //   applyStateTransition fires (delegate Astrid → Igor).
    //   Chunk 2 commentCreate → B3 currently re-fetches context, sees Igor as delegate,
    //   blocks Astrid → exit 1, chunk 2 dropped.
    //
    // After the fix (authorization snapshotted at command start), chunk 2 must pass.

    const { fetch: mockFetch, setContext } = makeMutableFetch({
      initialContext: AC_VALIDATE_ASTRID,
      withIdsResponse: AC_VALIDATE_WITH_IDS,
    });
    globalThis.fetch = mockFetch;

    // Chunk 1: first commentCreate with ac-fail intent.
    const res1 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .send(commentCreateBody("issue-internal-uuid", "AC failure — chunk 1: detailed findings here."));

    expect(res1.status).toBe(200);
    // Chunk 1 must succeed (this is the existing behavior).
    expect(res1.body.errors).toBeUndefined();

    // Simulate what applyStateTransition does: delegate now points to igor.
    // In production, this happens automatically because applyStateTransition
    // calls Linear API during request 1's success handler.
    setContext(IMPLEMENTATION_IGOR);

    // Chunk 2: second commentCreate — same intent, same caller, same ticket.
    // After the fix, the proxy must honour the snapshotted authorization from
    // the first mutation and NOT re-gate on the current (post-transition) delegate.
    const res2 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .send(commentCreateBody("issue-internal-uuid", "AC failure — chunk 2: appendix data."));

    expect(res2.status).toBe(200);
    // AC1/AC2: chunk 2 must NOT be blocked. Current (buggy) behavior returns an
    // error containing "not the current delegate"; the fix removes this block.
    expect(res2.body.errors).toBeUndefined();
  });

  it("AC2: required comment for ac-fail is always delivered even after delegate reassignment", async () => {
    // A comment that is sent AFTER the commentCreate + applyStateTransition
    // have already changed the delegate must not be blocked.
    //
    // Sequence: commentCreate (carries comment, passes gate) → applyStateTransition fires
    // → delegate changes → follow-up commentCreate (feedback) → must pass.

    const { fetch: mockFetch, setContext } = makeMutableFetch({
      initialContext: AC_VALIDATE_ASTRID,
      withIdsResponse: AC_VALIDATE_WITH_IDS,
    });
    globalThis.fetch = mockFetch;

    // First mutation: commentCreate carrying the AC failure rationale.
    // This passes the requires_comment gate and triggers the transition.
    const triggerRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .send(commentCreateBody("issue-internal-uuid", "AC validation failed: detailed findings."));

    expect(triggerRes.status).toBe(200);
    expect(triggerRes.body.errors).toBeUndefined();

    // Simulate post-transition state: delegate now points to igor.
    setContext(IMPLEMENTATION_IGOR);

    // Now the follow-up comment: this is the feedback Astrid wants to post AFTER
    // confirming the transition fired (e.g. if the CLI posts the comment last as a
    // safeguard). Must NOT be blocked because Astrid authorized at command start.
    const commentRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .send(commentCreateBody("issue-internal-uuid", "AC failure feedback details."));

    expect(commentRes.status).toBe(200);
    // The comment must land — no "not the current delegate" block after the fix.
    expect(commentRes.body.errors).toBeUndefined();
  });

  // ── AC3: audit — refuse-work ─────────────────────────────────────────────

  it("AC3/refuse-work: subsequent comment is not blocked after refuse-work delegate change", async () => {
    // refuse-work in state:implementation: igor is the current delegate;
    // the refusal routes the ticket back to intake (steward) and changes the delegate.
    // Igor's comment explaining the refusal must not be blocked after the delegate flips.

    const initialContext = IMPLEMENTATION_IGOR_DELEGATE;
    const postTransitionContext = {
      data: {
        issue: {
          labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
          delegate: { id: "u-astrid" }, // routed back to steward after refuse-work
        },
      },
    };

    const { fetch: mockFetch, setContext } = makeMutableFetch({
      initialContext,
      withIdsResponse: IMPLEMENTATION_WITH_IDS,
    });
    globalThis.fetch = mockFetch;

    // First mutation: the refuse-work trigger (issueUpdate, carries delegate+label write).
    const triggerRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "refuse-work")
      .send(issueUpdateBody("issue-internal-uuid"));

    expect(triggerRes.status).toBe(200);
    expect(triggerRes.body.errors).toBeUndefined();

    // Simulate post-transition: delegate has changed to astrid.
    setContext(postTransitionContext);

    // Follow-up: the refusal comment. Igor must still be allowed to post it.
    const commentRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "refuse-work")
      .send(commentCreateBody("issue-internal-uuid", "Refusing: out-of-scope for this iteration."));

    expect(commentRes.status).toBe(200);
    // AC3: no delegate-block after the transition — comment must pass.
    expect(commentRes.body.errors).toBeUndefined();
  });

  // ── AC3: audit — handoff-work ────────────────────────────────────────────

  it("AC3/handoff-work: subsequent mutation is not blocked after handoff delegate change", async () => {
    // handoff-work: igor re-routes ticket to charles (same state, new delegate).
    // Igor's handoff commentCreate (carrying the briefing) triggers the transition;
    // a follow-up commentCreate (appendix or clarification) must not be blocked
    // after the delegate has moved to charles.
    // In production, the CLI sends commentCreate first (satisfies requires_comment),
    // then the trigger. Here we test the two-commentCreate sequence to prove
    // the auth snapshot covers follow-up mutations.

    const postHandoffContext = {
      data: {
        issue: {
          labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
          delegate: { id: "u-charles" }, // new delegate after handoff
        },
      },
    };

    const { fetch: mockFetch, setContext } = makeMutableFetch({
      initialContext: IMPLEMENTATION_IGOR_DELEGATE,
      withIdsResponse: IMPLEMENTATION_WITH_IDS,
    });
    globalThis.fetch = mockFetch;

    // First mutation: handoff commentCreate (carries comment body, satisfies requires_comment).
    const firstRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "handoff-work")
      .set("X-Openclaw-Linear-Target", "charles")
      .send(commentCreateBody("issue-internal-uuid", "Handing off to Charles. Context: ..."));

    expect(firstRes.status).toBe(200);
    expect(firstRes.body.errors).toBeUndefined();

    // Delegate has flipped to charles.
    setContext(postHandoffContext);

    // Follow-up: a second commentCreate (appendix or clarification).
    const commentRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-igor")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "handoff-work")
      .set("X-Openclaw-Linear-Target", "charles")
      .send(commentCreateBody("issue-internal-uuid", "Additional handoff context."));

    expect(commentRes.status).toBe(200);
    // AC3: igor must not be blocked after handing off.
    expect(commentRes.body.errors).toBeUndefined();
  });

  // ── AC3: audit — needs-human ─────────────────────────────────────────────

  it("AC3/needs-human: subsequent comment is not blocked after needs-human delegate change", async () => {
    // needs-human: the steward (astrid) escalates ticket from ac-validate to intake,
    // delegate changes. In this test fixture, needs-human transitions from ac-validate → intake.
    // The steward's escalation commentCreate triggers the transition; a follow-up
    // commentCreate must not be blocked after the delegate is reassigned.
    // Note: needs-human requires human:escalate capability, which only the steward holds.

    const postEscalationContext = {
      data: {
        issue: {
          labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
          delegate: { id: "u-astrid" }, // routed to steward (steward is astrid in this policy)
        },
      },
    };

    const { fetch: mockFetch, setContext } = makeMutableFetch({
      initialContext: AC_VALIDATE_ASTRID,
      withIdsResponse: AC_VALIDATE_WITH_IDS,
    });
    globalThis.fetch = mockFetch;

    // First mutation: needs-human commentCreate (carries escalation rationale).
    // Astrid (steward) is the current delegate in ac-validate and holds human:escalate.
    const firstRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "needs-human")
      .send(commentCreateBody("issue-internal-uuid", "Escalating: blocked on external API access."));

    expect(firstRes.status).toBe(200);
    expect(firstRes.body.errors).toBeUndefined();

    // Delegate has changed (simulated post-escalation).
    setContext(postEscalationContext);

    // Follow-up: additional escalation context.
    const commentRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "needs-human")
      .send(commentCreateBody("issue-internal-uuid", "Additional escalation context."));

    expect(commentRes.status).toBe(200);
    // AC3: escalation note must not be blocked.
    expect(commentRes.body.errors).toBeUndefined();
  });

  // ── AC3: audit — escape ──────────────────────────────────────────────────

  it("AC3/escape: subsequent comment is not blocked after break-glass delegate clear", async () => {
    // escape (break-glass): astrid exits the workflow; delegate is cleared / changed.
    // Astrid's break-glass commentCreate triggers the escape; a follow-up
    // commentCreate must not be blocked after the delegate changes.

    const postEscapeContext = {
      data: {
        issue: {
          labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
          delegate: null, // delegate cleared on escape
        },
      },
    };

    const { fetch: mockFetch, setContext } = makeMutableFetch({
      initialContext: AC_VALIDATE_ASTRID,
      withIdsResponse: AC_VALIDATE_WITH_IDS,
    });
    globalThis.fetch = mockFetch;

    // First mutation: break-glass commentCreate (carries justification).
    const firstRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "escape")
      .set("X-Openclaw-Break-Glass", "true")
      .send(commentCreateBody("issue-internal-uuid", "Break-glass justification: unrecoverable state."));

    expect(firstRes.status).toBe(200);
    expect(firstRes.body.errors).toBeUndefined();

    // Simulate post-escape: delegate cleared or reassigned.
    setContext(postEscapeContext);

    // Follow-up: additional break-glass context.
    const commentRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "escape")
      .set("X-Openclaw-Break-Glass", "true")
      .send(commentCreateBody("issue-internal-uuid", "Additional context for the break-glass."));

    expect(commentRes.status).toBe(200);
    // AC3: break-glass comment must not be blocked.
    expect(commentRes.body.errors).toBeUndefined();
  });

  // ── AC5: No inconsistent terminal state ──────────────────────────────────

  it("AC5: proxy never exits 1 with a blocked comment when the transition already applied", async () => {
    // If the transition applied (state + delegate changed) but the follow-up comment
    // is blocked, the proxy must not return an error for the comment — the caller
    // already transitioned the ticket; blocking the comment creates an inconsistent
    // state (transition done, feedback missing) which is the incident from AI-1848.
    //
    // Post-fix invariant: either BOTH the transition AND the comment succeed, or the
    // transition is rolled back before any error is surfaced. There must be no path
    // where the proxy reports exit 1 ("blocked") AFTER a successful applyStateTransition.

    const { fetch: mockFetch, setContext, calls } = makeMutableFetch({
      initialContext: AC_VALIDATE_ASTRID,
      withIdsResponse: AC_VALIDATE_WITH_IDS,
    });
    globalThis.fetch = mockFetch;

    // Request 1: the main ac-fail commentCreate (triggers applyStateTransition).
    const res1 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .send(commentCreateBody("issue-internal-uuid", "Feedback chunk 1."));

    expect(res1.status).toBe(200);
    expect(res1.body.errors).toBeUndefined();

    // Verify applyStateTransition ran for request 1.
    const atomicCall = calls.find((c) => c.query.includes("ApplyAtomicTransition"));
    expect(atomicCall).toBeDefined();

    // Delegate changed post-transition.
    setContext(IMPLEMENTATION_IGOR);

    // Request 2: follow-up comment. The transition already applied → this MUST succeed.
    const res2 = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .send(commentCreateBody("issue-internal-uuid", "Feedback chunk 2."));

    expect(res2.status).toBe(200);
    // AC5: no blocked error after a transition that already applied.
    // If this assertion fails, the proxy exited 1 while leaving the ticket
    // in a state inconsistent with the command's stated outcome.
    expect(res2.body.errors).toBeUndefined();
    const blockedMsg = res2.body.errors?.[0]?.message ?? "";
    expect(blockedMsg).not.toMatch(/not the current delegate/);
  });

  // ── AI-1809 extension: comment ordering ──────────────────────────────────

  it("AI-1809-ext: live commentCreate (non-dedup) ac-fail delivers comment before or despite delegate change", async () => {
    // AI-1809 covers the dedup-satisfied-by path (comment already exists, CLI sends
    // issueUpdate with X-Openclaw-Comment-Satisfied-By). This test extends coverage to
    // the LIVE comment path: the CLI sends commentCreate directly (no prior duplicate),
    // and the proxy should deliver it regardless of the post-transition delegate.
    //
    // This is the ordering guarantee from AC2: comment delivered BEFORE transition
    // is the safe order, but if the current implementation fires applyStateTransition
    // after the commentCreate forward, subsequent comment calls must not be blocked.

    const { fetch: mockFetch, setContext } = makeMutableFetch({
      initialContext: AC_VALIDATE_ASTRID,
      withIdsResponse: AC_VALIDATE_WITH_IDS,
    });
    globalThis.fetch = mockFetch;

    // Live comment (no satisfied-by header, no dedup): first and only commentCreate.
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .send(commentCreateBody("issue-internal-uuid", "AC failure: criteria 3 not met."));

    expect(res.status).toBe(200);
    // The single live comment must succeed — this is the baseline case where
    // the commentTriggersProxy design (CLI sends comment first, proxy fires
    // applyStateTransition after forward) should work correctly.
    expect(res.body.errors).toBeUndefined();

    // Post-transition context is simulated for any follow-up call.
    setContext(IMPLEMENTATION_IGOR);

    // If the CLI needs to re-post (e.g. chunked content or a retry), that
    // follow-up must also pass. This is the AI-1809 extension: the test drives
    // the full ac-fail flow (live comment path) and asserts comment delivery
    // even when the transition has already reassigned the delegate.
    const followUpRes = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Linear-Target", "igor")
      .send(commentCreateBody("issue-internal-uuid", "AC failure: appendix."));

    expect(followUpRes.status).toBe(200);
    expect(followUpRes.body.errors).toBeUndefined();
  });

  // ── Regression guard: unrelated callers are still blocked ────────────────

  it("regression: a completely different agent (no prior mutation) is still blocked by delegate check", async () => {
    // The authorization snapshot must only be honoured for the original caller
    // of the command. A third agent (charles) who never ran a mutation for this
    // ticket must still be blocked by the standard delegate check.

    const { fetch: mockFetch } = makeMutableFetch({
      initialContext: IMPLEMENTATION_IGOR_DELEGATE,
      withIdsResponse: IMPLEMENTATION_WITH_IDS,
    });
    globalThis.fetch = mockFetch;

    // Charles tries to mutate a ticket delegated to igor — no prior mutation.
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-charles")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send(issueUpdateBody("issue-internal-uuid"));

    expect(res.status).toBe(200);
    // Charles is NOT the delegate — must still be blocked.
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("not the current delegate");
  });
});
