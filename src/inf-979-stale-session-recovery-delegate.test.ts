/**
 * INF-979 — stale-session recovery must not create null-delegate husks.
 *
 * Ask mapping:
 *   1. C3/stale-session recovery must not clear a still-owned, non-terminal
 *      governed ticket's delegate.
 *   2. Governed-state redispatch/re-seat must bootstrap-seat the workflow role
 *      owner when Linear delegate is null.
 *   3. Liveness must reconcile connector engagement ownership with Linear
 *      delegate state, so a null Linear delegate is not treated as ownerless
 *      while engagement still identifies an active owner.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { recoverTicket, type StaleSnapshot } from "./bag/stale-session-forensics.js";
import { setStateAtomic, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { classifyStall, type LivenessRecord, type StallClassifierConfig } from "./stall-detection.js";

const LINEAR_IGOR_ID = "user-igor-linear-id";

function makeSnapshot(overrides: Partial<StaleSnapshot> = {}): StaleSnapshot {
  return {
    capturedAt: "2026-08-01T00:00:00.000Z",
    metadata: {
      agentId: "igor",
      ticketId: "linear-INF-979",
      sessionKey: "linear-INF-979",
      sessionFile: null,
      sessionStartedAt: Date.now() - 30 * 60 * 1000,
      lastActivityAt: Date.now() - 25 * 60 * 1000,
      timeoutMs: 25 * 60 * 1000,
      totalDurationMs: 25 * 60 * 1000,
    },
    lastAssistantMessage: {
      fullText: "I finished the work and verified the narrow suite.",
      hasQuestion: false,
      hasToolCalls: false,
      stopReason: "end_turn",
      timestamp: "2026-08-01T00:00:00.000Z",
    },
    lastToolCall: null,
    toolCallSummary: { totalCalls: 0, byName: {}, last10: [] },
    linearTicket: {
      identifier: "INF-979",
      stateAtStart: "Doing",
      stateAtTimeout: "Doing",
      lastCommentAtStart: null,
      lastCommentAtTimeout: null,
      commentCountAtStart: null,
      commentCountAtTimeout: null,
    },
    classification: "C3",
    errors: [],
    diagnosticPath: "/tmp/inf-979.json",
    ...overrides,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-979-"));
}

function writeWorkflowDef(dir: string): string {
  const file = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(file, yaml.dump({
    id: "dev-impl",
    version: 1,
    entry_state: "intake",
    break_glass: { command: "escape", to: "escape", owner_role: "steward" },
    states: [
      { id: "intake", owner_role: "steward", kind: "normal", native_state: "todo", transitions: [] },
      { id: "implementation", owner_role: "dev", kind: "normal", native_state: "todo", transitions: [] },
      { id: "done", kind: "terminal", native_state: "done" },
    ],
  }), "utf8");
  return file;
}

function writePolicyYaml(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(file, yaml.dump({
    bodies: [
      { id: "igor", container: "dev", fills_roles: ["dev"] },
      { id: "astrid", container: "steward", fills_roles: ["steward"] },
    ],
    containers: [
      { id: "dev", grants: ["linear:transition"] },
      { id: "steward", grants: ["linear:transition"] },
    ],
  }), "utf8");
  return file;
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      {
        name: "igor",
        linearUserId: LINEAR_IGOR_ID,
        openclawAgent: "igor",
        clientId: "client-id",
        clientSecret: "client-secret",
        accessToken: "access-token-igor",
        refreshToken: "refresh-token-igor",
      },
    ],
  }), "utf8");
  return file;
}

describe("INF-979 ask 1: stale-session recovery preserves live governed delegate", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINEAR_OAUTH_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.LINEAR_OAUTH_TOKEN;
    else process.env.LINEAR_OAUTH_TOKEN = originalToken;
  });

  it("does not send delegateId:null for a C3 still-owned, non-terminal governed ticket", async () => {
    process.env.LINEAR_OAUTH_TOKEN = "test-token";
    const issueUpdates: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = body.query ?? "";

      if (query.includes("IssueWithTeam")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: "issue-inf-979",
              team: { id: "team-inf" },
              state: { name: "Doing", type: "started" },
              delegate: { id: LINEAR_IGOR_ID },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (query.includes("commentCreate")) {
        return new Response(JSON.stringify({ data: { commentCreate: { comment: { id: "comment-1" } } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (query.includes("TeamStates")) {
        return new Response(JSON.stringify({
          data: { team: { workflow: { states: [{ id: "state-todo", name: "To Do", type: "unstarted" }] } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (query.includes("RecoverIssue")) {
        issueUpdates.push(body.variables?.input as Record<string, unknown>);
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue: { state: { name: "To Do" } } } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    const result = await recoverTicket(makeSnapshot({ classification: "C3" }), "igor");

    expect(result.success).toBe(true);
    expect(issueUpdates).toHaveLength(1);
    expect(issueUpdates[0]).not.toHaveProperty("delegateId");
    expect(result.action).not.toContain("delegate-cleared");
  });
});

describe("INF-979 ask 2: governed-state redispatch re-seats null delegate", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = tempDir();
    originalFetch = globalThis.fetch;
    for (const key of ["WORKFLOW_DEF_PATH", "WORKFLOW_DEF_STATE_SNAPSHOT_PATH", "CAPABILITY_POLICY_PATH", "AGENTS_FILE"]) {
      originalEnv[key] = process.env[key];
    }
    process.env.WORKFLOW_DEF_PATH = writeWorkflowDef(dir);
    process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "def-state-snapshot.json");
    process.env.CAPABILITY_POLICY_PATH = writePolicyYaml(dir);
    process.env.AGENTS_FILE = writeAgents(dir);
    reloadAgents();
    resetWorkflowCache();
    resetPolicyCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetWorkflowCache();
    resetPolicyCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("bootstrap-seats the singleton owner_role delegate when redispatching a governed state whose Linear delegate is null", async () => {
    let atomicVariables: Record<string, unknown> | null = null;
    const wakeCalls: Array<{ agentId: string; ticketId: string }> = [];

    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = body.query ?? "";

      if (query.includes("IssueWithLabels")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: "issue-inf-979",
              identifier: "INF-979",
              team: { id: "team-inf" },
              labels: {
                nodes: [
                  { id: "label-wf", name: "wf:dev-impl" },
                  { id: "label-state-old", name: "state:implementation" },
                ],
              },
              delegate: null,
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (query.includes("TeamLabels")) {
        return new Response(JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "label-wf", name: "wf:dev-impl" },
                  { id: "label-state-implementation", name: "state:implementation" },
                ],
              },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (query.includes("TeamStates")) {
        return new Response(JSON.stringify({
          data: { team: { states: { nodes: [{ id: "state-todo", name: "To Do", type: "unstarted" }] } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (query.includes("ApplyAtomicTransition")) {
        atomicVariables = body.variables ?? {};
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (query.includes("VerifyTransitionWrite")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
              delegate: { id: LINEAR_IGOR_ID },
              state: { id: "state-todo" },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    const result = await setStateAtomic("INF-979", "implementation", undefined, "Bearer token", {
      sendWakeUp: async (agentId, ticketId) => {
        wakeCalls.push({ agentId, ticketId });
      },
    });

    expect(result.ok).toBe(true);
    expect(wakeCalls).toEqual([{ agentId: "igor", ticketId: "INF-979" }]);
    expect(atomicVariables).not.toBeNull();
    expect(atomicVariables).toMatchObject({
      delegateId: LINEAR_IGOR_ID,
      assigneeId: null,
    });
  });
});

describe("INF-979 ask 3: engagement owner prevents false ownerless classification", () => {
  const config: StallClassifierConfig = {
    ackTimeoutMs: 3 * 60 * 1000,
    progressTimeoutMs: 12 * 60 * 1000,
  };

  it("does not classify delegate=null as ownerless when connector engagement still names an active owner", () => {
    const now = Date.now();
    const record = {
      ticketId: "INF-979",
      dispatchedAt: now - 60_000,
      ackedAt: now - 55_000,
      lastProgressAt: now - 5_000,
      delegate: null,
      state: "implementation",
      redispatched: false,
      engagementOwner: "igor",
      engagementSemantic: "doing",
      engagementObservedAt: now - 5_000,
    } as LivenessRecord & {
      engagementOwner: string;
      engagementSemantic: "thinking" | "doing";
      engagementObservedAt: number;
    };

    const result = classifyStall(record, config, now);

    expect(result.stalled).toBe(false);
    expect(result.reason).not.toBe("null-delegate");
  });
});
