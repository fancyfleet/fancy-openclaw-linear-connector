/**
 * INF-792 — wf:task NULL-DELEGATE re-seat, terminal reopen, and Rule 6b guard.
 *
 * AC mapping:
 *   AC1 Root cause write-up is not directly executable; the implementation handoff
 *       must document the offending stall-sweep/proxy close path in Linear.
 *   AC2 A NULL-DELEGATE re-seat for an in-flight wf:task is same-state,
 *       non-terminal, and restores the singleton owner delegate.
 *   AC3 Break-glass can un-terminate terminal workflow tickets for both wf:task
 *       and dev-impl by returning them to a legal non-terminal re-entry state.
 *   AC4 A wf:task To Do -> Done close carrying open/unmerged PR evidence is
 *       refused, while merged/no-PR cases remain permitted.
 *   AC5 The AC4 guard is exercised through the production /proxy/graphql entry
 *       point, not only by a module-level helper.
 *
 * These tests are expected RED until INF-792 is implemented. In particular,
 * current code has merged-PR gates for dev-impl merge/deploy, but no Rule 6b
 * guard on wf:task terminal close.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createApp } from "./index.js";
import {
  applyStateTransition,
  checkWorkflowRules,
  resetWorkflowCache,
  setStateAtomic,
} from "./workflow-gate.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";

const TOK = "Bearer test-token";
const ISSUE_UUID = "issue-inf-792-uuid";
const LINEAR_AI_ID = "u-ai";
const LINEAR_IGOR_ID = "u-igor";

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
  - id: worker
    requires: [linear:transition]
  - id: steward
    requires: [workflow:break-glass]

bodies:
  - id: ai
    container: steward
    fills_roles: [requester, steward]
  - id: igor
    container: dev
    fills_roles: [worker]
`;

const TASK_YAML = `
id: task
version: 792
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: requester
    kind: normal
    native_state: todo
    transitions:
      - command: assign
        to: doing
  - id: doing
    owner_role: worker
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: sign-off
  - id: sign-off
    owner_role: requester
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: done
  - id: done
    kind: terminal
    native_state: done
`;

const DEV_IMPL_YAML = `
id: dev-impl
version: 792
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
    owner_role: worker
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: merge
  - id: merge
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: deploy
  - id: deploy
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: done
  - id: done
    kind: terminal
    native_state: done
`;

type PrCase = "none" | "open" | "merged";

function json(payload: object): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "ai", linearUserId: LINEAR_AI_ID, openclawAgent: "ai", accessToken: "tok-ai", host: "local" },
        { name: "igor", linearUserId: LINEAR_IGOR_ID, openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

function writeDefs(dir: string): string {
  const defs = path.join(dir, "defs");
  fs.mkdirSync(defs);
  fs.writeFileSync(path.join(defs, "task.yaml"), TASK_YAML, "utf8");
  fs.writeFileSync(path.join(defs, "dev-impl.yaml"), DEV_IMPL_YAML, "utf8");
  return defs;
}

function makeLinearFetch(opts: {
  workflow: "task" | "dev-impl";
  state: string;
  delegateId?: string | null;
  prCase?: PrCase;
  atomicWrites?: Array<Record<string, unknown>>;
}): typeof globalThis.fetch {
  let delegateId = opts.delegateId === undefined ? LINEAR_AI_ID : opts.delegateId;
  let currentState = opts.state;
  let nativeStateId = opts.state === "done" ? "native-done" : opts.state === "doing" ? "native-doing" : "native-todo";
  const prCase = opts.prCase ?? "none";
  const wfLabel = { id: `wf-${opts.workflow}`, name: opts.workflow === "task" ? "wf:task" : "wf:dev-impl" };
  const labelsForCurrentState = () => [
    wfLabel,
    { id: `state-${currentState}`, name: `state:${currentState}` },
  ];
  const teamLabels = [
    { id: "state-intake", name: "state:intake" },
    { id: "state-doing", name: "state:doing" },
    { id: "state-sign-off", name: "state:sign-off" },
    { id: "state-implementation", name: "state:implementation" },
    { id: "state-done", name: "state:done" },
  ];

  return (async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected URL in INF-792 test: ${String(url)}`);
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = parsed.query ?? "";
    const labels = labelsForCurrentState();

    if (query.includes("IssueContext") || (query.includes("IssueLabels") && !query.includes("IssueWithLabels"))) {
      return json({
        data: {
          issue: {
            identifier: "INF-792",
            labels: { nodes: labels.map(({ name }) => ({ name })) },
            delegate: delegateId ? { id: delegateId } : null,
          },
        },
      });
    }

    if (query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: "INF-792",
            team: { id: "team-inf" },
            labels: { nodes: labels },
            delegate: delegateId ? { id: delegateId } : null,
          },
        },
      });
    }

    if (query.includes("TeamLabels") || query.includes("TeamStateLabels")) {
      return json({
        data: {
          team: { labels: { nodes: [...labels, ...teamLabels] } },
          issue: { team: { labels: { nodes: [...labels, ...teamLabels] } } },
        },
      });
    }

    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "native-todo", name: "To Do", type: "unstarted" },
                { id: "native-doing", name: "Doing", type: "started" },
                { id: "native-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("IssueBranchAndPR")) {
      const attachments =
        prCase === "none"
          ? []
          : [{
              url: "https://github.com/fancyfleet/fancy-openclaw-linear-connector/pull/563",
              sourceType: "github",
              metadata: prCase === "merged"
                ? { status: "merged", mergeCommitSha: "e53d811e00000000000000000000000000000000" }
                : { status: "open", headSha: "e53d811e00000000000000000000000000000000" },
            }];
      return json({
        data: {
          issue: {
            description: "",
            comments: { nodes: [] },
            attachments: { nodes: attachments },
          },
        },
      });
    }

    if (query.includes("ApplyAtomicTransition")) {
      opts.atomicWrites?.push(parsed.variables ?? {});
      const labelIds = parsed.variables?.labelIds;
      if (Array.isArray(labelIds)) {
        const stateLabelId = labelIds.find((id): id is string => typeof id === "string" && id.startsWith("state-"));
        if (stateLabelId) currentState = stateLabelId.slice("state-".length);
      }
      if ("delegateId" in (parsed.variables ?? {})) {
        delegateId = parsed.variables?.delegateId as string | null;
      }
      if ("stateId" in (parsed.variables ?? {})) {
        nativeStateId = parsed.variables?.stateId as string;
      }
      return json({ data: { issueUpdate: { success: true } } });
    }

    if (query.includes("VerifyTransitionWrite")) {
      const verifyLabels = labelsForCurrentState();
      return json({
        data: {
          issue: {
            labels: { nodes: verifyLabels.map(({ name }) => ({ name })) },
            delegate: delegateId ? { id: delegateId } : null,
            state: { id: nativeStateId },
          },
        },
      });
    }

    return json({
      data: {
        commentCreate: { success: true, comment: { id: "c-1", createdAt: "2026-08-02T00:00:00Z", url: "u" } },
        issueUpdate: { success: true },
      },
    });
  }) as typeof globalThis.fetch;
}

function proxyTriggerMutation() {
  return {
    operationName: "CloseTask",
    query: `mutation CloseTask($id: String!) { issueUpdate(id: $id, input: {}) { success } }`,
    variables: { id: ISSUE_UUID },
  };
}

describe("INF-792 wf:task re-seat/reopen/unmerged close guard", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  const originalEnv: Record<string, string | undefined> = {};
  let appState: ReturnType<typeof createApp> | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-792-"));
    originalFetch = globalThis.fetch;
    for (const key of ["AGENTS_FILE", "CAPABILITY_POLICY_PATH", "WORKFLOW_DEF_PATH", "WORKFLOW_DEFS_DIR"]) {
      originalEnv[key] = process.env[key];
    }
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.WORKFLOW_DEFS_DIR = writeDefs(dir);
    delete process.env.WORKFLOW_DEF_PATH;
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
    resetWorkflowCache();
    resetPolicyCache();
    _resetAppliedStateStore();
    resetConfigHealth();
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState?.bag.close();
    appState?.sessionTracker.close();
    appState?.agentQueue.close();
    appState?.operationalEventStore.close();
    appState?.mutationAuditStore.close();
    appState?.watchdog.stop();
    appState?.noActivityDetector.stop();
    appState?.managingPoller.stop();
    appState = null;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetWorkflowCache();
    resetPolicyCache();
    _resetAppliedStateStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC2: NULL-DELEGATE wf:task re-seat is same-state, non-terminal, and restores delegate", async () => {
    const writes: Array<Record<string, unknown>> = [];
    globalThis.fetch = makeLinearFetch({
      workflow: "task",
      state: "doing",
      delegateId: null,
      atomicWrites: writes,
    });

    const result = await setStateAtomic("INF-792", "doing", undefined, TOK);

    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      delegateId: LINEAR_IGOR_ID,
      stateId: "native-doing",
    });
    expect(writes[0].stateId).not.toBe("native-done");
  });

  it("AC3: escape reopens terminal wf:task and dev-impl tickets to non-terminal intake", async () => {
    for (const workflow of ["task", "dev-impl"] as const) {
      const writes: Array<Record<string, unknown>> = [];
      globalThis.fetch = makeLinearFetch({
        workflow,
        state: "done",
        delegateId: LINEAR_AI_ID,
        atomicWrites: writes,
      });

      const result = await applyStateTransition("escape", `INF-792-${workflow}`, TOK, { bodyId: "ai" });

      expect(result).toMatchObject({ status: "applied", to: "intake" });
      expect(writes[0]).toMatchObject({
        labelIds: expect.arrayContaining(["state-intake"]),
        stateId: "native-todo",
      });
      expect(writes[0].labelIds).not.toContain("state-done");
    }
  });

  it("AC4: wf:task To Do/sign-off -> Done is refused when an attached PR is open and unmerged", async () => {
    globalThis.fetch = makeLinearFetch({
      workflow: "task",
      state: "sign-off",
      delegateId: LINEAR_AI_ID,
      prCase: "open",
    });

    const blocked = await checkWorkflowRules("accept", "INF-792", TOK, "ai", null, LINEAR_AI_ID);

    expect(blocked).toMatch(/unmerged|not.*ancestor|pull request not yet merged/i);
  });

  it.each([
    ["merged PR evidence", "merged"],
    ["no PR evidence", "none"],
  ] as const)("AC4: wf:task terminal close is permitted with %s", async (_label, prCase) => {
    globalThis.fetch = makeLinearFetch({
      workflow: "task",
      state: "sign-off",
      delegateId: LINEAR_AI_ID,
      prCase,
    });

    const blocked = await checkWorkflowRules("accept", "INF-792", TOK, "ai", null, LINEAR_AI_ID);

    expect(blocked).toBeNull();
  });

  it("AC5: production /proxy/graphql path invokes the wf:task unmerged-work close guard", async () => {
    globalThis.fetch = makeLinearFetch({
      workflow: "task",
      state: "sign-off",
      delegateId: LINEAR_AI_ID,
      prCase: "open",
    });
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      mutationAuditDbPath: path.join(dir, "audit.db"),
    });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-ai")
      .set("X-Openclaw-Agent", "ai")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.6")
      .set("X-Openclaw-Linear-Intent", "accept")
      .send(proxyTriggerMutation());

    expect(res.status).toBe(403);
    expect(res.body?.errors?.[0]?.message).toMatch(/unmerged|not.*ancestor|pull request not yet merged/i);
  });
});
