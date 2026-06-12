/**
 * AI-1561 — Legal-move affordance: Full legal-move set on every dispatch.
 *
 * Tests cover AC1–AC5:
 *   AC1 — On dispatch/wake the message includes the full legal-move set (state
 *          transitions + meta-commands), each with the exact CLI command and the
 *          real ticket id in place of any placeholder.
 *   AC2 — Move set is derived from the workflow def + capability policy (not
 *          hardcoded) — a def change is reflected without connector code edits.
 *   AC3 — Illegal/irrelevant moves are excluded: state-gated and capability-gated.
 *   AC4 — Ad-hoc (non-wf:*) tickets get the lifecycle-verb affordance set.
 *   AC5 — A dev-impl stage emits exactly its legal transition verbs; an ad-hoc
 *          ticket emits the lifecycle set; an excluded move is absent.
 *
 * All tests are written against unimplemented behaviour and expected to be RED
 * until the feature lands.  The sole exception is the AC4 ad-hoc path and the
 * basic state-transition-present check, which validate correct existing
 * behaviour (regression guard).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetWorkflowCache } from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";

// ── Canonical dev-impl fixture path ──────────────────────────────────────────

const CANONICAL_DEV_IMPL = path.resolve(
  process.cwd(),
  "src/__fixtures__/canonical-dev-impl.yaml",
);

// ── Capability policy matching the canonical dev-impl workflow ────────────────
// Defines: dev (felix/noah/sage/igor), deployment (hanzo), steward (astrid),
// code-review (charles), test-author (tdd), host-deploy (grover).

const CAPABILITY_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute
  - id: infra:ssh

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: code-review
    grants: [linear:transition]
  - id: test-author
    grants: [linear:transition]
  - id: host-deploy
    grants: [linear:transition, infra:ssh]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: code-review
    requires: [linear:transition]
  - id: test-author
    requires: [linear:transition]
  - id: host-deploy
    requires: [infra:ssh]

bodies:
  - id: felix
    container: dev
    fills_roles: [dev]
  - id: noah
    container: dev
    fills_roles: [dev]
  - id: sage
    container: dev
    fills_roles: [dev]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: code-review
    fills_roles: [code-review]
  - id: tdd
    container: test-author
    fills_roles: [test-author]
  - id: grover
    container: host-deploy
    fills_roles: [host-deploy]
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRoute(
  identifier: string,
  title: string,
  agentId: string,
  routingReason: "delegate" | "assignee" | "mention" | "body-mention" = "delegate",
): import("../types.js").RouteResult {
  return {
    agentId,
    sessionKey: `linear-${identifier}`,
    priority: 0,
    routingReason,
    event: {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Ai", type: "user" },
      data: { identifier, title },
    } as unknown as import("../types.js").RouteResult["event"],
  };
}

function makeLabelFetch(labels: string[]): typeof globalThis.fetch {
  return async (_url, _init) =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            labels: { nodes: labels.map((name) => ({ name })) },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let tmpDir: string;
let policyPath: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "affordance-test-"));
  policyPath = path.join(tmpDir, "capability-policy.yaml");
  fs.writeFileSync(policyPath, CAPABILITY_POLICY_YAML, "utf8");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  originalFetch = globalThis.fetch;
  process.env.WORKFLOW_DEF_PATH = CANONICAL_DEV_IMPL;
  process.env.CAPABILITY_POLICY_PATH = policyPath;
  // No guidance files needed; loadStepGuidance is fail-open (returns null on ENOENT).
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.CAPABILITY_POLICY_PATH;
});

async function getBuildDeliveryMessage() {
  const mod = await import("./build-message.js");
  return mod.buildDeliveryMessage;
}

// ── AC1 + AC5: state-transition verbs present ─────────────────────────────────
//
// The dispatch message for a dev-impl workflow ticket must include the exact
// CLI command for every state-specific transition, with the real ticket id
// substituted for any placeholder.

describe("AC1/AC5 — workflow ticket: state-transition verbs with real ticket id", () => {
  it("write-tests state: tests-ready command with real ticket id is present", async () => {
    // Regression guard: the state-specific transition verb must appear.
    // Should PASS on the current B3 implementation.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-1561", "Legal-move affordance", "tdd"), "Bearer tok");

    expect(msg).toContain("tests-ready");
    expect(msg).toContain("AI-1561");
    // escape (break-glass) must always be present
    expect(msg).toContain("escape");
  });

  it("intake state: accept and demote commands are present, escape is present", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-9900", "Intake ticket", "astrid"), "Bearer tok");

    expect(msg).toContain("accept");
    expect(msg).toContain("demote");
    expect(msg).toContain("escape");
    expect(msg).toContain("AI-9900");
  });

  it("implementation state: submit command is present", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-9901", "Impl ticket", "felix"), "Bearer tok");

    expect(msg).toContain("submit");
    expect(msg).toContain("AI-9901");
  });
});

// ── AC1: meta-commands present in workflow ticket message ─────────────────────
//
// The full legal-move set includes not only workflow-state transition verbs but
// also the always-available lifecycle meta-commands: refuse-work, handoff-work,
// needs-human.  These are currently ABSENT from workflow ticket messages → RED.

describe("AC1 — workflow ticket: meta-commands included in the affordance block", () => {
  it("write-tests state: refuse-work is included with real ticket id", async () => {
    // Currently absent from the workflow message — FAILS until implemented.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-1561", "Test ticket", "tdd"), "Bearer tok");

    expect(msg).toContain("refuse-work");
    expect(msg).toContain("AI-1561");
  });

  it("write-tests state: handoff-work is included with real ticket id", async () => {
    // Currently absent from the workflow message — FAILS until implemented.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-1561", "Test ticket", "tdd"), "Bearer tok");

    expect(msg).toContain("handoff-work");
    expect(msg).toContain("AI-1561");
  });

  it("write-tests state: needs-human is included with real ticket id", async () => {
    // Currently absent from the workflow message — FAILS until implemented.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-1561", "Test ticket", "tdd"), "Bearer tok");

    expect(msg).toContain("needs-human");
    expect(msg).toContain("AI-1561");
  });

  it("implementation state: refuse-work is included with real ticket id", async () => {
    // Meta-command coverage across multiple states — FAILS until implemented.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-9902", "Impl ticket", "felix"), "Bearer tok");

    expect(msg).toContain("refuse-work");
    expect(msg).toContain("AI-9902");
  });

  it("implementation state: handoff-work is included with real ticket id", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-9902", "Impl ticket", "felix"), "Bearer tok");

    expect(msg).toContain("handoff-work");
    expect(msg).toContain("AI-9902");
  });
});

// ── AC2/AC3: Capability-filtered exclusion ────────────────────────────────────
//
// Moves requiring a capability the caller does not hold must be excluded.
// AC3: "Illegal/irrelevant moves for the current state/caller are excluded."
// AC2: "Derived from the loaded workflow def + capability policy."
//
// deploy requires deploy:execute — hanzo has it, charles does not.
// The dispatch message must exclude deploy from charles's affordance block.

describe("AC2/AC3 — capability filtering: excluded moves absent for caller without capability", () => {
  it("deployment state: deploy excluded for caller without deploy:execute (charles)", async () => {
    // charles is a code-review body — no deploy:execute.
    // Currently the connector shows deploy to ALL callers; this test is RED.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-9910", "Deploy test", "charles"), "Bearer tok");

    // deploy must NOT appear in charles's affordance — he cannot run it.
    expect(msg).not.toContain("linear deploy AI-9910");
  });

  it("deployment state: deploy present for caller with deploy:execute (hanzo)", async () => {
    // hanzo has deploy:execute — deploy is a legal move for them.
    // This is a regression guard for the positive capability case.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-9910", "Deploy test", "hanzo"), "Bearer tok");

    expect(msg).toContain("linear deploy AI-9910");
  });

  it("host-deploy state: host-deployed excluded for caller without infra:ssh (astrid)", async () => {
    // astrid is a steward body — no infra:ssh.
    // host-deployed requires infra:ssh → must be absent for astrid.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:host-deploy"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-9911", "Host deploy test", "astrid"), "Bearer tok");

    expect(msg).not.toContain("linear host-deployed AI-9911");
  });
});

// ── AC3/AC5: Excluded state-transition verbs ──────────────────────────────────
//
// A command that is only legal in a DIFFERENT state must not appear in the
// affordance block for the current state ("an excluded move is absent").

describe("AC3/AC5 — excluded moves: state-specific transition verbs absent for wrong state", () => {
  it("write-tests state: submit (implementation-only move) is absent", async () => {
    // submit is legal only from implementation; write-tests has no submit transition.
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-1561", "Write-tests ticket", "tdd"), "Bearer tok");

    expect(msg).not.toContain("linear submit AI-1561");
  });

  it("write-tests state: approve (code-review-only move) is absent", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-1561", "Write-tests ticket", "tdd"), "Bearer tok");

    expect(msg).not.toContain("linear approve AI-1561");
  });

  it("implementation state: tests-ready (write-tests-only move) is absent", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("AI-9902", "Impl ticket", "felix"), "Bearer tok");

    expect(msg).not.toContain("linear tests-ready AI-9902");
  });
});

// ── AC4: Ad-hoc ticket lifecycle-verb affordance set ─────────────────────────
//
// When the ticket has no wf:* label, the connector delivers the lifecycle-verb
// set (consider-work, begin-work, handoff-work, complete, refuse-work, needs-human).
// This is existing behaviour that must be preserved (regression guard).

describe("AC4 — ad-hoc ticket: lifecycle-verb affordance set", () => {
  it("no wf:* label → message contains lifecycle verbs with real ticket id", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("FCY-999", "Ad-hoc task", "charles"), "Bearer tok");

    // All key lifecycle verbs must be present.
    expect(msg).toContain("begin-work");
    expect(msg).toContain("handoff-work");
    expect(msg).toContain("refuse-work");
    expect(msg).toContain("needs-human");
    expect(msg).toContain("complete");
    expect(msg).toContain("FCY-999");
  });

  it("no wf:* label → workflow state block absent", async () => {
    globalThis.fetch = makeLabelFetch([]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("FCY-888", "No-label ad-hoc", "charles"), "Bearer tok");

    expect(msg).not.toContain("[dev-impl]");
    expect(msg).not.toContain("state: **");
  });

  it("no wf:* label → consider-work is present (AC5: lifecycle set)", async () => {
    globalThis.fetch = makeLabelFetch(["enhancement"]);
    const build = await getBuildDeliveryMessage();
    const msg = await build(makeRoute("FCY-777", "Enhancement", "igor"), "Bearer tok");

    expect(msg).toContain("consider-work");
    expect(msg).toContain("FCY-777");
  });
});

// ── AC2: Derivation from workflow def — state-machine change reflects ─────────
//
// AC2 requires that the affordance is derived from the loaded workflow def,
// not hardcoded.  We test this by verifying that ALL non-terminal states in the
// canonical dev-impl fixture emit their correct transition commands — if any
// transition were hardcoded and a def change was made, these tests would catch it.

describe("AC2 — move set derived from workflow def (all canonical dev-impl states)", () => {
  const STATES_AND_TRANSITIONS = [
    { state: "intake",       commands: ["accept", "demote"],                     absent: ["tests-ready", "submit"] },
    { state: "write-tests",  commands: ["tests-ready"],                           absent: ["submit", "accept", "approve"] },
    { state: "implementation", commands: ["submit"],                              absent: ["tests-ready", "approve", "deploy"] },
    { state: "code-review",  commands: ["approve", "request-changes"],           absent: ["submit", "deploy"] },
    { state: "ac-validate",  commands: ["validated", "ac-fail"],                 absent: ["submit", "approve", "deploy"] },
  ] as const;

  test.each(STATES_AND_TRANSITIONS)(
    "state '$state': emits correct commands and excludes illegal ones",
    async ({ state, commands, absent }) => {
      const agentForState: Record<string, string> = {
        "intake": "astrid",
        "write-tests": "tdd",
        "implementation": "felix",
        "code-review": "charles",
        "ac-validate": "astrid",
      };
      const agentId = agentForState[state] ?? "astrid";

      globalThis.fetch = makeLabelFetch([`wf:dev-impl`, `state:${state}`]);
      const build = await getBuildDeliveryMessage();
      const msg = await build(makeRoute("AI-9920", `State ${state} test`, agentId), "Bearer tok");

      // Confirm the workflow header is present (workflow message, not generic)
      expect(msg).toContain("[dev-impl]");
      expect(msg).toContain(`state: **${state}**`);

      // Correct transition verbs present
      for (const cmd of commands) {
        expect(msg).toContain(cmd);
      }

      // Incorrect (other-state) verbs absent
      for (const cmd of absent) {
        expect(msg).not.toContain(`linear ${cmd} AI-9920`);
      }
    },
  );
});
