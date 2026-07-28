/**
 * INF-933: Terminal re-entry guard blocks the dept-engine `loop` transition —
 * continuous-loop instances are one-shot, ENG cycle 2 cannot start.
 *
 * The AI-2035 terminal re-entry guard in `applyStateTransition` refuses ANY
 * non-break-glass intent whose authoritative (getAppliedState-backed) source is
 * a terminal state. That is correct for the bounce it was built to stop — an
 * UNDECLARED re-entrant write, whose intent matches a forward edge off the
 * stale PRE-terminal state (the Done→Doing bounce). But a `continuous-loop`
 * workflow declares an outgoing edge ON its terminal state: the `loop` command
 * deliberately re-enters the cycle from `done` to run the next iteration. The
 * guard could not tell the two apart, so it refused `loop` too — making every
 * continuous-loop instance one-shot (the live ENG dept-engine wall: it reaches
 * `done` after cycle 1 and can never start cycle 2).
 *
 * ── Scope (from the filing / steward triage) ─────────────────────────────────
 *   Exempt definition-declared terminal-exit transitions (continuous-loop
 *   `loop`) from the AI-2035 terminal-reentry guard, while keeping guard
 *   coverage for undeclared re-entrant writes.
 *
 * The distinguishing predicate: does the terminal source state declare an
 * outgoing transition whose `command` IS this intent? If yes → declared
 * terminal-exit, allow. If no → undeclared re-entrant write, refuse (unchanged).
 *
 * These tests exercise `applyStateTransition` directly, mirroring the AI-2035
 * guard suite's harness. The `loop`-allowed test is RED against the unfixed
 * code (the guard blocks it); the undeclared-`run`-blocked test is the
 * non-regression proof that the guard still bites, and passes both ways.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { reloadAgents } from "./agents.js";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { recordAppliedState, _resetAppliedStateStore } from "./store/applied-state-store.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: workflow:break-glass
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: dev
    grants: [linear:transition]
roles:
  - id: steward
    requires: [human:escalate]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// A continuous-loop workflow whose TERMINAL `done` state declares an outgoing
// `loop` edge back to the cycle entry (`evaluating`). This is the exact shape
// the guard was over-blocking. `run` is the forward edge OFF the pre-terminal
// `evaluating` state — the undeclared re-entrant write the guard must still stop.
const TEST_WORKFLOW_YAML = `
id: dept-engine
version: 1
archetype: continuous-loop
entry_state: evaluating
break_glass:
  command: escape
  to: evaluating
  owner_role: steward
states:
  - id: evaluating
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: run
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions:
      - command: loop
        to: evaluating
`;

const IDENTIFIER = "INF-933";

interface FetchCall {
  url: string;
  body: { query?: string; variables?: Record<string, unknown> };
}

function makeTransitionFetch(opts: {
  issueLabels: Array<{ id: string; name: string }>;
  teamLabels: Array<{ id: string; name: string }>;
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    calls.push({ url, body: parsed });
    const query = parsed.query ?? "";
    const json = (payload: object) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

    if (query.includes("IssueWithLabels")) {
      return json({
        data: {
          issue: {
            id: "internal-uuid",
            identifier: IDENTIFIER,
            team: { id: "team-uuid" },
            labels: { nodes: opts.issueLabels },
          },
        },
      });
    }
    if (query.includes("TeamStateLabels")) {
      return json({ data: { issue: { team: { labels: { nodes: opts.teamLabels } } } } });
    }
    if (query.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: opts.teamLabels } } } });
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
    if (query.includes("VerifyTransitionWrite")) {
      return json({ data: { issue: null } });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("UpdateDelegate")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
  };
  return { fetch: mockFetch, calls };
}

const atomicCalls = (calls: FetchCall[]) =>
  calls.filter((c) => (c.body.query ?? "").includes("ApplyAtomicTransition"));

// ── Suite ────────────────────────────────────────────────────────────────────

describe("INF-933: continuous-loop terminal-exit exemption (AI-2035 guard carve-out)", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-933-loop-"));
    const workflowFile = path.join(dir, "dept-engine.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
      ],
    }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    _resetAppliedStateStore();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetAppliedStateStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const TEAM_LABELS = [
    { id: "done-lbl", name: "state:done" },
    { id: "evaluating-lbl", name: "state:evaluating" },
  ];
  // Live label read at the terminal state — a deliberate `loop` command is a
  // fresh turn, so the source is genuinely `done` (no lag). We still record the
  // applied state to exercise the guard's authoritative resolution path.
  const DONE_LABELS = [
    { id: "wf-lbl", name: "wf:dept-engine" },
    { id: "done-lbl", name: "state:done" },
  ];

  it("RED: allows the definition-declared `loop` terminal-exit off terminal `done` (continuous-loop cycle 2)", async () => {
    // Cycle 1 landed the instance at terminal `done` and recorded it.
    recordAppliedState(IDENTIFIER, "done");

    const { fetch: mock, calls } = makeTransitionFetch({ issueLabels: DONE_LABELS, teamLabels: TEAM_LABELS });
    globalThis.fetch = mock;

    // `loop` is declared ON the terminal `done` state — the guard must exempt it.
    const result = await applyStateTransition("loop", IDENTIFIER, "Bearer tok", {
      sourceStateOverride: "done",
    });

    // Unfixed code: guard refuses every non-break-glass intent off terminal →
    // status "blocked" / code "terminal-reentry-guard". Fixed: applied, cycles
    // back to `evaluating`.
    expect(result.status).toBe("applied");
    expect(result.to).toBe("evaluating");
    expect(atomicCalls(calls).length).toBeGreaterThan(0);
  });

  it("non-regression: still blocks an UNDECLARED re-entrant write off terminal `done` (the AI-2035 bounce)", async () => {
    // Write 1 recorded terminal `done`; a trailing same-turn mutation re-enters
    // with `run` (a forward edge off the stale PRE-terminal `evaluating`). `done`
    // does NOT declare `run`, so the guard must still refuse it.
    recordAppliedState(IDENTIFIER, "done");

    const LAG_LABELS = [
      { id: "wf-lbl", name: "wf:dept-engine" },
      { id: "evaluating-lbl", name: "state:evaluating" },
    ];
    const { fetch: mock, calls } = makeTransitionFetch({ issueLabels: LAG_LABELS, teamLabels: TEAM_LABELS });
    globalThis.fetch = mock;

    const result = await applyStateTransition("run", IDENTIFIER, "Bearer tok", {
      sourceStateOverride: "evaluating",
    });

    expect(result.status).toBe("blocked");
    expect(result.code).toBe("terminal-reentry-guard");
    expect(atomicCalls(calls).length).toBe(0);
  });

  it("non-regression: break-glass escape remains legal off terminal `done`", async () => {
    recordAppliedState(IDENTIFIER, "done");
    const { fetch: mock, calls } = makeTransitionFetch({ issueLabels: DONE_LABELS, teamLabels: TEAM_LABELS });
    globalThis.fetch = mock;

    const result = await applyStateTransition("escape", IDENTIFIER, "Bearer tok", {
      sourceStateOverride: "done",
    });

    expect(result.status).toBe("applied");
    expect(result.to).toBe("evaluating");
    expect(atomicCalls(calls).length).toBeGreaterThan(0);
  });
});
