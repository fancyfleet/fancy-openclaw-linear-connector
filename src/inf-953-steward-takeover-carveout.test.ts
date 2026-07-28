/**
 * INF-953 — Connector: raw delegate-only guard blocks steward-takeover against a
 * live wrong delegate (no break-glass carve-out).
 *
 * `checkRawMutationInterception`'s delegate-only guard has three sibling authz
 * branches whose non-delegate/non-steward callers are blocked but whose STEWARD
 * (break_glass.owner_role) callers are carved out:
 *   - escape           (workflow-gate.ts §4.4 / AI-1668)
 *   - refuse-work       (AI-1460 / AI-1574)
 *   - first-delegate    (AI-1570 — establishes a delegate when the field is EMPTY)
 *
 * The raw delegate-only re-route branch — "caller is a known non-delegate,
 * delegate is live" — had NO such carve-out. Consequence: when a ticket sits on a
 * *live wrong* delegate (e.g. a dead/stale session, or a mis-routed owner), the
 * workflow steward could NOT take it over with a raw `handoff-work`-shaped
 * re-route, even though the steward can freely establish a delegate on the same
 * ticket the moment its delegate field is empty. The steward was forced to escape
 * (blowing away the workflow state) instead of simply re-homing the ticket.
 *
 * Fix: mirror the sibling carve-outs. A steward may re-route (non-null takeover) a
 * ticket off a live wrong delegate. A null self-clear is still caught earlier by
 * the isClearingDelegate guard (AI-1835/AI-1857) and remains an escape concern —
 * the steward carve-out only lets the field be handed to a correct owner.
 *
 * AC1 is RED against the unfixed code (steward is blocked). AC2/AC3 are regression
 * guards (non-steward still blocked; current delegate still allowed) and pass on
 * both sides of the fix.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache, checkRawMutationInterception } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: test-author
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: test-author
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: tdd
    container: test-author
    fills_roles: [test-author]
`;

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
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: code-review
  - id: code-review
    owner_role: dev
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
        { name: "hanzo", linearUserId: "u-hanzo", openclawAgent: "hanzo", accessToken: "tok-hanzo", host: "local" },
        { name: "tdd", linearUserId: "u-tdd", openclawAgent: "tdd", accessToken: "tok-tdd", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

/**
 * Fetch mock: a governed dev-impl ticket in `implementation` state whose current
 * (live) delegate is `u-tdd` — the "wrong" delegate a steward wants to take over.
 */
function makeLiveWrongDelegateFetch(): typeof globalThis.fetch {
  return async () =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
            delegate: { id: "u-tdd" },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

/** A raw `handoff-work`-shaped re-route: change delegateId to a new (non-null) owner. */
function reRouteBody(newDelegateId: string) {
  return {
    query: `mutation ReRoute($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    variables: { id: "issue-uuid", input: { delegateId: newDelegateId } },
  };
}

let dir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-953-steward-takeover-"));
  process.env.AGENTS_FILE = writeAgents(dir);
  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;
  const workflowFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;
  resetPolicyCache();
  resetWorkflowCache();
  reloadAgents();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.AGENTS_FILE;
});

// ── AC1: steward may re-route off a live wrong delegate (RED before fix) ──────

describe("INF-953 AC1: workflow steward may take over a live wrong delegate", () => {
  it("allows a steward (astrid) to re-route a ticket whose live delegate is someone else", async () => {
    globalThis.fetch = makeLiveWrongDelegateFetch();
    // astrid fills break_glass.owner_role (steward); current delegate is u-tdd.
    const result = await checkRawMutationInterception(
      reRouteBody("u-charles"), "issue-uuid", "Bearer tok", "astrid", "u-astrid",
    );
    // After fix: the break-glass carve-out fires → null (allowed).
    // Before fix: blocked with the "not the current delegate" message.
    expect(result).toBeNull();
  });
});

// ── AC2: non-delegate, non-steward is still blocked (regression guard) ────────

describe("INF-953 AC2: a non-delegate, non-steward re-route stays blocked", () => {
  it("blocks hanzo (deployment role, not delegate, not steward) from re-routing", async () => {
    globalThis.fetch = makeLiveWrongDelegateFetch();
    const result = await checkRawMutationInterception(
      reRouteBody("u-charles"), "issue-uuid", "Bearer tok", "hanzo", "u-hanzo",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toMatch(/not the current delegate/i);
  });

  it("block message names the steward as an alternative authorized re-router", async () => {
    globalThis.fetch = makeLiveWrongDelegateFetch();
    const result = await checkRawMutationInterception(
      reRouteBody("u-charles"), "issue-uuid", "Bearer tok", "hanzo", "u-hanzo",
    );
    expect(result).toMatch(/steward/i);
  });
});

// ── AC3: the current delegate may still re-route their own ticket (unchanged) ─

describe("INF-953 AC3: current delegate re-route is unaffected", () => {
  it("allows tdd (the current delegate) to re-route to a new owner", async () => {
    globalThis.fetch = makeLiveWrongDelegateFetch();
    const result = await checkRawMutationInterception(
      reRouteBody("u-charles"), "issue-uuid", "Bearer tok", "tdd", "u-tdd",
    );
    expect(result).toBeNull();
  });
});
