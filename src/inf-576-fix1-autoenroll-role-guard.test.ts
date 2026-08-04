/**
 * INF-576 Fix 1 — autoEnrollPlainDelegation must not enroll a plain-delegated
 * ticket into `wf:task` when the delegate fills NO `wf:task` owner role.
 *
 * Root cause (Igor's corrected analysis, confirmed by steward): a merge-tracker
 * directive minted ad-hoc and delegated to the merge gate (Hanzo) is promoted to
 * `wf:task` / `state:doing` by autoEnrollPlainDelegation. But `wf:task`'s only
 * owner roles are requester / department-head / worker — Hanzo (the `deployment`
 * role) fills none of them, so the routing-guard rejects every `handoff-work
 * Hanzo`, the delegate ping-pongs, and the cycle detector locks it to steward.
 *
 * Fix 1 = Option A: skip the enroll when the delegate fills no `wf:task` owner
 * role, leaving the ticket ad-hoc (un-gated) so the merge handoff just works.
 *
 * Failing-first: against unfixed code, delegate `hanzo` is enrolled (an
 * ApplyAtomicTransition label mutation fires), so the AC1 assertion below fails.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  autoEnrollPlainDelegation,
  getAutoEnrollLiveness,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

// `wf:task`-shaped def: owner roles are requester / department-head / worker.
const TASK_YAML = `
id: task
version: 2
archetype: single-task
entry_state: doing
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: requester
    kind: normal
    native_state: todo
    transitions:
      - command: request
        to: routing
  - id: routing
    owner_role: department-head
    kind: normal
    native_state: todo
    transitions:
      - command: assign
        to: doing
  - id: doing
    owner_role: worker
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: review
  - id: review
    owner_role: department-head
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

// Policy: hanzo fills only `deployment` (the merge gate) — none of task's roles.
const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: requester
  - id: department-head
  - id: worker
  - id: deployment
bodies:
  - id: ai
    container: steward
    fills_roles: [steward, requester]
  - id: astrid
    container: steward
    fills_roles: [department-head]
  - id: igor
    container: steward
    fills_roles: [worker]
  - id: hanzo
    container: steward
    fills_roles: [deployment]
`;

const TEAM_ID = "team-inf";
const AUTH = "Bearer tok-test";

interface FetchCall {
  query: string;
  variables: Record<string, unknown>;
}

function makeMockFetch(): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};
    calls.push({ query, variables });

    if (query.includes("IssueWithLabels")) {
      // Ad-hoc ticket: no wf:* / state:* labels yet.
      return json({
        data: {
          issue: {
            id: `internal-${variables.id}`,
            identifier: String(variables.id),
            team: { id: TEAM_ID },
            labels: { nodes: [] },
            delegate: null,
            assignee: null,
            state: { id: "s-todo" },
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
                { id: "wf-task-lbl", name: "wf:task" },
                { id: "state-doing-lbl", name: "state:doing" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ errors: [{ message: `unexpected query: ${query.slice(0, 80)}` }] }, 400);
  };
  return { fetch: mockFetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Count the label-stamp mutations for a given issue — the enrollment signal. */
function enrollStamps(calls: FetchCall[], issueId: string): FetchCall[] {
  return calls.filter(
    (c) => c.query.includes("ApplyAtomicTransition") && c.variables.issueId === `internal-${issueId}`,
  );
}

let dir: string;
let originalFetch: typeof globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf576-fix1-"));
  for (const k of ["CAPABILITY_POLICY_PATH", "WORKFLOW_DEF_PATH", "WORKFLOW_DEFS_DIR", "WORKFLOW_DEF_DIR"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
  process.env.WORKFLOW_DEF_PATH = path.join(dir, "task.yaml");
  delete process.env.WORKFLOW_DEFS_DIR;
  delete process.env.WORKFLOW_DEF_DIR;
  fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
  fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, TASK_YAML, "utf8");

  resetPolicyCache();
  resetWorkflowCache();

  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("INF-576 Fix 1 — autoEnrollPlainDelegation routability guard", () => {
  it("AC1: does NOT enroll a plain delegation whose delegate fills no wf:task owner role (merge gate)", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;
    const before = getAutoEnrollLiveness().suppressedUnroutableCount;

    const result = await autoEnrollPlainDelegation("INF-573", AUTH, undefined, undefined, "hanzo", null);

    expect(result.enrolled).toBe(false);
    expect(enrollStamps(mf.calls, "INF-573")).toHaveLength(0);
    expect(getAutoEnrollLiveness().suppressedUnroutableCount).toBe(before + 1);
  });

  it("AC2: still enrolls a plain delegation whose delegate fills a wf:task owner role (worker)", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    const result = await autoEnrollPlainDelegation("INF-600", AUTH, undefined, undefined, "igor", null);

    expect(result.enrolled).toBe(true);
    expect(result.workflowId).toBe("task");
    expect(result.entryState).toBe("doing");
    expect(enrollStamps(mf.calls, "INF-600").length).toBeGreaterThanOrEqual(1);
  });

  it("AC3: fails open (enrolls) when the delegate name is unknown/null — never silently suppress", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    const result = await autoEnrollPlainDelegation("INF-601", AUTH, undefined, undefined, null, null);

    expect(result.enrolled).toBe(true);
    expect(enrollStamps(mf.calls, "INF-601").length).toBeGreaterThanOrEqual(1);
  });
});
