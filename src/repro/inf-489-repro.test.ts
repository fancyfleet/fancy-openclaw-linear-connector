
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyStateTransition,
  resetWorkflowCache,
} from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";

const CANONICAL_TASK_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-task.yaml");

const TASK_POLICY_YAML = `
capabilities:
  - id: linear:transition
roles:
  - id: requester
    requires: [linear:transition]
  - id: department-head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
bodies:
  - id: ai
    fills_roles: [requester]
  - id: astrid
    fills_roles: [department-head]
`;

const TOK = "Bearer test-token";
const ISSUE = "INF-489-REPRO";

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeTransitionFetch(opts: {
  issueLabels: Array<{ id: string; name: string }>;
  teamLabels: Array<{ id: string; name: string }>;
  nativeStateId: string;
}): { fetch: typeof globalThis.fetch; calls: any[] } {
  const calls: any[] = [];
  const mock = (async (_url: string, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText);
    calls.push({ body: parsed });
    const query = parsed.query ?? "";

    if (query.includes("IssueWithLabels")) {
      return jsonResponse({
        data: {
          issue: {
            id: "internal-uuid",
            identifier: ISSUE,
            team: { id: "team-uuid" },
            labels: { nodes: opts.issueLabels },
            state: { id: opts.nativeStateId, type: "unstarted" }
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return jsonResponse({ data: { team: { labels: { nodes: opts.teamLabels } } } });
    }
    if (query.includes("TeamStates")) {
      return jsonResponse({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-todo-uuid", name: "To Do", type: "unstarted" },
                { id: "state-done-uuid", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("UpdateDelegate")) {
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
    return jsonResponse({ data: {} });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: mock, calls };
}

describe("INF-489 Repro: same-column transition no-op", () => {
  let originalFetch: typeof globalThis.fetch;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf489-repro-"));
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TASK_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_TASK_FIXTURE;
  });

  afterAll(() => {
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("REPRO: approve from review to sign-off (both native todo) should swap labels", async () => {
    const { fetch: mock, calls } = makeTransitionFetch({
      issueLabels: [
        { id: "wf-lbl", name: "wf:task" },
        { id: "review-lbl", name: "state:review" },
      ],
      teamLabels: [
        { id: "review-lbl", name: "state:review" },
        { id: "signoff-lbl", name: "state:sign-off" }
      ],
      nativeStateId: "state-todo-uuid"
    });
    globalThis.fetch = mock;

    const result = await applyStateTransition("approve", ISSUE, TOK, {
      sourceStateOverride: "review",
      bodyId: "astrid"
    });

    expect(result.status).toBe("applied");
    
    const updateCall = calls.find((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));
    expect(updateCall).toBeDefined();
    const labelIds = updateCall.body.variables.labelIds;
    expect(labelIds).toContain("signoff-lbl");
    expect(labelIds).not.toContain("review-lbl");
  });
});
