/**
 * INF-1198 / INF-1134 regression coverage: stale recovery for governed
 * dev-impl tickets must use the governed atomic transition writer, not raw
 * Linear issueUpdate state pokes that can split native state from wf/state labels.
 *
 * AC map:
 * - AC1: governed recovery may not raw-move native To Do/Doing without the
 *   workflow projection moving in the same atomic write.
 * - AC2: C3/C4 still-owned governed tickets are re-dispatched in place, so
 *   recovery must not relabel or native-move them off the workflow spine.
 * - AC3: shed / needs-human recovery uses the same atomic write semantics as
 *   normal governed transitions.
 * - AC4: a fixture proves the old raw stateId-only recovery would leave
 *   native/label split-brain, and recovery must not report that as success.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { reloadAgents } from "./agents.js";
import { recoverTicket, type StaleSnapshot } from "./bag/stale-session-forensics.js";

const IGOR_LINEAR_ID = "user-igor-linear-id";
const HUMAN_LINEAR_ID = "user-human-linear-id";

type GraphqlCall = {
  query: string;
  variables: Record<string, unknown>;
};

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSnapshot(overrides: Partial<StaleSnapshot> = {}): StaleSnapshot {
  return {
    capturedAt: "2026-08-04T00:00:00.000Z",
    metadata: {
      agentId: "igor",
      ticketId: "linear-INF-1198",
      sessionKey: "linear-INF-1198",
      sessionFile: null,
      sessionStartedAt: Date.now() - 30 * 60 * 1000,
      lastActivityAt: Date.now() - 25 * 60 * 1000,
      timeoutMs: 25 * 60 * 1000,
      totalDurationMs: 25 * 60 * 1000,
    },
    lastAssistantMessage: {
      fullText: "I finished the implementation work and tests, but did not transition the ticket.",
      hasQuestion: false,
      hasToolCalls: false,
      stopReason: "end_turn",
      timestamp: "2026-08-04T00:00:00.000Z",
    },
    lastToolCall: null,
    toolCallSummary: { totalCalls: 1, byName: { exec_command: 1 }, last10: [] },
    linearTicket: {
      identifier: "INF-1198",
      stateAtStart: "Doing",
      stateAtTimeout: "Doing",
      lastCommentAtStart: null,
      lastCommentAtTimeout: null,
      commentCountAtStart: null,
      commentCountAtTimeout: null,
    },
    classification: "C3",
    errors: [],
    diagnosticPath: "/tmp/inf-1198-stale-session.json",
    ...overrides,
  };
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: IGOR_LINEAR_ID,
          openclawAgent: "igor",
          accessToken: "token-igor",
          refreshToken: "refresh-igor",
          clientId: "client-igor",
          clientSecret: "secret-igor",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

function makeRecoveryFetch(opts: {
  liveDelegateId?: string | null;
  nativeStateAfterRawWrite?: string;
  labelStateAfterWrite?: string;
  rawUpdateSuccess?: boolean;
  atomicWritePersists?: boolean;
} = {}): { fetch: typeof globalThis.fetch; calls: GraphqlCall[] } {
  const calls: GraphqlCall[] = [];
  const liveDelegateId = opts.liveDelegateId === undefined ? IGOR_LINEAR_ID : opts.liveDelegateId;
  let currentNativeStateName = opts.nativeStateAfterRawWrite ?? "To Do";
  let currentNativeStateId = currentNativeStateName === "Doing" ? "state-doing" : currentNativeStateName === "Needs Human" ? "state-needs-human" : "state-todo";
  let currentLabelState = opts.labelStateAfterWrite ?? "implementation";
  let currentDelegateId = liveDelegateId;
  let currentAssigneeId: string | null = null;
  const rawUpdateSuccess = opts.rawUpdateSuccess ?? true;
  const atomicWritePersists = opts.atomicWritePersists ?? true;

  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphqlCall;
    calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
    const query = parsed.query ?? "";

    if (query.includes("IssueWithTeam")) {
      return json({
        data: {
          issue: {
            id: "issue-inf-1198",
            identifier: "INF-1198",
            team: { id: "team-inf" },
            state: { id: "state-doing", name: "Doing", type: "started" },
            delegate: liveDelegateId ? { id: liveDelegateId } : null,
            labels: {
              nodes: [
                { id: "label-wf-dev-impl", name: "wf:dev-impl" },
                { id: `label-state-${currentLabelState}`, name: `state:${currentLabelState}` },
              ],
            },
          },
        },
      });
    }

    if (query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: "issue-inf-1198",
            identifier: "INF-1198",
            team: { id: "team-inf" },
            delegate: currentDelegateId ? { id: currentDelegateId } : null,
            state: { id: currentNativeStateId, name: currentNativeStateName },
            labels: {
              nodes: [
                { id: "label-wf-dev-impl", name: "wf:dev-impl", team: { id: "team-inf" } },
                { id: `label-state-${currentLabelState}`, name: `state:${currentLabelState}`, team: { id: "team-inf" } },
              ],
            },
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return json({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "label-wf-dev-impl", name: "wf:dev-impl", team: { id: "team-inf" } },
                { id: "label-state-implementation", name: "state:implementation", team: { id: "team-inf" } },
                { id: "label-state-doing", name: "state:doing", team: { id: "team-inf" } },
                { id: "label-state-needs-human", name: "state:needs-human", team: { id: "team-inf" } },
              ],
            },
          },
        },
      });
    }

    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            workflow: {
              states: [
                { id: "state-todo", name: "To Do", type: "unstarted" },
                { id: "state-doing", name: "Doing", type: "started" },
                { id: "state-needs-human", name: "Needs Human", type: "unstarted" },
              ],
            },
            states: {
              nodes: [
                { id: "state-todo", name: "To Do", type: "unstarted" },
                { id: "state-doing", name: "Doing", type: "started" },
                { id: "state-needs-human", name: "Needs Human", type: "unstarted" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    }

    if (query.includes("RecoverIssue")) {
      if (rawUpdateSuccess && typeof parsed.variables?.input === "object" && parsed.variables.input) {
        const input = parsed.variables.input as Record<string, unknown>;
        if (input.stateId === "state-doing") {
          currentNativeStateId = "state-doing";
          currentNativeStateName = "Doing";
        } else if (input.stateId === "state-needs-human") {
          currentNativeStateId = "state-needs-human";
          currentNativeStateName = "Needs Human";
        } else if (input.stateId === "state-todo") {
          currentNativeStateId = "state-todo";
          currentNativeStateName = "To Do";
        }
      }
      return json({
        data: {
          issueUpdate: {
            success: rawUpdateSuccess,
            issue: { id: "issue-inf-1198", state: { name: currentNativeStateName } },
          },
        },
      });
    }

    if (query.includes("ApplyAtomicTransition")) {
      if (atomicWritePersists) {
        const labelIds = Array.isArray(parsed.variables?.labelIds) ? parsed.variables.labelIds : [];
        const stateLabelId = labelIds.find((id): id is string => typeof id === "string" && id.startsWith("label-state-"));
        if (stateLabelId) currentLabelState = stateLabelId.replace(/^label-state-/, "");
        if (parsed.variables?.stateId === "state-doing") {
          currentNativeStateId = "state-doing";
          currentNativeStateName = "Doing";
        } else if (parsed.variables?.stateId === "state-needs-human") {
          currentNativeStateId = "state-needs-human";
          currentNativeStateName = "Needs Human";
        } else if (parsed.variables?.stateId === "state-todo") {
          currentNativeStateId = "state-todo";
          currentNativeStateName = "To Do";
        }
        if (Object.prototype.hasOwnProperty.call(parsed.variables, "delegateId")) {
          currentDelegateId = typeof parsed.variables.delegateId === "string" ? parsed.variables.delegateId : null;
        }
        if (Object.prototype.hasOwnProperty.call(parsed.variables, "assigneeId")) {
          currentAssigneeId = typeof parsed.variables.assigneeId === "string" ? parsed.variables.assigneeId : null;
        }
      }
      return json({ data: { issueUpdate: { success: true } } });
    }

    if (query.includes("VerifyTransitionWrite")) {
      return json({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: `state:${currentLabelState}` }] },
            delegate: currentDelegateId ? { id: currentDelegateId } : null,
            assignee: currentAssigneeId ? { id: currentAssigneeId } : null,
            state: { id: currentNativeStateId },
          },
        },
      });
    }

    return json({ data: {} });
  }) as typeof globalThis.fetch;

  return { fetch, calls };
}

function issueUpdateCalls(calls: GraphqlCall[]): GraphqlCall[] {
  return calls.filter((call) => call.query.includes("issueUpdate"));
}

function rawRecoverCalls(calls: GraphqlCall[]): GraphqlCall[] {
  return calls.filter((call) => call.query.includes("RecoverIssue"));
}

function atomicTransitionCalls(calls: GraphqlCall[]): GraphqlCall[] {
  return calls.filter((call) => call.query.includes("ApplyAtomicTransition"));
}

describe("INF-1198 stale-session recovery atomicity", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1198-"));
    originalFetch = globalThis.fetch;
    for (const key of [
      "AGENTS_FILE",
      "LINEAR_OAUTH_TOKEN",
      "LINEAR_API_KEY",
      "STALE_HUMAN_ASSIGNEE_LINEAR_ID",
      "STALE_RECOVERY_NEEDS_HUMAN_STATE",
    ]) {
      originalEnv[key] = process.env[key];
    }
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.LINEAR_OAUTH_TOKEN = "linear-token";
    process.env.STALE_HUMAN_ASSIGNEE_LINEAR_ID = HUMAN_LINEAR_ID;
    process.env.STALE_RECOVERY_NEEDS_HUMAN_STATE = "Needs Human";
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC1: governed C2 redispatch recovery writes workflow label and native state atomically, never raw native To Do only", async () => {
    const { fetch, calls } = makeRecoveryFetch({ liveDelegateId: null });
    globalThis.fetch = fetch;

    const result = await recoverTicket(makeSnapshot({
      classification: "C2",
      lastAssistantMessage: {
        fullText: "",
        hasQuestion: false,
        hasToolCalls: true,
        stopReason: "tool_use",
        timestamp: "2026-08-04T00:00:00.000Z",
      },
      lastToolCall: {
        name: "exec_command",
        arguments: { cmd: "npm test" },
        result: "no-result",
        timestamp: "2026-08-04T00:00:00.000Z",
      },
      toolCallSummary: { totalCalls: 1, byName: { exec_command: 1 }, last10: [] },
    }), "igor", { redispatchDbPath: path.join(dir, "redispatch-c2.db") });

    expect(result.success).toBe(true);
    expect(rawRecoverCalls(calls)).toHaveLength(0);
    expect(atomicTransitionCalls(calls)).toHaveLength(1);
    expect(atomicTransitionCalls(calls)[0].variables).toEqual(expect.objectContaining({
      labelIds: expect.arrayContaining(["label-wf-dev-impl"]),
      stateId: expect.any(String),
    }));
  });

  it("AC2: still-owned C3 governed recovery re-dispatches in place without relabeling or native-moving off-spine", async () => {
    const { fetch, calls } = makeRecoveryFetch({ liveDelegateId: IGOR_LINEAR_ID });
    globalThis.fetch = fetch;

    const result = await recoverTicket(makeSnapshot({ classification: "C3" }), "igor");

    expect(result.success).toBe(true);
    expect(result.action).toMatch(/re-?dispatch|re-?poke|in-place/i);
    expect(issueUpdateCalls(calls)).toHaveLength(0);
  });

  it("AC3: capped C4 shed to needs-human uses the same atomic label/native/delegate/assignee write semantics", async () => {
    const { fetch, calls } = makeRecoveryFetch({ liveDelegateId: null });
    globalThis.fetch = fetch;

    const result = await recoverTicket(makeSnapshot({
      classification: "C4",
      lastAssistantMessage: null,
      lastToolCall: null,
      toolCallSummary: { totalCalls: 0, byName: {}, last10: [] },
    }), "igor", {
      redispatchDbPath: path.join(dir, "redispatch-c4.db"),
      maxRedispatchAttempts: 1,
      humanAssigneeLinearId: HUMAN_LINEAR_ID,
    });

    expect(result.success).toBe(true);
    expect(rawRecoverCalls(calls)).toHaveLength(0);
    expect(atomicTransitionCalls(calls)).toHaveLength(1);
    expect(atomicTransitionCalls(calls)[0].variables).toEqual(expect.objectContaining({
      labelIds: expect.arrayContaining(["label-wf-dev-impl", "label-state-needs-human"]),
      stateId: "state-needs-human",
      delegateId: null,
      assigneeId: HUMAN_LINEAR_ID,
    }));
  });

  it("AC4: raw native-only recovery split-brain fixture is not reported as a successful recovery", async () => {
    const { fetch, calls } = makeRecoveryFetch({
      liveDelegateId: null,
      nativeStateAfterRawWrite: "To Do",
      labelStateAfterWrite: "doing",
      atomicWritePersists: false,
    });
    globalThis.fetch = fetch;

    const result = await recoverTicket(makeSnapshot({
      classification: "C2",
      lastAssistantMessage: {
        fullText: "",
        hasQuestion: false,
        hasToolCalls: true,
        stopReason: "tool_use",
        timestamp: "2026-08-04T00:00:00.000Z",
      },
      lastToolCall: {
        name: "exec_command",
        arguments: { cmd: "npm test" },
        result: "no-result",
        timestamp: "2026-08-04T00:00:00.000Z",
      },
      toolCallSummary: { totalCalls: 1, byName: { exec_command: 1 }, last10: [] },
    }), "igor", { redispatchDbPath: path.join(dir, "redispatch-split.db") });

    expect(rawRecoverCalls(calls)).toHaveLength(0);
    expect(result).toMatchObject({
      success: false,
      action: expect.stringMatching(/split-brain|unverified|atomic-mutation-failed/i),
    });
  });
});
