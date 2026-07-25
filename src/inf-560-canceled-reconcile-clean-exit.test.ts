/**
 * INF-560 — Residual red tests only.
 *
 * Residual 1: the booted reconciliation sweep must heal stale Linear facets on
 * native-Canceled governed tickets without resurrecting them to Done.
 * Residual 2: governed `complete` becomes a clean terminal exit only when the
 * ticket's native Linear state is already terminal.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { registerBootstrapReconciliationCron } from "./bootstrap-reconciliation-sweep.js";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";

const ISSUE_ID = "issue-inf-560-uuid";
const ISSUE_IDENTIFIER = "INF-560";
const TEAM_ID = "team-inf-560";
const WF_LABEL = { id: "wf-lbl", name: "wf:dev-impl" };
const STALE_STATE_LABEL = { id: "implementation-lbl", name: "state:implementation" };
const COMPONENT_LABEL = { id: "component-lbl", name: "component:infra" };
const DELEGATE_ID = "u-astrid";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
  - id: workflow:steward

containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass, workflow:steward]

roles:
  - id: steward
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
    linearUserId: u-astrid
`;

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
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: ac-validate
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done
        generic: continue
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

type LinearCall = {
  query: string;
  variables: Record<string, unknown>;
};

let dir: string;
let originalFetch: typeof globalThis.fetch;
let originalCapabilityPolicyPath: string | undefined;
let originalWorkflowDefPath: string | undefined;
let originalAgentsFile: string | undefined;

function json(payload: object): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function writeConfig(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-560-"));
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
  process.env.AGENTS_FILE = path.join(dir, "agents.json");

  fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
  fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, WORKFLOW_YAML, "utf8");
  fs.writeFileSync(
    process.env.AGENTS_FILE,
    JSON.stringify({
      agents: [
        {
          name: "astrid",
          linearUserId: DELEGATE_ID,
          openclawAgent: "astrid",
          accessToken: "tok-astrid",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalCapabilityPolicyPath = process.env.CAPABILITY_POLICY_PATH;
  originalWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;
  originalAgentsFile = process.env.AGENTS_FILE;
  writeConfig();
  reloadAgents();
  resetWorkflowCache();
  resetPolicyCache();
  resetConfigHealth();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
  restoreEnv("CAPABILITY_POLICY_PATH", originalCapabilityPolicyPath);
  restoreEnv("WORKFLOW_DEF_PATH", originalWorkflowDefPath);
  restoreEnv("AGENTS_FILE", originalAgentsFile);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function makeReconciliationFetch(opts: {
  nativeState: { id: string; name: string; type: string };
  prMerged: boolean;
}): { fetch: typeof globalThis.fetch; calls: LinearCall[] } {
  const calls: LinearCall[] = [];

  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};
    calls.push({ query, variables });

    if (query.includes("BootstrapReconciliation")) {
      return json({
        data: {
          issues: {
            nodes: [
              {
                id: ISSUE_ID,
                identifier: ISSUE_IDENTIFIER,
                updatedAt: "2026-07-01T00:00:00.000Z",
                labels: { nodes: [WF_LABEL, STALE_STATE_LABEL, COMPONENT_LABEL] },
                delegate: { id: DELEGATE_ID },
                team: { id: TEAM_ID },
                title: "Canceled governed zombie",
              },
            ],
          },
        },
      });
    }

    if (query.includes("IssueContextSweep")) {
      return json({
        data: {
          issue: {
            id: ISSUE_ID,
            state: opts.nativeState,
            delegate: { id: DELEGATE_ID },
          },
        },
      });
    }

    if (query.includes("IssueBranchAndPR")) {
      return json({
        data: {
          issue: {
            attachments: {
              nodes: opts.prMerged
                ? [
                    {
                      url: "https://github.com/fancyfleet/fancy-openclaw-linear-connector/pull/498",
                      sourceType: "githubPullRequest",
                      metadata: { state: "merged" },
                    },
                  ]
                : [],
            },
          },
        },
      });
    }

    if (query.includes("IssueWithLabelsForClose")) {
      return json({
        data: {
          issue: {
            labels: { nodes: [WF_LABEL, STALE_STATE_LABEL, COMPONENT_LABEL] },
          },
        },
      });
    }

    if (query.includes("TeamCompletedState")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [{ id: "native-done-state", name: "Done", type: "completed", position: 3 }],
            },
          },
        },
      });
    }

    if (query.includes("issueUpdate")) {
      return json({ data: { issueUpdate: { success: true } } });
    }

    return json({ data: {} });
  };

  return { fetch: mockFetch, calls };
}

function issueUpdateCalls(calls: LinearCall[]): LinearCall[] {
  return calls.filter((call) => call.query.includes("issueUpdate"));
}

async function bootOneReconciliationTick(): Promise<NodeJS.Timeout> {
  const timer = registerBootstrapReconciliationCron({
    authToken: "Bearer tok-astrid",
    intervalMs: 100,
    wakeFn: async () => {},
  });
  await jest.advanceTimersByTimeAsync(100);
  await Promise.resolve();
  return timer;
}

describe("INF-560 Residual 1 — Canceled-path facet heal through booted reconcile sweep", () => {
  it("Residual 1: native Canceled + stale state label + pinned delegate heals facets without sending Done stateId", async () => {
    jest.useFakeTimers();
    const { fetch, calls } = makeReconciliationFetch({
      nativeState: { id: "native-canceled-state", name: "Canceled", type: "canceled" },
      prMerged: false,
    });
    globalThis.fetch = fetch;

    const timer = await bootOneReconciliationTick();
    clearInterval(timer);

    const mutations = issueUpdateCalls(calls);
    expect(mutations).toHaveLength(1);

    const mutation = mutations[0];
    expect(mutation.variables.issueId).toBe(ISSUE_ID);

    // Residual 1: heal stale Linear facets.
    expect(mutation.variables.labelIds).toEqual([COMPONENT_LABEL.id]);
    expect(mutation.query).toContain("delegateId: null");

    // Residual 1: the Canceled native terminal flavor must remain Canceled.
    expect(JSON.stringify(mutation.variables)).not.toContain("native-done-state");
    expect(JSON.stringify(mutation.variables)).not.toContain('"stateId"');
  });

  it("Residual 1 regression guard: existing native-Done reconcile path still strips labels and clears delegate", async () => {
    jest.useFakeTimers();
    const { fetch, calls } = makeReconciliationFetch({
      nativeState: { id: "native-done-state", name: "Done", type: "completed" },
      prMerged: true,
    });
    globalThis.fetch = fetch;

    const timer = await bootOneReconciliationTick();
    clearInterval(timer);

    const mutations = issueUpdateCalls(calls);
    expect(mutations).toHaveLength(1);
    expect(mutations[0].variables).toMatchObject({
      issueId: ISSUE_ID,
      labelIds: [COMPONENT_LABEL.id],
    });
    expect(mutations[0].query).toContain("delegateId: null");
    expect(JSON.stringify(mutations[0].variables)).not.toContain('"stateId"');
  });
});

function makeRuleFetch(nativeState: { id: string; name: string; type: string }): typeof globalThis.fetch {
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string };
    const query = parsed.query ?? "";

    if (query.includes("IssueContext")) {
      return json({
        data: {
          issue: {
            identifier: ISSUE_IDENTIFIER,
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
            delegate: null,
            assignee: null,
            state: nativeState,
          },
        },
      });
    }

    return json({ data: {} });
  };
}

describe("INF-560 Residual 2 — governed complete/sync clean-exit edge", () => {
  it("Residual 2: governed complete succeeds from a non-standard state when native Linear state is already terminal", async () => {
    globalThis.fetch = makeRuleFetch({ id: "native-canceled-state", name: "Canceled", type: "canceled" });

    const result = await checkWorkflowRules("complete", ISSUE_ID, "Bearer tok-astrid", "astrid");

    expect(result).toBeNull();
  });

  it("Residual 2: the same governed complete edge is not opened while native state is non-terminal", async () => {
    globalThis.fetch = makeRuleFetch({ id: "native-doing-state", name: "Doing", type: "started" });

    const result = await checkWorkflowRules("complete", ISSUE_ID, "Bearer tok-astrid", "astrid");

    expect(result).not.toBeNull();
    expect(result).toContain("complete");
  });
});
