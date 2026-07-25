/**
 * INF-634 release-1.4 backport regression coverage.
 *
 * AC mapping:
 * - If fanout preflight attempts child creation and Linear creates zero
 *   children, the parent transition must not advance.
 * - The failed transition reports `fanout-create-failed` and preserves the
 *   Linear refusal text for an invalid child title / zero-created regression.
 * - `attempted=0` is a legitimate fanout no-op, not a failed fanout attempt.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";

type GqlCall = { query: string; variables: Record<string, unknown> };

const VALID_CHILD_TITLE = "🔧 Connector Cycle 14 — Fanout Create Refusal";
const VALID_CHILD_DETAIL = "Preserve the Linear refusal while holding the parent.";
const LINEAR_REFUSAL = "Linear refused issueCreate: title contains invalid child-title characters";

function json(data: unknown, extra?: { errors?: Array<{ message: string }> }): Response {
  return new Response(JSON.stringify({ data, ...extra }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deriveFindingId(title: string, description?: string): string {
  const material = `${title}\n${description ?? ""}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "entry";
  return `${slug}-${hex}`;
}

const PARENT_WORKFLOW_YAML = `
id: inf-634-parent
version: 1
entry_state: spawning
states:
  - id: spawning
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: findings
      child_workflow: wf:dev-sprint
    transitions:
      - { command: spawn, to: managing }
  - id: managing
    owner_role: engine
    native_state: doing
    barrier: true
    transitions:
      - { command: complete, to: done }
  - id: done
    kind: terminal
    native_state: done
`;

const CHILD_WORKFLOW_YAML = `
id: dev-sprint
version: 1
entry_state: todo
states:
  - id: todo
    owner_role: engine
    native_state: todo
    transitions:
      - { command: start, to: doing }
  - id: doing
    owner_role: engine
    native_state: doing
    transitions:
      - { command: complete, to: done }
  - id: done
    kind: terminal
    native_state: done
`;

const CAPABILITY_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: engine
    grants: [linear:transition]
roles:
  - id: engine
    requires: [linear:transition]
bodies:
  - id: engine-1
    container: engine
    fills_roles: [engine]
`;

function findingsDescription(title = VALID_CHILD_TITLE, detail = VALID_CHILD_DETAIL): string {
  return `## Findings\n\n- **${title}**: ${detail}\n`;
}

function makeFetch(
  record: GqlCall[],
  options?: {
    existingChildAlreadyMatches?: boolean;
    failChildCreate?: boolean;
  },
): typeof globalThis.fetch {
  const parentLabels = [
    { id: "label-parent-wf", name: "wf:inf-634-parent" },
    { id: "label-state-spawning", name: "state:spawning" },
  ];
  const parentDescription = findingsDescription();

  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = parsed.query ?? "";
    record.push({ query, variables: parsed.variables ?? {} });

    if (query.includes("IssueWithLabels")) {
      return json({
        issue: {
          id: "parent-internal-id",
          identifier: "INF-634",
          team: { id: "team-uuid" },
          labels: { nodes: parentLabels },
          delegate: null,
          assignee: null,
          state: { id: "native-doing" },
        },
      });
    }
    if (query.includes("IssueWithComments")) {
      return json({
        issue: {
          id: "parent-internal-id",
          description: parentDescription,
          comments: { nodes: [] },
        },
      });
    }
    if (query.includes("TeamStates")) {
      return json({
        team: {
          states: {
            nodes: [
              { id: "native-todo", name: "Todo", type: "unstarted" },
              { id: "native-doing", name: "Doing", type: "started" },
              { id: "native-done", name: "Done", type: "completed" },
            ],
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return json({
        team: {
          labels: {
            nodes: [
              { id: "label-parent-wf", name: "wf:inf-634-parent" },
              { id: "label-child-wf", name: "wf:dev-sprint" },
              { id: "label-state-spawning", name: "state:spawning" },
              { id: "label-state-managing", name: "state:managing" },
              { id: "label-state-todo", name: "state:todo" },
            ],
          },
        },
      });
    }
    if (query.includes("issueLabelCreate") && !query.includes("issueCreate")) {
      const name = String(parsed.variables.name ?? "unknown");
      return json({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return json({ issueUpdate: { success: true } });
    }
    if (query.includes("VerifyTransitionWrite")) {
      return json({
        issue: {
          labels: {
            nodes: [
              { name: "wf:inf-634-parent" },
              { name: "state:managing" },
            ],
          },
          state: { id: "native-doing", name: "Doing" },
          delegate: { id: "engine-linear-id" },
          assignee: null,
        },
      });
    }
    if (query.includes("VerifyIssueLabels")) {
      return json({
        issue: {
          labels: {
            nodes: [
              { id: "label-parent-wf", name: "wf:inf-634-parent" },
              { id: "label-state-managing", name: "state:managing" },
            ],
          },
          state: { id: "native-doing", name: "Doing" },
          assignee: null,
        },
      });
    }
    if (query.includes("IssueTeamParent")) {
      return json({
        issue: {
          id: "parent-internal-id",
          title: "INF-634 parent",
          description: parentDescription,
          team: { id: "team-uuid" },
          parent: null,
        },
      });
    }
    if (query.includes("IssueParent") && !query.includes("IssueTeamParent")) {
      return json({ issue: { parent: null } });
    }
    if (query.includes("FanoutChildren")) {
      const existing = options?.existingChildAlreadyMatches
        ? [{
            identifier: "INF-633",
            title: VALID_CHILD_TITLE,
            description:
              `Parent: INF-634\n${VALID_CHILD_DETAIL}\n` +
              `<!-- ai-1994:spec-entry-id: ${deriveFindingId(VALID_CHILD_TITLE, VALID_CHILD_DETAIL)} -->\n` +
              "<!-- inf-32:child-workflow: wf:dev-sprint -->",
            state: { name: "Todo" },
            labels: { nodes: [{ name: "wf:dev-sprint" }, { name: "state:todo" }] },
          }]
        : [];
      return json({ issue: { children: { nodes: existing } } });
    }
    if (query.includes("ParentChildren")) {
      const existing = options?.existingChildAlreadyMatches
        ? [{
            identifier: "INF-633",
            state: { id: "native-todo", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ name: "wf:dev-sprint" }, { name: "state:todo" }] },
          }]
        : [];
      return json({ issue: { children: { nodes: existing } } });
    }
    if (query.includes("issue(id: $id) { id }")) {
      return json({ issue: { id: "parent-internal-id" } });
    }
    if (query.includes("issueCreate")) {
      if (options?.failChildCreate) {
        return json(
          { issueCreate: { success: false, issue: null } },
          { errors: [{ message: LINEAR_REFUSAL }] },
        );
      }
      return json({
        issueCreate: {
          success: true,
          issue: { id: "child-internal-id", identifier: "INF-635" },
        },
      });
    }
    if (query.includes("commentCreate")) {
      return json({ commentCreate: { success: true, comment: { id: "comment-id" } } });
    }

    throw new Error(`unexpected query: ${query.slice(0, 120)}`);
  };
}

describe("INF-634 release-1.4 fanout-create-failed preflight", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalDefsDir: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;
  let originalDataDir: string | undefined;

  beforeAll(() => {
    originalDefsDir = process.env.WORKFLOW_DEFS_DIR;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;
    originalDataDir = process.env.DATA_DIR;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-634-workflow-"));
    const defsDir = path.join(dir, "defs");
    fs.mkdirSync(defsDir);
    fs.writeFileSync(path.join(defsDir, "inf-634-parent.yaml"), PARENT_WORKFLOW_YAML, "utf8");
    fs.writeFileSync(path.join(defsDir, "dev-sprint.yaml"), CHILD_WORKFLOW_YAML, "utf8");
    const policyPath = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyPath, CAPABILITY_POLICY_YAML, "utf8");
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          {
            name: "engine-1",
            linearUserId: "engine-linear-id",
            clientId: "engine-client",
            clientSecret: "engine-secret",
            accessToken: "engine-token",
            refreshToken: "engine-refresh",
          },
        ],
      }),
      "utf8",
    );

    process.env.WORKFLOW_DEFS_DIR = defsDir;
    process.env.CAPABILITY_POLICY_PATH = policyPath;
    process.env.AGENTS_FILE = agentsFile;
    process.env.DATA_DIR = path.join(dir, "data");
    reloadAgents();
  });

  afterAll(() => {
    if (originalDefsDir === undefined) delete process.env.WORKFLOW_DEFS_DIR;
    else process.env.WORKFLOW_DEFS_DIR = originalDefsDir;
    if (originalPolicyPath === undefined) delete process.env.CAPABILITY_POLICY_PATH;
    else process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    if (originalAgentsFile === undefined) delete process.env.AGENTS_FILE;
    else process.env.AGENTS_FILE = originalAgentsFile;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    reloadAgents();
    resetWorkflowCache();
    resetPolicyCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkflowCache();
    resetPolicyCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("AC: attempted child creation with zero created blocks parent advance and preserves Linear refusal text", async () => {
    const record: GqlCall[] = [];
    globalThis.fetch = makeFetch(record, { failChildCreate: true });

    const result = await applyStateTransition("spawn", "INF-634", "Bearer tok");

    expect(result).toMatchObject({
      status: "failed",
      code: "fanout-create-failed",
      from: "spawning",
      to: "managing",
    });
    expect(String(result.detail ?? "")).toContain(LINEAR_REFUSAL);
    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(true);
    expect(record.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
    expect(record.some((c) => c.query.includes("VerifyIssueLabels"))).toBe(false);
  });

  test("AC: attempted=0 no-op fanout is not reported as fanout-create-failed", async () => {
    const record: GqlCall[] = [];
    globalThis.fetch = makeFetch(record, { existingChildAlreadyMatches: true });

    const result = await applyStateTransition("spawn", "INF-634", "Bearer tok");

    expect(result).toMatchObject({
      status: "applied",
      from: "spawning",
      to: "managing",
    });
    expect(result.code).not.toBe("fanout-create-failed");
    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(false);
    expect(record.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(true);
  });
});
