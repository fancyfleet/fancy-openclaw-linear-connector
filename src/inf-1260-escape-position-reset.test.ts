/**
 * INF-1260: escape (break-glass) must preserve spine position, not reset to
 * intake.
 *
 * Bug: `applyStateTransition` (src/workflow-gate.ts:6224-6238) resolves the
 * break-glass destination unconditionally from `def.break_glass.to` (which
 * for dev-impl is the literal `intake`, src/registered-defs/dev-impl.yaml:102)
 * regardless of the ticket's current state. A ticket that escaped from
 * `code-review` or `implementation` — having already passed write-tests,
 * implementation, and possibly code-review — is reset all the way back to
 * `intake`, discarding all completed spine progress (AC3).
 *
 * These tests assert the DESIRED behavior (escape preserves the furthest-
 * reached state, or routes to a dedicated recovery state — NOT `intake`),
 * so they are RED against today's unconditional `break_glass.to: intake`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { applyStateTransition, resetNativeStateCache, resetWorkflowCache } from "./workflow-gate.js";
import { reloadAgents } from "./agents.js";

// A workflow fixture that mirrors dev-impl's spine shape closely enough to
// exercise the bug: break_glass.to is fixed at `intake`, same as production.
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
      ],
    }),
    "utf8",
  );
  return agentsFile;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeEscapeFetch(sourceStateLabel: string): {
  fetch: typeof globalThis.fetch;
  mutations: Array<Record<string, unknown>>;
  labels: () => Array<{ id: string; name: string }>;
} {
  let labels = [
    { id: "wf-lbl", name: "wf:dev-impl" },
    { id: `state-${sourceStateLabel}`, name: `state:${sourceStateLabel}` },
  ];
  const mutations: Array<Record<string, unknown>> = [];
  let delegateId: string | null = "u-astrid";
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
            identifier: "INF-1260-ESCAPE",
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
      mutations.push(vars);
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

describe("INF-1260 AC3 (escape position-reset): escape must preserve furthest-reached spine position", () => {
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

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1260-escape-pos-"));
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    process.env.AGENTS_FILE = writeAgents(dir);
    reloadAgents();
    resetWorkflowCache();
    resetNativeStateCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });

    if (originalWorkflowDefPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowDefPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalAgentsFile !== undefined) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
    if (originalCapabilityPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalCapabilityPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
  });

  it("AC7(escape position-reset): escape from 'code-review' does not reset to 'intake' — completed spine progress is preserved", async () => {
    const { fetch, labels } = makeEscapeFetch("code-review");
    globalThis.fetch = fetch;

    const result = await applyStateTransition("escape", "INF-1260-ESCAPE", "Bearer tok", {
      bodyId: "astrid",
    });

    // Desired: escape from a ticket that already reached code-review must
    // NOT land back at intake — either the furthest-reached state is
    // preserved, or a designated recovery state (never intake) is used.
    expect(result.to).not.toBe("intake");
    expect(labels().map((l) => l.name)).not.toContain("state:intake");
  });

  it("AC7(escape position-reset): escape from 'implementation' does not reset to 'intake'", async () => {
    const { fetch, labels } = makeEscapeFetch("implementation");
    globalThis.fetch = fetch;

    const result = await applyStateTransition("escape", "INF-1260-ESCAPE", "Bearer tok", {
      bodyId: "astrid",
    });

    expect(result.to).not.toBe("intake");
    expect(labels().map((l) => l.name)).not.toContain("state:intake");
  });
});
