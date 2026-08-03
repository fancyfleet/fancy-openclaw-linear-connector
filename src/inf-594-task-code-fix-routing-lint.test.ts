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
 * Fix (Astrid triage, candidate 1) was an advisory routing lint at bootstrap —
 * a nudge suggesting `dev-impl` while still admitting the code fix to `task`.
 *
 * SUPERSEDED by INF-1023 (parent decision INF-1022, fix #2a): the advisory nudge
 * is replaced by a hard intake guardrail — a code-signaled `wf:task` request is
 * redirected to `dev-impl` at bootstrap instead of entering the Design track and
 * being nudged. This suite is updated to the redirect contract; the code-signal
 * detection (`referencesCodeChange`) that INF-594 introduced still lives on and
 * is exercised in AC6. Full redirect/refusal coverage lives in
 * `inf-1023-wf-task-code-guardrail.test.ts`.
 *
 * AC-to-test mapping (post-INF-1023):
 *   AC1: PR-URL-bearing ticket into `task` → redirected to `dev-impl`, no advisory
 *   AC2: "PR #512"-bearing ticket into `task` → redirected to `dev-impl`, no advisory
 *   AC3: branch-name-bearing ticket into `task` → redirected to `dev-impl`, no advisory
 *   AC4: clean (no code signal) `task` ticket → stays on `task`, NO redirect/comment
 *   AC5: PR-bearing ticket entering `dev-impl` directly → unchanged (guard is task-scoped)
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

// INF-1164: wf:chore is the replacement track for the deprecated wf:task. A
// non-code request that used to enroll at wf:task now redirects here.
const CHORE_YAML = `
id: chore
version: 1
entry_state: intake
states:
  - id: intake
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
const WF_CHORE_LABEL_ID = "label-wf-chore-id";
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
    { id: WF_CHORE_LABEL_ID, name: "wf:chore" },
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
  await fs.writeFile(path.join(defsDir, "chore.yaml"), CHORE_YAML);
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

// ── AC1–AC3: PR/branch-bearing ticket into `task` → redirected to dev-impl ───
// Post-INF-1023: the advisory nudge is superseded by a hard redirect. A code-
// signaled `wf:task` intake now bootstraps as `dev-impl` (not `task`) and posts
// no advisory — the loud, non-dropping outcome is the workflow swap itself.

describe("INF-594 AC1–AC3 (post-INF-1023): PR/branch-bearing `task` intake is redirected to dev-impl", () => {
  it("AC1: a GitHub PR URL in the description redirects to dev-impl (INF-585 shape)", async () => {
    installFetch();
    const issue = makeIssue({
      workflowLabelId: WF_TASK_LABEL_ID,
      workflowLabelName: "wf:task",
      title: "Connector fix",
      description: "Approved fix on https://github.com/fancyfleet/fancy-openclaw-linear-connector/pull/512",
    });

    const result = await applyBootstrapToIssue(issue, "test-token");

    expect(result?.action).toBe("bootstrapped");
    expect(result?.workflowId).toBe("dev-impl");
    expect(advisoryComment()).toBeUndefined();
  });

  it("AC2: a bare 'PR #512' mention redirects to dev-impl", async () => {
    installFetch();
    const issue = makeIssue({
      workflowLabelId: WF_TASK_LABEL_ID,
      workflowLabelName: "wf:task",
      description: "Approved fix on PR #512 — needs merge + deploy.",
    });

    const result = await applyBootstrapToIssue(issue, "test-token");

    expect(result?.workflowId).toBe("dev-impl");
    expect(advisoryComment()).toBeUndefined();
  });

  it("AC3: a conventional branch name redirects to dev-impl", async () => {
    installFetch();
    const issue = makeIssue({
      workflowLabelId: WF_TASK_LABEL_ID,
      workflowLabelName: "wf:task",
      description: "Landed on feature/INF-585-null-guard; ready for review.",
    });

    const result = await applyBootstrapToIssue(issue, "test-token");

    expect(result?.workflowId).toBe("dev-impl");
    expect(advisoryComment()).toBeUndefined();
  });
});

// ── AC4: clean `task` ticket → no redirect, no advisory ─────────────────────

describe("INF-594 AC4 (superseded by INF-1164): a non-code `task` ticket redirects to `chore`, not nagged", () => {
  it("redirects to chore (no dev-impl code-signal nag) when there is no code signal", async () => {
    // INF-594 originally left a clean non-code task ticket on `task` with no
    // advisory. INF-1164 deprecates wf:task and redirects ALL new enrollment to
    // wf:chore; because there is no code signal the dev-impl guardrail does not
    // fire and there is no advisory comment — only the silent chore redirect.
    installFetch();
    const issue = makeIssue({
      workflowLabelId: WF_TASK_LABEL_ID,
      workflowLabelName: "wf:task",
      title: "Write the Q3 marketing brief",
      description: "Draft positioning copy for the launch. No code involved.",
    });

    const result = await applyBootstrapToIssue(issue, "test-token");

    expect(result?.action).toBe("bootstrapped");
    expect(result?.workflowId).toBe("chore");
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
