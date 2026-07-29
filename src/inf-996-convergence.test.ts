/**
 * INF-996 — AI-1977 convergence: the proxy pre-compute and applyStateTransition
 * must resolve the SAME delegate for a bound role.
 *
 * The two paths are patched identically (PR-B), but "these two silently diverge"
 * is the entire AI-1977 failure class and identical-looking code drifts. This
 * drives a real transition INTO a bound state and asserts:
 *   resolveTransitionDelegate(...)  ==  the delegate applyStateTransition writes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  resolveTransitionDelegate,
  applyStateTransition,
  loadWorkflowDefById,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { recordBinding, clearImplementerStore } from "./implementer-store.js";

const ISSUE = "CHO-CONV-1";
const TOK = "Bearer test-token";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
  - id: reviewer
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition]
bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: reviewer
    fills_roles: [reviewer]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// Bound chore: review --request-changes--> implementation (owner_binding: bound).
const CHORE_YAML = `
id: chore
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: assign
        to: implementation
        assign: { mode: required }
  - id: implementation
    owner_role: dev
    owner_binding: bound
    native_state: todo
    transitions:
      - command: submit
        to: review
  - id: review
    owner_role: reviewer
    native_state: todo
    transitions:
      - command: request-changes
        to: implementation
        assign: { default: prior-implementer }
  - id: done
    kind: terminal
    native_state: done
`;

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}

let capturedDelegate: string | null | undefined;

/** Fetch mock: serves the transition context and captures the delegate applyStateTransition writes. */
function makeFetch(): typeof globalThis.fetch {
  capturedDelegate = undefined;
  const DEST_LABELS = [
    { id: "wf-lbl", name: "wf:chore" },
    { id: "state-implementation", name: "state:implementation" },
  ];
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = body.query ?? "";
    const vars = body.variables ?? {};

    if (query.includes("IssueWithLabels")) {
      return jsonResponse({
        data: {
          issue: {
            id: "internal-uuid-conv",
            identifier: ISSUE,
            team: { id: "team-uuid" },
            labels: { nodes: [{ id: "wf-lbl", name: "wf:chore" }, { id: "state-review", name: "state:review" }] },
            delegate: { id: "lin-charles" }, // the reviewer currently holds it
            assignee: null,
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return jsonResponse({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "wf-lbl", name: "wf:chore" },
                { id: "state-review", name: "state:review" },
                { id: "state-implementation", name: "state:implementation" },
                { id: "state-done", name: "state:done" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("TeamStates")) {
      return jsonResponse({
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
      return jsonResponse({ data: { issueLabelCreate: { success: true, issueLabel: { id: "x" } } } });
    }
    if (query.includes("ApplyAtomicTransition")) {
      capturedDelegate = (vars.delegateId as string | null | undefined); // the APPLIED delegate
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
    // Any read-back / verify: report the destination shape with the applied delegate.
    if (query.includes("issue")) {
      return jsonResponse({
        data: {
          issue: {
            id: "internal-uuid-conv",
            identifier: ISSUE,
            labels: { nodes: DEST_LABELS },
            delegate: capturedDelegate ? { id: capturedDelegate } : null,
            state: { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
          },
        },
      });
    }
    return jsonResponse({ data: {} });
  }) as unknown as typeof globalThis.fetch;
}

describe("INF-996 — AI-1977 convergence: pre-computed delegate == applied delegate (bound role)", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf996-conv-"));
    for (const k of ["WORKFLOW_DEF_PATH", "WORKFLOW_DEFS_DIR", "CAPABILITY_POLICY_PATH", "AGENTS_FILE"]) saved[k] = process.env[k];

    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const defFile = path.join(tmpDir, "chore.yaml");
    fs.writeFileSync(defFile, CHORE_YAML, "utf8");
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = defFile;

    const agentsFile = path.join(tmpDir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          { name: "igor", linearUserId: "lin-igor", openclawAgent: "igor", accessToken: "t", host: "local", app: true },
          { name: "charles", linearUserId: "lin-charles", openclawAgent: "charles", accessToken: "t", host: "local", app: true },
          { name: "astrid", linearUserId: "lin-astrid", openclawAgent: "astrid", accessToken: "t", host: "local" },
        ],
      }),
      "utf8",
    );
    process.env.AGENTS_FILE = agentsFile;
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    reloadAgents();
    process.env.IMPLEMENTER_STORE_PATH = path.join(tmpDir, `store-${Date.now()}.json`);
    clearImplementerStore();
    originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearImplementerStore();
    delete process.env.IMPLEMENTER_STORE_PATH;
  });

  it("both resolvers land on the SAME pinned body for a request-changes into a bound state", async () => {
    // igor is the pinned implementer for this chore.
    await recordBinding("internal-uuid-conv", "dev", "igor", "chore");

    const def = await loadWorkflowDefById("chore");
    const review = def!.states.find((s) => s.id === "review");
    const reqChanges = review!.transitions?.find((t) => t.command === "request-changes");

    // (1) proxy pre-compute
    const preComputed = await resolveTransitionDelegate("implementation", reqChanges, def!, "internal-uuid-conv");

    // (2) independent apply (no delegateOverride → applyStateTransition resolves on its own path)
    const result = await applyStateTransition("request-changes", "internal-uuid-conv", TOK, {
      sourceStateOverride: "review",
    });

    expect(result.status).toBe("applied");
    expect(preComputed).toBe("lin-igor");        // pre-compute resolved the pin
    expect(capturedDelegate).toBe("lin-igor");   // apply wrote the pin
    expect(preComputed).toBe(capturedDelegate);  // convergence: the two paths agree
  });
});
