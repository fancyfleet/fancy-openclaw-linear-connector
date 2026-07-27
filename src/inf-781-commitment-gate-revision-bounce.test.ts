/**
 * INF-781 — dev-impl commitment gate deadlocks on a revision bounce.
 *
 * The commitment/acceptance gate (INF-695) records a commitment exit ONCE per
 * workflow instance. When a reviewed ticket bounces back to the gate state on a
 * revision (code-review `request-changes` → implementation), the dev cannot
 * re-commit: `accept` is skipped as a duplicate ("commitment-exit-already-
 * recorded") so it never leaves the gate state, and every downstream verb from
 * the gate state is refused as "missing commitment exit". Revised, reviewed work
 * strands with no legal forward move (LSO-23).
 *
 * These tests drive the full `accept → request-revision → accept` round and pin
 * the fix: a revision bounce re-arms the gate (append-only rearm marker) so the
 * next `accept` records — and applies — a fresh commitment exit, while a
 * duplicate `accept` WITHOUT a bounce is still deduped (the INF-695 contract).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { _resetAppliedStateStore, recordAppliedState } from "./store/applied-state-store.js";
import {
  _setTransitionWritePolicyForTests,
  applyStateTransition,
  resetWorkflowCache,
} from "./workflow-gate.js";

const ISSUE_UUID = "issue-inf-781";
const ISSUE_IDENTIFIER = "INF-781";
const TEAM_ID = "team-ai";
const IGOR_LINEAR_ID = "user-igor";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
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

// A commitment-gated workflow with a full review round-trip: the gate state
// (`implementation`) can be re-entered from `review` via `request-changes`.
const WORKFLOW_YAML = `
id: commitment
version: 1
entry_state: implementation
break_glass:
  command: escape
  to: implementation
states:
  - id: implementation
    owner_role: dev
    native_state: todo
    commitment_gate:
      exits:
        accept:
          to: doing
        reject:
          to: rejected
        not-ready:
          to: needs-info
    transitions:
      - command: accept
        to: doing
      - command: reject
        to: rejected
      - command: not-ready
        to: needs-info
  - id: doing
    owner_role: dev
    native_state: doing
    transitions:
      - command: submit
        to: review
  - id: review
    owner_role: dev
    native_state: todo
    transitions:
      - command: approve
        to: done
      - command: request-changes
        to: implementation
        generic: revision
  - id: needs-info
    owner_role: dev
    native_state: todo
    transitions: []
  - id: rejected
    kind: terminal
    native_state: invalid
    transitions: []
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

// state id → native Linear state id (matches the TeamStates mock below)
const NATIVE_STATE_ID: Record<string, string> = {
  implementation: "state-todo",
  doing: "state-doing",
  review: "state-todo",
  "needs-info": "state-todo",
  rejected: "state-canceled",
  done: "state-done",
};

// state label id → state id (the ApplyAtomicTransition write carries these ids)
const LABEL_ID_TO_STATE: Record<string, string> = {
  "implementation-lbl": "implementation",
  "doing-lbl": "doing",
  "review-lbl": "review",
  "needs-info-lbl": "needs-info",
  "rejected-lbl": "rejected",
  "done-lbl": "done",
};

const STATE_LABEL_NODES = Object.entries(LABEL_ID_TO_STATE).map(([id, state]) => ({
  id,
  name: `state:${state}`,
}));

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A stateful Linear mock: `state.current` tracks the ticket's workflow state and
 * is advanced by each atomic transition write, so a multi-step round-trip reads
 * back consistently (the existing INF-695 mock is single-transition only).
 */
function makeStatefulFetch(initial: string) {
  const state = { current: initial };
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch: ${String(url)}`);
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push(parsed);
    const query = parsed.query ?? "";
    const cur = state.current;
    const nameLabels = [{ name: "wf:commitment" }, { name: `state:${cur}` }];
    const idLabels = [{ id: "wf-lbl", name: "wf:commitment" }, { id: `${cur}-lbl`, name: `state:${cur}` }];
    const nativeId = NATIVE_STATE_ID[cur];

    if (query.includes("ApplyAtomicTransition")) {
      const labelIds = (parsed.variables.labelIds ?? []) as string[];
      const targetLbl = labelIds.find((id) => id !== "wf-lbl" && id in LABEL_ID_TO_STATE);
      if (targetLbl) state.current = LABEL_ID_TO_STATE[targetLbl];
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("VerifyTransitionWrite")) {
      return json({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:commitment" }, { name: `state:${state.current}` }] },
            delegate: { id: IGOR_LINEAR_ID },
            assignee: null,
            state: { id: NATIVE_STATE_ID[state.current] },
          },
        },
      });
    }
    if (query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: ISSUE_IDENTIFIER,
            team: { id: TEAM_ID },
            labels: { nodes: idLabels },
            delegate: { id: IGOR_LINEAR_ID },
            assignee: null,
            state: { id: nativeId },
          },
        },
      });
    }
    if (query.includes("IssueContext") || query.includes("IssueLabels")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: ISSUE_IDENTIFIER,
            labels: { nodes: nameLabels },
            delegate: { id: IGOR_LINEAR_ID },
            state: { id: nativeId, name: cur, type: "unstarted" },
          },
        },
      });
    }
    if (query.includes("EngagementIssue")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            team: { id: TEAM_ID },
            state: { id: nativeId, name: cur },
            labels: { nodes: nameLabels },
            delegate: { id: IGOR_LINEAR_ID },
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: STATE_LABEL_NODES } } } });
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
                { id: "state-canceled", name: "Canceled", type: "canceled" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("issueUpdate")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: {} });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, state };
}

function setupConfig(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: IGOR_LINEAR_ID,
          openclawAgent: "igor",
          accessToken: "tok-igor",
          refreshToken: "ref-igor",
          clientId: "client",
          clientSecret: "secret",
        },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  process.env.WORKFLOW_DEF_PATH = path.join(dir, "workflow.yaml");
  fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
  fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, WORKFLOW_YAML, "utf8");
  resetPolicyCache();
  resetWorkflowCache();
  resetConfigHealth();
  reloadAgents();
  _setTransitionWritePolicyForTests({ maxAttempts: 1, retryDelayMs: 0 });
}

function exits(ops: OperationalEventStore) {
  return ops.query({ key: ISSUE_IDENTIFIER, outcome: "commitment-exit-recorded" });
}
function rearms(ops: OperationalEventStore) {
  return ops.query({ key: ISSUE_IDENTIFIER, outcome: "commitment-exit-rearmed" });
}

describe("INF-781 — commitment gate re-arms on a revision bounce", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-781-"));
    originalFetch = globalThis.fetch;
    _resetAppliedStateStore();
    setupConfig(dir);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetAppliedStateStore();
    _setTransitionWritePolicyForTests();
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC1: the full accept → request-revision → accept round re-commits (second accept applies, not skipped)", async () => {
    const ops = new OperationalEventStore(path.join(dir, "ops-round.db"));
    const { fetch, state } = makeStatefulFetch("implementation");
    globalThis.fetch = fetch;
    const opts = { bodyId: "igor", operationalEventStore: ops } as const;

    // 1) First commitment: implementation → doing, records exit #1.
    const accept1 = await applyStateTransition("accept", ISSUE_UUID, "Bearer tok-igor", {
      ...opts,
      sourceStateOverride: "implementation",
    });
    expect(accept1.status).toBe("applied");
    expect(state.current).toBe("doing");
    expect(exits(ops)).toHaveLength(1);
    expect(rearms(ops)).toHaveLength(0);

    // 2) Submit for review: doing → review.
    recordAppliedState(ISSUE_IDENTIFIER, "doing");
    const submit = await applyStateTransition("submit", ISSUE_UUID, "Bearer tok-igor", {
      ...opts,
      sourceStateOverride: "doing",
    });
    expect(submit.status).toBe("applied");
    expect(state.current).toBe("review");

    // 3) Revision bounce: review → implementation. Re-arms the gate.
    recordAppliedState(ISSUE_IDENTIFIER, "review");
    const revision = await applyStateTransition("request-changes", ISSUE_UUID, "Bearer tok-igor", {
      ...opts,
      sourceStateOverride: "review",
    });
    expect(revision.status).toBe("applied");
    expect(state.current).toBe("implementation");
    expect(rearms(ops)).toHaveLength(1);
    expect(rearms(ops)[0].detail).toMatchObject({
      workflow: "commitment",
      from: "review",
      to: "implementation",
    });

    // 4) Re-commit: implementation → doing MUST apply (previously a no-op
    //    "commitment-exit-already-recorded" that stranded the ticket).
    recordAppliedState(ISSUE_IDENTIFIER, "implementation");
    const accept2 = await applyStateTransition("accept", ISSUE_UUID, "Bearer tok-igor", {
      ...opts,
      sourceStateOverride: "implementation",
    });
    expect(accept2.status).toBe("applied");
    expect(accept2.code).not.toBe("commitment-exit-already-recorded");
    expect(state.current).toBe("doing");
    // A fresh exit for the new cycle is recorded (one per accept).
    expect(exits(ops)).toHaveLength(2);

    ops.close();
  });

  it("AC2: a duplicate accept WITHOUT a revision bounce is still deduped (INF-695 contract preserved)", async () => {
    const ops = new OperationalEventStore(path.join(dir, "ops-dedup.db"));
    const { fetch } = makeStatefulFetch("implementation");
    globalThis.fetch = fetch;
    const opts = { bodyId: "igor", operationalEventStore: ops } as const;

    const accept1 = await applyStateTransition("accept", ISSUE_UUID, "Bearer tok-igor", {
      ...opts,
      sourceStateOverride: "implementation",
    });
    expect(accept1.status).toBe("applied");
    expect(exits(ops)).toHaveLength(1);

    // No bounce, no rearm — a second accept from the gate state is a no-op and
    // records no second exit.
    const accept2 = await applyStateTransition("accept", ISSUE_UUID, "Bearer tok-igor", {
      ...opts,
      sourceStateOverride: "implementation",
    });
    expect(accept2.status).toBe("noop");
    expect(accept2.code).toBe("commitment-exit-already-recorded");
    expect(exits(ops)).toHaveLength(1);
    expect(rearms(ops)).toHaveLength(0);

    ops.close();
  });
});
