/**
 * INF-489 — a "blocked"/"failed" B2 apply must fail loudly on the wire.
 *
 * Live incident (2026-07-24): `linear approve INF-488` (wf:task, state:review,
 * native To Do) reported no comment and no label movement; a follow-up
 * `continue-workflow` posted its comment but still left the label unchanged.
 * The upstream mutation the CLI sends to trigger a transition (an empty
 * issueUpdate, or the transition-triggering comment itself) succeeds against
 * Linear regardless of whether the connector's OWN internal transition write
 * (`applyStateTransition`) actually applied — the outcome was previously only
 * embedded in an unread `_workflowTransition` response field. The skill CLI's
 * own before/after label-diff poll (AI-1769) is the only backstop, and it
 * only covers the label facet with a probabilistic re-poll — not delegate or
 * native state, and not a definitive "why".
 *
 * This test proves a config/policy-level rejection (`delegate-unresolved`,
 * from an unfillable destination role — the same failure family checkWorkflowRules
 * / applyStateTransition raise for a review→sign-off gate whose destination
 * owner cannot be resolved) now surfaces as a genuine GraphQL `errors` entry
 * on the SAME response, not only as the silently-embedded `_workflowTransition`
 * field.
 *
 * Scope note: NOT every non-"applied" status is escalated this way. Codes
 * that represent write-verification uncertainty (`context-fetch-failed`,
 * `atomic-mutation-failed`, `transition-write-unverified`) or a benign
 * trailing-mutation no-op within the same logical multi-mutation command
 * (`no-transition`, `terminal-reentry-guard`) are deliberately excluded —
 * escalating those broke ~10 existing suites (AI-1860, AI-2472, AI-1809,
 * AI-2016, comment-requirement, inf-443) that rely on the current silent
 * fail-open for exactly those codes, several by design (AI-1860/AI-2035
 * same-command re-entrant mutations) and some as an artifact of static
 * (non-stateful) test mocks masking the same lag AI-1762 tolerates in
 * production. Only codes decided once, on the primary mutation, from a
 * resolvable policy/config fact are in the hard-fail set (see
 * `HARD_FAIL_CODES` in proxy.ts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";
import { clearImplementerStore } from "./implementer-store.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";
import { createApp } from "./index.js";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition]
roles:
  - id: steward
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// review's destination role ('ghost-role') has ZERO bodies filling it — the
// unresolvable-destination-owner shape (delegate-unresolved, AI-1493 fail-close
// for approve/reject specifically).
const WORKFLOW_YAML = `
id: inf489
version: 1
archetype: single-task
entry_state: intake
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: ghost-state
  - id: ghost-state
    owner_role: ghost-role
    kind: normal
    native_state: todo
    transitions: []
`;

const ISSUE_UUID = "11111111-2222-3333-4444-555555555555";
const IDENTIFIER = "INF-489-TEST";

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetch(): typeof globalThis.fetch {
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string };
    const query = parsed.query ?? "";

    if (query.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "c1" } } } });
    }
    if (query.includes("IssueContext") || query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: IDENTIFIER,
            team: { id: "team-uuid" },
            labels: {
              nodes: [
                { id: "wf-lbl", name: "wf:inf489" },
                { id: "intake-lbl", name: "state:intake" },
              ],
            },
            delegate: null,
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return json({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "wf-lbl", name: "wf:inf489" },
                { id: "intake-lbl", name: "state:intake" },
                { id: "ghost-lbl", name: "state:ghost-state" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [{ id: "state-todo-uuid", name: "Todo", type: "unstarted" }],
            },
          },
        },
      });
    }
    // Any actual mutation would mean the fail-close leaked a partial write.
    if (query.includes("issueUpdate") || query.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: {} });
  };
}

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      { name: "astrid", linearUserId: "u-astrid", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r", host: "local" },
    ],
  }), "utf8");
  return file;
}

describe("proxy — INF-489: blocked/failed B2 apply fails loudly (hard-fail code subset)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-489-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "inf489.yaml");
    fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;
    process.env.IMPLEMENTER_STORE_PATH = path.join(dir, "implementer-store.json");

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    clearImplementerStore();
    _resetAppliedStateStore();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("REGRESSION: 'approve' with an unresolvable destination owner (delegate-unresolved) surfaces as a real GraphQL error, not just _workflowTransition", async () => {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Cli-Version", "9.9.9")
      .set("X-Openclaw-Linear-Intent", "approve")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: ISSUE_UUID },
      });

    expect(res.status).toBe(200);

    // The underlying diagnostic is still there (existing AI-1809 contract)...
    expect(res.body._workflowTransition).toBeDefined();
    expect(res.body._workflowTransition.status).toBe("failed");
    expect(res.body._workflowTransition.code).toBe("delegate-unresolved");

    // ...but INF-489's fix means it is NO LONGER only that silent field: a
    // caller that only checks GraphQL `errors` (as the skill CLI's
    // linearGraphQL() does, and as the operator staring at `--debug` output
    // does) now sees the failure on THIS response, immediately.
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(res.body.errors[0].message).toContain("delegate-unresolved");
    expect(res.body.errors[0].extensions.code).toBe("WORKFLOW_TRANSITION_FAILED");
  });
});
