/**
 * INF-1217: Governed-transition gate checks delegate identity, not owner_role
 * membership — any caller can act on an un-delegated ticket.
 *
 * `checkWorkflowRules`'s delegate-identity gate (workflow-gate.ts, the
 * `callerLinearUserId !== delegateId` block) is only reachable when a
 * delegate is set. When a state has no delegate — every ticket's first
 * moment after enrollment, before its steward has claimed it — the identity
 * check is skipped entirely and ANY registered caller may fire ANY legal
 * transition on that state, regardless of whether they fill the state's
 * `owner_role`. Live-reproduced on INF-1212: Charles (code-review role, not
 * steward) ran `accept` directly on a fresh intake ticket and it succeeded.
 *
 * Fix direction (Astrid, 2026-08-05): a caller must be a member of the
 * *current state's* `owner_role` (via `resolveBodiesForOwnerRole`) to fire a
 * transition on it — independent of whether a delegate is currently set, and
 * independent of whether the caller happens to BE the delegate. The existing
 * exception paths (`designated_approver`, `workflow:break-glass`,
 * `retire`/`workflow:steward`) must compose with the new gate, not be
 * superseded by it.
 *
 * AC mapping (verbatim AC captured at intake):
 *   AC1 — "Owner-role-gate" describe block, first 4 tests
 *   AC2 — "INF-1212 exact regression" test
 *   AC3 — "Exception paths compose with the new gate" describe block
 *   AC4 — "No regression to the normal case" describe block
 *   AC5 — validated by running the full suite (not a new test in this file)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";

// ── Fixture: a dev-impl-shaped workflow with a role per state, plus one
// designated_approver-gated transition (code-review -> deployment) so the
// exception-composition tests have something to exercise. ────────────────

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
    owner_role: code-review
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: deployment
        requires_capability: signoff:approve
        designated_approver: true
      - command: request-changes
        to: implementation

  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: doing
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute

  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

// bodies:
//   astrid — fills 'steward' (intake owner)
//   charles — fills 'dev' (implementation owner)
//   cra — fills 'code-review' (code-review owner)
//   hanzo — fills 'deployment' (deployment owner), holds deploy:execute
//   ops — fills NO workflow role, holds signoff:approve (designated approver)
//   recovery-bot — fills NO workflow role, holds workflow:break-glass (steward recovery)
const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: workflow:break-glass
  - id: linear:transition
  - id: deploy:execute
  - id: signoff:approve

containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: dev
    grants: [linear:transition]
  - id: reviewer
    grants: [linear:transition]
  - id: deployer
    grants: [linear:transition, deploy:execute]
  - id: signoff-only
    grants: [linear:transition, signoff:approve]
  - id: recovery
    grants: [linear:transition, workflow:break-glass]

roles:
  - id: steward
    requires: [human:escalate]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: cra
    container: reviewer
    fills_roles: [code-review]
  - id: hanzo
    container: deployer
    fills_roles: [deployment]
  - id: ops
    container: signoff-only
    fills_roles: []
  - id: recovery-bot
    container: recovery
    fills_roles: []
`;

// ── Test infrastructure ────────────────────────────────────────────────────

let dir: string;
let policyFile: string;
let wfFile: string;

const ORIG_CAPABILITY_POLICY_PATH = process.env.CAPABILITY_POLICY_PATH;
const ORIG_WORKFLOW_DEF_PATH = process.env.WORKFLOW_DEF_PATH;
const ORIG_ROLE_BODIES_FIXTURE_PATH = process.env.ROLE_BODIES_FIXTURE_PATH;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-gate-inf-1217-"));

  policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");

  wfFile = path.join(dir, "workflow.yaml");
  fs.writeFileSync(wfFile, TEST_WORKFLOW_YAML, "utf8");

  process.env.CAPABILITY_POLICY_PATH = policyFile;
  process.env.WORKFLOW_DEF_PATH = wfFile;
  process.env.ROLE_BODIES_FIXTURE_PATH = policyFile;
});

afterAll(() => {
  if (ORIG_CAPABILITY_POLICY_PATH !== undefined) {
    process.env.CAPABILITY_POLICY_PATH = ORIG_CAPABILITY_POLICY_PATH;
  } else {
    delete process.env.CAPABILITY_POLICY_PATH;
  }
  if (ORIG_WORKFLOW_DEF_PATH !== undefined) {
    process.env.WORKFLOW_DEF_PATH = ORIG_WORKFLOW_DEF_PATH;
  } else {
    delete process.env.WORKFLOW_DEF_PATH;
  }
  if (ORIG_ROLE_BODIES_FIXTURE_PATH !== undefined) {
    process.env.ROLE_BODIES_FIXTURE_PATH = ORIG_ROLE_BODIES_FIXTURE_PATH;
  } else {
    delete process.env.ROLE_BODIES_FIXTURE_PATH;
  }
  try { fs.rmSync(dir, { recursive: true }); } catch { /* best-effort */ }
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  resetConfigHealth();
});

const ISSUE_UUID = "11111111-2222-3333-4444-555555555555";
// The Linear user ID a delegateId/callerLinearUserId is expressed in — distinct
// from body IDs (mirrors production: delegateId is a Linear user UUID, bodyId
// is the policy body identifier resolved from the caller's registered agent).
const CRA_LINEAR_USER_ID = "cra-linear-user-uuid";

interface MakeLabelFetchOpts {
  /** Linear user ID of the current delegate. Omit/undefined = no delegate set. */
  delegateId?: string | null;
}

function makeLabelFetch(labels: string[], opts: MakeLabelFetchOpts = {}) {
  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string };
    const query = parsed.query ?? "";

    if (query.includes("IssueContext")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: "INF-1217-TEST",
              labels: { nodes: labels.map((l) => ({ name: l })) },
              delegate: opts.delegateId ? { id: opts.delegateId } : null,
              state: { type: "started", name: "irrelevant" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("IssueRepoAttachments")) {
      return new Response(
        JSON.stringify({ data: { issue: { attachments: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected Linear query in INF-1217 suite: ${query.slice(0, 80)}`);
  };
  return mockFetch;
}

// ── AC1 + AC2: the owner-role gate itself ──────────────────────────────────

describe("INF-1217 AC1/AC2: caller must fill the current state's owner_role to fire a transition", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("AC2 — INF-1212 exact regression: non-steward caller (code-review role) cannot 'accept' an intake ticket with no delegate set", async () => {
    // cra fills 'code-review', not 'steward'. Delegate unset — this is the
    // exact shape that let INF-1212 through: the identity gate never fires
    // because delegateId is falsy, and today nothing else checks role.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("accept", ISSUE_UUID, "Bearer tok", "cra");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    // Must name the required role explicitly, not just say "blocked".
    expect(result).toContain("steward");
  });

  it("AC1 — non-dev caller (steward) cannot 'submit' an implementation-state ticket with no delegate set", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("submit", ISSUE_UUID, "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("dev");
  });

  it("AC1 — non-code-review caller (dev) cannot 'request-changes' a code-review-state ticket with no delegate set", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("request-changes", ISSUE_UUID, "Bearer tok", "charles");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("code-review");
  });

  it("AC1 — role membership is required even when the caller IS the current delegate (delegate identity is not a substitute for role membership)", async () => {
    // This is the stronger claim in Astrid's framing: "Anyone who is (or makes
    // themselves, by creating the ticket) the current delegate can advance a
    // state whose owner_role they don't fill." cra is the delegate here, but
    // cra fills 'code-review', not 'steward' — must still be blocked.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"], { delegateId: CRA_LINEAR_USER_ID });
    const result = await checkWorkflowRules(
      "accept",
      ISSUE_UUID,
      "Bearer tok",
      "cra",
      null,
      CRA_LINEAR_USER_ID,
    );
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
    expect(result).toContain("steward");
  });
});

// ── AC3: existing exception paths must compose with the new gate ──────────

describe("INF-1217 AC3: designated_approver and workflow:break-glass compose with the new owner_role gate", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("designated_approver (ops, holds signoff:approve, fills no role) can 'approve' a code-review ticket with no delegate set", async () => {
    // ops fills no workflow role at all, so the naive fix ('block anyone who
    // doesn't fill owner_role') would wrongly reject this. The designated_approver
    // opt-in on 'approve' must still let a capability holder through.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("approve", ISSUE_UUID, "Bearer tok", "ops");
    expect(result).toBeNull();
  });

  it("workflow:break-glass holder (recovery-bot, fills no role) can 'accept' an intake ticket with no delegate set", async () => {
    // recovery-bot fills no workflow role either. The steward break-glass
    // exception is a recovery mechanism specifically for stuck/un-delegated
    // tickets — it must not be superseded by the new role gate.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("accept", ISSUE_UUID, "Bearer tok", "recovery-bot");
    expect(result).toBeNull();
  });

  it("a caller with NEITHER role membership NOR an exception capability is still blocked (exceptions are opt-in, not a blanket bypass)", async () => {
    // ops holds signoff:approve but that capability is irrelevant to 'accept'
    // on intake (which has no requires_capability / designated_approver at
    // all) — ops must still be blocked by the plain role gate here.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("accept", ISSUE_UUID, "Bearer tok", "ops");
    expect(result).not.toBeNull();
    expect(result).toContain("steward");
  });
});

// ── AC4: no regression to the normal case ──────────────────────────────────

describe("INF-1217 AC4: no regression — a caller who fills the owner_role can still act, delegate set or unset", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("steward (astrid) can 'accept' a fresh intake ticket with no delegate set", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("accept", ISSUE_UUID, "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("dev (charles) can 'submit' an implementation-state ticket with no delegate set", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const result = await checkWorkflowRules("submit", ISSUE_UUID, "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("deployment (hanzo) can 'deploy' a deployment-state ticket when ALSO the current delegate (steady-state case)", async () => {
    const HANZO_LINEAR_USER_ID = "hanzo-linear-user-uuid";
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"], { delegateId: HANZO_LINEAR_USER_ID });
    const result = await checkWorkflowRules(
      "deploy",
      ISSUE_UUID,
      "Bearer tok",
      "hanzo",
      null,
      HANZO_LINEAR_USER_ID,
    );
    expect(result).toBeNull();
  });

  it("code-review (cra) can 'request-changes' a code-review-state ticket with no delegate set", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("request-changes", ISSUE_UUID, "Bearer tok", "cra");
    expect(result).toBeNull();
  });
});
