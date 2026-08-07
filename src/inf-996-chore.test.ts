/**
 * INF-996 PR-D — wf:chore behavior. Drives real applyStateTransition against the
 * registered chore def and asserts the bound-seat contract end to end:
 *   - intake --assign <impl>--> implementation seats the NAMED implementer and pins it
 *   - review --request-changes--> implementation returns to the SAME bound implementer
 *     (never re-pooled), with no target supplied
 *   - implementation --submit--> review seats the STEWARD as reviewer (bound) — always
 *     != the implementer (implementer never reviews their own chore)
 *   - escape --> intake CLEARS the bindings so a re-intake re-binds fresh (the down-/
 *     deregistered-owner recovery)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { applyStateTransition, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { getBinding, getBindings, recordBinding, clearImplementerStore } from "./implementer-store.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";

const ISSUE = "internal-uuid-chore";
const TOK = "Bearer test-token";
const CHORE_FIXTURE = path.resolve(process.cwd(), "src/registered-defs/chore.yaml");

const POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}

let capturedDelegate: string | null | undefined;
let capturedWrite: { stateId?: string; labelIds: string[] };

/** Fetch mock: serves the issue at `currentState` and reflects the applied write (so the
 *  read-after-write verify in applyStateTransition sees the new state/delegate). */
function makeFetch(currentState: string, delegateId: string | null): typeof globalThis.fetch {
  capturedDelegate = undefined;
  capturedWrite = { labelIds: [] };
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
            id: ISSUE,
            identifier: "CHO-1",
            team: { id: "team-uuid" },
            labels: { nodes: [{ id: "wf-lbl", name: "wf:chore" }, { id: `state-${currentState}`, name: `state:${currentState}` }] },
            delegate: delegateId ? { id: delegateId } : null,
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
              nodes: ["intake", "implementation", "review", "parked", "done"].map((s) => ({ id: `state-${s}`, name: `state:${s}` }))
                .concat([{ id: "wf-lbl", name: "wf:chore" }]),
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
                { id: "s-todo", name: "Todo", type: "unstarted" },
                { id: "s-doing", name: "Doing", type: "started" },
                { id: "s-done", name: "Done", type: "completed" },
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
      capturedDelegate = vars.delegateId as string | null | undefined;
      capturedWrite = {
        stateId: vars.stateId as string | undefined,
        labelIds: (vars.labelIds as string[] | undefined) ?? [],
      };
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("issue")) {
      // read-back / verify: reflect exactly what ApplyAtomicTransition wrote.
      const nameFor = (id: string) => (id === "wf-lbl" ? "wf:chore" : id.replace(/^state-/, "state:"));
      const stTypeName: Record<string, [string, string]> = {
        "s-todo": ["Todo", "unstarted"],
        "s-doing": ["Doing", "started"],
        "s-done": ["Done", "completed"],
      };
      const st = capturedWrite.stateId ?? "s-todo";
      const [stName, stType] = stTypeName[st] ?? ["Todo", "unstarted"];
      return jsonResponse({
        data: {
          issue: {
            id: ISSUE,
            identifier: "CHO-1",
            labels: { nodes: capturedWrite.labelIds.map((id) => ({ id, name: nameFor(id) })) },
            delegate: capturedDelegate ? { id: capturedDelegate } : null,
            state: { id: st, name: stName, type: stType },
          },
        },
      });
    }
    return jsonResponse({ data: {} });
  }) as unknown as typeof globalThis.fetch;
}

describe("INF-996 PR-D — wf:chore bound-seat behavior", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf996-chore-"));
    for (const k of ["WORKFLOW_DEF_PATH", "WORKFLOW_DEFS_DIR", "CAPABILITY_POLICY_PATH", "AGENTS_FILE"]) saved[k] = process.env[k];

    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = CHORE_FIXTURE;

    const agentsFile = path.join(tmpDir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          { name: "igor", linearUserId: "lin-igor", openclawAgent: "igor", accessToken: "t", host: "local", app: true },
          { name: "noah", linearUserId: "lin-noah", openclawAgent: "noah", accessToken: "t", host: "local", app: true },
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
    process.env.IMPLEMENTER_STORE_PATH = path.join(tmpDir, `store-${Date.now()}-${Math.floor(process.hrtime()[1])}.json`);
    clearImplementerStore();
    // Module-level applied-state store is keyed by ticket identifier ("CHO-1"
    // here) and otherwise leaks across tests in this describe block, since
    // every test shares that hardcoded identifier (same root cause as AI-2542).
    _resetAppliedStateStore();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearImplementerStore();
    delete process.env.IMPLEMENTER_STORE_PATH;
  });

  it("intake --assign igor--> implementation seats the named implementer and PINS it", async () => {
    globalThis.fetch = makeFetch("intake", "lin-astrid");
    const result = await applyStateTransition("assign", ISSUE, TOK, { sourceStateOverride: "intake", cliTarget: "igor" });
    expect(result.status).toBe("applied");
    expect(capturedDelegate).toBe("lin-igor");                  // the named implementer is seated
    expect(await getBinding(ISSUE, "implementer")).toBe("igor"); // ...and pinned
  });

  it("review --request-changes--> implementation returns to the SAME bound implementer, no target, never re-pooled", async () => {
    await recordBinding(ISSUE, "implementer", "igor", "chore"); // igor is pinned
    globalThis.fetch = makeFetch("review", "lin-astrid");
    // NO cliTarget — the bound pin must resolve on its own.
    const result = await applyStateTransition("request-changes", ISSUE, TOK, {
      sourceStateOverride: "review",
      feedback: { category: "incomplete", text: "please fix" },
    });
    expect(result.status).toBe("applied");
    expect(capturedDelegate).toBe("lin-igor"); // returned to the bound implementer, not a pool pick
  });

  it("implementation --submit--> review seats the STEWARD as reviewer (bound) — != the implementer", async () => {
    await recordBinding(ISSUE, "implementer", "igor", "chore");
    globalThis.fetch = makeFetch("implementation", "lin-igor");
    const result = await applyStateTransition("submit", ISSUE, TOK, { sourceStateOverride: "implementation" });
    expect(result.status).toBe("applied");
    expect(capturedDelegate).toBe("lin-astrid");                 // steward reviews
    expect(await getBinding(ISSUE, "steward")).toBe("astrid");   // reviewer pinned
    expect(capturedDelegate).not.toBe("lin-igor");               // reviewer != implementer
  });

  it("escape from implementation preserves position (INF-1260 AC3 + INF-1294) — delegate+binding cleared, re-intake re-binds fresh", async () => {
    await recordBinding(ISSUE, "implementer", "igor", "chore");
    expect(await getBindings(ISSUE)).toEqual({ implementer: "igor" });

    globalThis.fetch = makeFetch("implementation", "lin-igor");
    const escaped = await applyStateTransition("escape", ISSUE, TOK, { sourceStateOverride: "implementation" });
    // INF-1260 AC3: preserves spine position (not back to intake).
    // INF-1294: spine-preserved escape clears the delegate via the atomic write
    // and the cleanup path clears bound seats (clearTicketBindings) so re-intake
    // re-binds fresh — the prior silent noop left the seat wedged (INF-1278 loop).
    expect(escaped.status).toBe("applied");
    expect(escaped.to).toBe("implementation");
    expect(capturedDelegate).toBeNull();
    // Bindings are cleared on escape (recovery path) — getBindings returns
    // null (no record) once clearTicketBindings drops the ticket.
    expect(await getBindings(ISSUE)).toBeNull();

    // Re-intake re-binds to a DIFFERENT implementer cleanly.
    globalThis.fetch = makeFetch("intake", "lin-astrid");
    await applyStateTransition("assign", ISSUE, TOK, { sourceStateOverride: "intake", cliTarget: "noah" });
    expect(await getBinding(ISSUE, "implementer")).toBe("noah");
  });
});
