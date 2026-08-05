/**
 * INF-1242 — regression guard: commitment-exit + re-intake loop.
 *
 * Background: INF-1197 got wedged in a loop — `submit` was refused with
 * "missing commitment exit" whenever the current workflow state had a
 * `commitment_gate` config and no exit was recorded, `escape` sent the
 * ticket back to intake, `accept` re-entered the workflow, and `submit`
 * was refused again. Infinite loop.
 *
 * This was already fixed by commit 70572713 (PR #665, INF-1205 "dev-impl
 * v20 — revert commitment gate, unify reject"), which removed
 * `commitment_gate` entirely from the dev-impl workflow config, the day
 * before this ticket (INF-1242) was filed. No currently-loadable workflow
 * config declares `commitment_gate`, so the specific "missing commitment
 * exit" refusal (workflow-gate.ts's `doing-never-set` code path) cannot
 * fire for any live workflow today.
 *
 * THIS TEST IS EXPECTED TO PASS ALREADY — it does not prove a new fix. Its
 * job is to lock in the escape → re-accept → submit sequence as a
 * regression guard against the loop shape resurfacing (e.g. if a future
 * workflow-config change reintroduces a `commitment_gate`).
 *
 * Test pattern mirrors src/inf-1205-dev-impl-v20.test.ts's AC3 reject-edge
 * test (installTransitionFetch + applyStateTransition w/ sourceStateOverride
 * against the real, registered dev-impl v20 def).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";

import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { applyStateTransition, resetNativeStateCache, resetWorkflowCache } from "./workflow-gate.js";

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");
const REGISTERED_DEV_IMPL = path.join(REGISTERED_DEFS_DIR, "dev-impl.yaml");

// INF-1060 push-before-claim evidence gate (unrelated to the commitment-exit
// loop this test guards, but it also sits on implementation → code-review and
// must be satisfied for the submit step to reach a verdict at all).
const VALID_BRANCH = "feature/INF-1242-commitment-exit-reintake-loop";
const VALID_SHA = "0123456789abcdef0123456789abcdef01234567";

const V20_STATES = [
  "intake",
  "write-tests",
  "implementation",
  "code-review",
  "merge",
  "deploy",
  "ac-validate",
  "done",
];

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute
  - id: infra:ssh
  - id: workflow:force-deploy
  - id: workflow:break-glass

containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:force-deploy, workflow:break-glass]
  - id: test-author
    grants: [linear:transition]
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: host-deploy
    grants: [linear:transition, infra:ssh]

roles:
  - id: steward
    requires: [human:escalate]
  - id: test-author
    requires: [linear:transition]
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: host-deploy
    requires: [infra:ssh]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: tdd
    container: test-author
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
    container: host-deploy
    fills_roles: [host-deploy]
`;

type GraphqlCall = { query: string; variables: Record<string, any> };

let tmpDir: string;
let savedFetch: typeof globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const key of keys) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function parseBody(init?: RequestInit): GraphqlCall {
  return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphqlCall;
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Mirrors inf-1205's installTransitionFetch: a fresh mock scoped to a single
 * source state, reflecting a ticket currently at `state:<sourceState>`. Each
 * step of the escape/accept/submit sequence below gets its own fresh mock
 * (matching how inf-1205's REJECT_EDGES cases independently exercise each edge).
 */
function installTransitionFetch(sourceState: string, delegateId: string): { calls: GraphqlCall[] } {
  const calls: GraphqlCall[] = [];
  let currentDelegateId = delegateId;
  let labelNodes = [
    { id: "label-wf-dev-impl", name: "wf:dev-impl", team: { id: "team-lif" } },
    { id: `label-state-${sourceState}`, name: `state:${sourceState}`, team: { id: "team-lif" } },
    { id: "label-workflow-version-20", name: "workflow-version:20", team: { id: "team-lif" } },
    { id: "label-repo-connector", name: "repo:fancy-openclaw-linear-connector", team: { id: "team-lif" } },
  ];
  const teamLabels = [
    { id: "label-wf-dev-impl", name: "wf:dev-impl" },
    { id: "label-workflow-version-20", name: "workflow-version:20" },
    { id: "label-repo-connector", name: "repo:fancy-openclaw-linear-connector" },
    ...V20_STATES.map((id) => ({ id: `label-state-${id}`, name: `state:${id}` })),
  ];

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlText = String(url);
    if (!urlText.includes("api.linear.app")) {
      // INF-1060 origin-reachability check (GitHub compare API) — not exercised
      // by this regression test's assertions, just needs to not block submit.
      return json({ status: "identical", reachable: true });
    }
    const parsed = parseBody(init);
    const query = parsed.query ?? "";
    calls.push(parsed);

    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "native-todo", name: "Todo", type: "unstarted" },
                { id: "native-doing", name: "Doing", type: "started" },
                { id: "native-done", name: "Done", type: "completed" },
                { id: "native-invalid", name: "Invalid", type: "canceled" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: teamLabels } } } });
    }
    if (query.includes("IssueBranchAndPR") || query.includes("IssueRepoAttachments")) {
      return json({ data: { issue: { attachments: { nodes: [] }, description: "", comments: { nodes: [] } } } });
    }
    if (query.includes("IssueContext") || query.includes("issue(")) {
      return json({
        data: {
          issue: {
            id: "issue-inf-1242",
            identifier: "INF-1242-LOOP",
            team: { id: "team-lif", key: "LIF", name: "LifeOS" },
            labels: { nodes: labelNodes },
            delegate: currentDelegateId ? { id: currentDelegateId } : null,
            state: { id: "native-todo", name: "Todo", type: "unstarted" },
            assignee: null,
          },
        },
      });
    }
    if (query.includes("issueUpdate")) {
      const nextLabelIds = (parsed.variables?.labelIds ?? []) as string[];
      labelNodes = teamLabels
        .filter((label) => nextLabelIds.includes(label.id))
        .map((label) => ({ ...label, team: { id: "team-lif" } }));
      if (typeof parsed.variables?.delegateId === "string") {
        currentDelegateId = parsed.variables.delegateId;
      }
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    }
    return json({ data: {} });
  }) as typeof globalThis.fetch;

  return { calls };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1242-"));
  saveEnv(
    "WORKFLOW_DEFS_DIR",
    "WORKFLOW_DEF_DIR",
    "WORKFLOW_DEF_PATH",
    "WORKFLOW_DEF_STATE_SNAPSHOT_PATH",
    "CAPABILITY_POLICY_PATH",
    "AGENTS_FILE",
    "AGENTS_PATH",
    "ADMIN_SECRET",
    "WORKFLOW_GUIDANCE_DIR",
  );
  fs.writeFileSync(path.join(tmpDir, "capability-policy.yaml"), POLICY_YAML, "utf8");
  fs.writeFileSync(
    path.join(tmpDir, "agents.json"),
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "lin-astrid", accessToken: "tok-astrid" },
        { name: "tdd", linearUserId: "lin-tdd", accessToken: "tok-tdd" },
        { name: "igor", linearUserId: "lin-igor", accessToken: "tok-igor" },
        { name: "charles", linearUserId: "lin-charles", accessToken: "tok-charles" },
        { name: "hanzo", linearUserId: "lin-hanzo", accessToken: "tok-hanzo" },
        { name: "grover", linearUserId: "lin-grover", accessToken: "tok-grover" },
      ],
    }),
    "utf8",
  );
  savedFetch = globalThis.fetch;
});

beforeEach(() => {
  process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
  process.env.WORKFLOW_DEF_PATH = REGISTERED_DEV_IMPL;
  process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(tmpDir, `def-state-${Date.now()}-${Math.random()}.json`);
  process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "capability-policy.yaml");
  process.env.AGENTS_FILE = path.join(tmpDir, "agents.json");
  process.env.AGENTS_PATH = path.join(tmpDir, "agents.json");
  process.env.ADMIN_SECRET = "inf-1242-admin-secret";
  process.env.WORKFLOW_GUIDANCE_DIR = path.resolve(process.cwd(), "config-templates/workflows");
  reloadAgents();
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetConfigHealth();
  globalThis.fetch = savedFetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetConfigHealth();
});

afterAll(() => {
  restoreEnv();
  globalThis.fetch = savedFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("INF-1242: commitment-exit + re-intake loop does not resurface on live dev-impl v20", () => {
  it("escape (implementation → intake) → re-accept (intake → write-tests) → submit (implementation → code-review) never refuses with a missing-commitment-exit error", async () => {
    // Step 1: ticket is stuck in `implementation` and gets escaped (break-glass)
    // back to intake — the first half of the INF-1197 loop.
    const escapeFetch = installTransitionFetch("implementation", "lin-igor");
    const escaped = await applyStateTransition("escape", "issue-inf-1242", "Bearer tok", {
      bodyId: "astrid",
      sourceStateOverride: "implementation",
    });
    expect(escaped).toMatchObject({ status: "applied", from: "implementation", to: "intake" });

    // Step 2: the ticket is re-accepted out of intake — the re-intake half of
    // the loop. Pre-fix, this alone was not the problem; the problem was what
    // happened on the NEXT visit to `implementation` (step 3).
    const acceptFetch = installTransitionFetch("intake", "lin-astrid");
    const accepted = await applyStateTransition("accept", "issue-inf-1242", "Bearer tok", {
      bodyId: "astrid",
      sourceStateOverride: "intake",
    });
    expect(accepted).toMatchObject({ status: "applied", from: "intake", to: "write-tests" });

    // Step 3: back at `implementation` (post re-intake), `submit` must NOT be
    // refused with "missing commitment exit" (workflow-gate's `doing-never-set`
    // code path). Pre-INF-1205, a `commitment_gate` on `implementation` with no
    // recorded exit made this refuse every time, wedging the ticket forever.
    // v20 carries no `commitment_gate` anywhere in the def, so this must apply.
    const submitFetch = installTransitionFetch("implementation", "lin-igor");
    const submitted = await applyStateTransition("submit", "issue-inf-1242", "Bearer tok", {
      bodyId: "igor",
      cliTarget: "charles",
      sourceStateOverride: "implementation",
      codeArtifact: `${VALID_BRANCH}@${VALID_SHA}`,
    });

    expect(submitted.code).not.toBe("doing-never-set");
    expect(JSON.stringify(submitted)).not.toMatch(/commitment[- ]exit/i);
    expect(submitted).toMatchObject({ status: "applied", from: "implementation", to: "code-review" });

    void escapeFetch;
    void acceptFetch;
    void submitFetch;
  });
});
