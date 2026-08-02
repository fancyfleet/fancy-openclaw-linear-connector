/**
 * INF-862 — approved non-code `wf:task` deliverables must release without
 * being routed through the dev-impl PR-evidence merge/deploy path.
 *
 * These are red tests for the requested TDD write-tests state. They intentionally
 * assert the missing contract instead of implementing it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";

const TASK_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-task.yaml");
const DEV_IMPL_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
const TASK_RELEASE_DOC = path.resolve(process.cwd(), "config-templates/workflows/task/release.md");
const TOKEN = "Bearer test-token";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: deploy:execute
  - id: infra:ssh
  - id: workflow:break-glass

containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: host-deploy
    grants: [linear:transition, infra:ssh]
  - id: requester
    grants: [linear:transition]

roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: deployment
    requires: [deploy:execute]
  - id: host-deploy
    requires: [infra:ssh]
  - id: requester
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: host-deploy
    fills_roles: [host-deploy]
  - id: ai
    container: requester
    fills_roles: [requester]
  - id: matt
    container: requester
    fills_roles: [requester]
`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeDevImplNoEvidenceFetch(): typeof globalThis.fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { query?: string } : {};
    const query = body.query ?? "";

    if (query.includes("IssueContext")) {
      return jsonResponse({
        data: {
          issue: {
            identifier: "INF-850",
            labels: {
              nodes: [
                { name: "wf:dev-impl" },
                { name: "state:merge" },
                { name: "stakes:low" },
              ],
            },
            delegate: { id: "hanzo-linear-user" },
          },
        },
      });
    }

    if (query.includes("IssueBranchAndPR")) {
      return jsonResponse({
        data: {
          issue: {
            attachments: { nodes: [] },
          },
        },
      });
    }

    throw new Error(`unexpected Linear query in INF-862 fixture: ${query.slice(0, 80)}`);
  }) as unknown as typeof globalThis.fetch;
}

function loadYamlFile(file: string): Record<string, unknown> {
  return yaml.load(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("INF-862 non-code task release contract", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalPolicyPath: string | undefined;
  let originalDefPath: string | undefined;
  let originalDefsDir: string | undefined;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-862-"));
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");

    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalDefPath = process.env.WORKFLOW_DEF_PATH;
    originalDefsDir = process.env.WORKFLOW_DEFS_DIR;

    process.env.CAPABILITY_POLICY_PATH = policyFile;
    delete process.env.WORKFLOW_DEFS_DIR;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (originalPolicyPath === undefined) delete process.env.CAPABILITY_POLICY_PATH;
    else process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;

    if (originalDefPath === undefined) delete process.env.WORKFLOW_DEF_PATH;
    else process.env.WORKFLOW_DEF_PATH = originalDefPath;

    if (originalDefsDir === undefined) delete process.env.WORKFLOW_DEFS_DIR;
    else process.env.WORKFLOW_DEFS_DIR = originalDefsDir;
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkflowCache();
    resetPolicyCache();
  });

  it("AC1 identifies the exact code-release path when PR evidence blocks a non-code deliverable", async () => {
    process.env.WORKFLOW_DEF_PATH = DEV_IMPL_FIXTURE;
    globalThis.fetch = makeDevImplNoEvidenceFetch();

    const result = await checkWorkflowRules(
      "continue",
      "INF-850",
      TOKEN,
      "hanzo",
      null,
      "hanzo-linear-user",
    );

    expect(result).toContain("wf:dev-impl");
    expect(result).toContain("state:merge");
    expect(result).toMatch(/PR[- ]evidence|branch\/PR evidence/i);
    expect(result).toMatch(/non-code|wf:task|task release/i);
  });

  it("AC2 declares an approved non-code wf:task release path that bypasses GitHub PR evidence", () => {
    const def = loadYamlFile(TASK_FIXTURE);
    expect(def.release).toEqual(
      expect.objectContaining({
        kind: "non-code-task",
        approved_state: "sign-off",
        terminal_state: "done",
        requires_github_pr_evidence: false,
      }),
    );
  });

  it("AC3 documents the multi-body requester target rule for force-deploy/escape recovery", () => {
    expect(fs.existsSync(TASK_RELEASE_DOC)).toBe(true);
    const content = fs.readFileSync(TASK_RELEASE_DOC, "utf8");

    expect(content).toMatch(/force-deploy|escape/i);
    expect(content).toMatch(/requester/i);
    expect(content).toMatch(/matt/i);
    expect(content).toMatch(/\bai\b/i);
    expect(content).toMatch(/explicit target|target.*required|ambiguous/i);
  });

  it("AC4 documents intended non-code task release behavior for operators", () => {
    expect(fs.existsSync(TASK_RELEASE_DOC)).toBe(true);
    const content = fs.readFileSync(TASK_RELEASE_DOC, "utf8");

    expect(content).toMatch(/non-code/i);
    expect(content).toMatch(/wf:task/i);
    expect(content).toMatch(/sign-off/i);
    expect(content).toMatch(/linear continue-workflow/i);
    expect(content).toMatch(/done/i);
    expect(content).toMatch(/no .*pull request|no .*PR|without .*GitHub/i);
  });
});
