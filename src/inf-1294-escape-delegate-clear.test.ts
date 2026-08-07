/**
 * INF-1294: escape (break-glass) silently no-ops on mid-spine dev-impl tickets
 * (delegate not cleared).
 *
 * Bug: `applyStateTransition` (src/workflow-gate.ts) resolves a mid-spine
 * escape to the SAME state (position preservation, INF-1260 AC3), then the
 * downstream idempotency branch (`currentStateName === toStateName`, ~L6766)
 * hits `return { status: "noop", code: "already-in-state" }` (~L6809) BEFORE
 * any delegate write. The `handoff-work` intent has an explicit fall-through
 * exception ("don't short-circuit — the delegate must be written even though
 * the state label doesn't change"), but `escape` has NO equivalent exception —
 * so the documented delegate-clear (workflow-gate.ts:6280, "the delegate is
 * cleared but the position is preserved") never fires. The caller gets a
 * silent noop while native state, `state:*` label, AND delegate all remain
 * unchanged (the INF-1278 redispatch loop: 11+ silent escape failures).
 *
 * AC1: Mid-spine escape that preserves the current spine position must not
 *      short-circuit before the ownership write; the documented delegate-clear
 *      behavior is executed (or an equivalent atomic write path is proven).
 * AC2: If escape resolves to same-state preservation and cannot/should not
 *      mutate the ticket, the command returns an ACTIONABLE decline instead of
 *      a silent `noop` / `already-in-state` — including guidance to use
 *      `reject` to move backward to intake, and the current state's forward
 *      verb to move forward.
 * AC3 (regression): native state, `state:*` label, and delegate are NOT all
 *      left unchanged while the caller receives only an already-in-state/no-op
 *      result.
 *
 * These tests assert the DESIRED behavior, so they are RED against today's
 * implementation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { applyStateTransition, resetNativeStateCache, resetWorkflowCache } from "./workflow-gate.js";
import { reloadAgents } from "./agents.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";

// A workflow fixture mirroring dev-impl's spine: break_glass.to is `intake`
// (same as production src/registered-defs/dev-impl.yaml), so a ticket past
// intake exercises the position-preservation branch.
const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
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
        to: write-tests
  - id: write-tests
    owner_role: test-author
    kind: normal
    native_state: todo
    transitions:
      - command: tests-ready
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: merge
  - id: merge
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: deploy
  - id: deploy
    owner_role: host-deploy
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

function writeAgents(dir: string): string {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "tdd", linearUserId: "u-tdd", openclawAgent: "tdd", accessToken: "tok-tdd", host: "local" },
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      ],
    }),
    "utf8",
  );
  return agentsFile;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Mock fetch for a governed mid-spine ticket (state:* label present, delegate
 * set). Records every ApplyAtomicTransition mutation so tests can assert on
 * the delegate value actually written.
 */
function makeEscapeFetch(sourceStateLabel: string, opts?: { delegate?: string | null }): {
  fetch: typeof globalThis.fetch;
  mutations: Array<{ delegateId: unknown; stateId: unknown; labelIds: unknown }>;
  labels: () => Array<{ id: string; name: string }>;
} {
  let labels = [
    { id: "wf-lbl", name: "wf:dev-impl" },
    { id: `state-${sourceStateLabel}`, name: `state:${sourceStateLabel}` },
  ];
  const mutations: Array<{ delegateId: unknown; stateId: unknown; labelIds: unknown }> = [];
  let delegateId: string | null = opts?.delegate !== undefined ? opts.delegate : "u-tdd";
  let nativeStateId: string | null = "native-todo";

  const allTeamLabels = [
    { id: "wf-lbl", name: "wf:dev-impl" },
    { id: "state-intake", name: "state:intake" },
    { id: "state-write-tests", name: "state:write-tests" },
    { id: "state-implementation", name: "state:implementation" },
    { id: "state-code-review", name: "state:code-review" },
    { id: "state-merge", name: "state:merge" },
    { id: "state-deploy", name: "state:deploy" },
  ];

  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = body.query ?? "";

    if (query.includes("IssueWithLabels")) {
      return jsonResponse({
        data: {
          issue: {
            id: "issue-uuid",
            identifier: "INF-1294-ESCAPE",
            team: { id: "team-inf" },
            labels: { nodes: labels },
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return jsonResponse({ data: { team: { labels: { nodes: allTeamLabels } } } });
    }

    if (query.includes("TeamStates")) {
      return jsonResponse({ data: { team: { states: { nodes: [{ id: "native-todo", name: "Todo", type: "unstarted" }] } } } });
    }

    if (query.includes("ApplyAtomicTransition")) {
      const vars = body.variables ?? {};
      mutations.push({
        delegateId: vars.delegateId ?? null,
        stateId: vars.stateId ?? null,
        labelIds: vars.labelIds ?? null,
      });
      const nextLabelIds = new Set((vars.labelIds as string[]) ?? []);
      labels = allTeamLabels.filter((l) => nextLabelIds.has(l.id));
      if ("delegateId" in vars) delegateId = vars.delegateId as string | null;
      if ("stateId" in vars) nativeStateId = vars.stateId as string | null;
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }

    if (query.includes("VerifyTransitionWrite")) {
      return jsonResponse({
        data: {
          issue: {
            labels: { nodes: labels.map(({ name }) => ({ name })) },
            delegate: delegateId ? { id: delegateId } : null,
            assignee: null,
            state: nativeStateId ? { id: nativeStateId } : null,
          },
        },
      });
    }

    if (query.includes("commentCreate")) {
      return jsonResponse({ data: { commentCreate: { success: true, comment: { id: "c-1" } } } });
    }

    throw new Error(`unexpected query: ${query.slice(0, 80)}`);
  };

  return { fetch, mutations, labels: () => labels };
}

describe("INF-1294 (escape delegate-clear): mid-spine escape must not short-circuit before the ownership write", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowDefPath: string | undefined;
  let originalAgentsFile: string | undefined;
  let originalCapabilityPolicyPath: string | undefined;

  beforeEach(() => {
    originalWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;
    originalCapabilityPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1294-escape-"));
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    process.env.AGENTS_FILE = writeAgents(dir);
    reloadAgents();
    resetWorkflowCache();
    resetNativeStateCache();
    _resetAppliedStateStore();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetAppliedStateStore();
    fs.rmSync(dir, { recursive: true, force: true });

    if (originalWorkflowDefPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowDefPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalAgentsFile !== undefined) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
    if (originalCapabilityPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalCapabilityPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
  });

  it("AC1: mid-spine escape from 'write-tests' clears the delegate via the atomic write (not a silent noop)", async () => {
    // A ticket in write-tests (beyond intake, so position-preservation kicks
    // in) with the test-author seated as delegate. Escape must clear the
    // delegate — the documented behavior at workflow-gate.ts:6280 — via an
    // atomic write, exactly like the handoff-work fall-through exception.
    const { fetch, mutations, labels } = makeEscapeFetch("write-tests", { delegate: "u-tdd" });
    globalThis.fetch = fetch;

    const result = await applyStateTransition("escape", "INF-1294-ESCAPE", "Bearer tok", {
      bodyId: "astrid",
    });

    // The escape must NOT resolve to a silent already-in-state noop.
    expect(result.status).not.toBe("noop");
    expect(result.code).not.toBe("already-in-state");

    // Position is preserved (spine stays at write-tests)...
    expect(labels().map((l) => l.name)).toContain("state:write-tests");
    // ...but an atomic ownership write fired, and it clears the delegate.
    const delegateWrites = mutations.filter((m) => "delegateId" in m && m.delegateId !== undefined);
    expect(delegateWrites.length).toBeGreaterThan(0);
    expect(delegateWrites[delegateWrites.length - 1].delegateId).toBeNull();
  });

  it("AC1: mid-spine escape from 'implementation' clears the delegate, preserving spine position", async () => {
    const { fetch, mutations, labels } = makeEscapeFetch("implementation", { delegate: "u-igor" });
    globalThis.fetch = fetch;

    const result = await applyStateTransition("escape", "INF-1294-ESCAPE", "Bearer tok", {
      bodyId: "astrid",
    });

    expect(result.status).not.toBe("noop");
    expect(result.code).not.toBe("already-in-state");
    expect(labels().map((l) => l.name)).toContain("state:implementation");
    const delegateWrites = mutations.filter((m) => "delegateId" in m && m.delegateId !== undefined);
    expect(delegateWrites.length).toBeGreaterThan(0);
    expect(delegateWrites[delegateWrites.length - 1].delegateId).toBeNull();
  });

  it("AC2: a mid-spine escape that cannot mutate must decline actionably (reject backward / forward verb), never a silent already-in-state", async () => {
    // Whatever the implementation decides — clear the delegate (AC1 path) or
    // decline — the caller must NEVER receive the bare `{status:"noop",
    // code:"already-in-state"}` shape with no guidance. If the result is a
    // no-op/decline, it must name both recovery verbs: `reject` to move
    // backward to intake, and the current state's forward verb.
    const { fetch } = makeEscapeFetch("write-tests", { delegate: "u-tdd" });
    globalThis.fetch = fetch;

    const result = await applyStateTransition("escape", "INF-1294-ESCAPE", "Bearer tok", {
      bodyId: "astrid",
    });

    // Forbidden shape: silent already-in-state noop.
    expect(result.code).not.toBe("already-in-state");

    // If the implementation declines (noop/blocked/failed), the decline must
    // be actionable: it tells the caller how to move backward (reject) and
    // forward (the state's forward verb), and does not pretend the ticket
    // changed.
    if (result.status === "noop" || result.status === "blocked" || result.status === "failed") {
      expect(result.detail).toBeTruthy();
      expect(String(result.detail)).toMatch(/reject/);
      expect(String(result.detail)).toMatch(/forward/);
    }
  });

  it("AC3 (regression): native state, state:* label, and delegate are not all left unchanged while the caller gets only already-in-state/noop", async () => {
    // The INF-1278 failure mode, expressed as an invariant: for a mid-spine
    // escape, it must never be the case that (a) no atomic write fires,
    // (b) the delegate stays seated, AND (c) the caller receives a bare
    // already-in-state noop. Under the AC1 fix, the atomic delegate-clear
    // write fires; under AC2, a noop would carry actionable detail. Both
    // satisfy the invariant; today's code satisfies none of them.
    const { fetch, mutations, labels } = makeEscapeFetch("write-tests", { delegate: "u-tdd" });
    globalThis.fetch = fetch;

    const result = await applyStateTransition("escape", "INF-1294-ESCAPE", "Bearer tok", {
      bodyId: "astrid",
    });

    const delegateWrites = mutations.filter((m) => "delegateId" in m && m.delegateId !== undefined);
    const writeFired = delegateWrites.length > 0;
    const delegateCleared = writeFired && delegateWrites[delegateWrites.length - 1].delegateId === null;
    const silentNoop = result.status === "noop" && result.code === "already-in-state" && !result.detail;

    // NOT (everything unchanged + silent noop): if no write fired and the
    // result is a silent noop, the delegate must not still be seated —
    // otherwise this is exactly the INF-1278 dead loop.
    expect(writeFired || delegateCleared || !silentNoop).toBe(true);

    // When the write fires (AC1 fix path), it must clear the delegate and
    // preserve the spine position (never reset to intake).
    if (writeFired) {
      expect(delegateCleared).toBe(true);
      expect(labels().map((l) => l.name)).toContain("state:write-tests");
      expect(labels().map((l) => l.name)).not.toContain("state:intake");
    }
  });
});
