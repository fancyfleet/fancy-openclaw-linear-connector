/**
 * INF-1237 — autoEnrollPlainDelegation hardcoded wf:task/state:doing, the
 * third call site INF-1196 missed. This file drives the production function
 * against real workflow defs (src/registered-defs) and a real capability
 * policy (not mocked) to prove the fix end to end:
 *
 * AC1: a delegated plain ticket enrolls into wf:<defaultEnrollmentWorkflow>
 *      (currently wf:chore), never wf:task.
 * AC2: the stamped state label is the resolved def's entry_state, not a
 *      hardcoded "doing".
 * AC3: flipping default_enrollment_workflow in enrollment-policy.yaml changes
 *      this path too (single source, same as bootstrap/fanout).
 * AC4: no enrollment path mints wf:task as a default anymore.
 * AC5 (this file): regression coverage on the plain-delegation enrollment
 *      target, mirroring INF-1196's AC tests.
 *
 * Repo: fancy-openclaw-linear-connector
 * Branch: fix/INF-1237-plain-delegation-enrollment-policy
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { autoEnrollPlainDelegation, resetWorkflowCache, resetNativeStateCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");

const POLICY_YAML = `
capabilities:
  - id: linear:transition

containers:
  - id: steward
    grants: [linear:transition]
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: felix
    container: dev
    fills_roles: [worker]
`;

const TEAM_ID = "team-inf-1237";
const WF_TASK_LABEL_ID = "label-wf-task";
const WF_CHORE_LABEL_ID = "label-wf-chore";
const WF_UI_AUDIT_LABEL_ID = "label-wf-ui-audit";
const STATE_INTAKE_LABEL_ID = "label-state-intake";

let tmpDir: string;
let savedFetch: typeof globalThis.fetch;
let capturedLabelIds: string[];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1237-plain-delegation-"));
  for (const key of ["WORKFLOW_DEFS_DIR", "CAPABILITY_POLICY_PATH", "ENROLLMENT_POLICY_PATH"]) {
    savedEnv[key] = process.env[key];
  }
  fs.writeFileSync(path.join(tmpDir, "capability-policy.yaml"), POLICY_YAML, "utf8");
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
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetConfigHealth();
  savedFetch = globalThis.fetch;
  capturedLabelIds = [];
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  delete process.env.ENROLLMENT_POLICY_PATH;
  const { resetEnrollmentPolicyCache } = await import("./enrollment-policy.js");
  resetEnrollmentPolicyCache();
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
  const { loadEnrollmentPolicy, resetEnrollmentPolicyCache } = await import("./enrollment-policy.js");
  resetEnrollmentPolicyCache();
  const loaded = loadEnrollmentPolicy();
  expect(loaded.defaultEnrollmentWorkflow).toBe(defaultWorkflow);
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

function installPlainDelegationFetch(issueId: string, issueIdentifier: string): void {
  const labels = [
    { id: WF_TASK_LABEL_ID, name: "wf:task", isGroup: false, team: { id: TEAM_ID }, parent: null },
    { id: WF_CHORE_LABEL_ID, name: "wf:chore", isGroup: false, team: { id: TEAM_ID }, parent: null },
    { id: WF_UI_AUDIT_LABEL_ID, name: "wf:ui-audit", isGroup: false, team: { id: TEAM_ID }, parent: null },
    { id: STATE_INTAKE_LABEL_ID, name: "state:intake", isGroup: false, team: { id: TEAM_ID }, parent: null },
  ];

  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";

    if (body.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: issueId,
            identifier: issueIdentifier,
            team: { id: TEAM_ID },
            labels: { nodes: [] },
            delegate: { id: "lin-delegate" },
            assignee: null,
            state: { id: "state-todo" },
          },
        },
      });
    }
    if (body.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: labels } } } });
    }
    if (body.includes("issueUpdate")) {
      const parsed = JSON.parse(body) as { variables?: { labelIds?: string[] } };
      capturedLabelIds = parsed.variables?.labelIds ?? [];
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: {} });
  }) as typeof globalThis.fetch;
}

describe("INF-1237: autoEnrollPlainDelegation resolves workflow/state from enrollment policy", () => {
  it("AC1/AC2: a plain-delegated ticket enrolls into wf:<default>:<entry_state> — never wf:task/doing", async () => {
    await writeEnrollmentPolicy("chore");
    installPlainDelegationFetch("issue-1", "INF-1237-A");

    const result = await autoEnrollPlainDelegation("issue-1", "Bearer test-token", undefined, undefined, "astrid");

    expect(result).toEqual({ enrolled: true, workflowId: "chore", entryState: "intake" });
    expect(capturedLabelIds).toContain(WF_CHORE_LABEL_ID);
    expect(capturedLabelIds).toContain(STATE_INTAKE_LABEL_ID);
    expect(capturedLabelIds).not.toContain(WF_TASK_LABEL_ID);
  });

  it("AC3: flipping default_enrollment_workflow in enrollment-policy.yaml redirects this path too", async () => {
    await writeEnrollmentPolicy("ui-audit");
    installPlainDelegationFetch("issue-2", "INF-1237-B");

    const result = await autoEnrollPlainDelegation("issue-2", "Bearer test-token", undefined, undefined, "astrid");

    expect(result).toEqual({ enrolled: true, workflowId: "ui-audit", entryState: "intake" });
    expect(capturedLabelIds).toContain(WF_UI_AUDIT_LABEL_ID);
    expect(capturedLabelIds).not.toContain(WF_CHORE_LABEL_ID);
    expect(capturedLabelIds).not.toContain(WF_TASK_LABEL_ID);
  });

  it("AC3 (role guard follows the entry phase, not a hardcoded 'worker'): a worker-only delegate does not force chore:intake enrollment", async () => {
    await writeEnrollmentPolicy("chore");
    installPlainDelegationFetch("issue-3", "INF-1237-C");

    const result = await autoEnrollPlainDelegation("issue-3", "Bearer test-token", undefined, undefined, "felix");

    expect(result).toEqual({ enrolled: false });
    expect(capturedLabelIds).toEqual([]);
  });

  it("AC4: no default-enroll path mints wf:task — a missing/falls-back policy still resolves to wf:chore", async () => {
    // No enrollment-policy.yaml written: loadEnrollmentPolicy falls back to the
    // INF-1164 defaults (deprecated=[task], default=chore) per enrollment-policy.ts.
    const { resetEnrollmentPolicyCache } = await import("./enrollment-policy.js");
    resetEnrollmentPolicyCache();
    installPlainDelegationFetch("issue-4", "INF-1237-D");

    const result = await autoEnrollPlainDelegation("issue-4", "Bearer test-token", undefined, undefined, "astrid");

    expect(result.workflowId).toBe("chore");
    expect(result.workflowId).not.toBe("task");
    expect(capturedLabelIds).not.toContain(WF_TASK_LABEL_ID);
  });
});
