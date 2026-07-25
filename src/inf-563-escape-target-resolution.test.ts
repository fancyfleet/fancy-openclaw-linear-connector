/**
 * INF-563 — `escape` from `done` was unusable by agents because the `--target`
 * body only resolved on an exact, case-sensitive `name` match.
 *
 * Split from INF-562. The break-glass `escape` recovery hatch re-enters a ticket
 * at `intake`, whose owner role (`requester`: {astrid, ai} on the live policy) is
 * multi-body, so it fail-closes without a `--target`. INF-545 shipped the flag,
 * but the connector resolved it with `getAgent(target)` — an EXACT, case-sensitive
 * match on the agents.json `name`. A steward recovering a ticket naturally types
 * the body the way it reads ("Ai", "Astrid", "Igor"), which never matched the
 * lowercase body id, so every attempt aborted with
 * `target-unresolved — CLI target '<x>' has no linearUserId`. Because escape does
 * NOT run the transition target-legality validation, nothing caught the mismatch
 * or told the operator the valid forms — the hatch looked broken for every body.
 *
 * Fix (agents.ts `getAgentByTarget`, wired into workflow-gate's two cliTarget
 * sites): resolve tolerant of case, `displayName`, and `openclawAgent`, fail-
 * closed on ambiguity; and, when a target still can't resolve, distinguish
 * "registered body with no linearUserId" (onboarding gap) from "no body matched"
 * (list the role's valid bodies).
 *
 * AC1: from state:done, `escape --target Ai` (capitalized legal requester body)
 *      resolves to the app-user's linearUserId, re-enters intake, delegate set.
 * AC2: a genuinely-unregistered target still fails closed, now naming the valid
 *      bodies for the destination role.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents, getAgentByTarget } from "./agents.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";

const CANONICAL_TASK_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-task.yaml");

// Live-shaped policy: `requester` is multi-body (astrid, ai) — the exact shape
// that makes escape → intake fail-close without a --target.
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

// agents.json: lowercase body ids, as onboarded. `igor` also carries a
// displayName + openclawAgent to exercise the alias tiers.
const AGENTS_JSON = {
  agents: [
    { name: "astrid", linearUserId: "user-astrid", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
    { name: "ai", linearUserId: "user-ai", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
    { name: "igor", displayName: "Igor (Back End Dev)", openclawAgent: "igor-agent", linearUserId: "user-igor", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" as const },
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
const TICKET_IDENTIFIER = "INF-552"; // the live error-closed ticket the AC repros
const TEAM_ID = "team-uuid";

interface Captured {
  comments: Array<{ issueId: string; body: string }>;
  delegateWrites: Array<string | null | undefined>;
}
let captured: Captured;

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function makeFetch(currentLabelNames: () => string[]): typeof globalThis.fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch call: ${String(url)}`);
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
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
      if ("delegateId" in vars) captured.delegateWrites.push(vars.delegateId as string | null);
      const inp = vars.input as { delegateId?: string | null } | undefined;
      if (inp && "delegateId" in inp) captured.delegateWrites.push(inp.delegateId ?? null);
      return json({ data: { issueUpdate: { success: true } } });
    }
    throw new Error(`unexpected Linear query: ${query.slice(0, 100)}`);
  }) as unknown as typeof globalThis.fetch;
}

describe("INF-563 — escape --target resolves app-user bodies tolerant of case/alias", () => {
  let originalFetch: typeof globalThis.fetch;
  let saved: Record<string, string | undefined>;
  let tmpDir: string;

  beforeAll(() => {
    saved = {
      WORKFLOW_DEF_PATH: process.env.WORKFLOW_DEF_PATH,
      WORKFLOW_DEFS_DIR: process.env.WORKFLOW_DEFS_DIR,
      CAPABILITY_POLICY_PATH: process.env.CAPABILITY_POLICY_PATH,
      AGENTS_FILE: process.env.AGENTS_FILE,
    };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf563-escape-target-"));
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
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    captured = { comments: [], delegateWrites: [] };
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

  // ── Unit: the resolver itself ──────────────────────────────────────────────
  describe("getAgentByTarget", () => {
    beforeEach(() => reloadAgents());

    it("exact name still wins (unchanged precedence)", () => {
      expect(getAgentByTarget("ai")?.name).toBe("ai");
      expect(getAgentByTarget("igor")?.name).toBe("igor");
    });
    it("resolves a capitalized body id (the break-glass failure)", () => {
      expect(getAgentByTarget("Ai")?.name).toBe("ai");
      expect(getAgentByTarget("ASTRID")?.name).toBe("astrid");
      expect(getAgentByTarget("Igor")?.name).toBe("igor");
    });
    it("resolves via displayName and openclawAgent", () => {
      expect(getAgentByTarget("Igor (Back End Dev)")?.name).toBe("igor");
      expect(getAgentByTarget("igor-agent")?.name).toBe("igor");
    });
    it("returns undefined for a genuinely-unknown target", () => {
      expect(getAgentByTarget("nobody")).toBeUndefined();
      expect(getAgentByTarget("")).toBeUndefined();
    });
  });

  // ── AC1: the core defect — escape from done with a capitalized target ───────
  it("AC1: escape from state:done with --target 'Ai' re-enters intake and delegates to the app-user", async () => {
    globalThis.fetch = makeFetch(() => ["wf:task", "state:done"]);

    const result = await applyStateTransition("escape", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "astrid",
      sourceStateOverride: "done",
      cliTarget: "Ai", // capitalized legal requester body — the exact form that failed
    });

    expect(result.status).toBe("applied");
    expect(result.to).toBe("intake");
    // The resolved app-user linearUserId was written as the delegate.
    expect(captured.delegateWrites).toContain("user-ai");
    expect(captured.delegateWrites).not.toContain(undefined);
  });

  it("AC1: escape --target 'ASTRID' resolves the steward body id case-insensitively", async () => {
    globalThis.fetch = makeFetch(() => ["wf:task", "state:done"]);
    const result = await applyStateTransition("escape", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "astrid",
      sourceStateOverride: "done",
      cliTarget: "ASTRID",
    });
    expect(result.status).toBe("applied");
    expect(result.to).toBe("intake");
    expect(captured.delegateWrites).toContain("user-astrid");
  });

  // ── AC2: an unregistered target still fails closed, now helpfully ──────────
  it("AC2: a genuinely-unregistered --target fails closed and names the role's valid bodies", async () => {
    globalThis.fetch = makeFetch(() => ["wf:task", "state:done"]);
    const result = await applyStateTransition("escape", TICKET_IDENTIFIER, "Bearer tok", {
      bodyId: "astrid",
      sourceStateOverride: "done",
      cliTarget: "Ghost",
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("target-unresolved");
    expect(result.detail).toContain("matched no registered body");
    // No delegate write landed (no half-applied re-entry).
    expect(captured.delegateWrites).toEqual([]);
  });
});
