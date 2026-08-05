/**
 * INF-1222: Governed transitions that are declined by policy must fail
 * loudly and atomically — no silent success, no partial mutation.
 *
 * Live incident (LIF-356, and self-reproduced live on INF-1222 2026-08-05
 * 11:01 UTC): a governed transition's atomic write failed/diverged AFTER the
 * B1/B2 policy gates had already passed it through, but the proxy only
 * attached a buried `_workflowTransition.status:"failed"` field — the
 * top-level response carried no `errors`, so the caller (agent or CLI) saw
 * what looked like an ordinary 200 and never retried or escalated. The
 * ticket sat stuck in `Doing` with its state:* label unadvanced and no
 * signal.
 *
 * INF-1147 already fixed this loud-decline requirement for exactly two
 * verb shapes: `submit`/`continue-workflow` (generic:continue) whose atomic
 * write fails, and `accept` (capture_ac) blocked pre-write by the
 * AC-of-record gate (see proxy.ts loudGenericFail / loudAcceptGate,
 * ~proxy.ts:2005-2033). INF-1222's AC explicitly widens this to "submit /
 * continue-workflow / peers" — i.e. every governed transition verb, not
 * just those two. This file targets a peer verb (a dev-impl transition out
 * of `implementation`, native status Doing) whose atomic write fails AFTER
 * the gates pass — the same failure shape INF-1147 fixed for two verbs,
 * still open for the rest.
 *
 * AC mapping (INF-1222 verbatim AC):
 *   AC1 (fail loudly): a policy-declined governed transition returns an
 *       explicit, non-empty decline naming the reason and current state —
 *       no silent success, no empty return.
 *   AC2 (atomic on decline): no delegate / state-label / status mutation is left
 *       dangling — either the transition fully applies, or it fully
 *       rejects and the ticket is left exactly as it was.
 *   AC3 (LIF-356 repro): a policy-declined governed transition on a ticket
 *       in Doing must not leave it silently stuck with no advance and no
 *       signal.
 *   AC4 (integration test): boots the governed-transition handler, drives
 *       a policy-declined transition, and asserts (a) decline surfaced to
 *       the caller, (b) no partial mutation occurred, (c) ticket not left
 *       in an inconsistent stuck state.
 *   AC5 (observability): the declined transition is recorded via
 *       operational-event/telemetry with reason + issue id.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache, _setTransitionWritePolicyForTests } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

// ── Fixtures (same policy/agent shape as ai-1809 / ai-1762) ───────────────

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// dev-impl shaped workflow with a peer governed transition (`flag`) out of
// `implementation` (native status Doing) that is NOT generic:continue and
// NOT capture_ac — i.e. outside the two verb shapes INF-1147 already loud-
// decline-protected. This is the LIF-356 "ticket in Doing" shape.
const WORKFLOW_YAML = `
id: dev-impl
version: 9
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: flag
        to: ac-validate
        requires_comment: true
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done
      - command: ac-fail
        to: implementation
        requires_comment: true
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

// Ticket sits in `implementation` (native Doing), delegated to igor — the
// LIF-356 "stuck in Doing" shape.
const IMPLEMENTATION_CONTEXT = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      delegate: { id: "u-igor" },
    },
  },
};

const IMPLEMENTATION_WITH_IDS = {
  data: {
    issue: {
      id: "internal-uuid",
      identifier: "LIF-356",
      team: { id: "team-uuid" },
      labels: {
        nodes: [
          { id: "wf-lbl", name: "wf:dev-impl" },
          { id: "impl-lbl", name: "state:implementation" },
        ],
      },
      delegate: { id: "u-igor" },
      assignee: { id: null },
      state: { id: "s-doing" },
    },
  },
};

const TEAM_LABELS = {
  data: {
    team: {
      labels: {
        nodes: [
          { id: "acv-lbl", name: "state:ac-validate" },
          { id: "impl-lbl", name: "state:implementation" },
        ],
      },
    },
  },
};

const TEAM_STATES = {
  data: {
    team: {
      states: {
        nodes: [
          { id: "s-todo", name: "Todo", type: "unstarted" },
          { id: "s-doing", name: "Doing", type: "started" },
          { id: "s-done", name: "Done", type: "completed" },
        ],
      },
    },
  },
};

const EXISTING_FEEDBACK_COMMENT = {
  id: "comment-dup-1",
  createdAt: new Date(Date.now() - 20_000).toISOString(),
  user: { id: "u-igor" },
  issue: { id: "issue-uuid", identifier: "LIF-356" },
};

// The AI-1759-class silent partial apply for the `flag` transition: the
// state:* label and native status land, but the delegate write silently
// drops — the exact "re-delegated but state never advanced" incident shape.
const DELEGATE_DROPPED_VERIFY = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
      delegate: null,
      state: { id: "s-todo" },
    },
  },
};

const UPSTREAM_OK = { data: { issueUpdate: { success: true, issue: { id: "issue-uuid" } } } };

// ── Test infrastructure (same harness pattern as ai-1809 / ai-1762) ───────

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok1", host: "local" },
      { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok2", host: "local" },
      { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok3", host: "local" },
    ],
  }), "utf8");
  return file;
}

describe("proxy — INF-1222 governed transitions fail loudly + atomically on policy decline", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-inf1222-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    _setTransitionWritePolicyForTests({ retryDelayMs: 0 });
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTransitionWritePolicyForTests();
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  /**
   * Full-stack fetch mock for the `flag` (implementation → ac-validate)
   * governed transition, with scriptable atomic-write outcomes — same
   * query-name routing pattern as ai-1809/ai-1762.
   */
  function makeFlagFetch(opts: {
    atomicResults?: boolean[];
    verifyResults?: object[];
  } = {}): { fetch: typeof globalThis.fetch; calls: Array<{ query: string; variables: Record<string, unknown> }> } {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    let atomicIdx = 0;
    let verifyIdx = 0;
    const json = (payload: object) => new Response(JSON.stringify(payload), {
      status: 200, headers: { "Content-Type": "application/json" },
    });

    const mockFetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      calls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
      const q = parsed.query ?? "";

      if (q.includes("SatisfiedByComment")) {
        return json({ data: { comment: EXISTING_FEEDBACK_COMMENT } });
      }
      if (q.includes("VerifyTransitionWrite")) {
        const results = opts.verifyResults ?? [];
        const payload = results[Math.min(verifyIdx, results.length - 1)];
        verifyIdx++;
        return json(payload);
      }
      if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
        return json(IMPLEMENTATION_CONTEXT);
      }
      if (q.includes("IssueWithLabels")) {
        return json(IMPLEMENTATION_WITH_IDS);
      }
      if (q.includes("TeamLabels")) {
        return json(TEAM_LABELS);
      }
      if (q.includes("TeamStates")) {
        return json(TEAM_STATES);
      }
      if (q.includes("ApplyAtomicTransition")) {
        const results = opts.atomicResults ?? [true];
        const success = results[Math.min(atomicIdx, results.length - 1)];
        atomicIdx++;
        return json({ data: { issueUpdate: { success } } });
      }
      return json(UPSTREAM_OK);
    };

    return { fetch: mockFetch, calls };
  }

  /** The governed `flag` transition, comment-satisfied via dedup header (as CLI ≥0.3.6 sends). */
  function flagWithSatisfiedBy() {
    return request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "igor")
      .set("X-Openclaw-Linear-Intent", "flag")
      .set("X-Openclaw-Comment-Satisfied-By", "comment-dup-1")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: "issue-uuid" },
      });
  }

  const atomicCalls = (calls: Array<{ query: string }>) =>
    calls.filter((c) => c.query.includes("ApplyAtomicTransition"));
  const forwardAtomicCalls = (calls: Array<{ query: string; variables: Record<string, unknown> }>) =>
    atomicCalls(calls).filter((c) => Array.isArray(c.variables.labelIds) && c.variables.labelIds.includes("acv-lbl"));
  const rollbackAtomicCalls = (calls: Array<{ query: string; variables: Record<string, unknown> }>) =>
    atomicCalls(calls).filter((c) => Array.isArray(c.variables.labelIds) && c.variables.labelIds.includes("impl-lbl"));

  // ── AC1 + AC3 + AC4: mutation-level atomic-write failure must decline loudly ──

  it("AC1/AC3/AC4: a governed peer-verb transition whose atomic write fails on every attempt returns an explicit top-level error naming the reason and current state — not just a buried _workflowTransition field", async () => {
    const { fetch: mock, calls } = makeFlagFetch({ atomicResults: [false] });
    globalThis.fetch = mock;

    const res = await flagWithSatisfiedBy();

    // The atomic write genuinely never applied.
    expect(res.body._workflowTransition?.status).toBe("failed");
    expect(res.body._workflowTransition?.code).toBe("atomic-mutation-failed");

    // AC1: the caller MUST receive an explicit, non-empty decline — not a
    // buried-only signal. This is the false-success LIF-356 exhibited: the
    // response looked like an ordinary 200 with no top-level `errors`.
    expect(res.body.errors).toBeDefined();
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    const message = String(res.body.errors[0].message ?? "");
    expect(message).toMatch(/implementation/);

    // The decline must not ALSO carry a Linear-success envelope alongside
    // the (buried) failure — that combination is the exact false-success
    // shape the AC forbids ("no silent success").
    expect(res.body.data?.issueUpdate?.success).not.toBe(true);

    // AC4(b): nothing partially landed — every atomic write attempt reported
    // failure, so no facet of {label, delegate, native state} was applied.
    expect(atomicCalls(calls).length).toBeGreaterThan(0);
  });

  // ── AC2 + AC4: verification-divergence failure must roll back AND decline loudly ──

  it("AC2/AC4: an atomic write that diverges on verification (delegate silently dropped) is rolled back to its pre-transition snapshot AND the decline is surfaced loudly to the caller", async () => {
    const { fetch: mock, calls } = makeFlagFetch({
      atomicResults: [true],
      verifyResults: [DELEGATE_DROPPED_VERIFY], // dropped delegate on every read-back
    });
    globalThis.fetch = mock;

    const res = await flagWithSatisfiedBy();

    expect(res.body._workflowTransition?.status).toBe("failed");
    expect(res.body._workflowTransition?.code).toBe("transition-write-unverified");

    // AC2: the connector's own atomicity mechanism (rollback-to-snapshot)
    // must actually have fired — the ticket must not be left half-advanced
    // (label moved, delegate dropped). This is a regression lock on the
    // existing rollback machinery; the new requirement is the loud surface
    // below.
    expect(rollbackAtomicCalls(calls).length).toBe(1);

    // AC1/AC2: the caller must be told, loudly, that the transition did not
    // apply — a silently-declined transition IS the LIF-356 stuck-ticket
    // symptom (delegate/state left in an ambiguous state with no signal to
    // act on).
    expect(res.body.errors).toBeDefined();
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    const message = String(res.body.errors[0].message ?? "");
    expect(message).toMatch(/implementation/);
    expect(res.body.data?.issueUpdate?.success).not.toBe(true);

    // AC5: the decline must be independently observable (reason + issue id)
    // via telemetry, not only via the (currently missing) loud response —
    // diagnosis must not depend on the caller having surfaced the failure.
    const events = appState.operationalEventStore.query({ outcome: "transition-write-failed" });
    expect(events.length).toBeGreaterThan(0);
    const event = events.find((e) => e.key === "LIF-356");
    expect(event).toBeDefined();
    expect(event?.errorSummary ?? "").toMatch(/delegate/);
  });
});
