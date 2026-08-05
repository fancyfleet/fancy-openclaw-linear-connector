/**
 * INF-826 — plain delegation must not force steward-held work into the entry
 * phase's worker/implementer role.
 *
 * INF-1237: autoEnrollPlainDelegation now resolves its target workflow from
 * enrollment-policy.ts (default wf:chore, entry_state intake, owner_role
 * steward) instead of a hardcoded wf:task/state:doing pair, so the role gate
 * this test guards is checked against chore:intake's owner_role ("steward"),
 * not a hardcoded "worker".
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

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");

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
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    savedEnv.WORKFLOW_DEFS_DIR = process.env.WORKFLOW_DEFS_DIR;
    savedEnv.WORKFLOW_DEF_DIR = process.env.WORKFLOW_DEF_DIR;
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    delete process.env.WORKFLOW_DEF_DIR;
    resetWorkflowCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedEnv.WORKFLOW_DEFS_DIR === undefined) delete process.env.WORKFLOW_DEFS_DIR;
    else process.env.WORKFLOW_DEFS_DIR = savedEnv.WORKFLOW_DEFS_DIR;
    if (savedEnv.WORKFLOW_DEF_DIR === undefined) delete process.env.WORKFLOW_DEF_DIR;
    else process.env.WORKFLOW_DEF_DIR = savedEnv.WORKFLOW_DEF_DIR;
    resetWorkflowCache();
  });

  it("does not stamp wf:chore/state:intake when a delegated plain ticket is held by a non-steward body", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = makePlainDelegationFetch(calls);
    mockResolveBodiesForRole.mockResolvedValue(["astrid"]);

    const result = await autoEnrollPlainDelegation("DSN-14", "Bearer token", undefined, undefined, "felix");

    expect(result.enrolled).toBe(false);
    expect(calls).toEqual([]);
    expect(mockResolveBodiesForRole).toHaveBeenCalledWith("steward", undefined);
  });

  it("still promotes a plain delegated ticket into chore:intake when the delegate is a steward", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = makePlainDelegationFetch(calls);
    mockResolveBodiesForRole.mockResolvedValue(["astrid"]);

    const result = await autoEnrollPlainDelegation("DSN-15", "Bearer token", undefined, undefined, "astrid");

    expect(result).toEqual({ enrolled: true, entryState: "intake", workflowId: "chore" });
    const mutation = calls.find((call) => call.query.includes("issueUpdate"));
    expect(mutation?.variables).toMatchObject({
      issueId: "issue-dsn-14",
      labelIds: expect.arrayContaining(["label-wf-chore", "label-state-intake"]),
    });
  });
});
