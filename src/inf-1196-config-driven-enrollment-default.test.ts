/**
 * INF-1196 — config-drive default enrollment policy.
 *
 * AC3 is proven behaviorally by the config-flip tests below: if the enrollment
 * path still hardcodes task -> chore, the ui-audit flip cannot pass. Keep this
 * as behavior, not a brittle source-grep assertion.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { validateFanoutSpec } from "./fanout.js";
import type { FanoutConfig } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { applyBootstrapToIssue, type BootstrapResult, type IssueContext } from "./workflow-bootstrap.js";
import { loadWorkflowRegistry, resetNativeStateCache, resetWorkflowCache } from "./workflow-gate.js";

type EnrollmentPolicyModule = {
  loadEnrollmentPolicy(pathOverride?: string): Promise<{
    deprecatedWorkflowIds: string[];
    defaultEnrollmentWorkflow: string;
  }>;
  resetEnrollmentPolicyCache(): void;
};

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: requester
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition]

roles:
  - id: requester
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
  - id: test-author
    requires: [linear:transition]
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
  - id: deployment
    requires: [linear:transition]
  - id: host-deploy
    requires: [linear:transition]

bodies:
  - id: ai
    container: requester
    fills_roles: [requester]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: tdd
    container: dev
    fills_roles: [test-author]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: code-review
    fills_roles: [code-review]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: deployment
    fills_roles: [host-deploy]
`;

const AGENTS_JSON = JSON.stringify({
  agents: [
    { name: "ai", linearUserId: "lin-ai" },
    { name: "astrid", linearUserId: "lin-astrid" },
    { name: "tdd", linearUserId: "lin-tdd" },
    { name: "igor", linearUserId: "lin-igor" },
    { name: "charles", linearUserId: "lin-charles" },
    { name: "hanzo", linearUserId: "lin-hanzo" },
    { name: "grover", linearUserId: "lin-grover" },
  ],
});

const TEAM_ID = "team-inf-1196";
const WF_TASK_LABEL_ID = "label-wf-task";
const WF_CHORE_LABEL_ID = "label-wf-chore";
const WF_UI_AUDIT_LABEL_ID = "label-wf-ui-audit";
const WF_DEV_IMPL_LABEL_ID = "label-wf-dev-impl";
const STATE_INTAKE_LABEL_ID = "label-state-intake";

let tmpDir: string;
let savedFetch: typeof globalThis.fetch;
let capturedLabelIds: string[];
let capturedBodies: string[];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1196-enrollment-policy-"));
  for (const key of ["WORKFLOW_DEFS_DIR", "CAPABILITY_POLICY_PATH", "AGENTS_PATH", "ENROLLMENT_POLICY_PATH"]) {
    savedEnv[key] = process.env[key];
  }

  fs.writeFileSync(path.join(tmpDir, "capability-policy.yaml"), POLICY_YAML, "utf8");
  fs.writeFileSync(path.join(tmpDir, "agents.json"), AGENTS_JSON, "utf8");
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
  process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "capability-policy.yaml");
  process.env.AGENTS_PATH = path.join(tmpDir, "agents.json");
  reloadAgents();
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  savedFetch = globalThis.fetch;
  capturedLabelIds = [];
  capturedBodies = [];
  installBootstrapFetch();
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  delete process.env.ENROLLMENT_POLICY_PATH;

  try {
    const { resetEnrollmentPolicyCache } = await import("./enrollment-policy.js") as EnrollmentPolicyModule;
    resetEnrollmentPolicyCache();
  } catch {
    // Current main has no enrollment-policy module yet; the red tests assert
    // that missing module explicitly when they configure the policy.
  }
});

async function writeEnrollmentPolicy(defaultWorkflow: string): Promise<void> {
  const policyPath = path.join(tmpDir, "enrollment-policy.yaml");
  fs.writeFileSync(
    policyPath,
    [
      "deprecated_workflow_ids:",
      "  - task",
      `default_enrollment_workflow: ${defaultWorkflow}`,
      "",
    ].join("\n"),
    "utf8",
  );
  process.env.ENROLLMENT_POLICY_PATH = policyPath;

  const { loadEnrollmentPolicy, resetEnrollmentPolicyCache } = await import("./enrollment-policy.js") as EnrollmentPolicyModule;
  resetEnrollmentPolicyCache();
  const loaded = await loadEnrollmentPolicy();
  expect(loaded.deprecatedWorkflowIds).toEqual(["task"]);
  expect(loaded.defaultEnrollmentWorkflow).toBe(defaultWorkflow);
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

function installBootstrapFetch(): void {
  const labels = [
    { id: WF_TASK_LABEL_ID, name: "wf:task" },
    { id: WF_CHORE_LABEL_ID, name: "wf:chore" },
    { id: WF_UI_AUDIT_LABEL_ID, name: "wf:ui-audit" },
    { id: WF_DEV_IMPL_LABEL_ID, name: "wf:dev-impl" },
    { id: STATE_INTAKE_LABEL_ID, name: "state:intake" },
  ];

  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    capturedBodies.push(body);

    if (body.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } });
    }
    if (body.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: labels } } } });
    }
    if (body.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "native-todo", name: "Todo", type: "unstarted" },
                { id: "native-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }
    if (body.includes("ApplyAtomicTransition") || body.includes("issueUpdate")) {
      const parsed = JSON.parse(body) as { variables?: { labelIds?: string[] } };
      capturedLabelIds = parsed.variables?.labelIds ?? [];
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (body.includes("IssueBranchAndPR")) {
      return json({ data: { issue: { attachments: { nodes: [] } } } });
    }
    if (body.includes("IssueContext")) {
      return json({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:task" }] },
            delegate: { id: "lin-ai" },
          },
        },
      });
    }
    return json({ data: {} });
  }) as typeof globalThis.fetch;
}

function makeTaskIssue(opts: { title?: string; description?: string | null } = {}): IssueContext {
  return {
    id: "issue-inf-1196",
    identifier: "INF-1196-T",
    teamId: TEAM_ID,
    title: opts.title ?? "Cross-functional request",
    description: opts.description ?? "Coordinate a non-code operational request.",
    labels: [{ id: WF_TASK_LABEL_ID, name: "wf:task" }],
    creatorId: "lin-ai",
  };
}

function expectBootstrappedTo(result: BootstrapResult | null, workflowId: string, workflowLabelId: string): void {
  expect(result).toMatchObject({
    action: "bootstrapped",
    workflowId,
    entryState: "intake",
  });
  expect(capturedLabelIds).toContain(workflowLabelId);
  expect(capturedLabelIds).toContain(STATE_INTAKE_LABEL_ID);
  expect(capturedLabelIds).not.toContain(WF_TASK_LABEL_ID);
}

describe("INF-1196 config-driven default enrollment policy", () => {
  it("AC1: hand-filed cross-functional wf:task enrollment redirects to the configured default wf:chore", async () => {
    await writeEnrollmentPolicy("chore");

    const result = await applyBootstrapToIssue(makeTaskIssue(), "Bearer test-token");

    expectBootstrappedTo(result, "chore", WF_CHORE_LABEL_ID);
  });

  it("AC2/AC3: flipping only enrollment-policy.yaml changes the default redirect target", async () => {
    await writeEnrollmentPolicy("ui-audit");

    const result = await applyBootstrapToIssue(makeTaskIssue(), "Bearer test-token");

    expectBootstrappedTo(result, "ui-audit", WF_UI_AUDIT_LABEL_ID);
  });

  it("AC2: resetEnrollmentPolicyCache keeps back-to-back config flips from using stale policy", async () => {
    await writeEnrollmentPolicy("chore");
    await writeEnrollmentPolicy("ui-audit");

    const result = await applyBootstrapToIssue(makeTaskIssue(), "Bearer test-token");

    expectBootstrappedTo(result, "ui-audit", WF_UI_AUDIT_LABEL_ID);
  });

  it("AC4: workflow-bootstrap and fanout derive deprecated/default workflow policy from the same config file", async () => {
    await writeEnrollmentPolicy("ui-audit");

    const bootstrapResult = await applyBootstrapToIssue(makeTaskIssue(), "Bearer test-token");
    expectBootstrappedTo(bootstrapResult, "ui-audit", WF_UI_AUDIT_LABEL_ID);

    const registry = await loadWorkflowRegistry();
    const registeredWorkflows = new Set([...registry.keys(), ...[...registry.keys()].map((id) => `wf:${id}`)]);
    const config = { spec_source: "findings", child_workflow: "wf:dev-impl" } as FanoutConfig;
    const result = await validateFanoutSpec(
      [
        "## Findings",
        "",
        "- **Operational cleanup** [wf:task -> astrid]",
        "  classification: declared-standalone",
        "  Move the non-code followup onto the configured default track.",
      ].join("\n"),
      config,
      registeredWorkflows,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/wf:task/);
      expect(result.reason).toMatch(/wf:ui-audit|ui-audit/);
      expect(result.reason).not.toMatch(/wf:chore|chore/);
    }
  });

  it("AC6: code-signaled wf:task intake still routes to dev-impl before the configured default redirect", async () => {
    await writeEnrollmentPolicy("chore");

    const result = await applyBootstrapToIssue(
      makeTaskIssue({
        title: "Fix connector bootstrap",
        description: "diff --git a/src/workflow-bootstrap.ts b/src/workflow-bootstrap.ts\n+load enrollment policy",
      }),
      "Bearer test-token",
    );

    expectBootstrappedTo(result, "dev-impl", WF_DEV_IMPL_LABEL_ID);
    expect(capturedLabelIds).not.toContain(WF_CHORE_LABEL_ID);
  });
});
