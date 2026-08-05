/**
 * INF-826 — plain delegation must not force steward-held task work into doing.
 *
 * INF-1243 (2026-08-05, Matt-confirmed): autoEnrollPlainDelegation is now a
 * permanent no-op — plain delegation never auto-enrolls a workflow for any
 * delegate, worker or steward. The second test below used to assert the
 * opposite (worker delegate ⇒ promoted into wf:chore); it is inverted here.
 */

import path from "node:path";
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const mockResolveBodiesForRole = jest.fn<(role: string) => Promise<string[]>>();
const mockRoleResolutionScopeForOwnerRole = jest.fn(() => undefined);

jest.unstable_mockModule("./escalation-gate.js", () => ({
  bodyHasCapability: jest.fn(),
  resolveBodiesForRole: mockResolveBodiesForRole,
  resolveBodiesWithCapability: jest.fn(),
  roleResolutionScopeForOwnerRole: mockRoleResolutionScopeForOwnerRole,
  isBodyKnown: jest.fn(),
  isRoleDeclared: jest.fn(),
  isSyntheticNoBodyRole: jest.fn(),
}));

const { autoEnrollPlainDelegation, resetWorkflowCache } = await import("./workflow-gate.js");

type FetchCall = { query: string; variables: Record<string, unknown> };

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makePlainDelegationFetch(calls: FetchCall[]): typeof globalThis.fetch {
  return async (_url, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as FetchCall;
    calls.push(payload);

    if (payload.query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: "issue-dsn-14",
            identifier: "DSN-14",
            team: { id: "team-dsn" },
            labels: { nodes: [{ id: "label-priority", name: "priority" }] },
            delegate: { id: "linear-delegate" },
            assignee: null,
            state: { id: "state-todo" },
          },
        },
      });
    }

    if (payload.query.includes("TeamLabels")) {
      return json({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "label-wf-task", name: "wf:task", isGroup: false, team: { id: "team-dsn" }, parent: null },
                { id: "label-state-doing", name: "state:doing", isGroup: false, team: { id: "team-dsn" }, parent: null },
                { id: "label-wf-chore", name: "wf:chore", isGroup: false, team: { id: "team-dsn" }, parent: null },
                { id: "label-state-intake", name: "state:intake", isGroup: false, team: { id: "team-dsn" }, parent: null },
              ],
            },
          },
        },
      });
    }

    if (payload.query.includes("issueUpdate")) {
      return json({ data: { issueUpdate: { success: true } } });
    }

    throw new Error(`Unexpected GraphQL query: ${payload.query}`);
  };
}

describe("INF-826: plain delegation task enrollment role guard", () => {
  const originalFetch = globalThis.fetch;
  let prevWorkflowDefPath: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    prevWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;
    // Harmless leftover from pre-INF-1243 setup — autoEnrollPlainDelegation
    // no longer reads the workflow registry at all, so this path is unused,
    // but left set for minimal diff against the original fixture setup.
    process.env.WORKFLOW_DEF_PATH = path.join(process.cwd(), "src", "registered-defs", "chore.yaml");
    resetWorkflowCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (prevWorkflowDefPath === undefined) delete process.env.WORKFLOW_DEF_PATH;
    else process.env.WORKFLOW_DEF_PATH = prevWorkflowDefPath;
    resetWorkflowCache();
  });

  it("does not stamp wf:task/state:doing when a delegated plain ticket is held by the steward", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = makePlainDelegationFetch(calls);
    mockResolveBodiesForRole.mockResolvedValue(["felix"]);

    const result = await autoEnrollPlainDelegation("DSN-14", "Bearer token", undefined, undefined, "astrid");

    expect(result.enrolled).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not promote a plain delegated ticket into any workflow, even when the delegate is a worker", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = makePlainDelegationFetch(calls);
    mockResolveBodiesForRole.mockResolvedValue(["felix"]);

    const result = await autoEnrollPlainDelegation("DSN-15", "Bearer token", undefined, undefined, "felix");

    expect(result).toEqual({ enrolled: false });
    expect(calls.find((call) => call.query.includes("issueUpdate"))).toBeUndefined();
  });
});
