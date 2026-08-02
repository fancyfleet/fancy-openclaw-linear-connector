import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: workflow:break-glass
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
roles:
  - id: steward
    requires: [human:escalate]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

describe("INF-864: manual continue cannot bypass barrier predicates", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-864-"));
    const policyPath = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyPath, TEST_POLICY_YAML, "utf8");

    process.env.CAPABILITY_POLICY_PATH = policyPath;
    process.env.WORKFLOW_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.WORKFLOW_DEFS_DIR;
    delete process.env.CAPABILITY_POLICY_PATH;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
  });

  it("refuses continue-workflow from dev-sprint managing-arms while an arm child is non-terminal", async () => {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
      if (body.query?.includes("query IssueContext")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                identifier: "LIF-307",
                team: { id: "team-lif" },
                delegate: { id: "u-astrid" },
                labels: {
                  nodes: [
                    { name: "wf:dev-sprint" },
                    { name: "state:managing-arms" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (body.query?.includes("query ParentChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: [
                    {
                      identifier: "LIF-308",
                      labels: { nodes: [{ name: "wf:sprint-arm-scope" }, { name: "state:done" }] },
                    },
                    {
                      identifier: "LIF-310",
                      labels: { nodes: [{ name: "wf:sprint-arm-scope" }, { name: "state:review" }] },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const rejection = await checkWorkflowRules(
      "continue",
      "LIF-307",
      "Bearer tok",
      "astrid",
      null,
      "u-astrid",
      null,
      false,
      true,
    );

    expect(rejection).toContain("continue-workflow");
    expect(rejection).toContain("non-terminal child ticket");
    expect(rejection).toContain("LIF-310");
    expect(rejection).toContain("review");
  });
});
