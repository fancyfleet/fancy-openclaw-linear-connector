/**
 * INF-562: continue-workflow bypassed a sign-off gate after the destination
 * delegate write failed.
 *
 * AC mapping:
 *   AC1 — governed transitions are atomic: if an ownership facet fails to
 *     persist, the transition must not leave authoritative state advanced.
 *   AC2 — sign-off/approval-gate states require a fresh act by their owner and
 *     must not inherit prior-state continue-workflow approval intent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { applyStateTransition, resetWorkflowCache, resolveMetaIntent } from "./workflow-gate.js";
import { _resetAppliedStateStore, getAppliedState } from "./store/applied-state-store.js";

const WORKFLOW_YAML = `
id: task
version: 1
archetype: single-task
entry_state: review
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
      - command: request
        to: review
        generic: continue
  - id: review
    owner_role: reviewer
    kind: normal
    native_state: doing
    transitions:
      - command: approve-review
        to: sign-off
        generic: continue
  - id: sign-off
    owner_role: signoff
    kind: approval_gate
    native_state: thinking
    transitions:
      - command: explicit-signoff
        to: done
        generic: continue
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
  - id: reviewer
    grants: [linear:transition]
  - id: signoff
    grants: [linear:transition]
roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: reviewer
    requires: [linear:transition]
  - id: signoff
    requires: [linear:transition]
bodies:
  - id: astrid
    container: reviewer
    fills_roles: [reviewer]
  - id: ai
    container: signoff
    fills_roles: [signoff, steward]
`;

type FetchCall = { query: string; variables: Record<string, unknown> };

function json(payload: object): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function labelsFor(state: string): Array<{ id: string; name: string }> {
  return [
    { id: "wf-task", name: "wf:task" },
    { id: `state-${state}`, name: `state:${state}` },
  ];
}

const TEAM_LABELS = [
  { id: "wf-task", name: "wf:task" },
  { id: "state-intake", name: "state:intake" },
  { id: "state-review", name: "state:review" },
  { id: "state-sign-off", name: "state:sign-off" },
  { id: "state-done", name: "state:done" },
];

function makeLinearFetch(opts: {
  liveState: "intake" | "review" | "sign-off" | "done";
  verifyDelegateId?: string | null;
  verifyState?: "intake" | "review" | "sign-off" | "done";
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as FetchCall;
    calls.push(body);
    const query = body.query ?? "";

    if (query.includes("IssueContext") || query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: "internal-inf-562",
            identifier: "INF-562",
            team: { id: "team-inf" },
            labels: { nodes: labelsFor(opts.liveState) },
            delegate: { id: opts.liveState === "sign-off" ? "u-ai" : "u-astrid" },
          },
        },
      });
    }
    if (query.includes("TeamStateLabels")) {
      return json({ data: { issue: { team: { labels: { nodes: TEAM_LABELS } } } } });
    }
    if (query.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: TEAM_LABELS } } } });
    }
    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "native-todo", name: "Todo", type: "unstarted" },
                { id: "native-doing", name: "Doing", type: "started" },
                { id: "native-thinking", name: "Thinking", type: "started" },
                { id: "native-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("VerifyTransitionWrite")) {
      const nativeStateIdByWorkflowState: Record<string, string> = {
        intake: "native-todo",
        review: "native-doing",
        "sign-off": "native-thinking",
        done: "native-done",
      };
      const verifyState = opts.verifyState ?? opts.liveState;
      return json({
        data: {
          issue: {
            labels: { nodes: labelsFor(verifyState) },
            delegate: opts.verifyDelegateId === null ? null : { id: opts.verifyDelegateId ?? "u-ai" },
            state: { id: nativeStateIdByWorkflowState[verifyState] },
          },
        },
      });
    }
    throw new Error(`unexpected Linear query: ${query.slice(0, 100)}`);
  };
  return { fetch: mockFetch, calls };
}

describe("INF-562 governed sign-off and terminal escape regressions", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-562-"));
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "task.yaml");
    fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, WORKFLOW_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    fs.writeFileSync(process.env.AGENTS_FILE, JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "ai", linearUserId: "u-ai", openclawAgent: "ai", accessToken: "tok-ai", host: "local" },
      ],
    }), "utf8");
    reloadAgents();
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    _resetAppliedStateStore();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetAppliedStateStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC1: failed sign-off delegate persistence does not mark review->sign-off as authoritatively applied", async () => {
    const { fetch: mock } = makeLinearFetch({
      liveState: "review",
      verifyState: "sign-off",
      verifyDelegateId: null,
    });
    globalThis.fetch = mock;

    const result = await applyStateTransition("approve-review", "INF-562", "Bearer tok-astrid", {
      bodyId: "astrid",
    });

    expect(result.status).toBe("failed");
    expect(result.code).toBe("transition-write-unverified");
    expect(getAppliedState("INF-562")).toBeNull();
  });

  it("AC2: a review-stage continue snapshot is not reused to satisfy the sign-off gate", async () => {
    const { fetch: mock } = makeLinearFetch({ liveState: "sign-off" });
    globalThis.fetch = mock;

    const result = await resolveMetaIntent("continue-workflow", "INF-562", "Bearer tok-astrid", "review");

    expect(result).toEqual({
      error: expect.stringMatching(/sign-off.*explicit.*owner/i),
    });
  });

});
