/**
 * INF-594: routing lint for the INF-585 dead-end class.
 *
 * A connector **code-fix** routed through the `task` workflow has no path to a
 * real terminal state: `task` exposes intake → routing → doing → review →
 * sign-off but has **no merge-gate and no deploy stage**. A code fix therefore
 * reaches review-approved and dead-ends — no verb to engage merge (Hanzo) or
 * deploy, and sign-off (Done ≠ merged ≠ deployed) can never be satisfied from
 * inside `task`. Observed live on INF-585 (PR #512 approved, then merge+deploy
 * hand-orchestrated out-of-band).
 *
 * Fix (Astrid triage, candidate 1): an advisory routing lint at bootstrap —
 * when a ticket enters `task` carrying a PR/branch reference (the fingerprint
 * of a code change), post a single suggestion to re-route through `dev-impl`.
 * Advisory, not blocking.
 *
 * AC-to-test mapping:
 *   AC1: PR-URL-bearing ticket entering `task` → advisory comment posted
 *   AC2: "PR #512"-bearing ticket entering `task` → advisory comment posted
 *   AC3: branch-name-bearing ticket entering `task` → advisory comment posted
 *   AC4: clean (no PR/branch) `task` ticket → NO advisory comment
 *   AC5: PR-bearing ticket entering `dev-impl` → NO advisory (guard scoped to task)
 *   AC6: referencesCodeChange() unit coverage of each signal + negative
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  applyBootstrapToIssue,
  referencesCodeChange,
  type IssueContext,
} from "./workflow-bootstrap.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

// ── Minimal workflow defs ──────────────────────────────────────────────────

// `task`: non-code deliverable workflow — no merge-gate, no deploy state.
const TASK_YAML = `
id: task
version: 1
entry_state: doing
states:
  - id: doing
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: continue-workflow
        to: review
  - id: review
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: continue-workflow
        to: done
  - id: done
    kind: terminal
    native_state: done
`;

// `dev-impl`: the code workflow — used to prove the guard is task-scoped.
const DEV_IMPL_YAML = `
id: dev-impl
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: done
  - id: done
    kind: terminal
    native_state: done
`;

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: steward
    requires: [human:escalate]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

const AGENTS_JSON = JSON.stringify({
  agents: [
    {
      name: "astrid",
      linearUserId: "astrid-linear-id",
      clientId: "c1",
      clientSecret: "s1",
      accessToken: "tok-astrid",
      refreshToken: "r1",
      openclawAgent: "astrid",
    },
  ],
});

// ── Fixed IDs ──────────────────────────────────────────────────────────────

const ISSUE_INTERNAL_ID = "issue-internal-uuid-594";
const TEAM_ID = "team-uuid-inf";
const WF_TASK_LABEL_ID = "label-wf-task-id";
const WF_DEV_IMPL_LABEL_ID = "label-wf-dev-impl-id";
const STATE_DOING_LABEL_ID = "label-state-doing-id";
const STATE_INTAKE_LABEL_ID = "label-state-intake-id";
const CREATOR_USER_ID = "creator-linear-user-id";

// ── Fetch mock: captures every request body; answers the bootstrap calls ────

let capturedBodies: string[];

function installFetch(opts: { mutationSuccess?: boolean } = {}): void {
  const mutationSuccess = opts.mutationSuccess ?? true;
  const teamLabels = [
    { id: STATE_DOING_LABEL_ID, name: "state:doing" },
    { id: STATE_INTAKE_LABEL_ID, name: "state:intake" },
    { id: WF_TASK_LABEL_ID, name: "wf:task" },
    { id: WF_DEV_IMPL_LABEL_ID, name: "wf:dev-impl" },
  ];

  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    capturedBodies.push(body);

    // Comment mutation (the advisory)
    if (body.includes("commentCreate")) {
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c1" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Team labels lookup (findOrCreateLabel)
    if (body.includes("labels") && body.includes(TEAM_ID)) {
      return new Response(JSON.stringify({ data: { team: { labels: { nodes: teamLabels } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Atomic transition mutation
    if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
      return new Response(JSON.stringify({ data: { issueUpdate: { success: mutationSuccess } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function makeIssue(opts: {
  workflowLabelId: string;
  workflowLabelName: string;
  title?: string;
  description?: string | null;
}): IssueContext {
  return {
    id: ISSUE_INTERNAL_ID,
    teamId: TEAM_ID,
    identifier: "INF-585",
    title: opts.title ?? "Fix something",
    labels: [{ id: opts.workflowLabelId, name: opts.workflowLabelName }],
    description: opts.description ?? "",
    creatorId: CREATOR_USER_ID,
  };
}

/** The advisory comment body sent to Linear, if any. */
function advisoryComment(): string | undefined {
  const raw = capturedBodies.find((b) => b.includes("commentCreate"));
  return raw;
}

// ── Setup ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let savedFetch: typeof globalThis.fetch;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inf594-test-"));
  const defsDir = path.join(tmpDir, "defs");
  await fs.mkdir(defsDir);
  await fs.writeFile(path.join(defsDir, "task.yaml"), TASK_YAML);
  await fs.writeFile(path.join(defsDir, "dev-impl.yaml"), DEV_IMPL_YAML);
  const policyFile = path.join(tmpDir, "policy.yaml");
  await fs.writeFile(policyFile, POLICY_YAML);
  const agentsFile = path.join(tmpDir, "agents.json");
  await fs.writeFile(agentsFile, AGENTS_JSON);
  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.CAPABILITY_POLICY_PATH = policyFile;
  process.env.AGENTS_PATH = agentsFile;
});

afterAll(async () => {
  delete process.env.WORKFLOW_DEFS_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.AGENTS_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  savedFetch = globalThis.fetch;
  capturedBodies = [];
  resetWorkflowCache();
  resetPolicyCache();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

// ── AC1–AC3: PR/branch-bearing ticket into `task` → advisory posted ─────────

describe("INF-594 AC1–AC3: PR/branch-bearing ticket entering `task` gets the routing advisory", () => {
  it("AC1: a GitHub PR URL in the description triggers the advisory (INF-585 shape)", async () => {
    installFetch();
    const issue = makeIssue({
      workflowLabelId: WF_TASK_LABEL_ID,
      workflowLabelName: "wf:task",
      title: "Connector fix",
      description: "Approved fix on https://github.com/fancyfleet/fancy-openclaw-linear-connector/pull/512",
    });

    const result = await applyBootstrapToIssue(issue, "test-token");

    expect(result?.action).toBe("bootstrapped");
    expect(result?.workflowId).toBe("task");
    const comment = advisoryComment();
    expect(comment).toBeDefined();
    expect(comment).toContain("INF-594");
    expect(comment).toContain("dev-impl");
    expect(comment).toContain("INF-585");
  });

  it("AC2: a bare 'PR #512' mention triggers the advisory", async () => {
    installFetch();
    const issue = makeIssue({
      workflowLabelId: WF_TASK_LABEL_ID,
      workflowLabelName: "wf:task",
      description: "Approved fix on PR #512 — needs merge + deploy.",
    });

    await applyBootstrapToIssue(issue, "test-token");

    expect(advisoryComment()).toBeDefined();
  });

  it("AC3: a conventional branch name triggers the advisory", async () => {
    installFetch();
    const issue = makeIssue({
      workflowLabelId: WF_TASK_LABEL_ID,
      workflowLabelName: "wf:task",
      description: "Landed on feature/INF-585-null-guard; ready for review.",
    });

    await applyBootstrapToIssue(issue, "test-token");

    expect(advisoryComment()).toBeDefined();
  });
});

// ── AC4: clean `task` ticket → no advisory ──────────────────────────────────

describe("INF-594 AC4: a non-code `task` ticket is not nagged", () => {
  it("does NOT post the advisory when there is no PR/branch reference", async () => {
    installFetch();
    const issue = makeIssue({
      workflowLabelId: WF_TASK_LABEL_ID,
      workflowLabelName: "wf:task",
      title: "Write the Q3 marketing brief",
      description: "Draft positioning copy for the launch. No code involved.",
    });

    const result = await applyBootstrapToIssue(issue, "test-token");

    expect(result?.action).toBe("bootstrapped");
    expect(advisoryComment()).toBeUndefined();
  });
});

// ── AC5: guard is task-scoped ───────────────────────────────────────────────

describe("INF-594 AC5: the guard only fires for `task`, never for `dev-impl`", () => {
  it("does NOT post the advisory when a PR-bearing ticket enters dev-impl", async () => {
    installFetch();
    const issue = makeIssue({
      workflowLabelId: WF_DEV_IMPL_LABEL_ID,
      workflowLabelName: "wf:dev-impl",
      description: "Fix in https://github.com/fancyfleet/fancy-openclaw-linear-connector/pull/512",
    });

    const result = await applyBootstrapToIssue(issue, "test-token");

    expect(result?.workflowId).toBe("dev-impl");
    expect(advisoryComment()).toBeUndefined();
  });
});

// ── AC6: referencesCodeChange() unit coverage ───────────────────────────────

describe("INF-594 AC6: referencesCodeChange() detects code-change fingerprints", () => {
  it("true for a GitHub PR URL", () => {
    expect(
      referencesCodeChange("t", "see https://github.com/foo/bar/pull/7 for the fix"),
    ).toBe(true);
  });
  it("true for a 'PR #123' mention", () => {
    expect(referencesCodeChange("t", "approved on PR #123")).toBe(true);
  });
  it("true for a 'pull request' phrase", () => {
    expect(referencesCodeChange("t", "opened a pull request against main")).toBe(true);
  });
  it("true for a conventional branch name", () => {
    expect(referencesCodeChange("t", "on feature/INF-585-null-guard")).toBe(true);
  });
  it("true when the signal is in the title", () => {
    expect(referencesCodeChange("Fix on PR #9", "no body")).toBe(true);
  });
  it("false for plain non-code prose", () => {
    expect(
      referencesCodeChange("Write launch copy", "Draft positioning for Q3. No code involved."),
    ).toBe(false);
  });
  it("false for empty/absent text", () => {
    expect(referencesCodeChange(undefined, null)).toBe(false);
  });
});
