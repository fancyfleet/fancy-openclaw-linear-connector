/**
 * INF-545 — break-glass `linear escape` must never demand a `--target`.
 *
 * The stuck-delegate break-glass path was unusable for multi-body role tickets.
 * `linear escape <ID>` re-enters the task workflow at `intake`, whose owner_role
 * is `requester` — a role filled by MORE THAN ONE body on the live policy
 * (astrid, ai). B2's delegate resolution (applyStateTransition Step 2) treated
 * that exactly like any other multi-body destination and fail-closed with
 * `delegate-unresolved — multi-body role 'requester' requires a --target`.
 *
 * But `linear escape` exposes no `--target` flag (only --comment / --comment-file
 * / --force-duplicate), so the proxy demanded a flag the CLI could not supply and
 * every stuck-delegate hook that told an agent to break glass failed
 * deterministically (observed live on INF-540: two Ai sessions, both blocked).
 *
 * Fix (connector-only, ticket option (b)): on a break-glass escape, route custody
 * of the recovered ticket to the escaping caller. By the time B2 runs, B1's §4.4
 * gate has already proven the caller is the ticket's delegate or a workflow
 * steward, so the target is deterministic and no `--target` is needed.
 *
 * This file proves:
 *   AC1: escape from a multi-body-`requester` recovery target succeeds with no
 *        `--target`, lands at `intake`, and delegates to the escaping caller.
 *   AC2: the fix is scoped to escape — a NORMAL forward transition into the same
 *        multi-body `requester` state (`approve` → sign-off) still fail-closes
 *        asking for `--target` (guards against over-broadening the escape hatch).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";

const CANONICAL_TASK_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-task.yaml");

// Mirrors the LIVE capability-policy shape that made INF-540's escape fail:
// `requester` is filled by TWO bodies (astrid, ai), so B2 cannot pick one
// without a target.
const TASK_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition]
  - id: dev
    grants: [linear:transition]
roles:
  - id: requester
    requires: [linear:transition]
  - id: department-head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
bodies:
  - id: astrid
    container: steward
    fills_roles: [department-head, requester]
  - id: ai
    container: steward
    fills_roles: [requester]
  - id: worker1
    container: dev
    fills_roles: [worker]
`;

const AGENTS_JSON = {
  agents: [
    { name: "astrid", linearUserId: "user-astrid", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
    { name: "ai", linearUserId: "user-ai", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
    { name: "worker1", linearUserId: "user-worker1", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
  ],
};

const TEAM_LABELS = [
  { id: "wf-task-id", name: "wf:task" },
  { id: "state-intake-id", name: "state:intake" },
  { id: "state-routing-id", name: "state:routing" },
  { id: "state-doing-id", name: "state:doing" },
  { id: "state-review-id", name: "state:review" },
  { id: "state-signoff-id", name: "state:sign-off" },
  { id: "state-done-id", name: "state:done" },
];

const ISSUE_UUID = "11111111-2222-3333-4444-555555555555";
const TICKET_IDENTIFIER = "INF-540";
const TEAM_ID = "team-uuid";

interface Captured {
  comments: Array<{ issueId: string; body: string }>;
  writes: Array<{ query: string; labelIds?: string[]; delegateId?: unknown }>;
}

let captured: Captured;

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** `currentLabelNames` is read fresh on every IssueWithLabels call. */
function makeFetch(currentLabelNames: () => string[]): typeof globalThis.fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch call: ${String(url)}`);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const vars = parsed.variables ?? {};

    if (query.includes("commentCreate")) {
      captured.comments.push({ issueId: String(vars.issueId ?? ""), body: String(vars.body ?? "") });
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } });
    }

    if (query.includes("IssueWithLabels") || query.includes("IssueContext")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: TICKET_IDENTIFIER,
            team: { id: TEAM_ID },
            labels: { nodes: currentLabelNames().map((name) => ({ id: `${name}-id`, name })) },
            delegate: null,
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: TEAM_LABELS } } } });
    }

    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
                { id: "state-doing-uuid", name: "Doing", type: "started" },
                { id: "state-done-uuid", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("issueLabelCreate")) {
      return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label-id" } } } });
    }

    if (query.includes("IssueBranchAndPR")) {
      return json({ data: { issue: { attachments: { nodes: [] } } } });
    }

    if (query.includes("issueUpdate") || query.includes("ApplyAtomicTransition") || query.includes("UpdateDelegate")) {
      captured.writes.push({
        query: query.slice(0, 60),
        labelIds: (vars as { labelIds?: string[] }).labelIds,
        delegateId: (vars as { delegateId?: unknown }).delegateId,
      });
      return json({ data: { issueUpdate: { success: true } } });
    }

    throw new Error(`unexpected Linear query: ${query.slice(0, 100)}`);
  }) as unknown as typeof globalThis.fetch;
}

describe("INF-545 — break-glass escape needs no --target", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalDefPath: string | undefined;
  let originalDefsDir: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;
  let tmpDir: string;

  beforeAll(() => {
    originalDefPath = process.env.WORKFLOW_DEF_PATH;
    originalDefsDir = process.env.WORKFLOW_DEFS_DIR;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf545-escape-"));
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TASK_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const agentsFile = path.join(tmpDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify(AGENTS_JSON), "utf8");
    process.env.AGENTS_FILE = agentsFile;

    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_TASK_FIXTURE;
  });

  afterAll(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    };
    restore("WORKFLOW_DEF_PATH", originalDefPath);
    restore("WORKFLOW_DEFS_DIR", originalDefsDir);
    restore("CAPABILITY_POLICY_PATH", originalPolicyPath);
    restore("AGENTS_FILE", originalAgentsFile);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    captured = { comments: [], writes: [] };
    originalFetch = globalThis.fetch;
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    _resetAppliedStateStore();
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("AC1: escape from a multi-body-requester state succeeds with NO --target and delegates to the escaping caller", async () => {
    // Ticket stuck in `review`; the steward `ai` breaks glass with no target —
    // exactly the INF-540 hook path. `review` --escape--> intake (owner_role
    // `requester`, filled by astrid+ai → multi-body).
    globalThis.fetch = makeFetch(() => ["wf:task", "state:review"]);

    const result = await applyStateTransition("escape", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "ai",
      sourceStateOverride: "review",
      // no cliTarget — `linear escape` exposes none
    });

    expect(result).toMatchObject({ status: "applied", from: "review", to: "intake" });
    // Must not have posted the --target remedy comment: escape resolved cleanly.
    expect(captured.comments).toEqual([]);
    // Custody of the recovered ticket went to the escaping caller (ai).
    const delegateWrites = captured.writes.filter((w) => w.delegateId !== undefined);
    expect(delegateWrites.length).toBeGreaterThan(0);
    for (const w of delegateWrites) {
      expect(w.delegateId).toBe("user-ai");
    }
  });

  it("AC2: a NORMAL forward transition into the same multi-body requester state still requires --target", async () => {
    // Guard against over-broadening: only escape is exempt. `approve` → sign-off
    // (owner_role `requester`, multi-body) with no target must still fail-closed.
    globalThis.fetch = makeFetch(() => ["wf:task", "state:review"]);

    const result = await applyStateTransition("approve", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "astrid",
      sourceStateOverride: "review",
      // no cliTarget
    });

    expect(result.status).toBe("failed");
    expect(result.code).toBe("delegate-unresolved");
    // The remedy comment naming both bodies still lands for the normal path.
    expect(captured.comments).toHaveLength(1);
    expect(captured.comments[0].body).toContain("--target");
  });
});
