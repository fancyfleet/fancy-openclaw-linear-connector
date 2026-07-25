/**
 * INF-570: Fan-out children born actionable must dispatch and track.
 *
 * AC mapping:
 * - AC1/AC2: synthetic parent fan-out mints an actionable synthetic child,
 *   dispatches it through the canonical wake contract, and records the dispatch
 *   in DispatchAckTracker for the watchdog.
 * - AC3: synthetic children born non-actionable or without a resolved owner do
 *   not emit a wake or ack expectation.
 * - AC4: reconciliation finds an existing governed actionable ticket with a
 *   delegate but no dispatch record, wakes and tracks it once, and stays
 *   idempotent on a later sweep.
 * - AC5: fixtures are workflow-agnostic and intentionally do not depend on
 *   live sprint workflow names or ticket identifiers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { executeFanout, type Finding } from "./fanout.js";
import { runBootstrapReconciliationSweep } from "./bootstrap-reconciliation-sweep.js";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import { resetWorkflowCache, type FanoutConfig, type WorkflowDef } from "./workflow-gate.js";
import { reloadAgents } from "./agents.js";

const TEAM_ID = "team-inf-570";
const PARENT_INTERNAL_ID = "parent-inf-570";
const CHILD_WORKFLOW_LABEL = "wf:synthetic-child";
const CHILD_ENTRY_STATE = "ready-for-owner";
const CHILD_DELEGATE_BODY = "synthetic-owner";
const CHILD_DELEGATE_LINEAR_ID = "linear-user-synthetic-owner";
const CHILD_WORKFLOW_LABEL_ID = "label-wf-synthetic-child";
const CHILD_ENTRY_STATE_LABEL_ID = "label-state-ready-for-owner";

const SYNTHETIC_PARENT_WORKFLOW: WorkflowDef = {
  id: "synthetic-parent",
  version: 1,
  entry_state: "planning",
  break_glass: { command: "escape", to: "escape", owner_role: "steward" },
  states: [
    {
      id: "planning",
      owner_role: "steward",
      fanout: {
        spec_source: "components",
        child_workflow: CHILD_WORKFLOW_LABEL,
        initial_delegate: CHILD_DELEGATE_BODY,
      },
      transitions: [{ command: "spawn-components", to: "managing" }],
    },
    { id: "managing", owner_role: "steward", barrier: true },
    { id: "done", kind: "terminal", native_state: "done" },
    { id: "escape", kind: "terminal", native_state: "invalid" },
  ],
};

const SYNTHETIC_ACTIONABLE_CHILD_WORKFLOW: WorkflowDef = {
  id: "synthetic-child",
  version: 1,
  entry_state: CHILD_ENTRY_STATE,
  break_glass: { command: "escape", to: "escape", owner_role: "steward" },
  states: [
    {
      id: CHILD_ENTRY_STATE,
      owner_role: "synthetic-owner-role",
      native_state: "thinking",
      transitions: [{ command: "complete", to: "done" }],
    },
    { id: "done", kind: "terminal", native_state: "done" },
    { id: "escape", kind: "terminal", native_state: "invalid" },
  ],
};

const SYNTHETIC_NON_ACTIONABLE_CHILD_WORKFLOW: WorkflowDef = {
  ...SYNTHETIC_ACTIONABLE_CHILD_WORKFLOW,
  entry_state: "queued",
  states: [
    { id: "queued", native_state: "backlog", transitions: [{ command: "activate", to: CHILD_ENTRY_STATE }] },
    ...SYNTHETIC_ACTIONABLE_CHILD_WORKFLOW.states,
  ],
};

const WORKFLOW_REGISTRY = new Map<string, WorkflowDef>([
  [SYNTHETIC_PARENT_WORKFLOW.id, SYNTHETIC_PARENT_WORKFLOW],
  [SYNTHETIC_ACTIONABLE_CHILD_WORKFLOW.id, SYNTHETIC_ACTIONABLE_CHILD_WORKFLOW],
]);

type IssueCreateInput = {
  teamId: string;
  title: string;
  description: string;
  parentId: string;
  labelIds: string[];
  delegateId?: string;
};

let tmpDir: string;
let savedFetch: typeof globalThis.fetch;
let savedAgentsFile: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-570-"));
  savedFetch = globalThis.fetch;
  savedAgentsFile = process.env.AGENTS_FILE;
  process.env.AGENTS_FILE = path.join(tmpDir, "agents.json");
  fs.writeFileSync(
    process.env.AGENTS_FILE,
    JSON.stringify({
      agents: [
        {
          name: CHILD_DELEGATE_BODY,
          displayName: "Synthetic Owner",
          linearUserId: CHILD_DELEGATE_LINEAR_ID,
          clientId: "client",
          clientSecret: "secret",
          accessToken: "token",
          refreshToken: "refresh",
        },
      ],
    }),
  );
  reloadAgents();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedAgentsFile === undefined) delete process.env.AGENTS_FILE;
  else process.env.AGENTS_FILE = savedAgentsFile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetWorkflowCache();
  jest.restoreAllMocks();
});

function makeAckTracker(name = "acks.db"): DispatchAckTracker {
  return new DispatchAckTracker(path.join(tmpDir, name));
}

function makeFanoutFetch(createdInputs: IssueCreateInput[]): typeof fetch {
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = body.query ?? "";

    if (query.includes("IssueTeamParent")) {
      return jsonResponse({
        data: {
          issue: {
            id: PARENT_INTERNAL_ID,
            title: "Synthetic parent",
            description: "## Components\n- **Synthetic actionable child**: born ready for owner\n",
            team: { id: TEAM_ID },
            parent: null,
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return jsonResponse({
        data: {
          team: {
            labels: {
              nodes: [
                { id: CHILD_WORKFLOW_LABEL_ID, name: CHILD_WORKFLOW_LABEL, team: { id: TEAM_ID } },
                { id: CHILD_ENTRY_STATE_LABEL_ID, name: `state:${CHILD_ENTRY_STATE}`, team: { id: TEAM_ID } },
                { id: "label-state-queued", name: "state:queued", team: { id: TEAM_ID } },
              ],
            },
          },
        },
      });
    }

    if (query.includes("issueCreate")) {
      const input = (body.variables?.input ?? {}) as IssueCreateInput;
      createdInputs.push(input);
      return jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: { id: "child-internal-1", identifier: "SYN-101" },
          },
        },
      });
    }

    if (query.includes("commentCreate")) {
      return jsonResponse({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    }

    if (query.includes("IssueParent")) {
      return jsonResponse({ data: { issue: { parent: null } } });
    }

    return jsonResponse({ data: {} });
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function executeSyntheticFanout(opts: {
  childWorkflow?: WorkflowDef;
  initialDelegate?: string;
  ackTracker: DispatchAckTracker;
  wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }>;
  createdInputs: IssueCreateInput[];
}) {
  const childWorkflow = opts.childWorkflow ?? SYNTHETIC_ACTIONABLE_CHILD_WORKFLOW;
  const workflowRegistry = new Map(WORKFLOW_REGISTRY);
  workflowRegistry.set(childWorkflow.id, childWorkflow);
  globalThis.fetch = makeFanoutFetch(opts.createdInputs);

  const config: FanoutConfig = {
    spec_source: "components",
    child_workflow: CHILD_WORKFLOW_LABEL,
    initial_delegate: opts.initialDelegate,
  };
  const findings: Finding[] = [{ title: "Synthetic actionable child", description: "born ready for owner" }];

  return executeFanout("SYN-PARENT", "Bearer test", config, {
    skipPreview: true,
    existingChildren: [],
    findingsOverride: findings,
    lookupEntryState: async () => `state:${childWorkflow.entry_state}`,
    workflowRegistry,
    dispatchAckTracker: opts.ackTracker,
    wakeFn: async (agentName: string, ticketIdentifier: string) => {
      opts.wakeDispatches.push({ agentName, ticketIdentifier });
    },
  } as unknown as Parameters<typeof executeFanout>[3]);
}

describe("INF-570 AC1/AC2: actionable fan-out children dispatch and enter ack tracking", () => {
  it("creates the synthetic child with workflow/state/delegate/parent facets, wakes the owner, and records the watchdog ack", async () => {
    const ackTracker = makeAckTracker();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const createdInputs: IssueCreateInput[] = [];

    const result = await executeSyntheticFanout({
      ackTracker,
      wakeDispatches,
      createdInputs,
      initialDelegate: CHILD_DELEGATE_BODY,
    });

    expect(result.created).toBe(1);
    expect(result.childIdentifiers).toEqual(["SYN-101"]);
    expect(createdInputs).toHaveLength(1);
    expect(createdInputs[0]).toMatchObject({
      teamId: TEAM_ID,
      title: "Synthetic actionable child",
      parentId: PARENT_INTERNAL_ID,
      delegateId: CHILD_DELEGATE_LINEAR_ID,
    });
    expect(createdInputs[0].labelIds).toEqual(
      expect.arrayContaining([CHILD_WORKFLOW_LABEL_ID, CHILD_ENTRY_STATE_LABEL_ID]),
    );

    expect(wakeDispatches).toEqual([{ agentName: CHILD_DELEGATE_BODY, ticketIdentifier: "SYN-101" }]);
    expect(ackTracker.getPendingTimedOut(0)).toEqual([
      expect.objectContaining({
        agentId: CHILD_DELEGATE_BODY,
        ticketId: "linear-SYN-101",
        ackStatus: "pending",
        attemptCount: 1,
      }),
    ]);
  });
});

describe("INF-570 AC3: non-actionable or unresolved-owner fan-out children stay quiet", () => {
  it("does not wake or track a child born into a non-actionable entry state", async () => {
    const ackTracker = makeAckTracker();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const createdInputs: IssueCreateInput[] = [];

    const result = await executeSyntheticFanout({
      ackTracker,
      wakeDispatches,
      createdInputs,
      childWorkflow: SYNTHETIC_NON_ACTIONABLE_CHILD_WORKFLOW,
      initialDelegate: CHILD_DELEGATE_BODY,
    });

    expect(result.created).toBe(1);
    expect(wakeDispatches).toEqual([]);
    expect(ackTracker.getPendingTimedOut(0)).toEqual([]);
  });

  it("does not wake or track a child whose configured owner cannot be resolved", async () => {
    const ackTracker = makeAckTracker();
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const createdInputs: IssueCreateInput[] = [];

    const result = await executeSyntheticFanout({
      ackTracker,
      wakeDispatches,
      createdInputs,
      initialDelegate: "unknown-body",
    });

    expect(result.created).toBe(1);
    expect(createdInputs[0].delegateId).toBeUndefined();
    expect(wakeDispatches).toEqual([]);
    expect(ackTracker.getPendingTimedOut(0)).toEqual([]);
  });
});

describe("INF-570 AC4: reconciliation dispatches already-actionable governed tickets missing ack records", () => {
  it("wakes and tracks once, then does not duplicate the dispatch on a subsequent sweep", async () => {
    const ackTracker = makeAckTracker("reconcile-acks.db");
    const wakeDispatches: Array<{ agentName: string; ticketIdentifier: string }> = [];
    const fetchFn = makeReconciliationFetch();
    const opts = {
      authToken: "Bearer test",
      workflowRegistry: new Map([[SYNTHETIC_ACTIONABLE_CHILD_WORKFLOW.id, SYNTHETIC_ACTIONABLE_CHILD_WORKFLOW]]),
      graceWindowMs: 0,
      nowMs: Date.now(),
      fetchFn,
      alertBus: { notify: jest.fn() },
      dispatchAckTracker: ackTracker,
      wakeFn: async (agentName: string, ticketIdentifier: string) => {
        wakeDispatches.push({ agentName, ticketIdentifier });
      },
    } as unknown as Parameters<typeof runBootstrapReconciliationSweep>[0];

    const first = await runBootstrapReconciliationSweep(opts);
    const second = await runBootstrapReconciliationSweep(opts);

    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(wakeDispatches).toEqual([{ agentName: CHILD_DELEGATE_BODY, ticketIdentifier: "SYN-202" }]);
    expect(ackTracker.getPendingTimedOut(0)).toEqual([
      expect.objectContaining({
        agentId: CHILD_DELEGATE_BODY,
        ticketId: "linear-SYN-202",
        ackStatus: "pending",
        attemptCount: 1,
      }),
    ]);
  });
});

function makeReconciliationFetch(): typeof fetch {
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(bodyText) as { query?: string };
    const query = body.query ?? "";

    if (query.includes("BootstrapReconciliation")) {
      return jsonResponse({
        data: {
          issues: {
            nodes: [
              {
                id: "issue-syn-202",
                identifier: "SYN-202",
                updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                labels: {
                  nodes: [
                    { id: CHILD_WORKFLOW_LABEL_ID, name: CHILD_WORKFLOW_LABEL },
                    { id: CHILD_ENTRY_STATE_LABEL_ID, name: `state:${CHILD_ENTRY_STATE}` },
                  ],
                },
                delegate: { id: CHILD_DELEGATE_LINEAR_ID },
                team: { id: TEAM_ID },
                title: "Existing actionable child",
              },
            ],
          },
        },
      });
    }

    if (query.includes("EnrolledTicketState")) {
      return jsonResponse({
        data: {
          issue: {
            state: { id: "native-started", name: "In Progress", type: "started" },
            delegate: { id: CHILD_DELEGATE_LINEAR_ID },
          },
        },
      });
    }

    return jsonResponse({ data: {} });
  };
}
