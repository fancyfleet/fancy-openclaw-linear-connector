import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { applyStateTransition, resetNativeStateCache, resetWorkflowCache } from "./workflow-gate.js";
import { reloadAgents } from "./agents.js";

const TASK_WORKFLOW = `
id: task
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
      - command: request
        to: routing

  - id: routing
    owner_role: steward
    kind: normal
    native_state: todo
    transitions: []

  - id: done
    owner_role: requester
    kind: terminal
    native_state: done
    transitions: []
`;

function writeAgents(dir: string): string {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "ai", linearUserId: "u-ai", openclawAgent: "ai", accessToken: "tok-ai", host: "local" },
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
      ],
    }),
    "utf8",
  );
  return agentsFile;
}

describe("INF-849: break-glass repairs reopened wf:task tickets stranded at state:done", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalAgentsFile: string | undefined;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf849-"));
    const workflowFile = path.join(dir, "task.yaml");
    fs.writeFileSync(workflowFile, TASK_WORKFLOW, "utf8");

    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    process.env.AGENTS_FILE = writeAgents(dir);
    reloadAgents();
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalAgentsFile !== undefined) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
    reloadAgents();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkflowCache();
    resetNativeStateCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("swaps state:done to state:intake and delegates the requested target", async () => {
    let labels = [
      { id: "wf-task", name: "wf:task" },
      { id: "state-done", name: "state:done" },
    ];
    let delegateId: string | null = "u-astrid";
    let nativeStateId: string | null = "native-todo";
    const mutations: Array<Record<string, unknown>> = [];

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = body.query ?? "";

      if (query.includes("IssueWithLabels")) {
        return Response.json({
          data: {
            issue: {
              id: "issue-uuid",
              identifier: "INF-781",
              team: { id: "team-inf" },
              labels: { nodes: labels },
            },
          },
        });
      }

      if (query.includes("TeamLabels")) {
        return Response.json({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "wf-task", name: "wf:task", team: { id: "team-inf" } },
                  { id: "state-done", name: "state:done", team: { id: "team-inf" } },
                  { id: "state-intake", name: "state:intake", team: { id: "team-inf" } },
                ],
              },
            },
          },
        });
      }

      if (query.includes("TeamStates")) {
        return Response.json({
          data: {
            team: {
              states: {
                nodes: [{ id: "native-todo", name: "To Do", type: "unstarted" }],
              },
            },
          },
        });
      }

      if (query.includes("ApplyAtomicTransition")) {
        mutations.push(body.variables ?? {});
        const nextLabelIds = new Set((body.variables?.labelIds as string[]) ?? []);
        labels = [
          { id: "wf-task", name: "wf:task" },
          ...(nextLabelIds.has("state-intake") ? [{ id: "state-intake", name: "state:intake" }] : []),
          ...(nextLabelIds.has("state-done") ? [{ id: "state-done", name: "state:done" }] : []),
        ];
        delegateId = (body.variables?.delegateId as string | null | undefined) ?? delegateId;
        nativeStateId = (body.variables?.stateId as string | null | undefined) ?? nativeStateId;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }

      if (query.includes("VerifyTransitionWrite")) {
        return Response.json({
          data: {
            issue: {
              labels: { nodes: labels.map(({ name }) => ({ name })) },
              delegate: delegateId ? { id: delegateId } : null,
              state: nativeStateId ? { id: nativeStateId } : null,
            },
          },
        });
      }

      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await applyStateTransition("escape", "INF-781", "Bearer tok", {
      bodyId: "astrid",
      cliTarget: "ai",
    });

    expect(result).toMatchObject({
      status: "applied",
      from: "done",
      to: "intake",
    });
    expect(labels.map((l) => l.name)).toEqual(["wf:task", "state:intake"]);
    expect(delegateId).toBe("u-ai");
    expect(mutations[0]).toMatchObject({
      labelIds: ["wf-task", "state-intake"],
      delegateId: "u-ai",
      stateId: "native-todo",
    });
  });
});
