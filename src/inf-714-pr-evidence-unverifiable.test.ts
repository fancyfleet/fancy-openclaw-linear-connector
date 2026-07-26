/**
 * INF-714 — PR-evidence gate fail-closes and traps merged tickets when the
 * GitHub merge-verification API cannot be reached.
 *
 * Incident (INF-695 deadlock): a merged + Charles-approved ticket used a valid
 * but non-canonical branch name, so Linear's GitHub integration never attached
 * merged metadata. The PR URL WAS available (Hanzo posted it in a comment), but
 * the connector's GitHub-API verify of that URL could not confirm the merge —
 * the fancyfleet connector repo is private and the token in use could not read
 * it, so `GET /pulls/{n}` returned a non-2xx. The old gate collapsed
 * "GitHub could not be reached" and "GitHub says not merged" into a single
 * `merged: false`, and — because a token *was* configured — fail-closed to
 * "pull request not yet merged". `continue`, `force-deploy`, and `demote` all
 * refused; only the destructive `escape` (→ intake, one `accept` from resetting
 * merged work to write-tests) passed.
 *
 * These tests pin the fix:
 *   AC1 — when GitHub confirms the merge for a comment-posted PR URL on a
 *         non-canonical branch, the gate treats the ticket as merged (passes).
 *   AC2 — when GitHub is UNREACHABLE for the PR URL, the gate does NOT
 *         fail-closed (does not strand the merged ticket) and raises a LOUD,
 *         actionable alert instead of silently blocking.
 *   Guard — an AUTHORITATIVE "not merged" (a reachable GitHub 200 reporting
 *         merged:false) still blocks. The fix is "cannot-verify ≠ not-merged",
 *         not a blanket fail-open.
 *
 * Both the advisory gate (`checkWorkflowRules`) and the enforcement gate
 * (`applyStateTransition`) are covered.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { checkWorkflowRules, applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";
import { initAlertBus, _resetAlertBusForTests } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";

// ── Fixture path ─────────────────────────────────────────────────────────────

const CANONICAL_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");

// ── Capability policy (mirrors INF-310: host-deploy holds infra:ssh) ─────────

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute
  - id: infra:ssh
  - id: workflow:break-glass

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: host-deploy
    grants: [linear:transition, infra:ssh]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: host-deploy
    requires: [infra:ssh]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: host-deploy
    fills_roles: [host-deploy]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const AGENTS_JSON = {
  agents: [
    { name: "hanzo", linearUserId: "hanzo-uuid", clientId: "h-c", clientSecret: "h-s", accessToken: "h-t", refreshToken: "h-r" },
    { name: "grover", linearUserId: "grover-uuid", clientId: "g-c", clientSecret: "g-s", accessToken: "g-t", refreshToken: "g-r" },
    { name: "astrid", linearUserId: "astrid-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
    { name: "igor", linearUserId: "igor-uuid", clientId: "i-c", clientSecret: "i-s", accessToken: "i-t", refreshToken: "i-r" },
  ],
};

// ── Constants ────────────────────────────────────────────────────────────────

const ISSUE_ID = "inf-714-issue-uuid";
const AUTH_TOKEN = "Bearer test-token";
const BODY_ID = "grover"; // host-deploy — holds infra:ssh (deploy state's continue requires it)
const CALLER_LUID = "grover-uuid";

// The INF-695 shape: a non-canonical branch, so Linear never attached the PR;
// the PR URL survives only in a Hanzo merge comment. Private connector repo.
const PR_URL = "https://github.com/fancyfleet/fancy-openclaw-linear-connector/pull/542";
const MERGE_COMMENT = `Break-glass: PR #542 merge complete and verified (SHA 77e50121 on main): ${PR_URL}`;

const DEPLOY_LABELS = [
  { id: "lbl-wf", name: "wf:dev-impl" },
  { id: "lbl-state", name: "state:deploy" },
];

// ── Mock fetch ───────────────────────────────────────────────────────────────

type GitHubMode = "merged" | "notmerged" | "unreachable";

interface MockOpts {
  /** GitHub API behavior for GET /pulls/{n}. */
  github: GitHubMode;
  issueLabels?: Array<{ id: string; name: string }>;
}

function makeMockFetch(opts: MockOpts): typeof globalThis.fetch {
  const issueLabels = opts.issueLabels ?? DEPLOY_LABELS;

  return (async (url, init) => {
    const urlStr = typeof url === "string" ? url : (url as URL).href;

    // ── GitHub REST API: GET /repos/{owner}/{repo}/pulls/{n} ──
    if (urlStr.includes("api.github.com")) {
      if (opts.github === "unreachable") {
        // Private repo the token cannot read (INF-695), or network/rate-limit.
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      const merged = opts.github === "merged";
      return new Response(
        JSON.stringify({
          merged,
          state: merged ? "closed" : "open",
          merge_commit_sha: merged ? "77e50121712e4f8a4fe2507352b0cea1be4a340a" : null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (typeof url !== "string" || !urlStr.includes("api.linear.app")) {
      throw new Error(`unexpected fetch: ${urlStr}`);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const q = (JSON.parse(bodyText) as { query?: string }).query ?? "";

    if (q.includes("IssueContext")) {
      return new Response(
        JSON.stringify({ data: { issue: { labels: { nodes: issueLabels.map((l) => ({ name: l.name })) }, delegate: { id: CALLER_LUID } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("IssueWithLabels")) {
      return new Response(
        JSON.stringify({ data: { issue: { id: "internal-uuid", identifier: "INF-714", team: { id: "team-uuid" }, labels: { nodes: issueLabels } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // IssueBranchAndPR: the INF-695 metadata-gap shape — NO PR attachments, the
    // PR URL lives only in a comment. So prMetadataAvailable is false and the
    // gate must fall through to GitHub-API verification of the comment URL.
    if (q.includes("IssueBranchAndPR")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              description: null,
              comments: { nodes: [{ body: MERGE_COMMENT }] },
              attachments: { nodes: [] },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "s1", name: "Backlog", type: "unstarted" },
                  { id: "s2", name: "Todo", type: "unstarted" },
                  { id: "s3", name: "Doing", type: "started" },
                  { id: "s4", name: "Thinking", type: "started" },
                  { id: "s5", name: "Managing", type: "started" },
                  { id: "s6", name: "Done", type: "completed" },
                  { id: "s7", name: "Invalid", type: "canceled" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("TeamLabels")) {
      return new Response(JSON.stringify({ data: { team: { labels: { nodes: [] } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (q.includes("IssueRepoAttachments")) {
      return new Response(JSON.stringify({ data: { issue: { attachments: { nodes: [] } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (q.includes("issueLabelCreate")) {
      return new Response(JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "nl" } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (q.includes("ApplyAtomicTransition") || q.includes("issueUpdate")) {
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (q.includes("UpdateDelegate")) {
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    throw new Error(`unexpected query: ${q.slice(0, 120)}`);
  }) as typeof globalThis.fetch;
}

// ── Shared test state ────────────────────────────────────────────────────────

let dir: string;
let savedFetch: typeof globalThis.fetch;
let savedGhToken: string | undefined;
let alertStore: AlertStore;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-714-test-"));
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(AGENTS_JSON), "utf8");
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
  reloadAgents();
  savedFetch = globalThis.fetch;
  savedGhToken = process.env.GH_TOKEN;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.AGENTS_FILE;
  delete process.env.WORKFLOW_DEF_PATH;
  globalThis.fetch = savedFetch;
  if (savedGhToken !== undefined) process.env.GH_TOKEN = savedGhToken;
  else delete process.env.GH_TOKEN;
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  resetConfigHealth();
  _resetAlertBusForTests();
  alertStore = new AlertStore(":memory:");
  initAlertBus({ store: alertStore, pushEnabled: false });
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  delete process.env.GH_TOKEN;
});

// ── checkWorkflowRules (advisory gate) ───────────────────────────────────────

describe("INF-714: checkWorkflowRules — merge verification across GitHub reachability", () => {
  it("AC1: comment-posted PR URL on a non-canonical branch, GitHub confirms merged → gate passes", async () => {
    process.env.GH_TOKEN = "mock-token";
    globalThis.fetch = makeMockFetch({ github: "merged" });
    const result = await checkWorkflowRules("continue", ISSUE_ID, AUTH_TOKEN, BODY_ID, null, CALLER_LUID);
    expect(result).toBeNull();
  });

  it("AC2: GitHub UNREACHABLE for the PR URL (token set) → gate does NOT fail-closed and raises a loud alert", async () => {
    process.env.GH_TOKEN = "mock-token"; // token configured but repo unreadable — the INF-695 case
    globalThis.fetch = makeMockFetch({ github: "unreachable" });
    const result = await checkWorkflowRules("continue", ISSUE_ID, AUTH_TOKEN, BODY_ID, null, CALLER_LUID);

    // Must NOT strand the merged+approved ticket.
    expect(result).toBeNull();

    // Must be LOUD, not silent (AC2): an actionable warning alert.
    const alert = alertStore.query({ source: "done-gate" }).find((a) => a.dedupKey === `done-gate|inf-714-unverifiable|${ISSUE_ID}`);
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("warning");
    expect(alert?.ticket).toBe(ISSUE_ID);
    expect(alert?.detail).toContain("infra dependency");
  });

  it("Guard: GitHub AUTHORITATIVELY reports not-merged (reachable 200, token set) → gate still BLOCKS", async () => {
    process.env.GH_TOKEN = "mock-token";
    globalThis.fetch = makeMockFetch({ github: "notmerged" });
    const result = await checkWorkflowRules("continue", ISSUE_ID, AUTH_TOKEN, BODY_ID, null, CALLER_LUID);
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  it("No token configured + comment PR URL → accepted as sufficient (INF-522 preserved, no false alert)", async () => {
    // GH_TOKEN unset (afterEach deletes it). checkPRMergedFromGitHub returns null
    // because no token — the no-token defense-in-depth path, not the unreachable path.
    globalThis.fetch = makeMockFetch({ github: "unreachable" });
    const result = await checkWorkflowRules("continue", ISSUE_ID, AUTH_TOKEN, BODY_ID, null, CALLER_LUID);
    expect(result).toBeNull();
    // The loud INF-714 unreachable alert must NOT fire in the plain no-token case.
    const unreachableAlert = alertStore.query({ source: "done-gate" }).find((a) => a.dedupKey === `done-gate|inf-714-unverifiable|${ISSUE_ID}`);
    expect(unreachableAlert).toBeUndefined();
  });
});

// ── applyStateTransition (enforcement gate) ──────────────────────────────────

describe("INF-714: applyStateTransition — release gate across GitHub reachability", () => {
  it("AC2: GitHub UNREACHABLE (token set) → release gate does NOT block and raises a loud alert", async () => {
    process.env.GH_TOKEN = "mock-token";
    globalThis.fetch = makeMockFetch({ github: "unreachable" });
    const result = await applyStateTransition("continue", ISSUE_ID, AUTH_TOKEN, { bodyId: BODY_ID });

    // The evidence gate must not be the thing that blocks (release-gate).
    expect(result.code).not.toBe("release-gate");

    const alert = alertStore.query({ source: "done-gate" }).find((a) => a.dedupKey === `done-gate|inf-714-unverifiable|${ISSUE_ID}`);
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("warning");
  });

  it("Guard: GitHub AUTHORITATIVELY not-merged (token set) → release gate blocks", async () => {
    process.env.GH_TOKEN = "mock-token";
    globalThis.fetch = makeMockFetch({ github: "notmerged" });
    const result = await applyStateTransition("continue", ISSUE_ID, AUTH_TOKEN, { bodyId: BODY_ID });
    expect(result.status).toBe("blocked");
    expect(result.code).toBe("release-gate");
  });
});
